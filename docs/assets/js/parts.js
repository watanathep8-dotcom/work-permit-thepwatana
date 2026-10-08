/* ================================================================
   e-Work Permit — shared permit rendering (port of inc/permit_parts.php
   and the helpers of inc/data.php). Returns HTML strings.
   ================================================================ */
(() => {
  const WP = window.WP, D = WP.data, E = WP.esc;
  const MONTHS = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  /** thai_date(): "YYYY-MM-DD[ HH:MM:SS]" (Bangkok wall time) → "5 ต.ค. 2569[ 09:30 น.]" */
  WP.thaiDate = (d, withTime = false) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(d || ''));
    if (!m) return '-';
    let s = `${+m[3]} ${MONTHS[+m[2]]} ${+m[1] + 543}`;
    if (withTime) s += ` ${m[4] || '00'}:${m[5] || '00'} น.`;
    return s;
  };
  WP.hm = t => String(t || '').substring(0, 5);
  WP.nl2br = s => E(s).replace(/\r?\n/g, '<br>');

  WP.statusBadge = st => {
    const s = D.status[st] || D.status.pending;
    return `<span class="badge ${s.cls}"><i class="fa-solid ${s.icon}"></i> ${s.label}</span>`;
  };

  /** Pending permits in the approval workflow: which stage (0–3) they wait at. */
  WP.stageBadge = p => {
    const st = p && p.status === 'pending' && D.stages && D.stages[p.stage];
    if (!st) return '';
    return `<span class="badge st-stage"><i class="fa-solid ${st.icon}"></i> ขั้นที่ ${st.no}: ${E(st.label)}</span>`;
  };

  WP.wtTags = types => (types || []).map(t => {
    const w = D.workTypes[t]; if (!w) return '';
    return `<span class="wt-tag" style="--wc:${w.color}"><i class="fa-solid ${w.icon}"></i> ${E(w.short)}</span>`;
  }).join('');

  /** render_info_card(). opts.staff: also the assigned approvers (logged-in pages only). */
  WP.infoCardHTML = (p, opts = {}) => {
    let h = `<div class="card mb2 reveal">
    <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-file-lines ic-bob"></i></span><h3>ข้อมูลใบขออนุญาต</h3></div>
    <div class="card-b">
      <dl class="kv">
        <dt>บริษัท (พื้นที่)</dt><dd>${E(p.company)}</dd>
        <dt>ประเภท</dt><dd>${E(D.permitTypes[p.permit_type] || '')}</dd>
        <dt>ลักษณะงาน</dt><dd>${WP.wtTags(p.work_types)}</dd>
        <dt>วันที่ / เวลา</dt><dd><i class="fa-regular fa-calendar"></i> ${WP.thaiDate(p.work_date)} &nbsp; <i class="fa-regular fa-clock"></i> ${WP.hm(p.time_from)} – ${WP.hm(p.time_to)} น.</dd>
        <dt>ผู้ขออนุญาต</dt><dd>${E((p.requester_title + ' ' + p.requester_name).trim())} <span class="muted">· <i class="fa-solid fa-phone"></i> ${E(p.requester_phone)}</span></dd>
        <dt>บริษัท / หน่วยงาน</dt><dd>${E(p.requester_company)}</dd>
        <dt>จำนวนพนักงาน</dt><dd>${+p.worker_count || 0} คน</dd>
        <dt>ผู้รับผิดชอบงานโครงการ</dt><dd>${E(p.owner_name)}${p.owner_phone ? ` <span class="muted">· <i class="fa-solid fa-phone"></i> ${E(p.owner_phone)}</span>` : ''}</dd>${opts.staff && p.workflow ? `
        <dt>ผู้รับผิดชอบงาน (ผู้อนุมัติ)</dt><dd><i class="fa-solid fa-user-tie"></i> ${E(p.responsible_name || '-')}</dd>
        <dt>เจ้าของพื้นที่ (ผู้อนุมัติ)</dt><dd><i class="fa-solid fa-map-location-dot"></i> ${p.area_owner_name ? E(p.area_owner_name) : '<span class="muted">— ยังไม่ระบุ —</span>'}</dd>` : ''}
        <dt>สถานที่ปฏิบัติงาน</dt><dd><i class="fa-solid fa-location-dot" style="color:var(--red)"></i> ${E(p.location)}</dd>
        <dt>รายละเอียดงาน</dt><dd style="white-space:pre-line">${E(p.job_detail)}</dd>`;
    if (p.has_attachment) h += `
        <dt>เอกสารแนบ</dt><dd><a class="btn sm ghost" href="#" data-attachment><i class="fa-solid fa-paperclip"></i> ${E(p.attachment_name)}</a></dd>`;
    // files of the checklist items (เอกสารรับรองที่เกี่ยวข้อง / อื่นๆ): staff open them, the requester sees names only
    const groups = WP.itemFileGroups(p);
    if (groups.length) h += `
        <dt>ไฟล์แนบรายการตรวจสอบ</dt><dd><ul class="item-files">` + groups.map(g => `<li><span class="it-lbl">${E(g.label)}</span><span class="chips-f">` +
        g.files.map(f => opts.staff
          ? `<a class="btn sm ghost" href="#" data-item-file="${E(f.fid)}" title="เปิด / ดาวน์โหลด"><i class="fa-solid fa-paperclip"></i> ${E(f.name)}</a>`
          : `<span class="fchip"><i class="fa-solid fa-paperclip"></i> ${E(f.name)}</span>`).join('') + '</span></li>').join('') + '</ul></dd>';
    h += `
      </dl>
    </div>
  </div>`;
    const ws = p.workers || [];
    if (ws.length) {
      h += `<div class="card mb2 reveal">
    <div class="card-h"><span class="ch-ic"><i class="fa-solid fa-users ic-beat"></i></span><h3>รายชื่อพนักงาน (${ws.length} คน)</h3></div>
    <div class="card-b"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>ชื่อ - นามสกุล</th><th>ตำแหน่ง / หน้าที่</th><th>เลขบัตร</th></tr></thead><tbody>` +
        ws.map((w, i) => `<tr><td>${i + 1}</td><td>${E(w.name)}</td><td>${E(w.role || '')}</td><td>${E(w.idno || '')}</td></tr>`).join('') +
        `</tbody></table></div></div>
  </div>`;
    }
    return h;
  };

  // Checklists of the paper form (FM-MR-58). Values of an older checklist (no _v) are
  // upgraded first (wpUpgradeChecklist_, Data.gs) — renamed PPE options, retired items
  // kept read-only under "อื่นๆ" (_legacy) and sent back unchanged on save.
  WP.upgradeChecklist = v => (typeof window.wpUpgradeChecklist_ === 'function' ? window.wpUpgradeChecklist_(JSON.parse(JSON.stringify(v || {}))) : (v || {}));
  WP.orderTypes = types => {
    const ord = WP.data.checklistOrder || [];
    return types.slice().sort((a, b) => (ord.indexOf(a) + 1 || 99) - (ord.indexOf(b) + 1 || 99));
  };
  WP.legacyHTML = (values, k) => {
    const L = (values && values._legacy && values._legacy[k]) || [];
    return L.length ? `<div class="cl-legacy full"><i class="fa-solid fa-clock-rotate-left"></i> <b>${WP.esc((WP.data.checklistLegacy || {}).note || 'อื่นๆ')}:</b> ${L.map(WP.esc).join(' · ')}</div>` : '';
  };

  /** render_timeline() */
  WP.timelineHTML = logs => {
    const map = {
      submit: ['ยื่นใบขออนุญาต', ''], approve: ['จป. อนุมัติ', ''], reject: ['ไม่อนุมัติ', 'reject'], close: ['ปิดงาน', 'close'], review: ['บันทึกการตรวจสอบ', ''], edit: ['จป. แก้ไขข้อมูล', ''],
      assign_area: ['ผู้รับผิดชอบงานระบุเจ้าของพื้นที่', ''], area_approve: ['เจ้าของพื้นที่อนุมัติ', ''], resp_approve: ['ผู้รับผิดชอบงานอนุมัติ', ''], reassign: ['จป. มอบหมายผู้อนุมัติใหม่', ''], inspect: ['ลงชื่อการตรวจสอบ', '']
    };
    return '<div class="timeline">' + (logs || []).map((l, i) => {
      const [t, c] = map[l.action] || [l.action, ''];
      return `<div class="tl-item ${c}" style="animation-delay:${i * 100}ms"><b>${E(t)}</b><small>${WP.thaiDate(l.created_at, true)} · ${E(l.by_name)}</small>${l.note ? '<p>' + WP.nl2br(l.note) + '</p>' : ''}</div>`;
    }).join('') + '</div>';
  };

  /**
   * Approval workflow progress (permits with a responsible): every stage with its
   * time. Shows stage names and timestamps only — no names, no signatures.
   */
  WP.workflowStepsHTML = p => {
    const st = p.status, stg = D.stages || {};
    const rejectAt = st === 'rejected' ? ({ assign: 1, area: 2, resp: 3, safety: 4 }[p.reject_stage] || 4) : -1;
    const curAt = st === 'pending' ? (stg[p.stage] ? stg[p.stage].no + 1 : 4) : (st === 'approved' ? 4 : -1);
    const steps = [
      ['fa-paper-plane', 'ยื่นคำขอ', p.created_at],
      [stg.assign.icon, stg.assign.short, p.area_assigned_at],
      [stg.area.icon, stg.area.short, p.area_approved_at],
      [stg.resp.icon, stg.resp.short, p.resp_approved_at],
      [stg.safety.icon, st === 'approved' || st === 'closed' ? 'จป. อนุมัติ / ปฏิบัติงาน' : stg.safety.short, ['approved', 'closed'].includes(st) ? p.approved_at : ''],
      ['fa-flag-checkered', 'ปิดงาน', p.closed_at]
    ];
    let h = '<div class="track-steps wf">' + steps.map(([ic, lbl, at], i) => {
      const bad = i === rejectAt, on = !!at || bad, cur = i === curAt;
      const when = bad ? WP.thaiDate(p.approved_at, true) : (at ? WP.thaiDate(at, true) : (cur && st === 'pending' ? 'กำลังรอ' : ''));
      return `<div class="ts ${on ? 'on ' : ''}${cur ? 'cur ' : ''}${bad ? 'bad' : ''}"><div class="ts-ic"><i class="fa-solid ${bad ? 'fa-xmark' : ic}"></i></div><span>${E(bad ? 'ไม่อนุมัติ' : lbl)}</span>${when ? `<small class="ts-at">${E(when)}</small>` : ''}</div>`;
    }).join('') + '</div>';
    if (p.es === 'expired') h += `<div class="alert warn mt1"><i class="fa-solid fa-clock"></i><div>ใบอนุญาตนี้ <b>หมดอายุแล้ว</b> (เกินเวลาที่ระบุ / เกิน ${D.config.permitValidHours} ชม.) หากงานยังไม่เสร็จต้องขออนุญาตใหม่</div></div>`;
    return h;
  };

  /** render_track_steps() — uses the server-computed effective status (es) */
  WP.trackStepsHTML = p => {
    if (p.workflow && D.stages) return WP.workflowStepsHTML(p);
    const st = p.status;
    const s = [
      ['fa-paper-plane', 'ยื่นคำขอ', true, false],
      ['fa-user-shield', 'จป. พิจารณา', st !== 'pending', st === 'pending'],
      [st === 'rejected' ? 'fa-xmark' : 'fa-person-digging', st === 'rejected' ? 'ไม่อนุมัติ' : 'อนุมัติ / ปฏิบัติงาน', ['approved', 'closed', 'rejected'].includes(st), st === 'approved'],
      ['fa-flag-checkered', 'ปิดงาน', st === 'closed', false]
    ];
    let h = '<div class="track-steps">' + s.map(([ic, lbl, on, cur], i) => {
      const bad = i === 2 && st === 'rejected';
      return `<div class="ts ${on ? 'on ' : ''}${cur ? 'cur ' : ''}${bad ? 'bad' : ''}"><div class="ts-ic"><i class="fa-solid ${ic}"></i></div><span>${lbl}</span></div>`;
    }).join('') + '</div>';
    if (p.es === 'expired') h += `<div class="alert warn mt1"><i class="fa-solid fa-clock"></i><div>ใบอนุญาตนี้ <b>หมดอายุแล้ว</b> (เกินเวลาที่ระบุ / เกิน ${D.config.permitValidHours} ชม.) หากงานยังไม่เสร็จต้องขออนุญาตใหม่</div></div>`;
    return h;
  };

  /**
   * Opens the attachment (replaces file.php). `params` = {id} for admins or {no, t}
   * for the token holder. PDF/PNG/JPEG open inline in a new tab, others download.
   */
  WP.openAttachment = async params => {
    const win = window.open('', '_blank');
    if (win) win.document.write('<p style="font-family:sans-serif;padding:20px">กำลังโหลดไฟล์...</p>');
    const r = await WP.api('file', params, { quiet: true }); // an expired session must not leave the page
    if (!r.ok) {
      if (win) win.close();
      return window.Swal ? Swal.fire({ icon: 'error', title: 'เปิดไฟล์ไม่สำเร็จ', text: r.msg }) : alert(r.msg);
    }
    const bin = atob(r.data.base64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: r.data.mimeType }));
    if (r.data.inline && win) {
      win.location.href = url;
    } else {
      if (win) win.close();
      const a = document.createElement('a');
      a.href = url; a.download = r.data.name || 'attachment';
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  WP.bindAttachment = (root, params) => {
    root.querySelectorAll('[data-attachment]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); WP.openAttachment(params); }));
    root.querySelectorAll('[data-item-file]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); WP.openAttachment(Object.assign({}, params, { fid: a.dataset.itemFile })); }));
  };
  /** permit.item_files grouped by checklist item, in form order: [{item, label, files}] (older permits: []). */
  WP.itemFileGroups = p => {
    const files = Array.isArray(p.item_files) ? p.item_files : [], out = [];
    if (!files.length) return out;
    WP.orderTypes(Object.keys(D.workTypes)).forEach(k => D.workTypes[k].items.forEach(it => {
      const fs = files.filter(f => f.item === it.id);
      if (fs.length) out.push({ item: it.id, label: `${D.workTypes[k].short || D.workTypes[k].label} · ${it.label}`, files: fs });
    }));
    return out;
  };
})();
