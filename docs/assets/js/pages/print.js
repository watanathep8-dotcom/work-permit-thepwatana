// print.php — A4 printable permit (admin by ?id=, requester by ?no=&t=)
// Layout of the paper form FM-MR-58: page 1 = request + checklists + approvals table,
// page 2 = หมายเหตุ / ระเบียบปฏิบัติ / ข้อตกลง / signatures, then the worker list
// (เอกสารแนบ) and — only for งานที่อับอากาศ — the FM-EMR-46 pages.
(async () => {
  const D = WP.data, E = WP.esc, WT = D.workTypes;
  const root = document.getElementById('print-root');
  // Fit-to-page: a page whose content is taller than the A4 printable area (297 − 2×10 mm)
  // is scaled down (CSS zoom, layout-aware) so it never spills onto a second sheet.
  WP.fitPages = rootEl => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;height:275mm;width:190mm';
    document.body.appendChild(probe);
    const maxH = probe.offsetHeight, maxW = probe.offsetWidth;
    probe.remove();
    rootEl.querySelectorAll('.fit').forEach(f => {
      f.style.zoom = '';
      // 3 % head-room: print re-wraps text slightly differently than the screen at small scales
      const k = Math.min(1, maxH / f.scrollHeight, maxW / f.scrollWidth);
      if (k < 1) { f.style.zoom = String(Math.floor(k * 0.97 * 1000) / 1000); return; }
    });
  };
  const id = WP.qs('id'), no = WP.qs('no'), t = WP.qs('t');
  const notFound = msg => { root.innerHTML = `<div class="page" style="min-height:auto;text-align:center;font-size:16px">${E(msg || 'ไม่พบใบอนุญาต')}</div>`; };
  if (!WP.apiUrl) return notFound('ยังไม่ได้ตั้งค่า apiUrl ใน docs/config.js');
  let r;
  if (id && WP.session) r = await WP.api('permit', { id: +id, signs: true });
  else if (no && t) r = await WP.api('permit', { no, t, signs: true });
  else return notFound(id ? 'กรุณาเข้าสู่ระบบ จป. ก่อนพิมพ์' : 'ไม่พบใบอนุญาต');
  if (!r.ok) return notFound(r.msg);

  const p = r.data.permit, sg = r.data.signs || {};
  const types = p.work_types, loto = p.loto || [], ins = p.inspections || {}, es = p.es;
  // checklists stored before the paper-form update are shown upgraded (same as the review page)
  const cl = WP.upgradeChecklist(p.checklist || {});
  document.title = p.permit_no + ' · ' + D.config.formTitle;
  const box = on => on ? '<span class="cb on">✓</span>' : '<span class="cb"></span>';
  const par = on => on ? '(<b>✓</b>)' : '(&nbsp;&nbsp;)';
  const td = WP.thaiDate, hm = WP.hm;
  const sigImg = src => src ? `<img class="sig" src="${src}">` : '';
  const fill = (v, w = '') => `<u class="fill"${w ? ` style="min-width:${w}"` : ''}>${E(v || '')}</u>`;

  // names of the files attached to a checklist item (เอกสารรับรองที่เกี่ยวข้อง / อื่นๆ), listed under it
  const itemFiles = Array.isArray(p.item_files) ? p.item_files : [];
  const filesHtml = it => {
    const fs = it.attach ? itemFiles.filter(f => f.item === it.id) : [];
    return fs.length ? `<div class="it files">ไฟล์แนบ: ${fs.map(f => E(f.name)).join(' · ')}</div>` : '';
  };
  // one checklist item as printed on the form
  const itemHtml = it => itemHtml0(it) + filesHtml(it);
  const itemHtml0 = it => {
    const v = cl[it.id];
    switch (it.type) {
      case 'group': return `<div class="grp">${E(it.label)}</div>`;
      case 'check': return `<div class="it">${box(!!v)} ${E(it.label)}</div>`;
      case 'text': return `<div class="it${it.half ? ' half' : ''}">${E(it.label)} ${fill(v, '35%')}</div>`;
      case 'checktext': return `<div class="it">${box(!!(v && v.on))} ${E(it.label)} ${fill(v && v.text, '30%')}</div>`;
      case 'ppe': {
        const sel = (v && v.sel) || [];
        return `<div class="it">${E(it.label)}</div><div class="ppe">` +
          it.options.map(o => `<span>${par(sel.includes(o))} ${E(o)}</span>`).join('') +
          `<span class="oth">${par(!!(v && v.other))} Other ${fill(v && v.other, '45%')}</span></div>`;
      }
    }
    return '';
  };
  const legacy = k => {
    const L = (cl._legacy || {})[k] || [];
    return L.length ? `<div class="it legacy">${E(D.checklistLegacy.note)}: ${L.map(E).join(' · ')}</div>` : '';
  };
  const items = (k, from, to) => {
    const it = WT[k].items, i0 = from ? it.findIndex(x => x.id === from) : 0, i1 = to ? it.findIndex(x => x.id === to) : it.length;
    return it.slice(i0, i1).map(itemHtml).join('');
  };
  const head = k => `<div class="sec">${box(types.includes(k))} ${E(WT[k].title || WT[k].label)}${WT[k].note ? ` <span class="sec-note">${E(WT[k].note)}</span>` : ''}</div>`;
  const off = k => types.includes(k) ? '' : ' wt-off';
  // a section in one column, or split in two columns at item `split` (as on the form)
  const section = k => {
    const w = WT[k];
    if (!w.split) return `<div class="blk${off(k)}">${head(k)}<div class="body">${items(k)}${legacy(k)}</div></div>`;
    return `<div class="blk${off(k)}">${head(k)}<div class="body two"><div>${items(k, '', w.split)}</div><div>${items(k, w.split)}${legacy(k)}</div></div></div>`;
  };
  const stamp = `<div class="stamp ${es}">${E(D.status[es].label)}</div>`;
  const ol = arr => '<ol>' + arr.map(x => `<li>${E(x)}</li>`).join('') + '</ol>';
  const requester = (p.requester_title + ' ' + p.requester_name).trim();

  // Approvals table: "การอนุญาตทำงาน (ผู้อนุมัติ)" = the approval workflow signatures (rows 1–2) and
  // the จป. approval (row 3); ก่อนเริ่มงาน / ระหว่างทำงาน / หลังเสร็จงาน = the inspection stamps.
  // An empty cell is left blank for a wet signature on the printed sheet.
  const done = ['approved', 'closed'].includes(p.status);
  const signCell = (img, name, at) => (img || name) ? `${sigImg(img)}<span class="val">${E(name || '')}</span>${at ? `<br><span class="at">${td(at, true)}</span>` : ''}` : '';
  const permitCell = rk => {
    const c = (ins[rk] || {}).permit;
    if (rk === 'owner' && p.workflow) return signCell(p.area_approved_at ? sg.area : '', p.area_approved_at ? p.area_owner_name : '', p.area_approved_at);
    if (rk === 'contractor' && p.workflow) return signCell(p.resp_approved_at ? sg.resp : '', p.resp_approved_at ? p.responsible_name : '', p.resp_approved_at);
    if (rk === 'safety') return signCell(done ? sg.approver : '', c ? c.name : (done ? p.approver_name : ''), c ? c.at : (done ? p.approved_at : ''));
    return signCell('', c && c.name, c && c.at); // permit without the workflow: typed by the จป. as before
  };
  const noteCell = rk => {
    const c = rk === 'owner' ? p.area_comment : rk === 'contractor' ? p.resp_comment : (done ? p.approve_comment : '');
    return [(ins[rk] || {}).note, c].filter(Boolean).map(E).join('<br>');
  };
  const lotoRows = Math.max(3, loto.reduce((n, x, i) => Object.values(x || {}).some(Boolean) ? i + 1 : n, 0));

  // ---------------- page 1: request + checklists + approvals table
  let h = `<div class="page">${stamp}<div class="fit">
  <table class="head">
    <tr>
      <td style="width:33%"><div class="co">${E(p.company)}</div><div class="small">เลขที่ <span class="no">${E(p.permit_no)}</span></div></td>
      <td class="title" style="width:28%">${E(D.config.formTitle)}<br>(${E(D.config.formTitleEn)})</td>
      <td style="width:39%">ประเภท &nbsp; ${box(p.permit_type === 'contractor')} ${E(D.permitTypes.contractor)} &nbsp; ${box(p.permit_type === 'internal')} ${E(D.permitTypes.internal)}<br>
        วันที่ <span class="val">${td(p.work_date)}</span> เวลา <span class="val">${hm(p.time_from)}</span> ถึง <span class="val">${hm(p.time_to)}</span> น.</td>
    </tr>
    <tr><td colspan="3"><div class="wts"><b>ลักษณะงาน</b><div class="wt-grid">${Object.entries(WT).map(([k, w]) => `<span>${box(types.includes(k))} ${E(w.label)}</span>`).join('')}</div></div></td></tr>
    <tr><td colspan="3" class="lines">
      ข้าพเจ้า (นาย / นาง / นางสาว) <span class="val">${E(requester)}</span> &nbsp; บริษัท / หน่วยงาน <span class="val">${E(p.requester_company)}</span> &nbsp; เบอร์โทรศัพท์ <span class="val">${E(p.requester_phone)}</span><br>
      ขออนุญาตนำพนักงานเข้าปฏิบัติงานในพื้นที่โครงการ จำนวน <span class="val">&nbsp;${+p.worker_count || 0}&nbsp;</span> คน โดยมีรายชื่อตามเอกสารแนบ<br>
      ชื่อผู้รับผิดชอบงานโครงการ <span class="val">${E(p.owner_name)}</span> &nbsp; เบอร์โทรศัพท์ <span class="val">${E(p.owner_phone || '-')}</span><br>
      รายละเอียดงานที่ปฏิบัติ <span class="val" style="white-space:pre-line">${E(p.job_detail)}</span><br>
      สถานที่ปฏิบัติงาน <span class="val">${E(p.location)}</span>
    </td></tr>
    <tr><td colspan="3" class="sub">${E(D.reviewNote)}</td></tr>
  </table>
  <table class="cl">
    <tr><td style="width:50%">${section('general')}${section('hot')}</td><td>${section('height')}</td></tr>
    <tr><td colspan="2">${section('chemical')}</td></tr>
    <tr><td colspan="2">${section('electric')}
      <table class="loto${off('electric')}"><tr class="sub"><th style="width:32%">รายการที่ทำการตัดระบบ</th><th>เวลาที่ติดตั้ง</th><th>ลงชื่อ</th><th>เวลาที่ปลดล็อค</th><th>ลงชื่อ</th><th>หมายเหตุ</th></tr>
        ${Array.from({ length: lotoRows }, (_, i) => { const x = loto[i] || {}; return `<tr><td>${i + 1}. <span class="val">${E(x.item || '')}</span></td>${['t_on', 'by_on', 't_off', 'by_off', 'note'].map(f => `<td class="val center">${E(x[f] || '')}</td>`).join('')}</tr>`; }).join('')}
      </table></td></tr>
    ${types.includes('confined') ? `<tr><td colspan="2" class="small">${box(true)} <b>${E(WT.confined.label)}</b> — รายละเอียดตามใบอนุญาตทำงานในที่อับอากาศ (${E(WT.confined.form)}) ที่แนบ</td></tr>` : ''}
  </table>
  <table class="appr">
    <tr><td colspan="6" class="stmt">${D.approvalStatement.map(E).join('<br>')}</td></tr>
    <tr class="sub center"><th style="width:19%"></th><th style="width:17%">การอนุญาตทำงาน<br>(ผู้อนุมัติ)</th><th style="width:15%">การตรวจสอบ<br>ก่อนเริ่มงาน</th><th style="width:15%">การตรวจสอบ<br>ระหว่างทำงาน</th><th style="width:15%">การตรวจสอบ<br>หลังเสร็จงาน</th><th>หมายเหตุ</th></tr>
    ${Object.entries(D.inspectRoles).map(([rk, rl]) => `<tr><td class="role">${E(rl)}</td><td class="center">${permitCell(rk)}</td>
      ${['before', 'during', 'after'].map(sk => { const c = (ins[rk] || {})[sk]; return `<td class="center">${signCell('', c && c.name, c && c.at)}</td>`; }).join('')}
      <td class="small val">${noteCell(rk)}</td></tr>`).join('')}
  </table>
  ${p.status === 'rejected' && p.approve_comment ? `<table><tr><td class="small"><b>เหตุผลที่ไม่อนุมัติ:</b> <span class="val">${WP.nl2br(p.approve_comment)}</span></td></tr></table>` : ''}
  <div class="code">${E(D.config.formCode)}</div>
</div></div>`;

  // ---------------- page 2: หมายเหตุ / ระเบียบปฏิบัติ / ข้อตกลง / signatures
  const ws = p.workers || [];
  h += `<div class="page"><div class="fit">
  <table class="notes"><tr><td style="width:9%"><b>หมายเหตุ</b></td><td>${ol(D.remarks)}</td></tr></table>
  <table class="rules">
    <tr><td style="width:52%" class="sub">ระเบียบปฏิบัติเพื่อความปลอดภัย อาชีวอนามัย และสภาพแวดล้อมในการทำงาน</td><td class="sub">ข้อตกลงด้านความปลอดภัย อาชีวอนามัย และสภาพแวดล้อมในการทำงาน</td></tr>
    <tr><td>${ol(D.safetyRules)}</td>
      <td>${ol(D.safetyAgreement)}
        <div class="grp">${E(D.wasteRules.title)}</div>${ol(D.wasteRules.items)}
        <p class="ack">${E(D.agreementAck)}</p>
        <div class="signl">${sigImg(sg.requester)}
          ลงชื่อ : ............................................ ผู้ขออนุญาต (ผู้รับเหมา)<br>( <span class="val">${E(requester)}</span> )</div>
        <div class="signl">${sigImg(sg.owner || (p.workflow ? sg.resp : ''))}
          ลงชื่อ : ............................................ ผู้รับผิดชอบงานโครงการ<br>( <span class="val">${E(!sg.owner && p.workflow && sg.resp ? p.responsible_name : p.owner_name)}</span> )</div>
      </td></tr>
  </table>
  <div class="code">${E(D.config.formCode)}</div>
</div></div>`;

  // ---------------- เอกสารแนบ: worker list ("โดยมีรายชื่อตามเอกสารแนบ")
  if (ws.length) {
    h += `<div class="page">
  <table>
    <tr><td colspan="4" class="sec">เอกสารแนบ: รายชื่อพนักงานเข้าปฏิบัติงาน (${ws.length} คน${(+p.worker_count || 0) > ws.length ? ` จากทั้งหมด ${+p.worker_count} คน` : ''}) — ${E(p.permit_no)}</td></tr>
    <tr class="sub"><th style="width:6%">#</th><th>ชื่อ - นามสกุล</th><th>ตำแหน่ง / หน้าที่</th><th>เลขบัตรประชาชน / บัตรพนักงาน</th></tr>
    ${ws.map((w, i) => `<tr><td>${i + 1}</td><td class="val">${E(w.name || '')}</td><td class="val">${E(w.role || '')}</td><td class="val">${E(w.idno || '')}</td></tr>`).join('')}
  </table>
</div>`;
  }

  // ---------------- confined space FM-EMR-46 (own pages, only when selected)
  if (types.includes('confined')) {
    const cw = WT.confined;
    const byId = {}; cw.items.forEach(it => { byId[it.id] = it; });
    const blank = { gas: Array.from({ length: 5 }, () => ({})), entries: Array.from({ length: 6 }, () => ({ name: '', t: Array.from({ length: 5 }, () => ({ in: '', out: '' })) })), renew: Array.from({ length: 3 }, () => ({})), close: {} };
    const cs = (p.confined && p.confined.gas) ? p.confined : blank;
    const tv = k => E(cl[k] || '');
    const grid = (prefix, n, cols) => {
      const half = Math.ceil(n / 2);
      let o = '<table class="small"><tr class="sub"><th></th>';
      [0, 1].forEach(x => { o += x ? '<th></th>' : ''; cols.forEach(c => { o += `<th class="center" style="width:7%">${E(c)}</th>`; }); });
      o += '</tr>';
      for (let rr = 1; rr <= half; rr++) {
        o += '<tr>';
        [rr, rr + half].forEach(k => {
          const it = byId[prefix + k];
          if (!it) { o += '<td></td>' + '<td></td>'.repeat(cols.length); return; }
          const v = cl[it.id];
          let lbl = E(it.label) + (it.other ? ` <u class="fill">${E(cl[it.id + '_t'] || '')}</u>` : '');
          if (it.type === 'checktext') lbl = `${E(it.label)} <u class="fill">${E((v && v.text) || '')}</u>`;
          o += `<td>${lbl}</td>`;
          if (it.type === 'choice') it.opts.forEach(op => { o += `<td class="center">${box(v === op)}</td>`; });
          else o += `<td class="center">${box(it.type === 'checktext' ? !!(v && v.on) : !!v)}</td>`;
        });
        o += '</tr>';
      }
      return o + '</table>';
    };
    const kind = (cl.cs_kind && cl.cs_kind.sel) || [];
    const ow = p.workflow && p.area_approved_at ? { name: p.area_owner_name } : (ins.owner || {}).permit; // ผู้อนุญาต = เจ้าของพื้นที่
    const em = D.confinedEmergency;
    const chunks = []; for (let i = 0; i < em.length; i += 4) chunks.push(em.slice(i, i + 4));

    h += `<div class="page">
  ${stamp}<div class="fit">
  <table class="head">
    <tr><td style="width:30%"><div class="co">${E(p.company)}</div><div class="small">อ้างอิง: <span class="no">${E(p.permit_no)}</span></div></td>
      <td class="title">ใบอนุญาตทำงานในที่อับอากาศ<br>(Confined Space Work Permit)</td>
      <td style="width:22%" class="small center">${E(cw.form)}, Rev : 00</td></tr>
    <tr><td colspan="3" class="small">${E(cw.note)}</td></tr>
    <tr><td colspan="3"><b>ประเภทงาน</b> &nbsp; ${byId.cs_kind.options.map(o => `<span style="margin-right:16px">${box(kind.includes(o))} ${E(o)}</span>`).join('')}</td></tr>
    <tr><td colspan="3">
      1. ผู้ควบคุมงาน ชื่อ <u class="fill">${tv('cs_sup')}</u> &nbsp; บริษัท/แผนก/หน่วย <u class="fill">${tv('cs_sup_co')}</u><br>
      สถานที่ปฏิบัติงาน <span class="val">${E(p.location)}</span> &nbsp; ปฏิบัติงานเกี่ยวกับ <u class="fill">${tv('cs_about') || E(Array.from(p.job_detail || '').slice(0, 80).join(''))}</u><br>
      เวลาปฏิบัติงาน <span class="val">${hm(p.time_from)}</span> ถึง <span class="val">${hm(p.time_to)}</span> น. &nbsp; วันที่ <span class="val">${td(p.work_date)}</span><br>
      2. ผู้ช่วยเหลือ ชื่อ 1. <u class="fill">${tv('cs_help1')}</u> &nbsp; 2. <u class="fill">${tv('cs_help2')}</u><br>
      3. ผู้ปฏิบัติงาน ชื่อ 1. <u class="fill">${tv('cs_work1')}</u> &nbsp; 2. <u class="fill">${tv('cs_work2')}</u>
    </td></tr>
  </table>
  <div class="sec">4. การชี้บ่งอันตรายการทำงานในที่อับอากาศ</div>${grid('cs4_', 12, ['ใช่', 'ไม่ใช่'])}
  <div class="sec">5. มาตรการความปลอดภัยก่อนเข้าปฏิบัติงานในที่อับอากาศ</div>${grid('cs5_', 18, ['ใช่', 'ไม่เกี่ยวข้อง'])}
  <div class="sec">6. อุปกรณ์ป้องกันอันตรายส่วนบุคคล (PPE) และอุปกรณ์เพิ่มเติมอื่นๆ ที่จำเป็นในงานที่อับอากาศ</div>${grid('cs6_', 18, ['จำเป็น'])}
  <div class="sec">7. แผนฉุกเฉิน แผนช่วยเหลือในที่อับอากาศ</div>
  <table class="small"><tr><td>เมื่อเกิดเหตุการณ์ฉุกเฉินในที่อับอากาศ ต้องปฏิบัติ ดังนี้<div class="cols" style="grid-template-columns:1fr 1fr">${chunks.map(ch => `<div style="border:0">${ch.map(l => `<div>${E(l)}</div>`).join('')}</div>`).join('')}</div></td></tr></table>
  <table class="small"><tr><td colspan="2">ได้ตรวจสอบมาตรการและการเตรียมการอื่นๆ เพื่อความปลอดภัยแล้วเห็นควรว่า การปฏิบัติงานในที่อับอากาศดำเนินได้อย่างปลอดภัย</td></tr>
    <tr><td class="center" style="width:50%">${sigImg(sg.approver)}ลงชื่อ ........................................ หน่วยงานความปลอดภัย<br>( <span class="val">${E(p.approver_name || '')}</span> ) ${p.approved_at ? td(p.approved_at, true) : ''}</td>
      <td class="center"><br>ลงชื่อ ........................................ ผู้อนุญาต<br>( <span class="val">${E((ow && ow.name) || '')}</span> )</td></tr></table>
</div></div>`;

    const gasRows = [['o2', '% O2 โดยปริมาตร'], ['lel', '% LEL'], ['by', 'ชื่อผู้ตรวจ'], ['time', 'เวลา']];
    h += `<div class="page"><div class="fit">
  <div class="sec">8. การตรวจวัดบรรยากาศในที่อับอากาศ (ก่อนเข้าปฏิบัติงานและขณะปฏิบัติงาน) โดยผู้ช่วยเหลือ / จป.วิชาชีพ</div>
  <table class="small"><tr class="sub"><th>บันทึกผลการวัดก๊าซ</th>${[1, 2, 3, 4, 5].map(i => `<th class="center">ครั้งที่ ${i}</th>`).join('')}</tr>
    ${gasRows.map(([f, l]) => `<tr><td>${l}</td>${[0, 1, 2, 3, 4].map(i => `<td class="center val">${E((cs.gas[i] || {})[f] || '')}</td>`).join('')}</tr>`).join('')}</table>
  <div class="sec">9. บันทึกเวลาเข้าและออก ของผู้ปฏิบัติงานในที่อับอากาศ</div>
  <table class="small"><tr class="sub"><th>ชื่อ - สกุล</th>${[1, 2, 3, 4, 5].map(() => '<th class="center">เวลาเข้า - เวลาออก</th>').join('')}</tr>
    ${cs.entries.map(e => `<tr><td class="val" style="height:22px">${E(e.name)}</td>${(e.t || []).map(x => `<td class="center val">${E(x.in)}${(x.in || x.out) ? ' - ' : ''}${E(x.out)}</td>`).join('')}</tr>`).join('')}</table>
  <div class="sec">10. การต่อใบอนุญาต (ต้องตรวจสอบก่อนให้ต่อใบอนุญาต)</div>
  <table class="small"><tr class="sub"><th style="width:10%">ครั้งที่</th><th>เริ่มต้น (เวลา)</th><th>สิ้นสุด (เวลา)</th><th>ผู้อนุญาต</th><th style="width:34%">หมายเหตุ</th></tr>
    ${cs.renew.map((x, i) => `<tr><td class="center">${i + 1}</td><td class="center val">${E(x.start || '')}</td><td class="center val">${E(x.end || '')}</td><td class="val">${E(x.by || '')}</td>${i === 0 ? '<td rowspan="3">- การต่อใบอนุญาต ต้องต่อโดยผู้ควบคุมงาน<br>- เมื่อเกิดเหตุฉุกเฉินใบอนุญาตนี้ถูกยกเลิกโดยอัตโนมัติ</td>' : ''}</tr>`).join('')}</table>
  <div class="sec">11. การปิดใบอนุญาต</div>
  <table><tr><td>
    ${Object.entries(D.confinedClose).map(([k, l]) => `<div class="it">${box(!!cs.close[k])} ${E(l)}${k === 'cancel' ? ` <u class="fill">${E(cs.close.reason || '')}</u>` : ''}</div>`).join('')}
    <div class="cols" style="margin-top:14px"><div class="center" style="border:0">ลงชื่อ ........................................ (ผู้ควบคุมงาน)<br>( <span class="val">${tv('cs_sup')}</span> )</div>
      <div class="center">ลงชื่อ ........................................ (ผู้อนุญาต)<br>( <span class="val">${p.status === 'closed' ? E(p.approver_name) : ''}</span> )</div></div>
    <div class="center" style="margin-top:8px">วันที่ <span class="val">${p.closed_at ? td(p.closed_at, true) : '................/................/................ เวลา ................ น.'}</span></div>
  </td></tr></table>
  <div class="small" style="text-align:right;margin-top:4px">${E(cw.form)} · Effective Date : 30 June 2025</div>
</div></div>`;
  }
  root.innerHTML = h;
  WP.fitPages(root);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => WP.fitPages(root)); // Sarabun metrics
})();
