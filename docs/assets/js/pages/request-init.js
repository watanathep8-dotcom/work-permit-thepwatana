// request.php — server-rendered lists now rendered from WP_DATA (runs before request.js)
(() => {
  if (WP.halt) return;
  const { $ } = WP, D = WP.data, E = WP.esc;
  $('#company-seg').innerHTML = D.companies.map((c, i) =>
    `<label><input type="radio" name="company" value="${E(c)}" ${i === 0 ? 'checked' : ''}><span><i class="fa-solid fa-building-flag"></i>${E(c)}</span></label>`).join('');
  $('#wt-grid').innerHTML = Object.entries(D.workTypes).map(([k, w]) => `
          <label class="wt" style="--wc:${w.color}">
            <input type="checkbox" name="work_types" value="${k}">
            <div class="wt-box">
              <span class="wt-check"><i class="fa-solid fa-check"></i></span>
              <span class="wt-ic"><i class="fa-solid ${w.icon}"></i></span>
              <span class="wt-name">${E(w.label)}</span>
            </div>
          </label>`).join('');
  const today = WP.todayBkk();
  const wd = $('input[name=work_date]');
  wd.value = today;
  if (!WP.editMode) wd.min = today; // the จป. may correct past permits (request.html?edit=<id>)
  const li = arr => arr.map(r => `<li>${E(r)}</li>`).join('');
  $('#rules').innerHTML = li(D.safetyRules);
  $('#agreement').innerHTML = li(D.safetyAgreement);
  $('#waste-title').textContent = D.wasteRules.title;
  $('#waste').innerHTML = li(D.wasteRules.items);
  $('#agree-text').textContent = D.agreementAck;
  $('#review-note').textContent = D.reviewNote;
  $('#max-mb').textContent = D.config.uploadMaxMb;
  $('#total-mb').textContent = D.config.requestMaxMb;

  // ผู้รับผิดชอบงาน (approval workflow): public list of id + name. Empty list = no
  // responsible accounts yet → the request goes straight to the จป. (field stays hidden).
  WP.respReady = WP.editMode ? Promise.resolve([]) : WP.get('responsibles').then(r => {
    const list = r.ok && Array.isArray(r.data) ? r.data : [];
    const sel = $('#responsible_id'), f = $('#resp-field');
    if (list.length) {
      sel.innerHTML = '<option value="">— เลือกผู้รับผิดชอบงาน —</option>' + list.map(x => `<option value="${+x.id}">${E(x.name)}</option>`).join('');
      sel.required = true;
      f.classList.remove('hide');
    }
    WP.respList = list;
    return list;
  });
  $('#attach').accept = D.config.uploadExt.map(x => '.' + x).join(',');
})();
