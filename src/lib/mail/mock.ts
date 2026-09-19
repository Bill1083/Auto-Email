/**
 * A fixture mailbox.
 *
 * With MOCK_MAIL=true the Settings page can "connect" a demo account that is
 * served from the emails below instead of Google. Label changes and trashing
 * are remembered in the settings table so the review flow, undo and the
 * activity log behave exactly as they would against Gmail. Each time the
 * new-mail lane looks for recent messages, a couple of fresh ones are minted
 * from templates so later runs have something to do.
 */

import { prisma, withDatabase } from '@/lib/prisma';
import { GLOBAL_SCOPE } from '@/lib/settings';
import type { ListPage, MailProfile, MailProvider } from '@/lib/mail/provider';
import { cleanBody, parseAddress } from '@/lib/mail/gmail/parse';
import type { RawEmail } from '@/lib/types';

export const MOCK_ACCOUNT_EMAIL = 'demo@automail.local';

interface Fixture {
  id: string;
  from: string;
  to?: string;
  subject: string;
  body: string;
  /** Hours before "now" the message arrived. */
  ageHours: number;
  labels?: string[];
  listUnsubscribe?: boolean;
  attachments?: string[];
}

const DEMO_TO = 'you@example.com';

const FIXTURES: Fixture[] = [
  {
    id: 'm001',
    from: 'Sarah Whitfield <sarah.whitfield@gmail.com>',
    subject: 'Re: dinner on Saturday?',
    body: "Hey! Saturday works for us. Shall we say 7 at ours? Tom's making that curry again if that's ok with you both. Let me know if you want us to pick anything up on the way.\n\nSarah",
    ageHours: 3,
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
  },
  {
    id: 'm002',
    from: 'Mark Davies <mark@northbridge-consulting.co.uk>',
    subject: 'Proposal v2 and next steps',
    body: 'Hi,\n\nAttached is the revised proposal with the phasing we discussed. Two things I need from you before Friday:\n\n1. Confirmation the June start date still works\n2. A named contact for the data access request\n\nHappy to jump on a call if easier.\n\nBest,\nMark',
    ageHours: 5,
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    attachments: ['Northbridge-Proposal-v2.pdf'],
  },
  {
    id: 'm003',
    from: 'Monzo <no-reply@monzo.com>',
    subject: 'Your statement for August is ready',
    body: 'Your monthly statement for the account ending 4471 is now available in the app. Total spent: £2,318.40. Total received: £4,100.00.',
    ageHours: 8,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm004',
    from: 'Amazon.co.uk <order-update@amazon.co.uk>',
    subject: 'Your order has been dispatched: Anker USB-C Hub',
    body: 'Hello, your order #203-4471920-1123 has been dispatched and will arrive on Thursday. Track your package in Your Orders. Order total: £34.99.',
    ageHours: 10,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm005',
    from: 'Ryanair <noreply@ryanair.com>',
    subject: 'Check-in is open for your flight to Dublin (FR 342)',
    body: 'Online check-in for your flight on 12 October, London Stansted to Dublin, is now open. Booking reference: QX7L2M. Check in now to choose your seat.',
    ageHours: 14,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm006',
    from: 'GitHub <noreply@github.com>',
    subject: '[GitHub] A new SSH key was added to your account',
    body: 'A new SSH public key was added to your account. If you did not do this, remove the key immediately from your account settings and review your recent activity.',
    ageHours: 20,
    labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm007',
    from: 'The Pragmatic Engineer <newsletter@pragmaticengineer.com>',
    subject: 'The Pulse: what happened in tech this week',
    body: 'This week: the state of engineering hiring, why on-call rotations keep getting longer, and a deep dive into how a mid-size company migrated off Kubernetes. Read the full issue online.',
    ageHours: 26,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
    listUnsubscribe: true,
  },
  {
    id: 'm008',
    from: 'Nike <nike@notifications.nike.com>',
    subject: 'Members get 25% off — this weekend only',
    body: 'Your member exclusive is here. Take 25% off selected styles until Sunday. Use code MEMBER25 at checkout. Shop the sale now.',
    ageHours: 30,
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    listUnsubscribe: true,
  },
  {
    id: 'm009',
    from: 'LinkedIn <messages-noreply@linkedin.com>',
    subject: 'You have 3 new connection requests',
    body: 'Priya Nair, Alex Turner and 1 other want to connect with you. Accept or ignore these requests from your network page.',
    ageHours: 33,
    labels: ['INBOX', 'CATEGORY_SOCIAL'],
    listUnsubscribe: true,
  },
  {
    id: 'm010',
    from: 'Dmitri Volkov <dmitri.volkov@bizgrowth-leads.biz>',
    subject: 'Quick question about your company',
    body: 'Hi there, I came across your website and was impressed. We help companies like yours 10x their lead generation with AI. Do you have 15 minutes this week for a quick call? If not, who is the right person to speak to?',
    ageHours: 40,
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
  },
  {
    id: 'm011',
    from: 'HMRC <noreply@hmrc.gov.uk>',
    subject: 'Reminder: your Self Assessment payment is due on 31 January',
    body: 'This is a reminder that your Self Assessment tax payment for the 2025 to 2026 tax year is due on 31 January. Interest will be charged on late payments. Sign in to your HMRC account to view the amount due.',
    ageHours: 48,
    labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm012',
    from: 'Apple <no_reply@email.apple.com>',
    subject: 'Your receipt from Apple',
    body: 'Receipt. iCloud+ 200GB storage plan, £2.99. Billed to the card ending 0192. Date: 1 September. Order ID: MLK3XQ9Z.',
    ageHours: 55,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm013',
    from: 'Spotify <no-reply@spotify.com>',
    subject: 'We miss you! Come back for 3 months free',
    body: 'Your Premium subscription ended, but the music did not have to. Get 3 months of Premium free when you come back before the end of the month.',
    ageHours: 60,
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    listUnsubscribe: true,
  },
  {
    id: 'm014',
    from: 'Topstep <support@topstep.com>',
    subject: 'Your payout request has been approved',
    body: 'Good news: your payout request of $2,400.00 for your Express Funded Account has been approved and will be sent within 2 business days. Keep an eye on your consistency rule as you continue trading.',
    ageHours: 70,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm015',
    from: 'Slack <feedback@slack.com>',
    subject: 'New message in #general from Priya',
    body: 'Priya Nair: "Deploy is done, dashboards look normal. Shout if anything looks off."',
    ageHours: 80,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
    listUnsubscribe: true,
  },
  {
    id: 'm016',
    from: 'Mum <linda.harvey61@btinternet.com>',
    subject: 'Photos from the weekend',
    body: 'Hello love, here are the photos from Sunday. Dad says the fence is finally finished! Are you still coming up on the 20th? Let me know what you fancy for dinner. Love, Mum x',
    ageHours: 90,
    labels: ['INBOX', 'CATEGORY_PERSONAL'],
    attachments: ['IMG_2041.jpg', 'IMG_2042.jpg', 'IMG_2044.jpg'],
  },
  {
    id: 'm017',
    from: 'Booking.com <noreply@booking.com>',
    subject: 'Your booking is confirmed: Hotel Riu Plaza, Dublin',
    body: 'Booking confirmed. Hotel Riu Plaza The Gresham Dublin, 12 to 14 October, 1 double room. Confirmation number 4419.203.117. Free cancellation until 5 October.',
    ageHours: 100,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm018',
    from: 'Dropbox <no-reply@dropbox.com>',
    subject: 'Updates to our Terms of Service',
    body: 'We are updating our Terms of Service and Privacy Policy, effective 1 November. The changes clarify how we handle account data. You do not need to do anything to continue using Dropbox.',
    ageHours: 120,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm019',
    from: 'Best Deals Daily <winner@prize-claims-center.top>',
    subject: 'CONGRATULATIONS you have been selected!!!',
    body: 'You have been selected to receive a $1000 gift card. Claim within 24 hours by confirming your details at the link below. This offer expires soon!',
    ageHours: 140,
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
  },
  {
    id: 'm020',
    from: 'Octopus Energy <hello@octopus.energy>',
    subject: 'Your energy bill: £96.12 due 28 September',
    body: 'Hi, your latest bill is ready. Electricity £61.40, gas £34.72, total £96.12. We will take payment by Direct Debit on 28 September. View the full breakdown in your account.',
    ageHours: 160,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm021',
    from: 'Ben Okafor <ben.okafor@fastmail.com>',
    subject: 'Can you send me that risk spreadsheet?',
    body: "Hey mate, you mentioned a spreadsheet you use to size positions against the trailing drawdown. Any chance you could send it over? Happy to buy you a pint for it.\n\nBen",
    ageHours: 180,
    labels: ['INBOX', 'CATEGORY_PERSONAL'],
  },
  {
    id: 'm022',
    from: 'Medium Daily Digest <noreply@medium.com>',
    subject: 'Stories for you: The hidden cost of context switching',
    body: 'Today\'s highlights: "The hidden cost of context switching" by Anna Lee, "I replaced my to-do list with a calendar" by Sam Rowe, and more picks based on your reading.',
    ageHours: 200,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
    listUnsubscribe: true,
  },
  {
    id: 'm023',
    from: 'Uber Eats <noreply@uber.com>',
    subject: 'Your Friday night order from Dishoom',
    body: 'Thanks for ordering with Uber Eats. Dishoom Kings Cross, delivered 20:14. Total £38.60 including delivery and service fee.',
    ageHours: 220,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
  {
    id: 'm024',
    from: 'Google <no-reply@accounts.google.com>',
    subject: 'Security alert: new sign-in from Windows',
    body: 'Your Google Account was just signed in to from a new Windows device. You are getting this email to make sure it was you. If this was not you, secure your account now.',
    ageHours: 240,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
];

/** Templates for freshly minted mail on later runs. */
const NEW_TEMPLATES: Omit<Fixture, 'id' | 'ageHours'>[] = [
  {
    from: 'Stripe <receipts@stripe.com>',
    subject: 'Payment received from Northbridge Consulting',
    body: 'You received a payment of £1,800.00 from Northbridge Consulting Ltd for invoice INV-0142. The funds will arrive in your bank account in 2 business days.',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
  },
  {
    from: 'ASOS <newsletters@asos.com>',
    subject: 'Up to 50% off: the mid-season sale starts now',
    body: 'Thousands of styles reduced. Shop now before your size sells out. Free delivery on orders over £35.',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
    listUnsubscribe: true,
  },
  {
    from: 'Priya Nair <priya.nair@northbridge-consulting.co.uk>',
    subject: 'Quick one: data access form',
    body: 'Hi, Mark asked me to chase the data access form. Could you sign the attached today if possible? Thanks, Priya',
    labels: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
    attachments: ['DataAccessForm.pdf'],
  },
  {
    from: 'Trello <do-not-reply@trello.com>',
    subject: 'Alex moved "Q4 roadmap" to Done',
    body: 'Alex Turner moved the card "Q4 roadmap" to the Done list on the Product board.',
    labels: ['INBOX', 'CATEGORY_UPDATES'],
    listUnsubscribe: true,
  },
  {
    from: 'Vodafone <no-reply@vodafone.co.uk>',
    subject: 'Your bill is ready: £28.00',
    body: 'Your latest bill of £28.00 is ready to view. We will collect it by Direct Debit on the 15th.',
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  },
];

interface MockState {
  /** message id -> current labels */
  labels: Record<string, string[]>;
  /** Minted messages beyond the fixtures. */
  extra: (Fixture & { receivedAt: number })[];
  /** Label name -> id */
  labelIds: Record<string, string>;
  lastMintedAt: number;
  /** Fixed "now" for fixture ages, so dates stay stable between runs. */
  epoch: number;
}

function stateKey(email: string): string {
  return `mock:${email}`;
}

async function loadState(email: string): Promise<MockState> {
  const row = await withDatabase(() =>
    prisma.setting.findUnique({ where: { scope_key: { scope: GLOBAL_SCOPE, key: stateKey(email) } } }),
  );
  if (row.ok && row.data) {
    try {
      const parsed = JSON.parse(row.data.value) as MockState;
      if (parsed && parsed.labels) return parsed;
    } catch {
      // fall through to a fresh state
    }
  }
  const epoch = Date.now();
  const labels: Record<string, string[]> = {};
  for (const fixture of FIXTURES) labels[fixture.id] = [...(fixture.labels ?? ['INBOX'])];
  return { labels, extra: [], labelIds: {}, lastMintedAt: 0, epoch };
}

async function saveState(email: string, state: MockState): Promise<void> {
  const value = JSON.stringify(state);
  await withDatabase(() =>
    prisma.setting.upsert({
      where: { scope_key: { scope: GLOBAL_SCOPE, key: stateKey(email) } },
      create: { scope: GLOBAL_SCOPE, key: stateKey(email), value },
      update: { value },
    }),
  );
}

interface Stored {
  fixture: Fixture;
  receivedAt: number;
}

function parseQuery(query: string): {
  after: number | null;
  before: number | null;
  excludeTrash: boolean;
  inInbox: boolean;
} {
  const after = /after:(\d{9,})/.exec(query);
  const before = /before:(\d{9,})/.exec(query);
  return {
    after: after ? Number(after[1]) : null,
    before: before ? Number(before[1]) : null,
    excludeTrash: /-in:trash/.test(query),
    inInbox: /(^|\s)in:inbox/.test(query),
  };
}

export class MockProvider implements MailProvider {
  readonly kind = 'mock' as const;

  constructor(private readonly email: string = MOCK_ACCOUNT_EMAIL) {}

  private all(state: MockState): Stored[] {
    const base = FIXTURES.map((fixture) => ({
      fixture,
      receivedAt: state.epoch - fixture.ageHours * 3_600_000,
    }));
    const extra = state.extra.map((fixture) => ({ fixture, receivedAt: fixture.receivedAt }));
    return [...base, ...extra].sort((a, b) => b.receivedAt - a.receivedAt);
  }

  private async mint(state: MockState): Promise<boolean> {
    const now = Date.now();
    // At most one minting per hour keeps the demo mailbox from ballooning.
    if (now - state.lastMintedAt < 3_600_000) return false;
    const count = state.lastMintedAt === 0 ? 0 : 1 + Math.floor(Math.random() * 2);
    state.lastMintedAt = now;
    for (let i = 0; i < count; i += 1) {
      const template = NEW_TEMPLATES[(state.extra.length + i) % NEW_TEMPLATES.length];
      const id = `n${String(state.extra.length + 1).padStart(3, '0')}`;
      const fixture: Fixture & { receivedAt: number } = {
        ...template,
        id,
        ageHours: 0,
        receivedAt: now - i * 60_000,
      };
      state.extra.push(fixture);
      state.labels[id] = [...(template.labels ?? ['INBOX'])];
    }
    return true;
  }

  async profile(): Promise<MailProfile> {
    const state = await loadState(this.email);
    return { email: this.email, messagesTotal: this.all(state).length };
  }

  async listIds(query: string, limit: number, pageToken?: string | null): Promise<ListPage> {
    const state = await loadState(this.email);
    const q = parseQuery(query);
    if (q.after !== null && (await this.mint(state))) await saveState(this.email, state);

    const matches = this.all(state).filter(({ fixture, receivedAt }) => {
      const labels = state.labels[fixture.id] ?? [];
      const seconds = Math.floor(receivedAt / 1000);
      if (q.after !== null && seconds <= q.after) return false;
      if (q.before !== null && seconds >= q.before) return false;
      if (q.excludeTrash && labels.includes('TRASH')) return false;
      if (q.inInbox && !labels.includes('INBOX')) return false;
      return true;
    });

    const offset = pageToken ? Number(pageToken) || 0 : 0;
    const page = matches.slice(offset, offset + limit);
    const next = offset + limit < matches.length ? String(offset + limit) : null;
    return { ids: page.map((m) => m.fixture.id), nextPageToken: next, estimate: matches.length };
  }

  private find(state: MockState, id: string): Stored | null {
    return this.all(state).find((m) => m.fixture.id === id) ?? null;
  }

  async fetch(id: string, maxBodyChars: number): Promise<RawEmail | null> {
    const state = await loadState(this.email);
    const stored = this.find(state, id);
    if (!stored) return null;
    const { fixture, receivedAt } = stored;
    const from = parseAddress(fixture.from);
    return {
      id: fixture.id,
      threadId: `t-${fixture.id}`,
      internalDate: new Date(receivedAt),
      from,
      to: fixture.to ?? DEMO_TO,
      replyTo: null,
      subject: fixture.subject,
      snippet: fixture.body.slice(0, 160),
      bodyText: cleanBody(fixture.body, maxBodyChars),
      hasAttachments: Boolean(fixture.attachments?.length),
      attachmentNames: fixture.attachments ?? [],
      listUnsubscribe: Boolean(fixture.listUnsubscribe),
      automated: Boolean(fixture.listUnsubscribe),
      labelIds: [...(state.labels[fixture.id] ?? [])],
    };
  }

  async fetchBody(id: string, maxChars: number): Promise<string | null> {
    const state = await loadState(this.email);
    const stored = this.find(state, id);
    return stored ? cleanBody(stored.fixture.body, maxChars) : null;
  }

  async modify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    const state = await loadState(this.email);
    for (const id of ids) {
      const current = new Set(state.labels[id] ?? []);
      for (const label of removeLabelIds) current.delete(label);
      for (const label of addLabelIds) current.add(label);
      state.labels[id] = [...current];
    }
    await saveState(this.email, state);
  }

  async trash(id: string): Promise<void> {
    await this.modify([id], ['TRASH'], ['INBOX']);
  }

  async untrash(id: string): Promise<void> {
    await this.modify([id], [], ['TRASH']);
  }

  async ensureLabels(names: string[]): Promise<Record<string, string>> {
    const state = await loadState(this.email);
    let changed = false;
    const result: Record<string, string> = {};
    for (const name of names) {
      if (!state.labelIds[name]) {
        state.labelIds[name] = `Label_${Object.keys(state.labelIds).length + 1}`;
        changed = true;
      }
      result[name] = state.labelIds[name];
    }
    if (changed) await saveState(this.email, state);
    return result;
  }
}
