/* Browser transport (docs/assets/js/core.js) against the real backend (gas-mock):
 * batched reads, fallback for a backend without "batch", stale-while-revalidate
 * cache + its invalidation, and the one-shot permit hand-over.  Run: node test/run.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(String(k), String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return [...this.m.keys()]; }
}

module.exports = async function run() {
  let passed = 0;
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) passed++; else failures.push('frontend: ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 300) : ''));
  };

  // ---- backend
  const gas = createGas();
  gas.load(path.join(ROOT, 'apps-script'), ['Data.gs', 'Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs']);
  // fixed server clock: permit numbers below (WP-20261005-...) must not depend on the day the tests run
  gas.clock.offset = new Date('2026-10-05T09:00:00+07:00').getTime() - Date.now();
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Front-End-Test-1';
  gas.context.setupSystem();
  let oldBackend = false; // simulate a deployment without action=batch
  const calls = [];
  let onServer = null; // runs after the server answered, before the browser sees it (e.g. another tab acts)
  const fetchMock = async (url, opts = {}) => {
    let out;
    if ((opts.method || 'GET') === 'POST') {
      let body = opts.body;
      const a = JSON.parse(body);
      calls.push(a.action + (Array.isArray(a.calls) ? '[' + a.calls.map((c) => c.action).join(',') + ']' : ''));
      if (oldBackend && a.action === 'batch') body = JSON.stringify(Object.assign(a, { action: 'batch_unknown' }));
      out = gas.context.doPost({ postData: { contents: body } });
    } else {
      const u = new URL(url);
      calls.push('GET ' + u.searchParams.get('action'));
      out = gas.context.doGet({ parameter: Object.fromEntries(u.searchParams) });
    }
    const text = out.getContent();
    if (onServer) { const f = onServer; onServer = null; f(); }
    return { status: 200, json: async () => JSON.parse(text) };
  };

  // ---- browser-ish global for core.js
  const sessionStorage = new MemStorage(), localStorage = new MemStorage();
  const ss = new Proxy(sessionStorage, { ownKeys: (t) => t.keys(), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
  const ctx = {
    WP_CONFIG: { apiUrl: 'https://script.google.com/macros/s/test/exec' },
    document: { readyState: 'complete', currentScript: null, addEventListener() {} },
    location: { origin: 'https://example.test', href: '', search: '' },
    localStorage, sessionStorage: ss, fetch: fetchMock, URL, URLSearchParams, Intl, setTimeout, console, JSON, Promise, Date, Object, Array, String, Set, Map
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js/data.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js/core.js'), 'utf8'), ctx);
  const WP = ctx.WP;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- login + data
  let r = await WP.api('login', { username: 'admin', password: 'Front-End-Test-1' });
  check('login', r.ok, r);
  WP.saveSession(r.data.session, r.data.user, r.data.expires_in);
  for (let i = 0; i < 2; i++) {
    r = await WP.api('submit', {
      company: WP.data.companies[0], permit_type: 'contractor', work_types: ['general'], work_date: '2026-10-05', time_from: '08:00', time_to: '17:00',
      requester_name: 'ผู้ขอ ' + i, requester_company: 'x', requester_phone: '0812345678', owner_name: 'o', location: 'ห้อง ' + i, job_detail: 'j', requester_sign: PNG
    });
    check('submit ' + i, r.ok, r);
  }

  // ---- reads started together → one batch round-trip, same answers as single calls
  const singles = [await WP.api('me'), await WP.api('poll'), await WP.api('dashboard')];
  calls.length = 0;
  const batched = await Promise.all([WP.read('me'), WP.read('poll'), WP.read('dashboard')]);
  check('3 reads → 1 batch request', calls.length === 1 && calls[0] === 'batch[me,poll,dashboard]', calls);
  check('batched answers === single calls', batched.every((x, i) => same(x, singles[i])), { batched, singles });
  calls.length = 0;
  r = await WP.read('poll', { since: 1 });
  check('a lone read goes out as itself', calls.join() === 'poll' && r.ok && r.data.new.length === 1, { calls, r });

  // ---- AUTH inside a batch still logs the browser out
  const keep = WP.session;
  WP.saveSession('f'.repeat(64), singles[0].data); // the stored session itself has expired on the server
  r = await Promise.all([WP.read('me'), WP.read('dashboard')]);
  check('batched AUTH clears the session', r.every((x) => x.code === 'AUTH') && WP.session === null && localStorage.getItem('wpt_session_v1') === null, r);
  WP.saveSession(keep, singles[0].data);

  // ---- older backend without "batch": fall back to single calls, remember it for this tab
  oldBackend = true;
  calls.length = 0;
  const fb = await Promise.all([WP.read('me'), WP.read('poll'), WP.read('dashboard')]);
  check('old backend: NOT_FOUND batch → single calls', calls.join() === 'batch[me,poll,dashboard],me,poll,dashboard' && fb.every((x, i) => same(x, singles[i])), { calls, fb });
  calls.length = 0;
  await Promise.all([WP.read('me'), WP.read('poll')]);
  check('old backend: no more batch attempts in this tab', calls.join() === 'me,poll', calls);
  oldBackend = false;
  sessionStorage.removeItem('wpt_nobatch');

  // ---- stale-while-revalidate
  // (core.js read wp_nobatch at load: reload it so batching is back on)
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js/core.js'), 'utf8'), ctx);
  const W = ctx.WP;
  W.saveSession(keep, singles[0].data);
  const paints = [];
  const render = (x) => paints.push(x.cached ? 'cached' : (x.ok ? 'fresh' : 'error:' + x.code));
  await W.swr('permits', { status: 'pending' }, render);
  check('swr: first view paints once (fresh)', paints.join() === 'fresh', paints);
  paints.length = 0; calls.length = 0;
  await W.swr('permits', { status: 'pending' }, render);
  check('swr: second view paints the cached copy, unchanged answer is not repainted', paints.join() === 'cached' && calls.join() === 'permits', { paints, calls });
  // a change on the server (other tab / other admin) → repaint
  gas.context.doPost({ postData: { contents: JSON.stringify({ action: 'decide', session: keep, id: 1, decision: 'reject', comment: 'x' }) } });
  paints.length = 0;
  await W.swr('permits', { status: 'pending' }, render);
  check('swr: changed answer is repainted', paints.join() === 'cached,fresh', paints);
  // a write from this tab wipes the cache → next view paints fresh only
  r = await W.api('decide', { id: 2, decision: 'reject', comment: 'y' });
  check('write ok', r.ok, r);
  check('write wiped the browser cache', !ss.keys().some((k) => k.startsWith('wpt_swr:')), ss.keys());
  paints.length = 0;
  await W.swr('permits', { status: 'pending' }, render);
  check('after a write: fresh paint only', paints.join() === 'fresh', paints);
  // cache key is per session; logout wipes it
  check('cache keyed by session', ss.keys().some((k) => k.startsWith('wpt_swr:' + keep.slice(0, 16) + ':permits:')));
  W.clearSession();
  check('logout wipes the browser cache', !ss.keys().some((k) => k.startsWith('wpt_swr:')));
  // anonymous: nothing cached unless explicitly public (opts.anon)
  paints.length = 0;
  await W.swr('permits', {}, render);
  check('anonymous admin view: error painted, nothing cached', paints.join() === 'error:AUTH' && !ss.keys().some((k) => k.startsWith('wpt_swr:')), { paints, keys: ss.keys() });
  await W.swr('stats', {}, render, { anon: true, fetch: () => W.get('stats') });
  check('public stats cached for the tab', ss.keys().some((k) => k === 'wpt_swr:anon:stats:{}'));

  // ---- session expiry while a form is open (admin layout)
  const A = ctx.WP;
  A.layout = 'admin';
  const login = async () => (await A.api('login', { username: 'admin', password: 'Front-End-Test-1' })).data;
  const revoke = (tok) => gas.context.doPost({ postData: { contents: JSON.stringify({ action: 'logout', session: tok }) } });
  let L = await login();
  A.saveSession(L.session, L.user);
  revoke(L.session);
  ctx.location.href = '';
  r = await A.api('decide', { id: 99, decision: 'reject', comment: 'x' });
  check('expired session on a write: error returned, page NOT left (form kept)', r.code === 'AUTH' && ctx.location.href === '' && r.msg.includes(A.AUTH_KEEP_MSG) && A.session === null, { r, href: ctx.location.href });
  L = await login(); A.saveSession(L.session, L.user); revoke(L.session); ctx.location.href = '';
  r = await A.read('poll', { since: 0 }, { quiet: true });
  check('expired session on the background poll: page NOT left', r.code === 'AUTH' && ctx.location.href === '', { r, href: ctx.location.href });
  r = await A.api('file', { id: 1 }, { quiet: true });
  check('expired session when opening an attachment: page NOT left', r.code === 'AUTH' && ctx.location.href === '');
  L = await login(); A.saveSession(L.session, L.user); revoke(L.session); ctx.location.href = '';
  r = await A.read('dashboard');
  check('expired session on a page-load read: goes to login as before', r.code === 'AUTH' && /login\.html\?expired=1$/.test(ctx.location.href), ctx.location.href);
  // re-login in another tab while this tab still holds the old token
  const old = await login(); A.saveSession(old.session, old.user); revoke(old.session);
  const fresh = await login();
  localStorage.setItem('wpt_session_v1', JSON.stringify({ token: fresh.session, user: fresh.user, exp: Date.now() + 3600e3 })); // the other tab
  calls.length = 0;
  r = await A.api('decide', { id: 99, decision: 'reject', comment: 'x' });
  check('after re-login in another tab: the next save uses the new session', r.code === 'NOT_FOUND' && A.session === fresh.session, r);
  // the old token fails while the other tab logs in: the new session must survive
  const old2 = await login(); A.saveSession(old2.session, old2.user); revoke(old2.session);
  const fresh2 = await login();
  onServer = () => localStorage.setItem('wpt_session_v1', JSON.stringify({ token: fresh2.session, user: fresh2.user, exp: Date.now() + 3600e3 }));
  r = await A.api('decide', { id: 99, decision: 'reject', comment: 'x' });
  check('a stale tab AUTH does not wipe the session another tab just stored', r.code === 'AUTH' && JSON.parse(localStorage.getItem('wpt_session_v1')).token === fresh2.session, r);
  A.layout = undefined; ctx.location.href = '';

  // ---- WP.busy: a double click while a save is running sends one request
  let runs = 0;
  const hb = A.busy(async () => { runs++; await tick(); });
  await Promise.all([hb(), hb(), hb()]);
  await hb();
  check('busy: re-entry ignored, next click runs again', runs === 2, runs);

  // ---- signature pad (app.js) on a phone: fractional CSS width, URL bar show/hide fires "resize"
  {
    const winListeners = {};
    const canvas = {
      _w: 300, _h: 150, rect: { width: 343.3, height: 170 },
      get width() { return this._w; }, set width(v) { this._w = Math.floor(v); }, // canvas sizes are integers (truncated)
      get height() { return this._h; }, set height(v) { this._h = Math.floor(v); },
      getBoundingClientRect() { return this.rect; },
      getContext() { return { setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {} }; },
      addEventListener() {}, toDataURL() { return 'data:image/png;base64,AAAA'; }
    };
    const wrap = { querySelector: (s) => (s === 'canvas' ? canvas : null), classList: { add() {}, remove() {} } };
    const none = { querySelector: () => null, querySelectorAll: () => [] };
    const dctx = {
      WP: { esc: (x) => String(x) }, devicePixelRatio: 2,
      document: Object.assign({ addEventListener() {}, body: {} }, none),
      addEventListener: (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); },
      setTimeout: () => 0, setInterval: () => 0, matchMedia: () => ({ matches: true }),
      IntersectionObserver: class { observe() {} unobserve() {} }, Image: class {}, Math, Array, Object, String, Date
    };
    dctx.window = dctx;
    vm.createContext(dctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js/app.js'), 'utf8'), dctx);
    const pad = new dctx.WP.SignaturePad(wrap);
    pad.empty = false; // signed
    let redraws = 0;
    pad.load = () => { redraws++; };
    (winListeners.resize || []).forEach((fn) => fn());
    (winListeners.resize || []).forEach((fn) => fn());
    check('signature pad: a resize with an unchanged width does not re-draw (blur) the signature', redraws === 0 && canvas.width === 687, { redraws, w: canvas.width });
    canvas.rect = { width: 700, height: 170 };
    (winListeners.resize || []).forEach((fn) => fn());
    check('signature pad: a real width change (rotation) still keeps the signature', redraws === 1 && canvas.width === 1400, { redraws, w: canvas.width });
  }

  // ---- one-shot hand-over (track / submit → status page)
  r = await W.api('track', { permit_no: 'WP-20261005-001', phone: '0812345678', with_permit: true });
  check('track with_permit returns the view', r.ok && r.data.view && r.data.view.permit.permit_no === 'WP-20261005-001', r);
  W.handoff(r.data.permit_no, r.data.token, r.data.view);
  check('hand-over: wrong token → nothing (and consumed)', W.takeHandoff('WP-20261005-001', 'a'.repeat(32)) === null && sessionStorage.getItem('wpt_handoff') === null);
  W.handoff(r.data.permit_no, r.data.token, r.data.view);
  const direct = await W.api('permit', { no: r.data.permit_no, t: r.data.token });
  check('hand-over: same data as action permit', same(W.takeHandoff(r.data.permit_no, r.data.token), direct.data));
  check('hand-over: one-shot', W.takeHandoff(r.data.permit_no, r.data.token) === null);
  W.handoff(r.data.permit_no, r.data.token, r.data.view);
  const h = JSON.parse(sessionStorage.getItem('wpt_handoff')); h.at -= 61000; sessionStorage.setItem('wpt_handoff', JSON.stringify(h));
  check('hand-over: ignored after 60 s', W.takeHandoff(r.data.permit_no, r.data.token) === null);
  await tick();

  // ---- roles (approval workflow) in the browser
  {
    const X = ctx.WP;
    X.layout = undefined; X.allowAll = false; ctx.location.href = '';
    const adm = (await X.api('login', { username: 'admin', password: 'Front-End-Test-1' })).data;
    X.saveSession(adm.session, adm.user);
    check('roles: admin is safety → dashboard', X.isSafety() && X.homeUrl() === X.base + '/admin/dashboard.html' && X.roles().join() === 'safety');
    X.saveSession(adm.session, { id: 1, username: 'admin', fullname: 'x' }); // stored before roles existed
    check('roles: a session stored before roles existed counts as จป.', X.isSafety() && X.homeUrl().endsWith('/admin/dashboard.html'));
    X.saveSession(adm.session, adm.user);
    const mk = async (u, roles) => (await X.api('user_save', { username: u, fullname: 'ผู้ใช้ ' + u, roles, email: u + '@corp.co.th', password: 'pw-' + u })).data.id;
    const rid = await mk('fresp', ['responsible']), aid = await mk('farea', ['area_owner']);
    const pub = await X.get('responsibles');
    check('public responsibles (GET): id + name only', pub.ok && pub.data.length === 1 && pub.data[0].id === rid && !JSON.stringify(pub.data).includes('@'), pub);
    const sub = await X.api('submit', {
      company: X.data.companies[0], permit_type: 'contractor', work_types: ['general'], work_date: '2026-10-05', time_from: '08:00', time_to: '17:00',
      requester_name: 'ผู้ขอ wf', requester_company: 'x', requester_phone: '0812345678', owner_name: '', location: 'ห้อง wf', job_detail: 'j', requester_sign: PNG, responsible_id: rid
    });
    check('submit with responsible from the browser', sub.ok, sub);
    const rl = (await X.api('login', { username: 'fresp', password: 'pw-fresp' })).data;
    X.saveSession(rl.session, rl.user);
    check('roles: responsible → approvals page', !X.isSafety() && X.hasRole('responsible') && X.homeUrl() === X.base + '/admin/approvals.html');
    const singlesA = [await X.api('me'), await X.api('my_tasks'), await X.api('approvers'), await X.api('permit', { id: sub.data.id, signs: true })];
    calls.length = 0;
    const batchedA = await Promise.all([X.read('me'), X.read('my_tasks'), X.read('approvers'), X.read('permit', { id: sub.data.id, signs: true })]);
    check('approver page load: me + my_tasks + approvers + permit in ONE batch', calls.length === 1 && calls[0] === 'batch[me,my_tasks,approvers,permit]' && batchedA.every((x, i) => same(x, singlesA[i])), { calls, batchedA });
    check('approver: my_tasks lists the permit at stage assign', batchedA[1].data.count === 1 && batchedA[1].data.pending[0].stage === 'assign');
    // FORBIDDEN: a จป.-only page read leaves for the approver's own list; a write / background read / allowed page does not
    X.layout = 'admin'; ctx.location.href = '';
    r = await X.read('dashboard');
    check('FORBIDDEN page-load read on a จป. page → approvals', r.code === 'FORBIDDEN' && /\/admin\/approvals\.html$/.test(ctx.location.href) && X.session === rl.session, { r, href: ctx.location.href });
    ctx.location.href = '';
    r = await X.api('decide', { id: sub.data.id, decision: 'reject', comment: 'x' });
    check('FORBIDDEN write: page kept, session kept', r.code === 'FORBIDDEN' && ctx.location.href === '' && X.session === rl.session);
    X.allowAll = true;
    r = await X.read('poll', {});
    check('FORBIDDEN on an allowed page (view / approvals): no redirect', r.code === 'FORBIDDEN' && ctx.location.href === '');
    X.allowAll = false; X.layout = undefined;
    r = await X.api('stage_decide', { id: sub.data.id, decision: 'approve', sign: PNG, area_owner_id: aid });
    check('write action wipes the browser cache + works (responsible approves first → area owner)', r.ok && r.data.stage === 'area' && !ss.keys().some((k) => k.startsWith('wpt_swr:')), r);

    // progress rendering (parts.js): stage names + times only
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js/parts.js'), 'utf8'), ctx);
    const view = (await X.api('permit', { id: sub.data.id })).data.permit;
    let h = X.trackStepsHTML(view);
    const steps = h.match(/<div class="ts [^"]*"/g) || [];
    check('progress: 5 workflow steps, 0–1 (ผู้รับผิดชอบงาน) done, 2 (เจ้าของพื้นที่) current', steps.length === 5 && /\bon\b/.test(steps[0]) && /\bon\b/.test(steps[1]) && /\bcur\b/.test(steps[2]) && !/\bon\b/.test(steps[3]), steps);
    check('progress: order ผู้รับผิดชอบงาน → เจ้าของพื้นที่ → จป.', h.indexOf('ผู้รับผิดชอบงานอนุมัติ') > 0 && h.indexOf('ผู้รับผิดชอบงานอนุมัติ') < h.indexOf('เจ้าของพื้นที่อนุมัติ') && h.indexOf('เจ้าของพื้นที่อนุมัติ') < h.indexOf('จป. อนุมัติ'), h);
    check('progress: shows the stage times, never approver names', h.includes(X.thaiDate(view.resp_approved_at, true)) && !h.includes('ผู้ใช้ fresp') && !h.includes('ผู้ใช้ farea') && !h.includes('@'), h);
    {
      // a permit started before the order changed: area owner approved first, now at the legacy stage resp (step 1)
      const lg = X.trackStepsHTML(Object.assign({}, view, { stage: 'resp', resp_approved_at: '', area_approved_at: '2026-10-05 09:00:00' })).match(/<div class="ts [^"]*"/g);
      check('progress: legacy stage resp → step 1 current, step 2 done', /\bcur\b/.test(lg[1]) && /\bon\b/.test(lg[2]) && !/\bcur\b/.test(lg[2]), lg);
    }
    h = X.trackStepsHTML(Object.assign({}, view, { status: 'rejected', reject_stage: 'area', stage: '', approved_at: '2026-10-05 10:00:00' }));
    const st2 = h.match(/<div class="ts [^"]*"/g);
    check('progress: rejected at stage 2 → that step is "ไม่อนุมัติ"', /\bbad\b/.test(st2[2]) && h.includes('ไม่อนุมัติ') && !/\bbad\b/.test(st2[1]) && !/\bbad\b/.test(st2[3]), st2);
    h = X.trackStepsHTML(Object.assign({}, view, { status: 'rejected', reject_stage: 'assign', stage: '', resp_approved_at: '', approved_at: '2026-10-05 10:00:00' }));
    check('progress: rejected by the responsible → step 1 "ไม่อนุมัติ"', /\bbad\b/.test((h.match(/<div class="ts [^"]*"/g))[1]));
    check('progress: legacy permit keeps the old 4 steps', (X.trackStepsHTML({ status: 'pending', es: 'pending', workflow: false }).match(/<div class="ts /g) || []).length === 4);
    check('stage badge only while pending in the workflow', X.stageBadge(view).includes('ขั้นที่ 2: รอเจ้าของพื้นที่อนุมัติ') && X.stageBadge(Object.assign({}, view, { stage: 'assign' })).includes('ขั้นที่ 1: รอผู้รับผิดชอบงานอนุมัติ') &&
      X.stageBadge(Object.assign({}, view, { status: 'approved' })) === '');
    // checklist item files: staff get open buttons, the requester (status page) names only; older permits nothing
    const pf = Object.assign({}, view, { item_files: [{ fid: 'a'.repeat(16), item: 'h9', name: 'cert<1>.pdf', size: 10 }, { fid: 'b'.repeat(16), item: 'g3', name: 'p.heic', size: 9 }] });
    const hs = X.infoCardHTML(pf, { staff: true }), hp = X.infoCardHTML(pf);
    check('item files: staff info card links each file by fid (form order, escaped)', hs.includes('data-item-file="' + 'a'.repeat(16) + '"') && hs.includes('cert&lt;1&gt;.pdf') &&
      hs.indexOf('p.heic') < hs.indexOf('cert&lt;1&gt;') && hs.includes('9. เอกสารรับรองที่เกี่ยวข้อง'), hs);
    check('item files: public info card shows names only', hp.includes('p.heic') && !hp.includes('data-item-file'), hp);
    check('item files: older permit (no item_files) → nothing', !X.infoCardHTML(Object.assign({}, view, { item_files: undefined })).includes('ไฟล์แนบรายการตรวจสอบ'));
    X.clearSession();
  }

  // ---- request wizard step 4 (ยอมรับระเบียบ & ลงนาม): box titles; หมายเหตุ 1–8 only on the printed form
  {
    const html = fs.readFileSync(path.join(ROOT, 'docs/request.html'), 'utf8');
    const init = fs.readFileSync(path.join(ROOT, 'docs/assets/js/pages/request-init.js'), 'utf8');
    const p4 = html.slice(html.indexOf('data-panel="3"'), html.indexOf('id="agree-card"'));
    check('step 4: left box title', p4.includes('<h3>ระเบียบปฏิบัติเพื่อความปลอดภัย อาชีวอนามัย และสภาพแวดล้อมในการทำงาน</h3>'));
    check('step 4: right box title', p4.includes('<h3>ข้อตกลงด้านความปลอดภัย อาชีวอนามัย และสภาพแวดล้อมในการทำงาน</h3>'));
    check('step 4: หมายเหตุ block removed, agreements + กากอุตสาหกรรม kept', !p4.includes('หมายเหตุ') && !p4.includes('id="remarks"') && !init.includes('D.remarks') &&
      p4.includes('id="agreement"') && p4.includes('id="waste"') && p4.includes('id="rules"'));
    const pr = fs.readFileSync(path.join(ROOT, 'docs/assets/js/pages/print.js'), 'utf8');
    check('print still lists หมายเหตุ (D.remarks) and item file names', pr.includes('D.remarks') && pr.includes('item_files'));
  }

  return { passed, failures };
};
