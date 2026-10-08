/* ================================================================
   e-Work Permit — shared header/footer (replaces inc/header.php +
   inc/footer.php). Each page puts its markup in <div id="wp-page">
   and sets <body data-layout="public|admin" data-active=".." data-title="..">.
   Admin-layout pages are for จป. (role safety) only, unless the body has
   data-allow="all" (view / approvals: approvers see their own permits there).
   ================================================================ */
(() => {
  const WP = window.WP;
  const B = WP.base, E = WP.esc;
  const body = document.body;
  // A page may offer an admin "edit mode" (request.html?edit=<id>): data-edit-layout/-active/-title apply then.
  const editMode = (WP.editMode = !!(body.dataset.editLayout && WP.qs('edit')));
  const layout = (WP.layout = (editMode && body.dataset.editLayout) || body.dataset.layout || 'public');
  let active = (editMode && body.dataset.editActive) || body.dataset.active || '';
  const title = (editMode && body.dataset.editTitle) || body.dataset.title || '';
  const appName = (WP.data.config && WP.data.config.appName) || 'e-Work Permit';

  const allowAll = (WP.allowAll = layout === 'admin' && body.dataset.allow === 'all');
  if (layout === 'admin' && !WP.session) {
    WP.halt = true; // page scripts check this and do nothing
    location.replace(B + '/login.html?next=' + encodeURIComponent(location.pathname.replace(/^.*\/admin\//, 'admin/') + location.search));
    return;
  }
  if (layout === 'admin' && !allowAll && !WP.isSafety()) {
    // ผู้รับผิดชอบงาน / เจ้าของพื้นที่: no admin-wide pages — their own list instead
    WP.halt = true;
    location.replace(B + '/admin/approvals.html');
    return;
  }

  document.title = (title ? title + ' · ' : '') + appName;
  body.classList.add('layout-' + layout);
  const page = document.getElementById('wp-page');
  const content = document.createDocumentFragment();
  if (page) { while (page.firstChild) content.appendChild(page.firstChild); page.remove(); }

  const fx = document.createElement('div');
  fx.innerHTML = `<canvas id="fx-bg"></canvas>
<div class="aurora"><span></span><span></span><span></span></div>
<div id="page-loader"><div class="loader-ring"><i class="fa-solid fa-helmet-safety"></i></div></div>`;
  const first = body.firstChild;
  while (fx.firstChild) body.insertBefore(fx.firstChild, first);

  const banner = () => {
    if (WP.apiUrl) return null;
    const d = document.createElement('div');
    d.className = 'alert warn mb2 cfg-banner';
    d.innerHTML = '<i class="fa-solid fa-plug-circle-exclamation ic-flicker"></i><div><b>ยังไม่ได้เชื่อมต่อระบบหลังบ้าน (Google Apps Script)</b><br>' +
      'กรุณาใส่ URL ของ Web App ที่ลงท้ายด้วย <code>/exec</code> ในไฟล์ <code>docs/config.js</code> → <code>window.WP_CONFIG = { apiUrl: "https://script.google.com/macros/s/…/exec" }</code> ' +
      '— ระหว่างนี้หน้าเว็บแสดงผลได้ แต่ยังส่ง/ค้นหา/อนุมัติใบอนุญาตไม่ได้</div>';
    return d;
  };

  let main;
  if (layout === 'admin') {
    const u = WP.user || {};
    const safety = WP.isSafety(), approver = WP.hasRole('responsible') || WP.hasRole('area_owner');
    const nav = (key, href, icon, label, extra = '') =>
      `<a href="${B}/${href}" class="${active === key ? 'active' : ''}" data-nav="${key}"><i class="fa-solid ${icon}"></i><span>${label}</span>${extra}</a>`;
    const mine = nav('mine', 'admin/approvals.html', 'fa-inbox', 'รออนุมัติของฉัน', '<em class="nav-count zero" id="nav-mine">0</em>');
    const aside = document.createElement('aside');
    aside.className = 'sidebar'; aside.id = 'sidebar';
    aside.innerHTML = `
  <a class="brand" href="${WP.homeUrl()}">
    <span class="brand-icon"><i class="fa-solid fa-shield-halved"></i></span>
    <span class="brand-text"><b>e-Work Permit</b><small>${safety ? 'ระบบอนุมัติ จป.' : 'ระบบอนุมัติใบอนุญาต'} · เทพวัฒนา</small><small class="programming-credit">Programming by Duongruthai_Milk</small></span>
  </a>
  <nav class="side-nav">
    ${safety ? `
    ${nav('dash', 'admin/dashboard.html', 'fa-gauge-high', 'แดชบอร์ด')}
    ${nav('pending', 'admin/permits.html?status=pending', 'fa-bell', 'รออนุมัติ', '<em class="nav-count" id="nav-pending">0</em>')}
    ${approver ? mine : ''}
    ${nav('list', 'admin/permits.html', 'fa-folder-open', 'ใบอนุญาตทั้งหมด')}
    ${nav('users', 'admin/users.html', 'fa-user-shield', 'ผู้ใช้งาน')}` : mine}
    <a href="${B}/request.html" target="_blank"><i class="fa-solid fa-file-circle-plus"></i><span>หน้าขอใบอนุญาต</span></a>
  </nav>
  <div class="side-user">
    <div class="avatar"><i class="fa-solid fa-user-tie"></i></div>
    <div><b id="me-name">${E(u.fullname || '')}</b><small id="me-pos">${E(u.position || '')}</small></div>
    <a href="${B}/logout.html" class="btn-icon" title="ออกจากระบบ" data-logout><i class="fa-solid fa-right-from-bracket"></i></a>
  </div>`;
    const wrap = document.createElement('div');
    wrap.className = 'admin-main';
    wrap.innerHTML = `
  <header class="topbar">
    <button class="btn-icon" id="sidebar-toggle"><i class="fa-solid fa-bars"></i></button>
    <h1 class="topbar-title">${E(title)}</h1>
    <div class="topbar-right">
      <span class="clock" id="live-clock"></span>
      <a href="${B}/admin/${WP.isSafety() ? 'permits.html?status=pending' : 'approvals.html'}" class="bell" id="bell"><i class="fa-solid fa-bell"></i><em id="bell-count">0</em></a>
    </div>
  </header>
  <main class="admin-content"></main>`;
    main = wrap.querySelector('main');
    body.insertBefore(aside, first);
    body.insertBefore(wrap, first);
  } else {
    const header = document.createElement('header');
    header.className = 'pub-nav';
    const pn = (key, href, icon, label) => `<a href="${B}/${href}" class="${active === key ? 'active' : ''}"><i class="fa-solid ${icon}"></i><span>${label}</span></a>`;
    header.innerHTML = `
  <a class="brand" href="${B}/index.html">
    <span class="brand-icon"><i class="fa-solid fa-shield-halved"></i></span>
    <span class="brand-text"><b>e-Work Permit</b><small>ใบขออนุญาตปฏิบัติงาน · บริษัท เทพวัฒนา จำกัด</small><small class="programming-credit">Programming by Duongruthai_Milk</small></span>
  </a>
  <nav>
    ${pn('home', 'index.html', 'fa-house', 'หน้าแรก')}
    ${pn('request', 'request.html', 'fa-file-signature', 'ขอใบอนุญาต')}
    ${pn('track', 'track.html', 'fa-magnifying-glass-location', 'ติดตามสถานะ')}
    <a href="${WP.session ? WP.homeUrl() : B + '/login.html'}" class="nav-cta"><i class="fa-solid fa-user-shield"></i><span>${WP.session && !WP.isSafety() ? 'รออนุมัติของฉัน' : 'สำหรับ จป. / ผู้อนุมัติ'}</span></a>
  </nav>`;
    main = document.createElement('main');
    main.className = 'pub-content';
    const footer = document.createElement('footer');
    footer.className = 'pub-footer';
    footer.innerHTML = `<i class="fa-solid fa-helmet-safety"></i> Safety First — ความปลอดภัยต้องมาก่อน · ${E(WP.data.config.formCode)} · ฝ่ายสิ่งแวดล้อมและความปลอดภัย`;
    body.insertBefore(header, first);
    body.insertBefore(main, first);
    body.insertBefore(footer, first);
  }
  const b = banner();
  if (b) main.appendChild(b);
  main.appendChild(content);
  WP.main = main;

  // Pages whose title/active menu depend on loaded data (view, permits?status=pending).
  WP.setPage = (newTitle, newActive) => {
    if (newTitle) {
      document.title = newTitle + ' · ' + appName;
      const t = document.querySelector('.topbar-title'); if (t) t.textContent = newTitle;
    }
    if (newActive !== undefined) {
      active = newActive;
      document.querySelectorAll('.side-nav a[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === active));
    }
  };

  // Refresh the sidebar name/position from the server (also validates the session).
  // WP.read: goes out together with the page's own data in one batched round-trip.
  if (layout === 'admin') {
    WP.read('me').then(r => {
      if (!r.ok) return;
      WP.updateSessionUser(r.data);
      if (!allowAll && !WP.isSafety(r.data)) { location.replace(B + '/admin/approvals.html'); return; }
      const n = document.getElementById('me-name'), p = document.getElementById('me-pos');
      if (n) n.textContent = r.data.fullname; if (p) p.textContent = r.data.position;
    });
  }
})();
