(() => {
  'use strict';

  const app = document.getElementById('app');
  const TOKEN_KEY = 'fb_admin_token';
  const PAGE = 25;
  let token = sessionStorage.getItem(TOKEN_KEY);
  const state = { tab: 'users', filter: 'all', search: '', usersOffset: 0, payOffset: 0, payStatus: 'success', stats: null, health: null };
  let refreshTimer = null;

  // ---------- tiny DOM helper. Text is ALWAYS inserted as text nodes (never innerHTML),
  // so a malicious signup name can't inject script into this page. ----------
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c);
    }
    return el;
  }
  const svg = (tag, attrs, ...kids) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    kids.forEach((k) => k && el.append(k));
    return el;
  };

  // ---------- formatting ----------
  const money = (minor, cur) => {
    try { return new Intl.NumberFormat('en-NG', { style: 'currency', currency: cur || 'NGN', maximumFractionDigits: 2, minimumFractionDigits: 0 }).format((minor || 0) / 100); }
    catch { return `${((minor || 0) / 100).toFixed(2)} ${cur || ''}`; }
  };
  const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const ago = (ms) => {
    if (!ms) return 'never';
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return fmtDate(ms);
  };
  const STATUS_LABEL = { paid: 'Paid', trial: 'Trial', comp: 'Comp', expired: 'Expired', none: 'No plan' };

  // ---------- api ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
    });
    if (res.status === 401) { logout(); throw new Error('Session expired — please sign in again.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function toast(message, isErr) {
    const t = h('div', { class: `toast ${isErr ? 'err' : ''}` }, message);
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    token = null;
    clearInterval(refreshTimer);
    renderLogin();
  }

  // ---------- login ----------
  function renderLogin(message) {
    const err = h('p', { class: 'error' }, message || '');
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true });
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true; err.textContent = '';
        try {
          const res = await fetch('/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.value, password: pass.value })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'Sign-in failed');
          if (!data.user || !data.user.isAdmin) throw new Error('This account is not an admin.');
          token = data.token;
          sessionStorage.setItem(TOKEN_KEY, token);
          renderDashboard();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      }
    },
    h('label', { class: 'field' }, h('span', {}, 'Email'), email),
    h('label', { class: 'field' }, h('span', {}, 'Password'), pass),
    btn, err);
    app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login-card' },
      h('h1', {}, 'Flow Batch · Admin'), h('p', {}, 'Sign in with your admin account.'), form)));
  }

  // ---------- charts ----------
  function barChart(days, datasets, fmt) {
    const W = 520, H = 170, L = 38, B = 22, T = 8, R = 6;
    const plotW = W - L - R, plotH = H - T - B;
    const max = Math.max(1, ...datasets.flatMap((d) => d.values));
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
    [0, 0.5, 1].forEach((f) => {
      const y = T + plotH - plotH * f;
      root.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: 'grid-line' }));
      const t = svg('text', { x: L - 6, y: y + 3, 'text-anchor': 'end', class: 'axis' });
      t.textContent = fmt(Math.round(max * f));
      root.append(t);
    });
    const group = plotW / days.length;
    const gap = Math.min(6, group * 0.25);
    const barW = (group - gap) / datasets.length;
    days.forEach((day, i) => {
      datasets.forEach((d, j) => {
        const v = d.values[i];
        const bh = (v / max) * plotH;
        const rect = svg('rect', {
          x: L + i * group + gap / 2 + j * barW, y: T + plotH - bh, width: Math.max(1, barW - 1), height: bh, rx: 2, fill: d.color
        });
        rect.append(svg('title', {}));
        rect.firstChild.textContent = `${day} · ${d.name}: ${fmt(v)}`;
        root.append(rect);
      });
      if (i % 2 === (days.length % 2 === 0 ? 1 : 0)) {
        const lab = svg('text', { x: L + i * group + group / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' });
        lab.textContent = day.slice(5);
        root.append(lab);
      }
    });
    return root;
  }

  function chartCard(title, days, datasets, fmt = String) {
    return h('div', { class: 'chart-card' },
      h('h3', {}, title, h('span', { class: 'legend' },
        datasets.length > 1 ? datasets.map((d) => h('span', {}, (() => { const i = h('i', {}); i.style.background = d.color; return i; })(), d.name)) : null)),
      barChart(days, datasets, fmt));
  }

  // ---------- dashboard ----------
  const els = {};

  function renderDashboard() {
    els.banners = h('div', { class: 'banners' });
    els.cards = h('div', { class: 'cards' });
    els.charts = h('div', { class: 'charts' });
    els.tabs = h('div', { class: 'tabs' });
    els.toolbar = h('div', { class: 'toolbar' });
    els.table = h('div', { class: 'table-wrap' });
    els.pager = h('div', { class: 'pager' });
    els.updated = h('span', {}, '');

    app.replaceChildren(
      h('div', { class: 'topbar' },
        h('div', { class: 'brand' }, h('span', { class: 'dot' }), 'Flow Batch · Admin'),
        h('div', { class: 'right' }, els.updated,
          h('button', { class: 'btn btn-sm', onclick: () => refreshAll() }, 'Refresh'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: logout }, 'Sign out'))),
      h('main', {}, els.banners, els.cards, els.charts, els.tabs, els.toolbar, els.table, els.pager)
    );
    renderTabs();
    refreshAll();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => refreshAll(true), 30000);
  }

  async function refreshAll(quiet) {
    try {
      const [stats, health] = await Promise.all([api('/admin/api/stats'), api('/admin/api/health')]);
      state.stats = stats; state.health = health;
      renderBanners(); renderCards(); renderCharts();
      els.updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      if (!document.querySelector('dialog[open]')) await loadActiveTab();
    } catch (ex) { if (!quiet) toast(ex.message, true); }
  }

  function renderBanners() {
    const hl = state.health;
    const msgs = [];
    if (!hl.paystackConfigured) msgs.push('Paystack is not configured (PAYSTACK_SECRET_KEY missing) — customers cannot pay yet.');
    if (!hl.publicUrlSet) msgs.push('PUBLIC_URL is not set — Paystack cannot send customers back to a confirmation page after paying.');
    if (hl.ephemeralSecret) msgs.push('JWT_SECRET is not set — every user is signed out each time the server restarts.');
    els.banners.replaceChildren(...msgs.map((m) => h('div', { class: 'banner' }, `⚠ ${m}`)));
  }

  function card(label, value, sub, onclick, live) {
    return h('div', { class: `card ${onclick ? 'click' : ''}`, onclick },
      h('div', { class: 'label' }, live ? h('span', { class: 'live' }) : null, label),
      h('div', { class: 'value num' }, value),
      sub ? h('div', { class: 'sub' }, sub) : null);
  }

  function goFilter(filter) {
    state.tab = 'users'; state.filter = filter; state.usersOffset = 0;
    renderTabs(); loadActiveTab();
  }

  function renderCards() {
    const s = state.stats, t = s.totals, a = s.activity, cur = s.currency;
    els.cards.replaceChildren(
      card('Online now', t.online, `${t.runningNow} running a batch`, () => goFilter('online'), true),
      card('Total users', t.users, `+${a.signupsToday} today`, () => goFilter('all')),
      card('Paying customers', t.paid, `${t.trial} on trial · ${t.comp} comp`, () => goFilter('paid')),
      card('Revenue this month', money(s.revenue.month, cur), `${money(s.revenue.today, cur)} today`),
      card('Total revenue', money(s.revenue.total, cur), 'all time'),
      card('Logins today', a.loginsToday, `${a.dauToday} active users`),
      card('Expiring ≤ 7 days', t.expiring7, 'follow up to renew', () => goFilter('expiring')),
      card('Expired', t.expired, 'win-back list', () => goFilter('expired')),
      card('Images saved', a.imagesTotal.toLocaleString(), `${a.imagesToday.toLocaleString()} today · ${a.promptsTotal.toLocaleString()} prompts`)
    );
  }

  function renderCharts() {
    const s = state.stats.series, cur = state.stats.currency;
    els.charts.replaceChildren(
      chartCard('Signups & logins (14 days)', s.days, [
        { name: 'Signups', color: '#5b8def', values: s.signups },
        { name: 'Logins', color: '#21c99b', values: s.logins }]),
      chartCard('Daily active users', s.days, [{ name: 'Active', color: '#21c99b', values: s.dau }]),
      chartCard('Revenue per day', s.days, [{ name: 'Revenue', color: '#f0b429', values: s.revenue }], (v) => money(v, cur).replace(/\.00$/, '')),
      chartCard('Images saved per day', s.days, [{ name: 'Images', color: '#a78bfa', values: s.images }])
    );
  }

  // ---------- tabs / lists ----------
  function renderTabs() {
    els.tabs.replaceChildren(
      ...[['users', 'Users'], ['payments', 'Payments']].map(([id, label]) =>
        h('button', {
          class: `tab ${state.tab === id ? 'active' : ''}`,
          onclick: () => { state.tab = id; renderTabs(); loadActiveTab(); }
        }, label))
    );
  }

  async function loadActiveTab() {
    if (state.tab === 'users') return loadUsers();
    return loadPayments();
  }

  async function download(kind) {
    try {
      const res = await fetch(`/admin/api/export/${kind}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: `${kind}.csv` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (ex) { toast(ex.message, true); }
  }

  function pager(total, offset, onPage) {
    const from = total ? offset + 1 : 0;
    const to = Math.min(total, offset + PAGE);
    els.pager.replaceChildren(
      h('span', {}, `${from}–${to} of ${total}`),
      h('div', { class: 'btns' },
        h('button', { class: 'btn btn-sm', disabled: offset === 0, onclick: () => onPage(Math.max(0, offset - PAGE)) }, '← Prev'),
        h('button', { class: 'btn btn-sm', disabled: offset + PAGE >= total, onclick: () => onPage(offset + PAGE) }, 'Next →')));
  }

  async function loadUsers() {
    let searchTimer;
    const search = h('input', {
      class: 'input', type: 'search', placeholder: 'Search name or email…', value: state.search,
      oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.search = e.target.value; state.usersOffset = 0; loadUsers(); }, 300); }
    });
    const filter = h('select', { class: 'input', onchange: (e) => { state.filter = e.target.value; state.usersOffset = 0; loadUsers(); } },
      ...[['all', 'All users'], ['online', 'Online now'], ['paid', 'Paying'], ['trial', 'On trial'], ['comp', 'Complimentary'],
        ['expiring', 'Expiring ≤ 7 days'], ['expired', 'Expired'], ['never', 'Never subscribed'], ['suspended', 'Suspended']]
        .map(([v, l]) => h('option', { value: v, selected: state.filter === v }, l)));

    const qs = new URLSearchParams({ filter: state.filter, search: state.search, limit: PAGE, offset: state.usersOffset });
    let data;
    try { data = await api(`/admin/api/users?${qs}`); } catch (ex) { toast(ex.message, true); return; }

    // keep focus in the search box across auto-refreshes
    const hadFocus = document.activeElement && document.activeElement.type === 'search';
    els.toolbar.replaceChildren(search, filter, h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: () => download('users') }, 'Export CSV'));
    if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }

    if (!data.rows.length) {
      els.table.replaceChildren(h('div', { class: 'empty' }, 'No users match.'));
    } else {
      els.table.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, ['User', 'Joined', 'Last login', 'Presence', 'Plan', 'Expires', 'Last paid', 'Images', 'Actions'].map((x) => h('th', {}, x)))),
        h('tbody', {}, data.rows.map(userRowEl))));
    }
    pager(data.total, state.usersOffset, (o) => { state.usersOffset = o; loadUsers(); });
  }

  function userRowEl(u) {
    const cur = state.stats ? state.stats.currency : 'NGN';
    const presence = h('span', { class: `presence ${u.online ? 'on' : ''}` }, h('i', {}),
      u.online ? (u.running ? 'Running batch' : 'Online') : ago(u.lastSeenAt));
    const expires = u.subEnd
      ? h('span', {}, fmtDate(u.subEnd), ' ',
        u.daysLeft > 0 ? h('span', { class: u.daysLeft <= 7 ? 'soon' : 'dim' }, `(${u.daysLeft}d left)`) : null)
      : h('span', { class: 'dim' }, '—');
    return h('tr', {},
      h('td', {}, h('div', { class: 'who' }, h('b', {}, u.name || '(no name)', u.suspended ? h('span', { class: 'badge suspended' }, 'Suspended') : null), h('span', {}, u.email))),
      h('td', { class: 'dim' }, fmtDate(u.createdAt)),
      h('td', { class: 'dim' }, ago(u.lastLoginAt)),
      h('td', {}, presence),
      h('td', {}, h('span', { class: `badge ${u.status}` }, STATUS_LABEL[u.status] || u.status)),
      h('td', {}, expires),
      h('td', {}, u.lastPaidAt ? h('span', {}, fmtDate(u.lastPaidAt), h('div', { class: 'dim' }, money(u.totalPaid, cur), ' total')) : h('span', { class: 'dim' }, '—')),
      h('td', { class: 'num' }, u.images.toLocaleString()),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'btn btn-sm', onclick: () => grantDialog(u) }, '+ Days'),
        h('button', { class: 'btn btn-sm btn-danger', onclick: () => revoke(u) }, 'Revoke'),
        h('button', { class: 'btn btn-sm', onclick: () => suspend(u) }, u.suspended ? 'Unsuspend' : 'Suspend'))));
  }

  async function loadPayments() {
    const status = h('select', { class: 'input', onchange: (e) => { state.payStatus = e.target.value; state.payOffset = 0; loadPayments(); } },
      ...[['success', 'Successful'], ['pending', 'Pending'], ['failed', 'Failed'], ['all', 'All']]
        .map(([v, l]) => h('option', { value: v, selected: state.payStatus === v }, l)));
    els.toolbar.replaceChildren(status, h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: () => download('payments') }, 'Export CSV'));

    let data;
    try { data = await api(`/admin/api/payments?status=${state.payStatus}&limit=${PAGE}&offset=${state.payOffset}`); } catch (ex) { toast(ex.message, true); return; }
    if (!data.rows.length) {
      els.table.replaceChildren(h('div', { class: 'empty' }, 'No payments yet.'));
    } else {
      els.table.replaceChildren(h('table', {},
        h('thead', {}, h('tr', {}, ['Paid on', 'Customer', 'Plan', 'Amount', 'Method', 'Access period', 'Status', 'Reference'].map((x) => h('th', {}, x)))),
        h('tbody', {}, data.rows.map((p) => h('tr', {},
          h('td', {}, fmtDateTime(p.paidAt || p.createdAt)),
          h('td', {}, h('div', { class: 'who' }, h('b', {}, p.name || '(no name)'), h('span', {}, p.email))),
          h('td', {}, p.plan),
          h('td', { class: 'num' }, p.method === 'manual' ? h('span', { class: 'dim' }, 'Granted') : money(p.amount, p.currency)),
          h('td', { class: 'dim' }, p.method),
          h('td', {}, p.periodStart ? `${fmtDate(p.periodStart)} → ${fmtDate(p.periodEnd)}` : '—'),
          h('td', {}, h('span', { class: `badge ${p.status === 'success' ? 'paid' : p.status === 'failed' ? 'expired' : 'none'}` }, p.status)),
          h('td', { class: 'mono', title: p.note || '' }, p.reference))))));
    }
    pager(data.total, state.payOffset, (o) => { state.payOffset = o; loadPayments(); });
  }

  // ---------- actions ----------
  function grantDialog(u) {
    const days = h('input', { class: 'input', type: 'number', min: 1, max: 3650, value: 30 });
    const note = h('input', { class: 'input', type: 'text', maxlength: 200, placeholder: 'e.g. bank transfer, refund, giveaway' });
    const dlg = h('dialog', {},
      h('h3', {}, 'Add subscription days'),
      h('p', {}, `${u.name || u.email} — adds time on top of whatever they have left.`),
      h('label', { class: 'field' }, h('span', {}, 'Days'), days),
      h('label', { class: 'field' }, h('span', {}, 'Note (internal)'), note),
      h('div', { class: 'dialog-actions' },
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', {
          class: "btn btn-primary", onclick: async (e) => {
            e.target.disabled = true;
            try {
              await api(`/admin/api/users/${u.id}/grant`, { method: 'POST', body: JSON.stringify({ days: Number(days.value), note: note.value }) });
              dlg.close(); toast('Days added.'); refreshAll(true);
            } catch (ex) { toast(ex.message, true); e.target.disabled = false; }
          }
        }, 'Add days')));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    days.focus();
  }

  async function revoke(u) {
    if (!confirm(`Revoke ${u.email}'s access now? They keep their account but lose the plan immediately.`)) return;
    try { await api(`/admin/api/users/${u.id}/revoke`, { method: 'POST', body: '{}' }); toast('Access revoked.'); refreshAll(true); } catch (ex) { toast(ex.message, true); }
  }

  async function suspend(u) {
    const next = !u.suspended;
    if (!confirm(next ? `Suspend ${u.email}? They will be signed out everywhere and unable to log in.` : `Unsuspend ${u.email}?`)) return;
    try { await api(`/admin/api/users/${u.id}/suspend`, { method: 'POST', body: JSON.stringify({ suspended: next }) }); toast(next ? 'User suspended.' : 'User unsuspended.'); refreshAll(true); } catch (ex) { toast(ex.message, true); }
  }

  // ---------- boot ----------
  if (token) renderDashboard(); else renderLogin();
})();
