/**
 * Auth: user accounts, sessions, roles and user management.
 *
 *  - Roles (column `roles`, comma separated; a user may hold several):
 *      safety      จป. — everything (admin pages, user management, edit/delete/reset, stage 3)
 *      responsible ผู้รับผิดชอบงาน — picks the area owner (stage 0), approves stage 2
 *      area_owner  เจ้าของพื้นที่ — approves stage 1
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
    roles: userRoles_(u), email: String(u.email || '')
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
      u.fullname = fullname;
      u.position = position;
      if (roles) u.roles = roles.join(',');
      if (email !== null) u.email = email;
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
      nu.position = position || (nu.roles.split(',').indexOf('safety') >= 0 ? WP_DATA.config.defaultPosition : '');
      nu.active = '1';
      nu.must_change = '0';
      nu.created_at = nowStr_();
      appendRow_(t, nu);
      out.id = nu.id;
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
