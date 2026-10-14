'use strict';
const { DAY, dayKey, startOfDay, startOfMonth } = require('./time');

const SERIES_DAYS = 14;

function lastDays(now, offsetMin, n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(dayKey(now - i * DAY, offsetMin));
  return days;
}

function toSeries(days, rows) {
  const map = new Map(rows.map((r) => [r.day, Number(r.v)]));
  return days.map((d) => map.get(d) || 0);
}

function dashboardStats(db, cfg, now = Date.now()) {
  const off = cfg.tzOffsetMin;
  const offSec = Number(off) * 60; // numeric, so safe to inline into SQL
  const today = dayKey(now, off);
  const todayStart = startOfDay(now, off);
  const monthStart = startOfMonth(now, off);
  const onlineSince = now - cfg.onlineWindowSec * 1000;
  const days = lastDays(now, off, SERIES_DAYS);
  const sinceMs = startOfDay(now, off) - (SERIES_DAYS - 1) * DAY;
  const bucket = (col) => `strftime('%Y-%m-%d', ${col} / 1000 + ${offSec}, 'unixepoch')`;
  const nonAdmin = 'user_id IN (SELECT id FROM users WHERE is_admin = 0)';

  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  const t = one(`
    SELECT
      COUNT(*) AS users,
      SUM(CASE WHEN last_seen_at > ? THEN 1 ELSE 0 END) AS online,
      SUM(CASE WHEN last_seen_at > ? AND last_running = 1 THEN 1 ELSE 0 END) AS runningNow,
      SUM(CASE WHEN sub_kind = 'paid' AND sub_end > ? THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN sub_kind = 'trial' AND sub_end > ? THEN 1 ELSE 0 END) AS trial,
      SUM(CASE WHEN sub_kind = 'comp' AND sub_end > ? THEN 1 ELSE 0 END) AS comp,
      SUM(CASE WHEN sub_end > 0 AND sub_end <= ? THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN sub_end = 0 THEN 1 ELSE 0 END) AS never,
      SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS suspended,
      SUM(CASE WHEN sub_end > ? AND sub_end <= ? THEN 1 ELSE 0 END) AS expiring7
    FROM users WHERE is_admin = 0`,
  onlineSince, onlineSince, now, now, now, now, now, now + 7 * DAY);

  const rev = (since) => Number(one(
    `SELECT COALESCE(SUM(amount), 0) AS v FROM payments
     WHERE status = 'success' AND method = 'paystack' AND paid_at >= ?`, since).v);

  const act = {
    loginsToday: Number(one(`SELECT COUNT(*) AS v FROM events WHERE type = 'login' AND at >= ? AND ${nonAdmin}`, todayStart).v),
    dauToday: Number(one(`SELECT COUNT(*) AS v FROM daily_active WHERE day = ? AND ${nonAdmin}`, today).v),
    signupsToday: Number(one('SELECT COUNT(*) AS v FROM users WHERE is_admin = 0 AND created_at >= ?', todayStart).v),
    imagesToday: Number(one(`SELECT COALESCE(SUM(images), 0) AS v FROM usage_daily WHERE day = ? AND ${nonAdmin}`, today).v),
    imagesTotal: Number(one(`SELECT COALESCE(SUM(images), 0) AS v FROM usage_daily WHERE ${nonAdmin}`).v),
    promptsTotal: Number(one(`SELECT COALESCE(SUM(prompts), 0) AS v FROM usage_daily WHERE ${nonAdmin}`).v)
  };

  const series = {
    days,
    signups: toSeries(days, all(
      `SELECT ${bucket('created_at')} AS day, COUNT(*) AS v FROM users WHERE is_admin = 0 AND created_at >= ? GROUP BY day`, sinceMs)),
    logins: toSeries(days, all(
      `SELECT ${bucket('at')} AS day, COUNT(*) AS v FROM events WHERE type = 'login' AND at >= ? AND ${nonAdmin} GROUP BY day`, sinceMs)),
    dau: toSeries(days, all(
      `SELECT day, COUNT(*) AS v FROM daily_active WHERE day >= ? AND ${nonAdmin} GROUP BY day`, days[0])),
    revenue: toSeries(days, all(
      `SELECT ${bucket('paid_at')} AS day, SUM(amount) AS v FROM payments
       WHERE status = 'success' AND method = 'paystack' AND paid_at >= ? GROUP BY day`, sinceMs)),
    images: toSeries(days, all(
      `SELECT day, SUM(images) AS v FROM usage_daily WHERE day >= ? AND ${nonAdmin} GROUP BY day`, days[0]))
  };

  const n = (v) => Number(v || 0);
  return {
    now,
    tzOffsetMin: off,
    currency: cfg.currency,
    totals: {
      users: n(t.users), online: n(t.online), runningNow: n(t.runningNow), paid: n(t.paid), trial: n(t.trial),
      comp: n(t.comp), expired: n(t.expired), never: n(t.never), suspended: n(t.suspended), expiring7: n(t.expiring7)
    },
    revenue: { today: rev(todayStart), month: rev(monthStart), total: rev(0) },
    activity: act,
    series
  };
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const USER_FILTERS = {
  all: { where: '1=1', params: () => [] },
  online: { where: 'u.last_seen_at > ?', params: (now, cfg) => [now - cfg.onlineWindowSec * 1000] },
  paid: { where: "u.sub_kind = 'paid' AND u.sub_end > ?", params: (now) => [now] },
  trial: { where: "u.sub_kind = 'trial' AND u.sub_end > ?", params: (now) => [now] },
  comp: { where: "u.sub_kind = 'comp' AND u.sub_end > ?", params: (now) => [now] },
  expiring: { where: 'u.sub_end > ? AND u.sub_end <= ?', params: (now) => [now, now + 7 * DAY] },
  expired: { where: 'u.sub_end > 0 AND u.sub_end <= ?', params: (now) => [now] },
  never: { where: 'u.sub_end = 0', params: () => [] },
  suspended: { where: 'u.suspended = 1', params: () => [] }
};

function userRow(u, cfg, now) {
  const active = u.sub_end > now;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    isAdmin: !!u.is_admin,
    suspended: !!u.suspended,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    lastSeenAt: u.last_seen_at,
    online: !!u.last_seen_at && u.last_seen_at > now - cfg.onlineWindowSec * 1000,
    running: !!u.last_running && !!u.last_seen_at && u.last_seen_at > now - cfg.onlineWindowSec * 1000,
    version: u.last_version,
    subKind: u.sub_kind,
    status: active ? u.sub_kind : (u.sub_end > 0 ? 'expired' : 'none'),
    subEnd: u.sub_end || null,
    daysLeft: active ? Math.ceil((u.sub_end - now) / DAY) : 0,
    lastPaidAt: u.last_paid_at,
    totalPaid: Number(u.total_paid || 0),
    images: Number(u.images || 0)
  };
}

function listUsers(db, cfg, { search = '', filter = 'all', limit = 25, offset = 0 }, now = Date.now()) {
  const f = USER_FILTERS[filter] || USER_FILTERS.all;
  const where = [`u.is_admin = 0`, `(${f.where})`];
  const params = [...f.params(now, cfg)];
  if (search) {
    where.push("(u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')");
    const like = `%${escapeLike(search)}%`;
    params.push(like, like);
  }
  const whereSql = where.join(' AND ');
  const total = Number(db.prepare(`SELECT COUNT(*) AS v FROM users u WHERE ${whereSql}`).get(...params).v);
  const rows = db.prepare(`
    SELECT u.*,
      (SELECT MAX(paid_at) FROM payments p WHERE p.user_id = u.id AND p.status = 'success' AND p.method = 'paystack') AS last_paid_at,
      (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'success' AND p.method = 'paystack') AS total_paid,
      (SELECT COALESCE(SUM(images), 0) FROM usage_daily d WHERE d.user_id = u.id) AS images
    FROM users u WHERE ${whereSql}
    ORDER BY u.created_at DESC, u.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, rows: rows.map((u) => userRow(u, cfg, now)) };
}

function listPayments(db, { status = 'success', limit = 25, offset = 0 }) {
  const where = status === 'all' ? '1=1' : 'p.status = ?';
  const params = status === 'all' ? [] : [status];
  const total = Number(db.prepare(`SELECT COUNT(*) AS v FROM payments p WHERE ${where}`).get(...params).v);
  const rows = db.prepare(`
    SELECT p.*, u.email, u.name FROM payments p JOIN users u ON u.id = p.user_id
    WHERE ${where} ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return {
    total,
    rows: rows.map((p) => ({
      id: p.id, reference: p.reference, userId: p.user_id, email: p.email, name: p.name, plan: p.plan,
      amount: p.amount, currency: p.currency, status: p.status, method: p.method, note: p.note,
      createdAt: p.created_at, paidAt: p.paid_at, periodStart: p.period_start, periodEnd: p.period_end
    }))
  };
}

module.exports = { dashboardStats, listUsers, listPayments, USER_FILTERS };
