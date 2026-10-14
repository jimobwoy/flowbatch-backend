# Flow Batch — Backend & Admin Dashboard

Accounts, free trials, Paystack subscriptions and a live admin dashboard for the
Flow Batch Generator extension. **Zero npm dependencies** — it uses Node's
built-in SQLite and crypto, so there's nothing to `npm install`.

Needs **Node 22.13 or newer**.

## 1. Try it locally (2 minutes)

```bash
cp .env.example .env          # then edit it (see below)
export $(grep -v '^#' .env | xargs)
node server.js                # or: npm start
```

Open `http://localhost:8787/admin` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

Want to see the dashboard full of data first?

```bash
DATABASE_PATH=./data/demo.db node scripts/seed-demo.js
DATABASE_PATH=./data/demo.db ADMIN_EMAIL=a@b.co ADMIN_PASSWORD=changeme123 node server.js
```

Run the tests any time: `npm test` (15 end-to-end tests).

## 2. Deploy it

You need: an HTTPS address, Node 22+, and **a disk that survives redeploys**
(your users live in one SQLite file — on a platform without a persistent disk
you would lose every account on each deploy).

**Option A — Railway / Render / Fly.io (easiest).** Deploy this folder (a
`Dockerfile` is included), attach a **volume mounted at `/data`**, and set the
environment variables from `.env.example` (leave `DATABASE_PATH=/data/app.db`).
Do not use a free tier that sleeps or has no disk.

**Option B — a small VPS** (any ~$5/month Linux box): install Docker, then

```bash
docker build -t flowbatch .
docker run -d --restart=always --name flowbatch -p 127.0.0.1:8787:8787 \
  -v flowbatch-data:/data --env-file .env flowbatch
```

and put Caddy or nginx in front for HTTPS (Caddy: one line,
`api.yourdomain.com { reverse_proxy 127.0.0.1:8787 }`).

**Back it up** (daily cron is plenty): `npm run backup` writes a consistent copy
to `./backups/`. Copy those off the machine.

## 3. Turn on billing (Paystack)

1. Create a Paystack account → **Settings → API Keys** → copy the **secret key**
   into `PAYSTACK_SECRET_KEY`. Start with the *test* key (`sk_test_…`).
2. **Settings → API Keys & Webhooks → Webhook URL** →
   `https://YOUR-DOMAIN/billing/webhook`
3. Set `PUBLIC_URL=https://YOUR-DOMAIN` so customers are sent back to a
   confirmation page after paying.
4. Set your real prices with `PLANS_JSON` (amounts are in **kobo**: ₦5,000 =
   `500000`). The built-in prices are placeholders.
5. Pay once yourself with a Paystack test card, check the **Payments** tab shows
   it, then swap in the live key.

How access works: each successful payment adds the plan's days to the customer's
access (renewing early stacks on top of the time left). Both the webhook and the
post-payment page verify and activate; duplicates are ignored. The amount is
checked against what we asked for, so a customer can't pay less.

## 4. Point the extension at it

In the extension folder, open `config.js`, set `BACKEND_URL` to your address
(`https://api.yourdomain.com`), and reload the extension. Before publishing, also
add that same domain to `host_permissions` in `manifest.json`.

## 5. The dashboard (`/admin`)

* **Online now** — people whose extension checked in during the last ~2½ minutes
  (the extension pings once a minute while signed in), and how many are mid-batch.
* Total users, paying / trial / expired, revenue today / this month / all time,
  logins today, daily active users, images saved — plus 14-day charts.
* **Users** — search and filter (online, paying, trial, expiring ≤ 7 days,
  expired, suspended…). See when each person joined, last logged in, last paid,
  when their plan ends and how many days are left.
* **Actions** — **+ Days** (give bank-transfer customers or friends time),
  **Revoke**, **Suspend** (signs them out everywhere immediately).
* **Payments** — every payment with date, plan, amount, access period, reference.
* **Export CSV** for users and payments.

## API (what the extension calls)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | – | create account (starts the free trial) |
| POST | `/auth/login` | – | sign in → `{ token, user }` |
| GET | `/me` | token | profile + subscription status |
| GET | `/plans` | – | plans, prices, trial length |
| POST | `/billing/initialize` | token | start Paystack checkout `{ plan }` |
| GET | `/billing/callback` | – | where Paystack returns the customer |
| POST | `/billing/webhook` | signature | Paystack payment events |
| POST | `/heartbeat` | token | "I'm online" + current plan status |
| POST | `/usage` | token | prompts / images processed |

Admin routes live under `/admin/api/*` and require an admin account.

## Security notes

* Passwords are hashed with scrypt; sessions are signed tokens (30 days) that are
  revoked instantly on suspend.
* Login and signup are rate-limited (per IP, plus per email on login).
* The dashboard is served with a strict Content-Security-Policy and renders user
  text as text only, so a hostile signup name can't run script in your admin page.
* **Honest limit:** any paid Chrome extension runs on the customer's machine, so a
  determined person can edit their copy to skip the subscription check. This setup
  stops casual sharing and gives you full visibility; it can't make cheating
  impossible.
* You collect emails and password hashes, so publish a privacy policy
  (a template is in the extension's `STORE_SUBMISSION.md`).
