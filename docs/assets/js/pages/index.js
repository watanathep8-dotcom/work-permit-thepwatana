// index.php — hero counters + data-driven sections
(() => {
  const { $ } = WP, D = WP.data, E = WP.esc;
  const WT = D.workTypes;

  $('#form-code').textContent = D.config.formCode;
  const scan = $('#hero-visual .hv-scan');
  Object.values(WT).forEach(w => {
    const o = document.createElement('div');
    o.className = 'hv-orb'; o.title = w.short; o.style.color = w.color;
    o.innerHTML = `<i class="fa-solid ${w.icon}"></i>`;
    scan.parentNode.insertBefore(o, scan);
  });

  $('#wt-features').innerHTML = Object.values(WT).map(w => {
    const n = w.items.filter(i => !['group', 'info'].includes(i.type)).length;
    return `<div class="card feature glow-border hover-lift reveal" style="--wc:${w.color}" data-tilt>
      <div class="f-ic" style="color:${w.color}"><i class="fa-solid ${w.icon} ic-float"></i></div>
      <h3>${E(w.label)}</h3>
      <p>${n} หัวข้อตรวจสอบความปลอดภัย${w.loto ? ' + ตาราง Lock Out / Tag Out' : ''}${w.confined ? ' + ตรวจวัดก๊าซ / บันทึกเวลาเข้า-ออก (' + E(w.form) + ')' : ''}</p>
    </div>`;
  }).join('');
  $('#remarks').innerHTML = D.remarks.map(r => `<li>${E(r)}</li>`).join('');
  WP.reveal(); WP.tilt();

  // Public aggregate counters: painted at once from this tab's last copy (if any),
  // then counted on to the server's numbers when they differ.
  let last = null;
  WP.swr('stats', {}, r => {
    if (!r.ok) return;
    ['total', 'approved', 'pending', 'today'].forEach(k => WP.countUp($('#st-' + k), +r.data[k] || 0, last ? 900 : 1400, last ? +last[k] || 0 : 0));
    last = r.data;
  }, { anon: true, fetch: () => WP.get('stats') });
})();
