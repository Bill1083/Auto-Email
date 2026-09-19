# Deploying AutoMail to an Ubuntu VPS

End-to-end setup: a fresh Ubuntu 22.04/24.04 server to a working HTTPS URL with
Google sign-in and a connected Gmail account. Roughly 30 minutes, a third of it
in the Google Cloud console.

**What you need**

- An Ubuntu VPS with at least 1 vCPU / 1GB RAM (2GB makes the Docker build
  comfortable) and a public IPv4 address.
- A domain you control, so you can point an A record at that address.
- A Google account that will own the Google Cloud project (any Gmail address
  works; it does not have to be one of the mailboxes you connect).
- A [Gemini API key](https://aistudio.google.com/apikey). The app runs without
  it, but every email no rule matches is then sent to "Needs attention".

---

## 1. Point DNS at the server

Do this first: DNS propagation runs in the background while you set up the box.

In your registrar's DNS panel, create:

| Type | Name       | Value          | TTL |
| ---- | ---------- | -------------- | --- |
| A    | `automail` | `203.0.113.10` | 300 |

Replace `203.0.113.10` with your server's IP and `automail` with whatever
subdomain you want (or `@` for the bare domain). The rest of this guide uses
`automail.example.com`.

Check it has landed before requesting a certificate:

```bash
dig +short automail.example.com
```

Certbot will fail if this does not return your server's IP.

---

## 2. Google Cloud setup

Both signing in to the dashboard and connecting mailboxes go through one OAuth
client. This takes about ten minutes.

1. Open <https://console.cloud.google.com> and create a project (for example
   "AutoMail").
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (called *Google Auth Platform*
   in newer consoles):
   - User type **External**. App name "AutoMail", your email as the support
     and developer contact.
   - **Scopes**: add `https://www.googleapis.com/auth/gmail.modify`, plus
     `openid` and `.../auth/userinfo.email`.
   - **Test users**: add every Gmail address you will sign in with or connect.
4. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Add both authorised redirect URIs:
   - `https://automail.example.com/api/google/callback` (mailbox connection)
   - `https://automail.example.com/api/auth/google/callback` (sign-in)

   Copy the **Client ID** and **Client secret**; they go in `.env` below.
5. **Publishing status.** An app left in *Testing* is issued refresh tokens
   that expire every 7 days, which means reconnecting every mailbox weekly.
   Press **Publish app** to move it to *In production*. You do **not** need to
   submit it for verification for personal use: Google shows a "hasn't
   verified this app" screen once per account, where you click **Advanced →
   Go to AutoMail (unsafe)**. That wording refers to Google not having audited
   the app; it is your own server.

If you ever see "This app is blocked" instead, Google has decided verification
is required for that project. Two workarounds: keep the project in *Testing*
and use the dashboard's **Reconnect** button when a mailbox expires, or set the
consent screen's user type to *Internal* if the mailboxes are Google Workspace
accounts.

---

## 3. Prepare the server

SSH in as root, then create a non-root user with Docker access:

```bash
adduser --gecos "" deploy && usermod -aG sudo deploy
```

Log back in as `deploy` and update the machine:

```bash
sudo apt update && sudo apt upgrade -y
```

### Firewall

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
```

Port 3000 is deliberately **not** opened. The container binds to
`127.0.0.1:3000` and is only reachable through Nginx.

### Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Let `deploy` use Docker without `sudo`:

```bash
sudo usermod -aG docker deploy && newgrp docker
```

Verify:

```bash
docker run --rm hello-world
```

---

## 4. Clone and configure

```bash
git clone https://github.com/Bill1083/Auto-Email.git /home/deploy/automail
```

```bash
cd /home/deploy/automail && cp .env.example .env
```

Generate the two secrets (run it twice, one value each):

```bash
openssl rand -base64 32
```

Then edit `.env`:

```bash
nano /home/deploy/automail/.env
```

Set at minimum:

```dotenv
NEXT_PUBLIC_APP_URL=https://automail.example.com
APP_TIMEZONE=Europe/London
DATABASE_URL="file:/app/data/automail.db"

SESSION_SECRET=<first generated value>
TOKEN_ENCRYPTION_KEY=<second generated value>
DASHBOARD_ALLOWED_EMAILS=you@gmail.com,you@yourbusiness.com
# Leave empty so only Google sign-in works:
DASHBOARD_PASSWORD=

GOOGLE_CLIENT_ID=<from step 2>
GOOGLE_CLIENT_SECRET=<from step 2>
GOOGLE_REDIRECT_URI=https://automail.example.com/api/google/callback

GEMINI_API_KEY=<from aistudio.google.com/apikey>
GEMINI_MODEL=gemini-2.5-flash

DRY_RUN=true
```

Keep `DATABASE_URL` pointing at `/app/data/` — that path is the mounted volume,
and it is the only directory whose contents survive a rebuild.

Two notes on the Gemini key: enable billing on the Google Cloud project it
belongs to, because on the free tier Google may use prompts to improve its
products, which is not what you want for personal email (at these volumes the
paid tier costs pennies). And leave `DRY_RUN=true` for the first day; nothing in
Gmail changes until you switch it off in Settings.

Lock the file down; it holds your keys:

```bash
chmod 600 /home/deploy/automail/.env
```

---

## 5. Build and start

```bash
cd /home/deploy/automail && docker compose up -d --build
```

The first build takes 3–8 minutes. Afterwards:

```bash
docker compose ps
```

`STATUS` should read `Up ... (healthy)`. If it says `starting`, wait 30 seconds
and check again — the health check has a grace period.

Check the startup log to confirm the database was created on the volume and
the scheduler started:

```bash
docker compose logs app | grep automail
```

On a fresh volume you should see `applied N statements` and
`scheduler started`; on later boots, `schema already present, nothing to apply`.

Confirm the app answers locally:

```bash
curl -s http://127.0.0.1:3000/api/health
```

Expected:

```json
{
  "status": "ok",
  "integrations": {
    "gemini": "configured",
    "google": "configured",
    "encryption": "configured",
    "password": "missing",
    "mockMail": "off",
    "database": "reachable"
  }
}
```

`"password": "missing"` is correct when you rely on Google sign-in.

---

## 6. Nginx reverse proxy

```bash
sudo apt install -y nginx
```

Copy the template from the repo and set your domain:

```bash
sudo cp /home/deploy/automail/nginx.conf /etc/nginx/sites-available/automail
```

```bash
sudo sed -i 's/automail.example.com/YOUR_DOMAIN/g' /etc/nginx/sites-available/automail
```

**Before the certificate exists**, the HTTPS block references files that are not
there yet, so comment it out for the first pass:

```bash
sudo nano /etc/nginx/sites-available/automail
```

Comment out the entire `server { listen 443 ssl; ... }` block, and also comment
out the `location / { return 301 ... }` redirect inside the port-80 block. Then:

```bash
sudo ln -sf /etc/nginx/sites-available/automail /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default
```

Test the configuration and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Visit `http://YOUR_DOMAIN` — the login page should load over plain HTTP. Do not
sign in yet; the session cookie is marked Secure and needs HTTPS.

---

## 7. Free SSL with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
```

```bash
sudo certbot --nginx -d YOUR_DOMAIN --agree-tos -m you@example.com --redirect
```

Certbot verifies the domain over HTTP, obtains the certificate, and rewrites the
Nginx config with the certificate paths and an HTTP→HTTPS redirect.

Once it succeeds, re-enable the hardened settings from the repo template
(security headers, the login rate limit, the `x-middleware-subrequest` strip,
timeouts) by merging them back into the Certbot-modified file, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### Auto-renewal

The Certbot package installs a systemd timer. Confirm it is armed:

```bash
systemctl list-timers | grep certbot
```

Dry-run a renewal to be sure it will work unattended:

```bash
sudo certbot renew --dry-run
```

---

## 8. First sign-in and first mailbox

1. Visit `https://YOUR_DOMAIN`, press **Sign in with Google**, and pick an
   address from `DASHBOARD_ALLOWED_EMAILS`. Any other address is refused and
   logged.
2. Go to **Settings → Connect Gmail**. Choose the mailbox, accept the Gmail
   permission (click through the unverified-app screen if it appears). Repeat
   for each mailbox; switch between them from the header.
3. Fill in **Rules → About you**. One paragraph about who you are and what
   matters is the single biggest quality lever.
4. Press **Run now** on the Overview. With dry run on, the Review page fills
   with what *would* happen. Rescue anything wrong, confirm what is right.
5. When you are happy, **Settings → Processing → Dry run** off. From then on
   the scheduled runs (07:00 and 19:00 by default) work on their own.

---

## 9. Day-to-day operations

### Deploying an update

```bash
cd /home/deploy/automail && git pull && docker compose up -d --build
```

The volume is untouched by rebuilds, so history survives.

**A caveat worth knowing:** the entrypoint creates the schema on a *fresh*
volume and then leaves it alone. It does not migrate an existing database, so if
an update changes `prisma/schema.prisma` you must apply that change yourself.
Back up first, then run the Prisma CLI against the volume from a throwaway
container:

```bash
docker run --rm -v automail_automail-data:/data -v "$PWD":/src -w /src -e DATABASE_URL=file:/data/automail.db node:22-bookworm-slim sh -c "npm ci && npx prisma db push"
```

Confirm the volume name first with `docker volume ls` — Compose prefixes it with
the project directory name.

### Logs

```bash
docker compose logs -f app
```

Every scheduled run logs one line per mailbox with the outcome.

### Backing up

Two things matter: the SQLite file (history, rules, settings, encrypted tokens)
and `.env` (the key that decrypts those tokens). A database restored without the
same `TOKEN_ENCRYPTION_KEY` still works, but every mailbox will show *Needs
reconnecting*.

```bash
mkdir -p /home/deploy/backups
```

```bash
docker compose exec app sh -c "cat /app/data/automail.db" > /home/deploy/backups/automail-$(date +%F).db && cp /home/deploy/automail/.env /home/deploy/backups/env-$(date +%F)
```

A nightly cron for the database:

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * cd /home/deploy/automail && docker compose exec -T app sh -c 'cat /app/data/automail.db' > /home/deploy/backups/automail-\$(date +\%F).db") | crontab -
```

### Restoring

```bash
docker compose down && docker compose run --rm -T app sh -c "cat > /app/data/automail.db" < /home/deploy/backups/automail-2026-09-19.db && docker compose up -d
```

### Rotating a key

Edit `.env`, then recreate the container so it picks up the new environment:

```bash
docker compose up -d --force-recreate app
```

Rotating `SESSION_SECRET` signs everyone out. Rotating `TOKEN_ENCRYPTION_KEY`
requires reconnecting every mailbox.

### Driving runs from cron instead of the built-in scheduler

Set `SCHEDULER_ENABLED=false` and a `CRON_SECRET` in `.env`, recreate the
container, then:

```bash
(crontab -l 2>/dev/null; echo "0 7,19 * * * curl -s -X POST -H 'Authorization: Bearer YOUR_CRON_SECRET' http://127.0.0.1:3000/api/jobs/run") | crontab -
```

Call `127.0.0.1:3000` directly rather than the public URL so the Nginx proxy
timeout does not cut a long run short.

---

## Troubleshooting

**"Google hasn't verified this app"**
Expected for a personal project. Click *Advanced → Go to AutoMail (unsafe)*.
It appears once per mailbox.

**A mailbox shows "Needs reconnecting" after a week**
The Google project is still in *Testing*: refresh tokens expire after 7 days.
Publish the app (step 2.5), then press **Reconnect** in Settings. Once
published, tokens last until you revoke them.

**"you@gmail.com is not allowed to use this dashboard"**
That address is not in `DASHBOARD_ALLOWED_EMAILS`. Add it (comma separated),
recreate the container, sign in again.

**`redirect_uri_mismatch` from Google**
The redirect URI in the Cloud console must match `GOOGLE_REDIRECT_URI` exactly,
and the sign-in one must be `NEXT_PUBLIC_APP_URL` + `/api/auth/google/callback`.
Check scheme, host and trailing characters.

**Every run says "Daily cap reached"**
Working as designed. Raise `Daily cap` in Settings → Processing, or set a
per-mailbox cap.

**Emails all end up in "Needs attention" with "Not classified"**
`GEMINI_API_KEY` is missing, invalid, or the model name is wrong. The exact
reason is in the run's error and in `docker compose logs app`.

**`docker compose up` fails with "no space left on device"**
Old build layers accumulate. Clear them:

```bash
docker system prune -af
```

**The container is `unhealthy`**
Check what the app said on startup:

```bash
docker compose logs --tail=50 app
```

**502 Bad Gateway from Nginx**
The container is not answering on port 3000. Confirm it is up with
`docker compose ps`, then `curl -s http://127.0.0.1:3000/api/health`.

**Certbot: "Timeout during connect"**
Port 80 is closed or DNS has not propagated. Re-check `sudo ufw status` and
`dig +short YOUR_DOMAIN`.

---

## Local development

```bash
npm install
```

```bash
cp .env.example .env
```

Point the database at a local file and enable the demo mailbox — edit `.env`
and set `DATABASE_URL="file:./dev.db"`, `MOCK_MAIL=true`, a `DASHBOARD_PASSWORD`,
and the two secrets — then:

```bash
npx prisma db push
```

```bash
npm run dev
```

To try Google sign-in locally, add `http://localhost:3000/api/auth/google/callback`
and `http://localhost:3000/api/google/callback` as redirect URIs on the OAuth
client and set `NEXT_PUBLIC_APP_URL=http://localhost:3000`.

Run the test suite:

```bash
npm test
```

> **Windows on ARM64:** Prisma publishes no native query engine for that
> platform, so `npm run dev` will start but nothing can be saved. Use WSL2 or
> Docker there.
