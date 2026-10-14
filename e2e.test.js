'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../server');
const { loadConfig } = require('../lib/config');
const { openDb } = require('../lib/db');

const SECRET = 'sk_test_unit_secret';
const DAY = 86400000;
let app, base, db;
const initCalls = [];
let verifyResult = null;

const fakePaystack = {
  configured: true,
  async initialize(p) { initCalls.push(p); return { authorization_url: `https://checkout.paystack.test/${p.reference}`, reference: p.reference }; },
  async verify(ref) { if (!verifyResult) throw new Error('no verify result'); return { ...verifyResult, reference: ref }; }
};

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function signup(email, name = 'Test User', password = 'password123') {
  return call('POST', '/auth/signup', { body: { email, name, password } });
}

function webhookBody(reference, amount, currency = 'NGN') {
  return JSON.stringify({ event: 'charge.success', data: { reference, amount, currency, paid_at: new Date().toISOString() } });
}
const sign = (raw) => crypto.createHmac('sha512', SECRET).update(raw).digest('hex');

before(async () => {
  const config = loadConfig({
    JWT_SECRET: 'x'.repeat(40), PAYSTACK_SECRET_KEY: SECRET, PUBLIC_URL: 'https://api.example.com',
    ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'adminpass123', TRIAL_DAYS: '3', TZ_OFFSET_MINUTES: '60'
  });
  db = openDb(':memory:');
  app = createApp({ config, db, paystack: fakePaystack });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => { await app.close(); });

test('health and plans are public', async () => {
  assert.equal((await call('GET', '/health')).json.ok, true);
  const plans = await call('GET', '/plans');
  assert.equal(plans.status, 200);
  assert.equal(plans.json.plans[0].id, 'monthly');
  assert.equal(plans.json.billingEnabled, true);
});

test('signup validates input, grants a trial, rejects duplicates', async () => {
  assert.equal((await signup('not-an-email')).status, 400);
  assert.equal((await signup('a@b.co', 'x', 'short')).status, 400);

  const ok = await signup('Alice@Example.com', 'Alice');
  assert.equal(ok.status, 201);
  assert.ok(ok.json.token);
  assert.equal(ok.json.user.email, 'alice@example.com');
  assert.equal(ok.json.user.subscriptionActive, true);
  assert.equal(ok.json.user.subscription.status, 'trial');
  assert.equal(ok.json.user.subscription.daysLeft, 3);

  const dup = await signup('alice@example.com');
  assert.equal(dup.status, 409);
});

test('login: wrong password and unknown email look identical; right password works', async () => {
  const bad = await call('POST', '/auth/login', { body: { email: 'alice@example.com', password: 'wrongwrong' } });
  const unknown = await call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'wrongwrong' } });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.json.error, unknown.json.error);

  const good = await call('POST', '/auth/login', { body: { email: 'ALICE@example.com', password: 'password123' } });
  assert.equal(good.status, 200);
  assert.ok(good.json.token);
});

test('/me requires a valid token', async () => {
  assert.equal((await call('GET', '/me')).status, 401);
  assert.equal((await call('GET', '/me', { token: 'garbage.token' })).status, 401);
  const { json } = await call('POST', '/auth/login', { body: { email: 'alice@example.com', password: 'password123' } });
  const me = await call('GET', '/me', { token: json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, 'alice@example.com');
  assert.equal(me.json.subscriptionActive, true);
});

test('tampered tokens are rejected', async () => {
  const { json } = await call('POST', '/auth/login', { body: { email: 'alice@example.com', password: 'password123' } });
  const [body, sig] = json.token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 1, tv: 0, exp: Date.now() + DAY })).toString('base64url');
  assert.equal((await call('GET', '/me', { token: `${forged}.${sig}` })).status, 401);
  assert.equal((await call('GET', '/me', { token: `${body}.AAAA` })).status, 401);
});

test('billing: checkout -> webhook activates once, extends on renewal, ignores bad signatures and amounts', async () => {
  const login = await call('POST', '/auth/login', { body: { email: 'alice@example.com', password: 'password123' } });
  const token = login.json.token;
  const uid = login.json.user.id;

  assert.equal((await call('POST', '/billing/initialize', { token, body: { plan: 'nope' } })).status, 400);
  const init = await call('POST', '/billing/initialize', { token, body: { plan: 'monthly' } });
  assert.equal(init.status, 200);
  assert.match(init.json.authorization_url, /^https:\/\/checkout\.paystack\.test\//);
  const ref = init.json.reference;
  assert.equal(initCalls.at(-1).amount, 500000);
  assert.equal(initCalls.at(-1).callback_url, 'https://api.example.com/billing/callback');
  assert.equal(db.prepare('SELECT status FROM payments WHERE reference = ?').get(ref).status, 'pending');

  // bad signature
  const raw = webhookBody(ref, 500000);
  assert.equal((await call('POST', '/billing/webhook', { body: raw, headers: { 'x-paystack-signature': 'deadbeef' } })).status, 401);
  assert.equal((await call('POST', '/billing/webhook', { body: raw })).status, 401);

  // good signature activates
  const before = Date.now();
  const okRes = await call('POST', '/billing/webhook', { body: raw, headers: { 'x-paystack-signature': sign(raw) } });
  assert.equal(okRes.status, 200);
  let u = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  assert.equal(u.sub_kind, 'paid');
  // trial had ~3 days left, so paid time stacks on top of it: 3 + 30 days
  assert.ok(u.sub_end > before + 32 * DAY && u.sub_end < before + 34 * DAY, 'renewal stacks on remaining trial');
  const firstEnd = u.sub_end;
  const pay = db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
  assert.equal(pay.status, 'success');
  assert.ok(pay.paid_at && pay.period_start && pay.period_end === firstEnd);

  // replay is idempotent
  await call('POST', '/billing/webhook', { body: raw, headers: { 'x-paystack-signature': sign(raw) } });
  assert.equal(db.prepare('SELECT sub_end FROM users WHERE id = ?').get(uid).sub_end, firstEnd);

  // amount mismatch must NOT activate (attacker pays less / different amount)
  const init2 = await call('POST', '/billing/initialize', { token, body: { plan: 'yearly' } });
  const raw2 = webhookBody(init2.json.reference, 100);
  await call('POST', '/billing/webhook', { body: raw2, headers: { 'x-paystack-signature': sign(raw2) } });
  assert.equal(db.prepare('SELECT sub_end FROM users WHERE id = ?').get(uid).sub_end, firstEnd);
  assert.equal(db.prepare('SELECT status FROM payments WHERE reference = ?').get(init2.json.reference).status, 'failed');

  // unknown reference is ignored but acknowledged
  const raw3 = webhookBody('does_not_exist', 500000);
  assert.equal((await call('POST', '/billing/webhook', { body: raw3, headers: { 'x-paystack-signature': sign(raw3) } })).status, 200);
});

test('billing callback verifies with Paystack and activates', async () => {
  const s = await signup('callback@example.com', 'Cb');
  const init = await call('POST', '/billing/initialize', { token: s.json.token, body: { plan: 'quarterly' } });
  verifyResult = { status: 'success', amount: 1350000, currency: 'NGN' };
  const res = await call('GET', `/billing/callback?reference=${init.json.reference}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Payment received/);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get('callback@example.com');
  assert.equal(u.sub_kind, 'paid');
  assert.ok(u.sub_end > Date.now() + 90 * DAY);
});

test('heartbeat marks users online; usage accumulates', async () => {
  const s = await signup('beat@example.com', 'Beat');
  const hb = await call('POST', '/heartbeat', { token: s.json.token, body: { version: '0.6.0', running: true } });
  assert.equal(hb.status, 200);
  assert.equal(hb.json.subscriptionActive, true);
  await call('POST', '/usage', { token: s.json.token, body: { prompts: 5, images: 10 } });
  await call('POST', '/usage', { token: s.json.token, body: { prompts: 1, images: 2 } });
  const row = db.prepare('SELECT SUM(prompts) p, SUM(images) i FROM usage_daily WHERE user_id = ?').get(s.json.user.id);
  assert.equal(Number(row.p), 6);
  assert.equal(Number(row.i), 12);
});

test('admin API is locked to admins', async () => {
  const user = await signup('plain@example.com', 'Plain');
  for (const p of ['/admin/api/stats', '/admin/api/users', '/admin/api/payments', '/admin/api/health']) {
    assert.equal((await call('GET', p)).status, 401, `${p} unauthenticated`);
    assert.equal((await call('GET', p, { token: user.json.token })).status, 403, `${p} as normal user`);
  }
});

test('admin dashboard stats, users and payments', async () => {
  const login = await call('POST', '/auth/login', { body: { email: 'boss@example.com', password: 'adminpass123' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.isAdmin, true);
  const token = login.json.token;

  const stats = await call('GET', '/admin/api/stats', { token });
  assert.equal(stats.status, 200);
  const t = stats.json.totals;
  assert.ok(t.users >= 4);
  assert.ok(t.online >= 1, 'beat@example.com is online');
  assert.ok(t.runningNow >= 1);
  assert.ok(t.paid >= 2, 'alice + callback paid');
  assert.ok(stats.json.revenue.total >= 500000 + 1350000);
  assert.equal(stats.json.series.days.length, 14);
  assert.ok(stats.json.activity.loginsToday >= 4);
  assert.ok(stats.json.activity.imagesTotal >= 12);
  assert.equal(stats.json.series.revenue.at(-1) >= 1850000, true);

  const online = await call('GET', '/admin/api/users?filter=online', { token });
  assert.ok(online.json.rows.some((r) => r.email === 'beat@example.com' && r.running));
  assert.ok(!online.json.rows.some((r) => r.isAdmin), 'admin never listed as a customer');

  const paid = await call('GET', '/admin/api/users?filter=paid', { token });
  const alice = paid.json.rows.find((r) => r.email === 'alice@example.com');
  assert.ok(alice && alice.lastPaidAt && alice.totalPaid === 500000 && alice.daysLeft > 30);

  const search = await call('GET', `/admin/api/users?search=${encodeURIComponent('%')}`, { token });
  assert.equal(search.json.total, 0, 'LIKE wildcards are escaped');
  const byName = await call('GET', '/admin/api/users?search=Alice', { token });
  assert.equal(byName.json.total, 1);

  const pays = await call('GET', '/admin/api/payments', { token });
  assert.ok(pays.json.total >= 2);
  assert.ok(pays.json.rows[0].email);
});

test('admin actions: grant, revoke, suspend (and suspended users are locked out)', async () => {
  const admin = (await call('POST', '/auth/login', { body: { email: 'boss@example.com', password: 'adminpass123' } })).json.token;
  const s = await signup('target@example.com', 'Target');
  const id = s.json.user.id;

  assert.equal((await call('POST', `/admin/api/users/${id}/grant`, { token: admin, body: { days: 0 } })).status, 400);
  assert.equal((await call('POST', `/admin/api/users/${id}/grant`, { token: admin, body: { days: 30, note: '=HYPERLINK("x")' } })).status, 200);
  let u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  assert.equal(u.sub_kind, 'comp');
  assert.ok(u.sub_end > Date.now() + 32 * DAY);

  assert.equal((await call('POST', `/admin/api/users/${id}/revoke`, { token: admin, body: {} })).status, 200);
  const me = await call('GET', '/me', { token: s.json.token });
  assert.equal(me.json.subscriptionActive, false);
  assert.equal(me.json.subscription.status, 'expired');

  assert.equal((await call('POST', `/admin/api/users/${id}/suspend`, { token: admin, body: { suspended: true } })).status, 200);
  assert.equal((await call('GET', '/me', { token: s.json.token })).status, 401, 'old token dead after suspend');
  assert.equal((await call('POST', '/auth/login', { body: { email: 'target@example.com', password: 'password123' } })).status, 403);

  assert.equal((await call('POST', `/admin/api/users/${id}/suspend`, { token: admin, body: { suspended: false } })).status, 200);
  assert.equal((await call('POST', '/auth/login', { body: { email: 'target@example.com', password: 'password123' } })).status, 200);

  assert.equal((await call('POST', '/admin/api/users/99999/grant', { token: admin, body: { days: 5 } })).status, 404);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const admin = (await call('POST', '/auth/login', { body: { email: 'boss@example.com', password: 'adminpass123' } })).json.token;
  await signup('evil@example.com', '=cmd|calc');
  const csv = await call('GET', '/admin/api/export/users', { token: admin });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes("'=cmd|calc"), 'formula prefixed with a quote');
  assert.ok(!/(^|,)=cmd/m.test(csv.text));
  assert.equal((await call('GET', '/admin/api/export/payments', { token: admin })).status, 200);
});

test('admin page is served with a strict CSP', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${base}/admin/admin.js`)).status, 200);
  assert.equal((await fetch(`${base}/admin/../server.js`)).status, 404, 'no path traversal');
});

test('CORS only opens for browser-extension origins; bodies are size-limited', async () => {
  const ext = await fetch(`${base}/plans`, { headers: { Origin: 'chrome-extension://abcdefghijklmnop' } });
  assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
  const web = await fetch(`${base}/plans`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(web.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } });
  assert.equal(pre.status, 204);

  const huge = await call('POST', '/auth/signup', { body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200 * 1024) }) }).catch((e) => ({ status: 'closed', e }));
  assert.ok(huge.status === 413 || huge.status === 'closed');
});

test('login is rate limited', async () => {
  let last;
  for (let i = 0; i < 20; i++) last = await call('POST', '/auth/login', { body: { email: 'ratelimit@example.com', password: 'wrongwrong' } });
  assert.equal(last.status, 429);
});
