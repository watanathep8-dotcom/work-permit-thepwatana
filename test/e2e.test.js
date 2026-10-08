/* End-to-end tests of the Apps Script backend through doGet/doPost,
 * using the in-memory mocks in gas-mock.js.  Run: node test/run.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { createGas } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const GS_ORDER = ['Data.gs', 'Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs'];

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; return; }
  failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : ''));
}
function throws(name, fn, re) {
  try { fn(); failures.push(name + ' → did not throw'); } catch (e) {
    if (re && !re.test(e.message)) failures.push(name + ' → wrong error: ' + e.message); else passed++;
  }
}

// ------------------------------------------------------------ fixtures
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SIG = 'data:image/png;base64,' + PNG_1x1;
const PDF_B64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n').toString('base64');

module.exports = function run() {
  const gas = createGas();
  gas.load(path.join(ROOT, 'apps-script'), GS_ORDER);
  const G = gas.context;
  const BKK = (iso) => new Date(iso + '+07:00').getTime();
  const setNow = (iso) => { gas.clock.offset = BKK(iso) - Date.now(); };

  const post = (body) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  const get = (params) => JSON.parse(G.doGet({ parameter: params }).getContent());

  // ================================================================ setup
  setNow('2026-10-05T09:00:00');
  check('API before setup → SETUP error', post({ action: 'stats' }).code === 'SETUP');
  throws('setupSystem refuses without WP_INITIAL_ADMIN_PASSWORD', () => G.setupSystem(), /WP_INITIAL_ADMIN_PASSWORD/);
  check('no spreadsheet created when refused', gas.spreadsheets.size === 0);
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'short';
  throws('setupSystem refuses too-short initial password', () => G.setupSystem(), /WP_INITIAL_ADMIN_PASSWORD/);
  const INIT_PW = 'Init-Passw0rd!';
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = INIT_PW;
  const s1 = G.setupSystem();
  check('setup creates admin', s1.adminCreated === true);
  const ssId = gas.propStore.WP_SPREADSHEET_ID, folderId = gas.propStore.WP_FOLDER_ID;
  const ss = gas.spreadsheets.get(ssId);
  check('sheets users/permits/permit_logs', ['users', 'permits', 'permit_logs'].every((n) => ss.getSheetByName(n)));
  check('permits header has all columns', ss.getSheetByName('permits').getRange(1, 1, 1, G.WP_SCHEMA.permits.length).getValues()[0].join() === G.WP_SCHEMA.permits.join());
  const s2 = G.setupSystem();
  check('setup idempotent (same ids, no new admin)', !s2.adminCreated && gas.propStore.WP_SPREADSHEET_ID === ssId && gas.propStore.WP_FOLDER_ID === folderId && gas.spreadsheets.size === 1 && ss.sheets.length === 3);
  const userRow = ss.getSheetByName('users').getDataRange().getValues();
  check('one user stored', userRow.length === 2);
  const uh = userRow[0];
  check('password stored as salt+hash, not plaintext', !JSON.stringify(userRow).includes(INIT_PW) && /^[a-f0-9]{64}$/.test(userRow[1][uh.indexOf('password_hash')]) && userRow[1][uh.indexOf('iterations')] === '5000');

  // ================================================================ public GET
  check('GET ping', get({ action: 'ping' }).ok);
  const cfg = get({ action: 'config' });
  check('GET config returns reference data', cfg.ok && cfg.data.companies.join() === 'บริษัท เทพวัฒนา จำกัด' && cfg.data.workTypes.confined.form === 'FM-EMR-46');
  check('GET stats', get({ action: 'stats' }).data.total === 0);
  // this site has one company; the edit tests below switch between two, so a test-only second one is added
  G.WP_DATA.companies.push('บริษัท ทดสอบ (เฉพาะชุดทดสอบ)');
  check('GET on POST-only action refused', !get({ action: 'permits' }).ok);
  check('unknown action', post({ action: 'nope' }).code === 'NOT_FOUND');
  check('invalid JSON body', JSON.parse(G.doPost({ postData: { contents: '{bad' } }).getContent()).ok === false);

  // ================================================================ login
  gas.stats.sleeps.length = 0;
  let r = post({ action: 'login', username: 'admin', password: 'wrong-pass' });
  check('login wrong password fails', !r.ok && r.code === 'AUTH_FAILED' && r.error === 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', r);
  check('failed login sleeps 1s', gas.stats.sleeps[0] === 1000);
  check('unknown user fails the same way', post({ action: 'login', username: 'ghost', password: 'x' }).code === 'AUTH_FAILED');
  r = post({ action: 'login', username: 'admin', password: INIT_PW });
  check('login right password', r.ok && /^[a-f0-9]{64}$/.test(r.data.session) && r.data.user.username === 'admin', r);
  let S = r.data.session;
  check('username case-insensitive like MySQL', post({ action: 'login', username: 'ADMIN', password: INIT_PW }).ok);
  check('me with session', post({ action: 'me', session: S }).data.fullname === 'ผู้ดูแลระบบ จป.');
  check('me without session → AUTH', post({ action: 'me' }).code === 'AUTH');
  check('me with forged session → AUTH', post({ action: 'me', session: 'a'.repeat(64) }).code === 'AUTH');

  // lockout: 10 failures → locked 15 min, even for the right password
  for (let i = 0; i < 10; i++) post({ action: 'login', username: 'admin', password: 'bad' + i });
  r = post({ action: 'login', username: 'admin', password: INIT_PW });
  check('locked after 10 failures', !r.ok && r.code === 'LOCKED', r);
  check('lockout does not block other usernames', post({ action: 'login', username: 'other', password: 'x' }).code === 'AUTH_FAILED');
  gas.clock.offset += 16 * 60 * 1000;
  r = post({ action: 'login', username: 'admin', password: INIT_PW });
  check('lock expires after 15 min', r.ok, r);
  S = r.data.session;
  setNow('2026-10-05T09:30:00');

  // ================================================================ submit
  const base = () => ({
    action: 'submit', company: G.WP_DATA.companies[0], permit_type: 'contractor', work_types: ['hot', 'electric', 'confined', 'bogus'],
    work_date: '2026-10-05', time_from: '08:00', time_to: '17:00', requester_title: 'นาย',
    requester_name: 'สมชาย ใจดี', requester_company: 'ผู้รับเหมา ก', requester_phone: '081-234-5678',
    owner_name: 'วิชัย', owner_phone: '0899999999', location: '=HYPERLINK("http://evil")', job_detail: 'เชื่อมท่อ\nบรรทัด 2',
    workers: [{ name: 'คนงาน 1', role: 'ช่างเชื่อม', idno: '123' }, { name: '' }, { name: 'คนงาน 2' }],
    checklist: { h1: true, h8: { sel: ['ถุงมือ', 'ไม่มีจริง'], other: 'x' }, e6: { on: true, text: 'ข้อกำหนด' }, cs4_1: 'ใช่', cs4_12: 'ไม่ใช่', cs4_12_t: 'อื่นๆ', zzz: 'drop me' },
    loto: [{ item: 'MDB-1', t_on: '08:00', by_on: 'A', hacker: 'x' }],
    confined: { gas: [{ o2: '20.9', lel: '0', by: 'จป.', time: '08:10' }], close: { done: true } },
    requester_sign: SIG, owner_sign: SIG,
    attachment: { name: 'รายชื่อ.pdf', mimeType: 'application/pdf', base64: PDF_B64 }
  });
  const bad = (name, mut, re) => { const b = base(); mut(b); const x = post(b); check('submit rejects: ' + name, !x.ok && (!re || re.test(x.error)), x); };
  bad('no work types', (b) => { b.work_types = ['bogus']; }, /ลักษณะงาน/);
  bad('bad company', (b) => { b.company = 'X'; }, /บริษัท/);
  bad('bad permit type', (b) => { b.permit_type = 'x'; }, /ประเภท/);
  bad('bad date', (b) => { b.work_date = '5/10/2026'; }, /วันที่/);
  bad('bad time', (b) => { b.time_to = '5pm'; }, /เวลา/);
  bad('missing requester name', (b) => { b.requester_name = '  '; }, /ชื่อผู้ขออนุญาต/);
  bad('missing signature', (b) => { b.requester_sign = ''; }, /ลงลายมือชื่อ/);
  bad('non-PNG signature', (b) => { b.requester_sign = 'data:image/svg+xml;base64,AAAA'; }, /ลายเซ็น/);
  bad('PNG header lie in signature', (b) => { b.requester_sign = 'data:image/png;base64,' + PDF_B64; }, /ลายเซ็น/);
  bad('attachment ext not allowed', (b) => { b.attachment.name = 'x.exe'; }, /ชนิดไฟล์/);
  bad('attachment content mismatch', (b) => { b.attachment.name = 'x.png'; }, /ไม่ตรง/);
  bad('attachment > 10 MB', (b) => { b.attachment.base64 = Buffer.alloc(10 * 1048576 + 10, 0x25).toString('base64'); }, /ใหญ่เกิน/);
  bad('oversize workers JSON (cell limit)', (b) => { b.workers = Array.from({ length: 200 }, (_, i) => ({ name: 'ก'.repeat(150), role: 'ข'.repeat(150), idno: String(i).repeat(50) })); }, /ขีดจำกัด/);
  check('rejected submits created no Drive files', gas.files.size === 0);

  r = post(base());
  check('submit ok', r.ok && r.data.permit_no === 'WP-20261005-001' && /^[a-f0-9]{32}$/.test(r.data.token), r);
  const P1 = r.data;
  check('submit returns tracking path', P1.track_path === 'track.html?no=WP-20261005-001&t=' + P1.token);
  check('3 Drive files (2 signatures + attachment), private', gas.files.size === 3 && gas.stats.sharingCalls === 0);
  const b2 = base(); delete b2.attachment; b2.owner_sign = ''; b2.work_types = ['general']; b2.requester_phone = '0811111111';
  b2.location = 'ห้อง MDB';
  r = post(b2);
  check('second submit numbered 002', r.ok && r.data.permit_no === 'WP-20261005-002', r);
  const P2 = r.data;
  const pRows = ss.getSheetByName('permits').getDataRange().getValues();
  const ph = pRows[0];
  check('phone kept as text with leading zero', pRows[1][ph.indexOf('requester_phone')] === '081-234-5678');
  check('no signature data URL stored in cells', !JSON.stringify(pRows).includes('base64'));
  check('formula-like text round-trips', post({ action: 'permit', no: P1.permit_no, t: P1.token }).data.permit.location === '=HYPERLINK("http://evil")');
  check('stats counts 2 pending today', get({ action: 'stats' }).data.pending === 2 && get({ action: 'stats' }).data.today === 2);

  // ================================================================ track / token access
  check('track wrong phone', post({ action: 'track', permit_no: P1.permit_no, phone: '000' }).code === 'NOT_FOUND');
  r = post({ action: 'track', permit_no: P1.permit_no.toLowerCase(), phone: '0812345678' });
  check('track right phone (digits only, case-insensitive no)', r.ok && r.data.token === P1.token, r);
  r = post({ action: 'permit', no: P1.permit_no, t: P1.token });
  const v1 = r.ok && r.data.permit;
  check('permit by token', v1 && v1.permit_no === P1.permit_no && v1.status === 'pending' && v1.es === 'pending', r);
  check('work types filtered', v1 && v1.work_types.join() === 'hot,electric,confined');
  check('workers cleaned', v1 && v1.worker_count === 2 && v1.workers.length === 2);
  // no _v = a checklist from a page cached before the paper-form update → upgraded (old "ถุงมือ" of h8 has no equivalent → Other)
  check('checklist sanitized', v1 && !('zzz' in v1.checklist) && v1.checklist.h8.sel.join() === '' && v1.checklist.h8.other === 'x, ถุงมือ' &&
    v1.checklist.cs4_12_t === 'อื่นๆ' && v1.checklist.e6.on === true && v1.checklist._v === G.WP_DATA.config.checklistVersion, v1 && v1.checklist);
  check('loto sanitized', v1 && v1.loto.length === 1 && !('hacker' in v1.loto[0]) && v1.loto[0].item === 'MDB-1');
  check('confined cleaned (5 gas, 6 entries, 3 renew)', v1 && v1.confined.gas.length === 5 && v1.confined.entries.length === 6 && v1.confined.renew.length === 3 && v1.confined.close.done === true);
  check('token not echoed in permit', v1 && !('token' in v1));
  check('log submit', r.data.logs.length === 1 && r.data.logs[0].action === 'submit' && r.data.logs[0].by_name === 'สมชาย ใจดี');
  check('signatures not sent unless asked', !r.data.signs);
  r = post({ action: 'permit', no: P1.permit_no, t: P1.token, signs: true });
  check('token holder gets signatures for print', r.ok && r.data.signs.requester.startsWith('data:image/png;base64,') && r.data.signs.owner && r.data.signs.approver === '');
  check('wrong token → NOT_FOUND', post({ action: 'permit', no: P1.permit_no, t: 'f'.repeat(32) }).code === 'NOT_FOUND');
  check("other permit's token → NOT_FOUND", post({ action: 'permit', no: P1.permit_no, t: P2.token }).code === 'NOT_FOUND');
  check('no token → NOT_FOUND', post({ action: 'permit', no: P1.permit_no }).code === 'NOT_FOUND');
  check('token without no → NOT_FOUND', post({ action: 'permit', t: P1.token }).code === 'NOT_FOUND');
  check('by id without session → AUTH', post({ action: 'permit', id: 1 }).code === 'AUTH');
  check('by id with token instead of session → AUTH', post({ action: 'permit', id: 1, no: P1.permit_no, t: P1.token }).code === 'AUTH');
  r = post({ action: 'file', no: P1.permit_no, t: P1.token });
  check('attachment with token', r.ok && r.data.base64 === PDF_B64 && r.data.mimeType === 'application/pdf' && r.data.inline && r.data.name === 'รายชื่อ.pdf', r);
  check('attachment wrong token', post({ action: 'file', no: P1.permit_no, t: P2.token }).code === 'NOT_FOUND');
  check('attachment none on P2', post({ action: 'file', no: P2.permit_no, t: P2.token }).code === 'NOT_FOUND');
  check('attachment by id needs session', post({ action: 'file', id: 1 }).code === 'AUTH');

  // admin-only actions must refuse anonymous / bogus / token callers
  ['poll', 'dashboard', 'permits', 'save_review', 'decide', 'delete', 'update_permit', 'users', 'user_save', 'user_toggle', 'me', 'reset_data'].forEach((a) => {
    check('anonymous ' + a + ' refused', post({ action: a, id: 1, decision: 'approve', fullname: 'x', no: P1.permit_no, t: P1.token }).code === 'AUTH');
    check('bogus session ' + a + ' refused', post({ action: a, id: 1, session: '0'.repeat(64) }).code === 'AUTH');
  });

  // ================================================================ admin list / dashboard / poll
  r = post({ action: 'poll', session: S });
  check('poll', r.ok && r.data.pending === 2 && r.data.max_id === 2 && r.data.new.length === 0, r);
  r = post({ action: 'poll', session: S, since: 1 });
  check('poll since', r.data.new.length === 1 && r.data.new[0].permit_no === P2.permit_no);
  r = post({ action: 'permits', session: S });
  check('permits list desc', r.ok && r.data.rows.length === 2 && r.data.rows[0].id === 2 && r.data.counts.pending === 2, r);
  check('permits q filter', post({ action: 'permits', session: S, q: 'mdb' }).data.rows.length === 1);
  check('permits type filter', post({ action: 'permits', session: S, type: 'confined' }).data.rows.map((x) => x.id).join() === '1');
  check('permits date filter', post({ action: 'permits', session: S, from: '2026-10-06' }).data.rows.length === 0);
  check('permits status filter', post({ action: 'permits', session: S, status: 'approved' }).data.rows.length === 0);
  r = post({ action: 'dashboard', session: S });
  check('dashboard', r.ok && r.data.cnt.pending === 2 && r.data.byType.hot === 1 && r.data.byType.general === 1 && r.data.days.length === 14 && r.data.days[13].count === 2 && r.data.pending.length === 2, r);

  // ================================================================ review / approve / reject / close
  r = post({
    action: 'save_review', session: S, id: 1, log: true,
    checklist: { h1: true, h2: true, nope: 1 }, loto: [{ item: 'X' }],
    confined: { gas: [{ o2: '21' }] },
    inspections: { owner: { before: { name: 'เจ้าของพื้นที่' }, note: 'ok' }, safety: { permit: { name: '' }, before: { name: 'จป. A' } } }
  });
  check('save_review', r.ok && r.data.inspections.owner.before.name === 'เจ้าของพื้นที่' && /^2026-10-05 09:30/.test(r.data.inspections.owner.before.at) && r.data.inspections.owner.note === 'ok', r);
  const at1 = r.data.inspections.owner.before.at;
  gas.clock.offset += 60000;
  r = post({ action: 'save_review', session: S, id: 1, checklist: {}, inspections: { owner: { before: { name: 'เจ้าของพื้นที่' }, during: { name: 'คนใหม่' } }, safety: { before: { name: 'จป. A' } } } });
  check('inspection time kept for unchanged name, stamped for new', r.data.inspections.owner.before.at === at1 && r.data.inspections.owner.during.at !== at1 && !r.data.inspections.owner.note);
  check('confined kept when not sent', post({ action: 'permit', session: S, id: 1 }).data.permit.confined.gas[0].o2 === '21');
  check('review log only when log=true', post({ action: 'permit', session: S, id: 1 }).data.logs.filter((l) => l.action === 'review').length === 1);
  check('save_review unknown permit', post({ action: 'save_review', session: S, id: 99 }).code === 'NOT_FOUND');

  check('approve without signature', /ลงลายมือชื่อผู้อนุมัติ/.test(post({ action: 'decide', session: S, id: 1, decision: 'approve' }).error));
  check('bad decision', post({ action: 'decide', session: S, id: 1, decision: 'maybe' }).error === 'คำสั่งไม่ถูกต้อง');
  check('close while pending refused', /เฉพาะใบอนุญาตที่อนุมัติ/.test(post({ action: 'decide', session: S, id: 1, decision: 'close' }).error));
  r = post({ action: 'decide', session: S, id: 1, decision: 'approve', comment: 'ต้องมี Fire Watch', sign: SIG });
  check('approve', r.ok && r.data.status === 'approved', r);
  r = post({ action: 'permit', session: S, id: 1, signs: true });
  const a1 = r.data.permit;
  check('approved fields', a1.status === 'approved' && a1.es === 'approved' && a1.approver_name === 'ผู้ดูแลระบบ จป.' && a1.approve_comment === 'ต้องมี Fire Watch' && a1.inspections.safety.permit.name === 'ผู้ดูแลระบบ จป.');
  check('approver signature served', r.data.signs.approver.startsWith('data:image/png'));
  check('approve log', r.data.logs.some((l) => l.action === 'approve' && l.note === 'ต้องมี Fire Watch'));
  check('approve twice refused', /ไม่ได้อยู่ในสถานะรออนุมัติ/.test(post({ action: 'decide', session: S, id: 1, decision: 'approve', sign: SIG }).error));
  check('reject approved refused', /ไม่ได้อยู่ในสถานะรออนุมัติ/.test(post({ action: 'decide', session: S, id: 1, decision: 'reject', comment: 'x' }).error));
  check('reject without reason', /เหตุผล/.test(post({ action: 'decide', session: S, id: 2, decision: 'reject', comment: ' ' }).error));
  r = post({ action: 'decide', session: S, id: 2, decision: 'reject', comment: 'เอกสารไม่ครบ' });
  check('reject', r.ok && post({ action: 'permit', no: P2.permit_no, t: P2.token }).data.permit.status === 'rejected');
  check('close rejected refused', !post({ action: 'decide', session: S, id: 2, decision: 'close' }).ok);
  r = post({ action: 'decide', session: S, id: 1, decision: 'close' });
  const c1 = post({ action: 'permit', no: P1.permit_no, t: P1.token }).data;
  check('close', r.ok && c1.permit.status === 'closed' && c1.permit.closed_at && c1.logs.some((l) => l.action === 'close' && l.note === 'ตรวจสอบหลังเสร็จงาน ปิดใบอนุญาต'));

  // ================================================================ expiry
  const end = (wd, f, t) => G.permitEndTs_({ work_date: wd, time_from: f, time_to: t });
  check('end = time_to same day', end('2026-10-05', '08:00', '17:00') === BKK('2026-10-05T17:00:00') / 1000);
  check('overnight end next day', end('2026-10-05', '20:00', '06:00') === BKK('2026-10-06T06:00:00') / 1000);
  check('equal times → capped at +24h', end('2026-10-05', '08:00', '08:00') === BKK('2026-10-06T08:00:00') / 1000);
  const b3 = base(); delete b3.attachment; b3.work_types = ['general']; b3.time_from = '20:00'; b3.time_to = '06:00';
  const P3 = post(b3).data;
  post({ action: 'decide', session: S, id: P3.id, decision: 'approve', sign: SIG });
  setNow('2026-10-06T05:59:00');
  S = post({ action: 'login', username: 'admin', password: INIT_PW }).data.session; // previous session is > 6 h old now
  check('overnight permit still valid at 05:59 next day', post({ action: 'permit', no: P3.permit_no, t: P3.token }).data.permit.es === 'approved');
  setNow('2026-10-06T06:01:00');
  const e3 = post({ action: 'permit', no: P3.permit_no, t: P3.token }).data.permit;
  check('auto-expired after end time', e3.status === 'approved' && e3.es === 'expired');
  check('dashboard counts expired', post({ action: 'dashboard', session: S }).data.cnt.expired === 1);
  check('permits status=expired', post({ action: 'permits', session: S, status: 'expired' }).data.rows.map((x) => x.id).join() === String(P3.id));
  check('expired (approved) can still be closed like PHP', post({ action: 'decide', session: S, id: P3.id, decision: 'close' }).ok);
  r = post(Object.assign(base(), { attachment: null }));
  check('numbering restarts per Bangkok day', r.ok && r.data.permit_no === 'WP-20261006-001', r);
  const P4 = r.data;

  // ================================================================ users
  r = post({ action: 'users', session: S });
  check('users list + initial password warning', r.ok && r.data.users.length === 1 && r.data.initial_password_warning === true, r);
  check('user_save bad username', /ชื่อผู้ใช้ต้องเป็น/.test(post({ action: 'user_save', session: S, username: 'a b', fullname: 'X', password: 'secret1' }).error));
  check('user_save short password', /อย่างน้อย 6/.test(post({ action: 'user_save', session: S, username: 'safety2', fullname: 'X', password: '123' }).error));
  check('user_save no fullname', /ชื่อ-นามสกุล/.test(post({ action: 'user_save', session: S, username: 'safety2', fullname: '', password: '123456' }).error));
  r = post({ action: 'user_save', session: S, username: 'safety2', fullname: 'จป. สอง', position: '', password: 'pass-two' });
  check('user add', r.ok && r.data.id === 2, r);
  check('duplicate username (case-insensitive)', /มีอยู่แล้ว/.test(post({ action: 'user_save', session: S, username: 'SAFETY2', fullname: 'x', password: '123456' }).error));
  check('default position', post({ action: 'users', session: S }).data.users[1].position === 'เจ้าหน้าที่ความปลอดภัย (จป.วิชาชีพ)');
  r = post({ action: 'login', username: 'safety2', password: 'pass-two' });
  check('new user can log in', r.ok);
  const S2 = r.data.session;
  check('cannot disable self', /ตนเอง/.test(post({ action: 'user_toggle', session: S2, id: 2 }).error));
  r = post({ action: 'user_toggle', session: S, id: 2 });
  check('disable user', r.ok && r.data.active === false);
  check('disabled user session revoked', post({ action: 'me', session: S2 }).code === 'AUTH');
  check('disabled user cannot log in', post({ action: 'login', username: 'safety2', password: 'pass-two' }).code === 'AUTH_FAILED');
  post({ action: 'user_toggle', session: S, id: 2 });
  const S2b = post({ action: 'login', username: 'safety2', password: 'pass-two' }).data.session;
  r = post({ action: 'user_save', session: S, id: 2, fullname: 'จป. สอง (แก้)', position: 'หัวหน้า', password: 'new-pass-2' });
  check('admin resets other user password', r.ok && !r.data.session);
  check('reset password revokes that user sessions', post({ action: 'me', session: S2b }).code === 'AUTH');
  check('old password no longer works', post({ action: 'login', username: 'safety2', password: 'pass-two' }).code === 'AUTH_FAILED');
  check('new password works', post({ action: 'login', username: 'safety2', password: 'new-pass-2' }).ok);
  check('edit keeps password when blank', post({ action: 'user_save', session: S, id: 2, fullname: 'จป. สอง', password: '' }).ok && post({ action: 'login', username: 'safety2', password: 'new-pass-2' }).ok);
  r = post({ action: 'user_save', session: S, id: 1, fullname: 'ผู้ดูแลระบบ จป.', position: 'จป.', password: 'Brand-New-1' });
  check('own password change returns a fresh session', r.ok && /^[a-f0-9]{64}$/.test(r.data.session) && r.data.session !== S);
  check('old own session revoked', post({ action: 'me', session: S }).code === 'AUTH');
  S = r.data.session;
  check('initial password warning cleared', post({ action: 'users', session: S }).data.initial_password_warning === false);
  check('toggle unknown user', post({ action: 'user_toggle', session: S, id: 77 }).code === 'NOT_FOUND');

  // ================================================================ session TTL / logout
  const S3 = post({ action: 'login', username: 'safety2', password: 'new-pass-2' }).data.session;
  gas.clock.offset += 6 * 3600 * 1000 + 1000;
  check('session expires after 6 h', post({ action: 'me', session: S3 }).code === 'AUTH');
  S = post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).data.session;
  check('logout', post({ action: 'logout', session: S }).ok && post({ action: 'me', session: S }).code === 'AUTH');
  S = post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).data.session;

  // ================================================================ edit / delete (admin session + reset password)
  const pSheet = ss.getSheetByName('permits'), lSheet = ss.getSheetByName('permit_logs');
  const RESET_PW = 'Reset-Only-For-Tests-9';
  const findRow = (id) => pSheet.getDataRange().getValues().find((x, i) => i > 0 && String(x[0]) === String(id));
  const rowOf = (id) => { const row = findRow(id); return row ? JSON.stringify(row) : null; };
  const col = (id, k) => { const row = findRow(id); return row ? row[ph.indexOf(k)] : undefined; };
  const logRows = () => lSheet.getLastRow() - 1;
  const editBody = (o = {}) => {
    const b = Object.assign(base(), {
      action: 'update_permit', session: S, id: P4.id, resetPassword: RESET_PW,
      company: G.WP_DATA.companies[1], permit_type: 'internal', work_types: ['general', 'hot', 'nope'],
      work_date: '2026-10-07', time_from: '22:00', time_to: '04:00',
      requester_name: 'สมชาย (แก้)', requester_company: 'ผู้รับเหมา ข', requester_phone: '0822222222',
      owner_name: 'วิชัย 2', owner_phone: '', location: '+SUM(1,2)', job_detail: 'ซ่อมท่อ',
      workers: [{ name: 'ก' }, { name: 'ข', role: 'ช่าง' }, { name: '' }, { name: 'ค', idno: '9' }],
      checklist: { h1: true, g1: true, junk: 1 }, loto: [{ item: 'MDB-2' }], confined: { gas: [{ o2: '20' }] },
      // must be ignored:
      status: 'approved', permit_no: 'WP-HACKED-001', token: 'f'.repeat(32), approver_name: 'แฮกเกอร์', approved_at: '2026-01-01 00:00:00',
      inspections: { safety: { permit: { name: 'x' } } }, requester_sign_file: 'evil', created_at: '2000-01-01 00:00:00', logs: []
    }, o);
    delete b.attachment;
    Object.keys(b).forEach((k) => { if (b[k] === undefined) delete b[k]; });
    return b;
  };
  const p4Before = rowOf(P4.id), p2Before = rowOf(P2.id), logsBefore0 = logRows();

  check('edit: no session → AUTH', post(editBody({ session: undefined })).code === 'AUTH');
  check('edit: token holder (no session) → AUTH', post(editBody({ session: undefined, no: P4.permit_no, t: P4.token })).code === 'AUTH');
  check('delete: no session → AUTH', post({ action: 'delete', id: P4.id, resetPassword: RESET_PW }).code === 'AUTH');
  r = post(editBody());
  check('edit: refused while WP_RESET_PASSWORD unset', !r.ok && r.code === 'SETUP' && /WP_RESET_PASSWORD/.test(r.error), r);
  r = post({ action: 'delete', session: S, id: P4.id, resetPassword: RESET_PW });
  check('delete: refused while WP_RESET_PASSWORD unset', !r.ok && r.code === 'SETUP', r);
  r = post({ action: 'reset_data', session: S, resetPassword: RESET_PW });
  check('reset: refused while WP_RESET_PASSWORD unset', !r.ok && r.code === 'SETUP' && /WP_RESET_PASSWORD/.test(r.error), r);
  check('reset password is not in the source', !['Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs'].some((f) => /WP_RESET_PASSWORD['"]?\s*[:=]\s*['"][^'"]+['"]/.test(fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8'))));
  gas.propStore.WP_RESET_PASSWORD = RESET_PW;

  gas.stats.sleeps.length = 0;
  r = post(editBody({ resetPassword: undefined }));
  check('edit: without password refused', !r.ok && r.code === 'AUTH_FAILED', r);
  r = post(editBody({ resetPassword: 'wrong' }));
  check('edit: wrong password refused', !r.ok && r.code === 'AUTH_FAILED' && /ไม่ถูกต้อง/.test(r.error), r);
  check('edit: wrong password sleeps 1s', gas.stats.sleeps.length === 2 && gas.stats.sleeps[1] === 1000);
  r = post({ action: 'delete', session: S, id: P4.id });
  check('delete: without password refused', !r.ok && r.code === 'AUTH_FAILED', r);
  r = post({ action: 'delete', session: S, id: P4.id, resetPassword: 'wrong' });
  check('delete: wrong password refused', !r.ok && r.code === 'AUTH_FAILED', r);
  check('edit/delete: nothing changed after password failures', rowOf(P4.id) === p4Before && logRows() === logsBefore0 && post({ action: 'permit', no: P4.permit_no, t: P4.token }).ok);
  // shared lockout with reset_data: 4 failures so far + 3 via reset + 3 via edit → 10
  for (let i = 0; i < 3; i++) post({ action: 'reset_data', session: S, resetPassword: 'bad' + i });
  for (let i = 0; i < 3; i++) post(editBody({ resetPassword: 'bad' + i }));
  r = post(editBody());
  check('edit: locked by shared counter (right password)', !r.ok && r.code === 'LOCKED', r);
  check('delete: locked by shared counter', post({ action: 'delete', session: S, id: P4.id, resetPassword: RESET_PW }).code === 'LOCKED');
  check('reset: locked by failures made via edit/delete', post({ action: 'reset_data', session: S, resetPassword: RESET_PW }).code === 'LOCKED');
  check('edit/delete lockout does not lock login', post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).ok);
  check('nothing changed while locked', rowOf(P4.id) === p4Before && logRows() === logsBefore0);
  gas.clock.offset += 16 * 60 * 1000;

  // validation exactly like submit — invalid input rejected, nothing changes
  const badEdit = (name, mut, re) => { const b = editBody(); mut(b); const x = post(b); check('edit rejects: ' + name, !x.ok && (!re || re.test(x.error)), x); };
  badEdit('no work types', (b) => { b.work_types = ['bogus']; }, /ลักษณะงาน/);
  badEdit('bad company', (b) => { b.company = 'X'; }, /บริษัท/);
  badEdit('bad permit type', (b) => { b.permit_type = 'x'; }, /ประเภท/);
  badEdit('bad date', (b) => { b.work_date = '7/10/2026'; }, /วันที่/);
  badEdit('bad time', (b) => { b.time_from = '8'; }, /เวลา/);
  badEdit('missing requester name', (b) => { b.requester_name = ' '; }, /ชื่อผู้ขออนุญาต/);
  badEdit('missing phone', (b) => { delete b.requester_phone; }, /เบอร์โทรศัพท์/);
  badEdit('missing location', (b) => { b.location = ''; }, /สถานที่/);
  badEdit('missing job detail', (b) => { b.job_detail = ''; }, /รายละเอียดงาน/);
  badEdit('oversize workers JSON (cell limit)', (b) => { b.workers = Array.from({ length: 200 }, (_, i) => ({ name: 'ก'.repeat(150), role: 'ข'.repeat(150), idno: String(i).repeat(50) })); }, /ขีดจำกัด/);
  check('edit: unknown permit → NOT_FOUND', post(editBody({ id: 999 })).code === 'NOT_FOUND');
  check('edit: invalid input changed nothing', rowOf(P4.id) === p4Before && logRows() === logsBefore0);

  // successful edit
  const fileCols = ['requester_sign_file', 'owner_sign_file', 'attachment_file', 'approver_sign_file'];
  const keepCols = ['id', 'permit_no', 'token', 'status', 'inspections', 'approver_id', 'approver_name', 'approve_comment', 'approved_at', 'closed_at', 'created_at'].concat(fileCols);
  const keepBefore = keepCols.map((k) => col(P4.id, k));
  const filesBefore = gas.files.size;
  r = post(editBody());
  check('edit: ok', r.ok && r.data.changed.length > 5 && r.data.permit.permit_no === P4.permit_no, r);
  const e4 = post({ action: 'permit', no: P4.permit_no, t: P4.token }).data;
  check('edit: old tracking token still works', !!e4);
  const ep = e4 && e4.permit;
  check('edit: allowed fields changed', ep && ep.company === G.WP_DATA.companies[1] && ep.permit_type === 'internal' && ep.work_types.join() === 'general,hot' &&
    ep.work_date === '2026-10-07' && ep.time_from === '22:00' && ep.time_to === '04:00' && ep.requester_name === 'สมชาย (แก้)' &&
    ep.requester_company === 'ผู้รับเหมา ข' && ep.requester_phone === '0822222222' && ep.owner_name === 'วิชัย 2' && ep.owner_phone === '' &&
    ep.job_detail === 'ซ่อมท่อ' && ep.worker_count === 3 && ep.workers.map((w) => w.name).join() === 'ก,ข,ค', ep);
  check('edit: formula-like text round-trips', ep && ep.location === '+SUM(1,2)');
  check('edit: sections sanitized like submit', ep && ep.checklist.h1 === true && !('junk' in ep.checklist) && ep.loto.length === 1 && ep.loto[0].item === 'MDB-2' && ep.confined === null, ep);
  {
    // A company removed from the list stays valid only for edits of permits that already use it.
    const OLD = 'บริษัท แน็ป นิวตริซายส์ จำกัด';
    const tryClean = (keep) => { try { G.cleanRequestFields_(Object.assign(editBody(), { company: OLD }), keep); return true; } catch (e) { return e.message; } };
    check('company no longer offered: allowed when an edit keeps it', tryClean({ company: OLD }) === true, tryClean({ company: OLD }));
    check('company no longer offered: rejected on submit', /บริษัท/.test(String(tryClean(null))));
    check('company no longer offered: rejected when an edit switches to it', /บริษัท/.test(String(tryClean({ company: G.WP_DATA.companies[0] }))));
  }
  check('edit: status / permit_no / token / approvals / signatures / created_at untouched', keepCols.every((k, i) => col(P4.id, k) === keepBefore[i]) && ep.status === 'pending' && !ep.approver_name, keepCols.map((k) => col(P4.id, k)));
  check('edit: expiry recomputed from new date/time (overnight)', ep && ep.end_ts === BKK('2026-10-08T04:00:00') / 1000 && ep.es === 'pending');
  const editLog = e4 && e4.logs[e4.logs.length - 1];
  check('edit: log row "แก้ไขข้อมูล" with admin name and changed fields', editLog && editLog.action === 'edit' && editLog.by_name === 'ผู้ดูแลระบบ จป.' &&
    /^แก้ไขข้อมูล: /.test(editLog.note) && /บริษัท \(พื้นที่\)/.test(editLog.note) && /สถานที่ปฏิบัติงาน/.test(editLog.note) && !/คำนำหน้า/.test(editLog.note) && logRows() === logsBefore0 + 1, editLog);
  check('edit: other permits untouched', rowOf(P2.id) === p2Before);
  check('edit: no Drive files created, signatures still served', gas.files.size === filesBefore && post({ action: 'permit', session: S, id: P4.id, signs: true }).data.signs.requester.startsWith('data:image/png'));
  r = post(editBody());
  check('edit: unchanged data → no changes, no log', r.ok && r.data.changed.length === 0 && logRows() === logsBefore0 + 1, r);
  r = post(editBody({ checklist: { g1: true, h1: true } }));
  check('edit: checklist key order is not a change', r.ok && r.data.changed.length === 0, r);
  r = post(editBody({ checklist: { g1: true, h1: true, h2: false, h3: '', h8: { sel: [], other: '' } }, loto: [{ item: 'MDB-2', t_on: '' }, {}, { item: '' }] }));
  check('edit: blank items / empty LOTO rows (as the form sends them) are not a change', r.ok && r.data.changed.length === 0, r);
  r = post(editBody({ loto: [{ item: 'MDB-2' }, { item: 'MDB-3' }] }));
  check('edit: a real LOTO change is detected', r.ok && r.data.changed.join() === 'loto', r);
  post(editBody());
  r = post(editBody({ work_types: ['confined'], confined: { gas: [{ o2: '20.5' }] } }));
  check('edit: confined section stored', r.ok && post({ action: 'permit', session: S, id: P4.id }).data.permit.confined.gas[0].o2 === '20.5', r);
  const b5 = editBody({ work_types: ['confined'] }); delete b5.confined; delete b5.checklist; delete b5.loto;
  r = post(b5);
  const k5 = post({ action: 'permit', session: S, id: P4.id }).data.permit;
  check('edit: omitted optional sections kept', r.ok && r.data.changed.length === 0 && k5.confined.gas[0].o2 === '20.5' && k5.checklist.h1 === true && k5.loto.length === 1, r);

  // expiry re-check on an approved permit
  check('approve edited permit', post({ action: 'decide', session: S, id: P4.id, decision: 'approve', sign: SIG }).ok);
  const apprCols = ['status', 'approver_name', 'approver_sign_file', 'approved_at', 'inspections'];
  const apprBefore = apprCols.map((k) => col(P4.id, k));
  check('approved + future date → approved', post({ action: 'permit', session: S, id: P4.id }).data.permit.es === 'approved');
  r = post(editBody({ work_types: ['confined'], work_date: '2026-10-05', time_from: '08:00', time_to: '17:00' }));
  const x4 = post({ action: 'permit', session: S, id: P4.id }).data.permit;
  check('edit to a past date → expired immediately; approval kept', r.ok && x4.status === 'approved' && x4.es === 'expired' && x4.end_ts === BKK('2026-10-05T17:00:00') / 1000 &&
    apprCols.every((k, i) => col(P4.id, k) === apprBefore[i]), x4);
  r = post(editBody({ work_types: ['confined'], work_date: '2026-10-06', time_from: '08:00', time_to: '23:00' }));
  check('edit back into the window → approved again', r.ok && post({ action: 'permit', session: S, id: P4.id }).data.permit.es === 'approved', r);

  // delete
  const fileIds = fileCols.map((k) => col(1, k)).filter(Boolean);
  const p4Snap = rowOf(P4.id), p2Snap = rowOf(P2.id);
  check('delete: unknown permit → NOT_FOUND', post({ action: 'delete', session: S, id: 999, resetPassword: RESET_PW }).code === 'NOT_FOUND');
  r = post({ action: 'delete', session: S, id: 1, resetPassword: RESET_PW });
  check('delete with password', r.ok && r.data.permit_no === P1.permit_no, r);
  check('deleted permit row removed', rowOf(1) === null);
  check('deleted permit unreachable by token', post({ action: 'permit', no: P1.permit_no, t: P1.token }).code === 'NOT_FOUND');
  check('deleted permit unreachable by id', post({ action: 'permit', session: S, id: 1 }).code === 'NOT_FOUND');
  check('deleted permit files moved to Drive trash', fileIds.length === 4 && fileIds.every((id) => gas.files.get(id).isTrashed()));
  check('logs of deleted permit removed', lSheet.getDataRange().getValues().slice(1).every((row) => String(row[1]) !== '1'));
  check('other permits intact', post({ action: 'permit', no: P2.permit_no, t: P2.token }).ok && rowOf(P4.id) === p4Snap && rowOf(P2.id) === p2Snap &&
    post({ action: 'permit', session: S, id: P4.id }).data.logs.length > 1);
  check('other permits files not trashed', [col(P2.id, 'requester_sign_file'), col(P4.id, 'requester_sign_file')].every((id) => !gas.files.get(id).isTrashed()));
  check('delete recorded in execution log', gas.logs.some((l) => l.startsWith('LOG WP delete permit ' + P1.permit_no + ' (id 1) by admin')));

  // ================================================================ reset_data
  check('reset: no session → AUTH', post({ action: 'reset_data', resetPassword: RESET_PW }).code === 'AUTH');
  check('reset: token holder (no session) → AUTH', post({ action: 'reset_data', no: P2.permit_no, t: P2.token, resetPassword: RESET_PW }).code === 'AUTH');
  const beforeRows = pSheet.getLastRow();
  gas.stats.sleeps.length = 0;
  r = post({ action: 'reset_data', session: S, resetPassword: 'wrong' });
  check('reset: wrong password refused', !r.ok && r.code === 'AUTH_FAILED' && /ไม่ถูกต้อง/.test(r.error), r);
  check('reset: wrong password sleeps 1s', gas.stats.sleeps[0] === 1000);
  check('reset: missing password refused', post({ action: 'reset_data', session: S }).code === 'AUTH_FAILED');
  check('reset: nothing deleted after failures', pSheet.getLastRow() === beforeRows && beforeRows > 1);
  for (let i = 0; i < 8; i++) post({ action: 'reset_data', session: S, resetPassword: 'bad' + i });
  r = post({ action: 'reset_data', session: S, resetPassword: RESET_PW });
  check('reset: locked after 10 wrong passwords (even with the right one)', !r.ok && r.code === 'LOCKED', r);
  check('reset lockout does not lock login', post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).ok);
  check('reset: still nothing deleted while locked', pSheet.getLastRow() === beforeRows);
  gas.clock.offset += 16 * 60 * 1000;
  // lock P4's tracking number (10 wrong phones) — must not haunt the next permit with the same number
  for (let i = 0; i < 10; i++) post({ action: 'track', permit_no: P4.permit_no, phone: '000' + i });
  check('track locked before reset', post({ action: 'track', permit_no: P4.permit_no, phone: '0812345678' }).code === 'LOCKED');
  const permitCount = pSheet.getLastRow() - 1, logCount = lSheet.getLastRow() - 1;
  const liveFiles = [...gas.files.values()].filter((f) => !f.isTrashed()).length;
  const S2c = post({ action: 'login', username: 'safety2', password: 'new-pass-2' }).data.session;
  r = post({ action: 'reset_data', session: S, resetPassword: RESET_PW });
  check('reset: success', r.ok && r.data.permits_removed === permitCount && r.data.logs_removed === logCount && r.data.files_trashed === liveFiles && permitCount === 3 && liveFiles > 0, { r, permitCount, logCount, liveFiles });
  check('reset: permits sheet only header left', pSheet.getLastRow() === 1 && pSheet.getRange(1, 1, 1, G.WP_SCHEMA.permits.length).getValues()[0].join() === G.WP_SCHEMA.permits.join());
  check('reset: logs sheet only header left', lSheet.getLastRow() === 1 && lSheet.getRange(1, 1, 1, G.WP_SCHEMA.permit_logs.length).getValues()[0].join() === G.WP_SCHEMA.permit_logs.join());
  check('reset: every Drive file in trash (not deleted)', gas.files.size > 0 && [...gas.files.values()].every((f) => f.isTrashed()));
  check('reset recorded in execution log', gas.logs.some((l) => l.startsWith('LOG WP reset_data by admin')));
  check('reset: users kept', ss.getSheetByName('users').getLastRow() === 3 && post({ action: 'users', session: S }).data.users.length === 2);
  check('reset: current session still works', post({ action: 'me', session: S }).ok);
  check('reset: other user session still works', post({ action: 'me', session: S2c }).ok);
  check('reset: login still works', post({ action: 'login', username: 'safety2', password: 'new-pass-2' }).ok);
  r = post({ action: 'dashboard', session: S });
  check('reset: dashboard empty', r.ok && r.data.cnt.pending === 0 && r.data.cnt.closed === 0 && r.data.pending.length === 0 && r.data.days.every((x) => x.count === 0), r);
  check('reset: stats zero', get({ action: 'stats' }).data.total === 0);
  check('reset: permits list empty', post({ action: 'permits', session: S }).data.rows.length === 0);
  check('reset: old token no longer tracks', post({ action: 'permit', no: P2.permit_no, t: P2.token }).code === 'NOT_FOUND' && post({ action: 'permit', no: P4.permit_no, t: P4.token }).code === 'NOT_FOUND');
  check('reset: old attachment unreachable', post({ action: 'file', no: P2.permit_no, t: P2.token }).code === 'NOT_FOUND');
  check('reset: second reset (nothing left) is fine', (() => { const x = post({ action: 'reset_data', session: S, resetPassword: RESET_PW }); return x.ok && x.data.permits_removed === 0 && x.data.files_trashed === 0; })());
  r = post(base());
  check('after reset: first number of the day again, id 1', r.ok && r.data.permit_no === P4.permit_no && r.data.permit_no === 'WP-20261006-001' && r.data.id === 1, r);
  const P5 = r.data;
  check('after reset: old token of the reused number fails', post({ action: 'permit', no: P5.permit_no, t: P4.token }).code === 'NOT_FOUND');
  r = post({ action: 'permit', no: P5.permit_no, t: P5.token, signs: true });
  check('after reset: new permit readable with one log + files', r.ok && r.data.logs.length === 1 && r.data.signs.requester.startsWith('data:image/png') && pSheet.getLastRow() === 2 && lSheet.getLastRow() === 2, r);
  check('after reset: tracking lockout of reused number cleared', post({ action: 'track', permit_no: P5.permit_no, phone: '0812345678' }).ok);
  check('after reset: second submit 002', post(Object.assign(base(), { attachment: null })).data.permit_no === 'WP-20261006-002');

  // ================================================================ speed: batch / read cache / data version
  setNow('2026-10-06T10:00:00');
  S = post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).data.session;
  const dvNow = () => (gas.cacheStore.get('wpdv') || {}).v;
  const clearReadCache = () => { [...gas.cacheStore.keys()].forEach((k) => { if (k.startsWith('wpc_')) gas.cacheStore.delete(k); }); };
  const readsOf = (fn) => {
    const before = Object.assign({}, gas.stats.sheetReads);
    const out = fn();
    const d = {};
    Object.keys(gas.stats.sheetReads).forEach((k) => { const n = gas.stats.sheetReads[k] - (before[k] || 0); if (n) d[k] = n; });
    return { out, reads: d };
  };
  const READS = () => [
    ['stats', () => get({ action: 'stats' })],
    ['dashboard', () => post({ action: 'dashboard', session: S })],
    ['permits', () => post({ action: 'permits', session: S })],
    ['permits pending', () => post({ action: 'permits', session: S, status: 'pending' })],
    ['permits expired', () => post({ action: 'permits', session: S, status: 'expired' })],
    ['permits q', () => post({ action: 'permits', session: S, q: 'ห้อง' })],
    ['poll', () => post({ action: 'poll', session: S })],
    ['poll since 0', () => post({ action: 'poll', session: S, since: 0 })],
    ['users', () => post({ action: 'users', session: S })]
  ];
  const warm = () => READS().forEach(([, fn]) => fn());
  // Every read (served from cache when possible) must equal a freshly computed one.
  const consistent = (label) => {
    const now = READS().map(([, fn]) => JSON.stringify(fn()));
    clearReadCache();
    const fresh = READS().map(([, fn]) => JSON.stringify(fn()));
    READS().forEach(([n], i) => check(`cache consistent after ${label}: ${n}`, now[i] === fresh[i] && JSON.parse(fresh[i]).ok, { now: now[i], fresh: fresh[i] }));
  };
  const write = (label, fn, expectOk = true) => {
    warm();
    const dv = dvNow();
    const x = fn();
    if (expectOk) check(label + ' ok', x.ok, x);
    check('data version replaced by ' + label, dvNow() && dvNow() !== dv);
    consistent(label);
    return x;
  };

  // read cache is really used: a repeated dashboard / permits / poll / stats reads no permit data
  clearReadCache();
  post({ action: 'dashboard', session: S });
  check('cached dashboard: only the users sheet is read (session check)', JSON.stringify(readsOf(() => post({ action: 'dashboard', session: S })).reads) === '{"users":1}');
  post({ action: 'permits', session: S });
  check('cached permits list: only users read', JSON.stringify(readsOf(() => post({ action: 'permits', session: S })).reads) === '{"users":1}');
  post({ action: 'poll', session: S, since: 2 });
  check('cached poll: only users read', JSON.stringify(readsOf(() => post({ action: 'poll', session: S, since: 2 })).reads) === '{"users":1}');
  get({ action: 'stats' });
  check('cached stats: no sheet read', JSON.stringify(readsOf(() => get({ action: 'stats' })).reads) === '{}');
  check('cached poll still refuses a bogus session', post({ action: 'poll', session: '0'.repeat(64), since: 2 }).code === 'AUTH');
  check('cached dashboard still refuses anonymous', post({ action: 'dashboard' }).code === 'AUTH');

  // submit (+ with_permit → status page data in the same round-trip)
  r = write('submit', () => post(Object.assign(base(), {
    attachment: null, work_types: ['hot', 'general'], work_date: '2026-10-06', time_from: '09:00', time_to: '11:00',
    requester_name: "'อัญประกาศ", location: '=1+1 ห้อง', with_permit: true
  })));
  const P6 = r.data;
  const v6 = post({ action: 'permit', no: P6.permit_no, t: P6.token }).data;
  check('submit with_permit: view === permit(no, t)', JSON.stringify(P6.view) === JSON.stringify(v6), { view: P6.view, permit: v6 });
  check('submit without with_permit: same output as before (no view)', !('view' in post(Object.assign(base(), { attachment: null })).data));
  r = post({ action: 'track', permit_no: P6.permit_no, phone: '0812345678', with_permit: true });
  check('track with_permit: view === permit(no, t)', r.ok && r.data.token === P6.token && JSON.stringify(r.data.view) === JSON.stringify(v6), r);
  r = post({ action: 'track', permit_no: P6.permit_no, phone: '0812345678' });
  check('track without with_permit: unchanged output', r.ok && Object.keys(r.data).join() === 'permit_no,token', r);
  check('track with_permit wrong phone → NOT_FOUND', post({ action: 'track', permit_no: P6.permit_no, phone: '000', with_permit: true }).code === 'NOT_FOUND');

  // save_review / approve
  write('save_review', () => post({ action: 'save_review', session: S, id: P6.id, log: true, checklist: { h1: true }, inspections: { owner: { before: { name: 'ก' } } } }));
  write('decide approve', () => post({ action: 'decide', session: S, id: P6.id, decision: 'approve', sign: SIG }));
  check('approved permit in dashboard activeNow', post({ action: 'dashboard', session: S }).data.activeNow.some((x) => x.id === P6.id));

  // the clock alone (no write) turns a cached "approved" into "expired"
  warm();
  setNow('2026-10-06T11:01:00');
  const d11 = post({ action: 'dashboard', session: S }).data;
  check('cached dashboard follows expiry by the clock', !d11.activeNow.some((x) => x.id === P6.id) && post({ action: 'permits', session: S, status: 'expired' }).data.rows.some((x) => x.id === P6.id), d11);
  consistent('expiry time passed');

  write('decide reject', () => post({ action: 'decide', session: S, id: 2, decision: 'reject', comment: 'ไม่ครบ' }));
  write('decide close', () => post({ action: 'decide', session: S, id: P6.id, decision: 'close' }));
  write('failed write (unknown permit)', () => post({ action: 'decide', session: S, id: 999, decision: 'close' }), false);
  write('update_permit', () => post(editBody({ id: P6.id, location: 'ห้องใหม่' })));
  check('update_permit visible in cached list', post({ action: 'permits', session: S, q: 'ห้องใหม่' }).data.rows.length === 1);
  write('user_save', () => post({ action: 'user_save', session: S, id: 1, fullname: 'ผู้ดูแลระบบ จป. (ใหม่)', position: 'จป.', password: '' }));
  check('user_save visible in dashboard', post({ action: 'dashboard', session: S }).data.user.fullname === 'ผู้ดูแลระบบ จป. (ใหม่)');
  write('user_toggle off', () => post({ action: 'user_toggle', session: S, id: 2 }));
  write('user_toggle on', () => post({ action: 'user_toggle', session: S, id: 2 }));
  write('delete', () => post({ action: 'delete', session: S, id: P6.id, resetPassword: RESET_PW }));
  check('deleted permit gone from cached list', !post({ action: 'permits', session: S }).data.rows.some((x) => x.id === P6.id));

  // ---- batch: same output as single calls, one read per sheet
  const P7 = post(Object.assign(base(), { attachment: null, work_date: '2026-10-06' })).data;
  const calls = [{ action: 'me' }, { action: 'poll' }, { action: 'poll', since: 1 }, { action: 'dashboard' }, { action: 'permits', status: 'pending', q: 'ห้อง' },
    { action: 'users' }, { action: 'permit', id: P7.id, signs: true }, { action: 'stats' }];
  const singles = calls.map((c) => post(Object.assign({ session: S }, c)));
  clearReadCache();
  const b1 = readsOf(() => post({ action: 'batch', session: S, calls }));
  check('batch ok with one result per call', b1.out.ok && b1.out.data.length === calls.length, b1.out);
  check('batch results === single calls', b1.out.ok && b1.out.data.every((x, i) => JSON.stringify(x) === JSON.stringify(singles[i])), { batch: b1.out.data, singles });
  check('batch reads each sheet once', JSON.stringify(b1.reads) === '{"users":1,"permits":1,"permit_logs":1}', b1.reads);
  r = post({ action: 'batch', calls: [{ action: 'me' }, { action: 'dashboard' }, { action: 'stats' }] });
  check('batch without session: admin sub-calls AUTH, public ok', r.ok && r.data[0].code === 'AUTH' && r.data[1].code === 'AUTH' && r.data[2].ok, r);
  r = post({ action: 'batch', calls: [{ action: 'me', session: S }, { action: 'permits', session: S }] });
  check('batch sub-call cannot carry its own session', r.data.every((x) => x.code === 'AUTH'), r);
  r = post({ action: 'batch', session: '0'.repeat(64), calls: [{ action: 'poll' }] });
  check('batch with bogus session → AUTH', r.data[0].code === 'AUTH', r);
  const before7 = rowOf(P7.id), logs7 = logRows(), files7 = gas.files.size;
  r = post({
    action: 'batch', session: S, calls: [
      { action: 'decide', id: P7.id, decision: 'approve', sign: SIG }, { action: 'save_review', id: P7.id }, { action: 'delete', id: P7.id, resetPassword: RESET_PW },
      { action: 'update_permit', id: P7.id, resetPassword: RESET_PW }, { action: 'submit' }, { action: 'login', username: 'admin', password: 'Brand-New-1' },
      { action: 'file', id: P7.id }, { action: 'batch', calls: [{ action: 'me' }] }]
  });
  check('batch refuses writes / login / file / nested batch', r.ok && r.data.every((x) => !x.ok && x.code === 'NOT_FOUND'), r);
  check('refused batch changed nothing', rowOf(P7.id) === before7 && logRows() === logs7 && gas.files.size === files7);
  r = post({ action: 'batch', session: S, calls: [{ action: 'reset_data', resetPassword: RESET_PW }, { action: 'user_toggle', id: 2 }, { action: 'user_save', id: 1, fullname: 'x' }, { action: 'track', permit_no: P7.permit_no, phone: '0812345678' }] });
  check('batch refuses reset / user changes / track', r.data.every((x) => x.code === 'NOT_FOUND') && post({ action: 'permits', session: S }).data.rows.length > 0, r);
  check('batch: empty / too many calls refused', post({ action: 'batch', session: S, calls: [] }).code === 'BAD_REQUEST' && post({ action: 'batch', session: S, calls: Array(9).fill({ action: 'me' }) }).code === 'BAD_REQUEST' && post({ action: 'batch', session: S }).code === 'BAD_REQUEST');
  check('batch via GET refused', !get({ action: 'batch', calls: '[]' }).ok);
  r = post({ action: 'batch', calls: [{ action: 'permit', no: P7.permit_no, t: P7.token }, { action: 'permit', no: P7.permit_no, t: P6.token }, { action: 'permit', id: P7.id }] });
  check('batch token permit: own permit only, by id needs session', r.data[0].ok && r.data[0].data.permit.id === P7.id && r.data[1].code === 'NOT_FOUND' && r.data[2].code === 'AUTH', r);

  // ---- a requester token never sees cached admin data
  warm();
  const tokens = [P5, P6, P7].map((x) => x.token);
  const cachedVals = [...gas.cacheStore.entries()].filter(([k]) => k.startsWith('wpc_')).map(([, e]) => e.v).join('\n');
  check('read cache holds no tracking tokens, signatures, files or password data', cachedVals.length > 0 && !tokens.some((t) => cachedVals.includes(t)) &&
    !/data:image|base64|password_hash|"salt"/.test(cachedVals));
  // poison every cached value: token reads must be unaffected (they never consult the cache)
  [...gas.cacheStore.keys()].filter((k) => k.startsWith('wpc_') && !/\.\d+$/.test(k)).forEach((k) => {
    gas.cacheStore.get(k).v = '1';
    gas.cacheStore.set(k + '.0', { v: JSON.stringify({ u: 9e12, d: 'POISON' }), exp: gas.clock.now() + 60000 });
  });
  check('poisoned cache is what cached reads return (sanity)', get({ action: 'stats' }).data === 'POISON');
  r = post({ action: 'permit', no: P7.permit_no, t: P7.token, signs: true });
  check('token permit read ignores the cache', r.ok && r.data.permit.id === P7.id && !JSON.stringify(r.data).includes('POISON'), r);
  r = post({ action: 'track', permit_no: P7.permit_no, phone: '0812345678', with_permit: true });
  check('track ignores the cache', r.ok && r.data.view.permit.id === P7.id && !JSON.stringify(r.data).includes('POISON'), r);
  check('token file read ignores the cache', post({ action: 'file', no: P7.permit_no, t: P7.token }).code === 'NOT_FOUND');
  check('admin permit by id ignores the cache', post({ action: 'permit', session: S, id: P7.id }).data.permit.permit_no === P7.permit_no);
  check('poisoned cache still needs a session', post({ action: 'dashboard' }).code === 'AUTH' && post({ action: 'permits', no: P7.permit_no, t: P7.token }).code === 'AUTH');
  clearReadCache();

  // ---- writes keep the pre-lock users sheet only if nothing was written meanwhile
  const usersSheet = ss.getSheetByName('users');
  const uhdr = usersSheet.getRange(1, 1, 1, G.WP_SCHEMA.users.length).getValues()[0];
  const setActive = (uid, v) => usersSheet.getRange(1 + uid, uhdr.indexOf('active') + 1).setValues([[v]]);
  const S2d = post({ action: 'login', username: 'safety2', password: 'new-pass-2' }).data.session;
  r = readsOf(() => post({ action: 'save_review', session: S2d, id: P7.id, checklist: {} }));
  check('write reads each sheet once (users kept across the lock)', r.out.ok && JSON.stringify(r.reads) === '{"users":1,"permits":1}', r);
  const lk = G.LockService.getScriptLock(), origTry = lk.tryLock;
  lk.tryLock = function () { // another request disables safety2 while this one waits for the lock
    lk.tryLock = origTry;
    gas.stats.unlockedWrites--; // simulated concurrent write (it held its own lock)
    setActive(2, '0');
    G.bumpDataVersion_();
    return origTry.apply(this, arguments);
  };
  const before7b = rowOf(P7.id);
  r = post({ action: 'save_review', session: S2d, id: P7.id, checklist: { h1: true } });
  check('session re-checked against fresh users after a concurrent write', r.code === 'AUTH' && rowOf(P7.id) === before7b, r);
  gas.stats.unlockedWrites--;
  setActive(2, '1');
  G.bumpDataVersion_();

  // ---- reset + "today" rolls over at midnight without any write
  write('reset_data', () => post({ action: 'reset_data', session: S, resetPassword: RESET_PW }));
  write('submit after reset', () => post(Object.assign(base(), { attachment: null, work_date: '2026-10-06' })));
  warm();
  check('stats today counted', get({ action: 'stats' }).data.today === 1);
  setNow('2026-10-07T00:00:30');
  S = post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).data.session;
  check('cached stats roll over at Bangkok midnight', get({ action: 'stats' }).data.today === 0 && get({ action: 'stats' }).data.total === 1);
  check('cached dashboard days roll over at midnight', post({ action: 'dashboard', session: S }).data.days[13].date === '2026-10-07');
  consistent('midnight');

  // ---- big values are chunked under the 100 KB CacheService limit
  const bigV = 'ก'.repeat(70000);
  G.cachePutBig_('wpc_test_big', bigV, 60);
  check('big cache value stored in chunks and read back', G.cacheGetBig_('wpc_test_big') === bigV && gas.cacheStore.has('wpc_test_big.2'));
  gas.cacheStore.delete('wpc_test_big.1');
  check('missing chunk → miss', G.cacheGetBig_('wpc_test_big') === null);
  G.cachePutBig_('wpc_test_huge', 'x'.repeat(30000 * 21), 60);
  check('value over the chunk budget is not cached', G.cacheGetBig_('wpc_test_huge') === null);

  // ================================================================ bug fixes (review / concurrency / submit)
  S = post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).data.session;
  const permitOf = (id) => post({ action: 'permit', session: S, id }).data.permit;

  // -- double submit: a retried submit with the same rid gets the same permit, nothing duplicated
  const RID = 'ab'.repeat(16);
  const subBody = () => Object.assign(base(), { work_date: '2026-10-07', rid: RID, with_permit: true });
  const rowsBefore = pSheet.getLastRow(), logsBeforeRid = logRows(), filesBeforeRid = gas.files.size;
  const first = post(subBody());
  check('rid submit ok', first.ok, first);
  const filesAfterFirst = gas.files.size;
  const again = post(subBody());
  check('rid: retried submit returns the same permit', again.ok && again.data.permit_no === first.data.permit_no && again.data.token === first.data.token && again.data.id === first.data.id, again);
  check('rid: no second row / log / Drive file', pSheet.getLastRow() === rowsBefore + 1 && logRows() === logsBeforeRid + 1 && gas.files.size === filesAfterFirst && filesAfterFirst === filesBeforeRid + 3);
  check('rid: replayed view === permit(no, t)', JSON.stringify(again.data.view) === JSON.stringify(post({ action: 'permit', no: first.data.permit_no, t: first.data.token }).data));
  check('rid: cache holds no token', !String((gas.cacheStore.get('wpsub_' + RID) || {}).v).includes(first.data.token));
  const noRid = [post(Object.assign(base(), { attachment: null })), post(Object.assign(base(), { attachment: null }))];
  check('without rid: two submits are two permits (unchanged)', noRid[0].data.permit_no !== noRid[1].data.permit_no);
  check('malformed rid is ignored', post(Object.assign(base(), { attachment: null, rid: 'x' })).data.permit_no !== post(Object.assign(base(), { attachment: null, rid: 'x' })).data.permit_no);
  // the identical try finishes while this one is uploading its files (both pass the pre-check)
  const RID2 = 'cd'.repeat(16);
  const lk2 = G.LockService.getScriptLock(), origTry2 = lk2.tryLock;
  let inner = null;
  lk2.tryLock = function () { lk2.tryLock = origTry2; inner = post(Object.assign(base(), { rid: RID2 })); return origTry2.apply(this, arguments); };
  const rowsB2 = pSheet.getLastRow(), liveB2 = [...gas.files.values()].filter((f) => !f.isTrashed()).length;
  const outer = post(Object.assign(base(), { rid: RID2 }));
  check('rid race: both answers name the same permit', inner && inner.ok && outer.ok && inner.data.permit_no === outer.data.permit_no, { inner, outer });
  check('rid race: one row, the loser\'s uploads trashed', pSheet.getLastRow() === rowsB2 + 1 && [...gas.files.values()].filter((f) => !f.isTrashed()).length === liveB2 + 3);
  check('rid: deleted permit is not replayed', post({ action: 'delete', session: S, id: first.data.id, resetPassword: RESET_PW }).ok &&
    post(subBody()).data.token !== first.data.token);

  // -- save_review on a permit another admin rejected / closed meanwhile is refused (nothing written)
  const R1 = post(Object.assign(base(), { attachment: null })).data;
  post({ action: 'decide', session: S, id: R1.id, decision: 'reject', comment: 'ไม่ครบ' });
  const r1Row = rowOf(R1.id), r1Logs = logRows();
  r = post({ action: 'save_review', session: S, id: R1.id, checklist: { h1: true }, inspections: { owner: { before: { name: 'x' } } } });
  check('save_review on rejected permit refused', !r.ok && r.code === 'CONFLICT' && /ไม่อนุมัติ/.test(r.error) && rowOf(R1.id) === r1Row && logRows() === r1Logs, r);

  // -- optimistic concurrency (base = updated_at as loaded)
  const C1 = post(Object.assign(base(), { attachment: null })).data;
  const loadedA = permitOf(C1.id).updated_at;
  check('permit carries updated_at', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(loadedA), loadedA);
  gas.clock.offset += 2000;
  r = post({ action: 'save_review', session: S, id: C1.id, base: loadedA, checklist: { h1: true }, inspections: { owner: { before: { name: 'จป. B' } } } });
  check('save_review with current base ok, returns new updated_at', r.ok && r.data.updated_at && r.data.updated_at !== loadedA, r);
  const afterB = rowOf(C1.id);
  gas.clock.offset += 2000;
  r = post({ action: 'save_review', session: S, id: C1.id, base: loadedA, checklist: {}, inspections: {} });
  check('stale save_review refused, other admin\'s review kept', !r.ok && r.code === 'CONFLICT' && rowOf(C1.id) === afterB && permitOf(C1.id).inspections.owner.before.name === 'จป. B', r);
  r = post(editBody({ id: C1.id, base: loadedA, location: 'ใหม่' }));
  check('stale update_permit refused', !r.ok && r.code === 'CONFLICT' && rowOf(C1.id) === afterB, r);
  r = post(editBody({ id: C1.id, base: permitOf(C1.id).updated_at, location: 'ใหม่' }));
  check('update_permit with current base ok', r.ok && r.data.changed.indexOf('location') >= 0 && r.data.permit.updated_at, r);
  check('no base: last write wins as before', post({ action: 'save_review', session: S, id: C1.id, checklist: {}, inspections: {} }).ok);

  // -- the approval stamp cannot be written / erased through save_review
  post({ action: 'save_review', session: S, id: C1.id, inspections: { safety: { permit: { name: 'ปลอม' } } } });
  check('save_review cannot stamp safety.permit on a pending permit', !(permitOf(C1.id).inspections.safety || {}).permit);
  post({ action: 'decide', session: S, id: C1.id, decision: 'approve', sign: SIG });
  const stamp1 = permitOf(C1.id).inspections.safety.permit;
  post({ action: 'save_review', session: S, id: C1.id, inspections: { safety: { permit: { name: '' } } } });
  check('save_review keeps the approver stamp', JSON.stringify(permitOf(C1.id).inspections.safety.permit) === JSON.stringify(stamp1) && stamp1.name === 'ผู้ดูแลระบบ จป. (ใหม่)', stamp1);

  // -- attachment: the extension of a long file name is checked before the name is shortened
  const longName = 'ก'.repeat(300) + '.pdf';
  r = post(Object.assign(base(), { attachment: { name: longName, base64: PDF_B64 } }));
  const ln = r.ok && post({ action: 'file', no: r.data.permit_no, t: r.data.token }).data;
  check('long attachment name accepted (stored ≤ 255 chars)', r.ok && ln && ln.mimeType === 'application/pdf' && Array.from(ln.name).length === 255, r);

  // ================================================================ keep-warm
  check('keepWarm: install', G.installKeepWarmTrigger().installed === 1 && gas.triggers.length === 1 && gas.triggers[0].getHandlerFunction() === 'keepWarm' && gas.triggers[0].minutes === 10);
  const kw2 = G.installKeepWarmTrigger();
  check('keepWarm: install is idempotent', kw2.removed === 1 && gas.triggers.length === 1 && kw2.warm.ok, kw2);
  gas.triggers.push({ getHandlerFunction: () => 'otherJob' });
  check('keepWarm: remove leaves other triggers', G.removeKeepWarmTrigger() === 1 && gas.triggers.length === 1 && gas.triggers[0].getHandlerFunction() === 'otherJob');
  gas.triggers.length = 0;
  clearReadCache();
  const dvKw = dvNow(), writesKw = gas.stats.writes, rowsKw = pSheet.getLastRow();
  const kw = readsOf(() => G.keepWarm());
  check('keepWarm: ok, reads only the permits sheet once', kw.out.ok && JSON.stringify(kw.reads) === '{"permits":1}', kw);
  check('keepWarm: no sheet write, data version unchanged', gas.stats.writes === writesKw && pSheet.getLastRow() === rowsKw && dvNow() === dvKw);
  check('keepWarm: dashboard served from cache (only the session check reads)', JSON.stringify(readsOf(() => post({ action: 'dashboard', session: S })).reads) === '{"users":1}');
  check('keepWarm: default + pending lists and stats served from cache', JSON.stringify(readsOf(() => {
    post({ action: 'permits', session: S }); post({ action: 'permits', session: S, status: 'pending' }); get({ action: 'stats' });
    const mx = post({ action: 'poll', session: S }).data.max_id; post({ action: 'poll', session: S, since: mx });
  }).reads) === '{"users":4}');
  const kwVals = [...gas.cacheStore.entries()].filter(([k]) => k.startsWith('wpc_')).map(([, e]) => e.v).join('\n');
  check('keepWarm: cache holds no tokens / signatures / password data', kwVals.length > 0 && !/data:image|base64|password_hash|"salt"|"token"/.test(kwVals));
  gas.clock.offset += 400 * 1000; // past the normal 300 s TTL, before the next 10 min run
  S = post({ action: 'login', username: 'admin', password: 'Brand-New-1' }).data.session;
  check('keepWarm: values stay hot until the next run', JSON.stringify(readsOf(() => post({ action: 'dashboard', session: S })).reads) === '{"users":1}');
  write('submit after keepWarm', () => post(Object.assign(base(), { attachment: null })));
  check('keepWarm: a write still invalidates warmed values', post({ action: 'permits', session: S }).data.rows.length === pSheet.getLastRow() - 1);
  const ssProp = gas.propStore.WP_SPREADSHEET_ID;
  delete gas.propStore.WP_SPREADSHEET_ID;
  check('keepWarm before setup: skipped quietly', G.keepWarm().ok === false);
  gas.propStore.WP_SPREADSHEET_ID = ssProp;

  // ================================================================ Microsoft Teams notifications
  {
    check('teams: no webhook call while TEAMS_WEBHOOK_URL is unset (whole suite so far)', gas.fetches.length === 0, gas.fetches.length);
    const HOOK = 'https://prod-00.example.logic.azure.com/workflows/abc123/triggers/manual/paths/invoke?sig=SECRET-SIG-xyz';
    const raws = [];
    const postT = (b) => { const raw = G.doPost({ postData: { contents: JSON.stringify(b) } }).getContent(); raws.push(raw); return JSON.parse(raw); };
    const sent = () => gas.fetches.length;
    const lastCard = () => JSON.parse(gas.fetches[gas.fetches.length - 1].params.payload);
    const body = (msg) => msg.attachments[0].content.body;
    const factsOf = (msg) => {
      const fs_ = body(msg).find((b) => b.type === 'FactSet');
      const o = {}; (fs_ ? fs_.facts : []).forEach((f) => { o[f.title] = f.value; }); return o;
    };
    const header = (msg) => body(msg)[0].items[0];
    const cardOk = (msg) => msg.type === 'message' && msg.attachments.length === 1 &&
      msg.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive' && msg.attachments[0].contentUrl === null &&
      msg.attachments[0].content.type === 'AdaptiveCard' && msg.attachments[0].content.version === '1.4' &&
      msg.attachments[0].content.$schema === 'http://adaptivecards.io/schemas/adaptive-card.json' && Array.isArray(msg.attachments[0].content.actions);
    const li = post({ action: 'login', username: 'admin', password: 'Brand-New-1' });
    const ST = li.data.session, ME = li.data.user.fullname;

    // property present but empty / whitespace → still nothing
    gas.propStore.TEAMS_WEBHOOK_URL = '   ';
    const e0 = postT(Object.assign(base(), { attachment: null }));
    check('teams: empty TEAMS_WEBHOOK_URL → submit ok, no call', e0.ok && sent() === 0);
    gas.propStore.TEAMS_WEBHOOK_URL = HOOK;
    gas.fetchMode.code = 202; gas.fetchMode.throws = null;

    // -- new permit
    const RIDT = 'ef'.repeat(16);
    const subT = () => Object.assign(base(), { rid: RIDT, work_types: ['hot', 'height'], worker_count: 99 });
    const n0 = sent();
    const T1 = postT(subT());
    check('teams submit: ok + exactly one call', T1.ok && sent() === n0 + 1, T1);
    const f0 = gas.fetches[gas.fetches.length - 1];
    check('teams submit: POST JSON to the webhook, muteHttpExceptions', f0.url === HOOK && f0.params.method === 'post' &&
      f0.params.contentType === 'application/json' && f0.params.muteHttpExceptions === true && typeof f0.params.payload === 'string', f0.params);
    const c1 = lastCard(), F1 = factsOf(c1);
    check('teams submit: Adaptive Card 1.4 message structure', cardOk(c1), c1);
    check('teams submit: Good headline "มีคำขอใบอนุญาตใหม่ รอพิจารณา"', header(c1).text === 'มีคำขอใบอนุญาตใหม่ รอพิจารณา' && header(c1).color === 'Good' && header(c1).size === 'Large', header(c1));
    check('teams submit: facts (no, company, type, work types, date+time, requester, company, phone, workers, area, owner)',
      F1['เลขที่'] === T1.data.permit_no && F1['บริษัท (พื้นที่)'] === G.WP_DATA.companies[0] && F1['ประเภท'] === 'งานผู้รับเหมา' &&
      F1['ลักษณะงาน'] === G.WP_DATA.workTypes.hot.label + ', ' + G.WP_DATA.workTypes.height.label &&
      F1['วันที่ปฏิบัติงาน'] === '5 ต.ค. 2569 เวลา 08:00–17:00 น.' && F1['ผู้ขออนุญาต'] === 'นาย สมชาย ใจดี' &&
      F1['บริษัท/หน่วยงานผู้ขอ'] === 'ผู้รับเหมา ก' && F1['เบอร์โทรผู้ขอ'] === '081-234-5678' && F1['จำนวนผู้ปฏิบัติงาน'] === '99 คน' &&
      F1['สถานที่ปฏิบัติงาน'] === '=HYPERLINK("http://evil")' && F1['ผู้รับผิดชอบงาน'] === 'วิชัย · โทร 0899999999', F1);
    const a1 = c1.attachments[0].content.actions;
    check('teams submit: one "เปิดพิจารณา" button → admin view (default site)', a1.length === 1 && a1[0].type === 'Action.OpenUrl' && a1[0].title === 'เปิดพิจารณา' &&
      a1[0].url === 'https://watanathep8-dotcom.github.io/work-permit-thepwatana/admin/view.html?id=' + T1.data.id, a1);
    check('teams submit: Bangkok time footer', /^เวลา \d{1,2} \S+ 25\d\d \d\d:\d\d น\. \(เวลาประเทศไทย\)$/.test(body(c1)[body(c1).length - 1].text), body(c1));

    // -- idempotent retry (cache replay before the lock) and race (replay inside the lock) send nothing
    const T1b = postT(subT());
    check('teams: retried submit (same rid) → same permit, no second card', T1b.ok && T1b.data.permit_no === T1.data.permit_no && sent() === n0 + 1);
    const RIDT2 = '12'.repeat(16);
    const lk = G.LockService.getScriptLock(), origTry = lk.tryLock;
    let innerT = null;
    lk.tryLock = function () { lk.tryLock = origTry; innerT = postT(Object.assign(base(), { rid: RIDT2 })); return origTry.apply(this, arguments); };
    const outerT = postT(Object.assign(base(), { rid: RIDT2 }));
    check('teams: rid race → one permit, exactly one card', innerT.ok && outerT.ok && innerT.data.permit_no === outerT.data.permit_no && sent() === n0 + 2, { innerT, outerT, sent: sent() });

    // -- sent after the lock was released
    let lockedAtFetch = null;
    const origFetch = G.UrlFetchApp.fetch;
    G.UrlFetchApp.fetch = function () { lockedAtFetch = gas.isLocked(); return origFetch.apply(this, arguments); };
    const T2 = postT(Object.assign(base(), { attachment: null }));
    G.UrlFetchApp.fetch = origFetch;
    check('teams: card sent after the lock is released', T2.ok && lockedAtFetch === false, lockedAtFetch);

    // -- WP_SITE_URL overrides the site base
    gas.propStore.WP_SITE_URL = 'https://intranet.example.com/wp/';
    const T3 = postT(Object.assign(base(), { attachment: null }));
    check('teams: WP_SITE_URL overrides the button base', lastCard().attachments[0].content.actions[0].url === 'https://intranet.example.com/wp/admin/view.html?id=' + T3.data.id);
    delete gas.propStore.WP_SITE_URL;

    // -- decisions
    let n = sent();
    let r1 = postT({ action: 'decide', session: ST, id: T1.data.id, decision: 'approve', comment: 'ต้องมี Fire Watch', sign: SIG });
    let c = lastCard();
    check('teams approve: one Good card with decision + admin + note', r1.ok && sent() === n + 1 && cardOk(c) && header(c).color === 'Good' &&
      header(c).text === 'อนุมัติใบอนุญาตแล้ว ' + T1.data.permit_no && factsOf(c)['ผลการพิจารณา'] === 'อนุมัติให้ปฏิบัติงาน' &&
      factsOf(c)['โดย'] === ME && factsOf(c)['บริษัท (พื้นที่)'] === G.WP_DATA.companies[0] &&
      JSON.stringify(body(c)).includes('ต้องมี Fire Watch') && c.attachments[0].content.actions[0].url.endsWith('/admin/view.html?id=' + T1.data.id), c);
    check('teams approve: no signature / data URL in the card', !/data:image|base64/.test(gas.fetches[gas.fetches.length - 1].params.payload));
    n = sent();
    r1 = postT({ action: 'decide', session: ST, id: T1.data.id, decision: 'close' });
    c = lastCard();
    check('teams close: one card', r1.ok && sent() === n + 1 && factsOf(c)['ผลการพิจารณา'] === 'ปิดงาน' && header(c).color === 'Good', c);
    n = sent();
    r1 = postT({ action: 'decide', session: ST, id: T2.data.id, decision: 'reject', comment: 'เอกสาร\nไม่ครบ' });
    c = lastCard();
    check('teams reject: one Attention card with the reason', r1.ok && sent() === n + 1 && header(c).color === 'Attention' &&
      factsOf(c)['ผลการพิจารณา'] === 'ไม่อนุมัติ' && body(c).some((b) => b.text === 'เหตุผลที่ไม่อนุมัติ') && body(c).some((b) => b.text === 'เอกสาร\nไม่ครบ'), c);
    n = sent();
    check('teams: refused decision sends nothing', !postT({ action: 'decide', session: ST, id: T2.data.id, decision: 'approve', sign: SIG }).ok && sent() === n);
    check('teams: failed admin auth sends nothing', !postT({ action: 'decide', id: T3.data.id, decision: 'reject', comment: 'x' }).ok && sent() === n);
    check('teams: save_review / update sends nothing', postT({ action: 'save_review', session: ST, id: T3.data.id, checklist: {} }).ok && sent() === n);

    // -- long texts are limited
    const longR = postT({ action: 'decide', session: ST, id: T3.data.id, decision: 'reject', comment: 'ย'.repeat(1990) });
    c = lastCard();
    const longest = Math.max(...body(c).filter((b) => b.text).map((b) => b.text.length));
    check('teams: long reason truncated (≤ 1000 chars), facts ≤ 300', longR.ok && longest <= 1000 && Object.values(factsOf(c)).every((v) => v.length <= 300), longest);

    // -- delete
    n = sent();
    const T4 = postT(Object.assign(base(), {})).data; // with attachment: 3 files
    n = sent();
    let rd = postT({ action: 'delete', session: ST, id: T4.id, resetPassword: RESET_PW });
    c = lastCard();
    check('teams delete: one Attention card: what + by whom', rd.ok && sent() === n + 1 && header(c).color === 'Attention' &&
      header(c).text === 'ลบใบอนุญาต ' + T4.permit_no && factsOf(c)['ลบโดย'] === ME &&
      factsOf(c)['สิ่งที่ถูกลบ'] === 'ใบอนุญาต 1 ใบ, ประวัติ 1 รายการ, ไฟล์ 3 ไฟล์ (ย้ายไปถังขยะ Drive)' && factsOf(c)['สถานะก่อนลบ'] === 'รออนุมัติ' &&
      c.attachments[0].content.actions.length === 0, c);
    n = sent();
    check('teams: wrong reset password → no card', !postT({ action: 'delete', session: ST, id: T3.data.id, resetPassword: 'nope' }).ok && sent() === n);

    // -- failures never change the answer or the data
    gas.fetchMode.code = 500;
    gas.logs.length = 0;
    const T5 = postT(Object.assign(base(), { attachment: null }));
    check('teams: HTTP 500 → submit still ok, permit stored', T5.ok && /^WP-/.test(T5.data.permit_no) && post({ action: 'permit', no: T5.data.permit_no, t: T5.data.token }).ok && sent() === n + 1);
    check('teams: HTTP status logged with console.warn', gas.logs.some((l) => l === 'WARN Teams notification failed: HTTP 500'), gas.logs);
    gas.fetchMode.code = 202;
    gas.fetchMode.throws = 'Address unavailable: ' + HOOK;
    const T6 = postT(Object.assign(base(), { attachment: null }));
    const rr = postT({ action: 'decide', session: ST, id: T6.data.id, decision: 'reject', comment: 'x' });
    check('teams: fetch exception → submit + decide still ok and stored', T6.ok && rr.ok && rr.data.status === 'rejected' && col(T6.data.id, 'status') === 'rejected', { T6, rr });
    check('teams: request error logged without the URL', gas.logs.some((l) => l === 'WARN Teams notification failed: request error'));
    gas.fetchMode.throws = null;
    G.teamsCard_ = (() => { const orig = G.teamsCard_; return function () { G.teamsCard_ = orig; throw new Error('boom ' + HOOK); }; })();
    const T7 = postT(Object.assign(base(), { attachment: null }));
    check('teams: card build error → submit still ok', T7.ok && !gas.logs.some((l) => l.startsWith('ERROR')));
    gas.propStore.TEAMS_WEBHOOK_URL = 'http://insecure.example.com/hook';
    n = sent();
    check('teams: non-https webhook is not called', postT(Object.assign(base(), { attachment: null })).ok && sent() === n);
    gas.propStore.TEAMS_WEBHOOK_URL = HOOK;

    // -- testTeamsNotification()
    n = sent();
    const tt = G.testTeamsNotification();
    check('testTeamsNotification: sends one sample card, returns the status', tt.ok === true && tt.status === 202 && sent() === n + 1 && cardOk(lastCard()), tt);
    gas.fetchMode.code = 404;
    const tt2 = G.testTeamsNotification();
    check('testTeamsNotification: non-2xx → ok false + status', tt2.ok === false && tt2.status === 404);
    gas.fetchMode.code = 202;
    delete gas.propStore.TEAMS_WEBHOOK_URL;
    n = sent();
    const tt3 = G.testTeamsNotification();
    check('testTeamsNotification: unset → nothing sent, says so', tt3.ok === false && tt3.status === null && sent() === n && /TEAMS_WEBHOOK_URL/.test(tt3.note));
    gas.propStore.TEAMS_WEBHOOK_URL = HOOK;

    // -- reset_data (last: wipes the permits)
    n = sent();
    const before = pSheet.getLastRow() - 1;
    const rs = postT({ action: 'reset_data', session: ST, resetPassword: RESET_PW });
    c = lastCard();
    check('teams reset_data: one Attention card with counts + by whom', rs.ok && sent() === n + 1 && header(c).color === 'Attention' &&
      factsOf(c)['ใบอนุญาตที่ลบ'] === before + ' ใบ' && factsOf(c)['ประวัติที่ลบ'] === rs.data.logs_removed + ' รายการ' &&
      factsOf(c)['ไฟล์ที่ย้ายไปถังขยะ Drive'] === rs.data.files_trashed + ' ไฟล์' && factsOf(c)['รีเซ็ตโดย'] === ME, { rs, c });

    // -- privacy: no tracking token / token link anywhere in a card; webhook URL never in logs or responses
    const tokens = [T1, T2, T3, T5, T6, T7].map((x) => x.data.token).concat(T4.token);
    const payloads = gas.fetches.map((f) => f.params.payload).join('\n');
    check('teams: no tracking token / track link / session in any payload', tokens.every((t) => t && !payloads.includes(t)) && !/track\.html|[?&]t=|"token"/.test(payloads) && !payloads.includes(ST));
    check('teams: no attachment / signature in any payload', !/data:image|base64|_file"/.test(payloads));
    check('teams: webhook URL / sig never in logs or API responses', !gas.logs.concat(raws).some((l) => l.includes('SECRET-SIG') || l.includes('logic.azure.com')));
    check('teams: every card is valid JSON with header color Good|Attention', gas.fetches.every((f) => { const m = JSON.parse(f.params.payload); return cardOk(m) && /^(Good|Attention)$/.test(header(m).color); }));
    delete gas.propStore.TEAMS_WEBHOOK_URL;
  }

  // ================================================================ single-file paste (all .gs concatenated in order)
  const allGs = GS_ORDER.map((f) => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8')).join('\n');
  const tops = {};
  (allGs.match(/^(?:var|let|const|function)\s+[A-Za-z_$][\w$]*/gm) || []).forEach((m) => { const n = m.split(/\s+/)[1]; tops[n] = (tops[n] || 0) + 1; });
  const dups = Object.keys(tops).filter((n) => tops[n] > 1);
  check('concatenated .gs: no duplicate top-level names', dups.length === 0, dups);
  check('concatenated .gs: no top-level let/const (redeclaration errors across files)', !/^(?:let|const)\s/m.test(allGs));
  const g1 = createGas();
  require('vm').runInContext(allGs, g1.context, { filename: 'all.gs' });
  g1.context.now_ = () => new Date(BKK('2026-10-07T10:00:00'));
  g1.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Single-File-1';
  g1.context.setupSystem();
  const post1 = (b) => JSON.parse(g1.context.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
  const s1x = post1({ action: 'login', username: 'admin', password: 'Single-File-1' });
  const sub1 = post1(Object.assign(base(), { attachment: null }));
  check('concatenated .gs: setup + login + submit + dashboard + keepWarm work', s1x.ok && sub1.ok && post1({ action: 'dashboard', session: s1x.data.session }).data.cnt.pending === 1 &&
    g1.context.keepWarm().ok, { s1x, sub1 });
  check('concatenated .gs: no Teams call while unset', g1.fetches.length === 0);
  g1.propStore.TEAMS_WEBHOOK_URL = 'https://example.invalid/hook';
  const sub2 = post1(Object.assign(base(), { attachment: null }));
  check('concatenated .gs: submit sends one Teams card, testTeamsNotification works', sub2.ok && g1.fetches.length === 1 &&
    JSON.parse(g1.fetches[0].params.payload).attachments[0].content.body[0].items[0].text === 'มีคำขอใบอนุญาตใหม่ รอพิจารณา' &&
    g1.context.testTeamsNotification().status === 202 && g1.fetches.length === 2, { sub2, n: g1.fetches.length });

  // ================================================================ forgotten admin password
  {
    const before = gas.propStore.WP_INITIAL_ADMIN_PASSWORD;
    gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'short';
    throws('resetAdminPassword: refuses a property shorter than 8', () => G.resetAdminPassword(), /อย่างน้อย 8/);
    gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Reset-Admin-77';
    for (let i = 0; i < 12; i++) post({ action: 'login', username: 'admin', password: 'wrong-' + i }); // locked out
    check('resetAdminPassword: lockout active before reset', post({ action: 'login', username: 'admin', password: 'Reset-Admin-77' }).code === 'LOCKED');
    const r = G.resetAdminPassword();
    const li = post({ action: 'login', username: 'admin', password: 'Reset-Admin-77' });
    check('resetAdminPassword: admin logs in with the property value, lockout cleared', r.ok && li.ok && li.data.user.username === 'admin', { r, li });
    check('resetAdminPassword: old admin sessions no longer work', post({ action: 'me', session: S }).ok === false);
    if (before === undefined) delete gas.propStore.WP_INITIAL_ADMIN_PASSWORD; else gas.propStore.WP_INITIAL_ADMIN_PASSWORD = before;
  }

  // ================================================================ invariants
  check('every sheet write happened under LockService', gas.stats.unlockedWrites === 0, gas.stats.unlockedWrites);
  check('no server errors logged', !gas.logs.some((l) => l.startsWith('ERROR')), gas.logs.filter((l) => l.startsWith('ERROR')));

  return { passed, failures };
};
