import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { normalisePattern } from '@/lib/pipeline/rules';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeRule } from '@/lib/serialize';
import { ACTIONS, RULE_KINDS } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/rules?accountId= — global rules plus the account's own. */
export async function GET(request: Request) {
  return guard(async () => {
    const accountId = new URL(request.url).searchParams.get('accountId');
    const result = await withDatabase(() =>
      prisma.rule.findMany({
        where:
          accountId && accountId !== 'all'
            ? { OR: [{ accountId: null }, { accountId }] }
            : undefined,
        orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
      }),
    );
    if (!result.ok) return fail('The database could not be reached.', 503);
    return ok({ rules: result.data.map(serializeRule) });
  }, 'GET /api/rules');
}

const ruleBodySchema = z
  .object({
    accountId: z.string().min(1).max(64).nullable().default(null),
    kind: z.enum(RULE_KINDS),
    pattern: z.string().trim().max(200).default(''),
    action: z.enum(ACTIONS).nullable().default(null),
    category: z.string().trim().min(1).max(40).nullable().default(null),
    note: z.string().trim().max(1_000).default(''),
    autoApply: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'FREEFORM') {
      if (!value.note && !value.pattern) {
        ctx.addIssue({ code: 'custom', path: ['note'], message: 'Write the instruction.' });
      }
      return;
    }
    if (!value.pattern) {
      ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'A pattern is required.' });
    }
    if (!value.action) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: 'Choose an action.' });
    }
    if (value.kind === 'SENDER' && value.pattern && !value.pattern.includes('@')) {
      ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'A sender rule needs a full address (use a domain rule otherwise).' });
    }
    if (value.kind === 'DOMAIN' && value.pattern && value.pattern.includes('@')) {
      ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'A domain rule takes just the domain, e.g. example.com.' });
    }
  });

/** POST /api/rules — create a rule or a free-text instruction. */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, ruleBodySchema, 16 * 1024);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    if (body.accountId) {
      const account = await withDatabase(() => prisma.account.findUnique({ where: { id: body.accountId as string } }));
      if (!account.ok || !account.data) return fail('No such account.', 404);
    }

    const created = await withDatabase(() =>
      prisma.rule.create({
        data: {
          accountId: body.accountId,
          kind: body.kind,
          pattern: body.kind === 'FREEFORM' ? body.pattern : normalisePattern(body.kind, body.pattern),
          action: body.kind === 'FREEFORM' ? null : body.action,
          category: body.category,
          note: body.kind === 'FREEFORM' ? body.note || body.pattern : body.note,
          autoApply: body.action === 'TRASH' && body.autoApply,
          enabled: body.enabled,
          source: 'user',
        },
      }),
    );
    if (!created.ok) return fail('The database could not be reached.', 503);
    return ok({ rule: serializeRule(created.data) }, { status: 201 });
  }, 'POST /api/rules');
}
