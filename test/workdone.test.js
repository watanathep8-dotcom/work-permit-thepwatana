/* "แจ้งเสร็จงาน" (action work_done, the requester's tracking token) + the merged approvals
 * column of the view page: photos (types / magic bytes / count / size limits), private Drive
 * storage, new permits columns on a live sheet without them, log, data version, Teams card
 * @mentioning responsible + area owner + จป., access through action=file, delete, and the
 * browser helpers in parts.js — end-to-end on the Apps Script mocks.  Run: node test/run.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGas } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const HOOK = 'https://prod-01.example.logic.azure.com/workflows/wf/triggers/manual/paths/invoke?sig=WD-SECRET';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const withHead = (head, n = 64) => { const b = Buffer.alloc(Math.max(n, head.length), 0x20); Buffer.from(head).copy(b); return b; };
const ftyp = (brand) => { const b = Buffer.alloc(64, 0); b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'latin1'); b.write(brand, 8, 'latin1'); return b; };
const IMG = {
  jpg: withHead([0xff, 0xd8, 0xff, 0xe0]), jpeg: withHead([0xff, 0xd8, 0xff, 0xdb]), png: withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif: withHead('GIF89a'), bmp: withHead('BM'), tif: withHead([0x49, 0x49, 0x2a, 0x00]), tiff: withHead([0x4d, 0x4d, 0x00, 0x2a]),
  webp: (() => { const b = withHead('RIFF'); b.write('WEBPVP8 ', 8, 'latin1'); return b; })(), heic: ftyp('heic'), heif: ftyp('mif1')
};

module.exports = function run() {
  let passed = 0;
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) { passed++; return; }
    failures.push('work_done: ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 500) : ''));
  };

  const gas = createGas();
  gas.load(path.join(ROOT, 'apps-script'), ['Data.gs', 'Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs']);
  const G = gas.context, D = G.WP_DATA, C = D.config;
  const BKK = (iso) => new Date(iso + '+07:00').getTime();
  gas.clock.offset = BKK('2026-10-08T08:00:00') - Date.now();
  const post = (b) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
  const dv = () => (gas.cacheStore.get('wpdv') || {}).v;
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Admin-Pass-1';
  G.setupSystem();
  gas.propStore.WP_RESET_PASSWORD = 'Reset-Pass-1';
  let S = post({ action: 'login', username: 'admin', password: 'Admin-Pass-1' }).data.session;
  const ss = gas.spreadsheets.get(gas.propStore.WP_SPREADSHEET_ID), pSheet = ss.getSheetByName('permits');
  const folderId = gas.propStore.WP_FOLDER_ID;
  const WD_COLS = ['work_done_at', 'work_done_note', 'work_done_photos'];

  // ---- live sheet set up before this change: no work_done_* columns
  check('setupSystem creates the optional work_done_* columns', WD_COLS.every((h) => pSheet.data[0].includes(h)));
  WD_COLS.forEach((h) => { const ci = pSheet.data[0].indexOf(h); pSheet.data.forEach((row) => row.splice(ci, 1)); });
  G.bumpDataVersion_();
  check('limits: ≤ 10 photos, each ≤ uploadMaxMb, total ≤ requestMaxMb (base64 under ~50 MB POST)',
    C.workDonePhotoMax === 10 && C.requestMaxMb * 4 / 3 + 2 < 50 && C.uploadMaxMb <= C.requestMaxMb &&
    C.workDonePhotoExt.join() === 'jpg,jpeg,png,gif,webp,heic,heif,bmp,tif,tiff');

  // ---- people: responsible + area owner (with e-mail), a 2nd จป. without e-mail, an unrelated responsible
  post({ action: 'user_save', session: S, id: 1, fullname: 'ผู้ดูแลระบบ จป.', roles: ['safety'], email: 'safety.admin@company.co.th', password: '' });
  const mk = (u, n, roles, email) => post({ action: 'user_save', session: S, username: u, fullname: n, roles, email: email || '', password: 'pass-' + u }).data.id;
  const RID = mk('resp', 'สมศักดิ์ รับผิดชอบ', ['responsible'], 'somsak@company.co.th');
  const AID = mk('area', 'อารี พื้นที่', ['area_owner'], 'aree@company.co.th');
  mk('safety2', 'จป. ไม่มีเมล', ['safety']);
  mk('resp2', 'คนอื่น', ['responsible'], 'other@company.co.th');
  const login = (u) => post({ action: 'login', username: u, password: 'pass-' + u }).data.session;
  const SR = login('resp'), SR2 = login('resp2');
  let SA = login('area');

  const body = (o = {}) => Object.assign({
    action: 'submit', company: D.companies[0], permit_type: 'contractor', work_types: ['hot'], responsible_id: RID,
    work_date: '2026-10-08', time_from: '08:00', time_to: '17:00', requester_title: 'นาย', requester_name: 'ผู้รับเหมา ทดสอบ',
    requester_company: 'ผู้รับเหมา ก', requester_phone: '0812345678', owner_name: 'เจ้าของงาน', location: 'อาคาร 1', job_detail: 'เชื่อม',
    requester_sign: SIG
  }, o);
  const approve = (P) => {
    post({ action: 'assign_area', session: SR, id: P.id, area_owner_id: AID });
    post({ action: 'stage_decide', session: SA, id: P.id, decision: 'approve', sign: SIG });
    post({ action: 'stage_decide', session: SR, id: P.id, decision: 'approve', sign: SIG });
    return post({ action: 'decide', session: S, id: P.id, decision: 'approve', sign: SIG }).ok;
  };
  const photo = (name, buf) => ({ name, base64: b64(buf) });
  const wd = (P, o = {}) => post(Object.assign({ action: 'work_done', no: P.permit_no, t: P.token, photos: [photo('a.jpg', IMG.jpg)] }, o));

  // ================================================================ not yet allowed
  const W = post(body()).data;
  const files0 = gas.files.size;
  let r = wd(W);
  check('pending permit → CONFLICT (nothing stored)', r.code === 'CONFLICT' && /อนุมัติแล้ว/.test(r.error) && gas.files.size === files0, r);
  check('wrong token → NOT_FOUND', wd(W, { t: 'a'.repeat(32) }).code === 'NOT_FOUND');
  check('no token → NOT_FOUND', wd(W, { t: '' }).code === 'NOT_FOUND');
  check('session + id instead of the token → NOT_FOUND', post({ action: 'work_done', session: S, id: W.id, photos: [photo('a.jpg', IMG.jpg)] }).code === 'NOT_FOUND');
  check('workflow permit approved', approve(W));

  // ================================================================ validation (before any Drive upload)
  const bad = (name, photos, re, code) => {
    const before = gas.files.size;
    const x = wd(W, { photos });
    check(name, !x.ok && re.test(x.error) && (!code || x.code === code) && gas.files.size === before, x);
  };
  bad('no photos → refused', [], /อย่างน้อย 1 รูป/);
  bad('photos not an array → refused', { name: 'a.jpg' }, /อย่างน้อย 1 รูป/);
  bad('11 photos → refused', Array.from({ length: 11 }, (_, i) => photo('p' + i + '.jpg', IMG.jpg)), /ไม่เกิน 10 รูป/, 'TOO_LARGE');
  bad('PDF (not an image) → refused', [photo('report.pdf', withHead('%PDF-1.7'))], /รูปภาพเท่านั้น/);
  bad('no extension → refused', [photo('jpg', IMG.jpg)], /รูปภาพเท่านั้น/);
  bad('EXE renamed .jpg → refused', [photo('x.jpg', withHead('MZ\x90\x00'))], /ไม่ตรงกับเนื้อหา/);
  bad('PNG renamed .gif → refused', [photo('x.gif', IMG.png)], /ไม่ตรงกับเนื้อหา/);
  bad('AVIF renamed .heic → refused', [photo('x.heic', ftyp('avif'))], /ไม่ตรงกับเนื้อหา/);
  bad('invalid base64 → refused', [{ name: 'x.jpg', base64: '%%%' }], /ไม่สำเร็จ/);
  const big = Buffer.alloc(C.uploadMaxMb * 1048576 + 1, 0x20); Buffer.from([0xff, 0xd8, 0xff]).copy(big);
  bad('a photo over uploadMaxMb → refused', [photo('big.jpg', big)], /ใหญ่เกิน 10MB/, 'TOO_LARGE');
  const nine = Buffer.alloc(9 * 1048576, 0x20); Buffer.from([0xff, 0xd8, 0xff]).copy(nine);
  bad('total over requestMaxMb → refused', [photo('a.jpg', nine), photo('b.jpg', nine), photo('c.jpg', nine)], /รวมกันใหญ่เกิน 25MB/, 'TOO_LARGE');
  check('nothing recorded by the refused calls', !post({ action: 'permit', no: W.permit_no, t: W.token }).data.permit.work_done_at);

  // ================================================================ happy path
  gas.propStore.TEAMS_WEBHOOK_URL = HOOK;
  const fetches0 = gas.fetches.length, dv0 = dv(), driveBefore = gas.files.size, sharing0 = gas.stats.sharingCalls;
  const ten = Object.keys(IMG).map((ext, i) => photo('รูป' + i + '.' + (i % 2 ? ext.toUpperCase() : ext), IMG[ext]));
  r = wd(W, { photos: ten, note: 'เก็บอุปกรณ์และทำความสะอาดพื้นที่เรียบร้อย\n=ไม่ใช่สูตร' });
  check('10 photos of every accepted type + note → ok', r.ok && r.data.photos === 10 && /^2026-10-08 /.test(r.data.work_done_at), r);
  check('data version bumped', dv() !== dv0);
  const hdr = pSheet.data[0];
  check('old sheet: work_done_* columns created on write', WD_COLS.every((h) => hdr.includes(h)));
  const row = pSheet.data.find((x) => String(x[0]) === String(W.id));
  const stored = JSON.parse(row[hdr.indexOf('work_done_photos')]);
  check('photos stored privately in the app Drive folder', gas.files.size === driveBefore + 10 && gas.stats.sharingCalls === sharing0 &&
    stored.every((x) => gas.files.get(x.file).folder.getId() === folderId && /^[a-f0-9]{16}$/.test(x.fid)), stored);
  check('note stored (formula guarded)', row[hdr.indexOf('work_done_note')] === "เก็บอุปกรณ์และทำความสะอาดพื้นที่เรียบร้อย\n=ไม่ใช่สูตร");
  let v = post({ action: 'permit', no: W.permit_no, t: W.token }).data;
  let p = v.permit;
  check('permit: status stays approved, work_done_* returned', p.status === 'approved' && p.work_done_at === r.data.work_done_at &&
    /เรียบร้อย/.test(p.work_done_note) && p.work_done_photos.length === 10, p);
  check('permit: photo list = fid / name / mime / size only (no Drive id)', p.work_done_photos.every((f) => Object.keys(f).sort().join() === 'fid,mime,name,size') &&
    p.work_done_photos[0].name === 'รูป0.jpg' && p.work_done_photos.find((f) => /\.HEIC$/i.test(f.name)).mime === 'image/heic' &&
    !stored.some((x) => JSON.stringify(post({ action: 'permit', session: S, id: W.id })).includes(x.file)));
  const log = v.logs[v.logs.length - 1];
  check('permit_logs row "ผู้รับเหมาแจ้งเสร็จงาน"', log.action === 'work_done' && /^ผู้รับเหมาแจ้งเสร็จงาน \(รูปถ่าย 10 รูป\)/.test(log.note) && log.by_name === 'นาย ผู้รับเหมา ทดสอบ', log);
  const list = post({ action: 'permits', session: S }).data.rows.find((x) => x.id === W.id);
  check('admin list row carries work_done_at (indicator)', list && list.work_done_at === p.work_done_at, list);

  // Teams card
  check('one Teams card sent', gas.fetches.length === fetches0 + 1, gas.fetches.length - fetches0);
  const msg = JSON.parse(gas.fetches[gas.fetches.length - 1].params.payload);
  const content = msg.attachments[0].content, txt = JSON.stringify(content);
  const facts = {}; (content.body.find((b) => b.type === 'FactSet').facts || []).forEach((f) => { facts[f.title] = f.value; });
  check('card title "ผู้รับเหมาแจ้งเสร็จงาน <no>"', content.body[0].items[0].text === 'ผู้รับเหมาแจ้งเสร็จงาน ' + W.permit_no, content.body[0]);
  const ents = (content.msteams.entities || []).map((e) => e.mentioned.id).sort();
  check('mentions: responsible + area owner + จป. (by e-mail)', ents.join() === 'aree@company.co.th,safety.admin@company.co.th,somsak@company.co.th', ents);
  const line = content.body.find((b) => b.type === 'TextBlock' && /<at>/.test(b.text)).text;
  check('mention line: <at>names</at>, จป. without e-mail as plain name, never the unrelated responsible',
    /<at>สมศักดิ์ รับผิดชอบ<\/at>/.test(line) && /<at>อารี พื้นที่<\/at>/.test(line) && /<at>ผู้ดูแลระบบ จป\.<\/at>/.test(line) &&
    /จป\. ไม่มีเมล/.test(line) && !/<at>จป\. ไม่มีเมล/.test(line) && !/คนอื่น/.test(txt) && line.indexOf('สมศักดิ์') < line.indexOf('ผู้ดูแลระบบ'), line);
  check('facts: no / company / location / work date / requester / photos', facts['เลขที่'] === W.permit_no && facts['บริษัท (พื้นที่)'] === D.companies[0] &&
    facts['สถานที่ปฏิบัติงาน'] === 'อาคาร 1' && /8 ต\.ค\. 2569 เวลา 08:00–17:00/.test(facts['วันที่ปฏิบัติงาน']) &&
    facts['ผู้ขออนุญาต'] === 'นาย ผู้รับเหมา ทดสอบ (ผู้รับเหมา ก)' && facts['รูปถ่ายเมื่อเสร็จงาน'] === '10 รูป', facts);
  check('note block + admin view button; no token / photo data / Drive id in the card',
    /เก็บอุปกรณ์/.test(txt) && content.actions[0].url === 'https://watanathep8-dotcom.github.io/work-permit-thepwatana/admin/view.html?id=' + W.id &&
    !txt.includes(W.token) && !/base64|data:image/.test(txt) && !stored.some((x) => txt.includes(x.file)), content.actions);

  // ================================================================ once only
  const dCount = gas.files.size;
  r = wd(W);
  check('second report → CONFLICT, nothing stored / sent', r.code === 'CONFLICT' && /แจ้งเสร็จงานไปแล้ว/.test(r.error) && gas.files.size === dCount && gas.fetches.length === fetches0 + 1, r);

  // ================================================================ access to the photos via action=file
  const fid = p.work_done_photos[0].fid, fidHeic = p.work_done_photos.find((f) => f.mime === 'image/heic').fid;
  let x = post({ action: 'file', no: W.permit_no, t: W.token, fid });
  check('token holder opens a photo (bytes as uploaded, inline)', x.ok && x.data.base64 === b64(IMG.jpg) && x.data.mimeType === 'image/jpeg' && x.data.inline === true, x);
  check('จป. opens a photo', post({ action: 'file', session: S, id: W.id, fid }).ok);
  x = post({ action: 'file', session: SR, id: W.id, fid: fidHeic });
  check('assigned responsible opens a photo (heic → download)', x.ok && x.data.inline === false, x);
  check('assigned area owner opens a photo', post({ action: 'file', session: SA, id: W.id, fid }).ok);
  check('another responsible → NOT_FOUND', post({ action: 'file', session: SR2, id: W.id, fid }).code === 'NOT_FOUND');
  check('anonymous by id → AUTH', post({ action: 'file', id: W.id, fid }).code === 'AUTH');
  const O = post(body({ responsible_id: RID, location: 'อาคาร 2' })).data;
  check('another permit\'s token → NOT_FOUND', post({ action: 'file', no: W.permit_no, t: O.token, fid }).code === 'NOT_FOUND' &&
    post({ action: 'file', no: O.permit_no, t: O.token, fid }).code === 'NOT_FOUND');

  // ================================================================ other states
  approve(O);
  post({ action: 'decide', session: S, id: O.id, decision: 'close' });
  check('closed permit → CONFLICT', wd(O).code === 'CONFLICT');
  const R = post(body({ location: 'อาคาร 3' })).data;
  post({ action: 'stage_decide', session: SR, id: R.id, decision: 'reject', comment: 'ไม่ผ่าน' });
  check('rejected permit → CONFLICT', wd(R).code === 'CONFLICT');
  // approved, past its work window (expired by time) and not closed → still allowed
  const E = post(body({ location: 'อาคาร 4' })).data;
  approve(E);
  gas.clock.offset += 2 * 86400000;
  S = post({ action: 'login', username: 'admin', password: 'Admin-Pass-1' }).data.session; // sessions last 6 h
  SA = login('area');
  check('expired by time (es expired, status approved)', post({ action: 'permit', no: E.permit_no, t: E.token }).data.permit.es === 'expired');
  gas.fetchMode.throws = 'boom ' + HOOK; // Teams failure must not fail the action
  r = wd(E, { photos: [photo('done.png', IMG.png)] });
  gas.fetchMode.throws = null;
  check('expired-but-approved permit: report ok even when Teams fails', r.ok && r.data.photos === 1, r);
  check('Teams failure logged without the URL', !gas.logs.some((l) => l.includes('WD-SECRET')));
  delete gas.propStore.TEAMS_WEBHOOK_URL;

  // ================================================================ approvals table: save_review keeps unsent before / during stamps
  const ins0 = { owner: { before: { name: 'อารี (เก่า)' } }, contractor: { during: { name: 'สมศักดิ์ (เก่า)' } }, safety: { before: { name: 'จป. (เก่า)' } } };
  const base = post({ action: 'permit', session: S, id: E.id }).data.permit;
  r = post({ action: 'save_review', session: S, id: E.id, checklist: base.checklist, inspections: ins0 });
  check('older page: before / during stamps still accepted', r.ok && r.data.inspections.owner.before.name === 'อารี (เก่า)' && r.data.inspections.safety.before.name === 'จป. (เก่า)', r);
  // the view page now sends only the merged (permit) / after cells + notes
  r = post({ action: 'save_review', session: S, id: E.id, checklist: base.checklist, inspections: { owner: { after: { name: '' }, note: '' }, contractor: { after: { name: '' }, note: '' }, safety: { after: { name: 'ผู้ดูแลระบบ จป.' }, note: 'ok' } } });
  const ins = r.ok && r.data.inspections;
  check('new page: before / during stamps kept, after signed', ins && ins.owner.before.name === 'อารี (เก่า)' && ins.contractor.during.name === 'สมศักดิ์ (เก่า)' &&
    ins.safety.before.name === 'จป. (เก่า)' && ins.safety.after.name === 'ผู้ดูแลระบบ จป.' && ins.safety.note === 'ok', ins);
  r = post({ action: 'save_review', session: S, id: E.id, checklist: base.checklist, inspections: { safety: { before: { name: '' } } } });
  check('a cell sent empty is still cleared (older page)', r.ok && !r.data.inspections.safety.before && r.data.inspections.safety.after.name === 'ผู้ดูแลระบบ จป.', r.data && r.data.inspections);
  check('inspect_sign "after" (self-sign) still works', post({ action: 'inspect_sign', session: SA, id: E.id, stage: 'after' }).ok);

  // ================================================================ delete / reset trash the photos
  const eStored = JSON.parse(pSheet.data.find((x2) => String(x2[0]) === String(E.id))[pSheet.data[0].indexOf('work_done_photos')]);
  r = post({ action: 'delete', session: S, id: E.id, resetPassword: 'Reset-Pass-1' });
  check('delete trashes the work-done photos', r.ok && eStored.length === 1 && eStored.every((s) => gas.files.get(s.file).trashed), r);
  check('work_done of a deleted permit → NOT_FOUND', wd(E).code === 'NOT_FOUND');
  r = post({ action: 'reset_data', session: S, resetPassword: 'Reset-Pass-1' });
  check('reset_data trashes the work-done photos', r.ok && stored.every((s) => gas.files.get(s.file).trashed), r);
  check('every sheet write happened under LockService', gas.stats.unlockedWrites === 0);

  // ================================================================ browser helpers (parts.js)
  const ctx = {
    WP_CONFIG: { apiUrl: '' }, document: { readyState: 'complete', currentScript: null, addEventListener() {} },
    location: { origin: 'https://example.test', href: '', search: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, URL, URLSearchParams, Intl, setTimeout, console, JSON, Promise, Date, Object, Array, String, Set, Map
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  ['data.js', 'core.js', 'parts.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js', f), 'utf8'), ctx));
  const WP = ctx.WP;
  const legacyIns = { owner: { permit: { name: 'x' }, before: { name: 'อารี <b>', at: '2026-10-08 09:15:00' }, during: { name: 'อารี 2', at: '2026-10-08 11:00:00' }, after: { name: 'y' } }, safety: { note: 'n' } };
  const lines = WP.inspLegacyLines(legacyIns, 'owner');
  check('merged column label', WP.INSP_MERGED_LABEL === 'อนุมัติและตรวจสอบก่อนเริ่มงาน');
  check('legacy before / during stamps → extra lines (labels shortened)', lines.length === 2 && lines[0].label === 'ก่อนเริ่มงาน' && lines[1].label === 'ระหว่างทำงาน' && lines[0].name === 'อารี <b>', lines);
  const lh = WP.inspLegacyHTML(legacyIns, 'owner');
  check('extra lines HTML: escaped, with Thai time', /ก่อนเริ่มงาน: อารี &lt;b&gt; · 8 ต\.ค\. 2569 09:15 น\./.test(lh) && /ระหว่างทำงาน: อารี 2/.test(lh) && !/after|y</.test(lh), lh);
  check('no legacy stamps → nothing extra', WP.inspLegacyHTML(legacyIns, 'safety') === '' && WP.inspLegacyHTML({}, 'owner') === '' && WP.inspLegacyHTML(null, 'x') === '');
  check('view page: one merged column + หลังเสร็จงาน + หมายเหตุ, no before / during inputs', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'docs/assets/js/pages/view.js'), 'utf8');
    return /WP\.INSP_MERGED_LABEL/.test(src) && /inspectStages\.after/.test(src) && !/data-s="before"|data-s="during"|data-s="\$\{sk\}"/.test(src) &&
      /อนุมัติ & ตรวจสอบ \(ก่อนเริ่มงาน \/ หลังเสร็จงาน\)/.test(src);
  })());
  check('print page keeps the paper form (four columns)', !/INSP_MERGED/.test(fs.readFileSync(path.join(ROOT, 'docs/assets/js/pages/print.js'), 'utf8')));
  check('canReportWorkDone: approved (also expired) & not reported only', WP.canReportWorkDone({ status: 'approved', es: 'approved' }) && WP.canReportWorkDone({ status: 'approved', es: 'expired' }) &&
    !WP.canReportWorkDone({ status: 'approved', work_done_at: '2026-10-08 10:00:00' }) && ['pending', 'rejected', 'closed'].every((s) => !WP.canReportWorkDone({ status: s })));
  const wh = WP.workDoneHTML({ status: 'approved', work_done_at: '2026-10-08 16:30:00', work_done_note: 'เสร็จ <script>', work_done_photos: [{ fid: 'abc', name: 'a"b.jpg', mime: 'image/jpeg', size: 10 }] });
  check('workDoneHTML: badge, time, escaped note / names, one tile per photo', /ผู้รับเหมาแจ้งเสร็จงานแล้ว/.test(wh) && /16:30 น\./.test(wh) && /เสร็จ &lt;script&gt;/.test(wh) &&
    /data-wd-photo="abc"/.test(wh) && /a&quot;b\.jpg/.test(wh) && (wh.match(/data-wd-photo=/g) || []).length === 1, wh);
  check('workDoneHTML / badge empty when not reported', WP.workDoneHTML({ status: 'approved' }) === '' && WP.workDoneBadge({ status: 'approved' }) === '' &&
    WP.workDoneBadge({ status: 'closed', work_done_at: 'x' }) === '' && /st-done/.test(WP.workDoneBadge({ status: 'approved', work_done_at: 'x' })));
  check('status page: "แจ้งเสร็จงาน" button posts work_done with no + t', (() => {
    const src = fs.readFileSync(path.join(ROOT, 'docs/assets/js/pages/status.js'), 'utf8');
    return /WP\.canReportWorkDone\(p\)/.test(src) && /WP\.api\('work_done', \{ no, t, photos/.test(src) && /btn-work-done/.test(src) && !/onkeydown/.test(src);
  })());
  return { passed, failures };
};
