/**
 * e-Work Permit (FM-MR-58) — Google Apps Script backend.
 *
 * Ported from the PHP/MySQL app (api.php + server-side logic of the PHP pages).
 * Storage: one Google Sheet (tabs: users, permits, permit_logs) and one private
 * Drive folder for attachments + signature images.
 *
 * Files (all share one global scope in Apps Script):
 *   Code.gs     — router (doGet/doPost), response helpers, sheet "DB" helpers, utilities
 *   Auth.gs     — password hashing, login/logout/sessions (CacheService), users + roles (safety / responsible / area_owner)
 *   Permits.gs  — permit actions (submit, track, list, view, approval workflow, review, decide, edit, delete, reset, files)
 *                 + Teams notifications (@mentions) + approval reminders
 *   Setup.gs    — setupSystem() (run once / after an upgrade), keepWarm() + its 10-min trigger,
 *                 approval-reminder trigger (every 5 min), testTeamsNotification()
 *   Data.gs     — reference data (companies, checklists, rules) — single source of truth
 *
 * Transport (same as our SDS project):
 *   GET  ?action=config|stats|ping            → public, no secrets
 *   POST body = JSON {action, ...}            → everything else
 *        (Content-Type: text/plain to avoid a CORS preflight)
 *   POST {action:'batch', session, calls:[{action, ...}, ...]} → several READ actions in
 *        one round-trip (each sheet read once); data = [{ok, data} | {ok:false, error, code}]
 *   Response: {ok:true, data} | {ok:false, error, code}
 *
 * Speed: every write runs under withLock_, which replaces a random "data version"
 * (CacheService). Expensive derived reads (stats, dashboard, permits list, poll)
 * are cached under that version, so a cached value can never outlive a write.
 * Apps Script cannot read cookies/headers, so the admin session token travels in
 * the POST body (`session`) and the requester's tracking token as `no` + `t`.
 */

var WP_TZ = 'Asia/Bangkok';
var WP_PROP_SPREADSHEET = 'WP_SPREADSHEET_ID';
var WP_PROP_FOLDER = 'WP_FOLDER_ID';
var WP_PROP_INITIAL_ADMIN_PASSWORD = 'WP_INITIAL_ADMIN_PASSWORD';
var WP_PROP_SITE_URL = 'WP_SITE_URL'; // optional: public GitHub Pages URL, used to build absolute tracking links
var WP_CELL_MAX = 49000;              // Google Sheets cell limit is 50,000 characters

var WP_SCHEMA = {
  users: ['id', 'username', 'salt', 'password_hash', 'iterations', 'fullname', 'position', 'active', 'must_change', 'created_at',
    'roles', 'email'],
  permits: ['id', 'permit_no', 'token', 'company', 'permit_type', 'work_types', 'work_date', 'time_from', 'time_to',
    'requester_title', 'requester_name', 'requester_company', 'requester_phone', 'worker_count', 'workers',
    'owner_name', 'owner_phone', 'job_detail', 'location', 'checklist', 'loto', 'confined', 'inspections',
    'requester_sign_file', 'owner_sign_file', 'attachment_file', 'attachment_name', 'attachment_mime',
    'status', 'approver_id', 'approver_name', 'approver_sign_file', 'approve_comment', 'approved_at', 'closed_at',
    'created_at', 'updated_at',
    // approval workflow (stage 1 assign = responsible approves + picks the area owner → 2 area owner → 3 จป.;
    // legacy in-flight: area → resp → จป.); see Permits.gs
    'responsible_id', 'responsible_name', 'area_owner_id', 'area_owner_name', 'stage', 'stage_started_at',
    'area_assigned_at', 'area_approved_at', 'area_sign_file', 'area_comment',
    'resp_approved_at', 'resp_sign_file', 'resp_comment', 'reject_stage',
    'last_reminder_at', 'reminder_count'],
  permit_logs: ['id', 'permit_id', 'action', 'by_name', 'note', 'created_at']
};
/**
 * Columns added after the first deployments. setupSystem() creates them, but a live
 * sheet may not have re-run it: reading never requires them (a missing cell reads as
 * empty) and the code that writes one creates it first (ensureColumn_).
 *  - permits.item_files: JSON [{fid, item, name, mime, size, file}] — files attached to the
 *    checklist items "เอกสารรับรองที่เกี่ยวข้อง" / "อื่นๆ" (the Drive id `file` never leaves the server)
 */
//  - permits.work_done_at / work_done_note / work_done_photos: the contractor's "แจ้งเสร็จงาน"
//    (action work_done, token holder); photos JSON [{fid, name, mime, size, file}] like item_files
var WP_SCHEMA_OPTIONAL = {
  permits: ['item_files', 'work_done_at', 'work_done_note', 'work_done_photos']
};

// ---------------------------------------------------------------- errors
function WpError(message, code) {
  this.name = 'WpError';
  this.message = message;
  this.code = code || 'BAD_REQUEST';
}
WpError.prototype = Object.create(Error.prototype);
WpError.prototype.constructor = WpError;

function fail_(message, code) { throw new WpError(message, code); }

// ---------------------------------------------------------------- entry points
function doGet(e) {
  var params = (e && e.parameter) || {};
  return handle_(String(params.action || ''), params, 'GET');
}

function doPost(e) {
  var body = (e && e.postData && e.postData.contents) || '';
  var payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'รูปแบบข้อมูลไม่ถูกต้อง', code: 'BAD_REQUEST' });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  return handle_(String(payload.action || ''), payload, 'POST');
}

// Built lazily: in Apps Script each .gs file is evaluated in order, so a map
// built at load time could not reference functions declared in later files.
function routes_() {
  return {
    // public
    ping: function () { return { app: WP_DATA.config.appName, form: WP_DATA.config.formCode, time: nowStr_() }; },
    config: apiConfig_,
    stats: apiStats_,
    submit: apiSubmit_,
    track: apiTrack_,
    track_list: apiTrackList_,   // public short list (no phone / details / token)
    login: apiLogin_,
    logout: apiLogout_,
    responsibles: apiResponsibles_,  // active "ผู้รับผิดชอบงาน": id + name only
    // logged-in user (any role) for permits they may see, OR permit-token holder
    permit: apiPermit_,
    file: apiFile_,
    work_done: apiWorkDone_,         // token holder only: the contractor reports the work done (+ photos)
    // any logged-in user (approvers: responsible / area_owner; their own stage only)
    me: apiMe_,
    my_tasks: apiMyTasks_,
    approvers: apiApprovers_,
    assign_area: apiAssignArea_,
    stage_decide: apiStageDecide_,
    inspect_sign: apiInspectSign_,   // area owner / responsible: own inspection cells of an approved permit
    // จป. (role safety) only
    reassign: apiReassign_,
    poll: apiPoll_,
    dashboard: apiDashboard_,
    permits: apiPermits_,
    save_review: apiSaveReview_,
    decide: apiDecide_,
    'delete': apiDelete_,           // + reset password
    update_permit: apiUpdatePermit_, // + reset password
    users: apiUsers_,
    user_save: apiUserSave_,
    user_toggle: apiUserToggle_,
    reset_data: apiResetData_,      // + reset password
    // several read actions in one round-trip
    batch: apiBatch_
  };
}
var WP_GET_ACTIONS = { ping: true, config: true, stats: true, responsibles: true, track_list: true };

function handle_(action, params, method) {
  try {
    var routes = routes_();
    if (!Object.prototype.hasOwnProperty.call(routes, action)) fail_('Unknown action', 'NOT_FOUND');
    if (method === 'GET' && !WP_GET_ACTIONS[action]) fail_('คำสั่งนี้ต้องเรียกด้วย POST', 'BAD_REQUEST');
    var ctx = { tables: {}, user: null };
    return jsonOut_({ ok: true, data: routes[action](params, ctx) });
  } catch (err) {
    if (err instanceof WpError) return jsonOut_({ ok: false, error: err.message, code: err.code });
    console.error(err && err.stack ? err.stack : err);
    return jsonOut_({ ok: false, error: 'เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : String(err)), code: 'SERVER' });
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function apiConfig_() {
  return WP_DATA;
}

/**
 * batch — runs several READ actions with one shared request context, so the
 * users / permits / logs sheets are read at most once for all of them. Every
 * sub-call uses the batch's own `session` (a sub-call cannot carry another one)
 * and goes through exactly the same action function (= same auth checks and
 * output) as a single call. Errors are reported per sub-call.
 */
var WP_BATCH_ACTIONS = {
  me: true, poll: true, dashboard: true, permits: true, users: true, permit: true, stats: true,
  my_tasks: true, approvers: true, responsibles: true
};
var WP_BATCH_MAX = 8;
function apiBatch_(p, ctx) {
  var calls = Array.isArray(p.calls) ? p.calls : [];
  if (!calls.length || calls.length > WP_BATCH_MAX) fail_('คำสั่งไม่ถูกต้อง');
  var routes = routes_();
  return calls.map(function (c) {
    var params = {};
    if (c && typeof c === 'object' && !Array.isArray(c)) Object.keys(c).forEach(function (k) { params[k] = c[k]; });
    params.session = p.session;
    var action = String(params.action || '');
    try {
      if (!Object.prototype.hasOwnProperty.call(WP_BATCH_ACTIONS, action)) fail_('Unknown action', 'NOT_FOUND');
      return { ok: true, data: routes[action](params, ctx) };
    } catch (err) {
      if (err instanceof WpError) return { ok: false, error: err.message, code: err.code };
      console.error(err && err.stack ? err.stack : err);
      return { ok: false, error: 'เกิดข้อผิดพลาด: ' + (err && err.message ? err.message : String(err)), code: 'SERVER' };
    }
  });
}

// ---------------------------------------------------------------- data version + read cache
/**
 * Data version: a random token in CacheService, replaced after EVERY write
 * (withLock_ / setupSystem). Cached reads are keyed by it, so a write makes all
 * of them unreachable at once. If the token is evicted a new random one is
 * created — that only causes misses, never stale hits.
 * Cached values are admin-wide data or public aggregates only (never file
 * contents, never anything served through a requester's tracking token). Each
 * carries its own "valid until" (approved permits turn "expired" by the clock,
 * "today" changes at midnight) and a short TTL as a backstop for manual sheet edits.
 */
var WP_DV_KEY = 'wpdv';
var WP_READ_CACHE_TTL = 300;  // s
var WP_WARM_TTL = 660;        // s — values refreshed by keepWarm (every 10 min) live until just after its next run
var WP_CACHE_CHUNK = 30000;   // chars per cache value: ≤ 90 KB even if every char is 3-byte UTF-8 (limit 100 KB)
var WP_CACHE_MAX_CHUNKS = 20;

function dataVersion_(ctx) {
  if (ctx && ctx.dv) return ctx.dv;
  var cache = cache_();
  var v = cache.get(WP_DV_KEY);
  if (!v) { v = randomHex_(16); cache.put(WP_DV_KEY, v, 21600); }
  if (ctx) ctx.dv = v;
  return v;
}

/**
 * Write mark: a second random token, replaced by writes that must NOT invalidate
 * the read cache (approval-reminder bookkeeping: last_reminder_at / reminder_count
 * are never part of a cached read). relockCtx_ compares it too, so a writer that
 * read the sheets before such a write re-reads them under the lock and never
 * writes an old copy of the row back.
 */
var WP_WV_KEY = 'wpwv';
function writeMark_() { try { return String(cache_().get(WP_WV_KEY) || ''); } catch (e) { return ''; } }
function bumpWriteMark_() {
  try { cache_().put(WP_WV_KEY, randomHex_(16), 21600); } catch (e) { bumpDataVersion_(); } // could not mark: fall back to a full bump
}

function bumpDataVersion_() {
  try { cache_().put(WP_DV_KEY, randomHex_(16), 21600); } catch (e) {
    // could not replace the token: drop it, the next reader creates a fresh one
    try { cache_().remove(WP_DV_KEY); } catch (e2) { console.error('data version bump failed'); }
  }
}

function cacheGetBig_(key) {
  var cache = cache_();
  var head = cache.get(key);
  if (!head) return null;
  var n = Number(head);
  if (!(n >= 1 && n <= WP_CACHE_MAX_CHUNKS)) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '.' + i);
  var parts = cache.getAll(keys), out = '';
  for (var j = 0; j < n; j++) {
    if (typeof parts[keys[j]] !== 'string') return null;
    out += parts[keys[j]];
  }
  return out;
}

function cachePutBig_(key, str, ttl) {
  var n = Math.ceil(str.length / WP_CACHE_CHUNK) || 1;
  if (n > WP_CACHE_MAX_CHUNKS) return;
  var vals = {};
  for (var i = 0; i < n; i++) vals[key + '.' + i] = str.substring(i * WP_CACHE_CHUNK, (i + 1) * WP_CACHE_CHUNK);
  try {
    var cache = cache_();
    cache.putAll(vals, ttl);
    cache.put(key, String(n), ttl); // head last: readers never see a half-written value
  } catch (e) { console.warn('read cache put failed: ' + key); }
}

/**
 * Returns compute().data, from cache when possible. `name` + `params` identify
 * the read (params are hashed into the key); compute() returns {data, until}
 * where `until` (unix s) is when the data becomes stale by the clock. Callers do
 * their own auth checks first — the cache never replaces them.
 */
function cachedRead_(ctx, name, params, compute) {
  var key = 'wpc_' + dataVersion_(ctx) + '_' + name + '_' + sha256Hex_(JSON.stringify(params || {})).substring(0, 32);
  var now = nowTs_();
  // keepWarm (ctx.warm): always recompute, and keep the value until shortly after the next run
  var hit = ctx && ctx.warm ? null : cacheGetBig_(key);
  if (hit) {
    var o = jdec_(hit, null);
    if (o && Number(o.u) > now && Object.prototype.hasOwnProperty.call(o, 'd')) return o.d;
  }
  var res = compute();
  var ttl = Math.min(ctx && ctx.warm ? WP_WARM_TTL : WP_READ_CACHE_TTL, Math.floor(res.until) - now);
  if (ttl >= 1) cachePutBig_(key, JSON.stringify({ u: res.until, d: res.data }), ttl);
  return res.data;
}

/** Until when derived permit data stays right by the clock: next Bangkok midnight or the next approved permit's expiry. */
function permitsValidUntil_(rows) {
  var now = nowTs_();
  var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayStr_());
  var until = Date.UTC(+d[1], +d[2] - 1, +d[3] + 1) / 1000 - 7 * 3600; // next 00:00 in Asia/Bangkok
  rows.forEach(function (r) {
    if (r.status !== 'approved') return;
    var end = permitEndTs_(r);
    if (end >= now && end < until) until = end;
  });
  return until;
}

// ---------------------------------------------------------------- locking
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) fail_('ระบบกำลังทำงานหนาแน่น กรุณาลองใหม่อีกครั้ง', 'BUSY');
  var flushed = false;
  try {
    var result = fn();
    SpreadsheetApp.flush();
    flushed = true;
    return result;
  } finally {
    // Every write (even one that failed half-way) invalidates all cached reads.
    // Flush first so no reader can see the new version together with old sheet data.
    if (!flushed) { try { SpreadsheetApp.flush(); } catch (e) { console.warn('flush failed'); } }
    bumpDataVersion_();
    lock.releaseLock();
  }
}

/**
 * First thing inside withLock_: tables read before the lock are kept only if no
 * write happened since they were read (data version unchanged) — otherwise all
 * are read again. The session is always re-checked (ctx.user cleared).
 */
function relockCtx_(ctx) {
  if (!ctx.dv0 || ctx.dv0 !== cache_().get(WP_DV_KEY) || ctx.wv0 !== writeMark_()) ctx.tables = {};
  ctx.dv = null;
  ctx.user = null;
}

// ---------------------------------------------------------------- spreadsheet "DB"
function props_() { return PropertiesService.getScriptProperties(); }

function spreadsheet_() {
  var id = props_().getProperty(WP_PROP_SPREADSHEET);
  if (!id) fail_('ระบบยังไม่ได้ตั้งค่า กรุณารัน setupSystem() ใน Apps Script ก่อน', 'SETUP');
  return SpreadsheetApp.openById(id);
}

function folder_() {
  var id = props_().getProperty(WP_PROP_FOLDER);
  if (!id) fail_('ระบบยังไม่ได้ตั้งค่า กรุณารัน setupSystem() ใน Apps Script ก่อน', 'SETUP');
  return DriveApp.getFolderById(id);
}

/**
 * Loads a whole sheet once per request (getDataRange().getValues()) and maps
 * rows to objects by header name. Writes go through writeRow_/appendRow_.
 */
function table_(ctx, name) {
  if (ctx.tables[name]) return ctx.tables[name];
  // data version as of this request's first sheet read (see relockCtx_)
  if (!ctx.dv0) { ctx.dv0 = dataVersion_(ctx); ctx.wv0 = writeMark_(); }
  if (!ctx.ss) ctx.ss = spreadsheet_();
  var sheet = ctx.ss.getSheetByName(name);
  if (!sheet) fail_('ไม่พบชีต "' + name + '" กรุณารัน setupSystem() อีกครั้ง', 'SETUP');
  var values = sheet.getDataRange().getValues();
  var headers = (values[0] || []).map(function (h) { return String(h); });
  WP_SCHEMA[name].forEach(function (h) {
    if (headers.indexOf(h) < 0) fail_('โครงสร้างชีต "' + name + '" ไม่ครบ (ขาดคอลัมน์ ' + h + ') กรุณารัน setupSystem()', 'SETUP');
  });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r], empty = true, obj = { _row: r + 1 };
    for (var c = 0; c < headers.length; c++) {
      var v = fromCell_(row[c]);
      if (v !== '') empty = false;
      obj[headers[c]] = v;
    }
    if (!empty) rows.push(obj);
  }
  ctx.tables[name] = { name: name, sheet: sheet, headers: headers, rows: rows };
  return ctx.tables[name];
}

function fromCell_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, WP_TZ, 'yyyy-MM-dd HH:mm:ss');
  }
  var s = String(v);
  // undo the formula guard if Sheets kept the quote prefix
  if (/^'[=+\-@]/.test(s)) s = s.substring(1);
  return s;
}

function toCell_(v, column) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.length > WP_CELL_MAX) {
    fail_('ข้อมูล "' + column + '" ยาวเกินขีดจำกัดของ Google Sheets (' + WP_CELL_MAX + ' ตัวอักษร) กรุณาลดข้อมูลหรือแนบเป็นไฟล์แทน', 'TOO_LARGE');
  }
  // Never let user text be interpreted as a formula.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function rowValues_(t, obj) {
  return t.headers.map(function (h) { return toCell_(obj[h], h); });
}

/** Adds header `h` after the last column when the live sheet lacks it (call under the lock). */
function ensureColumn_(t, h) {
  if (t.headers.indexOf(h) >= 0) return;
  var sh = t.sheet, col = t.headers.length + 1;
  if (sh.getMaxColumns() < col) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  var cell = sh.getRange(1, col, 1, 1);
  cell.setNumberFormat('@');
  cell.setValues([[h]]);
  t.headers.push(h);
}

function appendRow_(t, obj) {
  var values = rowValues_(t, obj);
  var sheet = t.sheet;
  var rowIndex = sheet.getLastRow() + 1;
  if (rowIndex > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  var range = sheet.getRange(rowIndex, 1, 1, values.length);
  range.setNumberFormat('@'); // keep phone numbers, dates and times as plain text
  range.setValues([values]);
  obj._row = rowIndex;
  t.rows.push(storedRow_(t, obj)); // later reads in this request see the cells as stored
  return obj;
}

function writeRow_(t, obj) {
  var values = rowValues_(t, obj);
  var range = t.sheet.getRange(obj._row, 1, 1, values.length);
  range.setNumberFormat('@');
  range.setValues([values]);
  return obj;
}

/** The row exactly as a later table_() read returns it (cells as Sheets stores them). */
function storedRow_(t, obj) {
  var out = { _row: obj._row };
  t.headers.forEach(function (h) {
    var v = toCell_(obj[h], h);
    if (v.charAt(0) === "'") v = v.substring(1); // a leading apostrophe is Sheets' quote prefix, not text
    out[h] = fromCell_(v);
  });
  return out;
}

function deleteRows_(t, objs) {
  objs.map(function (o) { return o._row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (r) { t.sheet.deleteRow(r); });
  var gone = {};
  objs.forEach(function (o) { gone[o._row] = true; });
  t.rows = t.rows.filter(function (o) { return !gone[o._row]; });
}

function nextId_(t) {
  var max = 0;
  t.rows.forEach(function (r) { var n = Number(r.id) || 0; if (n > max) max = n; });
  return max + 1;
}

function findById_(t, id) {
  id = Number(id) || 0;
  if (!id) return null;
  for (var i = 0; i < t.rows.length; i++) if (Number(t.rows[i].id) === id) return t.rows[i];
  return null;
}

// ---------------------------------------------------------------- utilities
function now_() { return new Date(); } // single clock source (tests override it)
function nowTs_() { return Math.floor(now_().getTime() / 1000); }
function nowStr_() { return Utilities.formatDate(now_(), WP_TZ, 'yyyy-MM-dd HH:mm:ss'); }
function todayStr_() { return Utilities.formatDate(now_(), WP_TZ, 'yyyy-MM-dd'); }
/** Unix seconds of a nowStr_() stamp ("YYYY-MM-DD HH:MM[:SS]", Bangkok wall time); 0 if not a stamp. */
function stampTs_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000 - 7 * 3600;
}

/** mb_substr(trim((string)$v), 0, $max) */
function str_(v, max) {
  if (v === null || v === undefined || typeof v === 'object') v = '';
  var s = String(v).trim();
  max = max || 255;
  if (s.length > max) s = Array.from(s).slice(0, max).join('');
  return s;
}

function jdec_(s, fallback) {
  if (s === '' || s === null || s === undefined) return fallback;
  try {
    var v = JSON.parse(s);
    return (v && typeof v === 'object') ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function bytesToHex_(bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    out.push((b < 16 ? '0' : '') + b.toString(16));
  }
  return out.join('');
}

function sha256Hex_(s) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

/** Random lowercase hex string of length n (UUIDs + Math.random mixed through SHA-256). */
function randomHex_(n) {
  var out = '';
  while (out.length < n) {
    out += sha256Hex_(Utilities.getUuid() + ':' + Utilities.getUuid() + ':' + Math.random() + ':' + Date.now() + ':' + out);
  }
  return out.substring(0, n);
}

/** Constant-time string comparison. */
function safeEqual_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length || !a.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
