// request.php wizard — ported; submits JSON (+ base64 attachment) to Google Apps Script.
// Edit mode (request.html?edit=<id>, จป. admin layout): the same wizard pre-filled from
// the permit, saved with action=update_permit (admin session + reset password).
// Signatures, attachment, status and approvals are not part of the edit.
(async () => {
  if (WP.halt) return;
  const { $, $$ } = WP;
  const CFG = WP.data.config;
  const form = $('#wp-form');
  const editId = WP.editMode ? +WP.qs('edit') || 0 : 0;
  let step = 0, pads = {}, lastTypes = '';
  let initial = null; // edit mode: { checklist, loto, confined } of the permit being edited
  let editNo = '', editBase = ''; // edit mode: permit no + its updated_at as loaded (a newer change by someone else is refused)
  // One id per filled form: a retried submit (lost answer, double tap) returns the permit already created.
  const rid = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const panels = $$('.wz-panel'), stepEls = $$('.step');

  // ---------- Draft autosave (per-browser convenience; not in edit mode) ----------
  const DKEY = 'wpt_draft_v1';
  if (!editId) {
    const saveDraft = () => {
      try {
        const d = {};
        ['requester_name', 'requester_company', 'requester_phone', 'owner_name', 'owner_phone', 'location', 'job_detail'].forEach(n => d[n] = form[n].value);
        localStorage.setItem(DKEY, JSON.stringify(d));
      } catch { }
    };
    try {
      const d = JSON.parse(localStorage.getItem(DKEY) || 'null');
      if (d) Object.entries(d).forEach(([k, v]) => { if (form[k] && !form[k].value) form[k].value = v; });
    } catch { }
    form.addEventListener('input', saveDraft);
  }

  // ---------- Workers ----------
  const wb = $('#workers tbody');
  const renumber = () => {
    $$('tr', wb).forEach((tr, i) => tr.firstElementChild.textContent = i + 1);
    const n = $$('tr', wb).filter(tr => $('input', tr).value.trim()).length;
    $('#worker-count').textContent = n;
    // "จำนวน ___ คน": follows the typed names until edited by hand, never below them
    const wt = form.worker_count;
    wt.min = n;
    if (!wt.dataset.manual || (+wt.value || 0) < n) wt.value = n;
  };
  form.worker_count.addEventListener('input', () => { form.worker_count.dataset.manual = '1'; });
  const addWorker = (focus = true, w = {}) => {
    const tr = document.createElement('tr'); tr.className = 'row-in';
    tr.innerHTML = `<td></td><td><input class="input" data-w="name" placeholder="ชื่อ - นามสกุล"></td><td><input class="input" data-w="role" placeholder="เช่น ช่างเชื่อม / หัวหน้างาน"></td><td><input class="input" data-w="idno" placeholder="(ถ้ามี)"></td>
      <td><button type="button" class="btn-icon" title="ลบ"><i class="fa-solid fa-trash-can"></i></button></td>`;
    $$('input', tr).forEach(i => { i.value = w[i.dataset.w] || ''; });
    $('button', tr).onclick = () => { tr.style.opacity = 0; tr.style.transform = 'translateX(30px)'; tr.style.transition = '.3s'; setTimeout(() => { tr.remove(); renumber(); }, 300); };
    $('input', tr).addEventListener('input', renumber);
    wb.appendChild(tr); renumber();
    if (focus) $('input', tr).focus();
  };
  $('#add-worker').onclick = () => addWorker();

  // ---------- ผู้รับผิดชอบงาน → pre-fills "ชื่อผู้รับผิดชอบงานโครงการ" (still editable) ----------
  let autoOwner = '';
  $('#responsible_id').addEventListener('change', e => {
    const o = e.target.selectedOptions[0];
    const name = o && o.value ? o.textContent : '';
    if (!form.owner_name.value.trim() || form.owner_name.value === autoOwner) { form.owner_name.value = name; autoOwner = name; form.owner_name.classList.remove('invalid'); }
  });
  const workflow = () => !!(WP.respList && WP.respList.length);

  // ---------- Signatures / File (new requests only) ----------
  const fileIn = $('#attach'), drop = $('#drop');
  if (!editId) {
    $('#sig-area').innerHTML = WP.sigHTML('sig-req', 'ลงชื่อ ผู้ขออนุญาต (ผู้รับเหมา) <span class="req">*</span>') + WP.sigHTML('sig-own', 'ลงชื่อ ผู้รับผิดชอบงานโครงการ (ถ้าลงนามได้ทันที)');
    const showFile = () => { const f = fileIn.files[0]; $('#fname').innerHTML = f ? `<i class="fa-solid fa-file-circle-check" style="display:inline;font-size:16px;animation:none"></i> ${WP.esc(f.name)} (${(f.size / 1048576).toFixed(2)} MB)` : ''; };
    fileIn.addEventListener('change', showFile);
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) { fileIn.files = e.dataTransfer.files; showFile(); } });
  }

  // ---------- Checklist item files (เอกสารรับรองที่เกี่ยวข้อง / อื่นๆ; optional, new requests only) ----------
  // itemFiles[itemId] = [File]; only the items shown for the selected work types are sent.
  const itemFiles = {};
  const MB = 1048576, mb = n => (n / MB).toFixed(2) + ' MB';
  const fileExt = n => (String(n).includes('.') ? String(n).split('.').pop() : '').toLowerCase();
  const sentItemFiles = () => $$('[data-att-list]').flatMap(ul => (itemFiles[ul.dataset.attList] || []).map(file => ({ item: ul.dataset.attList, file })));
  const totalBytes = () => sentItemFiles().reduce((s, x) => s + x.file.size, 0) + (fileIn.files[0] ? fileIn.files[0].size : 0);
  const tooBig = () => totalBytes() > CFG.requestMaxMb * MB;
  const bigMsg = () => `ไฟล์แนบทั้งหมดรวมกันต้องไม่เกิน ${CFG.requestMaxMb}MB (ตอนนี้ ${mb(totalBytes())}) — กรุณาลดจำนวนหรือขนาดไฟล์`;
  const renderFiles = id => {
    const ul = $(`[data-att-list="${id}"]`); if (!ul) return;
    ul.innerHTML = (itemFiles[id] || []).map((f, i) => `<li><i class="fa-solid ${fileExt(f.name) === 'pdf' ? 'fa-file-pdf' : 'fa-file-image'}"></i><span class="nm" title="${WP.esc(f.name)}">${WP.esc(f.name)}</span><span class="sz">${mb(f.size)}</span><button type="button" class="rm" data-i="${i}" title="ลบไฟล์" aria-label="ลบไฟล์ ${WP.esc(f.name)}"><i class="fa-solid fa-xmark"></i></button></li>`).join('');
  };
  $('#checklist').addEventListener('click', e => {
    const b = e.target.closest('.cl-att-list .rm'); if (!b) return;
    const id = b.closest('[data-att-list]').dataset.attList;
    (itemFiles[id] || []).splice(+b.dataset.i, 1);
    renderFiles(id);
  });
  $('#checklist').addEventListener('change', e => {
    const inp = e.target.closest('input[type=file][data-att]'); if (!inp) return;
    const id = inp.dataset.att, list = itemFiles[id] = itemFiles[id] || [], bad = [];
    Array.from(inp.files).forEach(f => {
      if (!CFG.itemFileExt.includes(fileExt(f.name))) bad.push(`${f.name}: ชนิดไฟล์ไม่รองรับ (PDF หรือรูปภาพเท่านั้น)`);
      else if (f.size > CFG.uploadMaxMb * MB) bad.push(`${f.name}: ใหญ่เกิน ${CFG.uploadMaxMb}MB`);
      else if (!f.size) bad.push(`${f.name}: ไฟล์ว่าง`);
      else if (list.length >= CFG.itemFileMax) bad.push(`${f.name}: แนบได้ไม่เกิน ${CFG.itemFileMax} ไฟล์ต่อรายการ`);
      else if (list.some(x => x.name === f.name && x.size === f.size)) bad.push(`${f.name}: แนบไฟล์นี้แล้ว`);
      else {
        list.push(f);
        if (tooBig()) { list.pop(); bad.push(`${f.name}: ${bigMsg()}`); }
      }
    });
    inp.value = '';
    renderFiles(id);
    if (bad.length) Swal.fire({ icon: 'warning', title: 'แนบไฟล์ไม่ได้บางไฟล์', html: bad.map(WP.esc).join('<br>') });
  });

  // ---------- Steps ----------
  const types =() => $$('input[name=work_types]:checked').map(c => c.value);
  const buildChecklist = () => {
    const t = types(), key = t.join(',');
    if (key === lastTypes) return;
    const prev = lastTypes ? WP.collectChecklist($('#checklist')) : (initial ? initial.checklist : {});
    lastTypes = key;
    WP.renderChecklist($('#checklist'), WP.defs, t, prev, false, { attach: !editId });
    $$('[data-att-list]').forEach(ul => renderFiles(ul.dataset.attList)); // files picked before a work-type change
    const hasLoto = t.includes('electric');
    $('#loto-card').classList.toggle('hide', !hasLoto);
    if (hasLoto && !$('#loto table')) WP.renderLoto($('#loto'), initial ? initial.loto : []);
    const hasCs = t.includes('confined');
    $('#cs-card').classList.toggle('hide', !hasCs);
    if (hasCs && !$('#cs-box table')) {
      if (initial) {
        // edit: full FM-EMR-46 record (gas / entries / renew / close) so nothing recorded later is lost
        WP.renderConfined($('#cs-box'), initial.confined || {}, false, true);
      } else {
        const names = $$('#workers input[data-w=name]').map(i => i.value.trim()).filter(Boolean);
        WP.renderConfined($('#cs-box'), { entries: names.map(name => ({ name })) }, false, false);
      }
    }
  };

  const validate = s => {
    const p = panels[s];
    let ok = true, first = null;
    $$('[required]', p).forEach(i => {
      const bad = !i.value.trim();
      i.classList.toggle('invalid', bad);
      if (bad) { ok = false; first = first || i; }
    });
    if (s === 0 && !types().length) {
      Swal.fire({ icon: 'warning', title: 'กรุณาเลือกลักษณะงาน', text: 'เลือกอย่างน้อย 1 ลักษณะงาน' });
      return false;
    }
    if (s === 0) {
      const tf = form.time_from.value, tt = form.time_to.value;
      if (tf && tt && tf === tt) { form.time_to.classList.add('invalid'); Swal.fire({ icon: 'warning', title: 'เวลาไม่ถูกต้อง', text: 'เวลาเริ่มและสิ้นสุดต้องไม่เท่ากัน' }); return false; }
    }
    if (s === 1 && form.requester_phone.value && !/^[0-9+\-\s()]{6,20}$/.test(form.requester_phone.value)) {
      form.requester_phone.classList.add('invalid'); first = form.requester_phone; ok = false;
    }
    if (!ok) { first?.focus(); first?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    return ok;
  };

  const setBar = () => {
    const first = stepEls[0].getBoundingClientRect(), cur = stepEls[step].getBoundingClientRect();
    $('#steps-bar').style.width = (cur.left - first.left) + 'px';
  };
  const go = n => {
    step = Math.max(0, Math.min(3, n));
    panels.forEach((p, i) => p.classList.toggle('active', i === step));
    stepEls.forEach((e, i) => { e.classList.toggle('active', i === step); e.classList.toggle('done', i < step); e.querySelector('.s-ic i').className = i < step ? 'fa-solid fa-check' : e.dataset.ic; });
    setBar();
    $('#prev').style.visibility = step ? 'visible' : 'hidden';
    $('#next').classList.toggle('hide', step === 3);
    $('#submit').classList.toggle('hide', step !== 3);
    if (step === 2) buildChecklist();
    if (step === 3 && !editId) {
      // with the approval workflow the ผู้รับผิดชอบงาน signs when approving (stage 1), not on this form
      $('#sig-own').closest('.field').classList.toggle('hide', workflow());
      ['sig-req', 'sig-own'].forEach(id => { if (!pads[id]) pads[id] = new WP.SignaturePad($('#' + id)); });
      $('#submit').innerHTML = workflow() ? '<i class="fa-solid fa-paper-plane"></i> ส่งคำขออนุมัติ' : '<i class="fa-solid fa-paper-plane"></i> ส่งให้ จป. อนุมัติ';
    }
    scrollTo({ top: 0, behavior: 'smooth' });
  };
  stepEls.forEach(e => e.dataset.ic = e.querySelector('.s-ic i').className);
  stepEls.forEach((e, i) => e.addEventListener('click', () => {
    if (i <= step) return go(i);
    for (let s = step; s < i; s++) if (!validate(s)) return go(s);
    go(i);
  }));
  $('#next').onclick = () => { if (validate(step)) go(step + 1); };
  $('#prev').onclick = () => go(step - 1);
  form.addEventListener('input', e => e.target.classList.remove('invalid'));
  addEventListener('resize', setBar);

  // ---------- Form data (shared by submit and edit) ----------
  const collect = () => ({
    company: form.company.value, permit_type: form.permit_type.value, work_types: types(),
    work_date: form.work_date.value, time_from: form.time_from.value, time_to: form.time_to.value,
    requester_title: form.requester_title.value, requester_name: form.requester_name.value.trim(),
    requester_company: form.requester_company.value.trim(), requester_phone: form.requester_phone.value.trim(),
    owner_name: form.owner_name.value.trim(), owner_phone: form.owner_phone.value.trim(),
    location: form.location.value.trim(), job_detail: form.job_detail.value.trim(),
    worker_count: Math.max(+form.worker_count.value || 0, 0),
    workers: $$('tr', wb).map(tr => { const o = {}; $$('input', tr).forEach(i => o[i.dataset.w] = i.value.trim()); return o; }).filter(w => w.name),
    checklist: WP.collectChecklist($('#checklist')),
    loto: types().includes('electric') && $('#loto table') ? WP.collectLoto($('#loto')) : [],
    confined: types().includes('confined') && $('#cs-box table') ? WP.collectConfined($('#cs-box')) : null,
  });

  // ---------- Edit mode: load + pre-fill ----------
  if (editId) {
    const E = WP.esc;
    const view = `${WP.base}/admin/view.html?id=${editId}`;
    const top = document.createElement('div');
    top.className = 'alert info mb2';
    top.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><div>กำลังโหลดข้อมูลใบอนุญาต...</div>';
    $('.wizard-top').before(top);
    $('#submit').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> บันทึกการแก้ไข';
    $('#submit').disabled = true;
    $('.step[data-step="3"] .s-lbl').textContent = 'ตรวจทาน & บันทึก';
    ['#rules-grid', '#agree-card', '#sig-card', '#attach-card'].forEach(s => $(s).classList.add('hide'));
    const r = await WP.read('permit', { id: editId }); // batched with the sidebar's me + poll
    if (!r.ok) {
      if (r.code === 'NOT_FOUND') { location.replace(`${WP.base}/admin/permits.html`); return; }
      top.className = 'alert err mb2';
      top.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><div>${E(r.msg)}</div>`;
      return;
    }
    const p = r.data.permit;
    editNo = p.permit_no;
    editBase = p.updated_at || '';
    WP.setPage('แก้ไขข้อมูลใบอนุญาต ' + p.permit_no, 'list');
    top.className = 'alert warn mb2';
    top.innerHTML = `<i class="fa-solid fa-pen-to-square"></i><div>กำลังแก้ไขข้อมูลใบอนุญาต <b>${E(p.permit_no)}</b> ${WP.statusBadge(p.es)} — แก้ไขข้อมูลที่ผู้ขอกรอกได้ทุกขั้นตอน แล้วกด <b>บันทึกการแก้ไข</b> (ต้องใช้รหัสผ่าน Reset password)
      <br><a href="${view}"><i class="fa-solid fa-arrow-left"></i> กลับไปหน้าพิจารณาโดยไม่บันทึก</a></div>`;
    const sum = $('#edit-summary');
    sum.className = 'alert info mb2';
    sum.innerHTML = `<i class="fa-solid fa-circle-info"></i><div>เลขที่ใบอนุญาต สถานะ ผลการอนุมัติ/การตรวจสอบ ลายมือชื่อ และไฟล์แนบ <b>ไม่ถูกแก้ไข</b> จากหน้านี้ ·
      ระบบบันทึกประวัติ "แก้ไขข้อมูล" พร้อมชื่อผู้แก้ไขและรายการที่เปลี่ยน · วันที่/เวลาที่แก้ไขจะใช้คำนวณการหมดอายุใหม่ทันที</div>`;

    const setRadio = (name, v) => $$(`input[name=${name}]`).forEach(i => { i.checked = i.value === v; });
    if (p.company && !$$('input[name=company]').some(i => i.value === p.company)) {
      // older permit: its company is no longer in the list — offer it so the edit can keep it
      $('#company-seg').insertAdjacentHTML('beforeend', `<label><input type="radio" name="company" value="${WP.esc(p.company)}"><span><i class="fa-solid fa-building-flag"></i>${WP.esc(p.company)}</span></label>`);
    }
    setRadio('company', p.company);
    setRadio('permit_type', p.permit_type);
    setRadio('requester_title', p.requester_title);
    $$('input[name=work_types]').forEach(c => { c.checked = (p.work_types || []).includes(c.value); });
    form.work_date.value = p.work_date || '';
    form.time_from.value = WP.hm(p.time_from);
    form.time_to.value = WP.hm(p.time_to);
    ['requester_name', 'requester_company', 'requester_phone', 'owner_name', 'owner_phone', 'location', 'job_detail'].forEach(k => { form[k].value = p[k] || ''; });
    (p.workers || []).forEach(w => addWorker(false, w));
    if (!(p.workers || []).length) addWorker(false);
    if ((+p.worker_count || 0) > (p.workers || []).length) { form.worker_count.value = +p.worker_count; form.worker_count.dataset.manual = '1'; }
    initial = { checklist: p.checklist || {}, loto: p.loto || [], confined: p.confined || {} };
    buildChecklist(); // render now so the sections are saved even if step 3 is never opened
    $('#submit').disabled = false;
  } else {
    addWorker(false); addWorker(false);
  }

  // ---------- Submit / Save ----------
  $('#submit').onclick = async () => {
    for (let s = 0; s < 3; s++) if (!validate(s)) return go(s);
    const data = collect();
    if (editId) {
      const ok = await Swal.fire({
        icon: 'question', title: `บันทึกการแก้ไข ${editNo}?`,
        html: `<small>${WP.esc(data.location)} · ${data.work_date} ${data.time_from}-${data.time_to}</small>`,
        showCancelButton: true, confirmButtonText: '<i class="fa-solid fa-floppy-disk"></i> บันทึก', cancelButtonText: 'ตรวจสอบอีกครั้ง'
      });
      if (!ok.isConfirmed) return;
      const r = await WP.withResetPassword('update_permit', Object.assign({ id: editId, base: editBase }, data), `ยืนยันการแก้ไข ${editNo}`);
      if (!r) return;
      if (!r.ok) return Swal.fire({ icon: 'error', title: 'บันทึกไม่สำเร็จ', text: r.msg });
      await Swal.fire({ icon: 'success', title: r.data.changed.length ? 'บันทึกการแก้ไขเรียบร้อย' : 'ไม่มีข้อมูลที่เปลี่ยนแปลง', timer: 1300, showConfirmButton: false });
      location.href = `${WP.base}/admin/view.html?id=${editId}`;
      return;
    }
    if (!$('#agree').checked) {
      $('#agree').closest('.card').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(10px)' }, { transform: 'translateX(0)' }], { duration: 350 });
      return Swal.fire({ icon: 'warning', title: 'กรุณายอมรับระเบียบความปลอดภัย' });
    }
    if (pads['sig-req'].empty) return Swal.fire({ icon: 'warning', title: 'กรุณาลงลายมือชื่อผู้ขออนุญาต' });
    const f = fileIn.files[0];
    if (f && f.size > CFG.uploadMaxMb * 1048576) return Swal.fire({ icon: 'error', title: `ไฟล์ใหญ่เกิน ${CFG.uploadMaxMb}MB` });
    if (f && !CFG.uploadExt.includes(f.name.split('.').pop().toLowerCase())) return Swal.fire({ icon: 'error', title: 'ชนิดไฟล์ไม่รองรับ', text: 'PDF/JPG/PNG/XLS/DOC เท่านั้น' });
    if (tooBig()) return Swal.fire({ icon: 'error', title: 'ไฟล์แนบรวมกันใหญ่เกินไป', text: bigMsg() });

    await WP.respReady;
    if (workflow() && !form.responsible_id.value) {
      go(1); form.responsible_id.classList.add('invalid'); form.responsible_id.focus();
      return Swal.fire({ icon: 'warning', title: 'กรุณาเลือกผู้รับผิดชอบงาน' });
    }
    data.requester_sign = pads['sig-req'].toData();
    data.owner_sign = workflow() || pads['sig-own'].empty ? '' : pads['sig-own'].toData();
    if (workflow()) data.responsible_id = +form.responsible_id.value;
    const respName = workflow() ? form.responsible_id.selectedOptions[0].textContent : '';
    const ok = await Swal.fire({
      icon: 'question', title: 'ยืนยันส่งใบขออนุญาต?',
      html: (workflow() ? `ส่งไปยัง <b>ผู้รับผิดชอบงาน: ${WP.esc(respName)}</b> เพื่อเริ่มขั้นตอนอนุมัติ<br>(ผู้รับผิดชอบงาน → เจ้าของพื้นที่ → จป.)`
        : 'ส่งไปยัง <b>เจ้าหน้าที่ความปลอดภัย (จป.)</b> เพื่อพิจารณาอนุมัติ') + `<br><small>${WP.esc(data.location)} · ${data.work_date} ${data.time_from}-${data.time_to}</small>`,
      showCancelButton: true, confirmButtonText: '<i class="fa-solid fa-paper-plane"></i> ยืนยันส่ง', cancelButtonText: 'ตรวจสอบอีกครั้ง'
    });
    if (!ok.isConfirmed) return;
    Swal.fire({ title: 'กำลังส่งข้อมูล...', html: '<i class="fa-solid fa-paper-plane fa-2x ic-float" style="color:var(--lime)"></i>', showConfirmButton: false, allowOutsideClick: false });
    const b64 = file => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).slice(String(fr.result).indexOf(',') + 1)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
    try {
      if (f) data.attachment = { name: f.name, mimeType: f.type || '', base64: await b64(f) };
      const sent = sentItemFiles();
      if (sent.length) data.item_files = await Promise.all(sent.map(async x => ({ item: x.item, name: x.file.name, base64: await b64(x.file) })));
    } catch { return Swal.fire({ icon: 'error', title: 'อ่านไฟล์แนบไม่สำเร็จ' }); }
    const r = await WP.api('submit', Object.assign(data, { with_permit: true, rid }));
    if (!r.ok) return Swal.fire({ icon: 'error', title: 'ส่งไม่สำเร็จ', text: r.msg });
    try { localStorage.removeItem(DKEY); } catch { }
    WP.handoff(r.data.permit_no, r.data.token, r.data.view); // status page paints it without another round-trip
    location.href = `${WP.base}/status.html?no=${encodeURIComponent(r.data.permit_no)}&t=${r.data.token}&new=1`;
  };
})();
