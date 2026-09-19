import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { OTHER_CATEGORY } from '@/lib/categories';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeCategory } from '@/lib/serialize';
import { ACTIONS, parseLabelMap } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: { key: string };
}

const patchSchema = z
  .object({
    name: z.string().trim().min(2).max(40),
    description: z.string().trim().min(10).max(500),
    labelName: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[^/\\]+$/, 'must not contain slashes')
      .nullable(),
    defaultAction: z.enum(ACTIONS),
    allowTrash: z.boolean(),
    autoTrash: z.boolean(),
    enabled: z.boolean(),
    sortOrder: z.number().int().min(0).max(10_000),
  })
  .partial()
  .strict();

/** PATCH /api/categories/:key */
export async function PATCH(request: Request, { params }: RouteContext) {
  return guard(async () => {
    const parsed = await readJson(request, patchSchema, 16 * 1024);
    if (!parsed.ok) return parsed.response;
    const key = params.key.toUpperCase();
    const existing = await withDatabase(() => prisma.category.findUnique({ where: { key } }));
    if (!existing.ok) return fail('The database could not be reached.', 503);
    if (!existing.data) return fail('No such category.', 404);

    const data = { ...parsed.data };
    if (key === OTHER_CATEGORY && data.enabled === false) {
      return fail('The Other category is the fallback and cannot be disabled.', 422);
    }
    if (data.allowTrash === false) data.autoTrash = false;
    if (data.autoTrash && !(data.allowTrash ?? existing.data.allowTrash)) {
      return fail('Allow trashing before enabling auto-trash.', 422);
    }

    // A renamed label is created afresh on each account's next run; the old
    // Gmail label is left in place.
    if (data.labelName !== undefined && data.labelName !== existing.data.labelName) {
      const accounts = await withDatabase(() => prisma.account.findMany());
      if (accounts.ok) {
        for (const account of accounts.data) {
          const map = parseLabelMap(account.labelMapJson);
          if (map[key]) {
            delete map[key];
            await withDatabase(() =>
              prisma.account.update({ where: { id: account.id }, data: { labelMapJson: JSON.stringify(map) } }),
            );
          }
        }
      }
    }

    const updated = await withDatabase(() => prisma.category.update({ where: { key }, data }));
    if (!updated.ok) return fail('The category could not be updated.', 500);
    return ok({ category: serializeCategory(updated.data) });
  }, 'PATCH /api/categories/:key');
}

/** DELETE /api/categories/:key — custom categories only. */
export async function DELETE(_request: Request, { params }: RouteContext) {
  return guard(async () => {
    const key = params.key.toUpperCase();
    const existing = await withDatabase(() => prisma.category.findUnique({ where: { key } }));
    if (!existing.ok) return fail('The database could not be reached.', 503);
    if (!existing.data) return fail('No such category.', 404);
    if (existing.data.builtIn) return fail('Built-in categories can be disabled but not deleted.', 422);
    const deleted = await withDatabase(() => prisma.category.delete({ where: { key } }));
    if (!deleted.ok) return fail('The category could not be deleted.', 500);
    return ok({ deleted: key });
  }, 'DELETE /api/categories/:key');
}
