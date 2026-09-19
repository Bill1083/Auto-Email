/**
 * Turning a Gmail API message into the compact `RawEmail` the pipeline uses.
 *
 * Pure functions, no I/O, so every transformation here is unit-tested: MIME
 * part walking, HTML to text, quoted-reply and signature stripping, header
 * signals. The goal is a short, faithful excerpt that is cheap to send to the
 * model, not a full rendering of the email.
 */

import type { RawEmail } from '@/lib/types';
import { domainOf } from '@/lib/utils';

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export function decodeBase64Url(data: string): string {
  const normalised = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function headerMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of headers ?? []) {
    if (!header.name || header.value === undefined) continue;
    const key = header.name.toLowerCase();
    // Keep the first occurrence; duplicates (Received etc.) are irrelevant here.
    if (!(key in map)) map[key] = header.value;
  }
  return map;
}

/** `"Jane Doe" <jane@example.com>` -> parts. Tolerates bare addresses. */
export function parseAddress(raw: string | undefined): {
  name: string | null;
  address: string;
  domain: string;
} {
  const value = (raw ?? '').trim();
  if (!value) return { name: null, address: '', domain: '' };

  const angle = /^(.*?)<([^<>]+)>\s*$/.exec(value);
  let name: string | null = null;
  let address = value;
  if (angle) {
    name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim() || null;
    address = angle[2].trim();
  }
  address = address.toLowerCase().replace(/^mailto:/, '');
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
    // Not a parseable address: keep whatever text we have as the name.
    return { name: name ?? value.slice(0, 120), address: address.slice(0, 200), domain: domainOf(address) };
  }
  return { name, address, domain: domainOf(address) };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  zwnj: '',
  zwj: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return lower in ENTITIES ? ENTITIES[lower] : match;
  });
}

/**
 * A deliberately small HTML-to-text conversion: enough structure to keep
 * paragraphs and list items on their own lines, nothing else.
 */
export function htmlToText(html: string): string {
  let text = html
    // Whole blocks that never contain prose.
    .replace(/<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Preformatted / hidden preheader text is usually a duplicate of the subject.
    .replace(/<span[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/span>/gi, ' ')
    .replace(/<div[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, ' ')
    // Line-level structure.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|table|ul|ol|pre)>/gi, '\n')
    .replace(/<(li)\b[^>]*>/gi, '- ')
    .replace(/<\/(td|th)>/gi, ' ')
    // Keep link text, drop the markup.
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text);
  return normaliseWhitespace(text);
}

export function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cut quoted replies and signatures; drop `>` quoted lines. */
export function stripQuotedReplies(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // "On Mon, 1 Jan 2024 at 10:00, Jane <jane@x.com> wrote:" (may wrap onto the next line)
    if (/^On .{4,240}wrote:?$/.test(trimmed) || (/^On .{4,120}$/.test(trimmed) && /wrote:?$/.test(lines[i + 1]?.trim() ?? ''))) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(trimmed)) break;
    if (/^From:\s.+$/i.test(trimmed) && /^(Sent|Date):\s/i.test(lines[i + 1]?.trim() ?? '')) break;
    if (/^_{10,}$/.test(trimmed) && /^From:\s/i.test(lines[i + 1]?.trim() ?? '')) break;
    // Standard signature delimiter.
    if (line === '-- ' || trimmed === '--') break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/** Very long URLs and tracking links carry no meaning for classification. */
export function collapseUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s)>\]]{40,}/g, (url) => {
    try {
      const host = new URL(url).hostname;
      return `[link: ${host}]`;
    } catch {
      return '[link]';
    }
  });
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function cleanBody(text: string, maxChars: number): string {
  return truncateText(normaliseWhitespace(collapseUrls(stripQuotedReplies(text))), maxChars);
}

export interface CollectedParts {
  text: string | null;
  html: string | null;
  attachments: string[];
}

/** Walk the MIME tree collecting the best text and HTML bodies. */
export function collectParts(payload: GmailPart | undefined): CollectedParts {
  const out: CollectedParts = { text: null, html: null, attachments: [] };
  if (!payload) return out;

  const visit = (part: GmailPart) => {
    const mime = (part.mimeType ?? '').toLowerCase();
    if (part.filename && part.filename.trim()) {
      out.attachments.push(part.filename.trim());
    } else if (part.body?.data) {
      if (mime === 'text/plain' && out.text === null) out.text = decodeBase64Url(part.body.data);
      else if (mime === 'text/html' && out.html === null) out.html = decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) visit(child);
  };
  visit(payload);
  return out;
}

export function isAutomated(headers: Record<string, string>): boolean {
  const precedence = (headers['precedence'] ?? '').toLowerCase();
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return true;
  const auto = (headers['auto-submitted'] ?? '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (headers['list-id'] || headers['x-auto-response-suppress']) return true;
  return false;
}

/** The body text of a message, preferring plain text over converted HTML. */
export function bodyTextOf(payload: GmailPart | undefined): { text: string; attachments: string[] } {
  const parts = collectParts(payload);
  let text = parts.text ?? '';
  // Some senders put only an unsubscribe footer in text/plain; when the plain
  // part is tiny but HTML exists, the HTML is the real content.
  if (parts.html && (!parts.text || parts.text.trim().length < 80)) {
    text = htmlToText(parts.html);
  }
  return { text, attachments: parts.attachments };
}

export function parseGmailMessage(message: GmailMessage, maxBodyChars: number): RawEmail {
  const headers = headerMap(message.payload?.headers);
  const from = parseAddress(headers['from']);
  const { text, attachments } = bodyTextOf(message.payload);
  const internalMs = Number(message.internalDate ?? '');
  const dateHeader = headers['date'] ? Date.parse(headers['date']) : Number.NaN;
  const internalDate = new Date(
    Number.isFinite(internalMs) && internalMs > 0
      ? internalMs
      : Number.isFinite(dateHeader)
        ? dateHeader
        : Date.now(),
  );

  return {
    id: message.id,
    threadId: message.threadId ?? '',
    internalDate,
    from,
    to: headers['to'] ? headers['to'].slice(0, 300) : null,
    replyTo: headers['reply-to'] ? parseAddress(headers['reply-to']).address || null : null,
    subject: (headers['subject'] ?? '').trim().slice(0, 500),
    snippet: decodeEntities(message.snippet ?? '').trim().slice(0, 300),
    bodyText: cleanBody(text, maxBodyChars),
    hasAttachments: attachments.length > 0,
    attachmentNames: attachments.slice(0, 10),
    listUnsubscribe: Boolean(headers['list-unsubscribe']),
    automated: isAutomated(headers),
    labelIds: message.labelIds ?? [],
  };
}
