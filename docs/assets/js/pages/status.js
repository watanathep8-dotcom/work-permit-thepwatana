// status.php — requester view, authorised by permit no + tracking token
(async () => {
  const { $ } = WP, E = WP.esc;
  const no = WP.qs('no'), t = WP.qs('t'), isNew = !!WP.qs('new');
  if (!no || !t) { location.replace(WP.base + '/track.html?nf=1'); return; }
  const root = $('#status-root');
  if (!WP.apiUrl) { root.innerHTML = ''; return; }

  // Coming straight from track / submit: that answer already carries this page's data.
  const handed = WP.takeHandoff(no, t);
  const r = handed ? { ok: true, data: handed, msg: '' } : await WP.api('permit', { no, t });
  await WP.ready; // deferred libraries (QR code, confetti, SweetAlert) are loaded
  if (!r.ok) {
    if (r.code === 'NOT_FOUND') { location.replace(WP.base + '/track.html?nf=1'); return; }
    root.innerHTML = `<div class="alert err"><i class="fa-solid fa-triangle-exclamation"></i><div>${E(r.msg)}</div></div>`;
    return;
  }
  const p = r.data.permit, es = p.es;
  const q = `no=${encodeURIComponent(p.permit_no)}&t=${encodeURIComponent(t)}`;
  const link = `${WP.base}/track.html?${q}`;
  const printUrl = `${WP.base}/print.html?${q}`;
  document.title = 'สถานะ ' + p.permit_no + ' · ' + WP.data.config.appName;

  // approval workflow steps on this public page: role + time only (no approver names)
  const R = WP.data.roles || {};
  const publicLogs = logs => (logs || []).map(l => {
    const m = /^\[([^\]]+)\] ([\s\S]*)$/.exec(l.note || '');
    if (l.action === 'assign_area') return Object.assign({}, l, { by_name: R.responsible, note: '' });
    if (l.action === 'area_approve') return Object.assign({}, l, { by_name: R.area_owner });
    if (l.action === 'resp_approve') return Object.assign({}, l, { by_name: R.responsible });
    if (l.action === 'reassign') return Object.assign({}, l, { by_name: 'จป.', note: 'มอบหมายผู้อนุมัติใหม่' });
    if (l.action === 'inspect') { const [what, who] = String(l.note || '').split(' — '); return Object.assign({}, l, { by_name: String(who || '').replace(/^\d+\.\s*/, ''), note: what }); }
    if (l.action === 'reject' && m) return Object.assign({}, l, { by_name: m[1], note: m[2] });
    return l;
  });

  let h = '';
  if (isNew) h += `<div class="card success-wrap glow-border always mb2">
  <svg class="check-anim" viewBox="0 0 120 120"><circle cx="60" cy="60" r="54"/><path d="M36 62 l16 16 l32 -36"/></svg>
  <h2 style="margin:0;font-weight:500">ส่งใบขออนุญาตเรียบร้อยแล้ว!</h2>
  <p class="text2">ระบบได้แจ้งเตือนไปยัง <b>${p.workflow ? 'ผู้รับผิดชอบงาน' : 'เจ้าหน้าที่ความปลอดภัย (จป.)'}</b> แล้ว กรุณาบันทึกเลขที่ใบอนุญาตไว้เพื่อติดตามสถานะ</p>
  <div class="big-no">${E(p.permit_no)}</div>
  <div class="qr-box"><div id="qr"></div></div>
  <p class="hint">สแกน QR หรือบันทึกลิงก์นี้เพื่อติดตามสถานะ</p>
  <div class="flex" style="justify-content:center">
    <button class="btn ghost" id="copy"><i class="fa-solid fa-copy"></i> คัดลอกลิงก์</button>
    <a class="btn ghost" href="${printUrl}" target="_blank"><i class="fa-solid fa-print"></i> พิมพ์ใบคำขอ</a>
    <a class="btn" href="${WP.base}/request.html"><i class="fa-solid fa-plus"></i> ขอใบอนุญาตใหม่</a>
  </div>
</div>`;

  h += `<div class="card hero-strip glow-border always reveal">
  <div class="hs-ic"><i class="fa-solid fa-file-shield ic-float"></i></div>
  <div>
    <h2>${E(p.permit_no)} ${WP.statusBadge(es)} ${WP.workDoneBadge(p)}</h2>
    <div class="meta"><span><i class="fa-solid fa-location-dot"></i> ${E(p.location)}</span><span><i class="fa-regular fa-calendar"></i> ${WP.thaiDate(p.work_date)} ${WP.hm(p.time_from)}–${WP.hm(p.time_to)}</span></div>
  </div>
  <div class="actions"><a class="btn ${['approved', 'closed'].includes(p.status) ? 'gold' : 'ghost'}" href="${printUrl}" target="_blank"><i class="fa-solid fa-print"></i> พิมพ์ใบอนุญาต</a></div>
</div>`;

  h += `<div class="card mb2 reveal"><div class="card-b">${WP.trackStepsHTML(p)}`;
  const stg = WP.data.stages || {};
  // approval workflow: stage names + times only (no approver names / signatures on this public page)
  const rejStage = p.workflow && stg[p.reject_stage] && p.reject_stage !== 'safety' ? stg[p.reject_stage] : null;
  if (p.status === 'rejected') {
    const by = rejStage ? `ขั้นตอน "${E(rejStage.short)}"` : E(p.approver_name);
    h += `<div class="alert err mt2"><i class="fa-solid fa-circle-xmark"></i><div><b>เหตุผลที่ไม่อนุมัติ:</b> ${WP.nl2br(p.approve_comment)}<br><small>โดย ${by} · ${WP.thaiDate(p.approved_at, true)}</small><br><a href="${WP.base}/request.html">ยื่นคำขอใหม่ <i class="fa-solid fa-arrow-right"></i></a></div></div>`;
  } else if (p.status === 'approved' && es !== 'expired') {
    h += `<div class="alert info mt2"><i class="fa-solid fa-circle-check ic-beat"></i><div><b>อนุมัติให้ปฏิบัติงานได้</b> โดย ${E(p.approver_name)} · ${WP.thaiDate(p.approved_at, true)}${p.approve_comment ? '<br>เงื่อนไข/หมายเหตุ: ' + WP.nl2br(p.approve_comment) : ''}</div></div>`;
  } else if (p.status === 'pending') {
    const cur = p.workflow && stg[p.stage];
    const waiting = cur ? `ขั้นที่ ${cur.no}: ${E(cur.label)}${p.stage_started_at ? ` <span class="muted">(ตั้งแต่ ${WP.thaiDate(p.stage_started_at, true)})</span>` : ''}` : 'อยู่ระหว่างรอ จป. พิจารณา';
    h += `<div class="alert warn mt2"><i class="fa-solid fa-hourglass-half ic-spin"></i><div>${waiting} — <b>ห้ามเริ่มปฏิบัติงานจนกว่าจะได้รับอนุมัติ</b> <span class="muted">(หน้านี้จะอัปเดตอัตโนมัติ)</span></div></div>`;
  }
  // "แจ้งเสร็จงาน": approved (also past its work window), not closed, not reported yet
  if (WP.canReportWorkDone(p)) {
    h += `<div class="alert info mt2 wd-report"><i class="fa-solid fa-camera ic-bob"></i><p>ปฏิบัติงานเสร็จแล้ว? แจ้งเสร็จงานพร้อมแนบรูปถ่ายพื้นที่หลังเสร็จงาน เพื่อให้ผู้รับผิดชอบงาน / เจ้าของพื้นที่ / จป. ตรวจสอบและปิดงาน</p>
    <button type="button" class="btn" id="btn-work-done"><i class="fa-solid fa-flag-checkered"></i> แจ้งเสร็จงาน</button></div>`;
  }
  h += `</div></div>`;
  h += WP.workDoneHTML(p);

  h += `<div class="detail-grid">
  <div>${WP.infoCardHTML(p)}</div>
  <div class="card reveal"><div class="card-h"><span class="ch-ic"><i class="fa-solid fa-timeline ic-bob"></i></span><h3>ประวัติการดำเนินการ</h3></div><div class="card-b">${WP.timelineHTML(publicLogs(r.data.logs))}</div></div>
</div>`;
  root.innerHTML = h;
  WP.reveal(root);
  WP.bindAttachment(root, { no: p.permit_no, t });
  WP.bindWorkDonePhotos(root, { no: p.permit_no, t });
  $('#btn-work-done')?.addEventListener('click', WP.busy(() => reportWorkDone(p.permit_no, t)));

  if (isNew) {
    if (window.QRCode) new QRCode(document.getElementById('qr'), { text: link, width: 150, height: 150, colorDark: '#04170e' });
    setTimeout(WP.celebrate, 900);
    $('#copy').onclick = () => navigator.clipboard.writeText(link).then(() => Swal.fire({ icon: 'success', title: 'คัดลอกลิงก์แล้ว', timer: 1400, showConfirmButton: false }));
    history.replaceState(null, '', `status.html?${q}`);
  }
  if (p.status === 'pending') setTimeout(() => location.reload(), 30000);

  // ---------- "แจ้งเสร็จงาน" dialog: photos (required) + note → action work_done ----------
  async function reportWorkDone(no, t) {
    const C = WP.data.config, MB = 1048576;
    const exts = C.workDonePhotoExt || [];
    const ext = f => (f.name.includes('.') ? f.name.split('.').pop() : '').toLowerCase();
    const mb = n => (n / MB).toFixed(n < MB ? 2 : 1) + ' MB';
    const files = [];
    const total = () => files.reduce((a, f) => a + f.size, 0);
    const res = await Swal.fire({
      title: 'แจ้งเสร็จงาน',
      html: `<div class="wd-dlg">
        <p class="text2 mt0">แนบรูปถ่ายพื้นที่ / งานหลังเสร็จ (อย่างน้อย 1 รูป) — <b>แจ้งได้ครั้งเดียว</b></p>
        <label class="wd-drop"><input type="file" id="wd-files" multiple hidden accept="image/*,${exts.map(x => '.' + x).join(',')}">
          <i class="fa-solid fa-camera"></i><b>เลือกรูปถ่าย / ถ่ายรูป</b>
          <small>สูงสุด ${C.workDonePhotoMax} รูป · รูปละไม่เกิน ${C.uploadMaxMb}MB · รวมไม่เกิน ${C.requestMaxMb}MB</small></label>
        <ul class="cl-att-list" id="wd-list"></ul>
        <p class="wd-sum" id="wd-sum"></p><p class="wd-err" id="wd-err"></p>
        <textarea class="swal2-textarea" id="wd-note" maxlength="1000" placeholder="หมายเหตุ (ถ้ามี) เช่น เก็บอุปกรณ์และทำความสะอาดพื้นที่เรียบร้อยแล้ว"></textarea>
      </div>`,
      showCancelButton: true, focusConfirm: false, showLoaderOnConfirm: true,
      confirmButtonText: '<i class="fa-solid fa-paper-plane"></i> ส่งแจ้งเสร็จงาน', cancelButtonText: 'ยกเลิก',
      allowOutsideClick: () => !Swal.isLoading(),
      didOpen: pop => {
        const inp = pop.querySelector('#wd-files'), list = pop.querySelector('#wd-list');
        const sum = pop.querySelector('#wd-sum'), err = pop.querySelector('#wd-err');
        const paint = () => {
          list.innerHTML = files.map((f, i) => `<li><i class="fa-solid fa-file-image"></i><span class="nm" title="${E(f.name)}">${E(f.name)}</span><span class="sz">${mb(f.size)}</span><button type="button" class="rm" data-i="${i}" title="ลบรูป" aria-label="ลบรูป ${E(f.name)}"><i class="fa-solid fa-xmark"></i></button></li>`).join('');
          sum.textContent = files.length ? `${files.length}/${C.workDonePhotoMax} รูป · รวม ${mb(total())}` : '';
        };
        inp.addEventListener('change', () => {
          const bad = [];
          [...inp.files].forEach(f => {
            if (!exts.includes(ext(f))) bad.push(`${f.name}: ชนิดไฟล์ไม่รองรับ (รูปภาพเท่านั้น)`);
            else if (f.size > C.uploadMaxMb * MB) bad.push(`${f.name}: ใหญ่เกิน ${C.uploadMaxMb}MB`);
            else if (files.length >= C.workDonePhotoMax) bad.push(`${f.name}: แนบได้ไม่เกิน ${C.workDonePhotoMax} รูป`);
            else if (total() + f.size > C.requestMaxMb * MB) bad.push(`${f.name}: รวมแล้วเกิน ${C.requestMaxMb}MB`);
            else files.push(f);
          });
          inp.value = '';
          err.textContent = bad.join('\n');
          Swal.resetValidationMessage();
          paint();
        });
        list.addEventListener('click', e => {
          const b = e.target.closest('.rm');
          if (!b) return;
          files.splice(+b.dataset.i, 1);
          err.textContent = '';
          paint();
        });
      },
      preConfirm: async () => {
        if (!files.length) { Swal.showValidationMessage('กรุณาแนบรูปถ่ายอย่างน้อย 1 รูป'); return false; }
        const b64 = f => new Promise((ok, no2) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).slice(String(fr.result).indexOf(',') + 1)); fr.onerror = () => no2(fr.error); fr.readAsDataURL(f); });
        let photos;
        try { photos = await Promise.all(files.map(async f => ({ name: f.name, base64: await b64(f) }))); } catch { Swal.showValidationMessage('อ่านไฟล์รูปไม่สำเร็จ กรุณาเลือกใหม่'); return false; }
        const x = await WP.api('work_done', { no, t, photos, note: document.getElementById('wd-note').value.trim() });
        if (!x.ok) { Swal.showValidationMessage(x.msg || 'ส่งไม่สำเร็จ'); return false; }
        return x.data;
      }
    });
    if (!res.isConfirmed) return;
    WP.celebrate();
    await Swal.fire({ icon: 'success', title: 'แจ้งเสร็จงานเรียบร้อย', html: 'ระบบแจ้งผู้รับผิดชอบงาน / เจ้าของพื้นที่ / จป. แล้ว<br><small>จป. จะตรวจสอบหลังเสร็จงานและปิดงาน</small>', timer: 2600, showConfirmButton: false });
    location.reload();
  }
})();
