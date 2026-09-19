import { z } from 'zod';

import { fail, guard, ok, readJson } from '@/lib/api';
import { categoryKeyFromName, listCategories } from '@/lib/categories';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeCategory } from '@/lib/serialize';
import { ACTIONS } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GET /api/categories — the full taxonomy including disabled entries. */
export async function GET() {
  return guard(async () => {
    const categories = await listCategories(true);
    return ok({ categories: categories.map(serializeCategory) });
  }, 'GET /api/categories');
}

const bodySchema = z.object({
  name: z.string().trim().min(2).max(40),
  description: z.string().trim().min(10).max(500),
  labelName: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^/\\]+$/, 'must not contain slashes')
    .nullable()
    .default(null),
  defaultAction: z.enum(ACTIONS).default('KEEP'),
  allowTrash: z.boolean().default(false),
});

/** POST /api/categories — add a custom category. */
export async function POST(request: Request) {
  return guard(async () => {
    const parsed = await readJson(request, bodySchema, 16 * 1024);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const key = categoryKeyFromName(body.name);
    if (!key) return fail('The name must contain letters or numbers.', 422);

    const existing = await withDatabase(() => prisma.category.findUnique({ where: { key } }));
    if (!existing.ok) return fail('The database could not be reached.', 503);
    if (existing.data) return fail(`A category with the key ${key} already exists.`, 409);

    const max = await withDatabase(() => prisma.category.aggregate({ _max: { sortOrder: true } }));
    const created = await withDatabase(() =>
      prisma.category.create({
        data: {
          key,
          name: body.name,
          description: body.description,
          labelName: body.labelName ?? body.name,
          defaultAction: body.defaultAction,
          allowTrash: body.allowTrash,
          builtIn: false,
          sortOrder: (max.ok ? max.data._max.sortOrder ?? 100 : 100) + 10,
        },
      }),
    );
    if (!created.ok) return fail('The category could not be created.', 500);
    return ok({ category: serializeCategory(created.data) }, { status: 201 });
  }, 'POST /api/categories');
}
