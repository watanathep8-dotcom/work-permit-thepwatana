// admin/users.php — user accounts (จป. only): add / edit / roles / e-mail / reset password / จป. edit password / enable-disable
(async () => {
  if (WP.halt) return;
  const { $, $$ } = WP, E = WP.esc, ROLES = WP.data.roles || {};
  const roleBadges = rs => (rs || []).map(k => `<span class="badge role">${E(ROLES[k] || k)}</span>`).join('');
  // จป. only: whether a personal "รหัสแก้ไขข้อมูล" is set (the server only says yes / no, never the hash)
  const editPwMark = x => !(x.roles || []).includes('safety') ? '' : x.has_edit_password
    ? '<br><small class="edit-pw" title="จป. คนนี้แก้ไขข้อมูลใบอนุญาตได้ด้วยรหัสแก้ไขข้อมูลของตนเอง">🔑 ตั้งรหัสแก้ไขแล้ว</small>'
    : '<br><small class="edit-pw muted" title="ยังแก้ไขข้อมูลใบอนุญาตไม่ได้ จนกว่าจะตั้งรหัสแก้ไขข้อมูลให้">— ยังไม่มีรหัสแก้ไข</small>';
  // Painted at once from this tab's last copy (if any), then again only if the server's answer differs.
  // Disabled accounts are hidden (never deleted: permits/logs keep their history); a footer row can show them to re-enable.
  let showOff = false, last = null;
  const render = r => {
  last = r;
  if (!r.ok) { $('#users-body').innerHTML = `<tr><td colspan="8"><div class="alert err"><i class="fa-solid fa-triangle-exclamation"></i><div>${E(r.msg)}</div></div></td></tr>`; return; }
  const { users, me, initial_password_warning } = r.data;
  $('#pw-warn').classList.toggle('hide', !initial_password_warning);
  const off = users.filter(x => !x.active).length;
  const shown = showOff ? users : users.filter(x => x.active);
  $('#users-body').innerHTML = shown.map(x => `
    <tr><td class="p-no">${E(x.username)}</td><td>${E(x.fullname)}</td><td>${E(x.position)}</td>
      <td class="nowrap">${x.phone ? `<a href="tel:${E(x.phone.replace(/[^0-9+]/g, ''))}"><i class="fa-solid fa-phone"></i> ${E(x.phone)}</a>` : '<small class="muted">—</small>'}</td>
      <td>${roleBadges(x.roles)}${editPwMark(x)}</td>
      <td>${x.email ? `<small>${E(x.email)}</small>` : '<small class="muted">— (ไม่มี: แจ้งเตือนแบบไม่ @mention)</small>'}</td>
      <td>${x.active ? '<span class="badge st-approved"><i class="fa-solid fa-circle-check"></i> ใช้งาน</span>' : '<span class="badge st-expired"><i class="fa-solid fa-ban"></i> ปิดใช้งาน</span>'}</td>
      <td class="nowrap"><button class="btn sm ghost edit" data-id="${x.id}"><i class="fa-solid fa-pen"></i> แก้ไข</button>
        ${x.id !== me ? `<button class="btn-icon toggle" data-id="${x.id}" title="${x.active ? 'ปิดการใช้งาน (ซ่อนจากหน้านี้)' : 'เปิดใช้งานอีกครั้ง'}"><i class="fa-solid fa-power-off"></i></button>` : ''}</td></tr>`).join('')
    + (off ? `<tr><td colspan="8" class="muted" style="text-align:center"><button class="btn sm ghost" id="show-off"><i class="fa-solid ${showOff ? 'fa-eye-slash' : 'fa-eye'}"></i> ${showOff ? 'ซ่อนบัญชีที่ปิดใช้งาน' : `แสดงบัญชีที่ปิดใช้งาน (${off})`}</button></td></tr>` : '');
  if (off) $('#show-off').onclick = () => { showOff = !showOff; render(last); };

  const form = (x = {}) => {
    const cur = x.id ? (x.roles || []) : ['safety'];
    return Swal.fire({
    title: x.id ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้',
    html: `<div class="uf"><label for="f-user">ชื่อผู้ใช้ (ใช้ล็อกอิน)</label><input id="f-user" class="swal2-input" placeholder="ชื่อผู้ใช้ (a-z, 0-9)" value="${E(x.username || '')}" ${x.id ? 'disabled' : ''}></div>
      <div class="uf"><label for="f-name">ชื่อ - นามสกุล</label><input id="f-name" class="swal2-input" placeholder="ชื่อ - นามสกุล (ชื่อที่แสดงใน Teams)" value="${E(x.fullname || '')}"></div>
      <div class="uf"><label for="f-pos">ตำแหน่ง</label><input id="f-pos" class="swal2-input" placeholder="ตำแหน่ง" value="${E(x.id ? x.position || '' : WP.data.config.defaultPosition)}"></div>
      <div class="uf"><label for="f-phone">เบอร์โทรศัพท์</label><input id="f-phone" type="tel" inputmode="tel" class="swal2-input" autocomplete="off" placeholder="เบอร์โทรศัพท์ (เช่น 081-234-5678)" value="${E(x.phone || '')}"></div>
      <div class="uf"><label for="f-email">อีเมล (Teams)</label><input id="f-email" type="email" class="swal2-input" autocomplete="off" placeholder="อีเมลบริษัท / Teams (สำหรับ @mention)" value="${E(x.email || '')}"></div>
      <div class="role-chips" id="f-roles">${Object.entries(ROLES).map(([k, l]) => `<label><input type="checkbox" value="${k}" ${cur.includes(k) ? 'checked' : ''}> ${E(l)}</label>`).join('')}</div>
      <div class="uf"><label for="f-pass">${x.id ? 'รหัสผ่านใหม่' : 'รหัสผ่าน'}</label><input id="f-pass" type="password" class="swal2-input" autocomplete="new-password" placeholder="${x.id ? 'รหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'รหัสผ่าน (≥ 6 ตัว)'}"></div>
      <div class="uf" id="f-editpw-box"><label for="f-editpw">รหัสแก้ไขข้อมูล (เฉพาะ จป.)${x.has_edit_password ? ' — ตั้งแล้ว 🔑' : ''}</label><input id="f-editpw" type="password" class="swal2-input" autocomplete="new-password" placeholder="${x.has_edit_password ? 'รหัสแก้ไขข้อมูลใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'รหัสแก้ไขข้อมูล (≥ 6 ตัว, เว้นว่าง = ยังไม่ตั้ง)'}">
        <small class="muted" style="display:block;margin:4px 2px 0;font-size:12px">ใช้ยืนยันตอนแก้ไขข้อมูลใบอนุญาต · ต้องไม่ซ้ำกับรหัสผ่าน Reset password</small></div>`,
    didOpen: () => { // the edit password belongs to the จป. role only
      const sync = () => { $('#f-editpw-box').style.display = $('#f-roles input[value="safety"]').checked ? '' : 'none'; };
      $$('#f-roles input').forEach(i => i.addEventListener('change', sync)); sync();
    },
    showCancelButton: true, confirmButtonText: 'บันทึก', cancelButtonText: 'ยกเลิก',
    preConfirm: async () => {
      const roles = $$('#f-roles input:checked').map(i => i.value);
      if (!roles.length) { Swal.showValidationMessage('กรุณาเลือกบทบาทอย่างน้อย 1 บทบาท'); return false; }
      const editPw = roles.includes('safety') ? $('#f-editpw').value : '';
      if (editPw && editPw.length < 6) { Swal.showValidationMessage('รหัสแก้ไขข้อมูลต้องมีอย่างน้อย 6 ตัวอักษร'); return false; }
      const res = await WP.api('user_save', { id: x.id || 0, username: $('#f-user').value, fullname: $('#f-name').value, position: $('#f-pos').value, email: $('#f-email').value, phone: $('#f-phone').value, roles, password: $('#f-pass').value, edit_password: editPw });
      if (!res.ok) { Swal.showValidationMessage(res.msg); return false; }
      if (res.data.session) WP.saveSession(res.data.session, res.data.user); // own password changed → fresh session
      else if (res.data.user) WP.updateSessionUser(res.data.user);
      return true;
    }
  }).then(res => { if (res.isConfirmed) location.reload(); });
  };
  $('#add').onclick = () => form();
  $$('.edit').forEach(b => b.onclick = () => form(users.find(u => u.id === +b.dataset.id)));
  $$('.toggle').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.id === +b.dataset.id);
    if (u && u.active) {
      const ok = await Swal.fire({ icon: 'warning', title: 'ปิดการใช้งานบัญชีนี้?', html: `<b>${E(u.fullname || u.username)}</b> จะเข้าระบบไม่ได้และถูกซ่อนจากหน้านี้<br><small>ไม่ได้ลบ — ประวัติการอนุมัติและใบอนุญาตเดิมยังอยู่ครบ เปิดกลับได้จาก "แสดงบัญชีที่ปิดใช้งาน"</small>`, showCancelButton: true, confirmButtonText: 'ปิดการใช้งาน', cancelButtonText: 'ยกเลิก' });
      if (!ok.isConfirmed) return;
    }
    const res = await WP.api('user_toggle', { id: +b.dataset.id }); res.ok ? location.reload() : Swal.fire({ icon: 'error', title: res.msg }); });
  };
  await WP.swr('users', {}, render);
})();
