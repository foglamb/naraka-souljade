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
    function schedule(allowed) {
      if (disposed) return;
      const ticket = ++revision;
      latest = null;
      if (timer !== null) cancel(timer);
      if (options.onPending) options.onPending();
      const choices = allowed.slice();
      timer = later(async () => {
        timer = null;
        const config = EXT.clone(options.getConfig());
        const input = JSON.stringify(config);
        try {
          const result = await options.solve(config, { allowedAffixes: choices });
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
    let selected;
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (stored && Array.isArray(stored.selected)) selected = stored.selected.filter(id => validIds.includes(id));
    } catch (e) { /* use defaults when storage is unavailable */ }
    if (!selected) selected = EXT.candidateAffixes(H.state.params, null, 'dps').filter(id => validIds.includes(id));
    const checked = new Set(selected);

    panel.innerHTML = `
      <p class="auto-help">勾选可用的普通词条，自动计算搭配。魂玉、染色和稀有词条原样保留。</p>
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
      <p class="auto-rule">只使用勾选词条；同一颗玉普通词条不重复。候选不足时留空，不增加稀有词条。</p>
      <div class="auto-rares" id="autoRareSummary"></div>
      <div class="auto-result" aria-live="polite" aria-atomic="true">
        <p id="autoStatus">正在读取当前配装…</p>
        <div id="autoMetrics"></div>
      </div>
      <button class="btn btn-primary auto-apply" type="button" id="autoApply" disabled>应用方案</button>
      <div class="auto-plan" id="autoPlan"></div>`;

    const status = $('#autoStatus'), metrics = $('#autoMetrics'), apply = $('#autoApply');
    function showRareSummary() {
      const counts = { hedao: 0, huaqi: 0, meibu: 0 };
      H.state.slots.filter(Boolean).forEach(slot => (slot.subs || []).forEach(id => {
        if (Object.prototype.hasOwnProperty.call(counts, id)) counts[id]++;
      }));
      $('#autoRareSummary').textContent = '稀有词条锁定：' + H.RARES.map(r => `${r.name} ×${counts[r.id] || 0}`).join(' · ');
    }
    function emptyResult() {
      metrics.textContent = '';
      $('#autoPlan').textContent = '';
      apply.disabled = true;
    }
    let applied = false;
    const analyzer = createAnalyzer({
      getConfig: EXT.currentConfig,
      solve: (config, options) => EXT.solveLocked(config, options),
      onPending() {
        status.textContent = '正在自动分析…';
        emptyResult();
        showRareSummary();
      },
      onResult(result) {
        const n = result.slots.filter(Boolean).length;
        if (!n) { status.textContent = '先在左侧选择魂玉，再勾选词条。'; emptyResult(); return; }
        const before = result.before.value, after = result.after.value;
        const gain = before > 0 ? (after / before - 1) * 100 : 0;
        status.textContent = `已自动分析 · ${n} 颗魂玉不变 · ${result.stats.elapsedMs}ms`;
        metrics.innerHTML = `<div class="auto-score"><span>当前 ${EXT.num(before)}/秒</span>
          <strong>${EXT.num(after)}<small>/秒</small></strong>
          <span class="${gain < 0 ? 'down' : 'up'}">${gain >= 0 ? '+' : ''}${EXT.round1(gain)}%</span></div>
          <p class="auto-rule">按满值估算的候选方案，点击应用才修改配装。</p>`;
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
        // 动态预览不进入历史；只有严格更高的结果写最高记录，沿用用户锁定/关闭开关。
        if (EXT.store) EXT.store.maybeUpdateBest(EXT.store.makeRecord(
          { params: result.params, slots: result.slots }, { source: 'auto-analysis', label: '勾选词条分析方案' }));
      },
      onError(error) { status.textContent = error.message || String(error); emptyResult(); },
    });
    let inputKey = '';
    function scheduleIfChanged(force) {
      const key = JSON.stringify([EXT.currentConfig(), [...checked].sort()]);
      if (!force && key === inputKey) return;
      inputKey = key;
      analyzer.schedule([...checked]);
    }
    function saveSelection() {
      try { localStorage.setItem(KEY, JSON.stringify({ selected: [...checked] })); } catch (e) { /* session still works */ }
      applied = false;
      panel.querySelectorAll('[data-auto-affix]').forEach(input => { input.checked = checked.has(input.dataset.autoAffix); });
      scheduleIfChanged(true);
    }
    panel.addEventListener('change', event => {
      const id = event.target && event.target.dataset.autoAffix;
      if (!id || !validIds.includes(id)) return;
      event.target.checked ? checked.add(id) : checked.delete(id);
      saveSelection();
    });
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
      const checks = EXT.verifyLocked(EXT.normalizeConfig(EXT.currentConfig()).slots, result.slots, [...checked]);
      if (!checks.ok) { status.textContent = '当前配装已变化，正在重新分析'; scheduleIfChanged(true); return; }
      EXT.applyConfig(config);
      if (EXT.store) EXT.store.capture(config, { source: 'applied-analysis' });
      applied = true;
      if (EXT.ui) EXT.ui.renderAll();
      scheduleIfChanged(true);
    });
    // 只观察输入派生的 DOM：避免常驻轮询，也不因自身渲染重复计算。
    if (global.MutationObserver) {
      const observer = new global.MutationObserver(() => scheduleIfChanged(false));
      ['#slots', '#dmgTotal'].forEach(selector => {
        const target = $(selector);
        if (target) observer.observe(target, { childList: true, subtree: true, characterData: true });
      });
    }
    EXT.autoAnalysis = {
      schedule: () => scheduleIfChanged(true), getLatest: analyzer.getLatest,
      getAllowed: () => [...checked], dispose: analyzer.dispose,
    };
    scheduleIfChanged(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
