/**
 * Classification with Gemini.
 *
 * One request per batch of emails. The system instruction carries everything
 * that is stable for a run (who the user is, the categories, the standing
 * rules); the prompt carries the corrections relevant to this batch and the
 * emails themselves. The response is constrained by a schema, validated with
 * Zod, and then passed through deterministic guards the model cannot talk its
 * way around.
 */

import type { Category } from '@prisma/client';
import { z } from 'zod';

import { OTHER_CATEGORY } from '@/lib/categories';
import {
  Type,
  describeFailure,
  generateStructured,
  isTransientFailure,
  type GeminiFailureCode,
  type Schema,
} from '@/lib/gemini';
import { addUsage } from '@/lib/pipeline/cost';
import type { FeedbackExample } from '@/lib/pipeline/learning';
import type { AppSettings } from '@/lib/settings';
import { ACTIONS, ZERO_USAGE, type Action, type Decision, type RawEmail, type TokenUsage } from '@/lib/types';
import { clamp } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

const decisionSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.string().min(1).max(40),
  action: z.enum(ACTIONS),
  confidence: z.number().int().min(0).max(100),
  reason: z.string().max(400).transform((s) => s.trim()),
  needsReply: z.boolean().default(false),
});

export const decisionsResponseSchema = z.object({
  decisions: z.array(decisionSchema).max(200),
});

export type ModelDecision = z.infer<typeof decisionSchema>;

function geminiSchema(categoryKeys: string[]): Schema {
  return {
    type: Type.OBJECT,
    required: ['decisions'],
    properties: {
      decisions: {
        type: Type.ARRAY,
        description: 'Exactly one entry per email id supplied, in the same order.',
        items: {
          type: Type.OBJECT,
          required: ['id', 'category', 'action', 'confidence', 'reason', 'needsReply'],
          properties: {
            id: { type: Type.STRING, description: 'The email id exactly as supplied.' },
            category: { type: Type.STRING, enum: categoryKeys },
            action: { type: Type.STRING, enum: [...ACTIONS] },
            confidence: {
              type: Type.INTEGER,
              description: '0-100. Below 60 means the category is a guess.',
            },
            reason: {
              type: Type.STRING,
              description: 'One short sentence, under 25 words, that a person can scan.',
            },
            needsReply: {
              type: Type.BOOLEAN,
              description: 'True when the person is expected to reply, decide or act.',
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface ClassifyContext {
  categories: Category[];
  settings: Pick<AppSettings, 'profileText' | 'learnedNotes' | 'geminiModel' | 'autoTrashMinConfidence'>;
  instructions: string[];
  accountEmail: string;
}

export function buildSystemInstruction(ctx: ClassifyContext): string {
  const enabled = ctx.categories.filter((c) => c.enabled);
  const lines: string[] = [
    'You are AutoMail, a private email triage assistant working for one person. For every email you choose exactly one category and one action. You never write email or take any other action.',
    '',
    `MAILBOX: ${ctx.accountEmail}`,
    '',
    'ABOUT THE PERSON:',
    ctx.settings.profileText.trim() || '(No profile has been written yet. Judge from the emails alone.)',
    '',
    'LEARNED PREFERENCES (distilled from their past corrections; follow these):',
    ctx.settings.learnedNotes.trim() || '(none yet)',
  ];

  if (ctx.instructions.length > 0) {
    lines.push('', 'STANDING INSTRUCTIONS FROM THE PERSON (these override everything below):');
    for (const instruction of ctx.instructions) lines.push(`- ${instruction}`);
  }

  lines.push('', 'CATEGORIES (use the key exactly):');
  for (const category of enabled) {
    const flags: string[] = [];
    if (!category.allowTrash) flags.push('never TRASH');
    lines.push(`- ${category.key} (${category.name}): ${category.description}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
  }

  lines.push(
    '',
    'ACTIONS:',
    '- KEEP: worth seeing or likely to be needed; it stays in the inbox.',
    '- ARCHIVE: not worth attention now but worth keeping; it leaves the inbox.',
    '- TRASH: no value at all; proposed for deletion, which the person confirms.',
    '- ATTENTION: the person must read, reply, decide or act, or it concerns money, tax, legal matters or the security of an account they use.',
    '',
    'GUIDELINES:',
    '- Judge only from the sender, subject and excerpt. Never assume facts that are not in the email.',
    '- A real person writing directly to them is at least KEEP. If it asks them something or needs a reply, use ATTENTION and set needsReply.',
    '- Money owed either way, tax, government, legal, insurance, and security alerts for accounts they use: never TRASH, and usually ATTENTION.',
    '- Marketing, promotions, discount codes and re-engagement mail with no order or account information: TRASH.',
    '- Torn between TRASH and ARCHIVE: choose ARCHIVE. Torn between ARCHIVE and KEEP: choose KEEP.',
    '- Confidence must reflect real uncertainty. Use below 60 when the category is a guess.',
    '- The reason is one short sentence under 25 words. No restating the subject.',
    '- Return exactly one decision for every id supplied and nothing else.',
  );

  return lines.join('\n');
}

export function describeEmail(email: RawEmail): string {
  const signals: string[] = [];
  const tab = email.labelIds.find((l) => l.startsWith('CATEGORY_'));
  if (tab) signals.push(`gmail tab: ${tab.replace('CATEGORY_', '').toLowerCase()}`);
  if (email.listUnsubscribe) signals.push('has List-Unsubscribe header');
  if (email.automated) signals.push('automated/bulk sender');
  if (email.labelIds.includes('IMPORTANT')) signals.push('gmail marked important');
  if (!email.labelIds.includes('UNREAD')) signals.push('already read');
  if (email.hasAttachments) signals.push(`attachments: ${email.attachmentNames.slice(0, 5).join(', ') || 'yes'}`);
  if (email.replyTo && email.replyTo !== email.from.address) signals.push(`reply-to: ${email.replyTo}`);

  const from = email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address;
  const lines = [
    `### id: ${email.id}`,
    `From: ${from}`,
    email.to ? `To: ${email.to}` : null,
    `Date: ${email.internalDate.toISOString()}`,
    `Subject: ${email.subject || '(no subject)'}`,
    `Signals: ${signals.length ? signals.join('; ') : 'none'}`,
    'Excerpt:',
    email.bodyText || email.snippet || '(empty body)',
  ];
  return lines.filter((line) => line !== null).join('\n');
}

export function formatExamples(examples: FeedbackExample[]): string {
  if (examples.length === 0) return '(none)';
  return examples
    .map((ex) => {
      const proposed = `${ex.aiAction}${ex.aiCategory ? ` (${ex.aiCategory})` : ''}`;
      const chosen = `${ex.userAction}${ex.userCategory ? ` (${ex.userCategory})` : ''}`;
      const note = ex.note ? ` Note from the person: "${ex.note}"` : '';
      const verdict = ex.aiAction === ex.userAction && (!ex.userCategory || ex.userCategory === ex.aiCategory)
        ? `the person confirmed ${chosen}`
        : `the person changed it to ${chosen}`;
      return `- From ${ex.fromAddress}, subject "${ex.subject}": proposed ${proposed}; ${verdict}.${note}`;
    })
    .join('\n');
}

export function buildBatchPrompt(emails: RawEmail[], examples: FeedbackExample[]): string {
  return [
    'PAST DECISIONS THE PERSON REVIEWED (most relevant first):',
    formatExamples(examples),
    '',
    `EMAILS TO CLASSIFY (${emails.length}):`,
    '',
    emails.map(describeEmail).join('\n\n'),
    '',
    `Return one decision for each of these ids: ${emails.map((e) => e.id).join(', ')}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function applyGuards(
  raw: ModelDecision,
  categories: Category[],
): Decision {
  const notes: string[] = [];
  const byKey = new Map(categories.map((c) => [c.key, c]));

  let category = byKey.get(raw.category.toUpperCase());
  if (!category || !category.enabled) {
    notes.push(`Unknown or disabled category "${raw.category}" mapped to ${OTHER_CATEGORY}.`);
    category = byKey.get(OTHER_CATEGORY) ?? category;
  }
  const categoryKey = category?.key ?? OTHER_CATEGORY;

  let action: Action = raw.action;
  const confidence = clamp(Math.round(raw.confidence), 0, 100);

  if (raw.needsReply && action !== 'ATTENTION') {
    notes.push(`Needs a reply, so ${action} became ATTENTION.`);
    action = 'ATTENTION';
  }

  if (action === 'TRASH' && category && !category.allowTrash) {
    const fallback: Action =
      category.defaultAction === 'KEEP' || category.defaultAction === 'ATTENTION' ? 'KEEP' : 'ARCHIVE';
    notes.push(`${category.name} may not be trashed by the AI; ${fallback} applied instead.`);
    action = fallback;
  }

  return {
    category: categoryKey,
    action,
    confidence,
    reason: raw.reason || 'No reason given.',
    needsReply: raw.needsReply,
    decidedBy: 'ai',
    guardNote: notes.length > 0 ? notes.join(' ') : null,
  };
}

export function fallbackDecision(reason: string): Decision {
  return {
    category: OTHER_CATEGORY,
    action: 'ATTENTION',
    confidence: 0,
    reason,
    needsReply: false,
    decidedBy: 'fallback',
    guardNote: null,
  };
}

// ---------------------------------------------------------------------------
// Batch call
// ---------------------------------------------------------------------------

export interface ClassifyBatchResult {
  decisions: Map<string, Decision>;
  ok: boolean;
  /**
   * The model was busy or rate limited even after retrying. The decisions
   * are placeholders and the caller should leave these emails for later
   * rather than file them.
   */
  transient: boolean;
  errorCode: GeminiFailureCode | null;
  errorReason: string | null;
  model: string;
  usage: TokenUsage;
  latencyMs: number;
}

/**
 * Failures one email can cause for a whole batch: Google's filter refusing
 * the request, or an answer cut short or garbled. Worth splitting over.
 */
const SPLITTABLE = new Set<GeminiFailureCode>(['BLOCKED', 'TRUNCATED', 'EMPTY_RESPONSE', 'INVALID_JSON', 'SCHEMA_MISMATCH']);

/** Never auto-trash on the strength of a sender and subject alone. */
const HEADERS_ONLY_MAX_CONFIDENCE = 60;

/**
 * Classify a batch. If Gemini refuses or garbles the answer, the batch is
 * split in half and each half tried again, down to single emails, so one
 * spam email the filter will not touch costs only itself rather than the
 * nine beside it. A single email Gemini still will not read is tried once
 * more from its sender and subject alone.
 */
export async function classifyBatch(
  emails: RawEmail[],
  examples: FeedbackExample[],
  ctx: ClassifyContext,
  systemInstruction = buildSystemInstruction(ctx),
): Promise<ClassifyBatchResult> {
  const first = await classifyOnce(emails, examples, ctx, systemInstruction);
  if (first.ok || first.transient || !first.errorCode || !SPLITTABLE.has(first.errorCode)) return first;

  if (emails.length > 1) {
    const middle = Math.ceil(emails.length / 2);
    const parts: ClassifyBatchResult[] = [];
    for (const half of [emails.slice(0, middle), emails.slice(middle)]) {
      parts.push(await classifyBatch(half, examples, ctx, systemInstruction));
    }
    return combine([first, ...parts], parts);
  }

  const [email] = emails;
  if (first.errorCode !== 'BLOCKED' && first.errorCode !== 'EMPTY_RESPONSE') return first;

  const bare: RawEmail = { ...email, bodyText: '(body left out: the content filter would not let it through)', snippet: '' };
  const second = await classifyOnce([bare], examples, ctx, systemInstruction);
  if (second.ok) {
    const decision = second.decisions.get(email.id);
    if (decision) {
      second.decisions.set(email.id, {
        ...decision,
        confidence: Math.min(decision.confidence, HEADERS_ONLY_MAX_CONFIDENCE),
        guardNote: [
          decision.guardNote,
          "Sorted from the sender and subject only: Google's content filter would not let Gemini read the body.",
        ]
          .filter(Boolean)
          .join(' '),
      });
    }
    return combine([first, second], [second]);
  }

  // Not even the sender and subject: hand it to the user, and say plainly why.
  const reason = `Not classified: ${first.errorReason ?? "Google's content filter stopped Gemini."} It would not read this email even from its sender and subject, which usually means spam or phishing, so have a look yourself.`;
  const failed = combine([first, second], [second]);
  failed.decisions = new Map([[email.id, fallbackDecision(reason)]]);
  return failed;
}

/**
 * One answer from several calls: decisions from `parts`, usage and time
 * from every call that was made.
 */
function combine(calls: ClassifyBatchResult[], parts: ClassifyBatchResult[]): ClassifyBatchResult {
  const decisions = new Map<string, Decision>();
  for (const part of parts) for (const [id, decision] of part.decisions) decisions.set(id, decision);
  const failed = parts.find((part) => !part.ok);
  return {
    decisions,
    ok: parts.every((part) => part.ok),
    transient: parts.some((part) => part.transient),
    errorCode: failed?.errorCode ?? null,
    errorReason: failed?.errorReason ?? null,
    model: calls[0].model,
    usage: calls.reduce((sum, call) => addUsage(sum, call.usage), { ...ZERO_USAGE }),
    latencyMs: calls.reduce((sum, call) => sum + call.latencyMs, 0),
  };
}

async function classifyOnce(
  emails: RawEmail[],
  examples: FeedbackExample[],
  ctx: ClassifyContext,
  systemInstruction: string,
): Promise<ClassifyBatchResult> {
  const enabledKeys = ctx.categories.filter((c) => c.enabled).map((c) => c.key);
  const outcome = await generateStructured({
    systemInstruction,
    prompt: buildBatchPrompt(emails, examples),
    schema: geminiSchema(enabledKeys),
    validator: decisionsResponseSchema,
    model: ctx.settings.geminiModel,
    temperature: 0.2,
    maxOutputTokens: 8_192,
    thinkingBudget: 0,
  });

  const decisions = new Map<string, Decision>();

  if (!outcome.ok) {
    // The newer failure codes carry a complete sentence of their own.
    const reason = ['API_ERROR', 'OVERLOADED', 'RATE_LIMITED', 'BLOCKED', 'TRUNCATED', 'EMPTY_RESPONSE'].includes(
      outcome.code,
    )
      ? outcome.reason
      : `${describeFailure(outcome.code)} ${outcome.reason}`.trim();
    for (const email of emails) decisions.set(email.id, fallbackDecision(`Not classified: ${reason}`));
    return {
      decisions,
      ok: false,
      transient: isTransientFailure(outcome.code),
      errorCode: outcome.code,
      errorReason: outcome.reason,
      model: outcome.model,
      usage: outcome.usage ?? { ...ZERO_USAGE },
      latencyMs: outcome.latencyMs,
    };
  }

  const wanted = new Set(emails.map((e) => e.id));
  for (const raw of outcome.data.decisions) {
    if (!wanted.has(raw.id) || decisions.has(raw.id)) continue;
    decisions.set(raw.id, applyGuards(raw, ctx.categories));
  }
  for (const email of emails) {
    if (!decisions.has(email.id)) {
      decisions.set(email.id, fallbackDecision('The model returned no decision for this email.'));
    }
  }

  return {
    decisions,
    ok: true,
    transient: false,
    errorCode: null,
    errorReason: null,
    model: outcome.model,
    usage: outcome.usage,
    latencyMs: outcome.latencyMs,
  };
}
