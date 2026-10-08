/* Approval workflow (stage 0 assign → 1 area owner → 2 responsible → 3 จป.), roles,
 * permissions, Teams @mention cards and approval reminders — end-to-end through
 * doGet/doPost on the in-memory Apps Script mocks.  Run: node test/run.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const GS_ORDER = ['Data.gs', 'Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs'];
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SIG = 'data:image/png;base64,' + PNG_1x1;
const HOOK = 'https://prod-01.example.logic.azure.com/workflows/wf/triggers/manual/paths/invoke?sig=WF-SECRET';

module.exports = function run() {
  let passed = 0;
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) { passed++; return; }
    failures.push('workflow: ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 500) : ''));
  };

  const gas = createGas();
  gas.load(path.join(ROOT, 'apps-script'), GS_ORDER);
  const G = gas.context;
  const BKK = (iso) => new Date(iso + '+07:00').getTime();
  const setNow = (iso) => { gas.clock.offset = BKK(iso) - Date.now(); };
  const addMin = (m) => { gas.clock.offset += m * 60000; };
  const post = (b) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
  const get = (p) => JSON.parse(G.doGet({ parameter: p }).getContent());
  const dv = () => (gas.cacheStore.get('wpdv') || {}).v;

  // ================================================================ legacy database (before roles / workflow)
  setNow('2026-10-06T08:00:00');
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Admin-Pass-1';
  G.setupSystem();
  const ss = gas.spreadsheets.get(gas.propStore.WP_SPREADSHEET_ID);
  const pSheet = ss.getSheetByName('permits'), uSheet = ss.getSheetByName('users'), lSheet = ss.getSheetByName('permit_logs');
  let S = post({ action: 'login', username: 'admin', password: 'Admin-Pass-1' }).data.session;
  post({ action: 'user_save', session: S, username: 'oldsafety', fullname: 'จป. เก่า', password: 'old-pass-1' });
  const body = (o = {}) => Object.assign({
    action: 'submit', company: G.WP_DATA.companies[0], permit_type: 'contractor', work_types: ['hot'],
    work_date: '2026-10-06', time_from: '08:00', time_to: '17:00', requester_title: 'นาย', requester_name: 'ผู้ขอ ทดสอบ',
    requester_company: 'ผู้รับเหมา ก', requester_phone: '0812345678', owner_name: 'เจ้าของงาน', location: 'อาคาร 1', job_detail: 'เชื่อม',
    requester_sign: SIG
  }, o);
  const L1 = post(body()).data, L2 = post(body({ location: 'อาคาร 2' })).data;
  check('legacy: submits without responsibles ok', L1 && L2 && L1.permit_no && L2.permit_no);
  // strip every column added by this version → exactly the old sheet layout
  const OLD = {
    users: ['id', 'username', 'salt', 'password_hash', 'iterations', 'fullname', 'position', 'active', 'must_change', 'created_at'],
    permits: G.WP_SCHEMA.permits.slice(0, G.WP_SCHEMA.permits.indexOf('responsible_id'))
  };
  [['users', uSheet], ['permits', pSheet]].forEach(([n, sh]) => { sh.data = sh.data.map((row) => (row || []).slice(0, OLD[n].length)); });
  check('legacy: sheets have the old columns only', uSheet.getRange(1, 1, 1, uSheet.getLastColumn()).getValues()[0].join() === OLD.users.join() && pSheet.getLastColumn() === OLD.permits.length);
  G.bumpDataVersion_();
  check('legacy: new code refuses until setupSystem() is re-run (SETUP)', post({ action: 'me', session: S }).code === 'SETUP');
  const up = G.setupSystem();
  check('upgrade: setupSystem adds columns, migrates both users to safety, keeps data', up.usersMigratedToSafety === 2 && !up.adminCreated &&
    uSheet.getRange(1, 1, 1, G.WP_SCHEMA.users.length).getValues()[0].join() === G.WP_SCHEMA.users.join() &&
    pSheet.getRange(1, 1, 1, G.WP_SCHEMA.permits.length).getValues()[0].join() === G.WP_SCHEMA.permits.join() && pSheet.getLastRow() === 3, up);
  const uh = G.WP_SCHEMA.users;
  check('upgrade: roles cell written "safety"', uSheet.getDataRange().getValues().slice(1).every((r) => r[uh.indexOf('roles')] === 'safety'));
  check('upgrade: second run migrates nobody', G.setupSystem().usersMigratedToSafety === 0);
  S = post({ action: 'login', username: 'admin', password: 'Admin-Pass-1' }).data.session;
  let r = post({ action: 'me', session: S });
  check('upgrade: admin is safety, sessions / login unchanged', r.ok && r.data.roles.join() === 'safety' && r.data.email === '', r);
  check('upgrade: old safety user can still log in + use admin pages', (() => { const s2 = post({ action: 'login', username: 'oldsafety', password: 'old-pass-1' }).data.session; return post({ action: 'dashboard', session: s2 }).ok; })());
  // an empty roles cell (row written by the old deployment after the upgrade) still means safety
  G.userRoles_({ roles: '' }).join() === 'safety' ? passed++ : failures.push('workflow: empty roles → safety');
  r = post({ action: 'permit', session: S, id: L1.id });
  check('legacy pending permit: stage 3 (จป.) directly, not a workflow permit', r.ok && r.data.permit.stage === 'safety' && r.data.permit.workflow === false, r.data && r.data.permit);
  check('legacy pending permit: จป. approves as before', post({ action: 'decide', session: S, id: L1.id, decision: 'approve', sign: SIG }).ok);

  // ================================================================ accounts (roles + e-mail), user management strictness
  const mk = (o) => post(Object.assign({ action: 'user_save', session: S, password: 'pass-' + o.username }, o));
  check('user_save: invalid e-mail refused', /อีเมลไม่ถูกต้อง/.test(mk({ username: 'x1', fullname: 'X', email: 'not-an-email', roles: ['responsible'] }).error));
  check('user_save: no role refused', /บทบาท/.test(mk({ username: 'x1', fullname: 'X', roles: [] }).error));
  check('user_save: unknown roles only refused', /บทบาท/.test(mk({ username: 'x1', fullname: 'X', roles: ['god'] }).error));
  const ids = {};
  [['resp1', 'สมศักดิ์ รับผิดชอบ', ['responsible'], 'Somsak@Company.co.th'],
    ['resp2', 'วีระ ไม่มีเมล', ['responsible'], ''],
    ['area1', 'อารี เจ้าของพื้นที่', ['area_owner'], 'aree@company.co.th'],
    ['area2', 'ประเสริฐ พื้นที่สอง', ['area_owner'], 'prasert@company.co.th'],
    ['both1', 'ทวี สองบทบาท', ['responsible', 'area_owner', 'bogus'], 'tawee@company.co.th']
  ].forEach(([u, n, roles, email]) => { const x = mk({ username: u, fullname: n, roles, email }); ids[u] = x.ok && x.data.id; check('create ' + u, x.ok, x); });
  r = post({ action: 'users', session: S });
  const byU = {}; r.data.users.forEach((u) => { byU[u.username] = u; });
  check('users: roles + e-mail stored (lower-cased, unknown roles dropped)', byU.resp1.roles.join() === 'responsible' && byU.resp1.email === 'somsak@company.co.th' &&
    byU.both1.roles.join() === 'responsible,area_owner' && byU.area1.position === '', byU);
  check('user_save without roles (older page) keeps roles', post({ action: 'user_save', session: S, id: ids.resp1, fullname: 'สมศักดิ์ รับผิดชอบ', position: 'วิศวกร', password: '' }).ok &&
    post({ action: 'users', session: S }).data.users.find((u) => u.id === ids.resp1).roles.join() === 'responsible');
  check('จป. cannot remove own safety role', /จป\. ของตนเอง/.test(post({ action: 'user_save', session: S, id: 1, fullname: 'ผู้ดูแลระบบ จป.', roles: ['responsible'], password: '' }).error));
  post({ action: 'user_save', session: S, id: 1, fullname: 'ผู้ดูแลระบบ จป.', roles: ['safety'], email: 'safety.admin@company.co.th', password: '' });

  const login = (u) => { const x = post({ action: 'login', username: u, password: 'pass-' + u }); return x.ok ? x.data.session : null; };
  const SR1 = login('resp1'), SR2 = login('resp2'), SA1 = login('area1'), SA2 = login('area2');
  r = post({ action: 'login', username: 'resp1', password: 'pass-resp1' });
  check('approver login: same endpoint, roles returned, e-mail only their own', r.ok && r.data.user.roles.join() === 'responsible' && r.data.user.email === 'somsak@company.co.th');
  gas.stats.sleeps.length = 0;
  for (let i = 0; i < 10; i++) post({ action: 'login', username: 'area2', password: 'wrong' + i });
  check('approver: same lockout after 10 failures', post({ action: 'login', username: 'area2', password: 'pass-area2' }).code === 'LOCKED' && gas.stats.sleeps.length === 10);
  addMin(16);

  // non-safety users: no admin data, no admin actions
  ['poll', 'dashboard', 'permits', 'users', 'save_review', 'decide', 'delete', 'update_permit', 'reset_data', 'user_save', 'user_toggle', 'reassign'].forEach((a) => {
    const x = post({ action: a, session: SR1, id: L2.id, decision: 'reject', comment: 'x', fullname: 'x', resetPassword: 'x', responsible_id: ids.resp2 });
    check('responsible: ' + a + ' → FORBIDDEN', x.code === 'FORBIDDEN', x);
    check('area owner: ' + a + ' → FORBIDDEN', post({ action: a, session: SA1, id: L2.id }).code === 'FORBIDDEN');
  });
  check('approver: me ok', post({ action: 'me', session: SA1 }).ok);
  check('approver: unrelated permit by id → NOT_FOUND', post({ action: 'permit', session: SR1, id: L2.id }).code === 'NOT_FOUND' && post({ action: 'file', session: SR1, id: L2.id }).code === 'NOT_FOUND');
  r = post({ action: 'batch', session: SR1, calls: [{ action: 'me' }, { action: 'poll' }, { action: 'dashboard' }, { action: 'permits' }, { action: 'users' }, { action: 'my_tasks' }, { action: 'approvers' }] });
  check('approver batch: admin sub-calls FORBIDDEN, own calls ok', r.ok && r.data[0].ok && [1, 2, 3, 4].every((i) => r.data[i].code === 'FORBIDDEN') && r.data[5].ok && r.data[6].ok, r);
  ['my_tasks', 'approvers', 'assign_area', 'stage_decide', 'reassign'].forEach((a) => check('anonymous ' + a + ' → AUTH', post({ action: a, id: 1 }).code === 'AUTH'));

  // ================================================================ public responsibles list
  r = get({ action: 'responsibles' });
  const raw = JSON.stringify(r);
  check('GET responsibles: active responsibles, id + name only', r.ok && r.data.length === 3 && r.data.every((x) => Object.keys(x).join() === 'id,name') &&
    r.data.map((x) => x.id).sort().join() === [ids.resp1, ids.resp2, ids.both1].sort().join(), r);
  check('GET responsibles: no e-mail / username / role / hash leaks', !/@|resp1|area|password|salt|email|username/.test(raw), raw);
  post({ action: 'user_toggle', session: S, id: ids.resp2 });
  const filesB = gas.files.size;
  check('disabled responsible not listed', !get({ action: 'responsibles' }).data.some((x) => x.id === ids.resp2));
  check('disabled responsible refused at submit', /ไม่ถูกต้องหรือถูกปิด/.test(post(body({ responsible_id: ids.resp2 })).error));
  post({ action: 'user_toggle', session: S, id: ids.resp2 });

  // ================================================================ submit (stage 0)
  check('submit: responsible required while responsibles exist', post(body()).error === 'กรุณาเลือกผู้รับผิดชอบงาน');
  check('submit: an area owner is not a responsible', /ไม่ถูกต้อง/.test(post(body({ responsible_id: ids.area1 })).error));
  check('submit: refused submits created no Drive files', gas.files.size === filesB, gas.files.size - filesB);
  gas.propStore.TEAMS_WEBHOOK_URL = HOOK;
  const fetches0 = gas.fetches.length;
  r = post(body({ responsible_id: ids.resp1, owner_name: '', with_permit: true }));
  const P = r.data;
  check('submit with responsible ok → stage assign', r.ok && P.view.permit.stage === 'assign' && P.view.permit.workflow === true && P.view.permit.status === 'pending', r);
  check('submit: blank owner_name filled with the responsible name', P.view.permit.owner_name === 'สมศักดิ์ รับผิดชอบ');
  check('token view: no assignee ids / e-mails', !('responsible_id' in P.view.permit) && !JSON.stringify(P.view).includes('@'));
  const lastCard = () => JSON.parse(gas.fetches[gas.fetches.length - 1].params.payload);
  const content = (m) => m.attachments[0].content;
  const texts = (m) => content(m).body.flatMap((b) => (b.items || [b]).map((x) => x.text).filter(Boolean)).join('\n');
  const facts = (m) => { const o = {}; (content(m).body.find((b) => b.type === 'FactSet') || { facts: [] }).facts.forEach((f) => { o[f.title] = f.value; }); return o; };
  const ents = (m) => (content(m).msteams.entities || []);
  let c = lastCard();
  check('teams submit: one card "มีคำขอใบอนุญาตใหม่" mentioning the responsible', gas.fetches.length === fetches0 + 1 && content(c).body[0].items[0].text === 'มีคำขอใบอนุญาตใหม่' &&
    texts(c).includes('<at>สมศักดิ์ รับผิดชอบ</at>') && /ระบุเจ้าของพื้นที่/.test(texts(c)), texts(c));
  check('teams submit: mention entity (type, text, mentioned id = e-mail, name)', JSON.stringify(ents(c)) === JSON.stringify([{ type: 'mention', text: '<at>สมศักดิ์ รับผิดชอบ</at>', mentioned: { id: 'somsak@company.co.th', name: 'สมศักดิ์ รับผิดชอบ' } }]) &&
    content(c).msteams.width === 'Full', content(c).msteams);
  check('teams submit: facts + button to admin view, no token', facts(c)['เลขที่'] === P.permit_no && facts(c)['ขั้นตอนปัจจุบัน'] === 'รอระบุเจ้าของพื้นที่' &&
    content(c).actions[0].url.endsWith('/admin/view.html?id=' + P.id) && !gas.fetches[gas.fetches.length - 1].params.payload.includes(P.token));

  {
    const RID = '9f'.repeat(16);
    const first = post(body({ responsible_id: ids.resp2, rid: RID }));
    post({ action: 'user_toggle', session: S, id: ids.resp2 });
    const again = post(body({ responsible_id: ids.resp2, rid: RID }));
    post({ action: 'user_toggle', session: S, id: ids.resp2 });
    check('retried submit (same rid) replays even if the responsible was disabled meanwhile', first.ok && again.ok && again.data.permit_no === first.data.permit_no, { first, again });
    post({ action: 'stage_decide', session: login('resp2'), id: first.data.id, decision: 'reject', comment: 'ทดสอบ' });
  }

  // ================================================================ stage 0 → 1 (assign area owner)
  let t = post({ action: 'my_tasks', session: SR1 });
  check('my_tasks (responsible): the new permit is pending for them', t.ok && t.data.count === 1 && t.data.pending[0].id === P.id && t.data.pending[0].stage === 'assign', t);
  check('my_tasks (area owner): nothing yet', post({ action: 'my_tasks', session: SA1 }).data.count === 0);
  check('area owner cannot see it before assignment', post({ action: 'permit', session: SA1, id: P.id }).code === 'NOT_FOUND');
  check('other responsible cannot see it', post({ action: 'permit', session: SR2, id: P.id }).code === 'NOT_FOUND' && post({ action: 'assign_area', session: SR2, id: P.id, area_owner_id: ids.area1 }).code === 'NOT_FOUND');
  r = post({ action: 'permit', session: SR1, id: P.id, signs: true });
  check('assigned responsible reads it (ids, signs incl. area/resp)', r.ok && r.data.permit.responsible_id === ids.resp1 && 'area' in r.data.signs && 'resp' in r.data.signs, r);
  check('จป. cannot approve / reject at stage 0 (CONFLICT)', post({ action: 'decide', session: S, id: P.id, decision: 'approve', sign: SIG }).code === 'CONFLICT' &&
    post({ action: 'decide', session: S, id: P.id, decision: 'reject', comment: 'x' }).code === 'CONFLICT');
  check('จป. is not the assignee: assign_area / stage_decide FORBIDDEN', post({ action: 'assign_area', session: S, id: P.id, area_owner_id: ids.area1 }).code === 'FORBIDDEN' &&
    post({ action: 'stage_decide', session: S, id: P.id, decision: 'reject', comment: 'x' }).code === 'FORBIDDEN');
  check('stage 0 has no approve (pick the area owner)', /ระบุเจ้าของพื้นที่ก่อน/.test(post({ action: 'stage_decide', session: SR1, id: P.id, decision: 'approve', sign: SIG }).error));
  check('assign_area: a responsible-only user is not an area owner', /เจ้าของพื้นที่/.test(post({ action: 'assign_area', session: SR1, id: P.id, area_owner_id: ids.resp2 }).error));
  const base0 = post({ action: 'permit', session: SR1, id: P.id }).data.permit.updated_at;
  addMin(3);
  const dvA = dv();
  r = post({ action: 'assign_area', session: SR1, id: P.id, area_owner_id: ids.area1, base: base0 });
  check('assign_area ok → stage area (data version replaced)', r.ok && r.data.stage === 'area' && dv() !== dvA, r);
  c = lastCard();
  check('teams: stage 1 card "รออนุมัติขั้นที่ 1: เจ้าของพื้นที่ — <at>…</at>"', content(c).body[0].items[0].text === 'รออนุมัติขั้นที่ 1: เจ้าของพื้นที่ — <at>อารี เจ้าของพื้นที่</at>' &&
    ents(c).length === 1 && ents(c)[0].mentioned.id === 'aree@company.co.th', content(c).body[0]);
  r = get({ action: 'track_list' });
  const tl = r.ok && r.data.find((x) => x.permit_no === P.permit_no);
  check('GET track_list: public short row, waits at area owner by name', !!tl && tl.stage === 'area' && tl.waiting_name === 'อารี เจ้าของพื้นที่' && tl.status === 'pending', r);
  check('GET track_list: no phone / token / details / ids', r.ok && r.data.every((x) => Object.keys(x).sort().join() ===
    'es,permit_no,requester_company,requester_name,stage,status,time_from,time_to,waiting_name,work_date,work_types'), r.data && r.data[0]);
  check('assign_area again → CONFLICT (stage moved on)', post({ action: 'assign_area', session: SR1, id: P.id, area_owner_id: ids.area2, base: base0 }).code === 'CONFLICT');

  // ================================================================ stage 1 (area owner)
  check('responsible cannot approve stage 1', post({ action: 'stage_decide', session: SR1, id: P.id, decision: 'approve', sign: SIG }).code === 'FORBIDDEN');
  check('other area owner cannot see / approve stage 1', post({ action: 'stage_decide', session: SA2, id: P.id, decision: 'approve', sign: SIG }).code === 'NOT_FOUND');
  check('area owner: approve needs a signature', /ลงลายมือชื่อ/.test(post({ action: 'stage_decide', session: SA1, id: P.id, decision: 'approve' }).error));
  check('area owner: reject needs a reason', /เหตุผล/.test(post({ action: 'stage_decide', session: SA1, id: P.id, decision: 'reject', comment: ' ' }).error));
  check('my_tasks (area owner): pending now', post({ action: 'my_tasks', session: SA1 }).data.pending.map((x) => x.id).join() === String(P.id));
  addMin(4);
  r = post({ action: 'stage_decide', session: SA1, id: P.id, decision: 'approve', comment: 'พื้นที่พร้อม', sign: SIG });
  check('area owner approves → stage resp', r.ok && r.data.stage === 'resp', r);
  c = lastCard();
  check('teams: stage 2 card mentions the responsible', content(c).body[0].items[0].text === 'รออนุมัติขั้นที่ 2: ผู้รับผิดชอบงาน — <at>สมศักดิ์ รับผิดชอบ</at>' && ents(c)[0].mentioned.id === 'somsak@company.co.th');
  check('area owner can still read it, cannot act any more', post({ action: 'permit', session: SA1, id: P.id }).ok && post({ action: 'stage_decide', session: SA1, id: P.id, decision: 'approve', sign: SIG }).code === 'FORBIDDEN');

  // ================================================================ stage 2 (responsible) → 3 (จป.)
  check('area owner cannot reject stage 2', post({ action: 'stage_decide', session: SA1, id: P.id, decision: 'reject', comment: 'x' }).code === 'FORBIDDEN');
  addMin(5);
  r = post({ action: 'stage_decide', session: SR1, id: P.id, decision: 'approve', sign: SIG });
  check('responsible approves → stage safety', r.ok && r.data.stage === 'safety', r);
  c = lastCard();
  check('teams: stage 3 card mentions the active จป. with e-mail (others by name)', /^รออนุมัติขั้นที่ 3: จป\. \(เจ้าหน้าที่ความปลอดภัย\) — /.test(content(c).body[0].items[0].text) &&
    content(c).body[0].items[0].text.includes('<at>ผู้ดูแลระบบ จป.</at>') && content(c).body[0].items[0].text.includes('จป. เก่า') && !content(c).body[0].items[0].text.includes('<at>จป. เก่า</at>') &&
    ents(c).length === 1 && ents(c)[0].mentioned.id === 'safety.admin@company.co.th', content(c).body[0].items[0].text);
  check('my_tasks (responsible): nothing pending, permit in recent', (() => { const x = post({ action: 'my_tasks', session: SR1 }).data; return x.count === 0 && x.recent.some((y) => y.id === P.id); })());
  check('responsible cannot decide stage 3', post({ action: 'decide', session: SR1, id: P.id, decision: 'approve', sign: SIG }).code === 'FORBIDDEN' &&
    post({ action: 'stage_decide', session: SR1, id: P.id, decision: 'approve', sign: SIG }).code === 'CONFLICT');
  addMin(6);
  r = post({ action: 'decide', session: S, id: P.id, decision: 'approve', comment: 'ok', sign: SIG });
  check('จป. approves at stage 3 (unchanged flow)', r.ok && r.data.status === 'approved', r);
  c = lastCard();
  check('teams: final approval card as before', content(c).body[0].items[0].text === 'อนุมัติใบอนุญาตแล้ว ' + P.permit_no && !content(c).msteams.entities);
  r = post({ action: 'permit', session: S, id: P.id, signs: true });
  const fp = r.data.permit;
  check('approved: every step recorded (who / when) + signatures served', fp.status === 'approved' && fp.stage === '' && fp.area_owner_name === 'อารี เจ้าของพื้นที่' &&
    fp.area_assigned_at && fp.area_approved_at && fp.resp_approved_at && fp.approved_at && fp.area_comment === 'พื้นที่พร้อม' && fp.has_area_sign && fp.has_resp_sign &&
    r.data.signs.area.startsWith('data:image/png') && r.data.signs.resp.startsWith('data:image/png') && r.data.signs.approver.startsWith('data:image/png'), fp);
  check('logs: submit, assign_area, area_approve, resp_approve, approve (with names)', r.data.logs.map((l) => l.action).join() === 'submit,assign_area,area_approve,resp_approve,approve' &&
    r.data.logs[1].by_name === 'สมศักดิ์ รับผิดชอบ' && r.data.logs[2].by_name === 'อารี เจ้าของพื้นที่' && r.data.logs[2].note === 'พื้นที่พร้อม', r.data.logs);
  const tv = post({ action: 'permit', no: P.permit_no, t: P.token, signs: true }).data;
  check('token holder: stages + times, print signatures, no ids / e-mails', tv.permit.area_approved_at === fp.area_approved_at && tv.signs.area && !('area_owner_id' in tv.permit) && !JSON.stringify(tv).includes('@company'));
  const rowOf = (id) => pSheet.getDataRange().getValues().find((x, i) => i > 0 && String(x[0]) === String(id));
  const ph = G.WP_SCHEMA.permits, col = (id, k) => rowOf(id)[ph.indexOf(k)];
  check('sheet: signature files in Drive (private), names stored', /^file_/.test(col(P.id, 'area_sign_file')) && /^file_/.test(col(P.id, 'resp_sign_file')) && gas.stats.sharingCalls === 0);
  check('expiry only after the final approval (end of the work window)', fp.es === 'approved' && fp.end_ts === BKK('2026-10-06T17:00:00') / 1000);
  check('close as before', post({ action: 'decide', session: S, id: P.id, decision: 'close' }).ok);

  // ================================================================ rejection at each stage
  const flowTo = (stage) => {
    const x = post(body({ responsible_id: ids.resp1 })).data;
    if (stage === 'assign') return x;
    post({ action: 'assign_area', session: SR1, id: x.id, area_owner_id: ids.area1 });
    if (stage === 'area') return x;
    post({ action: 'stage_decide', session: SA1, id: x.id, decision: 'approve', sign: SIG });
    if (stage === 'resp') return x;
    post({ action: 'stage_decide', session: SR1, id: x.id, decision: 'approve', sign: SIG });
    return x;
  };
  [['assign', SR1, 'ผู้รับผิดชอบงาน', 'สมศักดิ์ รับผิดชอบ'], ['area', SA1, 'เจ้าของพื้นที่', 'อารี เจ้าของพื้นที่'], ['resp', SR1, 'ผู้รับผิดชอบงาน', 'สมศักดิ์ รับผิดชอบ'], ['safety', S, 'จป.', 'ผู้ดูแลระบบ จป.']].forEach(([st, sess, role, name]) => {
    const x = flowTo(st);
    check('reject at ' + st + ': permit is at that stage', post({ action: 'permit', session: S, id: x.id }).data.permit.stage === st);
    const n = gas.fetches.length;
    const res = st === 'safety' ? post({ action: 'decide', session: sess, id: x.id, decision: 'reject', comment: 'เหตุผล ' + st })
      : post({ action: 'stage_decide', session: sess, id: x.id, decision: 'reject', comment: 'เหตุผล ' + st });
    const v = post({ action: 'permit', session: S, id: x.id }).data;
    const lg = v.logs[v.logs.length - 1];
    check('reject at ' + st + ': rejected, reason + who + stage recorded', res.ok && v.permit.status === 'rejected' && v.permit.reject_stage === st && v.permit.approve_comment === 'เหตุผล ' + st &&
      v.permit.approver_name === name && lg.action === 'reject' && lg.by_name === name && (st === 'safety' ? lg.note === 'เหตุผล safety' : lg.note === '[' + role + '] เหตุผล ' + st), { v: v.permit, lg });
    const cc = lastCard();
    check('reject at ' + st + ': one Attention card with the reason, no token / mention', gas.fetches.length === n + 1 && content(cc).body[0].items[0].color === 'Attention' &&
      facts(cc)['ผลการพิจารณา'] === 'ไม่อนุมัติ' && texts(cc).includes('เหตุผล ' + st) && !gas.fetches[gas.fetches.length - 1].params.payload.includes(x.token) && !content(cc).msteams.entities &&
      (st === 'safety' ? !facts(cc)['ขั้นตอน'] : facts(cc)['ขั้นตอน'] === 'ขั้นที่ ' + G.WP_DATA.stages[st].no + ' — ' + G.WP_DATA.stages[st].label), facts(cc));
    check('reject at ' + st + ': nothing more possible', post({ action: 'stage_decide', session: sess, id: x.id, decision: 'approve', sign: SIG }).ok === false &&
      post({ action: 'decide', session: S, id: x.id, decision: 'approve', sign: SIG }).ok === false);
  });

  // ================================================================ reassignment by the จป.
  const Q = flowTo('assign');
  check('reassign: approver cannot', post({ action: 'reassign', session: SR1, id: Q.id, responsible_id: ids.resp2 }).code === 'FORBIDDEN');
  check('reassign: area owner at stage 0 refused', post({ action: 'reassign', session: S, id: Q.id, area_owner_id: ids.area2 }).code === 'CONFLICT');
  check('reassign: to a non-responsible refused', /ไม่ถูกต้อง/.test(post({ action: 'reassign', session: S, id: Q.id, responsible_id: ids.area1 }).error));
  let n = gas.fetches.length;
  r = post({ action: 'reassign', session: S, id: Q.id, responsible_id: ids.resp2 });
  c = lastCard();
  check('reassign responsible at stage 0: changed + card to the new one (no e-mail → plain name, no entity)', r.ok && r.data.changed && gas.fetches.length === n + 1 &&
    content(c).body[0].items[0].text === 'รออนุมัติขั้นที่ 0: ผู้รับผิดชอบงาน — วีระ ไม่มีเมล' && !content(c).msteams.entities, content(c).body[0]);
  check('reassign: old responsible loses access, new one can act', post({ action: 'permit', session: SR1, id: Q.id }).code === 'NOT_FOUND' &&
    post({ action: 'assign_area', session: SR2, id: Q.id, area_owner_id: ids.area1 }).ok);
  const qv = post({ action: 'permit', session: S, id: Q.id }).data;
  check('reassign logged with names', qv.logs.some((l) => l.action === 'reassign' && l.by_name === 'ผู้ดูแลระบบ จป.' && l.note.includes('สมศักดิ์ รับผิดชอบ → วีระ ไม่มีเมล')), qv.logs);
  n = gas.fetches.length;
  r = post({ action: 'reassign', session: S, id: Q.id, area_owner_id: ids.area2 });
  check('reassign area owner at stage 1 → card mentions the new area owner', r.ok && gas.fetches.length === n + 1 && ents(lastCard())[0].mentioned.id === 'prasert@company.co.th' &&
    post({ action: 'stage_decide', session: SA1, id: Q.id, decision: 'approve', sign: SIG }).code === 'NOT_FOUND' &&
    post({ action: 'stage_decide', session: SA2, id: Q.id, decision: 'approve', sign: SIG }).ok);
  n = gas.fetches.length;
  r = post({ action: 'reassign', session: S, id: Q.id, responsible_id: ids.resp2 });
  check('reassign to the same person: no change, no card', r.ok && r.data.changed === false && gas.fetches.length === n);
  check('reassign at stage 3 refused', (() => { post({ action: 'stage_decide', session: SR2, id: Q.id, decision: 'approve', sign: SIG }); return post({ action: 'reassign', session: S, id: Q.id, responsible_id: ids.resp1 }).code === 'CONFLICT'; })());
  // role removed while assigned → strict: refused (the จป. must reassign)
  const R3 = flowTo('assign');
  post({ action: 'user_save', session: S, id: ids.resp1, fullname: 'สมศักดิ์ รับผิดชอบ', roles: ['area_owner'], password: '' });
  check('assignee who lost the role cannot act / read', post({ action: 'assign_area', session: SR1, id: R3.id, area_owner_id: ids.area1 }).code === 'NOT_FOUND');
  post({ action: 'user_save', session: S, id: ids.resp1, fullname: 'สมศักดิ์ รับผิดชอบ', roles: ['responsible'], password: '' });
  check('…and can again once the role is back (same session)', post({ action: 'assign_area', session: SR1, id: R3.id, area_owner_id: ids.area1 }).ok);
  // one person holding both roles may be responsible and area owner of the same permit
  const SB = login('both1');
  const B1 = post(body({ responsible_id: ids.both1 })).data;
  check('both roles: assign self as area owner, approve both stages', post({ action: 'assign_area', session: SB, id: B1.id, area_owner_id: ids.both1 }).ok &&
    post({ action: 'stage_decide', session: SB, id: B1.id, decision: 'approve', sign: SIG }).ok && post({ action: 'stage_decide', session: SB, id: B1.id, decision: 'approve', sign: SIG }).data.stage === 'safety');

  // ================================================================ reminders (time trigger)
  check('reminder trigger: install every 5 min, idempotent, keepWarm untouched', (() => {
    G.installKeepWarmTrigger();
    const a = G.installApprovalReminderTrigger(), b = G.installApprovalReminderTrigger();
    const rem = gas.triggers.filter((x) => x.getHandlerFunction() === 'checkApprovalReminders');
    const kw = gas.triggers.filter((x) => x.getHandlerFunction() === 'keepWarm');
    return a.installed === 1 && b.removed === 1 && rem.length === 1 && rem[0].minutes === 5 && kw.length === 1 && kw[0].minutes === 10;
  })());
  check('reminder trigger installer requests external_request + scriptapp scopes (FULL)', gas.scopeRequests.length >= 1 && gas.scopeRequests.every((q) => q.mode === 'FULL' &&
    q.scopes.join() === 'https://www.googleapis.com/auth/script.external_request,https://www.googleapis.com/auth/script.scriptapp'), gas.scopeRequests);
  gas.scopeRequests.length = 0;
  G.testTeamsNotification();
  check('testTeamsNotification requests the external_request scope first', gas.scopeRequests.length === 1 && gas.scopeRequests[0].scopes.join() === 'https://www.googleapis.com/auth/script.external_request', gas.scopeRequests);
  check('reminder trigger: remove leaves keepWarm', G.removeApprovalReminderTrigger() === 1 && gas.triggers.length === 1 && G.removeKeepWarmTrigger() === 1 && gas.triggers.length === 0);

  // test fixture: close every open permit directly in the sheet so only the ones below are pending
  pSheet.data.forEach((row, i) => { if (i > 0 && row && row[ph.indexOf('status')] === 'pending') row[ph.indexOf('status')] = 'closed'; });
  G.bumpDataVersion_();
  check('reminders: setup — nothing pending', !pSheet.getDataRange().getValues().slice(1).some((row) => row[ph.indexOf('status')] === 'pending'));

  setNow('2026-10-07T09:00:00');
  const fresh = () => { S = post({ action: 'login', username: 'admin', password: 'Admin-Pass-1' }).data.session; return { SR1: login('resp1'), SA1: login('area1') }; };
  let SS = fresh();
  const W = post(body({ responsible_id: ids.resp1, work_date: '2026-10-07' })).data;
  const remCards = () => gas.fetches.filter((f) => /^ค้างอนุมัติ/.test(JSON.parse(f.params.payload).attachments[0].content.body[0].items[0].text));
  const runAt = (iso) => { setNow(iso); return G.checkApprovalReminders(); };
  let rc0 = remCards().length;
  let x = runAt('2026-10-07T09:29:59');
  check('reminder: not before 30 min', x.ok && x.due === 0 && remCards().length === rc0, x);
  const dv0 = dv(), writes0 = gas.stats.writes, wm0 = (gas.cacheStore.get('wpwv') || {}).v;
  const pre = { tables: {} }; G.table_(pre, 'permits'); // a request that read the sheet before the reminder run
  x = runAt('2026-10-07T09:30:00');
  c = JSON.parse(remCards()[remCards().length - 1].params.payload);
  check('reminder #1 at 30 min: one card, @mentions the pending person', x.ok && x.due === 1 && x.sent === 1 && remCards().length === rc0 + 1 &&
    content(c).body[0].items[0].text === 'ค้างอนุมัติ 30 นาที — ' + W.permit_no && content(c).body[0].items[0].color === 'Attention' &&
    texts(c).includes('รออนุมัติขั้นที่ 0: ผู้รับผิดชอบงาน — <at>สมศักดิ์ รับผิดชอบ</at>') && texts(c).includes('แจ้งเตือนครั้งที่ 1/6') &&
    ents(c).length === 1 && ents(c)[0].mentioned.id === 'somsak@company.co.th' && !remCards()[remCards().length - 1].params.payload.includes(W.token), texts(c));
  check('reminder bookkeeping stored (count, time), data version NOT replaced', col(W.id, 'reminder_count') === '1' && col(W.id, 'last_reminder_at') === '2026-10-07 09:30:00' &&
    dv() === dv0 && gas.stats.writes === writes0 + 1, { dv0, dv: dv() });
  check('reminder: write mark replaced → a request that read the sheet before re-reads it under the lock', (gas.cacheStore.get('wpwv') || {}).v !== wm0 &&
    (() => { G.relockCtx_(pre); return Object.keys(pre.tables).length === 0; })());
  check('reminder: updated_at untouched (no false CONFLICT for open pages)', col(W.id, 'updated_at') === col(W.id, 'created_at'));
  x = runAt('2026-10-07T09:30:00');
  const x2 = runAt('2026-10-07T09:34:00');
  check('reminder: no duplicate across trigger runs', x.due === 0 && x2.due === 0 && remCards().length === rc0 + 1);
  x = runAt('2026-10-07T09:59:59');
  check('reminder: not again before 30 more minutes', x.due === 0);
  x = runAt('2026-10-07T10:00:00');
  c = JSON.parse(remCards()[remCards().length - 1].params.payload);
  check('reminder #2 at 60 min', x.due === 1 && content(c).body[0].items[0].text === 'ค้างอนุมัติ 60 นาที — ' + W.permit_no && texts(c).includes('แจ้งเตือนครั้งที่ 2/6'));
  ['10:30', '11:00', '11:30', '12:00'].forEach((hm, i) => { x = runAt('2026-10-07T' + hm + ':00'); check('reminder #' + (i + 3), x.due === 1); });
  check('reminder: 6 sent for this stage', col(W.id, 'reminder_count') === '6' && remCards().length === rc0 + 6);
  x = runAt('2026-10-07T12:30:00');
  const x3 = runAt('2026-10-07T15:00:00');
  check('reminder: max 6 per stage', x.due === 0 && x3.due === 0 && remCards().length === rc0 + 6);
  SS = fresh();
  check('stage change restarts the reminders', post({ action: 'assign_area', session: SS.SR1, id: W.id, area_owner_id: ids.area1 }).ok && col(W.id, 'reminder_count') === '0' && col(W.id, 'last_reminder_at') === '');
  check('new stage: none before 30 min', runAt('2026-10-07T15:29:00').due === 0);
  x = runAt('2026-10-07T15:30:00');
  c = JSON.parse(remCards()[remCards().length - 1].params.payload);
  check('new stage: reminder @mentions the area owner', x.due === 1 && texts(c).includes('รออนุมัติขั้นที่ 1: เจ้าของพื้นที่ — <at>อารี เจ้าของพื้นที่</at>') && ents(c)[0].mentioned.id === 'aree@company.co.th');
  // stage 3: the active จป.
  SS = fresh();
  post({ action: 'stage_decide', session: SS.SA1, id: W.id, decision: 'approve', sign: SIG });
  post({ action: 'stage_decide', session: SS.SR1, id: W.id, decision: 'approve', sign: SIG });
  x = runAt('2026-10-07T16:00:00');
  c = JSON.parse(remCards()[remCards().length - 1].params.payload);
  check('stage 3 reminder mentions the จป. (with e-mail)', x.due === 1 && texts(c).includes('รออนุมัติขั้นที่ 3: จป. (เจ้าหน้าที่ความปลอดภัย) — ') && texts(c).includes('<at>ผู้ดูแลระบบ จป.</at>') && ents(c).length === 1, texts(c));
  SS = fresh();
  post({ action: 'decide', session: S, id: W.id, decision: 'approve', sign: SIG });
  check('decided permit: reminders stop', runAt('2026-10-07T18:00:00').due === 0);
  // legacy pending permit (no stage_started_at) is never reminded
  delete gas.propStore.TEAMS_WEBHOOK_URL;
  post({ action: 'user_toggle', session: S, id: ids.resp1 }); post({ action: 'user_toggle', session: S, id: ids.resp2 }); post({ action: 'user_toggle', session: S, id: ids.both1 });
  const LG = post(body()).data; // no active responsible → legacy path (stage safety, no clock)
  post({ action: 'user_toggle', session: S, id: ids.resp1 }); post({ action: 'user_toggle', session: S, id: ids.resp2 }); post({ action: 'user_toggle', session: S, id: ids.both1 });
  check('no responsible accounts → submit goes straight to the จป. (no stage clock)', LG && col(LG.id, 'stage') === '' && col(LG.id, 'stage_started_at') === '' &&
    post({ action: 'permit', session: S, id: LG.id }).data.permit.stage === 'safety');
  const Z = post(body({ responsible_id: ids.resp1 })).data;
  const zc = col(Z.id, 'reminder_count');
  x = runAt('2026-10-08T09:00:00');
  check('no TEAMS_WEBHOOK_URL: reminders skipped, no bookkeeping', x.ok && x.skipped && col(Z.id, 'reminder_count') === zc);
  gas.propStore.TEAMS_WEBHOOK_URL = HOOK;
  rc0 = remCards().length;
  x = runAt('2026-10-08T09:00:00');
  check('legacy permit never reminded; workflow permit is', x.due === 1 && JSON.parse(remCards()[remCards().length - 1].params.payload).attachments[0].content.body[0].items[0].text.endsWith(Z.permit_no));
  // failures never throw and are not retried (at most once)
  gas.fetchMode.code = 500;
  x = runAt('2026-10-08T09:30:00');
  check('reminder: HTTP 500 → ok, counted, not sent', x.ok && x.due === 1 && x.sent === 0 && col(Z.id, 'reminder_count') === '2');
  gas.fetchMode.code = 202; gas.fetchMode.throws = 'boom ' + HOOK;
  x = runAt('2026-10-08T10:00:00');
  check('reminder: fetch exception → ok, no URL logged', x.ok && x.due === 1 && !gas.logs.some((l) => l.includes('WF-SECRET')));
  gas.fetchMode.throws = null;
  // quota cap per run
  const many = [1, 2, 3].map(() => post(body({ responsible_id: ids.resp1 })).data);
  const cap = G.WP_REMIND_PER_RUN;
  G.WP_REMIND_PER_RUN = 2;
  x = runAt('2026-10-08T11:00:00');
  const y = runAt('2026-10-08T11:05:00');
  G.WP_REMIND_PER_RUN = cap;
  check('reminder: at most WP_REMIND_PER_RUN cards per run, the rest next run', x.due === 2 && y.due === 2 && many.every((m) => col(m.id, 'reminder_count') === '1'), { x, y });
  // lock busy → skipped quietly
  const lk = G.LockService.getScriptLock(), orig = lk.tryLock;
  lk.tryLock = () => false;
  x = runAt('2026-10-08T12:00:00');
  lk.tryLock = orig;
  check('reminder: lock busy → skipped, nothing written', x.ok === false && x.skipped === 'busy');
  check('reminder: cards are valid Adaptive Cards', remCards().every((f) => { const m = JSON.parse(f.params.payload); return m.type === 'message' && m.attachments[0].content.type === 'AdaptiveCard'; }));

  // ================================================================ privacy / caches
  setNow('2026-10-08T13:00:00');
  SS = fresh();
  post({ action: 'my_tasks', session: SS.SR1 }); get({ action: 'responsibles' });
  const cached = [...gas.cacheStore.entries()].filter(([k]) => k.startsWith('wpc_')).map(([, e]) => e.v).join('\n');
  check('read cache: no e-mail / token / signature', cached.length > 0 && !/@company|data:image|"token"|password_hash/.test(cached));
  const payloads = gas.fetches.map((f) => f.params.payload).join('\n');
  check('cards: no tracking token / track link / signature anywhere', !/track\.html|[?&]t=|"token"|data:image|base64/.test(payloads));
  check('cards: e-mail only inside mention entities', gas.fetches.every((f) => {
    const cc = JSON.parse(f.params.payload).attachments[0].content;
    return !JSON.stringify(Object.assign({}, cc, { msteams: {} })).includes('@company');
  }));
  // my_tasks cache follows writes
  const before = post({ action: 'my_tasks', session: SS.SR1 }).data.count;
  post(body({ responsible_id: ids.resp1 }));
  check('my_tasks: a new permit appears at once (cache keyed by data version)', post({ action: 'my_tasks', session: SS.SR1 }).data.count === before + 1);
  check('every sheet write under LockService', gas.stats.unlockedWrites === 0, gas.stats.unlockedWrites);
  check('no server errors logged', !gas.logs.some((l) => l.startsWith('ERROR')), gas.logs.filter((l) => l.startsWith('ERROR')));

  // ================================================================ single-file paste
  const allGs = GS_ORDER.map((f) => fs.readFileSync(path.join(ROOT, 'apps-script', f), 'utf8')).join('\n');
  const g1 = createGas();
  vm.runInContext(allGs, g1.context, { filename: 'all.gs' });
  g1.context.now_ = () => new Date(g1.clock.now());
  g1.clock.offset = BKK('2026-10-09T09:00:00') - Date.now();
  g1.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Single-File-1';
  g1.context.setupSystem();
  g1.propStore.TEAMS_WEBHOOK_URL = HOOK;
  const p1 = (b) => JSON.parse(g1.context.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
  const s1 = p1({ action: 'login', username: 'admin', password: 'Single-File-1' }).data.session;
  const rid = p1({ action: 'user_save', session: s1, username: 'rr1', fullname: 'R One', roles: ['responsible'], email: 'r1@x.co', password: 'r1-pass' }).data.id;
  const aid = p1({ action: 'user_save', session: s1, username: 'aa1', fullname: 'A One', roles: ['area_owner'], email: 'a1@x.co', password: 'a1-pass' }).data.id;
  const sr = p1({ action: 'login', username: 'rr1', password: 'r1-pass' }).data.session, sa = p1({ action: 'login', username: 'aa1', password: 'a1-pass' }).data.session;
  const sp = p1(body({ responsible_id: rid, work_date: '2026-10-09' })).data;
  const ok1 = p1({ action: 'assign_area', session: sr, id: sp.id, area_owner_id: aid }).ok && p1({ action: 'stage_decide', session: sa, id: sp.id, decision: 'approve', sign: SIG }).ok &&
    p1({ action: 'stage_decide', session: sr, id: sp.id, decision: 'approve', sign: SIG }).ok && p1({ action: 'decide', session: s1, id: sp.id, decision: 'approve', sign: SIG }).ok;
  g1.clock.offset += 31 * 60000;
  const sp2 = p1(body({ responsible_id: rid, work_date: '2026-10-09' })).data;
  g1.clock.offset += 31 * 60000;
  const rem = g1.context.checkApprovalReminders();
  check('concatenated .gs: full workflow, reminders + trigger install work', ok1 && sp2 && rem.ok && rem.due === 1 &&
    g1.context.installApprovalReminderTrigger().installed === 1 && g1.fetches.length === 7, { ok1, rem, n: g1.fetches.length });

  return { passed, failures };
};
