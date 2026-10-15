/**
 * Auth: user accounts, sessions, roles and user management.
 *
 *  - Roles (column `roles`, comma separated; a user may hold several):
 *      safety      จป. — everything (admin pages, user management, edit/delete/reset, stage 3)
 *      responsible ผู้รับผิดชอบงาน — approves stage 1 + picks the area owner
 *      area_owner  เจ้าของพื้นที่ — approves stage 2
 *    A row with an EMPTY roles cell is a user created before roles existed: they
 *    were all จป., so they count as `safety` (setupSystem() also writes it in).
 *  - requireUser_: any active, logged-in user. requireAdmin_: role safety only
 *    (FORBIDDEN otherwise) — every admin-wide read / write goes through it.
 *
 *  - Passwords: random salt + iterated SHA-256 (WP_HASH_ROUNDS rounds), hex.
 *  - Login returns a random session token kept in CacheService for 6 h. The
 *    session is bound to the user's current salt, so changing a password or
 *    disabling the account invalidates existing sessions immediately.
 *  - Failed logins are counted per username; 10 failures lock the username for
 *    15 minutes and every failure waits 1 s.
 *  - Edit password (รหัสแก้ไขข้อมูล): each จป. may have a personal second password,
 *    set by a จป. on หน้าผู้ใช้งาน (user_save `edit_password`) and stored hashed like
 *    the login password (users.edit_salt / edit_iterations / edit_hash). Editing a
 *    permit (update_permit) needs the editor's own one — never the shared reset
 *    password, which it may not equal. 10 wrong tries lock that user's edits 15 min.
 */

var WP_HASH_ROUNDS = 5000;
var WP_SESSION_TTL = 21600;   // 6 h (CacheService maximum)
var WP_LOGIN_MAX_FAIL = 10;
var WP_LOGIN_LOCK_SEC = 900;  // 15 min
var WP_TRACK_MAX_FAIL = 10;

function cache_() { return CacheService.getScriptCache(); }

function hashPassword_(password, salt, rounds) {
  var alg = Utilities.DigestAlgorithm.SHA_256;
  var h = Utilities.computeDigest(alg, salt + ':' + password, Utilities.Charset.UTF_8);
  for (var i = 1; i < rounds; i++) h = Utilities.computeDigest(alg, h);
  return bytesToHex_(h);
}

function makePasswordFields_(password) {
  var salt = randomHex_(32);
  return { salt: salt, iterations: String(WP_HASH_ROUNDS), password_hash: hashPassword_(password, salt, WP_HASH_ROUNDS) };
}

/** True when `password` equals the shared reset password (Script Property; compared as fixed-length digests). */
function equalsResetPassword_(password) {
  var reset = String(props_().getProperty('WP_RESET_PASSWORD') || '');
  return !!reset && safeEqual_(sha256Hex_(String(password)), sha256Hex_(reset));
}

function hasEditPassword_(u) {
  return !!(u && String(u.edit_hash || '') && String(u.edit_salt || ''));
}

function verifyEditPassword_(user, password) {
  if (!hasEditPassword_(user)) return false;
  var rounds = Number(user.edit_iterations) || WP_HASH_ROUNDS;
  return safeEqual_(hashPassword_(String(password), user.edit_salt, rounds), user.edit_hash);
}

function setEditPassword_(t, u, password) {
  ['edit_salt', 'edit_iterations', 'edit_hash'].forEach(function (h) { ensureColumn_(t, h); });
  if (password === null) {
    u.edit_salt = ''; u.edit_iterations = ''; u.edit_hash = '';
  } else {
    var pf = makePasswordFields_(password);
    u.edit_salt = pf.salt; u.edit_iterations = pf.iterations; u.edit_hash = pf.password_hash;
  }
  cache_().remove(WP_EDIT_FAIL_PREFIX + Number(u.id)); // a new password starts with a clean lockout counter
}

var WP_EDIT_FAIL_PREFIX = 'wpef_';

/**
 * Audit note for a set / changed / cleared edit password. There is no user audit
 * sheet (permit_logs is per permit), so it goes to the Apps Script execution log
 * (Executions), like the delete log. Never logs the password itself.
 */
function auditEditPassword_(u, by, what) {
  console.log('WP edit password ' + what + ': user ' + u.username + ' (' + u.fullname + ') by ' + by.username + ' (' + by.fullname + ') at ' + nowStr_());
}

/**
 * update_permit second factor: the logged-in จป.'s OWN edit password, sent as
 * `editPassword`. Per-user failure counter: 10 wrong tries lock that user's edits
 * for 15 minutes (login, delete and reset are not affected).
 */
function requireEditPassword_(p, u) {
  if (!hasRole_(u, 'safety')) fail_('เฉพาะเจ้าหน้าที่ความปลอดภัย (จป.) เท่านั้น', 'FORBIDDEN');
  if (!hasEditPassword_(u)) {
    fail_('บัญชีของคุณยังไม่มีรหัสแก้ไขข้อมูล กรุณาติดต่อผู้ดูแลระบบ (จป.) ให้ตั้ง "รหัสแก้ไขข้อมูล" ให้ที่หน้าผู้ใช้งานก่อน', 'NO_EDIT_PASSWORD');
  }
  var given = typeof p.editPassword === 'string' ? p.editPassword : '';
  var cache = cache_(), key = WP_EDIT_FAIL_PREFIX + Number(u.id);
  var fails = Number(cache.get(key)) || 0;
  if (fails >= WP_LOGIN_MAX_FAIL) {
    fail_('กรอกรหัสแก้ไขข้อมูลผิดเกิน ' + WP_LOGIN_MAX_FAIL + ' ครั้ง ระงับการแก้ไขข้อมูลของบัญชีนี้ชั่วคราว 15 นาที', 'LOCKED');
  }
  if (!given || !verifyEditPassword_(u, given)) {
    cache.put(key, String(fails + 1), WP_LOGIN_LOCK_SEC);
    Utilities.sleep(1000);
    fail_('รหัสแก้ไขข้อมูลไม่ถูกต้อง (ใช้รหัสแก้ไขข้อมูลเฉพาะของคุณ ไม่ใช่รหัสรีเซ็ต)', 'AUTH_FAILED');
  }
  cache.remove(key);
}

function verifyPassword_(user, password) {
  var rounds = Number(user.iterations) || WP_HASH_ROUNDS;
  return safeEqual_(hashPassword_(String(password), user.salt, rounds), user.password_hash);
}

var WP_EMAIL_RE = /^[^\s@<>"',;:()[\]\\]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/** Roles of a user row (known roles only, fixed order). Empty cell = legacy จป. = ['safety']. */
function userRoles_(u) {
  var raw = String((u && u.roles) || '').trim();
  if (raw === '') return ['safety'];
  var have = raw.split(/[\s,]+/);
  return Object.keys(WP_DATA.roles).filter(function (k) { return have.indexOf(k) >= 0; });
}

function hasRole_(u, role) { return userRoles_(u).indexOf(role) >= 0; }

/** Roles from the user form: array or comma string → known roles; null when not sent. */
function cleanRoles_(v) {
  if (v === undefined || v === null) return null;
  var arr = Array.isArray(v) ? v : String(v).split(/[\s,]+/);
  arr = arr.map(function (x) { return String(x); });
  return Object.keys(WP_DATA.roles).filter(function (k) { return arr.indexOf(k) >= 0; });
}

function publicUser_(u) {
  return {
    id: Number(u.id), username: u.username, fullname: u.fullname, position: u.position, active: u.active === '1', created_at: u.created_at,
    roles: userRoles_(u), email: String(u.email || ''), phone: String(u.phone || ''),
    has_edit_password: hasEditPassword_(u) // the hash / salt never leave the server
  };
}

function findUserByName_(t, username) {
  var key = String(username).toLowerCase(); // MySQL utf8mb4_unicode_ci compared usernames case-insensitively
  for (var i = 0; i < t.rows.length; i++) if (String(t.rows[i].username).toLowerCase() === key) return t.rows[i];
  return null;
}

function newSession_(u) {
  var token = randomHex_(64);
  cache_().put('wps_' + token, JSON.stringify({ uid: Number(u.id), sv: u.salt }), WP_SESSION_TTL);
  return token;
}

// ---------------------------------------------------------------- actions
function apiLogin_(p, ctx) {
  var username = str_(p.username, 50);
  var password = typeof p.password === 'string' ? p.password : '';
  if (!username || !password) fail_('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน', 'BAD_REQUEST');
  var cache = cache_();
  var failKey = 'wplf_' + username.toLowerCase();
  var fails = Number(cache.get(failKey)) || 0;
  if (fails >= WP_LOGIN_MAX_FAIL) {
    fail_('เข้าสู่ระบบผิดเกิน ' + WP_LOGIN_MAX_FAIL + ' ครั้ง บัญชีนี้ถูกระงับชั่วคราว 15 นาที', 'LOCKED');
  }
  var u = findUserByName_(table_(ctx, 'users'), username);
  if (u && u.active === '1' && verifyPassword_(u, password)) {
    cache.remove(failKey);
    return { session: newSession_(u), expires_in: WP_SESSION_TTL, user: publicUser_(u) };
  }
  cache.put(failKey, String(fails + 1), WP_LOGIN_LOCK_SEC);
  Utilities.sleep(1000);
  fail_('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 'AUTH_FAILED');
}

function apiLogout_(p) {
  var token = String(p.session || '');
  if (/^[a-f0-9]{64}$/.test(token)) cache_().remove('wps_' + token);
  return true;
}

/** require_login(): returns the logged-in (active) user row of any role, or throws AUTH. */
function requireUser_(p, ctx) {
  if (ctx.user) return ctx.user;
  var token = String(p.session || '');
  if (!/^[a-f0-9]{64}$/.test(token)) fail_('กรุณาเข้าสู่ระบบ', 'AUTH');
  var raw = cache_().get('wps_' + token);
  var s = raw ? jdec_(raw, null) : null;
  if (!s) fail_('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 'AUTH');
  var u = findById_(table_(ctx, 'users'), s.uid);
  if (!u || u.active !== '1' || !safeEqual_(u.salt, s.sv)) {
    cache_().remove('wps_' + token);
    fail_('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่', 'AUTH');
  }
  ctx.user = u;
  ctx.sessionToken = token;
  return u;
}

/** จป. only: a logged-in user with role safety, else AUTH / FORBIDDEN. */
function requireAdmin_(p, ctx) {
  var u = requireUser_(p, ctx);
  if (!hasRole_(u, 'safety')) fail_('เฉพาะเจ้าหน้าที่ความปลอดภัย (จป.) เท่านั้น', 'FORBIDDEN');
  return u;
}

function apiMe_(p, ctx) {
  return publicUser_(requireUser_(p, ctx));
}

function apiUsers_(p, ctx) {
  requireAdmin_(p, ctx);
  var t = table_(ctx, 'users');
  var admin = findUserByName_(t, 'admin');
  return {
    me: Number(ctx.user.id),
    users: t.rows.slice().sort(function (a, b) { return Number(a.id) - Number(b.id); }).map(publicUser_),
    // replaces the PHP "admin still uses admin1234" warning
    initial_password_warning: !!(admin && admin.must_change === '1')
  };
}

function apiUserSave_(p, ctx) {
  requireAdmin_(p, ctx);
  var id = Number(p.id) || 0;
  var fullname = str_(p.fullname, 150);
  var position = str_(p.position, 150);
  var pass = typeof p.password === 'string' ? p.password : '';
  if (fullname === '') fail_('กรุณากรอกชื่อ-นามสกุล');
  var roles = cleanRoles_(p.roles); // null = not sent (older page): new user → safety, edit → unchanged
  if (roles && !roles.length) fail_('กรุณาเลือกบทบาทอย่างน้อย 1 บทบาท');
  var email = p.email === undefined || p.email === null ? null : str_(p.email, 200).toLowerCase();
  if (email && !WP_EMAIL_RE.test(email)) fail_('อีเมลไม่ถูกต้อง (ใช้อีเมลบริษัท / Teams เช่น name@company.com)');
  var phone = p.phone === undefined || p.phone === null ? null : str_(p.phone, 30); // null = not sent (older page): unchanged
  if (phone && (!/^[0-9+\-() ,/]+$/.test(phone) || phone.replace(/\D/g, '').length < 9)) fail_('เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 081-234-5678)');
  // รหัสแก้ไขข้อมูล (จป. only): empty / not sent = unchanged
  var editPass = typeof p.edit_password === 'string' ? p.edit_password : '';
  if (editPass !== '') {
    if (editPass.length < 6) fail_('รหัสแก้ไขข้อมูลต้องมีอย่างน้อย 6 ตัวอักษร');
    if (equalsResetPassword_(editPass)) fail_('รหัสแก้ไขข้อมูลต้องไม่ซ้ำกับรหัสผ่านสำหรับรีเซ็ต/ลบข้อมูล (Reset password) กรุณาตั้งรหัสอื่น');
    if (editPass === pass) fail_('รหัสแก้ไขข้อมูลต้องไม่ซ้ำกับรหัสผ่านเข้าสู่ระบบ');
  }
  return withLock_(function () {
    relockCtx_(ctx); // re-read fresh data (unless nothing was written since) + re-check the session
    var me = requireAdmin_(p, ctx);
    var t = table_(ctx, 'users');
    var out = { ok: true };
    if (id) {
      var u = findById_(t, id);
      if (!u) fail_('ไม่พบผู้ใช้', 'NOT_FOUND');
      if (pass !== '' && pass.length < 6) fail_('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      // the จป. editing cannot take the จป. role away from themself (nobody could manage users then)
      if (roles && Number(u.id) === Number(me.id) && roles.indexOf('safety') < 0) fail_('ไม่สามารถถอดบทบาท จป. ของตนเองได้');
      if (editPass !== '') { // checked before anything is changed
        if ((roles || userRoles_(u)).indexOf('safety') < 0) fail_('รหัสแก้ไขข้อมูลตั้งได้เฉพาะผู้ใช้ที่มีบทบาท จป. เท่านั้น');
        if (pass === '' && verifyPassword_(u, editPass)) fail_('รหัสแก้ไขข้อมูลต้องไม่ซ้ำกับรหัสผ่านเข้าสู่ระบบ');
      }
      u.fullname = fullname;
      u.position = position;
      if (roles) u.roles = roles.join(',');
      if (email !== null) u.email = email;
      if (phone !== null) { ensureColumn_(t, 'phone'); u.phone = phone; }
      if (editPass !== '') {
        var hadEdit = hasEditPassword_(u);
        setEditPassword_(t, u, editPass);
        auditEditPassword_(u, me, hadEdit ? 'เปลี่ยน' : 'ตั้ง');
      } else if (!hasRole_(u, 'safety') && hasEditPassword_(u)) {
        setEditPassword_(t, u, null); // no longer จป.: the edit password goes with the role
        auditEditPassword_(u, me, 'ล้าง (ถอดบทบาท จป.)');
      }
      if (pass !== '') {
        var pf = makePasswordFields_(pass);
        u.salt = pf.salt; u.iterations = pf.iterations; u.password_hash = pf.password_hash; u.must_change = '0';
      }
      writeRow_(t, u);
      if (Number(u.id) === Number(me.id)) {
        out.user = publicUser_(u);
        if (pass !== '') { // own password changed: old sessions are now invalid, hand out a new one
          cache_().remove('wps_' + ctx.sessionToken);
          out.session = newSession_(u);
        }
      }
    } else {
      var username = str_(p.username, 50);
      if (!/^[A-Za-z0-9_.]{3,50}$/.test(username)) fail_('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, _ . อย่างน้อย 3 ตัว');
      if (pass.length < 6) fail_('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      if (findUserByName_(t, username)) fail_('ชื่อผู้ใช้นี้มีอยู่แล้ว');
      var nu = makePasswordFields_(pass);
      nu.id = nextId_(t);
      nu.username = username;
      nu.fullname = fullname;
      nu.roles = (roles || ['safety']).join(',');
      nu.email = email || '';
      if (phone) { ensureColumn_(t, 'phone'); nu.phone = phone; }
      if (editPass !== '') {
        if (nu.roles.split(',').indexOf('safety') < 0) fail_('รหัสแก้ไขข้อมูลตั้งได้เฉพาะผู้ใช้ที่มีบทบาท จป. เท่านั้น');
        setEditPassword_(t, nu, editPass);
      }
      nu.position = position || (nu.roles.split(',').indexOf('safety') >= 0 ? WP_DATA.config.defaultPosition : '');
      nu.active = '1';
      nu.must_change = '0';
      nu.created_at = nowStr_();
      appendRow_(t, nu);
      out.id = nu.id;
      if (editPass !== '') auditEditPassword_(nu, me, 'ตั้ง');
    }
    return out;
  });
}

function apiUserToggle_(p, ctx) {
  var me = requireAdmin_(p, ctx);
  var id = Number(p.id) || 0;
  if (id === Number(me.id)) fail_('ไม่สามารถปิดการใช้งานบัญชีของตนเองได้');
  return withLock_(function () {
    relockCtx_(ctx);
    var t = table_(ctx, 'users');
    var u = findById_(t, id);
    if (!u) fail_('ไม่พบผู้ใช้', 'NOT_FOUND');
    u.active = u.active === '1' ? '0' : '1';
    writeRow_(t, u);
    return { id: id, active: u.active === '1' };
  });
}
