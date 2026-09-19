import { describe, expect, it } from 'vitest';

import {
  cleanBody,
  collapseUrls,
  collectParts,
  decodeBase64Url,
  decodeEntities,
  headerMap,
  htmlToText,
  isAutomated,
  parseAddress,
  parseGmailMessage,
  stripQuotedReplies,
  type GmailMessage,
} from '@/lib/mail/gmail/parse';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('decodeBase64Url', () => {
  it('decodes url-safe base64 without padding', () => {
    expect(decodeBase64Url(b64('hello, wörld'))).toBe('hello, wörld');
  });
});

describe('parseAddress', () => {
  it('splits a display name from the address', () => {
    expect(parseAddress('"Jane Doe" <Jane@Example.com>')).toEqual({ name: 'Jane Doe', address: 'jane@example.com', domain: 'example.com' });
  });

  it('handles bare addresses and empty input', () => {
    expect(parseAddress('bob@example.org')).toEqual({ name: null, address: 'bob@example.org', domain: 'example.org' });
    expect(parseAddress(undefined)).toEqual({ name: null, address: '', domain: '' });
  });
});

describe('htmlToText', () => {
  it('drops scripts, styles and hidden preheaders, and keeps block structure', () => {
    const html = `
      <html><head><style>p{color:red}</style><title>ignored</title></head>
      <body><span style="display:none">PREHEADER</span><script>alert(1)</script>
      <p>Hello &amp; welcome,</p><div>Line two<br>Line three</div>
      <ul><li>One</li><li>Two</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).not.toContain('PREHEADER');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('ignored');
    expect(text).toContain('Hello & welcome,\nLine two\nLine three');
    expect(text).toContain('- One\n- Two');
  });

  it('decodes numeric and named entities', () => {
    expect(decodeEntities('&#39;quoted&#x27; &nbsp;&rsquo; &copy;')).toBe("'quoted'  ’ ©");
  });
});

describe('stripQuotedReplies', () => {
  it('cuts at the reply header and drops quoted lines', () => {
    const text = ['Thanks, see you then.', '', 'On Mon, 1 Sep 2026 at 10:00, Jane <jane@x.com> wrote:', '> old message', '> more'].join('\n');
    expect(stripQuotedReplies(text)).toBe('Thanks, see you then.');
  });

  it('cuts at Outlook-style headers and signatures', () => {
    expect(stripQuotedReplies('Reply\n-----Original Message-----\nFrom: x')).toBe('Reply');
    expect(stripQuotedReplies('Reply\nFrom: Bob\nSent: yesterday\nbody')).toBe('Reply');
    expect(stripQuotedReplies('Reply\n-- \nBob\nCEO')).toBe('Reply');
  });
});

describe('collapseUrls and cleanBody', () => {
  it('replaces long tracking links with the host', () => {
    const text = collapseUrls('Click https://click.example.com/track/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?x=1 now');
    expect(text).toBe('Click [link: click.example.com] now');
  });

  it('truncates to the character budget', () => {
    const long = 'word '.repeat(200);
    expect(cleanBody(long, 50).length).toBeLessThanOrEqual(50);
    expect(cleanBody(long, 50).endsWith('…')).toBe(true);
  });
});

describe('collectParts', () => {
  it('walks nested multiparts and lists attachments', () => {
    const parts = collectParts({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64('plain body') } },
            { mimeType: 'text/html', body: { data: b64('<p>html body</p>') } },
          ],
        },
        { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'a1', size: 100 } },
      ],
    });
    expect(parts.text).toBe('plain body');
    expect(parts.html).toBe('<p>html body</p>');
    expect(parts.attachments).toEqual(['invoice.pdf']);
  });
});

describe('isAutomated', () => {
  it('detects bulk and auto-submitted mail', () => {
    expect(isAutomated({ precedence: 'bulk' })).toBe(true);
    expect(isAutomated({ 'auto-submitted': 'auto-generated' })).toBe(true);
    expect(isAutomated({ 'list-id': '<news.example.com>' })).toBe(true);
    expect(isAutomated({ 'auto-submitted': 'no' })).toBe(false);
    expect(isAutomated({})).toBe(false);
  });
});

describe('parseGmailMessage', () => {
  const message: GmailMessage = {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
    snippet: 'Members get 25% off &amp; more',
    internalDate: '1756720800000',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Nike <nike@notifications.nike.com>' },
        { name: 'To', value: 'you@example.com' },
        { name: 'Subject', value: 'Members get 25% off' },
        { name: 'List-Unsubscribe', value: '<mailto:unsub@nike.com>' },
        { name: 'Precedence', value: 'bulk' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Unsubscribe here') } },
        { mimeType: 'text/html', body: { data: b64('<p>Take 25% off selected styles until Sunday.</p>') } },
      ],
    },
  };

  it('extracts headers, signals and prefers the richer HTML when plain text is a stub', () => {
    const email = parseGmailMessage(message, 1500);
    expect(email.from.address).toBe('nike@notifications.nike.com');
    expect(email.from.name).toBe('Nike');
    expect(email.subject).toBe('Members get 25% off');
    expect(email.snippet).toBe('Members get 25% off & more');
    expect(email.listUnsubscribe).toBe(true);
    expect(email.automated).toBe(true);
    expect(email.bodyText).toBe('Take 25% off selected styles until Sunday.');
    expect(email.internalDate.toISOString()).toBe('2025-09-01T10:00:00.000Z');
    expect(email.labelIds).toContain('CATEGORY_PROMOTIONS');
  });

  it('keeps the header map lowercase and first-wins', () => {
    const map = headerMap([
      { name: 'Received', value: 'first' },
      { name: 'received', value: 'second' },
    ]);
    expect(map.received).toBe('first');
  });
});
