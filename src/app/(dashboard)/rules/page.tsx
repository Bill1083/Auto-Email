import { listAccounts, resolveSelection } from '@/lib/accounts';
import { listCategories } from '@/lib/categories';
import { CategoriesEditor } from '@/components/rules/categories-editor';
import { ProfileEditor } from '@/components/rules/profile-editor';
import { RulesManager } from '@/components/rules/rules-manager';
import { SuggestionsList } from '@/components/rules/suggestions-list';
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
  const settings = await getSettings();

  const [categories, rules, suggestions, nudges] = await Promise.all([
    listCategories(true),
    withDatabase(() => prisma.rule.findMany({ orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }] })),
    suggestRules(selected?.id ?? null, settings.suggestionThreshold),
    categoryNudges(),
  ]);
  const names = Object.fromEntries(categories.map((c) => [c.key, c.name]));

  return (
    <>
      <PageHeader
        title="Rules & preferences"
        description="What you tell the AI up front, what it has learned from your reviews, and the categories it files into."
      />
      <div className="space-y-5">
        <ProfileEditor
          profileText={settings.profileText}
          learnedNotes={settings.learnedNotes}
          learnedNotesUpdatedAt={settings.learnedNotesUpdatedAt}
          geminiConfigured={isGeminiConfigured()}
        />
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
