/* ================================================================
   e-Work Permit — core: config, API transport (Google Apps Script),
   admin session storage. Loaded on every page (before layout.js).
   ================================================================ */
(() => {
  const WP = (window.WP = window.WP || {});
  const cfg = window.WP_CONFIG || {};
  const D = window.WP_DATA || {};

  // Site root (docs/) as absolute URL without trailing slash — works from /admin/* too.
  const me = document.currentScript && document.currentScript.src;
  WP.base = me ? me.replace(/\/assets\/js\/core\.js(?:[?#].*)?$/, '') : location.origin;
  WP.apiUrl = String(cfg.apiUrl || '').trim();
  WP.data = D;
  WP.defs = D.workTypes || {};
  WP.confinedClose = D.confinedClose || {};

  // Resolves at DOMContentLoaded (all page + deferred scripts have run).
  WP.ready = new Promise(res => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => res(), { once: true });
    else res();
  });

  WP.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  WP.qs = name => new URLSearchParams(location.search).get(name) || '';

  // ---------- browser read cache (stale-while-revalidate) ----------
  // Last response per (session, action, params) in sessionStorage — this tab only,
  // wiped on login / logout / session expiry and after every write action.
  // Used for the admin views (+ the public aggregate counters); never for a
  // requester's permit data.
  const SWR = 'wpt_swr:';
  const swrKey = (action, data) => SWR + (WP.session ? String(WP.session).slice(0, 16) : 'anon') + ':' + action + ':' + JSON.stringify(data || {});
  WP.swrClear = () => {
    try { Object.keys(sessionStorage).filter(k => k.startsWith(SWR)).forEach(k => sessionStorage.removeItem(k)); } catch { }
  };
  WP.cacheGet = (action, data) => { try { const v = sessionStorage.getItem(swrKey(action, data)); return v === null ? null : JSON.parse(v); } catch { return null; } };
  WP.cachePut = (action, data, value) => { try { sessionStorage.setItem(swrKey(action, data), JSON.stringify(value)); } catch { } };

  // ---------- admin session (token from action=login, 6 h server TTL) ----------
  const SKEY = 'wpt_session_v1';
  WP.loadSession = () => {
    try {
      const s = JSON.parse(localStorage.getItem(SKEY) || 'null');
      if (s && s.token && s.exp > Date.now()) return s;
      if (s) localStorage.removeItem(SKEY);
    } catch { }
    return null;
  };
  WP.saveSession = (token, user, ttlSec = 21600) => {
    WP.swrClear();
    const s = { token, user, exp: Date.now() + ttlSec * 1000 };
    try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { }
    WP.session = token; WP.user = user; WP.admin = true;
    return s;
  };
  WP.updateSessionUser = user => {
    const s = WP.loadSession(); if (!s) return;
    s.user = user; try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { }
    WP.user = user;
  };
  WP.clearSession = () => { WP.swrClear(); try { localStorage.removeItem(SKEY); } catch { } WP.session = null; WP.user = null; WP.admin = false; };
  // The server refused `token`: forget it here, but never wipe a newer session that
  // another tab has stored meanwhile (re-login in a new tab while this one waits).
  const dropSession = token => {
    if (WP.session === token) { WP.session = null; WP.user = null; WP.admin = false; }
    const s = WP.loadSession();
    if (!s || s.token === token) WP.clearSession();
  };
  // A session stored by another tab (e.g. re-login after expiry) is picked up by the next call.
  const adoptSession = () => {
    const s = WP.loadSession();
    if (s && s.token !== WP.session) { WP.session = s.token; WP.user = s.user; WP.admin = true; }
  };
  const S = WP.loadSession();
  WP.session = S ? S.token : null;
  WP.user = S ? S.user : null;
  WP.admin = !!S;

  // ---------- roles (safety = จป., responsible = ผู้รับผิดชอบงาน, area_owner = เจ้าของพื้นที่) ----------
  // A session stored before roles existed has no `roles`: those users were all จป.
  WP.roles = (u = WP.user) => (u && Array.isArray(u.roles) ? u.roles : (u ? ['safety'] : []));
  WP.hasRole = (role, u) => WP.roles(u).includes(role);
  WP.isSafety = u => WP.hasRole('safety', u);
  // Where a logged-in user starts: จป. → dashboard, approvers → "รออนุมัติของฉัน".
  WP.homeUrl = u => WP.base + (WP.isSafety(u) ? '/admin/dashboard.html' : '/admin/approvals.html');

  // ---------- API ----------
  const noApi = () => ({ ok: false, code: 'NO_API', error: 'ยังไม่ได้ตั้งค่า apiUrl ใน docs/config.js', msg: 'ยังไม่ได้ตั้งค่า apiUrl ใน docs/config.js' });
  WP.AUTH_KEEP_MSG = ' — ข้อมูลที่กรอกยังอยู่ในหน้านี้: เปิดหน้าเข้าสู่ระบบในแท็บใหม่ แล้วกลับมากดอีกครั้ง';
  /**
   * opts.sent: session token the request carried. On AUTH that token is dropped.
   * Only a page-load read (not opts.write / opts.quiet) jumps to the login page —
   * a write or a background read (poll, attachment) must not throw away what the
   * user has typed / signed on this page; the error is returned to the caller.
   */
  const finish = (j, opts = {}) => {
    if (!j || typeof j !== 'object') j = { ok: false, error: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง' };
    j.msg = j.error || '';
    if (!j.ok && j.code === 'AUTH' && opts.sent) {
      dropSession(opts.sent);
      if (opts.write || opts.quiet) j.msg += WP.AUTH_KEEP_MSG;
      else if (WP.layout === 'admin' || WP.requireAdmin) location.href = WP.base + '/login.html?expired=1';
    }
    // a จป.-only page read by a user without the จป. role (e.g. the role was removed): go to their own list
    if (!j.ok && j.code === 'FORBIDDEN' && !opts.write && !opts.quiet && WP.layout === 'admin' && !WP.allowAll) location.href = WP.base + '/admin/approvals.html';
    return j;
  };
  // Actions that change nothing; any other action (a write) wipes the browser read cache.
  const READS = new Set(['me', 'poll', 'dashboard', 'permits', 'users', 'permit', 'stats', 'file', 'track', 'ping', 'config', 'batch', 'my_tasks', 'approvers', 'responsibles', 'track_list']);
  // Writes and anything carrying a secret: POST, text/plain JSON body (no CORS preflight).
  let writes = 0;
  WP.api = async (action, data = {}, opts = {}) => {
    if (READS.has(action)) return post(action, data, opts);
    writes++; WP.swrClear();
    try { return await post(action, data, Object.assign({}, opts, { write: true })); } finally { writes++; WP.swrClear(); }
  };
  const post = async (action, data, opts = {}) => {
    if (!WP.apiUrl) return noApi();
    const x = await send(action, data);
    return finish(x.j, Object.assign({}, opts, { sent: x.sent }));
  };
  // One POST round-trip: the raw answer + the session token it carried.
  const send = async (action, data) => {
    const body = Object.assign({}, data, { action });
    if (!('session' in data)) adoptSession();
    if (WP.session && !('session' in data)) body.session = WP.session;
    let j;
    try {
      const res = await fetch(WP.apiUrl, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body)
      });
      try { j = await res.json(); } catch { j = { ok: false, error: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (' + res.status + ')' }; }
    } catch (e) {
      j = { ok: false, code: 'NETWORK', error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่' };
    }
    return { j, sent: body.session };
  };
  // ---------- batched reads ----------
  // Read actions requested while the page starts (layout: me, app: poll, page: its
  // data) go to the server as ONE action=batch round-trip at DOMContentLoaded.
  // A backend without "batch" (older deployment) answers NOT_FOUND → single calls.
  const BATCHABLE = new Set(['me', 'poll', 'dashboard', 'permits', 'users', 'permit', 'stats', 'my_tasks', 'approvers']);
  const NB = 'wpt_nobatch';
  let noBatch = false;
  try { noBatch = sessionStorage.getItem(NB) === WP.apiUrl; } catch { }
  let queue = null;
  const single = c => WP.api(c.action, c.data, c.opts).then(c.resolve);
  const flush = async () => {
    const q = queue; queue = null;
    if (q.length === 1 || noBatch) return q.forEach(single);
    const x = await send('batch', { calls: q.map(c => Object.assign({}, c.data, { action: c.action })) });
    const r = finish(x.j);
    if (r.ok && Array.isArray(r.data) && r.data.length === q.length) return q.forEach((c, i) => c.resolve(finish(r.data[i], Object.assign({}, c.opts, { sent: x.sent }))));
    if (r.code === 'NOT_FOUND') {
      noBatch = true;
      try { sessionStorage.setItem(NB, WP.apiUrl); } catch { }
      return q.forEach(single);
    }
    q.forEach(c => c.resolve(Object.assign({}, r)));
  };
  // opts.quiet: a background read (e.g. the 15 s poll) — an expired session does not leave the page.
  WP.read = (action, data = {}, opts = {}) => {
    if (!WP.apiUrl || !BATCHABLE.has(action) || 'session' in data) return WP.api(action, data, opts);
    return new Promise(resolve => {
      if (!queue) { queue = []; WP.ready.then(() => setTimeout(flush, 0)); }
      queue.push({ action, data, opts, resolve });
    });
  };

  /**
   * Stale-while-revalidate: paints the last response of (session, action, params)
   * at once (after DOMContentLoaded), then fetches and repaints only if it changed.
   * render(r) receives the usual {ok, data, msg, code}. Without a session nothing is
   * cached unless opts.anon (public aggregates only). opts.fetch replaces WP.read.
   */
  WP.swr = async (action, data, render, opts = {}) => {
    const use = !!(WP.session || opts.anon);
    let shown = null;
    const cached = use ? WP.cacheGet(action, data) : null;
    if (cached !== null) {
      await WP.ready;
      shown = JSON.stringify(cached);
      render({ ok: true, data: cached, msg: '', cached: true });
    }
    const w = writes;
    const r = await (opts.fetch ? opts.fetch() : WP.read(action, data));
    if (w !== writes) return r; // a write happened meanwhile: this answer may predate it
    if (r.ok) {
      const fresh = JSON.stringify(r.data);
      if (use) WP.cachePut(action, data, r.data);
      if (fresh !== shown) render(r);
    } else if (shown === null || !['NETWORK', 'SERVER', 'BUSY'].includes(r.code)) {
      // (a transient failure keeps the painted copy; anything else is shown as before)
      try { sessionStorage.removeItem(swrKey(action, data)); } catch { }
      render(r);
    }
    return r;
  };

  /** Wraps an async handler so it runs once at a time: a double click / tap while it works is ignored. */
  WP.busy = fn => {
    let running = false;
    return async function (...args) {
      if (running) return;
      running = true;
      try { return await fn.apply(this, args); } finally { running = false; }
    };
  };

  // ---------- one-shot hand-over of a permit view to the next page ----------
  // track / submit already return the status page data (with_permit); the status
  // page takes it once (removed on read, ignored after 60 s) instead of fetching.
  const HK = 'wpt_handoff';
  WP.handoff = (no, t, view) => { if (view) try { sessionStorage.setItem(HK, JSON.stringify({ no, t, at: Date.now(), view })); } catch { } };
  WP.takeHandoff = (no, t) => {
    let h = null;
    try { h = JSON.parse(sessionStorage.getItem(HK) || 'null'); sessionStorage.removeItem(HK); } catch { }
    return h && h.view && h.no === no && h.t === t && Date.now() - h.at >= 0 && Date.now() - h.at < 60000 ? h.view : null;
  };

  // Public reads without secrets: GET ?action=...&_=<ts>
  WP.get = async (action, params = {}) => {
    if (!WP.apiUrl) return noApi();
    const u = new URL(WP.apiUrl);
    u.searchParams.set('action', action);
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
    u.searchParams.set('_', String(Date.now()));
    let j;
    try {
      const res = await fetch(u.toString(), { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow' });
      j = await res.json();
    } catch (e) {
      j = { ok: false, code: 'NETWORK', error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่' };
    }
    return finish(j);
  };

  // Today's date in Asia/Bangkok as YYYY-MM-DD (independent of the viewer's timezone).
  WP.todayBkk = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
})();
