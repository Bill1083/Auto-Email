/**
 * Environment access.
 *
 * Nothing here throws on a missing key. The app boots on an empty `.env` and
 * the dashboard shows a setup checklist naming what is still missing. Values
 * under "processing defaults" only seed the Settings table on first boot;
 * after that the database wins (see `lib/settings.ts`).
 */

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFloat(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = read(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const env = {
  // --- core --------------------------------------------------------------
  get appUrl(): string {
    return (read('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
  },
  get timezone(): string {
    const tz = read('APP_TIMEZONE') ?? 'UTC';
    return isValidTimeZone(tz) ? tz : 'UTC';
  },
  get databaseUrl(): string | undefined {
    return read('DATABASE_URL');
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  },

  // --- dashboard access --------------------------------------------------
  get dashboardPassword(): string | undefined {
    return read('DASHBOARD_PASSWORD');
  },
  get sessionSecret(): string | undefined {
    return read('SESSION_SECRET');
  },
  /** How long a sign-in lasts before Google (or the password) is asked again. */
  get sessionTtlDays(): number {
    return Math.min(365, Math.max(1, readInt('SESSION_TTL_DAYS', 30)));
  },
  get tokenEncryptionKey(): string | undefined {
    return read('TOKEN_ENCRYPTION_KEY');
  },
  get cronSecret(): string | undefined {
    return read('CRON_SECRET');
  },
  /** Google identities allowed to sign in to the dashboard. */
  get dashboardAllowedEmails(): string[] {
    return (read('DASHBOARD_ALLOWED_EMAILS') ?? '')
      .split(/[,\s;]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.includes('@'));
  },
  get googleLoginEnabled(): boolean {
    return Boolean(env.googleClientId && env.googleClientSecret) && env.dashboardAllowedEmails.length > 0;
  },
  get passwordLoginEnabled(): boolean {
    return Boolean(env.dashboardPassword);
  },

  // --- google ------------------------------------------------------------
  get googleClientId(): string | undefined {
    return read('GOOGLE_CLIENT_ID');
  },
  get googleClientSecret(): string | undefined {
    return read('GOOGLE_CLIENT_SECRET');
  },
  get googleRedirectUri(): string {
    return read('GOOGLE_REDIRECT_URI') ?? `${env.appUrl}/api/google/callback`;
  },

  // --- gemini ------------------------------------------------------------
  get geminiApiKey(): string | undefined {
    // GOOGLE_API_KEY is what the SDK itself looks for; accept either.
    return read('GEMINI_API_KEY') ?? read('GOOGLE_API_KEY');
  },
  get geminiModel(): string {
    return read('GEMINI_MODEL') ?? 'gemini-2.5-flash';
  },
  get geminiPriceInputPerM(): number {
    return readFloat('GEMINI_PRICE_INPUT_PER_M', 0.3);
  },
  get geminiPriceOutputPerM(): number {
    return readFloat('GEMINI_PRICE_OUTPUT_PER_M', 2.5);
  },

  // --- processing defaults (seed values only) -----------------------------
  get dailyEmailLimit(): number {
    return Math.max(0, readInt('DAILY_EMAIL_LIMIT', 100));
  },
  get aiBatchSize(): number {
    return Math.min(50, Math.max(1, readInt('AI_BATCH_SIZE', 10)));
  },
  get maxBodyChars(): number {
    return Math.min(20_000, Math.max(200, readInt('MAX_BODY_CHARS', 1_500)));
  },
  get runTimes(): string {
    return read('RUN_TIMES') ?? '07:00,19:00';
  },
  get newMailPollMinutes(): number {
    return Math.max(0, readInt('NEW_MAIL_POLL_MINUTES', 0));
  },
  get dryRun(): boolean {
    return readBool('DRY_RUN', true);
  },
  get backlogOrder(): 'newest' | 'oldest' {
    return read('BACKLOG_ORDER')?.toLowerCase() === 'oldest' ? 'oldest' : 'newest';
  },
  get backlogQuery(): string {
    return read('BACKLOG_QUERY') ?? '-in:spam -in:trash -in:sent -in:drafts -in:chats';
  },
  get labelPrefix(): string {
    return read('LABEL_PREFIX') ?? 'AutoMail';
  },
  get autoTrashMinConfidence(): number {
    return Math.min(100, Math.max(0, readInt('AUTO_TRASH_MIN_CONFIDENCE', 90)));
  },
  get schedulerEnabled(): boolean {
    return readBool('SCHEDULER_ENABLED', true);
  },
  get mockMail(): boolean {
    return readBool('MOCK_MAIL', false);
  },
} as const;

export interface IntegrationStatus {
  gemini: boolean;
  google: boolean;
  googleLogin: boolean;
  database: boolean;
  encryption: boolean;
  password: boolean;
  session: boolean;
  mockMail: boolean;
}

/** Which integrations have credentials configured. Safe to send to the client. */
export function integrationStatus(): IntegrationStatus {
  return {
    gemini: Boolean(env.geminiApiKey),
    google: Boolean(env.googleClientId && env.googleClientSecret),
    googleLogin: env.googleLoginEnabled,
    database: Boolean(env.databaseUrl),
    encryption: Boolean(env.tokenEncryptionKey),
    password: env.passwordLoginEnabled,
    session: Boolean(env.sessionSecret),
    mockMail: env.mockMail,
  };
}
