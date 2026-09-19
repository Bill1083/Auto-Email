import { listAccounts, resolveSelection } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { CategoriesEditor } from '@/components/rules/categories-editor';
import { ProfileEditor } from '@/components/rules/profile-editor';
import { RulesManager } from '@/components/rules/rules-manager';
import { SuggestionsList } from '@/components/rules/suggestions-list';
import { ChooseMailbox } from '@/components/shared/choose-mailbox';
import { PageHeader } from '@/components/stat-card';
import { isGeminiConfigured } from '@/lib/gemini';
import { categoryNudges, suggestRules } from '@/lib/pipeline/learning';
import { prisma, withDatabase } from '@/lib/prisma';
import { serializeAccount, serializeCategory, serializeRule } from '@/lib/serialize';
import { getSettings } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Rules' };

export default async function RulesPage() {
  const accounts = await listAccounts();
  const { selected, selectedId } = await resolveSelection(accounts);
  // Everything on this page follows the mailbox chosen in the top right.
  const settings = await getSettings(selected?.id ?? null);

  const [categories, rules, suggestions, nudges] = await Promise.all([
    listCategories(true),
    withDatabase(() =>
      prisma.rule.findMany({
        // A mailbox sees its own rules plus the ones that apply to every mailbox.
        where: selected ? { OR: [{ accountId: null }, { accountId: selected.id }] } : undefined,
        orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
      }),
    ),
    suggestRules(selected?.id ?? null, settings.suggestionThreshold),
    categoryNudges(),
  ]);
  const names = Object.fromEntries(categories.map((c) => [c.key, c.name]));

  return (
    <>
      <PageHeader
        title="Rules & preferences"
        description={
          selected
            ? `What you tell the AI about ${selected.email}, what it has learned there, and the rules it applies. Switch mailbox in the top right.`
            : 'Viewing all accounts. Choose a mailbox in the top right to edit its profile and preferences.'
        }
      />
      <div className="space-y-5">
        {selected ? (
          <ProfileEditor
            key={selected.id}
            mailbox={{
              id: selected.id,
              email: selected.email,
              profileText: settings.profileText,
              learnedNotes: settings.learnedNotes,
              learnedNotesUpdatedAt: settings.learnedNotesUpdatedAt,
            }}
            geminiConfigured={isGeminiConfigured()}
          />
        ) : (
          <ChooseMailbox
            title="About you"
            what="profile and learned preferences"
            hasMailboxes={accounts.length > 0}
          />
        )}
        <SuggestionsList
          suggestions={suggestions}
          nudges={nudges}
          threshold={settings.suggestionThreshold}
          names={names}
        />
        <RulesManager
          rules={rules.ok ? rules.data.map(serializeRule) : []}
          categories={categories.filter((c) => c.enabled).map((c) => ({ key: c.key, name: c.name }))}
          accounts={accounts.map(serializeAccount)}
          selectedId={selectedId}
        />
        <CategoriesEditor categories={categories.map(serializeCategory)} labelPrefix={settings.labelPrefix} />
      </div>
    </>
  );
}
