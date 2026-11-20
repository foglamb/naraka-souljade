/* 勾选普通词条后自动分析。预览保存在内存；只有应用才改工作区/历史。
 * 每次变化防抖、撤销旧预览；结果返回时再核对输入，避免旧计算覆盖新勾选。
 */
(function (global) {
  'use strict';
  const EXT = global.NSJExt;
  const KEY = 'naraka-souljade-analysis-options-v1';
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 纯控制器支持注入数据源/调度器，测试不启动浏览器。
  function createAnalyzer(options) {
    let revision = 0, timer = null, disposed = false, latest = null;
    const later = options.setTimeout || global.setTimeout.bind(global);
    const cancel = options.clearTimeout || global.clearTimeout.bind(global);
    function schedule(allowed, analysisOptions) {
      if (disposed) return;
      const ticket = ++revision;
      latest = null;
      if (timer !== null) cancel(timer);
      if (options.onPending) options.onPending();
      const choices = allowed.slice();
      const solverOptions = EXT.clone(analysisOptions || {});
      timer = later(async () => {
        timer = null;
        const config = EXT.clone(options.getConfig());
        const input = JSON.stringify(config);
        try {
          const result = await options.solve(config, {
            ...solverOptions, allowedAffixes: choices,
            isCancelled: () => disposed || ticket !== revision,
          });
          if (disposed || ticket !== revision || JSON.stringify(options.getConfig()) !== input) return;
          latest = { result, input, allowed: choices };
          options.onResult(result);
        } catch (error) {
          if (!disposed && ticket === revision && options.onError) options.onError(error);
        }
      }, options.delay == null ? 180 : options.delay);
    }
    return {
      schedule,
      getLatest() {
        if (!latest || JSON.stringify(options.getConfig()) !== latest.input) return null;
        return latest.result;
      },
      dispose() {
        disposed = true;
        revision++;
        if (timer !== null) cancel(timer);
        latest = null;
      },
    };
  }
  EXT.createAutoAnalyzer = createAnalyzer;

  function boot() {
    const panel = $('#drawerAnalysis');
    if (!panel || panel.dataset.ready) return;
    panel.dataset.ready = 'true';
    const H = EXT.host();
    const validIds = H.AFFIXES.map(affix => affix.id);
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* use defaults */ }
    const selected = stored && Array.isArray(stored.selected)
      ? stored.selected.filter(id => validIds.includes(id))
      : EXT.candidateAffixes(H.state.params, null, 'dps').filter(id => validIds.includes(id));
    const checked = new Set(selected);
    let rarePrefs = null; // null means follow the current build until the user edits counts.
    if (stored && stored.rares && typeof stored.rares === 'object') {
      rarePrefs = Object.fromEntries(H.RARES.map(rare => {
        const pref = stored.rares[rare.id];
        return [rare.id, { enabled: !!(pref && pref.enabled), count: pref && Number.isFinite(pref.count) ? pref.count : 0 }];
      }));
    }
    const sourceCounts = () => EXT.countRares(H.state.slots);
    function getRareCounts() {
      if (!rarePrefs) return sourceCounts();
      const result = {};
      H.RARES.forEach(rare => {
        const pref = rarePrefs[rare.id];
        result[rare.id] = pref && pref.enabled ? Number(pref.count) : 0;
      });
      return result;
    }
    function makeEditable() {
      if (!rarePrefs) {
        const counts = sourceCounts();
        rarePrefs = Object.fromEntries(H.RARES.map(r => [r.id, { enabled: counts[r.id] > 0, count: counts[r.id] }]));
      }
    }

    panel.innerHTML = `
      <p class="auto-help">勾选普通词条，设置稀有词条总数，自动分析当前魂玉的搭配。魂玉数量与染色保持不变。</p>
      <fieldset class="auto-rare-fieldset">
        <legend>稀有词条 · 全部魂玉合计条数</legend>
        ${H.RARES.map(rare => `<div class="auto-rare-row">
          <label><input type="checkbox" data-auto-rare="${rare.id}"><span>${escapeHtml(rare.name)}</span></label>
          <div class="auto-stepper">
            <button type="button" data-rare-step="-1" data-rare-id="${rare.id}" aria-label="减少${rare.name}数量">−</button>
            <input type="number" min="0" step="1" inputmode="numeric" pattern="[0-9]*" value="0"
              data-rare-count="${rare.id}" aria-label="${rare.name}总条数">
            <button type="button" data-rare-step="1" data-rare-id="${rare.id}" aria-label="增加${rare.name}数量">+</button>
          </div></div>`).join('')}
        <button class="nsjx-mini" type="button" id="autoUseCurrentRares">读取当前配装的稀有数量</button>
      </fieldset>
      <div class="auto-rares" id="autoRareSummary"></div>
      <p class="auto-rule">数量是精确值，系统会分配到已选魂玉，每颗最多 4 格。未勾选的稀有词条为 0 条。</p>
      <fieldset class="auto-affixes">
        <legend>允许使用的普通词条</legend>
        ${H.AFFIXES.map(affix => `<label class="auto-choice">
          <input type="checkbox" data-auto-affix="${affix.id}" ${checked.has(affix.id) ? 'checked' : ''}>
          <span>${escapeHtml(affix.name)}<small>满值 ${affix.value}%</small></span>
        </label>`).join('')}
      </fieldset>
      <div class="auto-tools"><button class="nsjx-mini" type="button" id="autoAll">全选</button>
        <button class="nsjx-mini" type="button" id="autoRecommended">本系推荐</button>
        <button class="nsjx-mini" type="button" id="autoNone">清空勾选</button></div>
      <p class="auto-rule">普通词条只从勾选项中挑选，同玉不重复；勾选不足时留空。</p>
      <div class="auto-result" aria-live="polite" aria-atomic="true">
        <p id="autoStatus">正在读取当前配装…</p><div id="autoMetrics"></div>
      </div>
      <button class="btn btn-primary auto-apply" type="button" id="autoApply" disabled>应用方案</button>
      <div class="auto-plan" id="autoPlan"></div>`;

    const status = $('#autoStatus'), metrics = $('#autoMetrics'), apply = $('#autoApply');
    function syncControls() {
      const counts = getRareCounts(), capacity = H.state.slots.filter(Boolean).length * 4;
      H.RARES.forEach(rare => {
        const pref = rarePrefs ? rarePrefs[rare.id] : { enabled: counts[rare.id] > 0, count: counts[rare.id] };
        const enabled = !!(pref && pref.enabled);
        const toggle = panel.querySelector(`[data-auto-rare="${rare.id}"]`);
        const number = panel.querySelector(`[data-rare-count="${rare.id}"]`);
        toggle.checked = enabled;
        number.value = String(pref && pref.count !== undefined ? pref.count : 0);
        number.disabled = !enabled;
        number.max = String(capacity);
        panel.querySelectorAll(`[data-rare-id="${rare.id}"]`).forEach(button => {
          button.disabled = !enabled || (button.dataset.rareStep === '-1' && Number(number.value) <= 0);
        });
      });
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      $('#autoRareSummary').textContent = '指定稀有：' + H.RARES.map(r => `${r.name} ×${counts[r.id]}`).join(' · ') +
        `（${total} / ${capacity} 格）`;
      panel.querySelectorAll('[data-auto-affix]').forEach(input => {
        input.checked = checked.has(input.dataset.autoAffix);
        input.parentElement.classList.toggle('is-checked', input.checked);
      });
    }
    function emptyResult() {
      metrics.textContent = ''; $('#autoPlan').textContent = ''; apply.disabled = true;
    }
    let applied = false;
    const analyzer = createAnalyzer({
      getConfig: EXT.currentConfig,
      solve: (config, options) => EXT.solveRareCounts(config, options),
      onPending() { status.textContent = '正在自动分析…'; emptyResult(); syncControls(); },
      onResult(result) {
        const n = result.slots.filter(Boolean).length;
        if (!n) { status.textContent = '先选择魂玉，再勾选词条并设置数量。'; emptyResult(); return; }
        const before = result.before.value, after = result.after.value;
        const gain = before > 0 ? (after / before - 1) * 100 : 0;
        status.textContent = `已自动分析 · ${n} 颗魂玉不变 · 稀有数量校验通过`;
        metrics.innerHTML = `<div class="auto-score"><span>当前 ${EXT.num(before)}/秒</span>
          <strong>${EXT.num(after)}<small>/秒</small></strong>
          <span class="${gain < 0 ? 'down' : 'up'}">${gain >= 0 ? '+' : ''}${EXT.round1(gain)}%</span></div>
          <p class="auto-rule">普通与新增稀有按满值估算，旧稀有实填值随词条移动。点击应用才修改配装。${result.stats.limited ? '已在计算预算内给出候选方案。' : ''}</p>`;
        const changed = JSON.stringify(result.slots) !== JSON.stringify(H.state.slots);
        apply.disabled = !changed;
        apply.textContent = changed ? '应用方案' : (applied ? '方案已应用' : '当前已符合此方案');
        $('#autoPlan').innerHTML = result.slots.map((slot, index) => {
          if (!slot) return '';
          const words = slot.subs.map(id => {
            const word = H.AFFIXES.find(a => a.id === id) || H.RARES.find(r => r.id === id);
            return word ? word.name : '空';
          });
          return `<div class="auto-plan-row"><b>${index + 1}. ${escapeHtml(EXT.jadeName(slot.jadeId))}</b>
            <span>${words.map(escapeHtml).join(' / ')}</span></div>`;
        }).join('');
        if (EXT.store) EXT.store.maybeUpdateBest(EXT.store.makeRecord(
          { params: result.params, slots: result.slots }, { source: 'auto-analysis', label: '勾选词条分析方案' }));
      },
      onError(error) { status.textContent = error.message || String(error); emptyResult(); },
    });
    let inputKey = '';
    function scheduleIfChanged(force) {
      const rareCounts = getRareCounts();
      const key = JSON.stringify([EXT.currentConfig(), [...checked].sort(), rareCounts]);
      if (!force && key === inputKey) return;
      inputKey = key;
      analyzer.schedule([...checked], { rareCounts });
    }
    function saveSelection() {
      try { localStorage.setItem(KEY, JSON.stringify({ selected: [...checked], rares: rarePrefs })); } catch (e) { /* session still works */ }
      applied = false;
      scheduleIfChanged(true);
    }
    panel.addEventListener('change', event => {
      const input = event.target;
      const id = input && input.dataset.autoAffix;
      if (id && validIds.includes(id)) {
        input.checked ? checked.add(id) : checked.delete(id);
        saveSelection();
      }
      const rare = input && input.dataset.autoRare;
      if (rare && H.RARES.some(r => r.id === rare)) {
        makeEditable();
        rarePrefs[rare].enabled = input.checked;
        if (input.checked && !Number(rarePrefs[rare].count)) rarePrefs[rare].count = 1;
        saveSelection();
      }
    });
    panel.addEventListener('input', event => {
      const id = event.target && event.target.dataset.rareCount;
      if (!id || !H.RARES.some(r => r.id === id)) return;
      makeEditable(); rarePrefs[id].count = Number(event.target.value); saveSelection();
    });
    panel.querySelectorAll('[data-rare-step]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.rareId;
      makeEditable();
      rarePrefs[id].count = Math.max(0, Number(rarePrefs[id].count || 0) + Number(button.dataset.rareStep));
      saveSelection();
    }));
    $('#autoUseCurrentRares').addEventListener('click', () => { rarePrefs = null; saveSelection(); });
    $('#autoAll').addEventListener('click', () => { validIds.forEach(id => checked.add(id)); saveSelection(); });
    $('#autoNone').addEventListener('click', () => { checked.clear(); saveSelection(); });
    $('#autoRecommended').addEventListener('click', () => {
      checked.clear();
      EXT.candidateAffixes(H.state.params, null, 'dps').filter(id => validIds.includes(id)).forEach(id => checked.add(id));
      saveSelection();
    });
    apply.addEventListener('click', () => {
      const result = analyzer.getLatest();
      if (!result) { scheduleIfChanged(true); return; }
      const config = { params: result.params, slots: result.slots };
      const checks = EXT.verifyRareCounts(EXT.normalizeConfig(EXT.currentConfig()).slots, result.slots, [...checked], getRareCounts());
      if (!checks.ok) { status.textContent = '当前配装已变化，正在重新分析'; scheduleIfChanged(true); return; }
      EXT.applyConfig(config);
      if (EXT.store) EXT.store.capture(config, { source: 'applied-analysis' });
      applied = true;
      if (EXT.ui) EXT.ui.renderAll();
      scheduleIfChanged(true);
    });
    if (global.MutationObserver) {
      const observer = new global.MutationObserver(() => scheduleIfChanged(false));
      ['#slots', '#dmgTotal'].forEach(selector => {
        const target = $(selector);
        if (target) observer.observe(target, { childList: true, subtree: true, characterData: true });
      });
    }
    EXT.autoAnalysis = {
      schedule: () => scheduleIfChanged(true), getLatest: analyzer.getLatest,
      getAllowed: () => [...checked], getRareCounts, dispose: analyzer.dispose,
    };
    scheduleIfChanged(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
