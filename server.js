'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadConfig } = require('./lib/config');
const { openDb, tx } = require('./lib/db');
const auth = require('./lib/auth');
const { createPaystack, verifyWebhookSignature } = require('./lib/paystack');
const { activatePayment } = require('./lib/billing');
const { RateLimiter } = require('./lib/ratelimit');
const { dashboardStats, listUsers, listPayments, USER_FILTERS } = require('./lib/stats');
const { toCsv } = require('./lib/csv');
const { DAY, dayKey } = require('./lib/time');

const MAX_BODY = 100 * 1024;
const TOKEN_TTL = 30 * DAY;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_FILES = {
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8']
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function subscriptionOf(u, now) {
  const active = u.sub_end > now;
  return {
    kind: u.sub_kind,
    status: active ? u.sub_kind : (u.sub_end > 0 ? 'expired' : 'none'),
    active,
    endsAt: u.sub_end || null,
    daysLeft: active ? Math.ceil((u.sub_end - now) / DAY) : 0
  };
}

function publicUser(u, now) {
  const sub = subscriptionOf(u, now);
  return { id: u.id, name: u.name, email: u.email, isAdmin: !!u.is_admin, subscriptionActive: sub.active, subscription: sub };
}

function createApp(options = {}) {
  const config = options.config || loadConfig();
  const db = options.db || openDb(config.dbPath);
  const paystack = options.paystack || createPaystack(config.paystackSecret);
  const limiters = {
    // Per-IP limits are generous because many mobile users share one carrier IP;
    // the per-email limit is what actually protects individual accounts.
    login: new RateLimiter(60, 10 * 60 * 1000),
    loginEmail: new RateLimiter(10, 10 * 60 * 1000),
    signup: new RateLimiter(20, 60 * 60 * 1000),
    checkout: new RateLimiter(10, 10 * 60 * 1000),
    beat: new RateLimiter(40, 60 * 1000)
  };

  // A real (but impossible-to-match) hash so unknown-email logins cost the same
  // time as wrong-password logins — avoids leaking which emails exist.
  let dummyHash;
  const dummyHashPromise = auth.hashPassword(crypto.randomBytes(12).toString('hex')).then((h) => { dummyHash = h; });

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(`INSERT INTO users (email, name, password_hash, is_admin, created_at, sub_end, sub_kind)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertEvent: db.prepare('INSERT INTO events (user_id, type, at) VALUES (?, ?, ?)')
  };

  async function seedAdmin() {
    if (!config.adminEmail || !config.adminPassword) return;
    const existing = q.userByEmail.get(config.adminEmail);
    if (existing) {
      if (!existing.is_admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
      return;
    }
    const hash = await auth.hashPassword(config.adminPassword);
    q.insertUser.run(config.adminEmail, 'Admin', hash, 1, Date.now(), Date.now() + 3650 * DAY, 'comp');
  }
  const ready = Promise.all([dummyHashPromise, seedAdmin()]);

  // ---------- helpers ----------
  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function corsHeaders(req) {
    const origin = req.headers.origin || '';
    // Token auth (no cookies), so we only need to allow browser-extension origins.
    if (origin.startsWith('chrome-extension://')) {
      return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin'
      };
    }
    return {};
  }

  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  };

  function send(res, req, status, body, contentType, extra = {}) {
    res.writeHead(status, { ...baseHeaders, ...corsHeaders(req), 'Content-Type': contentType, ...extra });
    res.end(body);
  }
  const sendJson = (res, req, status, obj) => send(res, req, status, JSON.stringify(obj), 'application/json; charset=utf-8');

  function readRaw(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function parseJson(raw) {
    if (!raw.length) return {};
    try {
      const v = JSON.parse(raw.toString('utf8'));
      return v && typeof v === 'object' ? v : {};
    } catch { throw new HttpError(400, 'Invalid JSON body'); }
  }

  function authenticate(req) {
    const header = String(req.headers.authorization || '');
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) throw new HttpError(401, 'Not signed in');
    const payload = auth.verifyToken(m[1], config.jwtSecret);
    if (!payload) throw new HttpError(401, 'Session expired — please sign in again');
    const user = q.userById.get(payload.sub);
    if (!user || user.token_version !== payload.tv) throw new HttpError(401, 'Session expired — please sign in again');
    if (user.suspended) throw new HttpError(403, 'This account has been suspended. Contact support.');
    return user;
  }

  const issueToken = (u) => auth.signToken({ sub: u.id, tv: u.token_version, exp: Date.now() + TOKEN_TTL }, config.jwtSecret);

  function limit(limiter, key) {
    if (!limiter.take(key)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    routes.push({ method, re: new RegExp(`^${pattern}$`), opts, handler });
  };

  route('GET', '/health', {}, async (c) => c.json(200, { ok: true }));

  route('GET', '/plans', {}, async (c) => c.json(200, {
    currency: config.currency,
    plans: config.plans.map((p) => ({ id: p.id, name: p.name, days: p.days, amount: p.amount })),
    trialDays: config.trialDays,
    billingEnabled: paystack.configured
  }));

  route('POST', '/auth/signup', {}, async (c) => {
    limit(limiters.signup, c.ip);
    const email = cleanText(c.body.email, 254).toLowerCase();
    const name = cleanText(c.body.name, 80);
    const password = String(c.body.password ?? '');
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (q.userByEmail.get(email)) throw new HttpError(409, 'An account with this email already exists. Try logging in.');

    const now = Date.now();
    const hash = await auth.hashPassword(password);
    const trialEnd = config.trialDays > 0 ? now + config.trialDays * DAY : 0;
    let id;
    try {
      id = Number(q.insertUser.run(email, name, hash, 0, now, trialEnd, trialEnd ? 'trial' : 'none').lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'An account with this email already exists. Try logging in.');
      throw e;
    }
    q.insertEvent.run(id, 'signup', now);
    q.insertEvent.run(id, 'login', now);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
    const user = q.userById.get(id);
    c.json(201, { token: issueToken(user), user: publicUser(user, now) });
  });

  route('POST', '/auth/login', {}, async (c) => {
    limit(limiters.login, c.ip);
    await ready;
    const email = cleanText(c.body.email, 254).toLowerCase();
    limit(limiters.loginEmail, email);
    const password = String(c.body.password ?? '');
    const user = q.userByEmail.get(email);
    const ok = await auth.verifyPassword(password, user ? user.password_hash : dummyHash);
    if (!user || !ok) throw new HttpError(401, 'Invalid email or password.');
    if (user.suspended) throw new HttpError(403, 'This account has been suspended. Contact support.');
    const now = Date.now();
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, user.id);
    q.insertEvent.run(user.id, 'login', now);
    c.json(200, { token: issueToken(user), user: publicUser(q.userById.get(user.id), now) });
  });

  route('GET', '/me', { auth: true }, async (c) => {
    c.json(200, publicUser(c.user, Date.now()));
  });

  route('POST', '/heartbeat', { auth: true }, async (c) => {
    limit(limiters.beat, `u${c.user.id}`);
    const now = Date.now();
    const version = cleanText(c.body.version, 24) || null;
    const running = c.body.running ? 1 : 0;
    db.prepare('UPDATE users SET last_seen_at = ?, last_version = ?, last_running = ? WHERE id = ?').run(now, version, running, c.user.id);
    db.prepare('INSERT OR IGNORE INTO daily_active (day, user_id) VALUES (?, ?)').run(dayKey(now, config.tzOffsetMin), c.user.id);
    const sub = subscriptionOf(c.user, now);
    c.json(200, { ok: true, subscriptionActive: sub.active, endsAt: sub.endsAt, serverTime: now });
  });

  route('POST', '/usage', { auth: true }, async (c) => {
    limit(limiters.beat, `u${c.user.id}`);
    const prompts = Math.min(5000, Math.max(0, Math.floor(Number(c.body.prompts) || 0)));
    const images = Math.min(20000, Math.max(0, Math.floor(Number(c.body.images) || 0)));
    if (prompts || images) {
      db.prepare(`INSERT INTO usage_daily (day, user_id, prompts, images) VALUES (?, ?, ?, ?)
                  ON CONFLICT(day, user_id) DO UPDATE SET prompts = prompts + excluded.prompts, images = images + excluded.images`)
        .run(dayKey(Date.now(), config.tzOffsetMin), c.user.id, prompts, images);
    }
    c.json(200, { ok: true });
  });

  route('POST', '/billing/initialize', { auth: true }, async (c) => {
    limit(limiters.checkout, `u${c.user.id}`);
    if (!paystack.configured) throw new HttpError(503, 'Billing is not set up yet. Please contact support.');
    const planId = cleanText(c.body.plan, 32) || config.plans[0].id;
    const plan = config.plans.find((p) => p.id === planId);
    if (!plan) throw new HttpError(400, 'Unknown plan.');
    const reference = `fb_${c.user.id}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    db.prepare(`INSERT INTO payments (user_id, reference, plan, amount, currency, status, method, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', 'paystack', ?)`)
      .run(c.user.id, reference, plan.id, plan.amount, config.currency, Date.now());
    let data;
    try {
      data = await paystack.initialize({
        email: c.user.email,
        amount: plan.amount,
        currency: config.currency,
        reference,
        callback_url: config.publicUrl ? `${config.publicUrl}/billing/callback` : undefined,
        metadata: { user_id: c.user.id, plan: plan.id }
      });
    } catch (e) {
      db.prepare("UPDATE payments SET status = 'failed', note = ? WHERE reference = ?").run(String(e.message).slice(0, 200), reference);
      throw new HttpError(502, 'Could not start checkout. Please try again in a moment.');
    }
    c.json(200, { authorization_url: data.authorization_url, reference });
  });

  // Where Paystack sends the customer's browser after paying. We verify with
  // Paystack directly (don't trust the URL) and activate — the webhook may also
  // arrive; activatePayment is idempotent so whichever comes first wins.
  route('GET', '/billing/callback', {}, async (c) => {
    const reference = cleanText(c.url.searchParams.get('reference') || c.url.searchParams.get('trxref'), 120);
    let message = 'We could not confirm this payment yet. If you were charged, your plan will activate within a few minutes — you can close this tab.';
    let ok = false;
    if (reference && paystack.configured) {
      try {
        const data = await paystack.verify(reference);
        if (data && data.status === 'success') {
          const r = activatePayment(db, config.plans, { reference, amount: data.amount, currency: data.currency, paidAt: Date.now() });
          if (r.ok) {
            ok = true;
            message = `Payment confirmed. Your plan is active until ${new Date(r.periodEnd).toISOString().slice(0, 10)}. You can close this tab and return to the extension.`;
          }
        }
      } catch (e) { console.error('callback verify failed:', e.message); }
    }
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flow Batch Generator</title>
<body style="font-family:system-ui,sans-serif;background:#131417;color:#ecebf0;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="max-width:420px;padding:32px;text-align:center"><div style="font-size:42px">${ok ? '✅' : 'ℹ️'}</div>
<h1 style="font-size:20px;margin:12px 0">${ok ? 'Payment received' : 'Payment pending'}</h1><p style="color:#93939c;line-height:1.5">${message}</p></div></body>`;
    send(c.res, c.req, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  });

  route('POST', '/billing/webhook', { raw: true }, async (c) => {
    const signature = c.req.headers['x-paystack-signature'];
    if (!verifyWebhookSignature(c.raw, signature, config.paystackSecret)) throw new HttpError(401, 'Bad signature');
    let event;
    try { event = JSON.parse(c.raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (event && event.event === 'charge.success' && event.data) {
      const d = event.data;
      const r = activatePayment(db, config.plans, {
        reference: String(d.reference || ''), amount: d.amount, currency: d.currency,
        paidAt: d.paid_at ? Date.parse(d.paid_at) || Date.now() : Date.now()
      });
      if (!r.ok) console.warn('webhook: payment not activated:', d.reference, r.reason);
    }
    c.json(200, { received: true }); // always 200 once the signature is valid, so Paystack doesn't retry forever
  });

  // ---------- admin API ----------
  const A = { auth: 'admin' };
  const intParam = (v, def, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.floor(Number(v)) : def));

  route('GET', '/admin/api/health', A, async (c) => c.json(200, {
    paystackConfigured: paystack.configured,
    publicUrlSet: Boolean(config.publicUrl),
    ephemeralSecret: config.ephemeralSecret,
    trialDays: config.trialDays,
    currency: config.currency,
    plans: config.plans
  }));

  route('GET', '/admin/api/stats', A, async (c) => c.json(200, dashboardStats(db, config)));

  route('GET', '/admin/api/users', A, async (c) => {
    const sp = c.url.searchParams;
    const filter = USER_FILTERS[sp.get('filter')] ? sp.get('filter') : 'all';
    c.json(200, listUsers(db, config, {
      search: cleanText(sp.get('search'), 100), filter,
      limit: intParam(sp.get('limit'), 25, 1, 100), offset: intParam(sp.get('offset'), 0, 0, 1e7)
    }));
  });

  route('GET', '/admin/api/payments', A, async (c) => {
    const sp = c.url.searchParams;
    const status = ['success', 'pending', 'failed', 'all'].includes(sp.get('status')) ? sp.get('status') : 'success';
    c.json(200, listPayments(db, { status, limit: intParam(sp.get('limit'), 25, 1, 100), offset: intParam(sp.get('offset'), 0, 0, 1e7) }));
  });

  route('POST', '/admin/api/users/(\\d+)/grant', A, async (c) => {
    const id = Number(c.params[0]);
    const days = Math.floor(Number(c.body.days));
    if (!(days >= 1 && days <= 3650)) throw new HttpError(400, 'Days must be between 1 and 3650.');
    const note = cleanText(c.body.note, 200) || null;
    const result = tx(db, () => {
      const u = q.userById.get(id);
      if (!u || u.is_admin) throw new HttpError(404, 'User not found.');
      const now = Date.now();
      const start = Math.max(now, u.sub_end || 0);
      const end = start + days * DAY;
      const keepPaid = u.sub_kind === 'paid' && u.sub_end > now;
      db.prepare('UPDATE users SET sub_end = ?, sub_kind = ? WHERE id = ?').run(end, keepPaid ? 'paid' : 'comp', id);
      db.prepare(`INSERT INTO payments (user_id, reference, plan, amount, currency, status, method, note, created_at, paid_at, period_start, period_end)
                  VALUES (?, ?, 'manual', 0, ?, 'success', 'manual', ?, ?, ?, ?, ?)`)
        .run(id, `manual_${id}_${now}_${crypto.randomBytes(3).toString('hex')}`, config.currency, note, now, now, start, end);
      return { subEnd: end };
    });
    c.json(200, { ok: true, ...result });
  });

  route('POST', '/admin/api/users/(\\d+)/revoke', A, async (c) => {
    const r = db.prepare('UPDATE users SET sub_end = ? WHERE id = ? AND is_admin = 0').run(Date.now(), Number(c.params[0]));
    if (!r.changes) throw new HttpError(404, 'User not found.');
    c.json(200, { ok: true });
  });

  route('POST', '/admin/api/users/(\\d+)/suspend', A, async (c) => {
    const suspended = c.body.suspended ? 1 : 0;
    // Bumping token_version signs the person out everywhere immediately.
    const r = db.prepare('UPDATE users SET suspended = ?, token_version = token_version + 1 WHERE id = ? AND is_admin = 0')
      .run(suspended, Number(c.params[0]));
    if (!r.changes) throw new HttpError(404, 'User not found.');
    c.json(200, { ok: true, suspended: !!suspended });
  });

  route('GET', '/admin/api/export/(users|payments)', A, async (c) => {
    const now = Date.now();
    const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
    let csv;
    if (c.params[0] === 'users') {
      const { rows } = listUsers(db, config, { limit: 100000, offset: 0 }, now);
      csv = toCsv(
        ['id', 'name', 'email', 'joined', 'last_login', 'last_seen', 'status', 'plan_ends', 'days_left', 'last_paid', 'total_paid', 'images', 'suspended'],
        rows.map((r) => [r.id, r.name, r.email, iso(r.createdAt), iso(r.lastLoginAt), iso(r.lastSeenAt), r.status, iso(r.subEnd), r.daysLeft, iso(r.lastPaidAt), r.totalPaid / 100, r.images, r.suspended ? 'yes' : 'no']));
    } else {
      const { rows } = listPayments(db, { status: 'all', limit: 100000, offset: 0 });
      csv = toCsv(
        ['date', 'email', 'name', 'plan', 'amount', 'currency', 'status', 'method', 'period_start', 'period_end', 'reference', 'note'],
        rows.map((r) => [iso(r.paidAt || r.createdAt), r.email, r.name, r.plan, r.amount / 100, r.currency, r.status, r.method, iso(r.periodStart), iso(r.periodEnd), r.reference, r.note]));
    }
    send(c.res, c.req, 200, csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${c.params[0]}-${dayKey(now, config.tzOffsetMin)}.csv"` });
  });

  // ---------- dispatcher ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...baseHeaders, ...corsHeaders(req) });
        return res.end();
      }

      if (req.method === 'GET' && ADMIN_FILES[pathname]) {
        const [file, type] = ADMIN_FILES[pathname];
        const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
        const extra = pathname === '/admin' ? {
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'X-Frame-Options': 'DENY'
        } : {};
        return send(res, req, 200, body, type, extra);
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const raw = req.method === 'POST' ? await readRaw(req) : Buffer.alloc(0);
        const ctx = {
          req, res, url, ip: clientIp(req), params: m.slice(1), raw,
          body: r.opts.raw ? {} : (req.method === 'POST' ? parseJson(raw) : {}),
          json: (status, obj) => sendJson(res, req, status, obj)
        };
        if (r.opts.auth) {
          ctx.user = authenticate(req);
          if (r.opts.auth === 'admin' && !ctx.user.is_admin) throw new HttpError(403, 'Admin access required.');
        }
        return await r.handler(ctx);
      }
      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, req, err.status, { error: err.message });
      console.error('Unhandled error:', err);
      return sendJson(res, req, 500, { error: 'Internal server error' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 30000;

  return {
    server, db, config, ready,
    close() {
      Object.values(limiters).forEach((l) => l.stop());
      return new Promise((resolve) => server.close(() => { try { db.close(); } catch { /* already closed */ } resolve(); }));
    }
  };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  const { config } = app;
  app.ready.then(() => {
    app.server.listen(config.port, () => {
      console.log(`Flow Batch backend listening on :${config.port}`);
      if (config.ephemeralSecret) console.warn('⚠  JWT_SECRET not set — using a temporary secret. Everyone is signed out on every restart. Set JWT_SECRET.');
      if (!config.paystackSecret) console.warn('⚠  PAYSTACK_SECRET_KEY not set — subscriptions cannot be purchased yet.');
      if (!config.publicUrl) console.warn('⚠  PUBLIC_URL not set — Paystack will not redirect customers back after paying.');
      if (!config.adminEmail || !config.adminPassword) console.warn('⚠  ADMIN_EMAIL / ADMIN_PASSWORD not set — nobody can open the dashboard.');
      else console.log(`Dashboard: ${config.publicUrl || `http://localhost:${config.port}`}/admin`);
    });
  });
  const stop = () => app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
