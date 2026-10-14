'use strict';
// Fills a database with fake customers so you can preview the admin dashboard.
//   DATABASE_PATH=./data/demo.db node scripts/seed-demo.js
const crypto = require('node:crypto');
const { openDb } = require('../lib/db');
const { loadConfig } = require('../lib/config');
const { dayKey } = require('../lib/time');
const DAY = 86400000;

const cfg = loadConfig({ ...process.env, JWT_SECRET: process.env.JWT_SECRET || 'x'.repeat(40) });
const db = openDb(cfg.dbPath);
const now = Date.now();
const rnd = (n) => Math.floor(Math.random() * n);
const names = ['Chidi Okafor', 'Amaka Eze', 'Tunde Bakare', 'Ngozi Obi', 'Ibrahim Musa', 'Zainab Bello', 'Emeka Nwosu', 'Funke Adeyemi',
  'Kelechi Anya', 'Seyi Lawal', 'Halima Yusuf', 'Obinna Chukwu', 'Bisi Ogunleye', 'Uche Okeke', 'Mariam Sani', 'Femi Balogun',
  'Ada Nnamdi', 'Tobi Adebayo', 'Sade Johnson', 'Ife Coker', 'Kunle Ajayi', 'Nneka Ude', 'Yemi Alade', 'Dayo Ojo',
  'Chioma Igwe', 'Gbenga Ola', 'Hauwa Abubakar', 'Ikenna Eze', 'Jide Martins', 'Kemi Ariyo', '<img src=x onerror=alert(1)>', '=HYPERLINK("http://evil")'];

const ins = db.prepare('INSERT OR IGNORE INTO users (email, name, password_hash, created_at, last_login_at, last_seen_at, last_version, last_running, sub_end, sub_kind) VALUES (?,?,?,?,?,?,?,?,?,?)');
const pay = db.prepare("INSERT INTO payments (user_id, reference, plan, amount, currency, status, method, created_at, paid_at, period_start, period_end) VALUES (?,?,?,?,?,'success','paystack',?,?,?,?)");
const ev = db.prepare('INSERT INTO events (user_id, type, at) VALUES (?,?,?)');
const dau = db.prepare('INSERT OR IGNORE INTO daily_active (day, user_id) VALUES (?,?)');
const use = db.prepare('INSERT OR REPLACE INTO usage_daily (day, user_id, prompts, images) VALUES (?,?,?,?)');
const plans = cfg.plans;

names.forEach((name, i) => {
  const created = now - rnd(28) * DAY - rnd(DAY);
  const kind = ['paid', 'paid', 'trial', 'expired', 'none', 'paid'][i % 6];
  const online = i % 7 === 0;
  const lastSeen = online ? now - rnd(60) * 1000 : now - (1 + rnd(200)) * 3600000;
  let subEnd = 0, subKind = 'none';
  if (kind === 'trial') { subKind = 'trial'; subEnd = now + (1 + rnd(2)) * DAY; }
  if (kind === 'expired') { subKind = 'paid'; subEnd = now - (1 + rnd(20)) * DAY; }
  if (kind === 'paid') { subKind = 'paid'; subEnd = now + (2 + rnd(60)) * DAY; }
  const r = ins.run(`user${i}@example.com`, name, 'scrypt$00$00', created, lastSeen, lastSeen, '0.6.0', online && i % 2 === 0 ? 1 : 0, subEnd, subKind);
  const id = Number(r.lastInsertRowid);
  if (!id) return;
  ev.run(id, 'signup', created);
  for (let d = 0; d < 14; d++) if (Math.random() < 0.45) {
    const at = now - d * DAY - rnd(DAY / 2);
    if (at > created) { ev.run(id, 'login', at); dau.run(dayKey(at, cfg.tzOffsetMin), id); use.run(dayKey(at, cfg.tzOffsetMin), id, 5 + rnd(60), 10 + rnd(200)); }
  }
  if (kind === 'paid' || kind === 'expired') {
    const plan = plans[rnd(plans.length)];
    const paidAt = Math.max(created + 3600000, subEnd - plan.days * DAY);
    pay.run(id, `demo_${id}_${crypto.randomBytes(3).toString('hex')}`, plan.id, plan.amount, cfg.currency, paidAt, paidAt, paidAt, subEnd);
  }
});
console.log(`Seeded demo data into ${cfg.dbPath}`);
