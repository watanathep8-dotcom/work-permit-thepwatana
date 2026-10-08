/**
 * One-time setup. Run setupSystem() from the Apps Script editor and approve the
 * Google Sheets / Google Drive permissions. Safe to run again (idempotent):
 * existing spreadsheet, sheets, folder and users are kept; missing pieces are
 * created.
 *
 * Before the FIRST run set Script Property WP_INITIAL_ADMIN_PASSWORD
 * (Project Settings > Script properties). It becomes the password of user
 * `admin`; change it right after the first login, then delete the property.
 *
 * Upgrades: run it again after pasting a new version (BEFORE deploying it) — it
 * adds the new columns and migrates users without roles to role `safety` (จป.).
 */
function setupSystem() {
  var props = props_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = null;
    var ssId = props.getProperty(WP_PROP_SPREADSHEET);
    if (ssId) {
      try { ss = SpreadsheetApp.openById(ssId); } catch (e) { ss = null; }
    }

    // Decide whether an initial admin is needed BEFORE creating anything.
    var needAdmin = true;
    if (ss) {
      var us = ss.getSheetByName('users');
      if (us && us.getLastRow() > 1) needAdmin = false;
    }
    var initialPassword = props.getProperty(WP_PROP_INITIAL_ADMIN_PASSWORD) || '';
    if (needAdmin && initialPassword.length < 8) {
      throw new Error(
        'กรุณาตั้งค่า Script Property "' + WP_PROP_INITIAL_ADMIN_PASSWORD + '" (อย่างน้อย 8 ตัวอักษร) ก่อนรัน setupSystem() — ' +
        'Project Settings > Script properties. / Set Script Property ' + WP_PROP_INITIAL_ADMIN_PASSWORD +
        ' (min 8 characters) before running setupSystem().'
      );
    }

    var createdSpreadsheet = false;
    if (!ss) {
      ss = SpreadsheetApp.create('e-Work Permit (FM-MR-58) Database');
      createdSpreadsheet = true;
    }
    Object.keys(WP_SCHEMA).forEach(function (name, i) {
      var headers = WP_SCHEMA[name].concat(WP_SCHEMA_OPTIONAL[name] || []);
      var sh = ss.getSheetByName(name);
      if (!sh) {
        var first = ss.getSheets()[0];
        if (createdSpreadsheet && i === 0 && first && first.getLastRow() === 0) {
          sh = first;
          sh.setName(name);
        } else {
          sh = ss.insertSheet(name);
        }
      }
      var ensureCols = function (n) {
        if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
      };
      if (sh.getLastRow() === 0) {
        ensureCols(headers.length);
        sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      } else {
        // add any missing columns at the end (forward-compatible upgrades)
        var cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
        var missing = headers.filter(function (h) { return cur.indexOf(h) < 0; });
        if (missing.length) {
          ensureCols(cur.length + missing.length);
          sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]);
        }
      }
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
      // Everything is stored as plain text (phones keep leading zeros, dates/times stay strings).
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    });

    var folder = null;
    var folderId = props.getProperty(WP_PROP_FOLDER);
    if (folderId) {
      try { folder = DriveApp.getFolderById(folderId); } catch (e2) { folder = null; }
    }
    if (!folder) folder = DriveApp.createFolder('e-Work Permit (FM-MR-58) Files');

    props.setProperties({ WP_SPREADSHEET_ID: ss.getId(), WP_FOLDER_ID: folder.getId() }, false);

    // Roles migration: users from before roles existed were all จป. → role safety.
    var migrated = 0;
    var mctx = { tables: {}, ss: ss };
    var ut = table_(mctx, 'users');
    ut.rows.forEach(function (u) {
      if (String(u.roles || '').trim() === '') { u.roles = 'safety'; writeRow_(ut, u); migrated++; }
    });

    var adminCreated = false;
    if (needAdmin) {
      var ctx = { tables: {}, ss: ss };
      var t = table_(ctx, 'users');
      if (!t.rows.length) {
        var pf = makePasswordFields_(initialPassword);
        pf.id = 1;
        pf.username = 'admin';
        pf.fullname = 'ผู้ดูแลระบบ จป.';
        pf.position = WP_DATA.config.defaultPosition;
        pf.roles = 'safety';
        pf.email = '';
        pf.active = '1';
        pf.must_change = '1';
        pf.created_at = nowStr_();
        appendRow_(t, pf);
        adminCreated = true;
      }
    }
    SpreadsheetApp.flush();
    bumpDataVersion_(); // cached reads must not survive a (re-)setup

    var result = {
      spreadsheetUrl: ss.getUrl(),
      folderUrl: folder.getUrl(),
      adminCreated: adminCreated,
      usersMigratedToSafety: migrated,
      note: adminCreated
        ? 'สร้างผู้ใช้ admin แล้ว — เข้าสู่ระบบแล้วเปลี่ยนรหัสผ่านทันที และลบ Script Property ' + WP_PROP_INITIAL_ADMIN_PASSWORD
        : 'ระบบพร้อมใช้งาน (ไม่ได้สร้างผู้ใช้ใหม่)'
    };
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- keep-warm (optional)
/**
 * keepWarm() — run by a time trigger every 10 minutes (installKeepWarmTrigger()).
 * Recomputes the shared read caches that every visit needs first: public stats,
 * dashboard aggregates, the default / "pending" permits lists and the bell poll.
 * Only values the request path already caches (admin-wide data and public
 * aggregates — never a tracking token, a session, a file or a signature).
 * It writes no sheet row and never replaces the data version: values are stored
 * under the current version, so any later write still makes them unreachable.
 * Side effect: the script runtime is exercised regularly, which MAY shorten
 * Google's web-app cold start — Google does not guarantee that.
 */
var WP_KEEPWARM_HANDLER = 'keepWarm';
var WP_KEEPWARM_MINUTES = 10;

function keepWarm() {
  var t0 = Date.now();
  if (!props_().getProperty(WP_PROP_SPREADSHEET)) return { ok: false, skipped: 'setupSystem() ยังไม่ได้รัน' };
  try {
    var ctx = { tables: {}, user: null, warm: true };
    apiStats_({}, ctx);
    dashboardCached_(ctx);
    permitsCached_(ctx, '', '', '', '', '');          // admin/permits.html
    permitsCached_(ctx, '', '', '', '', 'pending');   // admin/permits.html?status=pending
    var poll = pollCached_(ctx, false, null);         // first poll of every admin page
    pollCached_(ctx, true, poll.max_id);              // the 15 s poll of open admin pages
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    console.warn('keepWarm failed: ' + (e && e.message ? e.message : e));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** Run once from the editor. Idempotent: replaces any existing keepWarm trigger with one every 10 minutes. */
function installKeepWarmTrigger() {
  var removed = removeKeepWarmTrigger();
  ScriptApp.newTrigger(WP_KEEPWARM_HANDLER).timeBased().everyMinutes(WP_KEEPWARM_MINUTES).create();
  var result = { removed: removed, installed: 1, everyMinutes: WP_KEEPWARM_MINUTES, warm: keepWarm() };
  Logger.log(JSON.stringify(result));
  return result;
}

/** Removes every keepWarm trigger of this project. Returns how many were removed. */
function removeKeepWarmTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === WP_KEEPWARM_HANDLER) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

/**
 * Forgotten admin password: run this ONCE from the Apps Script editor.
 * Sets the password of user "admin" to the current value of Script Property
 * WP_INITIAL_ADMIN_PASSWORD (min 8 chars), re-enables the account, clears the
 * login lockout and ends admin's existing sessions (they are bound to the salt).
 * The admin is asked to change the password after logging in (must_change).
 */
function resetAdminPassword() {
  var props = PropertiesService.getScriptProperties();
  var pw = props.getProperty(WP_PROP_INITIAL_ADMIN_PASSWORD) || '';
  if (pw.length < 8) {
    throw new Error('กรุณาตั้งค่า Script Property "' + WP_PROP_INITIAL_ADMIN_PASSWORD + '" (อย่างน้อย 8 ตัวอักษร) เป็นรหัสผ่านใหม่ของ admin ก่อนรัน');
  }
  var ssId = props.getProperty('WP_SPREADSHEET_ID');
  if (!ssId) throw new Error('ยังไม่ได้รัน setupSystem()');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ctx = { tables: {}, ss: SpreadsheetApp.openById(ssId) };
    var t = table_(ctx, 'users');
    var u = findUserByName_(t, 'admin');
    if (!u) throw new Error('ไม่พบผู้ใช้ admin');
    var pf = makePasswordFields_(pw);
    u.salt = pf.salt; u.iterations = pf.iterations; u.password_hash = pf.password_hash;
    u.active = '1';
    u.must_change = '1';
    writeRow_(t, u);
    SpreadsheetApp.flush();
    cache_().remove('wplf_admin');
    bumpDataVersion_();
    var msg = 'ตั้งรหัสผ่าน admin ใหม่แล้ว = ค่าใน ' + WP_PROP_INITIAL_ADMIN_PASSWORD + ' — เข้าสู่ระบบแล้วเปลี่ยนรหัสผ่านทันที';
    Logger.log(msg);
    return { ok: true, note: msg };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- approval reminders (Teams)
/**
 * Installs ONE time-driven trigger that runs checkApprovalReminders() every 5
 * minutes (Permits.gs): a stage waiting > 30 min gets a Teams reminder card
 * @mentioning its approver, again every 30 min, at most 6 per stage. Separate
 * from keepWarm (still every 10 min). Run once from the editor; idempotent.
 */
var WP_REMINDER_HANDLER = 'checkApprovalReminders';
var WP_REMINDER_MINUTES = 5;

function installApprovalReminderTrigger() {
  // Per-scope consent: the user may have unticked a scope earlier → force the consent dialog in the editor.
  if (typeof ScriptApp !== 'undefined' && ScriptApp.requireScopes) {
    ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/script.scriptapp']);
  }
  var removed = removeApprovalReminderTrigger();
  ScriptApp.newTrigger(WP_REMINDER_HANDLER).timeBased().everyMinutes(WP_REMINDER_MINUTES).create();
  var result = { removed: removed, installed: 1, everyMinutes: WP_REMINDER_MINUTES, webhook: !!teamsWebhookUrl_() };
  Logger.log(JSON.stringify(result));
  return result;
}

/** Removes every checkApprovalReminders trigger of this project. Returns how many were removed. */
function removeApprovalReminderTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === WP_REMINDER_HANDLER) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

// ---------------------------------------------------------------- Microsoft Teams (optional)
/**
 * Run from the Apps Script editor after setting Script Property TEAMS_WEBHOOK_URL
 * (the first run asks to allow "Connect to an external service"). Sends one
 * sample card to the จป. channel and returns / logs the HTTP status only.
 */
function testTeamsNotification() {
  // Per-scope consent may leave "Connect to an external service" unticked (UrlFetchApp: "You do not have
  // permission") → ask for it again in the editor.
  if (typeof ScriptApp !== 'undefined' && ScriptApp.requireScopes) {
    ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/script.external_request']);
  }
  if (!teamsWebhookUrl_()) {
    var skip = { ok: false, status: null, note: 'ยังไม่ได้ตั้งค่า Script Property "' + WP_PROP_TEAMS_WEBHOOK + '" — ไม่ได้ส่งการแจ้งเตือน' };
    Logger.log(JSON.stringify(skip));
    return skip;
  }
  var card = teamsCard_({
    title: 'ทดสอบการแจ้งเตือน e-Work Permit', color: 'Good',
    facts: [
      ['สถานะ', 'เชื่อมต่อ Microsoft Teams สำเร็จ'],
      ['ระบบ', WP_DATA.config.appName + ' (' + WP_DATA.config.formCode + ')'],
      ['หมายเหตุ', 'ข้อความนี้ส่งจากฟังก์ชัน testTeamsNotification() — ไม่ใช่คำขอจริง']
    ],
    url: teamsSiteBase_() + '/admin/dashboard.html', urlTitle: 'เปิดแดชบอร์ด จป.'
  });
  var status = teamsSend_(card);
  var result = { ok: status >= 200 && status < 300, status: status };
  Logger.log(JSON.stringify(result));
  return result;
}
