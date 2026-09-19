import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { normalisePattern } from '@/lib/pipeline/rules';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeRule } from '@/lib/serialize';
import { ACTIONS } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { id: string };
}

const patchSchema = z
  .object({
    pattern: z.string().trim().min(1).max(200),
    action: z.enum(ACTIONS).nullable(),
    category: z.string().trim().min(1).max(40).nullable(),
    note: z.string().trim().max(1_000),
    autoApply: z.boolean(),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

/** PATCH /api/rules/:id */
export async function PATCH(request: Request, { params }: RouteContext) {
  return guard(async () => {
    const parsed = await readJson(request, patchSchema, 16 * 1024);
    if (!parsed.ok) return parsed.response;
    const existing = await withDatabase(() => prisma.rule.findUnique({ where: { id: params.id } }));
    if (!existing.ok) return fail('The database could not be reached.', 503);
    if (!existing.data) return fail('No such rule.', 404);

    const data = { ...parsed.data };
    if (data.pattern !== undefined && existing.data.kind !== 'FREEFORM') {
      data.pattern = normalisePattern(existing.data.kind, data.pattern);
    }
    const action = data.action === undefined ? existing.data.action : data.action;
    if (existing.data.kind !== 'FREEFORM' && !action) {
      return fail('A matching rule needs an action.', 422);
    }
    if (data.autoApply && action !== 'TRASH') data.autoApply = false;

    const updated = await withDatabase(() =>
      prisma.rule.update({ where: { id: params.id }, data }),
    );
    if (!updated.ok) return fail('The rule could not be updated.', 500);
    return ok({ rule: serializeRule(updated.data) });
  }, 'PATCH /api/rules/:id');
}

/** DELETE /api/rules/:id */
export async function DELETE(_request: Request, { params }: RouteContext) {
  return guard(async () => {
    const deleted = await withDatabase(() => prisma.rule.delete({ where: { id: params.id } }));
    if (!deleted.ok) return fail('That rule could not be deleted; it may already be gone.', 404);
    return ok({ deleted: params.id });
  }, 'DELETE /api/rules/:id');
}
