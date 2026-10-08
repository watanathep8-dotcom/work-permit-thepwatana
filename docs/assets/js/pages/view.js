// admin/view.php — review checklist, inspections, approve / reject / close / delete
// + approval workflow: the assignee of stage 0–2 (ผู้รับผิดชอบงาน / เจ้าของพื้นที่) acts here;
//   a จป. sees everything (as before) and may reassign the approvers of stages 0–2.
(async () => {
  if (WP.halt) return;
  const { $, $$ } = WP, D = WP.data, E = WP.esc, STG = D.stages;
  const root = $('#view-root');
  const id = +WP.qs('id');
  const safety = WP.isSafety();
  const home = safety ? 'permits.html' : 'approvals.html';
  if (!id) { location.replace(home); return; }
  // batched with the sidebar's me + poll / my_tasks
  const [r, ap] = await Promise.all([WP.read('permit', { id, signs: true }), WP.read('approvers')]);
  if (!r.ok) {
    if (r.code === 'NOT_FOUND') { location.replace(home); return; }
    root.innerHTML = `<div class="alert err"><i class="fa-solid fa-triangle-exclamation"></i><div>${E(r.msg)}</div></div>`;
    return;
  }
  const p = r.data.permit, sg = r.data.signs || {}, es = p.es, types = p.work_types;
  const stage = p.status === 'pending' ? p.stage : '';
  // จป. review (checklist / inspections) as before; approvers read only
  const editable = safety && ['pending', 'approved'].includes(p.status);
  const ins = p.inspections || {};
  const me = (WP.user && WP.user.fullname) || '';
  const myId = +((WP.user && WP.user.id) || 0);
  // the assignee of the current stage 0–2 (the server checks the same again)
  const myStage = stage && stage !== 'safety' && WP.hasRole(STG[stage].role) &&
    (stage === 'area' ? p.area_owner_id === myId : p.responsible_id === myId) ? stage : '';
  WP.setPage((myStage ? 'อนุมัติใบอนุญาต ' : 'พิจารณาใบอนุญาต ') + p.permit_no, !safety ? 'mine' : (myStage ? 'mine' : p.status === 'pending' ? 'pending' : 'list'));
  const P = { id: p.id, types, checklist: p.checklist || {}, loto: p.loto || [], confined: p.confined || {}, editable, me, base: p.updated_at };
  const people = ap.ok ? ap.data : { responsible: [], area_owner: [] };
  const opts = (list, cur) => '<option value="">— เลือก —</option>' + list.map(x => `<option value="${+x.id}" ${+x.id === +cur ? 'selected' : ''}>${E(x.name)}</option>`).join('');

  // stage approvers (เจ้าของพื้นที่ / ผู้รับผิดชอบงาน) tick the checklist when they approve (paper form:
  // "สำหรับผู้รับผิดชอบงาน/ผู้รับผิดชอบพื้นที่/ผู้ตรวจสอบงาน"); the จป. reviews it last
  const clEditable = editable || myStage === 'area' || myStage === 'resp';
  // approvals table rows 1–2 of an approved permit: the assigned area owner / responsible sign their own inspection cells
  const selfRows = p.status === 'approved' ? [['owner', 'area_owner', p.area_owner_id], ['contractor', 'responsible', p.responsible_id]]
    .filter(([, role, uid]) => uid && +uid === myId && WP.hasRole(role)).map(([rk]) => rk) : [];
  // "การอนุญาตทำงาน (ผู้อนุมัติ)": workflow stage approvals (rows 1–2) and the จป. approval (row 3)
  const done = ['approved', 'closed'].includes(p.status);
  const permitCell = rk => {
    if (rk === 'owner' && p.workflow) return { name: p.area_approved_at ? p.area_owner_name : '', at: p.area_approved_at, img: sg.area, wait: stage === 'area' };
    if (rk === 'contractor' && p.workflow) return { name: p.resp_approved_at ? p.responsible_name : '', at: p.resp_approved_at, img: sg.resp, wait: stage === 'resp' };
    if (rk === 'safety') { const c = (ins.safety || {}).permit; return { name: c ? c.name : (done ? p.approver_name : ''), at: c ? c.at : (done ? p.approved_at : ''), img: done ? sg.approver : '', wait: stage === 'safety' }; }
    return null; // legacy permit without workflow: typed by the จป. as before
  };
  const inspRows = Object.entries(D.inspectRoles).map(([rk, rl]) => `
            <tr><td class="role">${E(rl)}</td>
              ${Object.keys(D.inspectStages).map(sk => {
                const pc = sk === 'permit' ? permitCell(rk) : null;
                if (pc) {
                  return `<td><div class="insp-cell ${pc.name ? 'filled' : ''}">
                  ${pc.img ? `<img class="sig-img sm" src="${pc.img}">` : (pc.name ? '<i class="fa-solid fa-stamp stamp"></i>' : '')}
                  <div class="insp-name">${pc.name ? E(pc.name) : `<span class="muted">${pc.wait ? 'รออนุมัติ' : '—'}</span>`}</div>
                  <small>${pc.at ? WP.thaiDate(pc.at, true) : '&nbsp;'}</small></div></td>`;
                }
                const c = (ins[rk] || {})[sk];
                const enabled = editable;
                const mine = !c && sk !== 'permit' && selfRows.includes(rk);
                return `<td><div class="insp-cell ${c ? 'filled' : ''}">
                  ${c ? '<i class="fa-solid fa-stamp stamp"></i>' : ''}
                  <input data-r="${rk}" data-s="${sk}" value="${E(c ? c.name : '')}" placeholder="${enabled ? 'ลงชื่อ...' : ''}" ${enabled ? '' : 'disabled'}>
                  <small>${c ? WP.thaiDate(c.at, true) : '&nbsp;'}</small>
                  ${editable && rk === 'safety' && sk !== 'permit' && !c ? `<button type="button" class="btn sm ghost mt1 sign-me" data-r="${rk}" data-s="${sk}"><i class="fa-solid fa-signature"></i> ลงชื่อฉัน</button>` : ''}
                  ${mine && !editable ? `<button type="button" class="btn sm mt1 self-sign" data-r="${rk}" data-s="${sk}"><i class="fa-solid fa-signature"></i> ลงชื่อตรวจสอบ</button>` : ''}
                </div></td>`;
              }).join('')}
              <td><div class="insp-cell"><input data-r="${rk}" data-note="1" value="${E((ins[rk] || {}).note || '')}" placeholder="..." ${editable ? '' : 'disabled'}>${(() => { const c = rk === 'owner' ? p.area_comment : rk === 'contractor' ? p.resp_comment : (done ? p.approve_comment : ''); return c ? `<small>“${E(c)}”</small>` : ''; })()}</div></td>
            </tr>`).join('');

  // ---------- approval workflow cards ----------
  let flow = '';
  if (myStage === 'assign') {
    flow = `<div class="card mb2 glow-border always reveal" id="wf-card">
      <div class="card-h"><span class="ch-ic" style="color:var(--gold)"><i class="fa-solid ${STG.assign.icon} ic-wiggle"></i></span><h3>ขั้นที่ 0: ${E(STG.assign.label)}</h3></div>
      <div class="card-b">
        <p class="text2 mt0">ท่านเป็น <b>ผู้รับผิดชอบงาน</b> ของคำขอนี้ — กรุณาระบุเจ้าของพื้นที่เพื่อส่งให้อนุมัติขั้นที่ 1</p>
        <div class="field mb2"><label><i class="fa-solid fa-map-location-dot"></i> เจ้าของพื้นที่ <span class="req">*</span></label>
          <select class="input" id="wf-area">${opts(people.area_owner, 0)}</select></div>
        <div class="grid g2 mt2">
          <button class="btn danger" id="wf-reject"><i class="fa-solid fa-circle-xmark"></i> ไม่อนุมัติ</button>
          <button class="btn" id="wf-assign"><i class="fa-solid fa-share-from-square"></i> ส่งให้เจ้าของพื้นที่</button>
        </div>
      </div>
    </div>`;
  } else if (myStage) {
    const S = STG[myStage];
    flow = `<div class="card mb2 glow-border always reveal" id="wf-card">
      <div class="card-h"><span class="ch-ic" style="color:var(--gold)"><i class="fa-solid ${S.icon} ic-wiggle"></i></span><h3>ขั้นที่ ${S.no}: ${E(S.label)}</h3></div>
      <div class="card-b">
        <p class="text2 mt0">ท่านเป็น <b>${E(D.roles[S.role])}</b> ของคำขอนี้ — ตรวจสอบรายละเอียดแล้วลงนามอนุมัติ หรือไม่อนุมัติพร้อมเหตุผล</p>
        <div class="field mb2"><label><i class="fa-solid fa-comment-dots"></i> ความเห็น (ถ้ามี)</label><textarea class="input" id="wf-comment" placeholder="ความเห็น / เงื่อนไขเพิ่มเติม"></textarea></div>
        <div id="wf-sig-box"></div>
        <div class="grid g2 mt2">
          <button class="btn danger" id="wf-reject"><i class="fa-solid fa-circle-xmark"></i> ไม่อนุมัติ</button>
          <button class="btn" id="wf-approve"><i class="fa-solid fa-circle-check"></i> อนุมัติ</button>
        </div>
      </div>
    </div>`;
  }
  if (safety && stage && stage !== 'safety') {
    flow += `<div class="card mb2 reveal">
      <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-hourglass-half ic-spin"></i></span><h3>รอขั้นตอนก่อนหน้า</h3></div>
      <div class="card-b">
        <p class="text2 mt0">${WP.stageBadge(p)}<br><small>ตั้งแต่ ${WP.thaiDate(p.stage_started_at, true)}</small></p>
        <p class="text2">จป. พิจารณาได้หลังผู้รับผิดชอบงานอนุมัติ (ขั้นที่ 2) แล้ว — หากผู้อนุมัติไม่อยู่ มอบหมายผู้อื่นแทนได้:</p>
        <div class="field mb1"><label><i class="fa-solid fa-user-tie"></i> ผู้รับผิดชอบงาน</label><select class="input" id="ra-resp">${opts(people.responsible, p.responsible_id)}</select></div>
        ${stage === 'area' ? `<div class="field mb1"><label><i class="fa-solid fa-map-location-dot"></i> เจ้าของพื้นที่</label><select class="input" id="ra-area">${opts(people.area_owner, p.area_owner_id)}</select></div>` : ''}
        <button class="btn ghost w100 mt1" id="ra-save"><i class="fa-solid fa-people-arrows"></i> มอบหมายใหม่</button>
      </div>
    </div>`;
  }
  const wfSigns = !p.workflow ? '' : `<div class="card mb2 reveal">
      <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-route ic-bob"></i></span><h3>การอนุมัติตามลำดับ</h3></div>
      <div class="card-b wf-signs">
        ${[['area', 'เจ้าของพื้นที่', p.area_owner_name, p.area_approved_at, sg.area, p.area_comment],
           ['resp', 'ผู้รับผิดชอบงาน', p.responsible_name, p.resp_approved_at, sg.resp, p.resp_comment],
           ['safety', 'จป.', p.status === 'approved' || p.status === 'closed' ? p.approver_name : '', p.status === 'approved' || p.status === 'closed' ? p.approved_at : '', sg.approver, '']]
          .map(([k, lbl, name, at, img, c]) => `<div>${img ? `<img class="sig-img" src="${img}">` : `<div class="muted" style="padding:20px 0">${stage === k ? '— รออนุมัติ —' : '—'}</div>`}
            <small class="text2"><b>${E(lbl)}</b><br>${E(name || '-')}${at ? '<br>' + WP.thaiDate(at, true) : ''}${c ? '<br>“' + E(c) + '”' : ''}</small></div>`).join('')}
      </div>
    </div>`;

  let side = '';
  if (!safety) {
    side = '';
  } else if (p.status === 'pending' && stage !== 'safety') {
    side = '';
  } else if (p.status === 'pending') {
    side = `<div class="card mb2 glow-border always reveal">
      <div class="card-h"><span class="ch-ic" style="color:var(--gold)"><i class="fa-solid fa-gavel ic-wiggle"></i></span><h3>การพิจารณาของ จป.</h3></div>
      <div class="card-b">
        <div class="alert warn mb2"><i class="fa-solid fa-triangle-exclamation ic-flicker"></i><div>ข้าพเจ้าได้ตรวจสอบลักษณะงานและอุปกรณ์ป้องกันในบริเวณพื้นที่โครงการ ซึ่งเห็นว่าปลอดภัยตามความเหมาะสมที่จะให้ปฏิบัติงาน และเป็นไปตามเงื่อนไขตามรายการข้างต้นแล้ว</div></div>
        <div class="field mb2"><label><i class="fa-solid fa-comment-dots"></i> ความเห็น / เงื่อนไขเพิ่มเติม</label><textarea class="input" id="comment" placeholder="เช่น ต้องมีผู้เฝ้าระวังไฟ (Fire Watch) ตลอดเวลา"></textarea></div>
        <div id="sig-appr-box"></div>
        <div class="grid g2 mt2">
          <button class="btn danger" id="btn-reject"><i class="fa-solid fa-circle-xmark"></i> ไม่อนุมัติ</button>
          <button class="btn" id="btn-approve"><i class="fa-solid fa-circle-check"></i> อนุมัติ</button>
        </div>
      </div>
    </div>`;
  } else if (p.status === 'approved') {
    side = `<div class="card mb2 glow-border always reveal">
      <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-circle-check ic-beat"></i></span><h3>อนุมัติแล้ว</h3></div>
      <div class="card-b">
        <p class="text2 mt0">โดย <b>${E(p.approver_name)}</b><br><small>${WP.thaiDate(p.approved_at, true)}</small></p>
        ${sg.approver ? `<img class="sig-img" src="${sg.approver}">` : ''}
        ${p.approve_comment ? `<p class="text2">เงื่อนไข: ${WP.nl2br(p.approve_comment)}</p>` : ''}
        <div class="alert info mt2"><i class="fa-solid fa-broom"></i><div>เมื่อเสร็จงาน: ตรวจสอบการจัดเก็บอุปกรณ์เครื่องมือ ทำความสะอาดพื้นที่ และไม่มีสิ่งที่ก่อให้เกิดอันตราย แล้วกดปิดงาน</div></div>
        <button class="btn blue w100 mt2" id="btn-close"><i class="fa-solid fa-flag-checkered"></i> ตรวจสอบหลังเสร็จงาน & ปิดงาน</button>
      </div>
    </div>`;
  } else {
    side = `<div class="card mb2 reveal"><div class="card-b">
      ${WP.statusBadge(es)}
      <p class="text2">โดย <b>${E(p.approver_name)}</b> · ${WP.thaiDate(p.approved_at, true)}</p>
      ${sg.approver ? `<img class="sig-img" src="${sg.approver}">` : ''}
      ${p.approve_comment ? `<p class="text2">${WP.nl2br(p.approve_comment)}</p>` : ''}
      ${p.closed_at ? `<p class="text2"><i class="fa-solid fa-flag-checkered"></i> ปิดงานเมื่อ ${WP.thaiDate(p.closed_at, true)}</p>` : ''}
    </div></div>`;
  }

  root.innerHTML = `
<div class="card hero-strip glow-border always reveal">
  <div class="hs-ic"><i class="fa-solid ${p.status === 'pending' ? 'fa-gavel ic-wiggle' : 'fa-file-shield ic-float'}"></i></div>
  <div>
    <h2>${E(p.permit_no)} ${WP.statusBadge(es)} ${WP.stageBadge(p)}</h2>
    <div class="meta"><span><i class="fa-solid fa-user"></i> ${E(p.requester_name)} (${E(p.requester_company)})</span><span><i class="fa-solid fa-location-dot"></i> ${E(p.location)}</span><span><i class="fa-regular fa-paper-plane"></i> ยื่นเมื่อ ${WP.thaiDate(p.created_at, true)}</span></div>
  </div>
  <div class="actions">
    ${myStage ? `<a class="btn gold" href="#wf-card"><i class="fa-solid fa-gavel"></i> ${myStage === 'assign' ? 'ระบุเจ้าของพื้นที่' : 'อนุมัติ / ไม่อนุมัติ'}</a>` : ''}
    <a class="btn ghost" href="../print.html?id=${p.id}" target="_blank"><i class="fa-solid fa-print"></i> พิมพ์</a>
    ${safety ? `<a class="btn ghost" id="btn-edit" href="../request.html?edit=${p.id}" title="แก้ไขข้อมูลที่ผู้ขอกรอก (ต้องใช้รหัสผ่าน Reset password)">✏️ แก้ไข</a>
    <button class="btn danger" id="btn-del" title="ลบใบอนุญาต (ต้องใช้รหัสผ่าน Reset password)">🗑 ลบ</button>` : `<a class="btn ghost" href="approvals.html"><i class="fa-solid fa-inbox"></i> รออนุมัติของฉัน</a>`}
  </div>
</div>

<div class="card mb2 reveal"><div class="card-b">${WP.trackStepsHTML(p)}</div></div>

<div class="detail-grid">
  <div>
    ${WP.infoCardHTML(p, { staff: true })}

    <div class="card mb2 reveal">
      <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-list-check ic-beat"></i></span><h3>รายการตรวจสอบความปลอดภัย</h3><span class="spacer"></span>
        ${editable ? '<small class="muted"><i class="fa-solid fa-pen"></i> จป. ปรับแก้ได้ตามหน้างาน</small>' : clEditable ? '<small class="muted"><i class="fa-solid fa-pen"></i> ทำเครื่องหมายตามหน้างาน — บันทึกพร้อมการอนุมัติ</small>' : ''}</div>
      <div class="card-b"><div class="hint mb2"><i class="fa-solid fa-user-shield"></i> ${E(D.reviewNote)}</div><div id="checklist"></div></div>
    </div>

    ${types.includes('electric') ? `<div class="card mb2 reveal">
      <div class="card-h"><span class="ch-ic" style="color:#facc15"><i class="fa-solid fa-lock ic-wiggle"></i></span><h3>ตาราง Lock Out / Tag Out</h3></div>
      <div class="card-b" id="loto"></div>
    </div>` : ''}

    ${types.includes('confined') ? `<div class="card mb2 reveal">
      <div class="card-h"><span class="ch-ic" style="color:#22d3ee"><i class="fa-solid fa-dungeon ic-float"></i></span><h3>บันทึกงานในที่อับอากาศ (FM-EMR-46 ข้อ 8–11)</h3></div>
      <div class="card-b" id="cs-box"></div>
    </div>` : ''}

    <div class="card mb2 reveal">
      <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-clipboard-user ic-bob"></i></span><h3>การอนุญาต & การตรวจสอบ (ก่อน / ระหว่าง / หลัง)</h3></div>
      <div class="card-b" style="overflow-x:auto">
        <p class="text2 mt0 small-stmt">${D.approvalStatement.map(E).join(' ')}</p>
        <table class="insp" id="insp">
          <thead><tr><th></th>${Object.values(D.inspectStages).map(sl => `<th>${E(sl)}</th>`).join('')}<th>หมายเหตุ</th></tr></thead>
          <tbody>${inspRows}</tbody>
        </table>
        ${editable ? '<div class="flex mt2"><button class="btn" id="btn-save"><i class="fa-solid fa-floppy-disk"></i> บันทึกผลการตรวจสอบ</button><span class="hint">ระบบประทับเวลาให้อัตโนมัติเมื่อมีการลงชื่อ</span></div>' : ''}
      </div>
    </div>
  </div>

  <div style="position:sticky;top:90px">
    ${flow}
    ${side}
    ${wfSigns}

    <div class="card mb2 reveal">
      <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-signature ic-swing"></i></span><h3>ลายมือชื่อ</h3></div>
      <div class="card-b grid g2">
        <div class="center">${sg.requester ? `<img class="sig-img" src="${sg.requester}">` : ''}<br><small class="text2">ผู้ขออนุญาต (ผู้รับเหมา)<br>${E(p.requester_name)}</small></div>
        <div class="center">${sg.owner ? `<img class="sig-img" src="${sg.owner}">` : '<div class="muted" style="padding:24px 0">— ยังไม่ลงนาม —</div>'}<br><small class="text2">ผู้รับผิดชอบงานโครงการ<br>${E(p.owner_name)}</small></div>
      </div>
    </div>

    <div class="card reveal">
      <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-timeline ic-bob"></i></span><h3>ประวัติการดำเนินการ</h3></div>
      <div class="card-b">${WP.timelineHTML(r.data.logs)}</div>
    </div>
  </div>
</div>`;
  WP.reveal(root);
  WP.bindAttachment(root, { id: p.id });

  // ---------- same client logic as view.php ----------
  WP.renderChecklist($('#checklist'), WP.defs, P.types, P.checklist, !clEditable);
  if ($('#loto')) WP.renderLoto($('#loto'), P.loto, !clEditable);
  if ($('#cs-box')) WP.renderConfined($('#cs-box'), P.confined, !P.editable, true);

  const collect = () => {
    const o = {};
    $$('#insp input[data-s]').forEach(i => { (o[i.dataset.r] ??= {})[i.dataset.s] = { name: i.value.trim() }; });
    $$('#insp input[data-note]').forEach(i => { (o[i.dataset.r] ??= {}).note = i.value.trim(); });
    return { id: P.id, base: P.base, checklist: WP.collectChecklist($('#checklist')), loto: $('#loto') ? WP.collectLoto($('#loto')) : [], ...($('#cs-box') ? { confined: WP.collectConfined($('#cs-box')) } : {}), inspections: o };
  };
  const save = async (log = true) => {
    const x = await WP.api('save_review', { ...collect(), log });
    if (!x.ok) throw new Error(x.msg);
    if (x.data && x.data.updated_at) P.base = x.data.updated_at; // our own save is not a conflict for a retried approve / close
    return x;
  };

  $$('.sign-me').forEach(b => b.onclick = () => {
    const i = $(`#insp input[data-r="${b.dataset.r}"][data-s="${b.dataset.s}"]`); i.value = P.me;
    i.closest('.insp-cell').classList.add('filled'); b.remove();
  });
  $$('.self-sign').forEach(b => b.addEventListener('click', WP.busy(async () => {
    const lbl = D.inspectStages[b.dataset.s];
    const c = await Swal.fire({ icon: 'question', title: 'ลงชื่อ' + lbl + '?', html: `${E(D.inspectRoles[b.dataset.r])}<br><b>${E(P.me)}</b><br><small>ระบบประทับเวลาให้อัตโนมัติ</small>`, showCancelButton: true, confirmButtonText: '<i class="fa-solid fa-signature"></i> ลงชื่อ', cancelButtonText: 'ยกเลิก' });
    if (!c.isConfirmed) return;
    const x = await WP.api('inspect_sign', { id: P.id, stage: b.dataset.s, row: b.dataset.r });
    if (!x.ok) return Swal.fire({ icon: 'error', title: 'ลงชื่อไม่สำเร็จ', text: x.msg });
    await Swal.fire({ icon: 'success', title: 'ลงชื่อเรียบร้อย', timer: 1200, showConfirmButton: false });
    location.reload();
  })));
  $('#btn-save')?.addEventListener('click', WP.busy(async () => {
    try { await save(); Swal.fire({ icon: 'success', title: 'บันทึกเรียบร้อย', timer: 1300, showConfirmButton: false }).then(() => location.reload()); }
    catch (e) { Swal.fire({ icon: 'error', title: 'บันทึกไม่สำเร็จ', text: e.message }); }
  }));

  let pad;
  if ($('#sig-appr-box')) { $('#sig-appr-box').innerHTML = WP.sigHTML('sig-appr', 'ลงชื่อผู้อนุมัติ (จป.) <span class="req">*</span>'); pad = new WP.SignaturePad($('#sig-appr')); }

  const decide = async (decision, comment, sign = '') => {
    const x = await WP.api('decide', { id: P.id, decision, comment, sign });
    if (!x.ok) { Swal.fire({ icon: 'error', title: 'ไม่สำเร็จ', text: x.msg }); return false; }
    return true;
  };

  $('#btn-approve')?.addEventListener('click', WP.busy(async () => {
    if (pad.empty) return Swal.fire({ icon: 'warning', title: 'กรุณาลงลายมือชื่อผู้อนุมัติ' });
    const c = await Swal.fire({ icon: 'question', title: 'ยืนยันอนุมัติใบอนุญาต?', html: 'ผู้ขอจะสามารถเริ่มปฏิบัติงานได้ตามเวลาที่ระบุ', showCancelButton: true, confirmButtonText: '<i class="fa-solid fa-circle-check"></i> อนุมัติ', cancelButtonText: 'ยกเลิก' });
    if (!c.isConfirmed) return;
    Swal.fire({ title: 'กำลังบันทึก...', showConfirmButton: false, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try { await save(false); } catch (e) { return Swal.fire({ icon: 'error', title: 'บันทึกเช็คลิสต์ไม่สำเร็จ', text: e.message }); }
    if (await decide('approve', $('#comment').value, pad.toData())) {
      WP.celebrate();
      Swal.fire({ icon: 'success', title: 'อนุมัติเรียบร้อย!', html: '<i class="fa-solid fa-helmet-safety fa-3x ic-swing" style="color:var(--gold);margin:10px"></i><br>ขอให้ปฏิบัติงานอย่างปลอดภัย', timer: 2600, showConfirmButton: false }).then(() => location.reload());
    }
  }));
  $('#btn-reject')?.addEventListener('click', WP.busy(async () => {
    const x = await Swal.fire({ icon: 'warning', title: 'ไม่อนุมัติใบอนุญาต', input: 'textarea', inputValue: $('#comment').value, inputPlaceholder: 'ระบุเหตุผล / สิ่งที่ต้องแก้ไข', inputValidator: v => !v.trim() && 'กรุณาระบุเหตุผล', showCancelButton: true, confirmButtonText: 'ยืนยันไม่อนุมัติ', cancelButtonText: 'ยกเลิก' });
    if (!x.isConfirmed) return;
    if (await decide('reject', x.value)) location.reload();
  }));
  $('#btn-close')?.addEventListener('click', WP.busy(async () => {
    const x = await Swal.fire({ icon: 'question', title: 'ปิดงาน?', input: 'textarea', inputPlaceholder: 'บันทึกผลการตรวจสอบหลังเสร็จงาน (ถ้ามี)', showCancelButton: true, confirmButtonText: '<i class="fa-solid fa-flag-checkered"></i> ปิดงาน', cancelButtonText: 'ยกเลิก' });
    if (!x.isConfirmed) return;
    // like approve: the review on screen must be saved first, otherwise do not close
    try { await save(false); } catch (e) { return Swal.fire({ icon: 'error', title: 'บันทึกผลการตรวจสอบไม่สำเร็จ', text: e.message }); }
    if (await decide('close', x.value)) { WP.celebrate(); setTimeout(() => location.reload(), 1500); }
  }));
  if ($('#btn-del')) $('#btn-del').onclick = async () => {
    if (await WP.deletePermit(P.id, p.permit_no)) location.href = 'permits.html';
  };

  // ---------- approval workflow actions (stage 0–2 assignee) ----------
  const after = async (x, title) => {
    if (!x.ok) { Swal.fire({ icon: 'error', title: 'ไม่สำเร็จ', text: x.msg }); return; }
    await Swal.fire({ icon: 'success', title, timer: 1600, showConfirmButton: false });
    if (safety) location.reload(); else location.href = 'approvals.html';
  };
  let wfPad = null;
  if ($('#wf-sig-box')) { $('#wf-sig-box').innerHTML = WP.sigHTML('wf-sig', `ลงชื่อ${E(D.roles[STG[myStage].role])} <span class="req">*</span>`); wfPad = new WP.SignaturePad($('#wf-sig')); }
  $('#wf-assign')?.addEventListener('click', WP.busy(async () => {
    const sel = $('#wf-area');
    if (!sel.value) { sel.classList.add('invalid'); return Swal.fire({ icon: 'warning', title: 'กรุณาเลือกเจ้าของพื้นที่' }); }
    const name = sel.selectedOptions[0].textContent;
    const c = await Swal.fire({ icon: 'question', title: 'ส่งให้เจ้าของพื้นที่อนุมัติ?', html: `เจ้าของพื้นที่: <b>${E(name)}</b><br><small>ระบบจะแจ้งเตือนทาง Microsoft Teams</small>`, showCancelButton: true, confirmButtonText: '<i class="fa-solid fa-share-from-square"></i> ส่งต่อ', cancelButtonText: 'ยกเลิก' });
    if (!c.isConfirmed) return;
    Swal.fire({ title: 'กำลังบันทึก...', showConfirmButton: false, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    await after(await WP.api('assign_area', { id: P.id, area_owner_id: +sel.value, base: P.base }), 'ส่งให้เจ้าของพื้นที่แล้ว');
  }));
  $('#wf-approve')?.addEventListener('click', WP.busy(async () => {
    if (wfPad.empty) return Swal.fire({ icon: 'warning', title: 'กรุณาลงลายมือชื่อ' });
    const next = myStage === 'area' ? 'ผู้รับผิดชอบงาน' : 'จป.';
    const c = await Swal.fire({ icon: 'question', title: 'ยืนยันอนุมัติ?', html: `คำขอจะถูกส่งต่อให้ <b>${next}</b> พิจารณาในขั้นถัดไป`, showCancelButton: true, confirmButtonText: '<i class="fa-solid fa-circle-check"></i> อนุมัติ', cancelButtonText: 'ยกเลิก' });
    if (!c.isConfirmed) return;
    Swal.fire({ title: 'กำลังบันทึก...', showConfirmButton: false, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const x = await WP.api('stage_decide', { id: P.id, decision: 'approve', comment: $('#wf-comment').value, sign: wfPad.toData(), base: P.base,
      checklist: WP.collectChecklist($('#checklist')), ...($('#loto') ? { loto: WP.collectLoto($('#loto')) } : {}) });
    if (x.ok) WP.celebrate();
    await after(x, 'อนุมัติเรียบร้อย — ส่งต่อให้' + next + 'แล้ว');
  }));
  $('#wf-reject')?.addEventListener('click', WP.busy(async () => {
    const x = await Swal.fire({ icon: 'warning', title: 'ไม่อนุมัติใบอนุญาต', input: 'textarea', inputValue: $('#wf-comment') ? $('#wf-comment').value : '', inputPlaceholder: 'ระบุเหตุผล / สิ่งที่ต้องแก้ไข', inputValidator: v => !v.trim() && 'กรุณาระบุเหตุผล', showCancelButton: true, confirmButtonText: 'ยืนยันไม่อนุมัติ', cancelButtonText: 'ยกเลิก' });
    if (!x.isConfirmed) return;
    await after(await WP.api('stage_decide', { id: P.id, decision: 'reject', comment: x.value, base: P.base }), 'บันทึกไม่อนุมัติแล้ว');
  }));
  // ---------- จป.: reassign the approvers of stages 0–2 ----------
  $('#ra-save')?.addEventListener('click', WP.busy(async () => {
    const data = { id: P.id, base: P.base };
    if ($('#ra-resp').value) data.responsible_id = +$('#ra-resp').value;
    if ($('#ra-area') && $('#ra-area').value) data.area_owner_id = +$('#ra-area').value;
    const x = await WP.api('reassign', data);
    if (!x.ok) return Swal.fire({ icon: 'error', title: 'มอบหมายไม่สำเร็จ', text: x.msg });
    await Swal.fire({ icon: 'success', title: x.data.changed ? 'มอบหมายใหม่แล้ว' : 'ไม่มีการเปลี่ยนแปลง', timer: 1300, showConfirmButton: false });
    location.reload();
  }));
})();
