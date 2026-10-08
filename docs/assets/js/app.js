/* ================================================================
   e-Work Permit — shared UI / FX
   (ported from the PHP app; API transport now lives in core.js)
   ================================================================ */
(() => {
  if (WP.halt) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  WP.$ = $; WP.$$ = $$;

  // ---------- Loader ----------
  window.addEventListener('load', () => setTimeout(() => $('#page-loader')?.classList.add('done'), 250));
  setTimeout(() => $('#page-loader')?.classList.add('done'), 2500);

  // ---------- Particle network background ----------
  const cv = $('#fx-bg');
  if (cv && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const ctx = cv.getContext('2d');
    let W, H, pts = [], mouse = { x: -999, y: -999 };
    const DPR = Math.min(devicePixelRatio || 1, 2);
    const resize = () => {
      W = innerWidth; H = innerHeight;
      cv.width = W * DPR; cv.height = H * DPR; cv.style.width = W + 'px'; cv.style.height = H + 'px';
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      const n = Math.min(90, Math.floor(W * H / 16000));
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35,
        r: Math.random() * 1.8 + .6, g: Math.random() < .15
      }));
    };
    addEventListener('resize', resize); resize();
    addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
    addEventListener('mouseout', () => { mouse.x = mouse.y = -999; });
    const tick = () => {
      ctx.clearRect(0, 0, W, H);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
        const dx = p.x - mouse.x, dy = p.y - mouse.y, d = Math.hypot(dx, dy);
        if (d < 140) { p.x += dx / d * 1.2; p.y += dy / d * 1.2; }
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 130) {
            ctx.strokeStyle = `rgba(52,211,153,${(1 - d / 130) * .22})`;
            ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
        const md = Math.hypot(pts[i].x - mouse.x, pts[i].y - mouse.y);
        if (md < 180) {
          ctx.strokeStyle = `rgba(163,230,53,${(1 - md / 180) * .45})`;
          ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
        }
      }
      for (const p of pts) {
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7);
        ctx.fillStyle = p.g ? 'rgba(251,191,36,.85)' : 'rgba(110,231,183,.75)';
        ctx.shadowBlur = p.g ? 12 : 6; ctx.shadowColor = p.g ? '#fbbf24' : '#34d399';
        ctx.fill(); ctx.shadowBlur = 0;
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- Reveal on scroll ----------
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: .12 });
  WP.reveal = (root = document) => $$('.reveal:not(.in)', root).forEach((el, i) => { el.style.transitionDelay = (el.dataset.delay || (i % 6) * 70) + 'ms'; io.observe(el); });
  WP.reveal();

  // ---------- Button ripple ----------
  document.addEventListener('pointerdown', e => {
    const b = e.target.closest('.btn'); if (!b) return;
    const r = b.getBoundingClientRect(), s = document.createElement('span');
    s.className = 'rip'; s.style.left = (e.clientX - r.left) + 'px'; s.style.top = (e.clientY - r.top) + 'px';
    b.appendChild(s); setTimeout(() => s.remove(), 700);
  });

  // ---------- 3D tilt ----------
  WP.tilt = (root = document) => $$('[data-tilt]:not([data-tilt-on])', root).forEach(el => {
    el.dataset.tiltOn = '1';
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      el.style.transform = `perspective(900px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg) translateY(-4px)`;
    });
    el.addEventListener('mouseleave', () => { el.style.transform = ''; });
  });
  WP.tilt();

  // ---------- Counters ----------
  WP.countUp = (el, to, dur = 1400, from = 0) => {
    const t0 = performance.now();
    const step = t => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
      el.textContent = Math.round(from + (to - from) * e).toLocaleString('th-TH');
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  $$('[data-count]').forEach(el => WP.countUp(el, +el.dataset.count));

  // ---------- API ----------
  // WP.api / WP.get / WP.esc are defined in core.js (Google Apps Script transport).

  // ---------- Toast ----------
  WP.toast = (title, sub = '', href = null, icon = 'fa-bell') => {
    let st = $('.toast-stack'); if (!st) { st = document.createElement('div'); st.className = 'toast-stack'; document.body.appendChild(st); }
    const t = document.createElement('div'); t.className = 'toast';
    t.innerHTML = `<div class="t-ic"><i class="fa-solid ${icon}"></i></div><div><b>${WP.esc(title)}</b><small>${WP.esc(sub)}</small></div>`;
    t.onclick = () => { if (href) location.href = href; };
    st.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 7000);
  };
  WP.chime = () => {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1175, 1568].forEach((f, i) => {
        const o = a.createOscillator(), g = a.createGain();
        o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(a.destination);
        const t = a.currentTime + i * .13;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.18, t + .02); g.gain.exponentialRampToValueAtTime(.001, t + .5);
        o.start(t); o.stop(t + .55);
      });
    } catch { }
  };
  WP.celebrate = () => {
    if (!window.confetti) return;
    const c = ['#10b981', '#34d399', '#a3e635', '#fbbf24', '#ffffff'];
    confetti({ particleCount: 140, spread: 90, origin: { y: .6 }, colors: c });
    setTimeout(() => { confetti({ particleCount: 80, angle: 60, spread: 70, origin: { x: 0 }, colors: c }); confetti({ particleCount: 80, angle: 120, spread: 70, origin: { x: 1 }, colors: c }); }, 300);
  };

  // ---------- Signature pad ----------
  WP.SignaturePad = class {
    constructor(wrap) {
      this.wrap = wrap; this.cv = $('canvas', wrap); this.ctx = this.cv.getContext('2d');
      this.empty = true; this.drawing = false; this.last = null;
      this.resize();
      addEventListener('resize', () => {
        const r = this.cv.getBoundingClientRect();
        if (!r.width || Math.round(r.width * Math.min(devicePixelRatio || 1, 2)) === this.cv.width) return; // hidden or unchanged
        const d = this.empty ? null : this.cv.toDataURL(); this.resize(); if (d) this.load(d);
      });
      const pos = e => { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || .5 }; };
      this.cv.addEventListener('pointerdown', e => { this.drawing = true; this.last = pos(e); this.cv.setPointerCapture(e.pointerId); this.dot(this.last); });
      this.cv.addEventListener('pointermove', e => { if (!this.drawing) return; const p = pos(e); this.line(this.last, p); this.last = p; });
      const end = () => { this.drawing = false; };
      this.cv.addEventListener('pointerup', end); this.cv.addEventListener('pointercancel', end);
      $('.sig-clear', wrap)?.addEventListener('click', () => this.clear());
    }
    resize() {
      const r = this.cv.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
      // rounded like the check in the resize listener: a truncated fractional width would
      // never match it, so every mobile scroll (URL bar → resize) re-drew and blurred the signature
      this.cv.width = Math.round(r.width * d); this.cv.height = Math.round(r.height * d); this.ctx.setTransform(d, 0, 0, d, 0, 0);
      this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round'; this.ctx.strokeStyle = '#d9fbe8'; this.ctx.fillStyle = '#d9fbe8';
    }
    mark() { if (this.empty) { this.empty = false; this.wrap.classList.add('signed'); } }
    dot(p) { this.mark(); this.ctx.beginPath(); this.ctx.arc(p.x, p.y, 1.4, 0, 7); this.ctx.fill(); }
    line(a, b) { this.mark(); this.ctx.lineWidth = 1.6 + (b.p || .5) * 2; this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke(); }
    clear() { this.ctx.clearRect(0, 0, this.cv.width, this.cv.height); this.empty = true; this.wrap.classList.remove('signed'); }
    load(src) { const im = new Image(); im.onload = () => { const r = this.cv.getBoundingClientRect(); this.ctx.drawImage(im, 0, 0, r.width, r.height); this.mark(); }; im.src = src; }
    // export as dark ink on transparent (prints well on white paper)
    toData() {
      if (this.empty) return '';
      const o = document.createElement('canvas'); o.width = this.cv.width; o.height = this.cv.height;
      const c = o.getContext('2d'); c.drawImage(this.cv, 0, 0);
      c.globalCompositeOperation = 'source-in'; c.fillStyle = '#0b2a6b'; c.fillRect(0, 0, o.width, o.height);
      return o.toDataURL('image/png');
    }
  };
  WP.sigHTML = (id, label) => `
    <div class="field"><label><i class="fa-solid fa-signature"></i> ${label}</label>
      <div class="sig-wrap" id="${id}"><canvas></canvas><div class="sig-line"></div>
        <div class="sig-ph"><span><i class="fa-solid fa-pen-nib"></i>เซ็นชื่อที่นี่ (ใช้เมาส์ / นิ้ว / ปากกา)</span></div>
        <button type="button" class="btn-icon sig-clear" title="ล้าง"><i class="fa-solid fa-eraser"></i></button>
      </div></div>`;

  // ---------- Checklist renderer ----------
  // opts.attach (request form only): an "แนบไฟล์" button + file list next to the items marked
  // "attach" in Data.gs (เอกสารรับรองที่เกี่ยวข้อง / อื่นๆ); request.js manages the files.
  WP.renderChecklist = (box, defs, types, values = {}, readonly = false, opts = {}) => {
    const ro = readonly ? 'disabled' : '';
    const att = it => opts.attach && it.attach && !readonly;
    const accept = (WP.data.config.itemFileExt || []).map(x => '.' + x).join(',');
    const attBtn = it => att(it) ? `<label class="btn sm ghost cl-att-btn" title="แนบไฟล์ PDF / รูปภาพ (ถ้ามี)"><input type="file" multiple hidden data-att="${it.id}" accept="${accept}"><i class="fa-solid fa-paperclip"></i> แนบไฟล์</label>` : '';
    const attList = it => att(it) ? `<ul class="cl-att-list" data-att-list="${it.id}"></ul>` : '';
    values = WP.upgradeChecklist(values);
    box._legacy = values._legacy || null;
    let html = '';
    WP.orderTypes(types).forEach((k, si) => {
      const d = defs[k]; if (!d) return;
      html += `<div class="cl-section" style="--wc:${d.color};animation-delay:${si * 90}ms" data-type="${k}">
        <div class="cl-head"><span class="wt-ic"><i class="fa-solid ${d.icon}"></i></span>
          <div><h3>${d.title || d.label}</h3>${d.note ? `<small>${d.note}</small>` : ''}</div>
          <span class="cl-prog"><i class="fa-solid fa-list-check"></i> <b class="cl-n">0</b>/<span class="cl-t">0</span></span></div>
        <div class="cl-body">`;
      d.items.forEach(it => {
        const v = values[it.id];
        if (it.type === 'group') { html += `<div class="cl-group">${it.label}${attBtn(it)}</div>` + (att(it) ? `<div class="full cl-att-row">${attList(it)}</div>` : ''); return; }
        if (it.type === 'check') {
          html += `<label class="ck ${readonly ? 'readonly' : ''}"><input type="checkbox" data-id="${it.id}" ${v ? 'checked' : ''} ${ro}><span class="box"><i class="fa-solid fa-check"></i></span><span class="lbl">${it.label}</span></label>`;
        } else if (it.type === 'choice') {
          html += `<div class="cl-choice ${it.other ? 'full' : ''}" data-choice="${it.id}"><span class="lbl">${it.label}</span>${it.other ? `<input class="input" data-id="${it.id}_t" data-kind="text" value="${WP.esc(values[it.id + '_t'] || '')}" ${ro} placeholder="ระบุ">` : ''}<span class="yn">` +
            it.opts.map((o, oi) => `<label class="${oi ? 'no' : 'yes'}"><input type="radio" name="ch_${it.id}" value="${o}" ${v === o ? 'checked' : ''} ${ro}><span>${o}</span></label>`).join('') + `</span></div>`;
        } else if (it.type === 'info') {
          html += `<div class="cl-info full"><div class="cl-group"><i class="fa-solid fa-truck-medical ic-bob"></i> ${it.label}</div><ol>${it.lines.map(l => `<li>${l}</li>`).join('')}</ol></div>`;
        } else if (it.type === 'text') {
          const inp = `<input class="input" data-id="${it.id}" data-kind="text" value="${WP.esc(v || '')}" ${ro} placeholder="ระบุ (ถ้ามี)">`;
          html += `<div class="cl-text ${it.half ? '' : 'full'}"><label>${it.label}</label>${att(it) ? `<div class="cl-inrow">${inp}${attBtn(it)}</div>${attList(it)}` : inp}</div>`;
        } else if (it.type === 'checktext') {
          const on = v && v.on, t = v && v.text || '';
          html += `<div class="full"><label class="ck ${readonly ? 'readonly' : ''}"><input type="checkbox" data-id="${it.id}" data-kind="ct" ${on ? 'checked' : ''} ${ro}><span class="box"><i class="fa-solid fa-check"></i></span><span class="lbl">${it.label}</span></label>
            <div class="cl-text" style="padding-left:48px">${att(it) ? '<div class="cl-inrow">' : ''}<input class="input" data-ct="${it.id}" value="${WP.esc(t)}" ${ro} placeholder="ระบุรายละเอียด (ถ้ามี)">${att(it) ? `${attBtn(it)}</div>${attList(it)}` : ''}</div></div>`;
        } else if (it.type === 'ppe') {
          const sel = (v && v.sel) || [], oth = (v && v.other) || '';
          html += `<div class="full"><div class="cl-group" style="padding-left:14px">${it.label}</div><div class="chips" data-ppe="${it.id}">` +
            it.options.map(o => `<label class="chip"><input type="checkbox" value="${o}" ${sel.includes(o) ? 'checked' : ''} ${ro}><span><i class="fa-solid fa-circle-check"></i>${o}</span></label>`).join('') +
            (it.noOther ? '' : `<input class="input" data-ppe-other="${it.id}" value="${WP.esc(oth)}" placeholder="Other (ระบุ)" ${ro}>`) + `</div></div>`;
        }
      });
      html += WP.legacyHTML(values, k) + `</div></div>`;
    });
    box.innerHTML = html || `<div class="empty"><i class="fa-solid fa-clipboard-question"></i>กรุณาเลือกลักษณะงานในขั้นตอนที่ 1 ก่อน</div>`;
    const upd = sec => {
      const all = $$('input[type=checkbox][data-id]', sec), ch = $$('[data-choice]', sec);
      const on = all.filter(c => c.checked).length + ch.filter(g => $('input:checked', g)).length;
      $('.cl-n', sec).textContent = on; $('.cl-t', sec).textContent = all.length + ch.length;
    };
    $$('.cl-section', box).forEach(sec => { upd(sec); sec.addEventListener('change', () => upd(sec)); });
  };
  WP.collectChecklist = box => {
    const out = { _v: WP.data.config.checklistVersion || 1 };
    if (box._legacy) out._legacy = box._legacy;
    $$('input[type=checkbox][data-id]', box).forEach(c => {
      if (c.dataset.kind === 'ct') out[c.dataset.id] = { on: c.checked, text: $(`[data-ct="${c.dataset.id}"]`, box).value.trim() };
      else out[c.dataset.id] = c.checked;
    });
    $$('input[data-kind=text]', box).forEach(i => out[i.dataset.id] = i.value.trim());
    $$('[data-ppe]', box).forEach(g => {
      out[g.dataset.ppe] = { sel: $$('input[type=checkbox]:checked', g).map(c => c.value), other: ($(`[data-ppe-other="${g.dataset.ppe}"]`, g)?.value || '').trim() };
    });
    $$('[data-choice]', box).forEach(g => { out[g.dataset.choice] = $('input[type=radio]:checked', g)?.value || ''; });
    return out;
  };

  // ---------- Confined space tables (FM-EMR-46 ข้อ 8–11) ----------
  WP.renderConfined = (box, d = {}, readonly = false, full = true) => {
    const ro = readonly ? 'disabled' : '', E = WP.esc;
    const gas = d.gas || [], en = d.entries || [], rn = d.renew || [], cl = d.close || {};
    const inp = (attrs, val, type = 'text', ph = '') => `<input class="input" ${attrs} type="${type}" value="${E(val || '')}" placeholder="${ph}" ${ro}>`;
    let h = `<h4 class="cs-h"><i class="fa-solid fa-wind ic-float"></i> 8. การตรวจวัดบรรยากาศในที่อับอากาศ (ก่อนเข้าและขณะปฏิบัติงาน) โดยผู้ช่วยเหลือ / จป.วิชาชีพ</h4>
      <div class="tbl-wrap"><table class="tbl" data-cs="gas"><thead><tr><th>บันทึกผลการวัดก๊าซ</th>${[1, 2, 3, 4, 5].map(n => `<th>ครั้งที่ ${n}</th>`).join('')}</tr></thead><tbody>` +
      [['o2', '% O2 โดยปริมาตร', 'number', '19.5–23.5'], ['lel', '% LEL', 'number', '< 10'], ['by', 'ชื่อผู้ตรวจ', 'text', ''], ['time', 'เวลา', 'time', '']].map(([f, l, t, ph]) =>
        `<tr><td class="nowrap">${l}</td>${[0, 1, 2, 3, 4].map(i => `<td>${inp(`data-i="${i}" data-f="${f}" step="0.1"`, (gas[i] || {})[f], t, ph)}</td>`).join('')}</tr>`).join('') +
      `</tbody></table></div><div class="hint mt1" id="gas-warn"></div>
      <h4 class="cs-h"><i class="fa-solid fa-door-open ic-wiggle"></i> 9. บันทึกเวลาเข้าและออก ของผู้ปฏิบัติงานในที่อับอากาศ</h4>
      <div class="tbl-wrap"><table class="tbl" data-cs="entries"><thead><tr><th>ชื่อ - สกุล</th>${[1, 2, 3, 4, 5].map(n => `<th>เข้า – ออก (${n})</th>`).join('')}</tr></thead><tbody>` +
      [0, 1, 2, 3, 4, 5].map(i => { const e = en[i] || {}, t = e.t || []; return `<tr data-i="${i}"><td style="min-width:170px">${inp('data-f="name"', e.name, 'text', 'ชื่อ - สกุล')}</td>` +
        [0, 1, 2, 3, 4].map(j => `<td><div class="io">${inp(`data-j="${j}" data-f="in"`, (t[j] || {}).in, 'time')}${inp(`data-j="${j}" data-f="out"`, (t[j] || {}).out, 'time')}</div></td>`).join('') + `</tr>`; }).join('') +
      `</tbody></table></div>`;
    if (full) {
      h += `<h4 class="cs-h"><i class="fa-solid fa-arrows-rotate ic-spin"></i> 10. การต่อใบอนุญาต (ต้องตรวจสอบก่อนให้ต่อใบอนุญาต)</h4>
        <div class="tbl-wrap"><table class="tbl" data-cs="renew"><thead><tr><th>ครั้งที่</th><th>เริ่มต้น (เวลา)</th><th>สิ้นสุด (เวลา)</th><th>ผู้อนุญาต</th></tr></thead><tbody>` +
        [0, 1, 2].map(i => `<tr><td>${i + 1}</td><td>${inp(`data-i="${i}" data-f="start"`, (rn[i] || {}).start, 'time')}</td><td>${inp(`data-i="${i}" data-f="end"`, (rn[i] || {}).end, 'time')}</td><td>${inp(`data-i="${i}" data-f="by"`, (rn[i] || {}).by, 'text', 'ชื่อผู้อนุญาต')}</td></tr>`).join('') +
        `</tbody></table></div><div class="hint mt1">− การต่อใบอนุญาต ต้องต่อโดยผู้ควบคุมงาน &nbsp; − เมื่อเกิดเหตุฉุกเฉินใบอนุญาตนี้ถูกยกเลิกโดยอัตโนมัติ</div>
        <h4 class="cs-h"><i class="fa-solid fa-lock ic-beat"></i> 11. การปิดใบอนุญาต</h4><div data-cs="close">` +
        Object.entries(WP.confinedClose).map(([k, l]) => `<label class="ck ${readonly ? 'readonly' : ''}"><input type="checkbox" data-k="${k}" ${cl[k] ? 'checked' : ''} ${ro}><span class="box"><i class="fa-solid fa-check"></i></span><span class="lbl">${l}</span></label>` +
          (k === 'cancel' ? `<div class="cl-text" style="padding-left:48px">${inp('data-k="reason"', cl.reason, 'text', 'ระบุเหตุผลที่ยกเลิก')}</div>` : '')).join('') + `</div>`;
    }
    box.innerHTML = h;
    const warn = () => {
      const bad = [];
      $$('[data-cs=gas] input[data-f=o2]', box).forEach((x, i) => { const v = parseFloat(x.value); const b = x.value !== '' && (v < 19.5 || v > 23.5); x.classList.toggle('invalid', b); if (b) bad.push(`ครั้งที่ ${i + 1}: O2 ${v}%`); });
      $$('[data-cs=gas] input[data-f=lel]', box).forEach((x, i) => { const v = parseFloat(x.value); const b = x.value !== '' && v >= 10; x.classList.toggle('invalid', b); if (b) bad.push(`ครั้งที่ ${i + 1}: LEL ${v}%`); });
      $('#gas-warn', box).innerHTML = bad.length ? `<span style="color:var(--red)"><i class="fa-solid fa-triangle-exclamation ic-flicker"></i> ค่าไม่อยู่ในเกณฑ์ปลอดภัย (O2 19.5–23.5%, LEL &lt; 10%) — ห้ามเข้าปฏิบัติงาน: ${bad.join(', ')}</span>` : '<i class="fa-solid fa-circle-info"></i> เกณฑ์ปลอดภัย: O2 19.5–23.5% และ LEL น้อยกว่า 10%';
    };
    box.addEventListener('input', warn); warn();
  };
  WP.collectConfined = box => {
    const o = { gas: [], entries: [], renew: [], close: {} };
    $$('[data-cs=gas] input', box).forEach(x => { (o.gas[x.dataset.i] ??= {})[x.dataset.f] = x.value.trim(); });
    $$('[data-cs=entries] tr[data-i]', box).forEach(tr => {
      const e = { name: $('[data-f=name]', tr).value.trim(), t: [] };
      $$('[data-j]', tr).forEach(x => { (e.t[x.dataset.j] ??= {})[x.dataset.f] = x.value; });
      o.entries.push(e);
    });
    $$('[data-cs=renew] input', box).forEach(x => { (o.renew[x.dataset.i] ??= {})[x.dataset.f] = x.value.trim(); });
    $$('[data-cs=close] input', box).forEach(x => { o.close[x.dataset.k] = x.type === 'checkbox' ? x.checked : x.value.trim(); });
    return o;
  };

  // ---------- LOTO table ----------
  WP.renderLoto = (box, rows = [], readonly = false) => {
    const ro = readonly ? 'disabled' : '';
    const r = Array.from({ length: 6 }, (_, i) => rows[i] || {});
    box.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>รายการที่ทำการตัดระบบ</th><th>เวลาที่ติดตั้ง</th><th>ลงชื่อ</th><th>เวลาที่ปลดล็อค</th><th>ลงชื่อ</th><th>หมายเหตุ</th></tr></thead><tbody>` +
      r.map((x, i) => `<tr><td>${i + 1}.</td>` + ['item', 't_on', 'by_on', 't_off', 'by_off', 'note'].map(f =>
        `<td><input class="input" data-loto="${i}" data-f="${f}" ${f.startsWith('t_') ? 'type="time"' : ''} value="${WP.esc(x[f] || '')}" ${ro}></td>`).join('') + `</tr>`).join('') +
      `</tbody></table></div>`;
  };
  WP.collectLoto = box => {
    const rows = [];
    $$('tbody tr', box).forEach((tr, i) => {
      const o = {}; $$('input', tr).forEach(inp => o[inp.dataset.f] = inp.value.trim());
      rows.push(o);
    });
    return rows;
  };

  // ---------- Admin: actions guarded by the reset password (edit / delete) ----------
  // The password (Script Property WP_RESET_PASSWORD) is asked once and kept in
  // memory for this page only; it is forgotten on a password error / lockout.
  let resetPw = null;
  WP.withResetPassword = async (action, data, title = 'ยืนยันด้วยรหัสผ่าน') => {
    let pw = resetPw;
    if (!pw) {
      const x = await Swal.fire({
        icon: 'warning', title, text: 'กรอกรหัสผ่านสำหรับแก้ไข / ลบข้อมูล (Reset password)',
        input: 'password', inputAttributes: { autocomplete: 'off', autocapitalize: 'off' },
        inputValidator: v => !v && 'กรุณากรอกรหัสผ่าน',
        showCancelButton: true, confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626'
      });
      if (!x.isConfirmed || !x.value) return null;
      pw = x.value;
    }
    Swal.fire({ title: 'กำลังบันทึก...', showConfirmButton: false, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const r = await WP.api(action, Object.assign({}, data, { resetPassword: pw }));
    // The server checks the password before validating anything else, so a
    // validation / not-found error still means the password was right.
    if (r.ok || ['BAD_REQUEST', 'TOO_LARGE', 'NOT_FOUND', 'CONFLICT'].includes(r.code)) resetPw = pw;
    else if (['AUTH_FAILED', 'LOCKED', 'SETUP'].includes(r.code)) resetPw = null;
    return r;
  };
  /** Confirm (naming the permit no), ask the reset password, delete. Resolves true when deleted. */
  WP.deletePermit = async (id, permitNo) => {
    const no = WP.esc(permitNo);
    const c = await Swal.fire({
      icon: 'warning', title: `ลบใบอนุญาต ${permitNo}?`,
      html: `ใบอนุญาตเลขที่ <b>${no}</b> พร้อมประวัติการดำเนินการ ลายเซ็น และไฟล์แนบ จะถูกลบ<br>ลิงก์ติดตามสถานะของใบนี้จะใช้ไม่ได้อีก<br><b style="color:#ef4444">ไม่สามารถกู้คืนได้</b>`,
      showCancelButton: true, focusCancel: true, confirmButtonText: '🗑 ลบ', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626'
    });
    if (!c.isConfirmed) return false;
    const r = await WP.withResetPassword('delete', { id }, `ยืนยันการลบ ${permitNo}`);
    if (!r) return false;
    if (!r.ok) { await Swal.fire({ icon: 'error', title: 'ลบไม่สำเร็จ', text: r.msg }); return false; }
    await Swal.fire({ icon: 'success', title: `ลบใบอนุญาต ${permitNo} แล้ว`, timer: 1300, showConfirmButton: false });
    return true;
  };

  // ---------- Admin: clock, sidebar, polling ----------
  const clk = $('#live-clock');
  if (clk) {
    const t = () => clk.innerHTML = '<i class="fa-regular fa-clock"></i> ' + new Date().toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'medium' });
    t(); setInterval(t, 1000);
  }
  $('#sidebar-toggle')?.addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  // ---------- Logout (replaces logout.php) ----------
  $$('[data-logout]').forEach(a => a.addEventListener('click', async e => {
    e.preventDefault();
    await WP.api('logout');
    WP.clearSession();
    location.href = WP.base + '/login.html';
  }));

  // ---------- approvers (ผู้รับผิดชอบงาน / เจ้าของพื้นที่): "รออนุมัติของฉัน" count + toasts ----------
  // Non-จป. users poll action=my_tasks (their own stages only); a จป. who also holds an
  // approver role gets the count once per page (their bell stays the จป. poll below).
  if (WP.session && $('#bell') && !WP.isSafety()) {
    let known = null, authWarned = false;
    const setMine = n => {
      ['#bell-count', '#nav-mine'].forEach(s => { const e = $(s); if (e) { e.textContent = n; e.classList.toggle('zero', !n); } });
      $('#bell').classList.toggle('has', n > 0);
      document.title = (n ? `(${n}) ` : '') + document.title.replace(/^\(\d+\)\s/, '');
    };
    const last = WP.cacheGet('mine', {});
    if (typeof last === 'number') setMine(last);
    const pollMine = async () => {
      try {
        const j = await WP.read('my_tasks', {}, { quiet: true });
        if (!j.ok) {
          if (j.code === 'AUTH' && !authWarned) { authWarned = true; WP.toast('Session หมดอายุ', 'เข้าสู่ระบบใหม่ในแท็บใหม่ — ข้อมูลที่กรอกในหน้านี้ยังอยู่', null, 'fa-user-lock'); }
          return;
        }
        authWarned = false;
        const ids = j.data.pending.map(p => p.id);
        setMine(j.data.count);
        WP.cachePut('mine', {}, j.data.count);
        if (known) {
          const fresh = j.data.pending.filter(p => !known.has(p.id));
          if (fresh.length) {
            WP.chime();
            fresh.forEach(p => WP.toast('รออนุมัติ: ' + p.permit_no, `${(WP.data.stages[p.stage] || {}).label || ''} · ${p.location}`, `${WP.base}/admin/view.html?id=${p.id}`, 'fa-inbox'));
            document.dispatchEvent(new CustomEvent('wp:mine', { detail: fresh }));
          }
        }
        known = new Set(ids);
      } catch { }
    };
    pollMine(); setInterval(pollMine, 15000);
  } else if (WP.session && $('#nav-mine')) {
    WP.read('my_tasks', {}, { quiet: true }).then(j => {
      const e = $('#nav-mine'); if (!j.ok || !e) return;
      e.textContent = j.data.count; e.classList.toggle('zero', !j.data.count);
    });
  }

  if (WP.session && $('#bell') && WP.isSafety()) {
    let lastId = null;
    const setCount = n => {
      ['#bell-count', '#nav-pending'].forEach(s => { const e = $(s); if (e) { e.textContent = n; e.classList.toggle('zero', !n); } });
      $('#bell').classList.toggle('has', n > 0);
      document.title = (n ? `(${n}) ` : '') + document.title.replace(/^\(\d+\)\s/, '');
    };
    // last count seen in this tab: shown at once; the first poll (batched with the page's data) refreshes it
    const known = WP.cacheGet('pending', {});
    if (typeof known === 'number') setCount(known);
    let authWarned = false;
    const poll = async () => {
      try {
        // quiet: an expired session must not navigate away from a half-filled review / approval
        const j = await WP.read('poll', lastId !== null ? { since: lastId } : {}, { quiet: true });
        if (!j.ok) {
          if (j.code === 'AUTH' && !authWarned) {
            authWarned = true;
            WP.toast('Session หมดอายุ', 'เข้าสู่ระบบใหม่ในแท็บใหม่ — ข้อมูลที่กรอกในหน้านี้ยังอยู่', null, 'fa-user-lock');
          }
          return;
        }
        authWarned = false;
        const r = j.data;
        setCount(r.pending);
        WP.cachePut('pending', {}, r.pending);
        if (lastId !== null && r.new && r.new.length) {
          WP.chime();
          r.new.forEach(p => WP.toast('มีใบขออนุญาตใหม่! ' + p.permit_no, `${p.requester_name} · ${p.location}`, `${WP.base}/admin/view.html?id=${p.id}`));
          document.dispatchEvent(new CustomEvent('wp:new', { detail: r.new }));
        }
        lastId = r.max_id;
      } catch { }
    };
    poll(); setInterval(poll, 15000);
  }
})();
