/**
 * Google Gemini client.
 *
 * Every call is structured-output only: the model is given a response schema
 * and the result is re-validated with Zod before it reaches the app. A model
 * that returns malformed or out-of-range data is treated as a failure and the
 * caller decides what to do (for classification: send the batch to "Needs
 * attention" rather than guess).
 *
 * Every outcome carries the token usage Gemini reported, which is what the
 * cost figures on the dashboard are computed from.
 */

import { GoogleGenAI, Type, type Schema } from '@google/genai';
import type { ZodType, ZodTypeDef } from 'zod';

import { env } from '@/lib/env';
import { ZERO_USAGE, type TokenUsage } from '@/lib/types';

export { Type };
export type { Schema };

export type GeminiFailureCode =
  | 'NO_API_KEY'
  | 'TIMEOUT'
  | 'EMPTY_RESPONSE'
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH'
  | 'API_ERROR';

export type GeminiOutcome<T> =
  | { ok: true; data: T; model: string; usage: TokenUsage; latencyMs: number }
  | {
      ok: false;
      code: GeminiFailureCode;
      reason: string;
      model: string;
      usage: TokenUsage;
      latencyMs: number;
    };

export interface StructuredRequest<T> {
  systemInstruction: string;
  prompt: string;
  schema: Schema;
  validator: ZodType<T, ZodTypeDef, unknown>;
  /** Overrides GEMINI_MODEL; the Settings page value is passed here. */
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** 0 disables model thinking, which keeps latency and cost predictable. */
  thinkingBudget?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

let client: GoogleGenAI | null = null;
let clientKey: string | null = null;

function getClient(apiKey: string): GoogleGenAI {
  if (!client || clientKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

export function isGeminiConfigured(): boolean {
  return Boolean(env.geminiApiKey);
}

/**
 * Pull a JSON object out of a model response. `responseMimeType` normally
 * guarantees bare JSON, but a fenced block still shows up occasionally and is
 * cheap to recover from.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost brace pair.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new SyntaxError('No JSON object found in the model response');
  }
}

interface UsageMetadataLike {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

export function usageFromMetadata(meta: UsageMetadataLike | undefined | null): TokenUsage {
  if (!meta) return { ...ZERO_USAGE };
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    promptTokens: n(meta.promptTokenCount),
    outputTokens: n(meta.candidatesTokenCount),
    thoughtTokens: n(meta.thoughtsTokenCount),
    cachedTokens: n(meta.cachedContentTokenCount),
  };
}

export async function generateStructured<T>(
  request: StructuredRequest<T>,
): Promise<GeminiOutcome<T>> {
  const model = request.model?.trim() || env.geminiModel;
  const apiKey = env.geminiApiKey;
  const started = Date.now();
  const base = { model, usage: { ...ZERO_USAGE } };

  if (!apiKey) {
    return {
      ok: false,
      code: 'NO_API_KEY',
      reason: 'GEMINI_API_KEY is not configured.',
      ...base,
      latencyMs: 0,
    };
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let text: string | undefined;
  let usage: TokenUsage = { ...ZERO_USAGE };
  try {
    const response = await getClient(apiKey).models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      config: {
        systemInstruction: request.systemInstruction,
        temperature: request.temperature ?? 0.2,
        maxOutputTokens: request.maxOutputTokens ?? 8_192,
        responseMimeType: 'application/json',
        responseSchema: request.schema,
        thinkingConfig: { thinkingBudget: request.thinkingBudget ?? 0 },
        abortSignal: AbortSignal.timeout(timeoutMs),
      },
    });
    text = response.text;
    usage = usageFromMetadata(response.usageMetadata);
  } catch (error) {
    const latencyMs = Date.now() - started;
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return {
        ok: false,
        code: 'TIMEOUT',
        reason: `Gemini did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        ...base,
        latencyMs,
      };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[automail] gemini request failed:', message);
    return { ok: false, code: 'API_ERROR', reason: sanitiseError(message), ...base, latencyMs };
  }

  const latencyMs = Date.now() - started;

  if (!text || !text.trim()) {
    return {
      ok: false,
      code: 'EMPTY_RESPONSE',
      reason: 'Gemini returned an empty response, most likely a safety block.',
      model,
      usage,
      latencyMs,
    };
  }

  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    return {
      ok: false,
      code: 'INVALID_JSON',
      reason: 'Gemini returned a response that was not valid JSON.',
      model,
      usage,
      latencyMs,
    };
  }

  const validated = request.validator.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const path = issue?.path.join('.') || 'response';
    return {
      ok: false,
      code: 'SCHEMA_MISMATCH',
      reason: `Gemini response failed validation at "${path}": ${issue?.message ?? 'unknown issue'}.`,
      model,
      usage,
      latencyMs,
    };
  }

  return { ok: true, data: validated.data, model, usage, latencyMs };
}

/**
 * Keep API keys and URLs out of anything shown to the user; upstream error
 * strings sometimes embed the request URL.
 */
function sanitiseError(message: string): string {
  const withoutKeys = message
    .replace(/key=[^&\s"']+/gi, 'key=***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '***');
  return withoutKeys.length > 300 ? `${withoutKeys.slice(0, 300)}...` : withoutKeys;
}

/** Human-readable explanation used when a batch could not be classified. */
export function describeFailure(code: GeminiFailureCode): string {
  switch (code) {
    case 'NO_API_KEY':
      return 'No Gemini API key is configured.';
    case 'TIMEOUT':
      return 'Gemini timed out.';
    case 'EMPTY_RESPONSE':
      return 'Gemini returned nothing usable.';
    case 'INVALID_JSON':
    case 'SCHEMA_MISMATCH':
      return 'Gemini returned data that did not match the required schema.';
    case 'API_ERROR':
    default:
      return 'The Gemini request failed.';
  }
}
