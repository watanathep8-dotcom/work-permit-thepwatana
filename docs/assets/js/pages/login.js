// login.php — returns a session token (kept server-side in CacheService for 6 h).
// จป. → dashboard; ผู้รับผิดชอบงาน / เจ้าของพื้นที่ → "รออนุมัติของฉัน" (or the permit a Teams card linked to).
(() => {
  const { $ } = WP;
  // ?next=admin/<page>.html?... (set by layout.js when a logged-out user opened an admin link, e.g. from Teams)
  const next = () => {
    const n = WP.qs('next');
    if (!/^admin\/(view|approvals|dashboard|permits|users)\.html(\?[\w=&%.-]*)?$/.test(n)) return '';
    if (!WP.isSafety() && !/^admin\/(view|approvals)\.html/.test(n)) return '';
    return WP.base + '/' + n;
  };
  if (WP.session) { location.replace(next() || WP.homeUrl()); return; }
  const showErr = msg => { $('#err-msg').textContent = msg; $('#err').classList.remove('hide'); };
  if (WP.qs('expired')) showErr('Session หมดอายุ กรุณาเข้าสู่ระบบใหม่');
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = $('button', f);
    btn.disabled = true;
    const old = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังตรวจสอบ...';
    const r = await WP.api('login', { username: f.username.value.trim(), password: f.password.value });
    btn.disabled = false; btn.innerHTML = old;
    if (!r.ok) { f.password.value = ''; return showErr(r.msg); }
    WP.saveSession(r.data.session, r.data.user, r.data.expires_in);
    location.href = next() || WP.homeUrl();
  });
})();
