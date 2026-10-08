// admin/permits.php — tabs, search/filters, table, CSV export
(async () => {
  if (WP.halt) return;
  const { $ } = WP, D = WP.data, E = WP.esc;
  const sp = new URLSearchParams(location.search);
  const f = { status: sp.get('status') || '', q: (sp.get('q') || '').trim(), type: sp.get('type') || '', from: sp.get('from') || '', to: sp.get('to') || '' };
  WP.setPage(f.status === 'pending' ? 'คำขอรออนุมัติ' : 'ใบอนุญาตทั้งหมด', f.status === 'pending' ? 'pending' : 'list');
  const qs = o => '?' + new URLSearchParams(Object.entries(Object.assign({}, f, o)).filter(([, v]) => v !== '')).toString();

  const form = $('#filters');
  form.status.value = f.status; form.q.value = f.q; form.from.value = f.from; form.to.value = f.to;
  form.type.innerHTML = '<option value="">ทุกลักษณะงาน</option>' + Object.entries(D.workTypes).map(([k, w]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${E(w.short)}</option>`).join('');
  $('#reset').href = '?status=' + encodeURIComponent(f.status);

  const tabs = (counts) => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return `<a href="${qs({ status: '' })}" class="${f.status === '' ? 'active' : ''}"><i class="fa-solid fa-layer-group"></i> ทั้งหมด <em>${total}</em></a>` +
      Object.entries(D.status).map(([k, s]) => `<a href="${qs({ status: k })}" class="${f.status === k ? 'active' : ''}"><i class="fa-solid ${s.icon}"></i> ${s.label} <em>${counts[k] || 0}</em></a>`).join('');
  };
  let bound = false;
  // Painted at once from this tab's last copy (if any), then again only if the server's answer differs.
  const render = r => {
  if (!r.ok) {
    $('#tabs').innerHTML = tabs({});
    $('#list').innerHTML = `<div class="card-b"><div class="alert err"><i class="fa-solid fa-triangle-exclamation"></i><div>${E(r.msg)}</div></div></div>`;
    return;
  }
  const rows = r.data.rows;
  $('#tabs').innerHTML = tabs(r.data.counts);
  $('#list').innerHTML = !rows.length ? '<div class="empty"><i class="fa-solid fa-folder-open"></i>ไม่พบข้อมูล</div>' : `
  <div class="tbl-wrap" style="border:0"><table class="tbl" id="tbl"><thead><tr>
    <th>เลขที่</th><th>สถานะ</th><th>ผู้ขออนุญาต</th><th>ลักษณะงาน</th><th>สถานที่</th><th>วันที่ทำงาน</th><th>คน</th><th>ยื่นเมื่อ</th><th></th></tr></thead><tbody>
    ${rows.map((x, i) => `
      <tr class="row-in" style="animation-delay:${Math.min(i, 20) * 35}ms">
        <td class="p-no nowrap">${E(x.permit_no)}</td>
        <td>${WP.statusBadge(x.es)}${x.status === 'pending' && x.stage && x.stage !== 'safety' ? '<br>' + WP.stageBadge(x) : ''}${x.work_done_at && x.status === 'approved' ? '<br><span class="badge st-done mt1" title="ผู้รับเหมาแจ้งเสร็จงานแล้ว — รอตรวจสอบและปิดงาน"><i class="fa-solid fa-camera"></i> แจ้งเสร็จงาน</span>' : ''}</td>
        <td>${E(x.requester_name)}<br><small class="muted">${E(x.requester_company)} · ${E(D.permitTypes[x.permit_type] || '')}</small></td>
        <td>${WP.wtTags(x.work_types)}</td>
        <td>${E(x.location)}</td>
        <td class="nowrap">${WP.thaiDate(x.work_date)}<br><small class="muted">${WP.hm(x.time_from)}–${WP.hm(x.time_to)}</small></td>
        <td>${+x.worker_count || 0}</td>
        <td class="nowrap"><small>${WP.thaiDate(x.created_at, true)}</small></td>
        <td class="nowrap"><a class="btn sm ${x.status === 'pending' ? 'gold' : 'ghost'}" href="view.html?id=${x.id}"><i class="fa-solid ${x.status === 'pending' ? 'fa-gavel' : 'fa-eye'}"></i> ${x.status === 'pending' ? 'พิจารณา' : 'ดู'}</a>
          <a class="btn-icon" href="../print.html?id=${x.id}" target="_blank" title="พิมพ์"><i class="fa-solid fa-print"></i></a>
          <a class="btn sm ghost" href="../request.html?edit=${x.id}" title="แก้ไขข้อมูล">✏️ แก้ไข</a>
          <button type="button" class="btn sm danger" data-del="${x.id}" data-no="${E(x.permit_no)}" data-es="${E(x.es)}" title="ลบใบอนุญาต">🗑 ลบ</button></td>
      </tr>`).join('')}
  </tbody></table></div>`;
  if (bound) return;
  bound = true;

  // ---------- per-row delete (admin session + reset password, asked once per page) ----------
  $('#list').addEventListener('click', async e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    if (!(await WP.deletePermit(+btn.dataset.del, btn.dataset.no))) return;
    // update in place (no reload) so the reset password stays in memory for further deletes
    btn.closest('tr').remove();
    const bump = a => { const em = a && a.querySelector('em'); if (em) em.textContent = Math.max(0, (+em.textContent || 0) - 1); };
    const tabLinks = [...document.querySelectorAll('#tabs a')];
    bump(tabLinks[0]);
    const si = Object.keys(D.status).indexOf(btn.dataset.es);
    if (si >= 0) bump(tabLinks[1 + si]);
    if (!document.querySelector('#tbl tbody tr')) $('#list').innerHTML = '<div class="empty"><i class="fa-solid fa-folder-open"></i>ไม่พบข้อมูล</div>';
  });

  $('#export').onclick = () => {
    const out = [...document.querySelectorAll('#tbl tr')].map(tr => [...tr.children].slice(0, 8).map(td => '"' + td.innerText.replace(/\s+/g, ' ').trim().replace(/"/g, '""') + '"').join(','));
    const blob = new Blob(['﻿' + out.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'work-permits-' + WP.todayBkk() + '.csv'; a.click();
  };
  };
  await WP.swr('permits', f, render);
})();
