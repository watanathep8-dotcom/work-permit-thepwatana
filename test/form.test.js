/* FM-MR-58 paper-form data model: checklist ids / PPE options / legacy (v1) rows,
 * the stated head count, checklist ticked by the stage approvers, the approvals
 * table (rows 1–2 sign their own inspection cells) — end-to-end through
 * doGet/doPost on the in-memory Apps Script mocks.  Run: node test/run.js */
'use strict';
const path = require('path');
const { createGas } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const GS_ORDER = ['Data.gs', 'Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs'];
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

module.exports = function run() {
  let passed = 0;
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) { passed++; return; }
    failures.push('form: ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 500) : ''));
  };

  const gas = createGas();
  gas.load(path.join(ROOT, 'apps-script'), GS_ORDER);
  const G = gas.context, D = G.WP_DATA;
  const BKK = (iso) => new Date(iso + '+07:00').getTime();
  gas.clock.offset = BKK('2026-10-06T08:00:00') - Date.now();
  const post = (b) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());

  // ================================================================ data model (Data.gs) = the paper form
  const WT = D.workTypes;
  check('6 ลักษณะงาน in form order with the form wording', Object.keys(WT).join() === 'general,hot,height,electric,chemical,confined' &&
    Object.values(WT).map((w) => w.label).join('|') === 'งานทั่วไป/งานติดตั้ง/งานยกเคลื่อนย้าย|งานที่ก่อให้เกิดประกายไฟ|งานที่สูงตั้งแต่ 2 เมตร/งานติดตั้ง/งานยกเคลื่อนย้าย|งานที่เกี่ยวกับไฟฟ้า ตั้งแต่ 220 โวลต์|งานขนถ่ายสารเคมี/น้ำมัน/กากของเสียอันตราย|งานที่อับอากาศ');
  check('checklist order covers every work type once', D.checklistOrder.slice().sort().join() === Object.keys(WT).sort().join());
  const all = [];
  Object.values(WT).forEach((w) => w.items.forEach((it) => all.push(it.id)));
  check('checklist ids unique', new Set(all).size === all.length);
  const item = (k, id) => WT[k].items.find((x) => x.id === id);
  const opts = (k, id) => item(k, id).options.join('|');
  check('งานทั่วไป PPE + Other, เอกสาร / อื่นๆ as text', opts('general', 'g1') === 'ถุงมือ|แว่นนิรภัย|หมวกนิรภัย|หน้ากากกันฝุ่น/สารเคมี|รองเท้านิรภัย|กระบังหน้า|หน้ากากเชื่อม' &&
    !item('general', 'g1').noOther && item('general', 'g2doc').type === 'text' && item('general', 'g3').type === 'text');
  check('ประกายไฟ 1–7 + PPE 8 + เอกสาร / อื่นๆ', ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'].every((id) => item('hot', id).type === 'check') &&
    opts('hot', 'h8') === 'ถุงมือป้องกันความร้อน|รองเท้านิรภัย|แว่นนิรภัย/กระบังหน้า|หน้ากากเชื่อม/กันฝุ่นและไอโลหะ|หมวกนิรภัย|ชุดป้องกันร่างกาย|เอี๊ยมหนังกันสะเก็ดไฟ' &&
    item('hot', 'h9').type === 'text' && item('hot', 'h10').type === 'text');
  check('ที่สูง 1.1–1.5, 2.1–2.5, 3, 4, 5 PPE, 6.1–6.4, 7', ['ht11', 'ht12', 'ht13', 'ht14', 'ht15', 'ht21', 'ht22', 'ht23', 'ht24', 'ht25', 'ht3', 'ht4', 'ht61', 'ht62', 'ht63'].every((id) => item('height', id).type === 'check') &&
    opts('height', 'ht5') === 'ถุงมือ|แว่นนิรภัย|รองเท้านิรภัย|กระบังหน้า|หมวกนิรภัย|หน้ากากกันสารเคมี|เข็มขัดนิรภัย' && item('height', 'ht64').type === 'checktext' &&
    /ปจ\.1 \/ ปจ\.2/.test(item('height', 'ht61').label) && /Lifting Plan/.test(item('height', 'ht63').label) && item('height', 'ht7').type === 'text' &&
    /ตลอดเวลา/.test(item('height', 'ht4').label) && /รถกระเช้า/.test(item('height', 'ht_g6').label));
  check('สารเคมี 1–8 + PPE 9 + 10 เอกสาร + 11 อื่นๆ', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].every((id) => item('chemical', id).type === 'check') &&
    opts('chemical', 'c9') === 'ถุงมือกันสารเคมี|แว่นนิรภัย|รองเท้านิรภัย|หมวกนิรภัย|หน้ากากกันสารเคมี|ชุดป้องกันสารเคมี' && /แผงกั้น/.test(item('chemical', 'c4').label) &&
    item('chemical', 'c10').type === 'text' && item('chemical', 'c11').type === 'text');
  check('ไฟฟ้า 1–5, 6 ข้อกำหนด, 7 PPE (Arc Flash / Class E), 8 เอกสาร + LOTO', ['e1', 'e2', 'e3', 'e4', 'e5'].every((id) => item('electric', id).type === 'check') &&
    opts('electric', 'e7') === 'ถุงมือป้องกันไฟฟ้า|ชุดป้องกัน Arc Flash|กระบังหน้า|หมวกนิรภัย Class E|รองเท้านิรภัยฉนวนไฟฟ้า' && item('electric', 'e8').type === 'checktext' &&
    WT.electric.loto === true && /ผู้ปฏิบัติงาน/.test(item('electric', 'e3').label));
  check('confined (FM-EMR-46) kept', WT.confined.form === 'FM-EMR-46' && item('confined', 'cs4_12').other && item('confined', 'cs6_18').type === 'checktext');
  check('หมายเหตุ 8 / ระเบียบ 9 / ข้อตกลง 2 + กากอุตสาหกรรม', D.remarks.length === 8 && /อับอากาศ/.test(D.remarks[7]) && D.safetyRules.length === 9 &&
    /ก๊าซ/.test(D.safetyRules[7]) && D.safetyAgreement.length === 2 && D.wasteRules.items.length === 1 && D.approvalStatement.length === 3);
  check('approvals table rows / columns as on the form', Object.values(D.inspectRoles).join('|') === '1. ผู้รับผิดชอบงาน|2. เจ้าของพื้นที่โครงการ|3. เจ้าหน้าที่ความปลอดภัย' &&
    Object.keys(D.inspectRoles).join() === 'contractor,owner,safety' &&
    Object.keys(D.inspectStages).join() === 'permit,before,during,after');
  // every legacy mapping points at an option that exists now; retired ids are not current ids
  const L = D.checklistLegacy;
  const ix = {}; Object.keys(WT).forEach((k) => WT[k].items.forEach((it) => { ix[it.id] = it; }));
  check('legacy option map targets exist', Object.entries(L.options).every(([id, m]) => ix[id] && ix[id].type === 'ppe' && Object.values(m).every((n) => n === '' || ix[id].options.includes(n))));
  check('retired ids are not current ids', Object.keys(L.retired).every((id) => !ix[id] && WT[L.retired[id].type]));
  check('no paper-form typos left', !/อุปกรณ์งป้องกัน|สวนใส่|ตลวดเวลา|รถถระเช้า|ผู้ปฏิบัตางน|แผนกั้น|ก๊าช|ถาดรับรอบ/.test(JSON.stringify(D)));

  // ================================================================ upgrade function (shared with the browser)
  const U = G.wpUpgradeChecklist_;
  const v1 = { g1: { sel: ['ถุงมือ', 'แว่นครอบตา', 'หน้ากากกันสารเคมี'], other: '' }, g2: true, g3: 'นั่งร้าน', h1: true,
    h8: { sel: ['ถุงมือ', 'กระบังหน้า', 'แว่นครอบตา', 'หน้ากากเชื่อม', 'หน้ากากกันสารเคมี'], other: 'ผ้าคลุม' },
    ht5: { sel: ['แว่นครอบตา', 'เข็มขัดนิรภัย'], other: '' }, c9: { sel: ['ถุงมือ', 'ชุดป้องกันสารเคมี'], other: '' },
    e7: { sel: ['ถุงมือ', 'หมวกนิรภัย'], other: '' }, e6: { on: true, text: 'ห้ามเปิดเบรกเกอร์' }, ht64: { on: true, text: 'รถเครน' } };
  const u = U(JSON.parse(JSON.stringify(v1)));
  check('upgrade: equivalent PPE options renamed', u.g1.sel.join('|') === 'ถุงมือ|แว่นนิรภัย|หน้ากากกันฝุ่น/สารเคมี' && u.ht5.sel.join('|') === 'แว่นนิรภัย|เข็มขัดนิรภัย' &&
    u.h8.sel.join('|') === 'แว่นนิรภัย/กระบังหน้า|หน้ากากเชื่อม/กันฝุ่นและไอโลหะ', u);
  check('upgrade: options without an equivalent → Other text (nothing lost)', u.h8.other === 'ผ้าคลุม, ถุงมือ, หน้ากากกันสารเคมี' && u.c9.other === 'ถุงมือ' &&
    u.c9.sel.join() === 'ชุดป้องกันสารเคมี' && u.e7.sel.length === 0 && u.e7.other === 'ถุงมือ, หมวกนิรภัย', u);
  check('upgrade: retired check box → _legacy under its work type', !('g2' in u) && u._legacy.general.join() === '✓ 2. เอกสารรับรองที่เกี่ยวข้อง', u);
  check('upgrade: unchanged ids kept, version set', u.h1 === true && u.g3 === 'นั่งร้าน' && u.e6.text === 'ห้ามเปิดเบรกเกอร์' && u.ht64.on === true && u._v === D.config.checklistVersion);
  check('upgrade: current version untouched (idempotent)', JSON.stringify(U(u)) === JSON.stringify(u) && U({ g2: false })._legacy === undefined);
  check('upgrade: junk input → empty current checklist', JSON.stringify(U(null)) === JSON.stringify({ _v: D.config.checklistVersion }) && U([1])._v === D.config.checklistVersion);

  // ================================================================ backend
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Admin-Pass-1';
  G.setupSystem();
  gas.propStore.WP_RESET_PASSWORD = 'Reset-Pass-1';
  const S = post({ action: 'login', username: 'admin', password: 'Admin-Pass-1' }).data.session;
  const ss = gas.spreadsheets.get(gas.propStore.WP_SPREADSHEET_ID), pSheet = ss.getSheetByName('permits');
  const ph = G.WP_SCHEMA.permits;
  const body = (o = {}) => Object.assign({
    action: 'submit', company: D.companies[0], permit_type: 'contractor', work_types: ['general', 'hot', 'electric'],
    work_date: '2026-10-06', time_from: '08:00', time_to: '17:00', requester_title: 'นาย', requester_name: 'ผู้ขอ',
    requester_company: 'ผู้รับเหมา ก', requester_phone: '0812345678', owner_name: 'เจ้าของงาน', location: 'อาคาร 1', job_detail: 'งาน',
    workers: [{ name: 'ก' }], requester_sign: SIG
  }, o);

  // -- v2 checklist (the current page) is stored as sent (cleaned)
  let r = post(body({ worker_count: 12, checklist: { _v: 2, g1: { sel: ['แว่นนิรภัย', 'แว่นครอบตา'], other: 'ปลั๊กอุดหู' }, g2doc: 'ใบรับรองเครื่องเชื่อม', h8: { sel: ['เอี๊ยมหนังกันสะเก็ดไฟ'], other: '' }, h9: 'x', e8: { on: true, text: 'ใบอนุญาตช่างไฟ' }, g2: true, _legacy: { general: ['ปลอม'], bogus: ['x'] } } }));
  check('submit v2 ok', r.ok, r);
  const A = r.data;
  let p = post({ action: 'permit', no: A.permit_no, t: A.token }).data.permit;
  check('v2: options kept (unknown dropped), texts stored', p.checklist.g1.sel.join() === 'แว่นนิรภัย' && p.checklist.g1.other === 'ปลั๊กอุดหู' && p.checklist.g2doc === 'ใบรับรองเครื่องเชื่อม' &&
    p.checklist.h8.sel.join() === 'เอี๊ยมหนังกันสะเก็ดไฟ' && p.checklist.e8.text === 'ใบอนุญาตช่างไฟ' && p.checklist._v === 2, p.checklist);
  check('v2: retired id ignored, _legacy limited to known work types', !('g2' in p.checklist) && JSON.stringify(p.checklist._legacy) === '{"general":["ปลอม"]}', p.checklist);
  check('stated head count ≥ typed rows ("จำนวน ... คน โดยมีรายชื่อตามเอกสารแนบ")', p.worker_count === 12 && p.workers.length === 1);
  r = post(body({ worker_count: 0, workers: [{ name: 'ก' }, { name: 'ข' }] }));
  check('head count never below the typed rows', post({ action: 'permit', no: r.data.permit_no, t: r.data.token }).data.permit.worker_count === 2);
  r = post(body({ worker_count: 'abc' }));
  check('head count: junk → typed rows', post({ action: 'permit', no: r.data.permit_no, t: r.data.token }).data.permit.worker_count === 1);

  // -- a row stored by the previous version (v1 JSON in the sheet) still works
  r = post(body());
  const O = r.data;
  const rowIdx = pSheet.getDataRange().getValues().findIndex((x, i) => i > 0 && String(x[0]) === String(O.id));
  pSheet.data[rowIdx][ph.indexOf('checklist')] = JSON.stringify(v1); // exactly what the previous version stored
  pSheet.data[rowIdx][ph.indexOf('loto')] = JSON.stringify([{ item: 'MDB-1', t_on: '08:00', by_on: 'A' }]);
  G.bumpDataVersion_();
  p = post({ action: 'permit', session: S, id: O.id }).data.permit;
  check('old row: read as stored (the page upgrades it for display)', JSON.stringify(p.checklist) === JSON.stringify(v1));
  const editBody = (o = {}) => Object.assign(body(), { action: 'update_permit', session: S, id: O.id, resetPassword: 'Reset-Pass-1' }, o);
  r = post(editBody({ checklist: undefined }));
  check('old row: edit without checklist → no change (stored v1 compares upgraded)', r.ok && r.data.changed.length === 0, r);
  r = post(editBody({ checklist: U(JSON.parse(JSON.stringify(v1))) }));
  check('old row: the upgraded checklist as the page sends it back → no change', r.ok && r.data.changed.length === 0, r);
  r = post({ action: 'save_review', session: S, id: O.id, checklist: v1, loto: [{ item: 'MDB-1' }], inspections: {} });
  p = post({ action: 'permit', session: S, id: O.id }).data.permit;
  check('old row: an old cached page saving v1 ids → upgraded, nothing lost', r.ok && p.checklist._v === 2 && p.checklist.h8.other === 'ผ้าคลุม, ถุงมือ, หน้ากากกันสารเคมี' &&
    p.checklist._legacy.general[0] === '✓ 2. เอกสารรับรองที่เกี่ยวข้อง' && p.checklist.e6.text === 'ห้ามเปิดเบรกเกอร์', p.checklist);
  r = post({ action: 'save_review', session: S, id: O.id, checklist: p.checklist, inspections: {} });
  check('saving the upgraded checklist again keeps _legacy', r.ok && post({ action: 'permit', session: S, id: O.id }).data.permit.checklist._legacy.general.length === 1);

  // ================================================================ workflow: approvers tick the checklist, sign their inspection cells
  const mk = (u, n, roles) => post({ action: 'user_save', session: S, username: u, fullname: n, roles, password: 'pass-' + u }).data.id;
  const RID = mk('resp', 'สมศักดิ์ รับผิดชอบ', ['responsible']), AID = mk('area', 'อารี พื้นที่', ['area_owner']), BID = mk('both', 'ทวี สองบทบาท', ['responsible', 'area_owner']);
  mk('other', 'คนอื่น', ['area_owner']);
  const login = (u) => post({ action: 'login', username: u, password: 'pass-' + u }).data.session;
  const SR = login('resp'), SA = login('area'), SB = login('both'), SO = login('other');
  r = post(body({ responsible_id: RID, work_types: ['hot', 'electric'] }));
  const W = r.data;
  post({ action: 'assign_area', session: SR, id: W.id, area_owner_id: AID });
  r = post({ action: 'stage_decide', session: SA, id: W.id, decision: 'approve', sign: SIG, comment: 'พื้นที่พร้อม', checklist: { _v: 2, h1: true, h8: { sel: ['หมวกนิรภัย'], other: '' } }, loto: [{ item: 'ห้ามใช้' }] });
  p = post({ action: 'permit', session: S, id: W.id }).data.permit;
  check('area owner approves + ticks the checklist / LOTO', r.ok && p.checklist.h1 === true && p.checklist.h8.sel.join() === 'หมวกนิรภัย' && p.loto[0].item === 'ห้ามใช้', p);
  r = post({ action: 'stage_decide', session: SR, id: W.id, decision: 'approve', sign: SIG });
  p = post({ action: 'permit', session: S, id: W.id }).data.permit;
  check('approve without checklist keeps the earlier ticks', r.ok && p.checklist.h1 === true && p.stage === 'safety');
  check('inspect_sign before approval → CONFLICT', post({ action: 'inspect_sign', session: SA, id: W.id, stage: 'before' }).code === 'CONFLICT');
  // จป. cannot type rows 1–2 "การอนุญาตทำงาน" of a workflow permit (they are the stage signatures)
  post({ action: 'save_review', session: S, id: W.id, checklist: p.checklist, inspections: { owner: { permit: { name: 'ปลอม' } }, contractor: { permit: { name: 'ปลอม' } } } });
  p = post({ action: 'permit', session: S, id: W.id }).data.permit;
  check('save_review: workflow rows 1–2 permit cells not typed by the จป.', !(p.inspections.owner || {}).permit && !(p.inspections.contractor || {}).permit, p.inspections);
  check('จป. approves', post({ action: 'decide', session: S, id: W.id, decision: 'approve', sign: SIG }).ok);
  r = post({ action: 'inspect_sign', session: SA, id: W.id, stage: 'before' });
  check('area owner signs own row "ก่อนเริ่มงาน"', r.ok && r.data.inspections.owner.before.name === 'อารี พื้นที่' && /^2026-10-06/.test(r.data.inspections.owner.before.at), r);
  check('… twice → CONFLICT (never overwritten)', post({ action: 'inspect_sign', session: SA, id: W.id, stage: 'before' }).code === 'CONFLICT');
  check('… not another row', post({ action: 'inspect_sign', session: SA, id: W.id, stage: 'during', row: 'contractor' }).code === 'FORBIDDEN');
  check('… "permit" column is not an inspection', post({ action: 'inspect_sign', session: SA, id: W.id, stage: 'permit' }).ok === false);
  r = post({ action: 'inspect_sign', session: SR, id: W.id, stage: 'after' });
  check('responsible signs own row "หลังเสร็จงาน"', r.ok && r.data.inspections.contractor.after.name === 'สมศักดิ์ รับผิดชอบ' && r.data.inspections.owner.before.name === 'อารี พื้นที่', r);
  check('unassigned area owner → NOT_FOUND', post({ action: 'inspect_sign', session: SO, id: W.id, stage: 'during' }).code === 'NOT_FOUND');
  check('จป. (not assigned) → NOT_FOUND / FORBIDDEN', ['NOT_FOUND', 'FORBIDDEN'].includes(post({ action: 'inspect_sign', session: S, id: W.id, stage: 'during' }).code));
  check('anonymous → AUTH', post({ action: 'inspect_sign', id: W.id, stage: 'during' }).code === 'AUTH');
  const logs = post({ action: 'permit', session: S, id: W.id }).data.logs.filter((l) => l.action === 'inspect');
  check('inspect_sign logged', logs.length === 2 && /ก่อนเริ่มงาน/.test(logs[0].note) && logs[1].by_name === 'สมศักดิ์ รับผิดชอบ', logs);
  // one person holding both assignments chooses the row
  r = post(body({ responsible_id: BID, work_types: ['general'] }));
  const B = r.data;
  post({ action: 'assign_area', session: SB, id: B.id, area_owner_id: BID });
  post({ action: 'stage_decide', session: SB, id: B.id, decision: 'approve', sign: SIG });
  post({ action: 'stage_decide', session: SB, id: B.id, decision: 'approve', sign: SIG });
  post({ action: 'decide', session: S, id: B.id, decision: 'approve', sign: SIG });
  check('both rows: row required', post({ action: 'inspect_sign', session: SB, id: B.id, stage: 'during' }).code === 'FORBIDDEN');
  r = post({ action: 'inspect_sign', session: SB, id: B.id, stage: 'during', row: 'contractor' });
  check('both rows: picks row 2', r.ok && r.data.inspections.contractor.during.name === 'ทวี สองบทบาท' && !(r.data.inspections.owner || {}).during, r);
  post({ action: 'decide', session: S, id: B.id, decision: 'close' });
  check('closed permit → CONFLICT', post({ action: 'inspect_sign', session: SB, id: B.id, stage: 'after', row: 'owner' }).code === 'CONFLICT');
  check('every sheet write happened under LockService', gas.stats.unlockedWrites === 0);

  return { passed, failures };
};
