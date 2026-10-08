// admin/approvals.html — "รออนุมัติของฉัน": the permits whose current stage (1–2)
// is assigned to the logged-in ผู้รับผิดชอบงาน / เจ้าของพื้นที่, plus recent ones.
(async () => {
  if (WP.halt) return;
  const { $ } = WP, D = WP.data, E = WP.esc, STG = D.stages;
  const root = $('#mine-root');
  const waited = at => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(at || ''));
    if (!m) return '';
    const ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 7 * 3600e3; // Bangkok wall time
    const min = Math.max(0, Math.floor((Date.now() - ts) / 60000));
    return min < 60 ? `${min} นาที` : `${Math.floor(min / 60)} ชม. ${min % 60} นาที`;
  };
  const row = (x, pending) => `
    <a class="task-row" href="view.html?id=${x.id}">
      <div class="t-main"><b class="p-no">${E(x.permit_no)}</b> ${pending ? WP.stageBadge(x) : WP.statusBadge(x.es)}<br>
        <small class="text2">${E(x.requester_name)} · ${E(x.requester_company)}</small><br>
        <small class="muted"><i class="fa-solid fa-location-dot"></i> ${E(x.location)} · ${WP.thaiDate(x.work_date)} ${WP.hm(x.time_from)}–${WP.hm(x.time_to)}</small>
        <div class="mt1">${WP.wtTags(x.work_types)}</div></div>
      <div class="t-wait">${pending ? `<small class="muted">รอมาแล้ว</small><br><b style="color:var(--gold)">${waited(x.stage_started_at)}</b><br><span class="btn sm gold mt1"><i class="fa-solid fa-gavel"></i> พิจารณา</span>`
        : `<span class="btn sm ghost"><i class="fa-solid fa-eye"></i> ดู</span>`}</div>
    </a>`;
  const render = r => {
    if (!r.ok) { root.innerHTML = `<div class="alert err"><i class="fa-solid fa-triangle-exclamation"></i><div>${E(r.msg)}</div></div>`; return; }
    const d = r.data, u = WP.user || {};
    const myRoles = WP.roles().map(k => `<span class="badge role">${E(D.roles[k] || k)}</span>`).join(' ');
    root.innerHTML = `
<div class="card hero-strip glow-border always reveal">
  <div class="hs-ic"><i class="fa-solid fa-inbox ic-beat"></i></div>
  <div><h2>สวัสดี, ${E(u.fullname || '')}</h2><div class="meta"><span>${myRoles}</span><span><i class="fa-solid fa-hourglass-half"></i> รออนุมัติของฉัน <b style="color:var(--gold)">${d.count}</b> รายการ</span></div></div>
</div>
<div class="card mb2 reveal">
  <div class="card-h"><span class="ch-ic" style="color:var(--gold)"><i class="fa-solid fa-bell ic-ring"></i></span><h3>รออนุมัติของฉัน</h3><span class="spacer"></span><small class="muted">ขั้นตอน: ${[STG.assign, STG.area, STG.safety].map(s => E(s.short)).join(' → ')}</small></div>
  <div class="card-b" style="padding-top:0">
    ${d.pending.length ? d.pending.map(x => row(x, true)).join('') : '<div class="empty"><i class="fa-solid fa-mug-hot"></i>ไม่มีคำขอที่รอท่านอนุมัติ</div>'}
  </div>
</div>
<div class="card reveal">
  <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-clock-rotate-left ic-bob"></i></span><h3>ใบอนุญาตที่ท่านเกี่ยวข้องล่าสุด</h3></div>
  <div class="card-b" style="padding-top:0">
    ${d.recent.length ? d.recent.map(x => row(x, false)).join('') : '<div class="empty" style="padding:30px"><i class="fa-solid fa-folder-open"></i>ยังไม่มีรายการ</div>'}
  </div>
</div>`;
    WP.reveal(root);
  };
  await WP.swr('my_tasks', {}, render);
  // a new task arrived (app.js poll) → show it
  document.addEventListener('wp:mine', () => setTimeout(() => { WP.swrClear(); location.reload(); }, 3000));
})();
