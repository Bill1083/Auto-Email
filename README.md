# AutoMail

AI email triage for your Gmail accounts, with a dashboard that shows every
decision and lets you correct it.

Each run it reads a bounded number of emails (100 a day by default), files each
one into a fixed set of categories as Gmail labels, archives what does not need
your attention, proposes what to delete, and flags what you must read or act on.
You confirm deletions in bulk, rescue the ones that matter, and every choice you
make teaches it. Over the weeks it works through the backlog without you
touching it.

Three things it will never do: permanently delete mail (it only moves things to
Gmail's Trash, and asks for the `gmail.modify` scope which cannot hard-delete),
trash mail in a protected category (Finance, Personal, Work, Travel, Accounts,
Receipts), or act while **dry run** is on, which it is on first boot.

---

## Stack

| Layer     | Choice                                                     |
| --------- | ---------------------------------------------------------- |
| Framework | Next.js 14 (App Router) + TypeScript                       |
| UI        | Tailwind CSS, shadcn/ui, Lucide, Recharts                  |
| Database  | SQLite via Prisma                                          |
| AI        | Google Gemini (`@google/genai`), structured output         |
| Mail      | Gmail REST API over OAuth 2.0 (PKCE), plain `fetch`        |
| Auth      | Sign in with Google (allowlisted addresses) or a password  |
| Tests     | Vitest over the rules, guards, parsing, cost and auth code |
| Deploy    | Docker + Nginx + Certbot on a single VPS                   |

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

For local work set these in `.env`:

```dotenv
DATABASE_URL="file:./dev.db"
NEXT_PUBLIC_APP_URL=http://localhost:3000
SESSION_SECRET=<openssl rand -base64 32>
TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
DASHBOARD_PASSWORD=anything-for-dev
MOCK_MAIL=true
```

Then:

```bash
npx prisma db push
```

```bash
npm run dev
```

Open <http://localhost:3000>, sign in with the password, go to **Settings →
Add demo mailbox**, and press **Run now**. The demo mailbox is 24 realistic
fixture emails plus a couple of new ones minted on later runs, so every page,
the review flow, undo and the learning loop can be exercised without Google or
Gemini credentials. Without a Gemini key, emails no rule matches are sent to
**Needs attention** instead of being classified.

---

## How it decides

For every email in a run, in order:

1. **Rules first.** A matching sender, domain or subject rule decides the email
   outright: no tokens, no ambiguity. Rules can also be free-text instructions
   that go to the model with every batch.
2. **Then the model.** The remaining emails go to Gemini ten at a time (the
   batch size is configurable) with your profile, your learned preferences,
   the category list, your instructions and the corrections most relevant to
   those senders. The response is constrained by a schema and validated with
   Zod.
3. **Then the guards.** Deterministic checks the model cannot talk its way
   around: unknown categories become *Other*, a trash verdict on a protected
   category becomes archive or keep, anything that needs a reply becomes
   *Attention*, and a trash verdict below the confidence floor is never applied
   automatically.
4. **Then Gmail.** Keep adds the category label. Archive also removes the
   inbox label. Attention adds a label and a star. Trash moves the email under
   `AutoMail/Review`, out of the inbox, until you confirm or rescue it (or, once
   you have opted in per sender or per category, straight to Trash).

Every change is recorded as the exact label ids added and removed, so undo is
a mechanical reversal.

### Learning

- **About you** and **learned preferences** on the Rules page are sent with
  every batch.
- Every correction you make (rescue, re-categorise, "not important", thumbs
  up) is stored and shown to the model as a worked example when the same
  sender or domain comes up again.
- After three consistent reviews of one sender (configurable) a rule is
  suggested; accepting it is one click. Senders whose trash proposals you
  always confirm are suggested as auto-trash rules.
- Once a week the model distils your correction history into a short list of
  general preferences that you can edit line by line.

### The daily cap and the backlog

`DAILY_EMAIL_LIMIT` (default 100, per mailbox, editable in Settings) counts every
email touched that day, rule-decided or not. Each run spends the budget on new
mail first, then on the backlog. The backlog is a one-time snapshot of every
message id matching the backlog search (by default everything received), worked
newest-first or oldest-first. The dashboard shows how many remain, how many days
that is at the current cap, and what it will cost.

---

## The dashboard

- **Overview** — processed today against the cap, what is waiting for you, the
  backlog and its projected cost, spend today / this month / per email, a
  14-day chart of what was done, the latest decisions, and mailbox health.
- **Review** — the **delete queue** (confirm in bulk, rescue individually, change
  the category) and **needs attention** (done, archive, never flag this sender).
- **Activity** — everything the pipeline did, filterable, with undo, thumbs-up
  and "change" on every row, plus a **Deleted** view for the 30-day undo window.
- **Rules** — your profile, learned preferences, rules and instructions,
  suggested rules, and the category editor (default action, allow trash,
  auto-trash, add your own).
- **Settings** — mailboxes (connect, reconnect, pause, per-mailbox cap, reset
  backlog, disconnect), processing (cap, batch size, run times, polling,
  dry run, backlog order and search), mailbox behaviour, learning, model and
  prices, and what is configured on the server.

The header switches between mailboxes, or shows all of them together. Switching
is a cookie and a server render; you never sign out to change mailbox.

---

## Security

- **Sign in with Google**, restricted to the addresses in
  `DASHBOARD_ALLOWED_EMAILS`, with PKCE and CSRF state checks. The password is
  an optional fallback and is disabled while `DASHBOARD_PASSWORD` is empty.
- Sessions are signed, HttpOnly, Secure cookies that last `SESSION_TTL_DAYS`
  (30 by default), so you sign in once a month.
- Mailbox refresh tokens are encrypted at rest with AES-256-GCM under
  `TOKEN_ENCRYPTION_KEY`, revoked at Google when you disconnect, and only ever
  used server-side.
- The middleware refuses cross-site state changes, login attempts are rate
  limited in the app and again in Nginx, and Nginx strips the header behind
  the Next.js middleware-bypass CVE.
- Email bodies are never stored: the database holds headers, a short snippet,
  the decision and what was done. The preview pane fetches from Gmail on demand.
- The only Gmail scope requested is `gmail.modify`, which cannot permanently
  delete, change settings or send mail.

---

## Environment

Nothing is required to boot: the dashboard shows a setup checklist. See
`.env.example` for every variable with comments. The ones that matter:

| Variable                     | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `SESSION_SECRET`             | Signs login cookies. Required to sign in at all.            |
| `TOKEN_ENCRYPTION_KEY`       | Encrypts mailbox tokens. Required to connect a mailbox.     |
| `DASHBOARD_ALLOWED_EMAILS`   | Who may sign in with Google.                               |
| `DASHBOARD_PASSWORD`         | Optional password sign-in (empty = disabled).               |
| `GOOGLE_CLIENT_ID` / `_SECRET` | OAuth client for sign-in and mailbox connection.          |
| `GOOGLE_REDIRECT_URI`        | `https://YOUR_DOMAIN/api/google/callback`                   |
| `GEMINI_API_KEY`             | Classification. Without it unmatched mail goes to Attention.|
| `GEMINI_MODEL`               | Default `gemini-2.5-flash`.                                 |
| `GEMINI_PRICE_*_PER_M`       | Prices used for the cost figures; editable in Settings.     |
| `APP_TIMEZONE`               | Defines "today" for the cap and the run times.              |
| `MOCK_MAIL`                  | `true` serves the fixture mailbox instead of Google.        |
| `CRON_SECRET`                | Optional bearer token for `POST /api/jobs/run`.             |

Processing defaults (`DAILY_EMAIL_LIMIT`, `RUN_TIMES`, `DRY_RUN`, and so on) only
seed the Settings page on first boot; the dashboard owns them afterwards.

---

## API

Every route except the ones marked public needs the session cookie.

| Method      | Route                                | Purpose                                            |
| ----------- | ------------------------------------ | -------------------------------------------------- |
| GET         | `/api/health`                        | Liveness and which integrations are configured (public) |
| GET         | `/api/auth/methods`                  | Which sign-in methods to offer (public)             |
| GET         | `/api/auth/google/start`, `/callback`| Sign in with Google (public)                       |
| POST        | `/api/auth/login`, `/logout`         | Password sign-in / sign out                         |
| GET         | `/api/google/start`, `/callback`     | Connect a mailbox                                   |
| GET/POST    | `/api/accounts`                      | List mailboxes / add the demo mailbox               |
| PATCH/DELETE| `/api/accounts/:id`                  | Pause, cap, reset backlog / disconnect              |
| POST        | `/api/accounts/select`               | Choose the mailbox the dashboard shows              |
| POST/GET    | `/api/runs`, `/api/runs/:id`         | Start a run in the background / inspect runs        |
| POST        | `/api/jobs/run`                      | Cron entry point, bearer `CRON_SECRET` (public)     |
| GET         | `/api/messages`                      | Decisions, filterable (`view=review\|attention\|deleted\|all`) |
| GET         | `/api/messages/:id/body`             | Body excerpt fetched live from the mailbox          |
| POST        | `/api/messages/:id/feedback`         | Keep / archive / trash / attention / done / confirm |
| POST        | `/api/messages/:id/undo`             | Reverse every change made to the message            |
| POST        | `/api/messages/bulk`                 | The same, for many ids                              |
| GET/POST    | `/api/rules`, PATCH/DELETE `/api/rules/:id` | Rules and instructions                        |
| GET/POST    | `/api/rules/suggestions`             | Learned suggestions; accept or dismiss              |
| POST        | `/api/rules/learn`                   | Regenerate the learned preferences                  |
| GET/POST    | `/api/categories`, PATCH/DELETE `/api/categories/:key` | The taxonomy                       |
| GET/PATCH   | `/api/settings`                      | Runtime settings                                    |
| POST        | `/api/settings/reset`                | Clear history                                       |
| GET         | `/api/stats`                         | Overview numbers                                    |

---

## Tests

```bash
npm test
```

Covers the parts that must be right whether or not any key is present: rule
matching and precedence, the daily-cap arithmetic, timezone and DST handling
for the scheduler, the model response contract and every guard, MIME and HTML
to text conversion with quoted-reply stripping, cost arithmetic, the label
change planner and its reversal, token encryption, and session signing.

---

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full Ubuntu VPS walkthrough:
Google Cloud setup, Docker, Nginx reverse proxy, DNS and free Let's Encrypt SSL.

The short version:

```bash
cp .env.example .env && docker compose up -d --build
```
