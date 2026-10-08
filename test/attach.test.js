/* Checklist item files ("เอกสารรับรองที่เกี่ยวข้อง" / "อื่นๆ"): optional text fields,
 * accepted / rejected types (magic bytes, HEIC/HEIF by the ftyp brand), per-item cap,
 * size limits, private Drive storage, access through action=file, a live sheet without
 * the item_files column, edit / delete — end-to-end on the Apps Script mocks.  Run: node test/run.js */
'use strict';
const path = require('path');
const { createGas } = require('./gas-mock');

const ROOT = path.join(__dirname, '..');
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const b64 = (buf) => Buffer.from(buf).toString('base64');
const withHead = (head, n = 64) => { const b = Buffer.alloc(Math.max(n, head.length), 0x20); Buffer.from(head).copy(b); return b; };
const ftyp = (brand) => { const b = Buffer.alloc(64, 0); b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'latin1'); b.write(brand, 8, 'latin1'); b.write('mif1heic', 16, 'latin1'); return b; };
const SAMPLES = {
  pdf: withHead('%PDF-1.7\n'), jpg: withHead([0xff, 0xd8, 0xff, 0xe0]), jpeg: withHead([0xff, 0xd8, 0xff, 0xdb]),
  png: withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), gif: withHead('GIF89a'), bmp: withHead('BM'),
  webp: (() => { const b = withHead('RIFF'); b.write('WEBPVP8 ', 8, 'latin1'); return b; })(),
  tif: withHead([0x49, 0x49, 0x2a, 0x00]), tiff: withHead([0x4d, 0x4d, 0x00, 0x2a]),
  heic: ftyp('heic'), heif: ftyp('mif1')
};

module.exports = function run() {
  let passed = 0;
  const failures = [];
  const check = (name, cond, extra) => {
    if (cond) { passed++; return; }
    failures.push('attach: ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 400) : ''));
  };

  const gas = createGas();
  gas.load(path.join(ROOT, 'apps-script'), ['Data.gs', 'Code.gs', 'Auth.gs', 'Permits.gs', 'Setup.gs']);
  const G = gas.context, D = G.WP_DATA;
  gas.clock.offset = new Date('2026-10-07T08:00:00+07:00').getTime() - Date.now();
  const post = (b) => JSON.parse(G.doPost({ postData: { contents: JSON.stringify(b) } }).getContent());
  gas.propStore.WP_INITIAL_ADMIN_PASSWORD = 'Admin-Pass-1';
  G.setupSystem();
  gas.propStore.WP_RESET_PASSWORD = 'Reset-Pass-1';
  const S = post({ action: 'login', username: 'admin', password: 'Admin-Pass-1' }).data.session;
  const ss = gas.spreadsheets.get(gas.propStore.WP_SPREADSHEET_ID), pSheet = ss.getSheetByName('permits');
  const folderId = gas.propStore.WP_FOLDER_ID;

  // ---- live sheet set up before this change: no item_files column
  const hdr = pSheet.data[0];
  check('setupSystem creates the optional item_files column', hdr.includes('item_files'));
  const ci = hdr.indexOf('item_files');
  pSheet.data.forEach((row) => row.splice(ci, 1));
  G.bumpDataVersion_();

  const body = (o = {}) => Object.assign({
    action: 'submit', company: D.companies[0], permit_type: 'contractor', work_types: ['general', 'hot', 'height', 'electric', 'chemical'],
    work_date: '2026-10-07', time_from: '08:00', time_to: '17:00', requester_title: 'นาย', requester_name: 'ผู้ขอ',
    requester_company: 'ผู้รับเหมา ก', requester_phone: '0812345678', owner_name: 'เจ้าของงาน', location: 'อาคาร 1', job_detail: 'งาน',
    workers: [{ name: 'ก' }], requester_sign: SIG
  }, o);
  const file = (item, name, buf) => ({ item, name, base64: b64(buf) });

  // ================================================================ A. optional fields
  const emptyCl = { _v: 2, g2doc: '', g3: '', h9: '', h10: '', ht7: '', ht64: { on: false, text: '' }, e8: { on: false, text: '' }, c10: '', c11: '' };
  let r = post(body({ checklist: emptyCl }));
  check('submit succeeds with every เอกสารรับรอง / อื่นๆ field empty (old sheet, no files)', r.ok, r);
  const OLD = r.data;
  check('old sheet: no column was added when nothing was attached', !pSheet.data[0].includes('item_files'));
  let p = post({ action: 'permit', no: OLD.permit_no, t: OLD.token }).data.permit;
  check('old row: item_files reads as []', Array.isArray(p.item_files) && p.item_files.length === 0 && p.checklist.h9 === '', p.item_files);
  r = post(body({ checklist: undefined }));
  check('submit succeeds with no checklist at all', r.ok, r);
  check('Data.gs: attach flag on every เอกสารรับรอง / อื่นๆ item', ['g2doc', 'g3', 'h9', 'h10', 'ht_g6', 'ht64', 'ht7', 'e8', 'c10', 'c11', 'cs6_18']
    .every((id) => Object.values(D.workTypes).some((w) => w.items.some((it) => it.id === id && it.attach === true))));

  // ================================================================ B. accepted types (incl. HEIC/HEIF by brand)
  const all = Object.keys(SAMPLES).map((ext, i) => file(['h9', 'h10', 'g2doc', 'g3', 'ht7', 'c10', 'c11', 'e8', 'ht_g6', 'ht64', 'h9'][i], 'doc' + i + '.' + ext.toUpperCase().replace('JPEG', 'jpeg'), SAMPLES[ext]));
  const driveBefore = gas.files.size, sharingBefore = gas.stats.sharingCalls;
  r = post(body({ item_files: all, checklist: emptyCl }));
  check('every accepted type (pdf jpg jpeg png gif webp bmp tif tiff heic heif) stored', r.ok, r);
  const A = r.data;
  check('old sheet: item_files column created on write', pSheet.data[0].includes('item_files') && pSheet.data[0].indexOf('item_files') === pSheet.data[0].length - 1);
  p = post({ action: 'permit', no: A.permit_no, t: A.token }).data.permit;
  check('permit lists the files (name / item / size / mime)', p.item_files.length === all.length && p.item_files[0].name === all[0].name && p.item_files[0].item === 'h9' &&
    p.item_files.find((f) => /\.HEIC$/.test(f.name)).mime === 'image/heic' && p.item_files.every((f) => f.size === 64 && /^[a-f0-9]{16}$/.test(f.fid)), p.item_files);
  const rowA = pSheet.data.find((x) => String(x[0]) === String(A.id));
  const stored = JSON.parse(rowA[pSheet.data[0].indexOf('item_files')]);
  check('stored in Drive (app folder), never shared', gas.files.size === driveBefore + all.length + 1 && stored.every((x) => gas.files.get(x.file).folder.getId() === folderId) &&
    gas.stats.sharingCalls === sharingBefore);
  check('API never returns a Drive file id', !stored.some((x) => JSON.stringify(post({ action: 'permit', session: S, id: A.id })).includes(x.file)));
  check('old row still readable after the column was added', post({ action: 'permit', no: OLD.permit_no, t: OLD.token }).data.permit.item_files.length === 0);

  // ================================================================ B. rejected
  const bad = (name, files, re, o = {}) => {
    const before = gas.files.size;
    const x = post(body(Object.assign({ item_files: files }, o)));
    check(name, !x.ok && re.test(x.error) && gas.files.size === before, x); // validated before any Drive upload
    return x;
  };
  bad('PNG renamed .pdf rejected', [file('h9', 'x.pdf', SAMPLES.png)], /ไม่ตรงกับเนื้อหา/);
  bad('EXE renamed .jpg rejected', [file('h9', 'x.jpg', withHead('MZ\x90\x00'))], /ไม่ตรงกับเนื้อหา/);
  bad('AVIF renamed .heic rejected (brand)', [file('h9', 'x.heic', ftyp('avif'))], /ไม่ตรงกับเนื้อหา/);
  bad('MP4 renamed .heif rejected (brand)', [file('h9', 'x.heif', ftyp('isom'))], /ไม่ตรงกับเนื้อหา/);
  bad('RIFF/WAVE renamed .webp rejected', [file('h9', 'x.webp', (() => { const b = withHead('RIFF'); b.write('WAVE', 8, 'latin1'); return b; })())], /ไม่ตรงกับเนื้อหา/);
  bad('docx not allowed for item files', [file('h9', 'x.docx', withHead([0x50, 0x4b, 0x03, 0x04]))], /ไม่รองรับ/);
  bad('no extension rejected', [file('h9', 'pdf', SAMPLES.pdf)], /ไม่รองรับ/);
  bad('item of a work type not selected rejected', [file('cs6_18', 'x.pdf', SAMPLES.pdf)], /ไม่ตรงกับรายการ/);
  bad('item without attach rejected', [file('h1', 'x.pdf', SAMPLES.pdf)], /ไม่ตรงกับรายการ/);
  bad('not an array rejected', { item: 'h9' }, /ไม่ถูกต้อง/);
  bad('invalid base64 rejected', [{ item: 'h9', name: 'x.pdf', base64: '%%%' }], /ไม่สำเร็จ/);
  const six = Array.from({ length: 6 }, (_, i) => file('h9', 'f' + i + '.pdf', SAMPLES.pdf));
  bad('6 files on one item rejected (cap ' + D.config.itemFileMax + ')', six, /ไม่เกิน 5 ไฟล์ต่อรายการ/);
  r = post(body({ item_files: six.slice(0, 5).concat([file('h10', 'g.pdf', SAMPLES.pdf)]) }));
  check('5 files on one item + another item accepted', r.ok && post({ action: 'permit', no: r.data.permit_no, t: r.data.token }).data.permit.item_files.length === 6, r);
  const big = Buffer.alloc(D.config.uploadMaxMb * 1048576 + 1, 0x20); Buffer.from('%PDF').copy(big);
  bad('a file over uploadMaxMb rejected', [file('h9', 'big.pdf', big)], /ใหญ่เกิน 10MB/);
  const nine = Buffer.alloc(9 * 1048576, 0x20); Buffer.from('%PDF').copy(nine);
  const filesBefore = gas.files.size;
  const tb = bad('total over requestMaxMb rejected (before anything is stored)', [file('h9', 'a.pdf', nine), file('h10', 'b.pdf', nine), file('g3', 'c.pdf', nine)], /รวมกันใหญ่เกิน 25MB/);
  check('… TOO_LARGE, no Drive file created', tb.code === 'TOO_LARGE' && gas.files.size === filesBefore);
  const att = { name: 'list.pdf', base64: b64(nine) };
  bad('total counts the main attachment too', [file('h9', 'a.pdf', nine), file('h10', 'b.pdf', nine)], /รวมกันใหญ่เกิน/, { attachment: att });
  check('limits: request total well under the ~50 MB POST limit (base64)', D.config.requestMaxMb * 4 / 3 + 2 < 50 && D.config.itemFileMax === 5);

  // ================================================================ B. access via action=file
  const mk = (u, n, roles) => post({ action: 'user_save', session: S, username: u, fullname: n, roles, password: 'pass-' + u }).data.id;
  const RID = mk('resp', 'ผู้รับผิดชอบ', ['responsible']);
  mk('resp2', 'ผู้รับผิดชอบอื่น', ['responsible']);
  const login = (u) => post({ action: 'login', username: u, password: 'pass-' + u }).data.session;
  const SR = login('resp'), SR2 = login('resp2');
  r = post(body({ responsible_id: RID, item_files: [file('h9', 'cert.pdf', SAMPLES.pdf), file('c11', 'photo.heic', SAMPLES.heic)] }));
  check('workflow submit with files', r.ok, r);
  const W = r.data;
  const wf = post({ action: 'permit', session: S, id: W.id }).data.permit.item_files;
  const fid = wf[0].fid, fid2 = wf[1].fid;
  let x = post({ action: 'file', session: S, id: W.id, fid });
  check('admin opens an item file (bytes as uploaded)', x.ok && x.data.name === 'cert.pdf' && x.data.base64 === b64(SAMPLES.pdf) && x.data.mimeType === 'application/pdf' && x.data.inline === true, x);
  x = post({ action: 'file', session: SR, id: W.id, fid: fid2 });
  check('assigned responsible opens an item file (heic → download)', x.ok && x.data.mimeType === 'image/heic' && x.data.inline === false, x);
  check('another responsible → NOT_FOUND', post({ action: 'file', session: SR2, id: W.id, fid }).code === 'NOT_FOUND');
  check('anonymous by id → AUTH', post({ action: 'file', id: W.id, fid }).code === 'AUTH');
  check('another permit\'s token → NOT_FOUND', post({ action: 'file', no: W.permit_no, t: A.token, fid }).code === 'NOT_FOUND');
  check('fid of another permit → NOT_FOUND', post({ action: 'file', session: S, id: W.id, fid: post({ action: 'permit', session: S, id: A.id }).data.permit.item_files[0].fid }).code === 'NOT_FOUND');
  check('unknown fid → NOT_FOUND', post({ action: 'file', session: S, id: W.id, fid: 'f'.repeat(16) }).code === 'NOT_FOUND');
  check('own token: existing rule (same as the main attachment)', post({ action: 'file', no: W.permit_no, t: W.token, fid }).ok);
  check('without fid: main attachment behaviour unchanged (none → NOT_FOUND)', post({ action: 'file', session: S, id: W.id }).code === 'NOT_FOUND');
  check('old row (no item_files cell): fid → NOT_FOUND', post({ action: 'file', session: S, id: OLD.id, fid }).code === 'NOT_FOUND');

  // ================================================================ edit keeps them, delete trashes them
  const before = JSON.stringify(post({ action: 'permit', session: S, id: W.id }).data.permit.item_files);
  r = post(Object.assign(body({ work_types: ['general'] }), { action: 'update_permit', session: S, id: W.id, resetPassword: 'Reset-Pass-1', item_files: [] }));
  check('update_permit keeps item files untouched', r.ok && JSON.stringify(post({ action: 'permit', session: S, id: W.id }).data.permit.item_files) === before, r);
  const wStored = JSON.parse(pSheet.data.find((row) => String(row[0]) === String(W.id))[pSheet.data[0].indexOf('item_files')]);
  r = post({ action: 'delete', session: S, id: W.id, resetPassword: 'Reset-Pass-1' });
  check('delete trashes the item files', r.ok && wStored.every((s) => gas.files.get(s.file).trashed), r);
  check('every sheet write happened under LockService', gas.stats.unlockedWrites === 0);
  return { passed, failures };
};
