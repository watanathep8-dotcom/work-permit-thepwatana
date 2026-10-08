// track.php — permit no + phone → tracking token → status page.
// The QR / tracking link (track.html?no=..&t=..) forwards straight to the status page.
(() => {
  const no = WP.qs('no'), t = WP.qs('t');
  if (no && t) {
    location.replace(`${WP.base}/status.html?no=${encodeURIComponent(no)}&t=${encodeURIComponent(t)}`);
    return;
  }
  const { $ } = WP, E = WP.esc, D = WP.data;

  // Public short list: no., contractor, work, date, and who a pending permit waits for (no phone / details).
  const waitText = p => {
    const st = D.stages && D.stages[p.stage];
    if (!st) return '';
    const role = (D.roles && D.roles[st.role]) || st.label;
    return `<div class="muted" style="margin-top:4px;font-size:13px"><i class="fa-solid fa-hourglass-half"></i> ค้างอยู่ที่: <b>${E(role)}</b>${p.waiting_name ? ' — ' + E(p.waiting_name) : ''}</div>`;
  };
  const renderList = r => {
    const body = $('#tl-body');
    if (!r.ok) { body.innerHTML = `<tr><td colspan="5"><div class="alert err"><i class="fa-solid fa-triangle-exclamation"></i><div>${E(r.msg)}</div></div></td></tr>`; return; }
    if (!r.data.length) { body.innerHTML = '<tr><td colspan="5"><div class="empty"><i class="fa-regular fa-folder-open"></i>ยังไม่มีใบอนุญาต</div></td></tr>'; return; }
    body.innerHTML = r.data.map(p => `<tr>
      <td class="p-no nowrap">${E(p.permit_no)}</td>
      <td>${E(p.requester_company || '-')}${p.requester_name ? `<div class="muted" style="font-size:13px">${E(p.requester_name)}</div>` : ''}</td>
      <td>${WP.wtTags(p.work_types)}</td>
      <td class="nowrap">${WP.thaiDate(p.work_date)}<div class="muted" style="font-size:13px">${E(WP.hm(p.time_from))}–${E(WP.hm(p.time_to))}</div></td>
      <td>${WP.statusBadge(p.es)}${p.status === 'pending' ? waitText(p) : ''}</td></tr>`).join('');
  };
  const loadList = () => WP.swr('track_list', {}, renderList, { anon: true, fetch: () => WP.get('track_list') });
  loadList();
  setInterval(() => { if (!document.hidden) loadList(); }, 60000);

  if (WP.qs('nf')) $('#nf').classList.remove('hide');
  $('#tf [name=permit_no]').placeholder = 'WP-' + WP.todayBkk().replace(/-/g, '') + '-001';
  $('#tf').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = $('button', f);
    btn.disabled = true;
    const r = await WP.api('track', { permit_no: f.permit_no.value, phone: f.phone.value, with_permit: true });
    btn.disabled = false;
    if (!r.ok) return Swal.fire({ icon: 'error', title: 'ไม่พบข้อมูล', text: r.msg });
    WP.handoff(r.data.permit_no, r.data.token, r.data.view); // status page paints it without another round-trip
    location.href = `${WP.base}/status.html?no=${encodeURIComponent(r.data.permit_no)}&t=${r.data.token}`;
  });
})();
