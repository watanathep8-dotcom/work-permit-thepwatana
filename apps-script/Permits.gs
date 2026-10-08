/**
 * Permit actions — port of api.php plus the server-side logic embedded in
 * index.php / status.php / track.php / print.php / file.php / admin/*.php.
 *
 * Read access to a permit (details, logs, signatures, attachment) is granted to
 *   (a) a logged-in จป. (role safety) — every permit (by `id`, with `session`),
 *   (b) a logged-in approver (responsible / area_owner) — only permits they are
 *       assigned to (responsible_id / area_owner_id), by `id`, or
 *   (c) the requester holding that permit's tracking token (`no` + `t`).
 *
 * Approval workflow (status stays "pending" until the จป. decides) — order
 * ผู้รับผิดชอบงาน → เจ้าของพื้นที่ → จป.:
 *   submit (requester picks an active "ผู้รับผิดชอบงาน")
 *   → stage assign  (ขั้นที่ 1) "รอผู้รับผิดชอบงานอนุมัติ"  the assigned responsible reviews, ticks the
 *                    checklist, SIGNS the approval and picks the area owner in one action (or rejects)
 *   → stage area    (ขั้นที่ 2) "รอเจ้าของพื้นที่อนุมัติ"   the assigned area owner approves (signature) or rejects
 *   → stage safety  (ขั้นที่ 3) "รอ จป. อนุมัติ"           any จป.: review / approve / reject exactly as before
 *   → approved → inspections / close (expiry counts from the work window, as before)
 * Only the assignee of the current stage may act; a จป. may reassign the
 * responsible (until they approved) / area owner (stage area) but never act for them.
 * A pending permit without responsible_id (created before the workflow, or while
 * no responsible user existed) is at stage "safety" directly.
 *
 * In-flight permits from the previous order (area owner first, responsible second)
 * finish the way they started: a permit at stage "area" whose responsible has NOT
 * approved yet (no resp_approved_at) goes area → resp (legacy stage, numbered
 * ขั้นที่ 1 like the responsible's row of the approvals table) → safety; a permit
 * at "resp" goes resp → safety. A permit at "assign" simply gets the new combined
 * step. The old action assign_area (a page cached before the update) still works:
 * it picks the area owner without the responsible's signature, so that permit
 * then follows the legacy path too — nobody's approval is ever skipped.
 */

var WP_MIME_BY_EXT = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // checklist item files (WP_DATA.config.itemFileExt): PDF + common image formats
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif'
};
// Leading "magic" bytes per extension, so a renamed file cannot slip through.
var WP_MAGIC_BY_EXT = {
  pdf: [[0x25, 0x50, 0x44, 0x46]],                 // %PDF
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  xlsx: [[0x50, 0x4b, 0x03, 0x04]],                // zip (OOXML)
  docx: [[0x50, 0x4b, 0x03, 0x04]],
  xls: [[0xd0, 0xcf, 0x11, 0xe0], [0x50, 0x4b, 0x03, 0x04]], // OLE2 (or mis-named OOXML)
  doc: [[0xd0, 0xcf, 0x11, 0xe0], [0x7b, 0x5c, 0x72, 0x74], [0x50, 0x4b, 0x03, 0x04]], // OLE2 / RTF / OOXML
  gif: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]], // GIF87a / GIF89a
  bmp: [[0x42, 0x4d]],                               // BM
  tif: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]], // II*. / MM.*
  tiff: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]]
  // webp ("RIFF" + "WEBP" at 8) and heic / heif (ISO-BMFF "ftyp" box + brand) are checked in contentMatchesExt_
};
// HEIF major brands (ISO/IEC 23008-12): HEVC-coded (heic …) and generic (mif1 / msf1). AVIF ("avif") is not accepted.
var WP_HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];
var WP_ITEM_FILE_NAME_MAX = 150;
var WP_SIG_MAX = 1500000; // same as sig_ok() in api.php

// ---------------------------------------------------------------- expiry (inc/data.php)
/** Unix seconds of "YYYY-MM-DD HH:MM" in Asia/Bangkok (UTC+7, no DST). */
function bkkTs_(date, time) {
  var d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  var t = /^(\d{1,2}):(\d{2})/.exec(String(time || '00:00'));
  if (!d) return 0;
  return Date.UTC(+d[1], +d[2] - 1, +d[3], t ? +t[1] : 0, t ? +t[2] : 0) / 1000 - 7 * 3600;
}

/** permit_end_ts(): end of the stated time window (overnight aware), capped at start + 24 h. */
function permitEndTs_(p) {
  var end = bkkTs_(p.work_date, p.time_to);
  if (String(p.time_to) <= String(p.time_from)) end += 86400; // overnight work
  var max = bkkTs_(p.work_date, p.time_from) + WP_DATA.config.permitValidHours * 3600;
  return Math.min(end, max);
}

/** effective_status(): approved permits become "expired" automatically. */
function effectiveStatus_(p) {
  if (p.status === 'approved' && nowTs_() > permitEndTs_(p)) return 'expired';
  return p.status;
}

// ---------------------------------------------------------------- sanitizers
function workTypeKeys_() { return Object.keys(WP_DATA.workTypes); }

function checklistItemIndex_() {
  var idx = {};
  workTypeKeys_().forEach(function (k) {
    WP_DATA.workTypes[k].items.forEach(function (it) { idx[it.id] = it; });
  });
  return idx;
}

/**
 * Keeps only known checklist ids with the value shape the UI produces.
 * Older checklists (no `_v`, sent by a cached page or stored before the
 * FM-MR-58 paper-form update) are first upgraded by wpUpgradeChecklist_ (Data.gs);
 * the result always carries `_v` (current version) and, for upgraded rows, the
 * read-only `_legacy` texts { workType: [text, ...] }.
 */
function cleanChecklist_(raw) {
  var out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  raw = wpUpgradeChecklist_(raw);
  var idx = checklistItemIndex_();
  var lg = (raw._legacy && typeof raw._legacy === 'object' && !Array.isArray(raw._legacy)) ? raw._legacy : {};
  var legacy = {};
  workTypeKeys_().forEach(function (k) {
    var arr = (Array.isArray(lg[k]) ? lg[k] : []).map(function (x) { return str_(x, 300); }).filter(function (x) { return x !== ''; }).slice(0, 20);
    if (arr.length) legacy[k] = arr;
  });
  Object.keys(raw).forEach(function (key) {
    if (key === '_v' || key === '_legacy') return;
    var v = raw[key];
    var it = idx[key];
    if (!it) {
      var base = key.replace(/_t$/, '');
      if (key !== base && idx[base] && idx[base].type === 'choice' && idx[base].other) out[key] = str_(v, 200);
      return;
    }
    switch (it.type) {
      case 'check': out[key] = !!v; break;
      case 'text': out[key] = str_(v, 500); break;
      case 'checktext': out[key] = { on: !!(v && v.on), text: str_(v && v.text, 500) }; break;
      case 'choice': out[key] = it.opts.indexOf(v) >= 0 ? v : ''; break;
      case 'ppe':
        var sel = (v && Array.isArray(v.sel)) ? v.sel : [];
        out[key] = {
          sel: it.options.filter(function (o) { return sel.indexOf(o) >= 0; }),
          other: str_(v && v.other, 200)
        };
        break;
      default: break; // group / info carry no value
    }
  });
  if (Object.keys(legacy).length) out._legacy = legacy;
  out._v = WP_DATA.config.checklistVersion;
  return out;
}

function cleanLoto_(raw) {
  var rows = Array.isArray(raw) ? raw.slice(0, 6) : [];
  return rows.map(function (r) {
    r = (r && typeof r === 'object') ? r : {};
    return {
      item: str_(r.item, 200), t_on: str_(r.t_on, 5), by_on: str_(r.by_on, 150),
      t_off: str_(r.t_off, 5), by_off: str_(r.by_off, 150), note: str_(r.note, 300)
    };
  });
}

/** clean_confined() from inc/data.php (gas / entries / renew / close). */
function cleanConfined_(d) {
  d = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  var at = function (arr, i) { return (Array.isArray(arr) && arr[i] && typeof arr[i] === 'object') ? arr[i] : {}; };
  var o = { gas: [], entries: [], renew: [], close: {} };
  var i, j;
  for (i = 0; i < 5; i++) {
    var g = at(d.gas, i);
    o.gas.push({ o2: str_(g.o2, 10), lel: str_(g.lel, 10), by: str_(g.by, 100), time: str_(g.time, 5) });
  }
  for (i = 0; i < 6; i++) {
    var e = at(d.entries, i), t = [];
    for (j = 0; j < 5; j++) { var x = at(e.t, j); t.push({ 'in': str_(x['in'], 5), out: str_(x.out, 5) }); }
    o.entries.push({ name: str_(e.name, 150), t: t });
  }
  for (i = 0; i < 3; i++) {
    var r = at(d.renew, i);
    o.renew.push({ start: str_(r.start, 5), end: str_(r.end, 5), by: str_(r.by, 100) });
  }
  var cl = (d.close && typeof d.close === 'object') ? d.close : {};
  Object.keys(WP_DATA.confinedClose).forEach(function (k) { o.close[k] = !!cl[k]; });
  o.close.reason = str_(cl.reason, 300);
  return o;
}

function cleanWorkers_(raw) {
  var out = [];
  (Array.isArray(raw) ? raw : []).some(function (w) {
    w = (w && typeof w === 'object') ? w : {};
    if (str_(w.name) === '') return false;
    out.push({ name: str_(w.name, 150), role: str_(w.role, 150), idno: str_(w.idno, 50) });
    return out.length >= 200;
  });
  return out;
}

// ---------------------------------------------------------------- files (Drive, private)
function startsWithBytes_(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (var i = 0; i < magic.length; i++) if ((bytes[i] & 0xff) !== magic[i]) return false;
  return true;
}

/** sig_ok(): '' or a PNG data URL ≤ 1.5 MB. Returns decoded bytes (or null). */
function checkSignature_(s) {
  s = typeof s === 'string' ? s : '';
  if (s === '') return null;
  if (s.length > WP_SIG_MAX || !/^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(s)) fail_('ลายเซ็นไม่ถูกต้อง');
  var bytes = Utilities.base64Decode(s.substring(s.indexOf(',') + 1));
  if (!startsWithBytes_(bytes, WP_MAGIC_BY_EXT.png[0])) fail_('ลายเซ็นไม่ถูกต้อง');
  return bytes;
}

/** Attachment rules of api.php: ≤ UPLOAD_MAX_MB, pdf/jpg/jpeg/png/xls/xlsx/doc/docx. */
function checkAttachment_(a) {
  if (!a || typeof a !== 'object' || !a.base64) return null;
  var full = str_(a.name, 100000);
  var ext = full.indexOf('.') >= 0 ? full.split('.').pop().toLowerCase() : '';
  var name = str_(full, 255);
  var maxBytes = WP_DATA.config.uploadMaxMb * 1048576;
  if (WP_DATA.config.uploadExt.indexOf(ext) < 0) fail_('ชนิดไฟล์ไม่รองรับ');
  var b64 = String(a.base64).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+\/]*={0,2}$/.test(b64)) fail_('อัปโหลดไฟล์ไม่สำเร็จ');
  if (Math.floor(b64.length * 3 / 4) - 2 > maxBytes) fail_('ไฟล์แนบใหญ่เกินกำหนด');
  var bytes = Utilities.base64Decode(b64);
  if (!bytes.length) fail_('อัปโหลดไฟล์ไม่สำเร็จ');
  if (bytes.length > maxBytes) fail_('ไฟล์แนบใหญ่เกินกำหนด');
  var okMagic = WP_MAGIC_BY_EXT[ext].some(function (m) { return startsWithBytes_(bytes, m); });
  if (!okMagic) fail_('ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์');
  return { bytes: bytes, ext: ext, name: name, mime: WP_MIME_BY_EXT[ext] };
}

function asciiAt_(bytes, at, n) {
  var s = '';
  for (var i = at; i < at + n && i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
  return s;
}

/** True when the decoded bytes really are a file of type `ext` (magic bytes / container brand). */
function contentMatchesExt_(bytes, ext) {
  if (ext === 'webp') return asciiAt_(bytes, 0, 4) === 'RIFF' && asciiAt_(bytes, 8, 4) === 'WEBP';
  if (ext === 'heic' || ext === 'heif') {
    // ISO-BMFF: [size:4]["ftyp"][major brand:4] — heic / heif share the brands (cameras mix them up)
    return bytes.length >= 12 && asciiAt_(bytes, 4, 4) === 'ftyp' && WP_HEIF_BRANDS.indexOf(asciiAt_(bytes, 8, 4).toLowerCase()) >= 0;
  }
  var m = WP_MAGIC_BY_EXT[ext];
  return !!m && m.some(function (x) { return startsWithBytes_(bytes, x); });
}

/** The items of the selected work types that take files ("attach": true in Data.gs). */
function attachItems_(types) {
  var out = {};
  types.forEach(function (k) {
    WP_DATA.workTypes[k].items.forEach(function (it) { if (it.attach) out[it.id] = it; });
  });
  return out;
}

/**
 * Files attached to the checklist items "เอกสารรับรองที่เกี่ยวข้อง" / "อื่นๆ" (all optional).
 * `list` = [{item, name, base64}], `types` = the cleaned work types, `usedBytes` = bytes
 * of the other attachment of the same request. Each file: an attach item of a selected
 * work type, ≤ itemFileMax per item, an itemFileExt extension whose content matches
 * (magic bytes; HEIC/HEIF by the ftyp brand), ≤ uploadMaxMb; all files of the request
 * together ≤ requestMaxMb (Apps Script caps a POST at ~50 MB, base64 adds a third).
 * Returns [{item, name, ext, mime, bytes}] — nothing is stored yet.
 */
function checkItemFiles_(list, types, usedBytes) {
  if (list === undefined || list === null || list === '') return [];
  if (!Array.isArray(list)) fail_('ไฟล์แนบรายการตรวจสอบไม่ถูกต้อง');
  var C = WP_DATA.config, items = attachItems_(types);
  var maxBytes = C.uploadMaxMb * 1048576, totalMax = C.requestMaxMb * 1048576;
  var total = usedBytes || 0, per = {}, out = [];
  // total size first (cheap, before decoding anything)
  list.forEach(function (a) {
    var b64 = a && typeof a === 'object' ? String(a.base64 || '').replace(/s+/g, '') : '';
    total += Math.floor(b64.length * 3 / 4) - 2;
  });
  if (total > totalMax) fail_('ไฟล์แนบรวมกันใหญ่เกิน ' + C.requestMaxMb + 'MB', 'TOO_LARGE');
  total = usedBytes || 0;
  list.forEach(function (a) {
    if (!a || typeof a !== 'object' || !a.base64) fail_('ไฟล์แนบรายการตรวจสอบไม่ถูกต้อง');
    var item = String(a.item || '');
    if (!Object.prototype.hasOwnProperty.call(items, item)) fail_('ไฟล์แนบไม่ตรงกับรายการตรวจสอบของลักษณะงานที่เลือก');
    per[item] = (per[item] || 0) + 1;
    if (per[item] > C.itemFileMax) fail_('แนบไฟล์ได้ไม่เกิน ' + C.itemFileMax + ' ไฟล์ต่อรายการ (' + items[item].label + ')');
    var full = str_(a.name, 100000);
    var ext = full.indexOf('.') >= 0 ? full.split('.').pop().toLowerCase() : '';
    if (C.itemFileExt.indexOf(ext) < 0) fail_('ชนิดไฟล์ไม่รองรับ (PDF หรือรูปภาพเท่านั้น): ' + str_(full, 80));
    var b64 = String(a.base64).replace(/s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) fail_('อัปโหลดไฟล์ไม่สำเร็จ');
    if (Math.floor(b64.length * 3 / 4) - 2 > maxBytes) fail_('ไฟล์ใหญ่เกิน ' + C.uploadMaxMb + 'MB: ' + str_(full, 80));
    var bytes = Utilities.base64Decode(b64);
    if (!bytes.length) fail_('อัปโหลดไฟล์ไม่สำเร็จ');
    if (bytes.length > maxBytes) fail_('ไฟล์ใหญ่เกิน ' + C.uploadMaxMb + 'MB: ' + str_(full, 80));
    if (!contentMatchesExt_(bytes, ext)) fail_('ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์: ' + str_(full, 80));
    total += bytes.length;
    if (total > totalMax) fail_('ไฟล์แนบรวมกันใหญ่เกิน ' + C.requestMaxMb + 'MB', 'TOO_LARGE');
    out.push({ item: item, name: str_(full, WP_ITEM_FILE_NAME_MAX), ext: ext, mime: WP_MIME_BY_EXT[ext], bytes: bytes });
  });
  return out;
}

/** item_files cell → [{fid, item, name, mime, size, file}] (a missing column / junk → []). */
function itemFilesOf_(r) {
  var a = jdec_(r && r.item_files, []);
  return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === 'object' && x.fid && x.file; }) : [];
}

/** What the API shows: names only — never the Drive id. */
function itemFilesOut_(r) {
  return itemFilesOf_(r).map(function (x) {
    return { fid: x.fid, item: x.item, name: x.name, mime: x.mime, size: Number(x.size) || 0 };
  });
}

/** work_done_photos cell → [{fid, name, mime, size, file}] (a missing column / junk → []). */
function workDonePhotosOf_(r) {
  var a = jdec_(r && r.work_done_photos, []);
  return Array.isArray(a) ? a.filter(function (x) { return x && typeof x === 'object' && x.fid && x.file; }) : [];
}

/** What the API shows: names only — never the Drive id. */
function workDonePhotosOut_(r) {
  return workDonePhotosOf_(r).map(function (x) {
    return { fid: x.fid, name: x.name, mime: x.mime, size: Number(x.size) || 0 };
  });
}

/** Every Drive file a permit row references (attachment, signatures, item files, work-done photos). */
function permitFileIds_(r) {
  return [r.attachment_file, r.requester_sign_file, r.owner_sign_file, r.approver_sign_file, r.area_sign_file, r.resp_sign_file]
    .concat(itemFilesOf_(r).map(function (x) { return x.file; }))
    .concat(workDonePhotosOf_(r).map(function (x) { return x.file; }));
}

/**
 * Photos of "แจ้งเสร็จงาน": `list` = [{name, base64}], 1..workDonePhotoMax images
 * (workDonePhotoExt, content checked like the item files), each ≤ uploadMaxMb,
 * together ≤ requestMaxMb (base64 keeps the POST well under Apps Script's ~50 MB).
 * Returns [{name, ext, mime, bytes}] — nothing is stored yet.
 */
function checkWorkDonePhotos_(list) {
  var C = WP_DATA.config;
  if (!Array.isArray(list) || !list.length) fail_('กรุณาแนบรูปถ่ายเมื่อเสร็จงานอย่างน้อย 1 รูป');
  if (list.length > C.workDonePhotoMax) fail_('แนบรูปถ่ายได้ไม่เกิน ' + C.workDonePhotoMax + ' รูป', 'TOO_LARGE');
  var maxBytes = C.uploadMaxMb * 1048576, totalMax = C.requestMaxMb * 1048576, total = 0;
  list.forEach(function (a) { // total size first (cheap, before decoding anything)
    var b64 = a && typeof a === 'object' ? String(a.base64 || '').replace(/\s+/g, '') : '';
    total += Math.floor(b64.length * 3 / 4) - 2;
  });
  if (total > totalMax) fail_('รูปถ่ายรวมกันใหญ่เกิน ' + C.requestMaxMb + 'MB', 'TOO_LARGE');
  total = 0;
  return list.map(function (a) {
    if (!a || typeof a !== 'object' || !a.base64) fail_('รูปถ่ายไม่ถูกต้อง');
    var full = str_(a.name, 100000);
    var ext = full.indexOf('.') >= 0 ? full.split('.').pop().toLowerCase() : '';
    if (C.workDonePhotoExt.indexOf(ext) < 0) fail_('ชนิดไฟล์ไม่รองรับ (รูปภาพเท่านั้น): ' + str_(full, 80));
    var b64 = String(a.base64).replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) fail_('อัปโหลดรูปถ่ายไม่สำเร็จ');
    if (Math.floor(b64.length * 3 / 4) - 2 > maxBytes) fail_('รูปถ่ายใหญ่เกิน ' + C.uploadMaxMb + 'MB: ' + str_(full, 80), 'TOO_LARGE');
    var bytes = Utilities.base64Decode(b64);
    if (!bytes.length) fail_('อัปโหลดรูปถ่ายไม่สำเร็จ');
    if (bytes.length > maxBytes) fail_('รูปถ่ายใหญ่เกิน ' + C.uploadMaxMb + 'MB: ' + str_(full, 80), 'TOO_LARGE');
    if (!contentMatchesExt_(bytes, ext)) fail_('ชนิดไฟล์ไม่ตรงกับเนื้อหาไฟล์: ' + str_(full, 80));
    total += bytes.length;
    if (total > totalMax) fail_('รูปถ่ายรวมกันใหญ่เกิน ' + C.requestMaxMb + 'MB', 'TOO_LARGE');
    return { name: str_(full, WP_ITEM_FILE_NAME_MAX), ext: ext, mime: WP_MIME_BY_EXT[ext], bytes: bytes };
  });
}

function saveDriveFile_(bytes, mime, filename) {
  // Files stay private (default sharing) and are only served through apiFile_ / apiPermit_.
  return folder_().createFile(Utilities.newBlob(bytes, mime, filename)).getId();
}

function trashDriveFile_(id) {
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { console.warn('trash failed: ' + id); }
}

function driveDataUrl_(id) {
  if (!id) return '';
  try {
    var blob = DriveApp.getFileById(id).getBlob();
    return 'data:' + (blob.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (e) {
    return '';
  }
}

function stampName_(ext) {
  return Utilities.formatDate(now_(), WP_TZ, 'yyyyMMdd_HHmmss') + '_' + randomHex_(12) + '.' + ext;
}

// ---------------------------------------------------------------- logs
function addLog_(ctx, permitId, action, by, note) {
  var t = table_(ctx, 'permit_logs');
  appendRow_(t, { id: nextId_(t), permit_id: permitId, action: action, by_name: by || '', note: note || '', created_at: nowStr_() });
}

function logsFor_(ctx, permitId) {
  return table_(ctx, 'permit_logs').rows
    .filter(function (l) { return Number(l.permit_id) === Number(permitId); })
    .sort(function (a, b) { return Number(a.id) - Number(b.id); })
    .map(function (l) { return { action: l.action, by_name: l.by_name, note: l.note, created_at: l.created_at }; });
}

// ---------------------------------------------------------------- shaping
/**
 * Permit as the API returns it. `staff` (a logged-in user reading by id) also gets
 * the assignee user ids; nobody ever gets an e-mail address, a token or a file id.
 */
function permitOut_(r, staff) {
  var types = jdec_(r.work_types, []);
  var out = {
    id: Number(r.id), permit_no: r.permit_no, company: r.company, permit_type: r.permit_type,
    work_types: types, work_date: r.work_date, time_from: r.time_from, time_to: r.time_to,
    requester_title: r.requester_title, requester_name: r.requester_name, requester_company: r.requester_company,
    requester_phone: r.requester_phone, worker_count: Number(r.worker_count) || 0, workers: jdec_(r.workers, []),
    owner_name: r.owner_name, owner_phone: r.owner_phone, job_detail: r.job_detail, location: r.location,
    checklist: jdec_(r.checklist, {}), loto: jdec_(r.loto, []), confined: jdec_(r.confined, null),
    inspections: jdec_(r.inspections, {}),
    has_attachment: !!r.attachment_file, attachment_name: r.attachment_name,
    item_files: itemFilesOut_(r),
    has_owner_sign: !!r.owner_sign_file, has_approver_sign: !!r.approver_sign_file,
    status: r.status, es: effectiveStatus_(r), end_ts: permitEndTs_(r),
    approver_name: r.approver_name, approve_comment: r.approve_comment,
    approved_at: r.approved_at, closed_at: r.closed_at, created_at: r.created_at, updated_at: r.updated_at,
    // approval workflow
    stage: stageOf_(r), workflow: !!Number(r.responsible_id) || !!r.area_owner_id,
    responsible_name: r.responsible_name, area_owner_name: r.area_owner_name,
    area_assigned_at: r.area_assigned_at, area_approved_at: r.area_approved_at, area_comment: r.area_comment,
    resp_approved_at: r.resp_approved_at, resp_comment: r.resp_comment,
    has_area_sign: !!r.area_sign_file, has_resp_sign: !!r.resp_sign_file,
    stage_started_at: r.stage_started_at, reject_stage: r.reject_stage,
    // the contractor's "แจ้งเสร็จงาน" (action work_done)
    work_done_at: r.work_done_at || '', work_done_note: r.work_done_note || '', work_done_photos: workDonePhotosOut_(r)
  };
  if (staff) {
    out.responsible_id = Number(r.responsible_id) || 0;
    out.area_owner_id = Number(r.area_owner_id) || 0;
  }
  return out;
}

function listRowOut_(r) {
  return {
    id: Number(r.id), permit_no: r.permit_no, status: r.status, es: effectiveStatus_(r), permit_type: r.permit_type,
    work_types: jdec_(r.work_types, []), work_date: r.work_date, time_from: r.time_from, time_to: r.time_to,
    requester_title: r.requester_title, requester_name: r.requester_name, requester_company: r.requester_company,
    requester_phone: r.requester_phone, location: r.location, worker_count: Number(r.worker_count) || 0,
    approver_name: r.approver_name, created_at: r.created_at, end_ts: permitEndTs_(r),
    stage: stageOf_(r), responsible_name: r.responsible_name, area_owner_name: r.area_owner_name,
    stage_started_at: r.stage_started_at, work_done_at: r.work_done_at || ''
  };
}

function permitsDesc_(ctx) {
  return table_(ctx, 'permits').rows.slice().sort(function (a, b) { return Number(b.id) - Number(a.id); });
}

/**
 * Resolves the permit a caller may read:
 *  - `id` → session required: a จป. reads any permit, an approver only the
 *    permits assigned to them (others look like "not found"); sets ctx.staff
 *  - `no` + `t` → tracking token must match that permit (constant-time)
 */
function authorizedPermit_(p, ctx) {
  if (p.id !== undefined && p.id !== null && p.id !== '') {
    var u = requireUser_(p, ctx);
    var byId = findById_(table_(ctx, 'permits'), p.id);
    if (!byId || !canViewPermit_(u, byId)) fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
    ctx.staff = true;
    return byId;
  }
  var no = str_(p.no, 30).toUpperCase();
  var tok = String(p.t || '').toLowerCase();
  if (!no || !/^[a-f0-9]{32}$/.test(tok)) fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
  var rows = table_(ctx, 'permits').rows;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].permit_no === no) {
      if (safeEqual_(rows[i].token, tok)) return rows[i];
      break;
    }
  }
  fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
}

// ---------------------------------------------------------------- PUBLIC
/** index.php hero counters (aggregate numbers only — no permit data). */
/**
 * Public "ติดตามสถานะ" list: recent permits in SHORT form only — no phone, no
 * workers, no details/files/signatures and no tracking token. Who a pending
 * permit waits for is the stage's role + the assignee's name.
 */
var WP_TRACK_LIST_DAYS = 60, WP_TRACK_LIST_MAX = 200;
function apiTrackList_(p, ctx) {
  return cachedRead_(ctx, 'track_list', null, function () {
    var rows = permitsDesc_(ctx);
    var from = Utilities.formatDate(new Date(Date.now() - WP_TRACK_LIST_DAYS * 86400000), WP_TZ, 'yyyy-MM-dd');
    var out = [];
    rows.some(function (r) {
      if (String(r.created_at).substring(0, 10) < from && String(r.work_date) < from) return false;
      var st = r.status === 'pending' ? stageOf_(r) : '';
      var who = '';
      if (st === 'assign' || st === 'resp') who = r.responsible_name || ''; // ขั้นที่ 1 (resp: legacy order)
      else if (st === 'area') who = r.area_owner_name || '';
      out.push({
        permit_no: r.permit_no, requester_company: r.requester_company, requester_name: r.requester_name,
        work_types: jdec_(r.work_types, []), work_date: r.work_date, time_from: r.time_from, time_to: r.time_to,
        status: r.status, es: effectiveStatus_(r), stage: st, waiting_name: who
      });
      return out.length >= WP_TRACK_LIST_MAX;
    });
    return { data: out, until: permitsValidUntil_(rows) };
  });
}

function apiStats_(p, ctx) {
  return cachedRead_(ctx, 'stats', null, function () {
    var today = todayStr_();
    var s = { total: 0, approved: 0, pending: 0, today: 0 };
    var rows = table_(ctx, 'permits').rows;
    rows.forEach(function (r) {
      s.total++;
      if (r.status === 'approved') s.approved++;
      if (r.status === 'pending') s.pending++;
      if (String(r.created_at).substring(0, 10) === today) s.today++;
    });
    return { data: s, until: permitsValidUntil_([]) }; // depends on "today" only
  });
}

/**
 * Request-form fields a requester keys in (submit) and the จป. admin may later
 * correct (update_permit). Never permit_no / token / status / approvals /
 * inspections / signatures / attachment / logs.
 */
var WP_REQUEST_FIELDS = {
  company: 'บริษัท (พื้นที่)', permit_type: 'ประเภท', work_types: 'ลักษณะงาน',
  work_date: 'วันที่ปฏิบัติงาน', time_from: 'เวลาเริ่ม', time_to: 'เวลาสิ้นสุด',
  requester_title: 'คำนำหน้า', requester_name: 'ชื่อผู้ขออนุญาต', requester_company: 'บริษัท/หน่วยงานผู้ขอ',
  requester_phone: 'เบอร์โทรผู้ขอ', worker_count: 'จำนวนผู้ปฏิบัติงาน', workers: 'รายชื่อผู้ปฏิบัติงาน',
  owner_name: 'ผู้รับผิดชอบงานโครงการ', owner_phone: 'เบอร์โทรผู้รับผิดชอบ', job_detail: 'รายละเอียดงาน',
  location: 'สถานที่ปฏิบัติงาน', checklist: 'รายการตรวจสอบความปลอดภัย', loto: 'Lock Out / Tag Out',
  confined: 'ที่อับอากาศ (FM-EMR-46)'
};

/**
 * Validates + sanitizes the request-form fields exactly as submit does and
 * returns the sheet cell values (keys of WP_REQUEST_FIELDS). Throws on invalid input.
 * `keep` (update only): existing row — the optional checklist / LOTO / confined
 * sections are kept when the caller does not send them.
 */
function cleanRequestFields_(d, keep) {
  var WT = WP_DATA.workTypes;
  var types = (Array.isArray(d.work_types) ? d.work_types : []).filter(function (t, i, a) {
    return typeof t === 'string' && Object.prototype.hasOwnProperty.call(WT, t) && a.indexOf(t) === i;
  });
  if (!types.length) fail_('กรุณาเลือกลักษณะงาน');
  // Editing an older permit may keep a company that is no longer offered.
  var keptCompany = keep && String(keep.company || '') !== '' && d.company === keep.company;
  if (WP_DATA.companies.indexOf(d.company) < 0 && !keptCompany) fail_('บริษัทไม่ถูกต้อง');
  if (!Object.prototype.hasOwnProperty.call(WP_DATA.permitTypes, String(d.permit_type))) fail_('ประเภทไม่ถูกต้อง');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.work_date || ''))) fail_('วันที่ไม่ถูกต้อง');
  ['time_from', 'time_to'].forEach(function (k) { if (!/^\d{2}:\d{2}$/.test(String(d[k] || ''))) fail_('เวลาไม่ถูกต้อง'); });
  var req = { requester_name: 'ชื่อผู้ขออนุญาต', requester_company: 'บริษัท/หน่วยงาน', requester_phone: 'เบอร์โทรศัพท์', owner_name: 'ผู้รับผิดชอบงานโครงการ', location: 'สถานที่ปฏิบัติงาน', job_detail: 'รายละเอียดงาน' };
  Object.keys(req).forEach(function (k) { if (str_(d[k]) === '') fail_('กรุณากรอก ' + req[k]); });
  var workers = cleanWorkers_(d.workers);
  // "จำนวน ___ คน โดยมีรายชื่อตามเอกสารแนบ": the stated head count may exceed the typed
  // rows (names in the attached file), never be lower than them
  var count = Math.max(workers.length, Math.min(9999, Math.floor(Number(d.worker_count)) || 0));
  var given = function (k) { return !keep || (d[k] !== undefined && d[k] !== null); };
  var confined = '';
  if (types.indexOf('confined') >= 0) {
    confined = given('confined') ? JSON.stringify(cleanConfined_(d.confined))
      : JSON.stringify(cleanConfined_(jdec_(keep.confined, {})));
  }
  var f = {
    company: d.company, permit_type: d.permit_type, work_types: JSON.stringify(types),
    work_date: d.work_date, time_from: d.time_from, time_to: d.time_to,
    requester_title: str_(d.requester_title, 20), requester_name: str_(d.requester_name, 150),
    requester_company: str_(d.requester_company, 200), requester_phone: str_(d.requester_phone, 30),
    worker_count: String(count), workers: JSON.stringify(workers),
    owner_name: str_(d.owner_name, 150), owner_phone: str_(d.owner_phone, 30),
    job_detail: str_(d.job_detail, 5000), location: str_(d.location),
    checklist: given('checklist') ? JSON.stringify(cleanChecklist_(d.checklist)) : JSON.stringify(cleanChecklist_(jdec_(keep.checklist, {}))),
    loto: given('loto') ? JSON.stringify(cleanLoto_(d.loto)) : JSON.stringify(cleanLoto_(jdec_(keep.loto, []))),
    confined: confined
  };
  // Fail on oversize cells (e.g. 200 very long worker rows) before touching Drive / the sheet.
  Object.keys(f).forEach(function (h) { toCell_(f[h], h); });
  return f;
}

/**
 * Double-submit guard: the request form sends a random `rid` (32 hex) once per
 * filled form. A retried submit with the same rid (the answer was lost on a bad
 * connection, a double tap) gets the permit that was already created instead of a
 * duplicate. The cache keeps only the permit id + number and a hash of its token.
 */
var WP_SUBMIT_RID_TTL = 3600;
function submitRidKey_(d) {
  var rid = String(d.rid || '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(rid) ? 'wpsub_' + rid : '';
}
function submitReplay_(ctx, key) {
  var o = key ? jdec_(cache_().get(key), null) : null;
  if (!o) return null;
  var r = findById_(table_(ctx, 'permits'), o.id);
  return (r && r.permit_no === o.no && sha256Hex_(r.token).substring(0, 32) === o.th) ? r : null;
}
function submitOut_(ctx, row, d) {
  var path = 'track.html?no=' + encodeURIComponent(row.permit_no) + '&t=' + row.token;
  var site = String(props_().getProperty(WP_PROP_SITE_URL) || '').replace(/\/+$/, '');
  var out = { id: Number(row.id), permit_no: row.permit_no, token: row.token, track_path: path, track_url: site ? site + '/' + path : '' };
  // Optional: the status page data (= action permit with no + t) so the browser
  // can show it without another round-trip. Built from the values as stored.
  if (d.with_permit) out.view = { permit: permitOut_(row), logs: logsFor_(ctx, row.id) };
  return out;
}

/**
 * api.php?action=submit — anonymous, like the original.
 * `responsible_id`: the "ผู้รับผิดชอบงาน" picked from action=responsibles. Required
 * while at least one active responsible user exists (the permit then starts at
 * stage "assign" = ขั้นที่ 1, the responsible approves first); with no responsible user at all the permit goes straight to
 * the จป. (stage "safety"), so the form keeps working before accounts are set up.
 */
function apiSubmit_(d) {
  var ridKey = submitRidKey_(d);
  if (ridKey) { // already created by an earlier try: answer the same, create nothing
    var rctx = { tables: {} }, prev = submitReplay_(rctx, ridKey);
    if (prev) return submitOut_(rctx, prev, d);
  }
  var resp0 = pickResponsible_({ tables: {} }, d); // validated before any Drive upload
  if (resp0 && str_(d.owner_name) === '') d = Object.assign({}, d, { owner_name: resp0.fullname });
  var fields = cleanRequestFields_(d, null);
  var reqSign = checkSignature_(d.requester_sign);
  if (!reqSign) fail_('กรุณาลงลายมือชื่อผู้ขออนุญาต');
  var ownSign = checkSignature_(d.owner_sign);
  var att = checkAttachment_(d.attachment);
  var itemFiles = checkItemFiles_(d.item_files, jdec_(fields.work_types, []), att ? att.bytes.length : 0);

  var row = Object.assign({}, fields, {
    inspections: '{}', status: 'pending',
    token: randomHex_(32), created_at: '', updated_at: ''
  });

  var created = [], fresh = null, out, resp = null;
  try {
    var tag = stampName_('png').replace(/\.png$/, '');
    row.requester_sign_file = saveDriveFile_(reqSign, 'image/png', tag + '_requester.png');
    created.push(row.requester_sign_file);
    if (ownSign) { row.owner_sign_file = saveDriveFile_(ownSign, 'image/png', tag + '_owner.png'); created.push(row.owner_sign_file); }
    if (att) {
      row.attachment_file = saveDriveFile_(att.bytes, att.mime, stampName_(att.ext));
      row.attachment_name = att.name;
      row.attachment_mime = att.mime;
      created.push(row.attachment_file);
    }
    if (itemFiles.length) {
      // same private app folder as the attachment / signatures (default sharing: owner only)
      row.item_files = JSON.stringify(itemFiles.map(function (f) {
        var id = saveDriveFile_(f.bytes, f.mime, stampName_(f.ext));
        created.push(id);
        return { fid: randomHex_(16), item: f.item, name: f.name, mime: f.mime, size: f.bytes.length, file: id };
      }));
      toCell_(row.item_files, 'item_files');
    }
    out = withLock_(function () {
      var ctx = { tables: {} };
      var t = table_(ctx, 'permits');
      if (row.item_files) ensureColumn_(t, 'item_files'); // a sheet set up before this column existed
      var prev = submitReplay_(ctx, ridKey); // an identical try finished while this one uploaded its files
      if (prev) {
        created.forEach(trashDriveFile_);
        created = [];
        return submitOut_(ctx, prev, d);
      }
      // numbering: WP-YYYYMMDD-NNN (per Bangkok day, 3-digit running number)
      var prefix = 'WP-' + Utilities.formatDate(now_(), WP_TZ, 'yyyyMMdd') + '-';
      var seq = 0;
      t.rows.forEach(function (r) {
        if (String(r.permit_no).indexOf(prefix) === 0) seq = Math.max(seq, parseInt(String(r.permit_no).substring(prefix.length), 10) || 0);
      });
      var n = String(seq + 1);
      while (n.length < 3) n = '0' + n;
      row.permit_no = prefix + n;
      row.id = nextId_(t);
      row.created_at = row.updated_at = nowStr_();
      resp = pickResponsible_(ctx, d); // again under the lock: the account may have been disabled meanwhile
      if (resp) {
        row.responsible_id = resp.id;
        row.responsible_name = resp.fullname;
        enterStage_(row, 'assign', row.created_at);
      }
      appendRow_(t, row);
      addLog_(ctx, row.id, 'submit', row.requester_name, 'ยื่นใบขออนุญาตปฏิบัติงาน');
      if (ridKey) {
        try {
          cache_().put(ridKey, JSON.stringify({ id: row.id, no: row.permit_no, th: sha256Hex_(row.token).substring(0, 32) }), WP_SUBMIT_RID_TTL);
        } catch (e) { console.warn('submit rid not cached'); }
      }
      fresh = t.rows[t.rows.length - 1]; // the row as stored
      return submitOut_(ctx, fresh, d);
    });
  } catch (err) {
    created.forEach(trashDriveFile_);
    throw err;
  }
  // Only a permit created by THIS call is announced (a replayed retry returned above / set no `fresh`).
  if (fresh) { // after the lock is released; never throws
    if (resp) notifyNewWorkflowPermit_(fresh, resp);
    else notifyNewPermit_(fresh);
  }
  return out;
}

/** api.php?action=track — permit no + requester phone → token. */
function apiTrack_(d, ctx) {
  var no = str_(d.permit_no, 30).toUpperCase();
  var phone = String(d.phone || '').replace(/\D/g, '');
  if (no === '' || phone === '') fail_('กรุณากรอกเลขที่ใบอนุญาตและเบอร์โทรศัพท์');
  var cache = cache_(), key = 'wptf_' + no;
  if ((Number(cache.get(key)) || 0) >= WP_TRACK_MAX_FAIL) fail_('ค้นหาผิดหลายครั้งเกินไป กรุณารอ 15 นาที', 'LOCKED');
  var r = null;
  table_(ctx, 'permits').rows.some(function (x) { if (x.permit_no === no) { r = x; return true; } return false; });
  if (!r || String(r.requester_phone).replace(/\D/g, '') !== phone) {
    cache.put(key, String((Number(cache.get(key)) || 0) + 1), WP_LOGIN_LOCK_SEC);
    fail_('ไม่พบข้อมูล กรุณาตรวจสอบเลขที่และเบอร์โทรศัพท์', 'NOT_FOUND');
  }
  var out = { permit_no: r.permit_no, token: r.token };
  // Optional: the status page data (= action permit with no + t) in the same round-trip.
  if (d.with_permit) out.view = { permit: permitOut_(r), logs: logsFor_(ctx, r.id) };
  return out;
}

// ---------------------------------------------------------------- ADMIN or TOKEN
/** status.php / admin/view.php / print.php data. */
function apiPermit_(p, ctx) {
  var r = authorizedPermit_(p, ctx);
  var out = { permit: permitOut_(r, !!ctx.staff), logs: logsFor_(ctx, r.id) };
  if (p.signs) {
    out.signs = {
      requester: driveDataUrl_(r.requester_sign_file),
      owner: driveDataUrl_(r.owner_sign_file),
      approver: driveDataUrl_(r.approver_sign_file),
      area: driveDataUrl_(r.area_sign_file),
      resp: driveDataUrl_(r.resp_sign_file)
    };
  }
  return out;
}

/** file.php — attachment as base64 for authorized callers only. */
function apiFile_(p, ctx) {
  var r = authorizedPermit_(p, ctx);
  var fileId = r.attachment_file, name = r.attachment_name, mime0 = r.attachment_mime;
  if (p.fid !== undefined && p.fid !== null && p.fid !== '') { // a checklist item file / work-done photo (same access rules)
    var x = null;
    itemFilesOf_(r).concat(workDonePhotosOf_(r)).some(function (f) { if (String(f.fid) === String(p.fid)) { x = f; return true; } return false; });
    if (!x) fail_('ไม่พบไฟล์', 'NOT_FOUND');
    fileId = x.file; name = x.name; mime0 = x.mime;
  }
  if (!fileId) fail_('ไม่พบไฟล์', 'NOT_FOUND');
  var blob;
  try { blob = DriveApp.getFileById(fileId).getBlob(); } catch (e) { fail_('ไม่พบไฟล์', 'NOT_FOUND'); }
  var mime = mime0 || blob.getContentType() || 'application/octet-stream';
  return {
    name: name, mimeType: mime,
    inline: ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].indexOf(mime) >= 0,
    base64: Utilities.base64Encode(blob.getBytes())
  };
}

// ---------------------------------------------------------------- TOKEN: contractor reports the work done
var WP_WORK_DONE_NOTE_MAX = 1000;

/** work_done is allowed once, on an approved permit (also past its work window), never pending / rejected / closed. */
function workDoneCheck_(r) {
  if (r.work_done_at) fail_('แจ้งเสร็จงานไปแล้วเมื่อ ' + teamsThaiDate_(r.work_done_at, true), 'CONFLICT');
  if (r.status !== 'approved') {
    var st = WP_DATA.status[r.status];
    fail_('แจ้งเสร็จงานได้เฉพาะใบอนุญาตที่อนุมัติแล้ว (สถานะปัจจุบัน: ' + (st ? st.label : r.status) + ')', 'CONFLICT');
  }
}

/**
 * work_done — the requester (contractor) holding the permit's tracking token (`no` + `t`)
 * reports the work done: 1..workDonePhotoMax photos (checkWorkDonePhotos_) + an optional
 * note. Photos are stored privately in the app Drive folder (served only through
 * action=file by fid, same access rules as the attachment). Records work_done_at /
 * work_done_note / work_done_photos (columns created on first write), logs
 * "ผู้รับเหมาแจ้งเสร็จงาน" and sends a Teams card @mentioning the responsible, the
 * area owner and the จป. The status stays "approved" (the จป. still closes it).
 */
function apiWorkDone_(d, ctx) {
  var auth = { no: d.no, t: d.t }; // token only — never by id / session
  workDoneCheck_(authorizedPermit_(auth, ctx)); // cheap checks before decoding / uploading anything
  var photos = checkWorkDonePhotos_(d.photos);
  var note = str_(d.note, WP_WORK_DONE_NOTE_MAX);
  var created = [], done = null, out;
  try {
    var tag = stampName_('x').replace(/\.x$/, '');
    var list = photos.map(function (f, i) {
      var id = saveDriveFile_(f.bytes, f.mime, tag + '_done' + (i + 1) + '.' + f.ext);
      created.push(id);
      return { fid: randomHex_(16), name: f.name, mime: f.mime, size: f.bytes.length, file: id };
    });
    var cell = JSON.stringify(list);
    toCell_(cell, 'work_done_photos');
    out = withLock_(function () {
      relockCtx_(ctx);
      var t = table_(ctx, 'permits');
      var p = authorizedPermit_(auth, ctx); // fresh, under the lock
      workDoneCheck_(p);
      ['work_done_at', 'work_done_note', 'work_done_photos'].forEach(function (h) { ensureColumn_(t, h); });
      var stamp = nowStr_();
      p.work_done_at = stamp;
      p.work_done_note = note;
      p.work_done_photos = cell;
      p.updated_at = stamp;
      writeRow_(t, p);
      addLog_(ctx, p.id, 'work_done', teamsRequester_(p) || p.requester_name,
        'ผู้รับเหมาแจ้งเสร็จงาน (รูปถ่าย ' + list.length + ' รูป)' + (note ? '\nหมายเหตุ: ' + note : ''));
      done = { row: p, users: workDoneUsers_(ctx, p) };
      return { work_done_at: stamp, photos: list.length, updated_at: stamp };
    });
  } catch (err) {
    created.forEach(trashDriveFile_);
    throw err;
  }
  notifyWorkDone_(done.row, done.users, out.photos); // after the lock is released; never throws
  return out;
}

/** Who hears about "แจ้งเสร็จงาน": the assigned responsible + area owner (active), then the active จป. */
function workDoneUsers_(ctx, r) {
  var users = table_(ctx, 'users'), out = [], seen = {};
  var add = function (u) {
    if (!u || u.active !== '1' || seen[u.id]) return;
    seen[u.id] = true;
    out.push(u);
  };
  add(findById_(users, r.responsible_id));
  add(findById_(users, r.area_owner_id));
  activeUsersWithRole_(ctx, 'safety').forEach(add);
  return out;
}

// ---------------------------------------------------------------- ADMIN
/** api.php?action=poll */
function apiPoll_(p, ctx) {
  requireAdmin_(p, ctx);
  var hasSince = p.since !== undefined && p.since !== null && p.since !== '';
  var since = hasSince ? Number(p.since) || 0 : null;
  return pollCached_(ctx, hasSince, since);
}

/** Cheap while nothing changes: one cached value per (data version, since). Also used by keepWarm. */
function pollCached_(ctx, hasSince, since) {
  return cachedRead_(ctx, 'poll', { since: since }, function () {
    var rows = table_(ctx, 'permits').rows;
    var pending = 0, max = 0;
    rows.forEach(function (r) { if (r.status === 'pending') pending++; max = Math.max(max, Number(r.id) || 0); });
    var out = { pending: pending, max_id: max, 'new': [] };
    if (hasSince) {
      out['new'] = rows.filter(function (r) { return Number(r.id) > since; })
        .sort(function (a, b) { return Number(a.id) - Number(b.id); }).slice(0, 10)
        .map(function (r) { return { id: Number(r.id), permit_no: r.permit_no, requester_name: r.requester_name, location: r.location }; });
    }
    return { data: out, until: nowTs_() + WP_READ_CACHE_TTL }; // no clock-dependent fields
  });
}

/** admin/dashboard.php aggregates. */
function apiDashboard_(p, ctx) {
  var u = requireAdmin_(p, ctx);
  // aggregates are the same for every admin: cached once, the user is added per request
  var agg = dashboardCached_(ctx);
  return {
    user: publicUser_(u), cnt: agg.cnt, byType: agg.byType,
    days: agg.days, pending: agg.pending, activeNow: agg.activeNow
  };
}

function dashboardCached_(ctx) {
  return cachedRead_(ctx, 'dashboard', null, function () {
    return { data: dashboardAgg_(ctx), until: permitsValidUntil_(table_(ctx, 'permits').rows) };
  });
}

function dashboardAgg_(ctx) {
  var cnt = { pending: 0, approved: 0, rejected: 0, closed: 0, expired: 0 };
  var byType = {};
  workTypeKeys_().forEach(function (k) { byType[k] = 0; });
  var days = {}, dayKeys = [];
  for (var i = 13; i >= 0; i--) {
    var k = Utilities.formatDate(new Date(now_().getTime() - i * 86400000), WP_TZ, 'yyyy-MM-dd');
    days[k] = 0; dayKeys.push(k);
  }
  var activeNow = [], pending = [];
  permitsDesc_(ctx).forEach(function (r) {
    var o = listRowOut_(r);
    if (cnt[o.es] !== undefined) cnt[o.es]++;
    o.work_types.forEach(function (t) { if (byType[t] !== undefined) byType[t]++; });
    var d = String(r.created_at).substring(0, 10);
    if (days[d] !== undefined) days[d]++;
    if (o.es === 'approved') activeNow.push(o);
    if (r.status === 'pending') pending.push(o);
  });
  return {
    cnt: cnt, byType: byType,
    days: dayKeys.map(function (k) { return { date: k, count: days[k] }; }),
    pending: pending.slice(0, 8), activeNow: activeNow.slice(0, 6)
  };
}

/** admin/permits.php search + filters + status tabs. */
function apiPermits_(p, ctx) {
  requireAdmin_(p, ctx);
  var q = str_(p.q, 200).toLowerCase();
  var type = String(p.type || '');
  var from = /^\d{4}-\d{2}-\d{2}$/.test(String(p.from || '')) ? p.from : '';
  var to = /^\d{4}-\d{2}-\d{2}$/.test(String(p.to || '')) ? p.to : '';
  var status = String(p.status || '');
  return permitsCached_(ctx, q, type, from, to, status);
}

function permitsCached_(ctx, q, type, from, to, status) {
  return cachedRead_(ctx, 'permits', { q: q, type: type, from: from, to: to, status: status }, function () {
    return { data: permitsList_(ctx, q, type, from, to, status), until: permitsValidUntil_(table_(ctx, 'permits').rows) };
  });
}

function permitsList_(ctx, q, type, from, to, status) {
  var rows = permitsDesc_(ctx).filter(function (r) {
    if (q) {
      var hay = [r.permit_no, r.requester_name, r.requester_company, r.location, r.job_detail, r.owner_name].join('\n').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    if (type && WP_DATA.workTypes[type] && jdec_(r.work_types, []).indexOf(type) < 0) return false;
    if (from && r.work_date < from) return false;
    if (to && r.work_date > to) return false;
    return true;
  }).slice(0, 1000).map(listRowOut_);
  var counts = {};
  Object.keys(WP_DATA.status).forEach(function (k) { counts[k] = 0; });
  rows.forEach(function (r) { if (counts[r.es] !== undefined) counts[r.es]++; });
  if (status && WP_DATA.status[status]) rows = rows.filter(function (r) { return r.es === status; });
  return { rows: rows, counts: counts };
}

/**
 * Optimistic concurrency for the review / edit forms: `base` is the permit's
 * updated_at as the caller loaded it. If another write happened since, the
 * request is refused instead of silently overwriting that change (callers that
 * send no base keep the old last-write-wins behaviour).
 */
function checkBase_(p, d) {
  if (d.base === undefined || d.base === null || d.base === '') return;
  if (String(d.base) !== String(p.updated_at)) {
    fail_('ใบอนุญาตนี้ถูกแก้ไขโดยผู้ใช้อื่นหลังจากที่คุณเปิดหน้านี้ — ยังไม่ได้บันทึก กรุณาโหลดหน้าใหม่แล้วทำรายการอีกครั้ง', 'CONFLICT');
  }
}

/** api.php?action=save_review — checklist / LOTO / confined / inspection signatures. */
function apiSaveReview_(d, ctx) {
  requireAdmin_(d, ctx);
  return withLock_(function () {
    relockCtx_(ctx); // re-read fresh data (unless nothing was written since) + re-check the session
    var u = requireAdmin_(d, ctx);
    var t = table_(ctx, 'permits');
    var p = findById_(t, d.id);
    if (!p) fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
    // another จป. may have rejected / closed it (or saved it) since this page was opened
    if (p.status !== 'pending' && p.status !== 'approved') {
      fail_('ใบอนุญาตนี้อยู่ในสถานะ "' + WP_DATA.status[p.status].label + '" แล้ว บันทึกผลการตรวจสอบไม่ได้ กรุณาโหลดหน้าใหม่', 'CONFLICT');
    }
    checkBase_(p, d);
    var ins = jdec_(p.inspections, {});
    if (Array.isArray(ins)) ins = {};
    var din = (d.inspections && typeof d.inspections === 'object') ? d.inspections : {};
    var stamp = nowStr_();
    var wf = !!Number(p.responsible_id);
    Object.keys(WP_DATA.inspectRoles).forEach(function (rk) {
      var role = (din[rk] && typeof din[rk] === 'object') ? din[rk] : {};
      if (!ins[rk] || typeof ins[rk] !== 'object' || Array.isArray(ins[rk])) ins[rk] = {};
      Object.keys(WP_DATA.inspectStages).forEach(function (sk) {
        if (rk === 'safety' && sk === 'permit') return; // the approval stamp is set by decide (approve) only
        // approval workflow: the "การอนุญาตทำงาน" cells of rows 1–2 are the stage approvals
        // (area owner / responsible signatures) — not typed by the จป.
        if (wf && sk === 'permit') return;
        // a cell the page did not send is kept as stored: the view page no longer has inputs for
        // "ก่อนเริ่มงาน" / "ระหว่างทำงาน" (merged into the approval column), older stamps stay
        if (!Object.prototype.hasOwnProperty.call(role, sk)) return;
        var name = str_(role[sk] && role[sk].name, 150);
        var old = ins[rk][sk];
        if (name === '') { delete ins[rk][sk]; return; }
        ins[rk][sk] = { name: name, at: (old && old.name === name) ? old.at : stamp };
      });
      var note = str_(role.note, 500);
      if (note !== '') ins[rk].note = note; else delete ins[rk].note;
    });
    p.checklist = JSON.stringify(cleanChecklist_(d.checklist));
    p.loto = JSON.stringify(cleanLoto_(d.loto));
    if (d.confined !== undefined && d.confined !== null) p.confined = JSON.stringify(cleanConfined_(d.confined));
    p.inspections = JSON.stringify(ins);
    p.updated_at = stamp;
    writeRow_(t, p);
    if (d.log) addLog_(ctx, p.id, 'review', u.fullname, 'บันทึกผลการตรวจสอบ');
    return { inspections: ins, updated_at: p.updated_at };
  });
}

/** api.php?action=decide — approve / reject / close. */
function apiDecide_(d, ctx) {
  requireAdmin_(d, ctx);
  var decision = String(d.decision || '');
  var comment = str_(d.comment, 2000);
  if (['approve', 'reject', 'close'].indexOf(decision) < 0) fail_('คำสั่งไม่ถูกต้อง');
  var sign = decision === 'approve' ? checkSignature_(d.sign) : null;
  var signFile = '', done = null, out;
  try {
    out = withLock_(function () {
      relockCtx_(ctx); // re-read fresh data (unless nothing was written since) + re-check the session
      var u = requireAdmin_(d, ctx);
      var t = table_(ctx, 'permits');
      var p = findById_(t, d.id);
      if (!p) fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
      var stamp = nowStr_();
      if (decision !== 'close' && p.status === 'pending' && stageOf_(p) !== 'safety') {
        // stages 1–2 belong to the assigned responsible / area owner — the จป. may reassign, not act for them
        fail_('ใบอนุญาตนี้ยังอยู่ในขั้นตอน "' + WP_DATA.stages[stageOf_(p)].label + '" — จป. พิจารณาได้หลังผู้รับผิดชอบงานและเจ้าของพื้นที่อนุมัติแล้ว', 'CONFLICT');
      }
      if (decision === 'approve') {
        if (p.status !== 'pending') fail_('ใบอนุญาตนี้ไม่ได้อยู่ในสถานะรออนุมัติ');
        if (!sign) fail_('กรุณาลงลายมือชื่อผู้อนุมัติ');
        var ins = jdec_(p.inspections, {});
        if (Array.isArray(ins)) ins = {};
        if (!ins.safety || typeof ins.safety !== 'object' || Array.isArray(ins.safety)) ins.safety = {};
        ins.safety.permit = { name: u.fullname, at: stamp };
        signFile = saveDriveFile_(sign, 'image/png', p.permit_no + '_approver_' + randomHex_(8) + '.png');
        p.status = 'approved'; p.approver_id = u.id; p.approver_name = u.fullname; p.approver_sign_file = signFile;
        p.approve_comment = comment; p.approved_at = stamp; p.inspections = JSON.stringify(ins);
        p.updated_at = stamp;
        writeRow_(t, p);
        addLog_(ctx, p.id, 'approve', u.fullname, comment || 'อนุมัติให้ปฏิบัติงาน');
      } else if (decision === 'reject') {
        if (p.status !== 'pending') fail_('ใบอนุญาตนี้ไม่ได้อยู่ในสถานะรออนุมัติ');
        if (comment === '') fail_('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
        p.status = 'rejected'; p.approver_id = u.id; p.approver_name = u.fullname;
        p.approve_comment = comment; p.approved_at = stamp; p.updated_at = stamp;
        if (p.responsible_id) p.reject_stage = 'safety';
        writeRow_(t, p);
        addLog_(ctx, p.id, 'reject', u.fullname, comment);
      } else {
        if (p.status !== 'approved') fail_('ปิดงานได้เฉพาะใบอนุญาตที่อนุมัติแล้ว');
        p.status = 'closed'; p.closed_at = stamp; p.updated_at = stamp;
        writeRow_(t, p);
        addLog_(ctx, p.id, 'close', u.fullname, comment || 'ตรวจสอบหลังเสร็จงาน ปิดใบอนุญาต');
      }
      done = { row: p, by: u.fullname };
      return { status: p.status };
    });
  } catch (err) {
    trashDriveFile_(signFile);
    throw err;
  }
  notifyDecision_(done.row, decision, done.by, comment); // after the lock is released; never throws
  return out;
}

// ---------------------------------------------------------------- APPROVAL WORKFLOW (stages 1–2)
/** Current stage of a pending permit ('' when not pending). No responsible → straight to the จป. */
function stageOf_(r) {
  if (!r || r.status !== 'pending') return '';
  var s = String(r.stage || '');
  if (!Number(r.responsible_id) || !Object.prototype.hasOwnProperty.call(WP_DATA.stages, s)) return 'safety';
  return s;
}

/** Starts a stage: its clock (stage_started_at) and its reminder bookkeeping restart. */
function enterStage_(r, stage, stamp) {
  r.stage = stage;
  r.stage_started_at = stamp;
  r.last_reminder_at = '';
  r.reminder_count = '0';
}

/** User id assigned to a stage (0 for the จป. stage — any จป.). assign / resp (legacy) = the responsible. */
function stageAssigneeId_(r, stage) {
  if (stage === 'assign' || stage === 'resp') return Number(r.responsible_id) || 0;
  if (stage === 'area') return Number(r.area_owner_id) || 0;
  return 0;
}

/** May user `u` act on the CURRENT stage of permit `r`? (assignee + still holding the stage's role) */
function canActOnStage_(u, r) {
  var st = stageOf_(r);
  if (!st) return false;
  if (!hasRole_(u, WP_DATA.stages[st].role)) return false;
  if (st === 'safety') return true;
  return stageAssigneeId_(r, st) === Number(u.id);
}

/** จป.: every permit. Approvers: the permits they are assigned to (any status). */
function canViewPermit_(u, r) {
  if (hasRole_(u, 'safety')) return true;
  var id = Number(u.id);
  return (Number(r.responsible_id) === id && hasRole_(u, 'responsible')) ||
    (Number(r.area_owner_id) === id && hasRole_(u, 'area_owner'));
}

function activeUsersWithRole_(ctx, role) {
  return table_(ctx, 'users').rows
    .filter(function (u) { return u.active === '1' && hasRole_(u, role); })
    .sort(function (a, b) { return String(a.fullname).localeCompare(String(b.fullname), 'th') || Number(a.id) - Number(b.id); });
}

/** The active user with that id holding `role`, else null. */
function activeRoleUser_(ctx, id, role) {
  var u = findById_(table_(ctx, 'users'), id);
  return u && u.active === '1' && hasRole_(u, role) ? u : null;
}

/** submit: the picked responsible (see apiSubmit_), or null when none is required. Throws when invalid. */
function pickResponsible_(ctx, d) {
  var id = Number(d.responsible_id) || 0;
  if (!id) {
    if (activeUsersWithRole_(ctx, 'responsible').length) fail_('กรุณาเลือกผู้รับผิดชอบงาน');
    return null;
  }
  var u = activeRoleUser_(ctx, id, 'responsible');
  if (!u) fail_('ผู้รับผิดชอบงานที่เลือกไม่ถูกต้องหรือถูกปิดการใช้งาน กรุณาเลือกใหม่');
  return u;
}

function userNameList_(rows) {
  return rows.map(function (u) { return { id: Number(u.id), name: u.fullname }; });
}

/** PUBLIC: active "ผู้รับผิดชอบงาน" for the request form — id + display name only (no username / e-mail). */
function apiResponsibles_(p, ctx) {
  return cachedRead_(ctx, 'responsibles', null, function () {
    return { data: userNameList_(activeUsersWithRole_(ctx, 'responsible')), until: nowTs_() + WP_READ_CACHE_TTL };
  });
}

/** Logged in: pickers (responsible → area owner; จป. → reassign). id + name only. */
function apiApprovers_(p, ctx) {
  requireUser_(p, ctx);
  return {
    responsible: userNameList_(activeUsersWithRole_(ctx, 'responsible')),
    area_owner: userNameList_(activeUsersWithRole_(ctx, 'area_owner'))
  };
}

/**
 * "รออนุมัติของฉัน": pending permits whose CURRENT stage (1–2) is assigned to the
 * caller, plus recent permits assigned to them. Only the caller's own permits —
 * never admin-wide data. Cached per user under the data version.
 */
function apiMyTasks_(p, ctx) {
  var u = requireUser_(p, ctx);
  var uid = Number(u.id);
  return cachedRead_(ctx, 'mytasks', { uid: uid, roles: userRoles_(u).join() }, function () {
    var pending = [], recent = [];
    var rows = permitsDesc_(ctx);
    rows.forEach(function (r) {
      var st = stageOf_(r);
      if (st && st !== 'safety' && canActOnStage_(u, r)) pending.push(listRowOut_(r));
      else if (recent.length < 50 && (Number(r.responsible_id) === uid || Number(r.area_owner_id) === uid) && canViewPermit_(u, r)) recent.push(listRowOut_(r));
    });
    pending.reverse(); // oldest waiting first
    return { data: { pending: pending, recent: recent, count: pending.length }, until: permitsValidUntil_(rows) };
  });
}

/** Loads the permit for a workflow write (under the lock) and checks the caller may see it. */
function wfPermit_(d, ctx, u) {
  var t = table_(ctx, 'permits');
  var p = findById_(t, d.id);
  if (!p || !canViewPermit_(u, p)) fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
  return { t: t, p: p };
}

function wfStageCheck_(p, want) {
  var st = stageOf_(p);
  if (want.indexOf(st) < 0) {
    var now = p.status !== 'pending' ? 'สถานะ "' + WP_DATA.status[p.status].label + '"' : 'ขั้นตอน "' + WP_DATA.stages[st].label + '"';
    fail_('ใบอนุญาตนี้อยู่ใน' + now + ' แล้ว — ทำรายการนี้ไม่ได้ กรุณาโหลดหน้าใหม่', 'CONFLICT');
  }
  return st;
}

/**
 * Legacy action (a page cached before the order changed): at stage assign the
 * responsible picks the area owner WITHOUT signing → stage area; that permit then
 * follows the legacy path area → resp → safety (see the header). The current page
 * uses stage_decide (approve + area_owner_id) instead.
 */
function apiAssignArea_(d, ctx) {
  requireUser_(d, ctx);
  var done = null;
  var out = withLock_(function () {
    relockCtx_(ctx); // re-read fresh data (unless nothing was written since) + re-check the session
    var u = requireUser_(d, ctx);
    var x = wfPermit_(d, ctx, u), p = x.p;
    wfStageCheck_(p, ['assign']);
    if (!canActOnStage_(u, p)) fail_('เฉพาะผู้รับผิดชอบงานที่ได้รับมอบหมาย (' + p.responsible_name + ') เท่านั้นที่ระบุเจ้าของพื้นที่ได้', 'FORBIDDEN');
    checkBase_(p, d);
    var ao = activeRoleUser_(ctx, d.area_owner_id, 'area_owner');
    if (!ao) fail_('กรุณาเลือกเจ้าของพื้นที่ (ผู้ใช้ที่มีบทบาทเจ้าของพื้นที่และเปิดใช้งานอยู่)');
    var stamp = nowStr_();
    p.area_owner_id = ao.id; p.area_owner_name = ao.fullname; p.area_assigned_at = stamp;
    enterStage_(p, 'area', stamp);
    p.updated_at = stamp;
    writeRow_(x.t, p);
    addLog_(ctx, p.id, 'assign_area', u.fullname, 'ระบุเจ้าของพื้นที่: ' + ao.fullname);
    done = { row: p, next: [ao] };
    return { stage: p.stage, updated_at: p.updated_at };
  });
  notifyStage_(done.row, done.next, false); // after the lock is released; never throws
  return out;
}

/**
 * Stages 1–2 by their assignee: approve (signature required) or reject (reason
 * required). Stage 3 is the จป.'s action=decide.
 *  - assign (ขั้นที่ 1): the responsible approves AND picks the area owner
 *    (`area_owner_id`) in one action → area
 *  - area   (ขั้นที่ 2): the area owner approves → safety; on a legacy permit whose
 *    responsible has not approved yet (no resp_approved_at) → resp
 *  - resp   (legacy, the responsible after the area owner): approves → safety
 */
function apiStageDecide_(d, ctx) {
  requireUser_(d, ctx);
  var decision = String(d.decision || '');
  var comment = str_(d.comment, 2000);
  if (['approve', 'reject'].indexOf(decision) < 0) fail_('คำสั่งไม่ถูกต้อง');
  if (decision === 'reject' && comment === '') fail_('กรุณาระบุเหตุผลที่ไม่อนุมัติ');
  var sign = decision === 'approve' ? checkSignature_(d.sign) : null;
  var signFile = '', done = null, out;
  try {
    out = withLock_(function () {
      relockCtx_(ctx);
      var u = requireUser_(d, ctx);
      var x = wfPermit_(d, ctx, u), p = x.p;
      var st = wfStageCheck_(p, ['assign', 'area', 'resp']);
      if (!canActOnStage_(u, p)) {
        var who = st === 'area' ? 'เจ้าของพื้นที่ที่ได้รับมอบหมาย (' + p.area_owner_name + ')' : 'ผู้รับผิดชอบงานที่ได้รับมอบหมาย (' + p.responsible_name + ')';
        fail_('ขั้นตอน "' + WP_DATA.stages[st].label + '" ทำได้เฉพาะ' + who + ' เท่านั้น', 'FORBIDDEN');
      }
      checkBase_(p, d);
      var stamp = nowStr_(), roleLabel = WP_DATA.roles[WP_DATA.stages[st].role];
      if (decision === 'reject') {
        p.status = 'rejected'; p.approver_id = u.id; p.approver_name = u.fullname;
        p.approve_comment = comment; p.approved_at = stamp; p.reject_stage = st; p.updated_at = stamp;
        writeRow_(x.t, p);
        addLog_(ctx, p.id, 'reject', u.fullname, '[' + roleLabel + '] ' + comment);
        done = { row: p, reject: true, by: u.fullname + ' (' + roleLabel + ')', stage: st };
        return { status: p.status, stage: '', updated_at: p.updated_at };
      }
      var ao = null;
      if (st === 'assign') {
        ao = activeRoleUser_(ctx, d.area_owner_id, 'area_owner');
        if (!ao) fail_('กรุณาเลือกเจ้าของพื้นที่ (ผู้ใช้ที่มีบทบาทเจ้าของพื้นที่และเปิดใช้งานอยู่)');
      }
      if (!sign) fail_('กรุณาลงลายมือชื่อ' + roleLabel);
      // the area owner / responsible tick the checklist of the paper form ("สำหรับผู้รับผิดชอบงาน/
      // ผู้รับผิดชอบพื้นที่/ผู้ตรวจสอบงาน") when they approve; the จป. reviews it last (optional)
      if (d.checklist && typeof d.checklist === 'object' && !Array.isArray(d.checklist)) {
        var cl = JSON.stringify(cleanChecklist_(d.checklist));
        toCell_(cl, 'checklist');
        p.checklist = cl;
      }
      if (Array.isArray(d.loto) && jdec_(p.work_types, []).indexOf('electric') >= 0) p.loto = JSON.stringify(cleanLoto_(d.loto));
      signFile = saveDriveFile_(sign, 'image/png', p.permit_no + '_' + (st === 'area' ? 'area' : 'resp') + '_' + randomHex_(8) + '.png');
      var next;
      if (st === 'assign') {
        p.resp_approved_at = stamp; p.resp_sign_file = signFile; p.resp_comment = comment;
        p.area_owner_id = ao.id; p.area_owner_name = ao.fullname; p.area_assigned_at = stamp;
        enterStage_(p, 'area', stamp);
        addLog_(ctx, p.id, 'resp_approve', u.fullname, comment || 'ผู้รับผิดชอบงานอนุมัติ');
        addLog_(ctx, p.id, 'assign_area', u.fullname, 'ระบุเจ้าของพื้นที่: ' + ao.fullname);
        next = [ao];
      } else if (st === 'area') {
        p.area_approved_at = stamp; p.area_sign_file = signFile; p.area_comment = comment;
        addLog_(ctx, p.id, 'area_approve', u.fullname, comment || 'เจ้าของพื้นที่อนุมัติ');
        if (p.resp_approved_at) {
          enterStage_(p, 'safety', stamp);
          next = activeUsersWithRole_(ctx, 'safety');
        } else { // legacy order: the responsible has not approved yet
          enterStage_(p, 'resp', stamp);
          var ru = findById_(table_(ctx, 'users'), p.responsible_id);
          next = ru ? [ru] : [];
        }
      } else {
        p.resp_approved_at = stamp; p.resp_sign_file = signFile; p.resp_comment = comment;
        enterStage_(p, 'safety', stamp);
        addLog_(ctx, p.id, 'resp_approve', u.fullname, comment || 'ผู้รับผิดชอบงานอนุมัติ');
        next = activeUsersWithRole_(ctx, 'safety');
      }
      p.updated_at = stamp;
      writeRow_(x.t, p);
      done = { row: p, next: next };
      return { status: p.status, stage: p.stage, updated_at: p.updated_at };
    });
  } catch (err) {
    trashDriveFile_(signFile);
    throw err;
  }
  if (done.reject) notifyDecision_(done.row, 'reject', done.by, comment, done.stage);
  else notifyStage_(done.row, done.next, false);
  return out;
}

/**
 * Approvals table of the paper form, rows 1–2: the assigned responsible (row
 * "contractor" = 1. ผู้รับผิดชอบงาน) and the assigned area owner (row
 * "owner" = 2. เจ้าของพื้นที่โครงการ) sign their OWN inspection cells
 * (ก่อนเริ่มงาน / ระหว่างทำงาน / หลังเสร็จงาน) of an approved permit, stamped with
 * their account name + time. An already signed cell is never overwritten (the
 * จป. may still correct any cell with save_review, as before). `row` is needed
 * only when the caller holds both assignments.
 */
var WP_SELF_INSPECT = { owner: { idField: 'area_owner_id', role: 'area_owner' }, contractor: { idField: 'responsible_id', role: 'responsible' } };
function inspectRowsOf_(u, p) {
  return Object.keys(WP_SELF_INSPECT).filter(function (rk) {
    var x = WP_SELF_INSPECT[rk];
    return Number(p[x.idField]) === Number(u.id) && hasRole_(u, x.role);
  });
}
function apiInspectSign_(d, ctx) {
  requireUser_(d, ctx);
  var sk = String(d.stage || '');
  if (['before', 'during', 'after'].indexOf(sk) < 0) fail_('คำสั่งไม่ถูกต้อง');
  return withLock_(function () {
    relockCtx_(ctx);
    var u = requireUser_(d, ctx);
    var x = wfPermit_(d, ctx, u), p = x.p;
    var rows = inspectRowsOf_(u, p);
    var rk = d.row ? String(d.row) : (rows.length === 1 ? rows[0] : '');
    if (!rows.length || rows.indexOf(rk) < 0) fail_('ลงชื่อการตรวจสอบได้เฉพาะแถวของผู้ที่ได้รับมอบหมาย (เจ้าของพื้นที่ / ผู้รับผิดชอบงาน) เท่านั้น', 'FORBIDDEN');
    if (p.status !== 'approved') fail_('ลงชื่อการตรวจสอบได้เฉพาะใบอนุญาตที่อนุมัติแล้ว (ระหว่างปฏิบัติงาน)', 'CONFLICT');
    var ins = jdec_(p.inspections, {});
    if (!ins || typeof ins !== 'object' || Array.isArray(ins)) ins = {};
    if (!ins[rk] || typeof ins[rk] !== 'object' || Array.isArray(ins[rk])) ins[rk] = {};
    if (ins[rk][sk] && ins[rk][sk].name) fail_('ช่องนี้ลงชื่อแล้วโดย ' + ins[rk][sk].name + ' — กรุณาโหลดหน้าใหม่', 'CONFLICT');
    var stamp = nowStr_();
    ins[rk][sk] = { name: u.fullname, at: stamp };
    var note = str_(d.note, 500);
    if (note !== '') ins[rk].note = note;
    p.inspections = JSON.stringify(ins);
    p.updated_at = stamp;
    writeRow_(x.t, p);
    addLog_(ctx, p.id, 'inspect', u.fullname, WP_DATA.inspectStages[sk] + ' — ' + WP_DATA.inspectRoles[rk]);
    return { inspections: ins, updated_at: p.updated_at };
  });
}

/**
 * จป. only: reassign the responsible (until they approved: stage assign, or a
 * legacy area / resp) and/or the area owner (stage area) of a pending permit,
 * e.g. when someone is absent. If the CURRENT stage's assignee changes, that
 * stage's clock and reminders restart and the new assignee is notified. The จป.
 * never approves stages 1–2 themself.
 */
function apiReassign_(d, ctx) {
  requireAdmin_(d, ctx);
  var hasR = !!(Number(d.responsible_id) || 0), hasA = !!(Number(d.area_owner_id) || 0);
  if (!hasR && !hasA) fail_('กรุณาเลือกผู้ที่จะมอบหมาย');
  var done = null;
  var out = withLock_(function () {
    relockCtx_(ctx);
    var u = requireAdmin_(d, ctx);
    var x = wfPermit_(d, ctx, u), p = x.p;
    var st = wfStageCheck_(p, ['assign', 'area', 'resp']);
    checkBase_(p, d);
    var notes = [], before = stageAssigneeId_(p, st);
    if (hasR) {
      var ru = activeRoleUser_(ctx, d.responsible_id, 'responsible');
      if (!ru) fail_('ผู้รับผิดชอบงานที่เลือกไม่ถูกต้องหรือถูกปิดการใช้งาน');
      if (Number(ru.id) !== Number(p.responsible_id)) {
        // the signed approval stays with the person who signed it
        if (p.resp_approved_at) fail_('ผู้รับผิดชอบงาน (' + p.responsible_name + ') อนุมัติแล้ว — เปลี่ยนผู้รับผิดชอบงานไม่ได้', 'CONFLICT');
        notes.push('ผู้รับผิดชอบงาน: ' + (p.responsible_name || '-') + ' → ' + ru.fullname);
        p.responsible_id = ru.id; p.responsible_name = ru.fullname;
      }
    }
    if (hasA) {
      if (st !== 'area') fail_('เปลี่ยนเจ้าของพื้นที่ได้เฉพาะในขั้นตอน "' + WP_DATA.stages.area.label + '"', 'CONFLICT');
      var ao = activeRoleUser_(ctx, d.area_owner_id, 'area_owner');
      if (!ao) fail_('เจ้าของพื้นที่ที่เลือกไม่ถูกต้องหรือถูกปิดการใช้งาน');
      if (Number(ao.id) !== Number(p.area_owner_id)) {
        notes.push('เจ้าของพื้นที่: ' + (p.area_owner_name || '-') + ' → ' + ao.fullname);
        p.area_owner_id = ao.id; p.area_owner_name = ao.fullname;
      }
    }
    if (!notes.length) return { changed: false, stage: st, updated_at: p.updated_at };
    var stamp = nowStr_();
    var moved = stageAssigneeId_(p, st) !== before;
    if (moved) enterStage_(p, st, stamp);
    p.updated_at = stamp;
    writeRow_(x.t, p);
    addLog_(ctx, p.id, 'reassign', u.fullname, 'มอบหมายใหม่ — ' + notes.join(', '));
    if (moved) done = { row: p, next: [findById_(table_(ctx, 'users'), stageAssigneeId_(p, st))] };
    return { changed: true, stage: st, updated_at: p.updated_at };
  });
  if (done) notifyStage_(done.row, done.next, true);
  return out;
}

// ---------------------------------------------------------------- RESET / DELETE / EDIT (admin + reset password)
var WP_PROP_RESET_PASSWORD = 'WP_RESET_PASSWORD';
var WP_RESET_MAX_FAIL = 10;
var WP_RESET_FAIL_KEY = 'wprf_reset'; // one global counter (not per user), separate from login lockout

/**
 * Second factor for destructive / corrective admin actions (reset_data,
 * delete, update_permit): the password stored only in Script Property
 * WP_RESET_PASSWORD, sent as `resetPassword`. One shared failure counter:
 * 10 wrong passwords lock all three actions for 15 minutes.
 */
var WP_RESET_WHAT = {
  reset: { label: 'รหัสผ่านสำหรับรีเซ็ตข้อมูล', locked: 'ระงับการรีเซ็ต' },
  'delete': { label: 'รหัสผ่านยืนยัน (Reset password) ', locked: 'ระงับการลบ/แก้ไข/รีเซ็ต' },
  update: { label: 'รหัสผ่านยืนยัน (Reset password) ', locked: 'ระงับการลบ/แก้ไข/รีเซ็ต' }
};
function requireResetPassword_(p, what) {
  var w = WP_RESET_WHAT[what] || WP_RESET_WHAT.update;
  var expected = String(props_().getProperty(WP_PROP_RESET_PASSWORD) || '');
  if (!expected) {
    fail_('ยังไม่ได้ตั้งรหัสผ่านสำหรับรีเซ็ตข้อมูล กรุณาตั้งค่า Script Property "' + WP_PROP_RESET_PASSWORD +
      '" ใน Apps Script (Project Settings > Script properties) ก่อน', 'SETUP');
  }
  var given = typeof p.resetPassword === 'string' ? p.resetPassword : '';
  var cache = cache_();
  var fails = Number(cache.get(WP_RESET_FAIL_KEY)) || 0;
  if (fails >= WP_RESET_MAX_FAIL) {
    fail_('กรอกรหัสผ่านรีเซ็ตผิดเกิน ' + WP_RESET_MAX_FAIL + ' ครั้ง ' + w.locked + 'ชั่วคราว 15 นาที', 'LOCKED');
  }
  // compare fixed-length digests so the comparison does not leak the length
  if (!given || !safeEqual_(sha256Hex_(given), sha256Hex_(expected))) {
    cache.put(WP_RESET_FAIL_KEY, String(fails + 1), WP_LOGIN_LOCK_SEC);
    Utilities.sleep(1000);
    fail_(w.label + 'ไม่ถูกต้อง', 'AUTH_FAILED');
  }
  cache.remove(WP_RESET_FAIL_KEY);
}

/**
 * api.php?action=delete — removes the permit, its logs and its Drive files (to Drive trash).
 * Requires an admin session AND the reset password.
 */
function apiDelete_(d, ctx) {
  requireAdmin_(d, ctx);
  requireResetPassword_(d, 'delete');
  var gone = null, by = '';
  var out = withLock_(function () {
    relockCtx_(ctx); // re-read fresh data (unless nothing was written since) + re-check the session
    var u = requireAdmin_(d, ctx);
    var t = table_(ctx, 'permits');
    var p = findById_(t, d.id);
    if (!p) fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
    var fileIds = permitFileIds_(p);
    fileIds.forEach(trashDriveFile_);
    var lt = table_(ctx, 'permit_logs');
    var logs = lt.rows.filter(function (l) { return Number(l.permit_id) === Number(p.id); });
    deleteRows_(lt, logs);
    deleteRows_(t, [p]);
    cache_().remove('wptf_' + p.permit_no); // a reused number must not inherit the tracking lockout
    console.log('WP delete permit ' + p.permit_no + ' (id ' + p.id + ') by ' + u.username + ' (' + u.fullname + ')');
    gone = {
      permit_no: p.permit_no, company: p.company, status: p.status, logs: logs.length,
      requester: teamsRequester_(p) + (p.requester_company ? ' (' + p.requester_company + ')' : ''),
      files: fileIds.filter(function (x) { return x; }).length
    };
    by = u.fullname;
    return { id: Number(p.id), permit_no: p.permit_no };
  });
  notifyPermitDeleted_(gone, by); // after the lock is released; never throws
  return out;
}

/** Cell equality; JSON cells compare by content (object key order ignored). */
function sameValue_(a, b) {
  a = String(a === undefined || a === null ? '' : a);
  b = String(b === undefined || b === null ? '' : b);
  if (a === b) return true;
  var canon = function (s) {
    var v;
    try { v = JSON.parse(s); } catch (e) { return null; }
    if (!v || typeof v !== 'object') return null;
    // Blank values (false, '', unchecked items, empty LOTO rows) carry no
    // information: the form sends every item while the stored JSON may be sparse.
    var blank = function (x) {
      return x === undefined || x === null || x === '' || x === false ||
        (typeof x === 'object' && !(Array.isArray(x) ? x.length : Object.keys(x).length));
    };
    var norm = function (x) {
      if (Array.isArray(x)) {
        var arr = x.map(norm);
        while (arr.length && blank(arr[arr.length - 1])) arr.pop();
        return arr;
      }
      if (x && typeof x === 'object') {
        var o = {};
        Object.keys(x).sort().forEach(function (k) { var n = norm(x[k]); if (!blank(n)) o[k] = n; });
        return o;
      }
      return x;
    };
    return JSON.stringify(norm(v));
  };
  var ca = canon(a), cb = canon(b);
  return ca !== null && ca === cb;
}

/**
 * update_permit — the จป. admin corrects what the requester keyed in.
 * Only the request-form fields (WP_REQUEST_FIELDS) can change, validated exactly
 * like submit; permit_no, token, status, approvals, inspections, signatures,
 * attachment and logs are never touched (extra keys in the payload are ignored).
 * Requires an admin session AND the reset password. Logs "แก้ไขข้อมูล".
 */
function apiUpdatePermit_(d, ctx) {
  requireAdmin_(d, ctx);
  requireResetPassword_(d, 'update');
  return withLock_(function () {
    relockCtx_(ctx); // re-read fresh data (unless nothing was written since) + re-check the session
    var u = requireAdmin_(d, ctx);
    var t = table_(ctx, 'permits');
    var p = findById_(t, d.id);
    if (!p) fail_('ไม่พบใบอนุญาต', 'NOT_FOUND');
    checkBase_(p, d);
    var f = cleanRequestFields_(d, p);
    var changed = Object.keys(WP_REQUEST_FIELDS).filter(function (k) {
      // a checklist stored before the paper-form update compares in its upgraded form
      var cur = k === 'checklist' ? JSON.stringify(cleanChecklist_(jdec_(p[k], {}))) : p[k];
      return !sameValue_(cur, f[k]);
    });
    if (!changed.length) return { changed: [], permit: permitOut_(p, true) };
    changed.forEach(function (k) { p[k] = f[k]; });
    p.updated_at = nowStr_();
    writeRow_(t, p); // expiry (es / end_ts) is derived from work_date + times on every read
    addLog_(ctx, p.id, 'edit', u.fullname, 'แก้ไขข้อมูล: ' + changed.map(function (k) { return WP_REQUEST_FIELDS[k]; }).join(', '));
    return { changed: changed, permit: permitOut_(p, true) };
  });
}


/**
 * reset_data — wipes all test data so the system can start over:
 *  - every data row of `permits` and `permit_logs` (header row + formats kept)
 *  - every file in the attachments/signatures Drive folder → Drive trash (recoverable for 30 days)
 * Users and their sessions are untouched. Requires an admin session AND the
 * reset password stored only in Script Property WP_RESET_PASSWORD.
 */
function apiResetData_(p, ctx) {
  var u = requireAdmin_(p, ctx);
  requireResetPassword_(p, 'reset');

  var out = withLock_(function () {
    relockCtx_(ctx); // re-read fresh data (unless nothing was written since) + re-check the session
    u = requireAdmin_(p, ctx);
    var pt = table_(ctx, 'permits');
    var lt = table_(ctx, 'permit_logs');
    var permitsRemoved = pt.rows.length, logsRemoved = lt.rows.length;

    // Drive: everything in the app folder, plus any referenced file that lives elsewhere.
    var trashed = 0, seen = {};
    var trashOne = function (f) {
      var id = f.getId();
      if (seen[id]) return;
      seen[id] = true;
      try {
        if (f.isTrashed()) return;
        f.setTrashed(true);
        trashed++;
      } catch (e) { console.warn('reset: trash failed: ' + id); }
    };
    var it = folder_().getFiles();
    while (it.hasNext()) trashOne(it.next());
    var trackKeys = [];
    pt.rows.forEach(function (r) {
      permitFileIds_(r).forEach(function (id) {
        if (!id || seen[id]) return;
        try { trashOne(DriveApp.getFileById(id)); } catch (e) { seen[id] = true; }
      });
      if (r.permit_no) trackKeys.push('wptf_' + r.permit_no);
    });

    // Sheets: clear data rows only (header row, column formats and row count are kept).
    [pt, lt].forEach(function (t) {
      var last = t.sheet.getLastRow();
      if (last > 1) t.sheet.getRange(2, 1, last - 1, t.sheet.getMaxColumns()).clearContent();
    });
    // Track-lockout counters of the removed permit numbers would otherwise hit the
    // new permits that reuse those numbers (numbering restarts at -001).
    trackKeys.forEach(function (k) { cache_().remove(k); });
    ctx.tables = {};

    var result = { permits_removed: permitsRemoved, logs_removed: logsRemoved, files_trashed: trashed, at: nowStr_(), by: u.fullname };
    // Admin audit: there is no audit sheet (a row in permit_logs would itself be "data"),
    // so the reset is recorded in the Apps Script execution log.
    console.log('WP reset_data by ' + u.username + ' (' + u.fullname + '): ' + JSON.stringify(result));
    return result;
  });
  notifyResetData_(out, u.fullname); // after the lock is released; never throws
  return out;
}

// ---------------------------------------------------------------- Microsoft Teams notifications
/**
 * Optional: posts an Adaptive Card to the จป. channel through a Teams
 * "Workflows" webhook ("Post to a channel when a webhook request is received").
 * The webhook URL lives ONLY in Script Property TEAMS_WEBHOOK_URL — unset/empty
 * = no notification. Cards are sent after the write has succeeded and the lock
 * is released; a failure is logged (HTTP status only, never the URL) and never
 * changes the API response or the data. Cards never carry the tracking token,
 * a token-bearing link, signatures or attachments.
 */
var WP_PROP_TEAMS_WEBHOOK = 'TEAMS_WEBHOOK_URL';
var WP_SITE_URL_DEFAULT = 'https://watanathep8-dotcom.github.io/work-permit-thepwatana';
var WP_TEAMS_TEXT_MAX = 300;   // chars per fact value
var WP_TEAMS_NOTE_MAX = 1000;  // chars of a reason / note block
var WP_TEAMS_MENTION_MAX = 10; // people mentioned in one card (stage 3: the active จป.)
var WP_THAI_MONTHS = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** Public site base (no trailing slash): Script Property WP_SITE_URL, else the GitHub Pages default. */
function teamsSiteBase_() {
  var site = String(props_().getProperty(WP_PROP_SITE_URL) || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(site) ? site : WP_SITE_URL_DEFAULT;
}

/** Admin view page of one permit (session-protected page — no token in the link). */
function teamsAdminViewUrl_(id) {
  return teamsSiteBase_() + '/admin/view.html?id=' + (Number(id) || 0);
}

/** "2026-10-05[ 09:30:00]" → "5 ต.ค. 2569[ 09:30 น.]" (same as WP.thaiDate in the browser). */
function teamsThaiDate_(d, withTime) {
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(d || ''));
  if (!m) return '-';
  var s = (+m[3]) + ' ' + WP_THAI_MONTHS[+m[2]] + ' ' + (+m[1] + 543);
  if (withTime) s += ' ' + (m[4] || '00') + ':' + (m[5] || '00') + ' น.';
  return s;
}

/** Single-line, length-limited text for a card. */
function teamsText_(v, max) {
  if (v === null || v === undefined || typeof v === 'object') v = '';
  return str_(String(v).replace(/\s+/g, ' '), max || WP_TEAMS_TEXT_MAX);
}

function teamsWhen_(r) {
  return teamsThaiDate_(r.work_date) + ' เวลา ' + String(r.time_from || '').substring(0, 5) + '–' + String(r.time_to || '').substring(0, 5) + ' น.';
}

function teamsRequester_(r) {
  return [r.requester_title, r.requester_name].filter(function (x) { return str_(x) !== ''; }).join(' ');
}

function teamsWorkTypes_(r) {
  return jdec_(r.work_types, []).map(function (k) {
    return Object.prototype.hasOwnProperty.call(WP_DATA.workTypes, k) ? WP_DATA.workTypes[k].label : '';
  }).filter(function (x) { return x; }).join(', ');
}

/** A user's name as used inside <at>…</at> (one line, no angle brackets). */
function teamsMentionName_(u) {
  return teamsText_(u && u.fullname, 100).replace(/[<>]/g, '') || '-';
}

/**
 * "Name A, Name B" for a card: users with a valid e-mail (company e-mail = Teams
 * UPN) become <at>Name</at> mentions, the others stay plain names.
 * Returns {text, mentions: [{name, email}]}.
 */
function teamsWho_(users) {
  var parts = [], mentions = [];
  (users || []).filter(function (u) { return u; }).slice(0, WP_TEAMS_MENTION_MAX).forEach(function (u) {
    var name = teamsMentionName_(u), email = String(u.email || '').trim().toLowerCase();
    if (email && WP_EMAIL_RE.test(email)) {
      parts.push('<at>' + name + '</at>');
      mentions.push({ name: name, email: email });
    } else {
      parts.push(name);
    }
  });
  return { text: parts.join(', '), mentions: mentions };
}

/**
 * Adaptive Card message. o = {title, color ('Good'|'Attention'), lines: [text], mentions: [{name, email}],
 * facts: [[label, value]], note: {label, text}, url, urlTitle, subtitle}. Empty fact values are left out.
 * `title` / `lines` may contain "<at>Name</at>" for the matching `mentions`
 * (Teams Workflows: msteams.entities of type "mention", mentioned.id = the user's e-mail / UPN).
 */
function teamsCard_(o) {
  var attention = o.color === 'Attention';
  var mentions = [], seen = {};
  (o.mentions || []).forEach(function (m) {
    var k = m.email + '|' + m.name;
    if (!seen[k]) { seen[k] = true; mentions.push(m); }
  });
  var facts = (o.facts || []).map(function (f) { return { title: teamsText_(f[0], 60), value: teamsText_(f[1]) }; })
    .filter(function (f) { return f.title !== '' && f.value !== ''; });
  var body = [{
    type: 'Container', style: attention ? 'attention' : 'good', bleed: true,
    items: [
      // a title with mentions is not cut (a cut could break an <at> tag); names are ≤ 100 chars, ≤ WP_TEAMS_MENTION_MAX people
      { type: 'TextBlock', text: teamsText_(o.title, mentions.length ? 2000 : 120), size: 'Large', weight: 'Bolder', color: attention ? 'Attention' : 'Good', wrap: true },
      { type: 'TextBlock', text: WP_DATA.config.appName + ' (' + WP_DATA.config.formCode + ') · ' + (o.subtitle || 'แจ้งเตือน จป.'), size: 'Small', isSubtle: true, spacing: 'None', wrap: true }
    ]
  }];
  (o.lines || []).forEach(function (line) {
    var text = teamsText_(line, 2000);
    if (text !== '') body.push({ type: 'TextBlock', text: text, wrap: true, weight: 'Bolder', spacing: 'Medium' });
  });
  if (facts.length) body.push({ type: 'FactSet', facts: facts, spacing: 'Medium' });
  var note = o.note ? str_(o.note.text, WP_TEAMS_NOTE_MAX) : '';
  if (note !== '') {
    body.push({ type: 'TextBlock', text: teamsText_(o.note.label, 60), weight: 'Bolder', color: attention ? 'Attention' : 'Default', spacing: 'Medium', wrap: true });
    body.push({ type: 'TextBlock', text: note, wrap: true, spacing: 'Small' });
  }
  body.push({ type: 'TextBlock', text: 'เวลา ' + teamsThaiDate_(nowStr_(), true) + ' (เวลาประเทศไทย)', size: 'Small', isSubtle: true, spacing: 'Medium', wrap: true });
  var content = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard', version: '1.4', body: body, actions: [], msteams: { width: 'Full' }
  };
  if (mentions.length) {
    content.msteams.entities = mentions.map(function (m) {
      return { type: 'mention', text: '<at>' + m.name + '</at>', mentioned: { id: m.email, name: m.name } };
    });
  }
  if (o.url) content.actions.push({ type: 'Action.OpenUrl', title: teamsText_(o.urlTitle || 'เปิดดู', 40), url: o.url });
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: content }] };
}

function teamsWebhookUrl_() {
  try { return String(props_().getProperty(WP_PROP_TEAMS_WEBHOOK) || '').trim(); } catch (e) { return ''; }
}

/**
 * POSTs a message to TEAMS_WEBHOOK_URL. Returns the HTTP status, 0 on a request
 * error, or null when not configured. Never throws; never logs the URL.
 */
function teamsSend_(message) {
  var url = teamsWebhookUrl_();
  if (!url) return null;
  if (!/^https:\/\//i.test(url)) { console.warn('Teams notification skipped: ' + WP_PROP_TEAMS_WEBHOOK + ' is not an https URL'); return null; }
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(message), muteHttpExceptions: true
    });
    var code = Number(res.getResponseCode()) || 0;
    if (code < 200 || code >= 300) console.warn('Teams notification failed: HTTP ' + code);
    return code;
  } catch (e) {
    console.warn('Teams notification failed: request error'); // the exception text may contain the URL
    return 0;
  }
}

/** Builds + sends a card; anything that goes wrong is swallowed (the action already succeeded). */
function notifyTeams_(build) {
  try {
    if (!teamsWebhookUrl_()) return null; // not configured: no work at all
    return teamsSend_(build());
  } catch (e) {
    console.warn('Teams notification skipped: card error');
    return null;
  }
}

/** New permit request (submit) — never called for a replayed / retried submit. */
function notifyNewPermit_(r) {
  return notifyTeams_(function () {
    var owner = [str_(r.owner_name), r.owner_phone ? 'โทร ' + r.owner_phone : ''].filter(function (x) { return x !== ''; }).join(' · ');
    return teamsCard_({
      title: 'มีคำขอใบอนุญาตใหม่ รอพิจารณา', color: 'Good',
      facts: [
        ['เลขที่', r.permit_no],
        ['บริษัท (พื้นที่)', r.company],
        ['ประเภท', WP_DATA.permitTypes[r.permit_type] || r.permit_type],
        ['ลักษณะงาน', teamsWorkTypes_(r)],
        ['วันที่ปฏิบัติงาน', teamsWhen_(r)],
        ['ผู้ขออนุญาต', teamsRequester_(r)],
        ['บริษัท/หน่วยงานผู้ขอ', r.requester_company],
        ['เบอร์โทรผู้ขอ', r.requester_phone],
        ['จำนวนผู้ปฏิบัติงาน', (Number(r.worker_count) || 0) + ' คน'],
        ['สถานที่ปฏิบัติงาน', r.location],
        ['ผู้รับผิดชอบงาน', owner]
      ],
      url: teamsAdminViewUrl_(r.id), urlTitle: 'เปิดพิจารณา'
    });
  });
}

var WP_TEAMS_DECISIONS = {
  approve: { title: 'อนุมัติใบอนุญาตแล้ว', color: 'Good', label: 'อนุมัติให้ปฏิบัติงาน', note: 'หมายเหตุ' },
  reject: { title: 'ไม่อนุมัติใบอนุญาต', color: 'Attention', label: 'ไม่อนุมัติ', note: 'เหตุผลที่ไม่อนุมัติ' },
  close: { title: 'ปิดงานใบอนุญาตแล้ว', color: 'Good', label: 'ปิดงาน', note: 'หมายเหตุ' }
};

/** approve / reject / close by a จป.; reject at stage 1–2 by its assignee (`stage` = where it was rejected). */
function notifyDecision_(r, decision, byName, comment, stage) {
  return notifyTeams_(function () {
    var h = WP_TEAMS_DECISIONS[decision];
    var S = stage ? WP_DATA.stages[stage] : null;
    return teamsCard_({
      title: h.title + ' ' + r.permit_no, color: h.color,
      facts: [
        ['เลขที่', r.permit_no],
        ['บริษัท (พื้นที่)', r.company],
        ['ผู้ขออนุญาต', teamsRequester_(r) + (r.requester_company ? ' (' + r.requester_company + ')' : '')],
        ['วันที่ปฏิบัติงาน', teamsWhen_(r)],
        ['ผลการพิจารณา', h.label],
        ['ขั้นตอน', S ? 'ขั้นที่ ' + S.no + ' — ' + S.label : ''],
        ['โดย', byName]
      ],
      note: comment ? { label: h.note, text: comment } : null,
      url: teamsAdminViewUrl_(r.id), urlTitle: 'ดูใบอนุญาต'
    });
  });
}

/** Admin deleted one permit. info = {permit_no, company, requester, status, logs, files}. */
function notifyPermitDeleted_(info, byName) {
  return notifyTeams_(function () {
    var st = WP_DATA.status[info.status];
    return teamsCard_({
      title: 'ลบใบอนุญาต ' + info.permit_no, color: 'Attention',
      facts: [
        ['เลขที่', info.permit_no],
        ['บริษัท (พื้นที่)', info.company],
        ['ผู้ขออนุญาต', info.requester],
        ['สถานะก่อนลบ', st ? st.label : info.status],
        ['สิ่งที่ถูกลบ', 'ใบอนุญาต 1 ใบ, ประวัติ ' + info.logs + ' รายการ, ไฟล์ ' + info.files + ' ไฟล์ (ย้ายไปถังขยะ Drive)'],
        ['ลบโดย', byName]
      ]
    });
  });
}

/** Admin reset_data. res = apiResetData_ result. */
function notifyResetData_(res, byName) {
  return notifyTeams_(function () {
    return teamsCard_({
      title: 'รีเซ็ตข้อมูลใบอนุญาตทั้งหมด', color: 'Attention',
      facts: [
        ['ใบอนุญาตที่ลบ', res.permits_removed + ' ใบ'],
        ['ประวัติที่ลบ', res.logs_removed + ' รายการ'],
        ['ไฟล์ที่ย้ายไปถังขยะ Drive', res.files_trashed + ' ไฟล์'],
        ['ผู้ใช้งาน จป.', 'ไม่ถูกลบ'],
        ['รีเซ็ตโดย', byName]
      ]
    });
  });
}

// ---------------------------------------------------------------- workflow notifications (@mentions)
/** "รออนุมัติขั้นที่ X: <role> — <at>Name</at>" for the CURRENT stage of r. */
function teamsStageLine_(r, users) {
  var st = stageOf_(r), S = WP_DATA.stages[st];
  var who = teamsWho_(users);
  var text = who.text || (st === 'safety' ? 'เจ้าหน้าที่ความปลอดภัย (จป.)' : '-');
  return { text: 'รออนุมัติขั้นที่ ' + S.no + ': ' + WP_DATA.roles[S.role] + ' — ' + text, mentions: who.mentions };
}

/** Facts shared by the workflow cards (no token, no e-mail). */
function teamsWorkflowFacts_(r) {
  var st = stageOf_(r);
  return [
    ['เลขที่', r.permit_no],
    ['บริษัท (พื้นที่)', r.company],
    ['ลักษณะงาน', teamsWorkTypes_(r)],
    ['วันที่ปฏิบัติงาน', teamsWhen_(r)],
    ['ผู้ขออนุญาต', teamsRequester_(r) + (r.requester_company ? ' (' + r.requester_company + ')' : '')],
    ['สถานที่ปฏิบัติงาน', r.location],
    ['ขั้นตอนปัจจุบัน', st ? WP_DATA.stages[st].label : '']
  ];
}

/** Users to mention for the current stage: its assignee, or the active จป. for stage 3. */
function stageUsers_(ctx, r) {
  var st = stageOf_(r);
  if (st === 'safety') return activeUsersWithRole_(ctx, 'safety');
  var u = findById_(table_(ctx, 'users'), stageAssigneeId_(r, st));
  return u ? [u] : [];
}

/** submit with a responsible: "มีคำขอใบอนุญาตใหม่" @mentioning them (ขั้นที่ 1: approve + pick the area owner). */
function notifyNewWorkflowPermit_(r, resp) {
  return notifyTeams_(function () {
    var who = teamsWho_([resp]);
    var facts = teamsWorkflowFacts_(r);
    facts.splice(5, 0, ['เบอร์โทรผู้ขอ', r.requester_phone], ['จำนวนผู้ปฏิบัติงาน', (Number(r.worker_count) || 0) + ' คน']);
    return teamsCard_({
      title: 'มีคำขอใบอนุญาตใหม่', color: 'Good', subtitle: 'แจ้งเตือนผู้อนุมัติ',
      lines: ['ขั้นที่ ' + WP_DATA.stages.assign.no + ': ' + WP_DATA.roles.responsible + ' — ' + who.text + ' กรุณาเข้าสู่ระบบเพื่อตรวจสอบ ลงนามอนุมัติ และระบุเจ้าของพื้นที่'],
      mentions: who.mentions,
      facts: facts,
      url: teamsAdminViewUrl_(r.id), urlTitle: 'เปิดพิจารณา / อนุมัติ'
    });
  });
}

/** A stage completed (or its assignee was replaced): card to the next approver. */
function notifyStage_(r, users, reassigned) {
  return notifyTeams_(function () {
    var line = teamsStageLine_(r, users);
    return teamsCard_({
      title: line.text, color: 'Good', subtitle: reassigned ? 'มอบหมายผู้อนุมัติใหม่' : 'แจ้งเตือนผู้อนุมัติ',
      mentions: line.mentions,
      lines: [reassigned ? 'จป. มอบหมายผู้อนุมัติใหม่สำหรับ ' + r.permit_no : 'ขั้นตอนก่อนหน้าเสร็จแล้ว — ' + r.permit_no + ' รอการพิจารณาของท่าน'],
      facts: teamsWorkflowFacts_(r),
      url: teamsAdminViewUrl_(r.id), urlTitle: 'เปิดพิจารณา'
    });
  });
}

/**
 * work_done: "ผู้รับเหมาแจ้งเสร็จงาน" @mentioning the responsible, the area owner and the
 * จป. (`users`, at most WP_TEAMS_MENTION_MAX; no e-mail → plain name). No photo / token in the card.
 */
function notifyWorkDone_(r, users, photoCount) {
  return notifyTeams_(function () {
    var who = teamsWho_(users);
    return teamsCard_({
      title: 'ผู้รับเหมาแจ้งเสร็จงาน ' + r.permit_no, color: 'Good', subtitle: 'แจ้งเสร็จงาน',
      lines: [(who.text ? who.text + ' — ' : '') + 'กรุณาตรวจสอบหลังเสร็จงาน แล้วให้ จป. ปิดงาน'],
      mentions: who.mentions,
      facts: [
        ['เลขที่', r.permit_no],
        ['บริษัท (พื้นที่)', r.company],
        ['สถานที่ปฏิบัติงาน', r.location],
        ['วันที่ปฏิบัติงาน', teamsWhen_(r)],
        ['ผู้ขออนุญาต', teamsRequester_(r) + (r.requester_company ? ' (' + r.requester_company + ')' : '')],
        ['รูปถ่ายเมื่อเสร็จงาน', (Number(photoCount) || 0) + ' รูป'],
        ['แจ้งเมื่อ', teamsThaiDate_(r.work_done_at, true)]
      ],
      note: r.work_done_note ? { label: 'หมายเหตุจากผู้รับเหมา', text: r.work_done_note } : null,
      url: teamsAdminViewUrl_(r.id), urlTitle: 'ดูใบอนุญาต'
    });
  });
}

// ---------------------------------------------------------------- approval reminders (time trigger, Setup.gs)
/**
 * A stage that has waited WP_REMIND_AFTER_SEC gets a reminder card @mentioning
 * its assignee, then one every WP_REMIND_EVERY_SEC, at most WP_REMIND_MAX per
 * stage. A stage change (enterStage_) restarts the count; a decided permit is not
 * pending any more. Bookkeeping (last_reminder_at, reminder_count) is written
 * under the script lock BEFORE the card is sent, so overlapping or restarted
 * trigger runs never send the same reminder twice (at most once: a failed send is
 * not retried). It replaces only the write mark, not the data version (reminder
 * fields are in no cached read). Permits from before the workflow (no
 * stage_started_at) are never reminded.
 */
var WP_REMIND_AFTER_SEC = 1800;
var WP_REMIND_EVERY_SEC = 1800;
var WP_REMIND_MAX = 6;
var WP_REMIND_PER_RUN = 20; // UrlFetch quota: the rest is picked up by the next run (still due)

function reminderDue_(r, now) {
  if (!stageOf_(r)) return false;
  var started = stampTs_(r.stage_started_at);
  if (!started) return false;
  if ((Number(r.reminder_count) || 0) >= WP_REMIND_MAX) return false;
  var last = stampTs_(r.last_reminder_at);
  return now - started >= WP_REMIND_AFTER_SEC && (!last || now - last >= WP_REMIND_EVERY_SEC);
}

/** Time trigger (every 5 min, installApprovalReminderTrigger()). Never throws. */
function checkApprovalReminders() {
  if (!props_().getProperty(WP_PROP_SPREADSHEET)) return { ok: false, skipped: 'setupSystem() ยังไม่ได้รัน' };
  if (!teamsWebhookUrl_()) return { ok: true, due: 0, sent: 0, skipped: 'ไม่ได้ตั้งค่า ' + WP_PROP_TEAMS_WEBHOOK };
  var jobs = [], now;
  try {
    now = nowTs_();
    // cheap check without the lock: nothing due → done
    if (!table_({ tables: {} }, 'permits').rows.some(function (r) { return reminderDue_(r, now); })) return { ok: true, due: 0, sent: 0 };
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return { ok: false, skipped: 'busy' };
    try {
      var ctx = { tables: {} };
      var t = table_(ctx, 'permits'); // fresh, under the lock
      var stamp = nowStr_();
      t.rows.filter(function (r) { return reminderDue_(r, now); })
        .sort(function (a, b) { return stampTs_(a.stage_started_at) - stampTs_(b.stage_started_at) || Number(a.id) - Number(b.id); })
        .slice(0, WP_REMIND_PER_RUN)
        .forEach(function (r) {
          r.reminder_count = String((Number(r.reminder_count) || 0) + 1);
          r.last_reminder_at = stamp;
          writeRow_(t, r);
          jobs.push({ row: r, users: stageUsers_(ctx, r) });
        });
      if (jobs.length) { SpreadsheetApp.flush(); bumpWriteMark_(); }
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    console.warn('approval reminders failed: ' + (e && e.message ? e.message : e));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  var sent = 0;
  jobs.forEach(function (j) {
    var code = notifyReminder_(j.row, j.users, now);
    if (code >= 200 && code < 300) sent++;
  });
  return { ok: true, due: jobs.length, sent: sent };
}

function notifyReminder_(r, users, now) {
  return notifyTeams_(function () {
    var line = teamsStageLine_(r, users);
    var mins = Math.max(0, Math.floor((now - stampTs_(r.stage_started_at)) / 60));
    var facts = teamsWorkflowFacts_(r);
    facts.push(['รอตั้งแต่', teamsThaiDate_(r.stage_started_at, true)]);
    return teamsCard_({
      title: 'ค้างอนุมัติ ' + mins + ' นาที — ' + r.permit_no, color: 'Attention', subtitle: 'เตือนผู้อนุมัติ',
      lines: [line.text, 'แจ้งเตือนครั้งที่ ' + r.reminder_count + '/' + WP_REMIND_MAX],
      mentions: line.mentions,
      facts: facts,
      url: teamsAdminViewUrl_(r.id), urlTitle: 'เปิดพิจารณา'
    });
  });
}
