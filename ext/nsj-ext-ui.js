/* =========================================================================
 * 永劫无间 · 征神之路 魂玉配装工具 —— 二改扩展 · 界面层
 * -------------------------------------------------------------------------
 * 新增一块「对比 / 自动最优」面板，接在原有三栏下面，不改动原有面板。
 *
 * 功能：
 *   · 历史快照（自动记录前面每次改动）+ 手动存点
 *   · 自动最高配置（全历史最高分，锁定 / 解锁 / 一键载入）
 *   · 动态对比（A/B 临时比较，不落盘）
 *   · 结构化差异（魂玉增减换位 / 染元素 / 词条位 / 词条数值 / 参数）
 *   · 一键求最优（多口径扫 + Top 榜单，逐条可载入）
 * ========================================================================= */
(function (global) {
  'use strict';

  const EXT = global.NSJExt;
  if (!EXT) throw new Error('[NSJExt.ui] 需要先加载 nsj-ext-core.js');

  const N = () => EXT.host();
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = v => EXT.num(v);
  const pctStr = v => (v > 0 ? '+' : '') + EXT.round1(v) + '%';

  const S = {};   // 本地 UI 状态

  /* ------------------------------------------------------------------ *
   * 自动抓拍：钩住 app.js 的 save() 写盘动作 + 签名轮询兜底
   * ------------------------------------------------------------------ */
  const APP_KEY = 'naraka-souljade-v1';
  let captureTimer = null;
  let lastAppliedSig = null;

  function scheduleCapture(delay) {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(doCapture, delay == null ? 220 : delay);
  }

  function doCapture() {
    if (!EXT.ready()) return;
    if (S.suspendCapture) return;
    const cfg = EXT.currentConfig();
    const r = EXT.store.capture(cfg, { source: 'auto' });
    if (r.added) {
      renderHistory();
      renderBest();
      renderHeadStats();
    } else if (r.record) {
      renderHistory();
    }
  }

  function hookStorage() {
    try {
      const raw = global.localStorage;
      if (!raw || raw.__nsjExtHooked) return;
      const orig = raw.setItem.bind(raw);
      raw.setItem = function (key, value) {
        const ret = orig(key, value);
        if (key === APP_KEY) scheduleCapture(180);
        return ret;
      };
      raw.__nsjExtHooked = true;
    } catch (e) { /* 隐私模式下不钩 */ }
  }

  function startAutoCapture() {
    hookStorage();
    /* 兜底：签名轮询。比监听更可靠（覆盖所有改法），代价是一次字符串比较 */
    setInterval(() => {
      if (!EXT.ready() || S.suspendCapture) return;
      const sig = EXT.signature(EXT.currentConfig());
      if (sig !== lastAppliedSig && sig !== EXT.store.lastSignature) {
        lastAppliedSig = sig;
        scheduleCapture(60);
      }
    }, 700);
    /* 首屏：把当前工作区状态记一条，保证历史里至少有个起点 */
    setTimeout(doCapture, 400);
  }

  /* ------------------------------------------------------------------ *
   * 顶部指标条
   * ------------------------------------------------------------------ */
  function renderHeadStats() {
    if (!EXT.ready()) return;
    const m = EXT.metricsOf(EXT.currentConfig());
    const best = EXT.store.best;
    const $cur = $('#extCurDps');
    const $best = $('#extBestDps');
    const $idx = $('#extCurIndex');
    const $cnt = $('#extHistCount');
    if ($cur) $cur.textContent = fmt(m.dps);
    if ($idx) $idx.textContent = m.index.toFixed(1);
    if ($cnt) $cnt.textContent = String(EXT.store.history.length);
    if ($best) {
      if (best) {
        const gain = m.dps > 0 ? ((best.metrics.dps - m.dps) / m.dps) * 100 : 0;
        $best.innerHTML = `${fmt(best.metrics.dps)}<small>${gain > 0.05
          ? `　领先当前 ${pctStr(gain)}` : '　当前已是最优'}</small>`;
      } else {
        $best.innerHTML = '—<small>还没有记录</small>';
      }
    }
    const badge = $('#tabExtBadge');
    if (badge) badge.textContent = String(EXT.store.history.length);
  }

  /* ------------------------------------------------------------------ *
   * 历史快照列表
   * ------------------------------------------------------------------ */
  function recordChip(r) {
    const el = EXT.ELEMENT_NAMES[(r.config.params || {}).element] || '';
    const wp = EXT.WEAPON_NAMES[(r.config.params || {}).weapon] || '';
    return `<span class="nsjx-chip el-${esc((r.config.params || {}).element || 'none')}">${esc(el)}</span>` +
      `<span class="nsjx-chip">${esc(wp)}</span>` +
      `<span class="nsjx-chip">${r.metrics.jadeCount}玉</span>`;
  }

  function renderHistory() {
    const box = $('#extHistory');
    if (!box) return;
    const list = EXT.store.history;
    if (!list.length) {
      box.innerHTML = '<div class="nsjx-empty">还没有快照。改一下配装就会自动记录下来。</div>';
      return;
    }
    const bestId = EXT.store.best && EXT.store.best.sig;
    box.innerHTML = list.map((r, i) => {
      const isBest = bestId && r.sig === bestId;
      const diff = S.compareA && S.compareA.sig === r.sig ? ' active' : '';
      return `<div class="nsjx-hist${isBest ? ' is-best' : ''}${diff}" data-hist="${esc(r.id)}">
        <div class="nsjx-hist-main">
          <div class="nsjx-hist-top">
            <b>#${list.length - i}</b>
            ${isBest ? '<span class="nsjx-tag best">最高</span>' : ''}
            ${r.source === 'manual' ? '<span class="nsjx-tag">手动</span>' : ''}
            <span class="nsjx-hist-time">${EXT.fmtTime(r.ts)}</span>
          </div>
          <div class="nsjx-hist-sub">${recordChip(r)}</div>
          <div class="nsjx-hist-jades">${(r.metrics.equipped || []).map(id => esc(EXT.jadeName(id))).join('、') || '空配装'}</div>
        </div>
        <div class="nsjx-hist-side">
          <span class="nsjx-hist-dps">${fmt(r.metrics.dps)}<small>/s</small></span>
          <div class="nsjx-hist-btns">
            <button type="button" class="nsjx-mini" data-compare="${esc(r.id)}" title="作为对比 A">对比</button>
            <button type="button" class="nsjx-mini" data-load="${esc(r.id)}" title="载入这套配装">载入</button>
            <button type="button" class="nsjx-mini danger" data-del="${esc(r.id)}" title="删除这条快照">✕</button>
          </div>
        </div>
      </div>`;
    }).join('');

    $$('#extHistory [data-compare]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      pickCompareA(b.dataset.compare);
    }));
    $$('#extHistory [data-load]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const r = EXT.store.history.find(x => x.id === b.dataset.load);
      if (!r) return;
      loadRecord(r, '已载入该快照');
    }));
    $$('#extHistory [data-del]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      EXT.store.removeHistory(b.dataset.del);
      renderHistory(); renderHeadStats();
      toast('已删除快照');
    }));
    $$('#extHistory .nsjx-hist').forEach(row => row.addEventListener('click', () => {
      const r = EXT.store.history.find(x => x.id === row.dataset.hist);
      if (r) showDetail(r);
    }));
  }

  /* ------------------------------------------------------------------ *
   * 最高配置卡片
   * ------------------------------------------------------------------ */
  function renderBest() {
    const box = $('#extBest');
    if (!box) return;
    const b = EXT.store.best;
    const locked = EXT.store.meta.bestLocked;
    const auto = EXT.store.meta.autoBest;
    if (!b) {
      box.innerHTML = `<div class="nsjx-empty">还没有最高记录。点「求最优」或改动一次配装即可生成。</div>
        <div class="nsjx-best-foot">
          <label class="nsjx-switch"><input type="checkbox" id="extAutoBest" ${auto ? 'checked' : ''}> 自动更新最高记录</label>
        </div>`;
      bindBestControls();
      return;
    }
    const cur = EXT.metricsOf(EXT.currentConfig());
    const gain = cur.dps > 0 ? ((b.metrics.dps - cur.dps) / cur.dps) * 100 : 0;
    box.innerHTML = `
      <div class="nsjx-best-main">
        <div class="nsjx-best-num">${fmt(b.metrics.dps)}<small>/s</small></div>
        <div class="nsjx-best-meta">
          <span class="nsjx-chip el-${esc(b.config.params.element || 'none')}">${esc(EXT.ELEMENT_NAMES[b.config.params.element] || '')}</span>
          <span class="nsjx-chip">${esc(EXT.WEAPON_NAMES[b.config.params.weapon] || '')}</span>
          <span class="nsjx-chip">${b.metrics.jadeCount} 玉 · ${b.metrics.subCount} 词条</span>
          <span class="nsjx-chip">相对基准 ${b.metrics.index}</span>
          ${locked ? '<span class="nsjx-tag lock">已锁定</span>' : ''}
        </div>
        <div class="nsjx-best-jades">${(b.metrics.equipped || []).map(id => esc(EXT.jadeName(id))).join('、')}</div>
        <div class="nsjx-best-time">记录于 ${EXT.fmtTime(b.bestSince || b.ts)}${b.prevDps
          ? `　（上一记录 ${fmt(b.prevDps)}/s）` : ''}</div>
        <div class="nsjx-best-delta ${gain > 0.05 ? 'up' : ''}">${gain > 0.05
          ? `比当前工作区高 ${pctStr(gain)}，${fmt(b.metrics.dps - cur.dps)}/s`
          : '当前工作区已达到或超过该记录'}</div>
      </div>
      <div class="nsjx-best-btns">
        <button type="button" class="btn btn-primary" id="extLoadBest">载入最高配置</button>
        <button type="button" class="btn" id="extLockBest">${locked ? '解锁' : '锁定'}</button>
        <button type="button" class="btn" id="extCompareBest">与当前对比</button>
        <button type="button" class="btn btn-danger" id="extClearBest">清除</button>
        <label class="nsjx-switch"><input type="checkbox" id="extAutoBest" ${auto ? 'checked' : ''}> 自动更新</label>
      </div>`;
    bindBestControls();
  }

  function bindBestControls() {
    const lb = $('#extLoadBest');
    if (lb) lb.addEventListener('click', () => {
      const b = EXT.store.best;
      if (!b) return;
      loadRecord(b, '已载入最高配置');
    });
    const lk = $('#extLockBest');
    if (lk) lk.addEventListener('click', () => {
      EXT.store.saveMeta({ bestLocked: !EXT.store.meta.bestLocked });
      renderBest();
      toast(EXT.store.meta.bestLocked ? '已锁定，更强的配置也不会覆盖' : '已解锁，恢复自动更新');
    });
    const cb = $('#extCompareBest');
    if (cb) cb.addEventListener('click', () => {
      const b = EXT.store.best;
      if (!b) return;
      S.compareA = b;
      S.compareB = { kind: 'current' };
      renderCompare();
      renderHistory();
      $('#extCompare')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    const cl = $('#extClearBest');
    if (cl) cl.addEventListener('click', () => {
      if (!confirm('确定清除最高记录吗？（历史快照不受影响）')) return;
      EXT.store.clearBest();
      renderBest(); renderHeadStats();
      toast('已清除最高记录');
    });
    const au = $('#extAutoBest');
    if (au) au.addEventListener('change', () => {
      EXT.store.saveMeta({ autoBest: au.checked });
      toast(au.checked ? '已开启自动更新最高记录' : '已关闭自动更新');
    });
  }

  /* ------------------------------------------------------------------ *
   * 载入 / 应用
   * ------------------------------------------------------------------ */
  function loadRecord(rec, msg) {
    if (!rec) return;
    S.suspendCapture = true;
    try {
      EXT.applyConfig(rec.config, { persist: true });
    } finally {
      setTimeout(() => {
        S.suspendCapture = false;
        lastAppliedSig = EXT.signature(EXT.currentConfig());
        renderAll();
      }, 260);
    }
    toast(msg || '已载入');
  }

  function renderAll() {
    renderHeadStats();
    renderHistory();
    renderBest();
    renderCompare();
    renderRanking();
  }
  EXT.uiRenderAll = renderAll;

  /* ------------------------------------------------------------------ *
   * 对比视图
   * ------------------------------------------------------------------ */
  function pickCompareA(id) {
    const r = EXT.store.history.find(x => x.id === id);
    if (!r) return;
    if (S.compareB && S.compareB.kind === 'record' && S.compareB.rec.sig === r.sig) {
      toast('A 与 B 是同一份配置，换一条吧');
      return;
    }
    S.compareA = r;
    if (!S.compareB || (S.compareB.kind === 'record' && S.compareB.rec.sig === r.sig)) {
      S.compareB = { kind: 'current' };
    }
    renderCompare();
    renderHistory();
    $('#extCompare')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function optionList(selected) {
    const opts = [`<option value="current"${selected === 'current' ? ' selected' : ''}>当前工作区</option>`];
    if (EXT.store.best) {
      opts.push(`<option value="best"${selected === 'best' ? ' selected' : ''}>最高记录（${fmt(EXT.store.best.metrics.dps)}/s）</option>`);
    }
    const vol = EXT.store.volatile;
    if (vol.a) opts.push(`<option value="vol-a"${selected === 'vol-a' ? ' selected' : ''}>动态 A（${fmt(vol.a.metrics.dps)}/s）</option>`);
    if (vol.b) opts.push(`<option value="vol-b"${selected === 'vol-b' ? ' selected' : ''}>动态 B（${fmt(vol.b.metrics.dps)}/s）</option>`);
    EXT.store.history.slice(0, 40).forEach((r, i) => {
      opts.push(`<option value="h:${esc(r.id)}"${selected === 'h:' + r.id ? ' selected' : ''}>#${EXT.store.history.length - i} · ${esc(EXT.fmtTime(r.ts).slice(5))} · ${fmt(r.metrics.dps)}/s</option>`);
    });
    return opts.join('');
  }

  function resolveSide(kind) {
    if (!kind) return null;
    if (kind === 'current') return { kind: 'current', label: '当前工作区', config: EXT.currentConfig() };
    if (kind === 'best') return EXT.store.best
      ? { kind: 'record', rec: EXT.store.best, label: '最高记录', config: EXT.store.best.config } : null;
    if (kind === 'vol-a') return EXT.store.volatile.a
      ? { kind: 'record', rec: EXT.store.volatile.a, label: '动态 A', config: EXT.store.volatile.a.config } : null;
    if (kind === 'vol-b') return EXT.store.volatile.b
      ? { kind: 'record', rec: EXT.store.volatile.b, label: '动态 B', config: EXT.store.volatile.b.config } : null;
    if (kind.startsWith('h:')) {
      const r = EXT.store.history.find(x => x.id === kind.slice(2));
      if (!r) return null;
      const i = EXT.store.history.indexOf(r);
      return {
        kind: 'record', rec: r,
        label: `#${EXT.store.history.length - i} · ${EXT.fmtTime(r.ts).slice(5)}`,
        config: r.config,
      };
    }
    return null;
  }

  function slotLine(e) {
    switch (e.type) {
      case 'add':
        return `<b>＋</b> 槽位 ${e.slot + 1} 新增 <span class="nsjx-jade">${esc(EXT.jadeName(e.jadeId))}</span>`;
      case 'remove':
        return `<b>－</b> 槽位 ${e.slot + 1} 移除 <span class="nsjx-jade">${esc(EXT.jadeName(e.jadeId))}</span>`;
      case 'swap':
        return `<b>↔</b> 槽位 ${e.slot + 1} 换玉 <span class="nsjx-jade">${esc(EXT.jadeName(e.from))}</span> → <span class="nsjx-jade">${esc(EXT.jadeName(e.to))}</span>`;
      case 'move':
        return `<b>⇄</b> <span class="nsjx-jade">${esc(EXT.jadeName(e.jadeId))}</span> 槽位 ${e.slot + 1} → ${e.toSlot + 1}`;
      case 'modify':
        return `<b>✎</b> 槽位 ${e.slot + 1} <span class="nsjx-jade">${esc(EXT.jadeName(e.jadeId))}</span>` +
          `<div class="nsjx-parts">${e.parts.map(p =>
            `<span class="nsjx-part"><i>${esc(p.label)}</i>` +
            `<s>${esc(p.a)}</s> → <em>${esc(p.b)}</em>` +
            `${p.hint ? `<u>${esc(p.hint)}</u>` : ''}</span>`).join('')}</div>`;
      default:
        return `<b>?</b> ${esc(JSON.stringify(e))}`;
    }
  }

  function renderCompare() {
    const box = $('#extCompare');
    if (!box) return;

    /* A 侧：优先显式选择，其次 S.compareA，最后取历史倒数第二条 */
    const aSel = S.compareA ? (EXT.store.history.find(r => r.sig === S.compareA.sig)?.id ? 'h:' + EXT.store.history.find(r => r.sig === S.compareA.sig).id : null) : null;
    const bSel = (S.compareB && S.compareB.kind) ? S.compareB.kind : 'current';

    const head = `
      <div class="nsjx-cmp-head">
        <label class="nsjx-field"><span>A 基准</span><select id="extSelA">${optionList(aSel || 'current')}</select></label>
        <span class="nsjx-arrow">→</span>
        <label class="nsjx-field"><span>B 对照</span><select id="extSelB">${optionList(bSel)}</select></label>
        <div class="nsjx-cmp-actions">
          <button type="button" class="btn" id="extSnapA" title="把当前配置冻结为动态 A（不写入历史）">冻结当前为 A</button>
          <button type="button" class="btn" id="extSnapB" title="把当前配置冻结为动态 B（不写入历史）">冻结当前为 B</button>
          <button type="button" class="btn" id="extSwapAB" title="互换 A / B">↔ 互换</button>
          <button type="button" class="btn" id="extClearVol" title="清空动态 A / B">清空动态</button>
        </div>
      </div>`;

    const aKind = aSel || 'current';
    const sideA = resolveSide(aKind);
    const sideB = resolveSide(bSel);

    if (!sideA || !sideB) {
      box.innerHTML = head + `<div class="nsjx-empty">选好 A / B 就可以对比了（动态对比不写入本机存储）。</div>`;
      bindCompareControls();
      return;
    }

    const d = EXT.diffConfigs(sideA.config, sideB.config, sideA.label, sideB.label);
    const m = d.metricDelta;

    const metricsHtml = EXT.METRIC_FIELDS.map(([k, label, unit, type]) => {
      const cell = m[k];
      if (!cell) return '';
      const dlt = EXT.round2(cell.b - cell.a);
      const changed = Math.abs(dlt) > 1e-6;
      const cls = changed ? (dlt > 0 ? 'up' : 'down') : 'same';
      const show = v => (type === 'pct' ? EXT.round1(v) + '%' : (k === 'index' ? v.toFixed(1) : fmt(v)));
      return `<div class="nsjx-metric ${cls}">
          <span class="k">${esc(label)}${unit && type === 'num' ? `<i>${esc(unit)}</i>` : ''}</span>
          <span class="v">${show(cell.a)}</span>
          <span class="d">${changed ? (dlt > 0 ? '▲' : '▼') + ' ' + (type === 'pct' ? pctStr(dlt) : (k === 'index' ? EXT.round1(dlt) : fmt(dlt))) : '—'}</span>
          <span class="v">${show(cell.b)}</span>
        </div>`;
    }).join('');

    const paramsHtml = d.params.length
      ? d.params.map(p => `<div class="nsjx-diff-row"><b>参数</b> ${esc(p.label)}：<s>${esc(p.a)}</s> → <em>${esc(p.b)}</em></div>`).join('')
      : '';

    const slotsHtml = d.slots.length
      ? d.slots.map(e => `<div class="nsjx-diff-row type-${e.type}">${slotLine(e)}</div>`).join('')
      : '<div class="nsjx-empty small">两份配置的魂玉、词条、染元素完全一致</div>';

    const sameOnly = !d.params.length && !d.slots.length;

    box.innerHTML = head + `
      <div class="nsjx-cmp-summary ${d.deltaPct > 0 ? 'up' : (d.deltaPct < 0 ? 'down' : '')}">
        <span class="nsjx-cmp-badge">${sameOnly ? '同构' : '差异'}</span>
        <span>${esc(d.summary)}</span>
      </div>
      <div class="nsjx-cmp-grid">
        <section class="nsjx-cmp-col">
          <h4>指标对照 <span class="muted">A → B</span></h4>
          <div class="nsjx-metrics">${metricsHtml}</div>
        </section>
        <section class="nsjx-cmp-col">
          <h4>配置差异 <span class="muted">${d.slots.length + d.params.length} 处</span></h4>
          <div class="nsjx-diffs">${paramsHtml}${slotsHtml}</div>
          <div class="nsjx-cmp-foot">
            <button type="button" class="btn" id="extUseA">载入 A</button>
            <button type="button" class="btn btn-primary" id="extUseB">载入 B</button>
            <button type="button" class="btn" id="extKeepBest" title="把 A / B 中较高的那份写入最高记录">较高者记为最高</button>
          </div>
        </section>
      </div>`;
    bindCompareControls(sideA, sideB);
  }

  function bindCompareControls(sideA, sideB) {
    const sa = $('#extSelA'), sb = $('#extSelB');
    if (sa) sa.addEventListener('change', () => {
      S.compareA = sa.value === 'current' ? null : (resolveSide(sa.value) || {}).rec || null;
      if (sa.value === 'current') S.compareA = null, S.compareKindA = 'current';
      S.compareKindA = sa.value;
      S.compareA = sa.value === 'current' ? null : (resolveSide(sa.value) || {}).rec || null;
      if (sa.value.startsWith('h:')) S.compareA = EXT.store.history.find(r => r.id === sa.value.slice(2)) || null;
      renderCompare(); renderHistory();
    });
    if (sb) sb.addEventListener('change', () => {
      S.compareB = { kind: sb.value };
      renderCompare();
    });
    const snapA = $('#extSnapA');
    if (snapA) snapA.addEventListener('click', () => {
      EXT.store.setVolatile('a', EXT.store.makeRecord(EXT.currentConfig(), {
        source: 'volatile', label: '动态 A（临时）',
      }));
      S.compareB = { kind: 'current' };
      if (!S.compareA) S.compareKindA = 'vol-a';
      S.compareKindA = 'vol-a'; S.compareA = null;
      renderCompare(); toast('已冻结为动态 A（不落盘）');
    });
    const snapB = $('#extSnapB');
    if (snapB) snapB.addEventListener('click', () => {
      EXT.store.setVolatile('b', EXT.store.makeRecord(EXT.currentConfig(), {
        source: 'volatile', label: '动态 B（临时）',
      }));
      S.compareB = { kind: 'vol-b' };
      renderCompare(); toast('已冻结为动态 B（不落盘）');
    });
    const sw = $('#extSwapAB');
    if (sw) sw.addEventListener('click', () => {
      const va = EXT.store.volatile.a, vb = EXT.store.volatile.b;
      EXT.store.setVolatile('a', vb);
      EXT.store.setVolatile('b', va);
      const ka = S.compareKindA, kb = (S.compareB || {}).kind;
      S.compareKindA = kb; S.compareB = { kind: ka };
      renderCompare();
    });
    const cv = $('#extClearVol');
    if (cv) cv.addEventListener('click', () => {
      EXT.store.clearVolatile();
      if ((S.compareB || {}).kind === 'vol-b') S.compareB = { kind: 'current' };
      S.compareKindA = null; S.compareA = null;
      renderCompare(); toast('已清空动态对比');
    });
    const ua = $('#extUseA');
    if (ua && sideA) ua.addEventListener('click', () => loadRecord(
      { config: sideA.config }, `已载入 A · ${sideA.label}`));
    const ub = $('#extUseB');
    if (ub && sideB) ub.addEventListener('click', () => loadRecord(
      { config: sideB.config }, `已载入 B · ${sideB.label}`));
    const kb2 = $('#extKeepBest');
    if (kb2 && sideA && sideB) kb2.addEventListener('click', () => {
      const mA = EXT.metricsOf(sideA.config), mB = EXT.metricsOf(sideB.config);
      const win = mA.dps >= mB.dps
        ? { cfg: sideA.config, m: mA, tag: sideA.label }
        : { cfg: sideB.config, m: mB, tag: sideB.label };
      EXT.store.capture(win.cfg, {
        force: true, source: 'manual', label: `${win.tag} · ${fmt(win.m.dps)}/s`,
      });
      EXT.store.recomputeBest();
      renderBest(); renderHistory(); renderHeadStats();
      toast(`已把【${win.tag}】记为最高记录`);
    });
  }

  /* ------------------------------------------------------------------ *
   * 详情弹窗
   * ------------------------------------------------------------------ */
  function showDetail(rec) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const m = rec.metrics;
    const rows = EXT.METRIC_FIELDS.map(([k, label, unit, type]) => {
      const v = m[k];
      if (v == null) return '';
      return `<div class="nsjx-detail-cell"><span>${esc(label)}</span><b>${
        type === 'pct' ? EXT.round1(v) + '%' : fmt(v)}${unit && type === 'num' ? `<i>${esc(unit)}</i>` : ''}</b></div>`;
    }).join('');
    const jades = (rec.config.slots || []).map((s, i) => {
      if (!s) return '';
      const subs = (s.subs || []).filter(Boolean).map(EXT.affixName).join(' / ');
      const el = s.element ? `染${EXT.ELEMENT_NAMES[s.element]}` : '未染';
      return `<div class="nsjx-detail-jade"><b>${i + 1}. ${esc(EXT.jadeName(s.jadeId))}</b>
        <span>${esc(el)}</span><small>${esc(subs || '无词条')}</small></div>`;
    }).join('');
    mask.innerHTML = `<div class="modal nsjx-detail">
      <h3>快照详情 · ${EXT.fmtTime(rec.ts)}</h3>
      <div class="nsjx-detail-grid">${rows}</div>
      <div class="nsjx-detail-jades">${jades}</div>
      <div class="modal-actions">
        <button type="button" class="btn" data-close>关闭</button>
        <button type="button" class="btn btn-primary" data-apply>载入这份</button>
      </div>
    </div>`;
    mask.addEventListener('click', e => {
      if (e.target === mask || e.target.hasAttribute('data-close')) mask.remove();
    });
    mask.querySelector('[data-apply]').addEventListener('click', () => {
      mask.remove();
      loadRecord(rec, '已载入');
    });
    document.body.appendChild(mask);
  }

  /* ------------------------------------------------------------------ *
   * 一键求最优
   * ------------------------------------------------------------------ */
  function renderRanking() {
    const box = $('#extRanking');
    if (!box) return;
    const list = S.ranking || [];
    if (!list.length) {
      box.innerHTML = '<div class="nsjx-empty">点「求最优」开始搜索：会扫描元素 × 武器 × 槽位，输出排名。</div>';
      return;
    }
    box.innerHTML = list.map(r => `<div class="nsjx-rank" data-rank="${r.rank}">
        <span class="nsjx-rank-no">${r.rank}</span>
        <div class="nsjx-rank-main">
          <div class="nsjx-rank-top">
            <span class="nsjx-chip el-${esc(r.params.element)}">${esc(EXT.ELEMENT_NAMES[r.params.element])}</span>
            <span class="nsjx-chip">${esc(EXT.WEAPON_NAMES[r.params.weapon])}</span>
            <span class="nsjx-chip">${r.params.slotCount} 槽</span>
            <span class="nsjx-rank-tag">${esc(r.tag)}</span>
          </div>
          <div class="nsjx-rank-jades">${(r.metrics.equipped || []).map(id => esc(EXT.jadeName(id))).join('、')}</div>
        </div>
        <div class="nsjx-rank-side">
          <span class="nsjx-rank-dps">${fmt(r.metrics.dps)}<small>/s</small></span>
          <span class="nsjx-rank-idx">基准 ${r.metrics.index}</span>
          <button type="button" class="nsjx-mini" data-rload="${r.rank}">载入</button>
        </div>
      </div>`).join('');
    $$('#extRanking [data-rload]').forEach(b => b.addEventListener('click', () => {
      const r = (S.ranking || []).find(x => String(x.rank) === b.dataset.rload);
      if (!r) return;
      loadRecord({ config: { params: r.params, slots: r.slots } }, `已载入排名第 ${r.rank}`);
    }));
  }

  /* ------------------------------------------------------------------
   * 固定阵容求最优：魂玉与稀有词条数量/位置不变，只把普通词条拉到最优
   * ------------------------------------------------------------------ */
  const RARE_IDS = ['hedao', 'huaqi', 'meibu'];
  const rareSig = slots => (slots || []).filter(Boolean).map(s =>
    s.jadeId + ':' + (s.subs || []).filter(x => RARE_IDS.includes(x)).sort().join('+')
  ).join('|');

  async function runSolveLocked() {
    const bar = $('#extSolveBar');
    const txt = $('#extSolveText');
    const cfg = EXT.currentConfig();
    const before = EXT.metricsOf(cfg);
    const sigBefore = rareSig(cfg.slots);

    if (txt) txt.textContent = '正在按当前阵容枚举词条…';
    if (bar) { bar.style.width = '30%'; bar.classList.add('running'); }
    await new Promise(r => setTimeout(r, 30));

    try {
      const t0 = Date.now();
      const counted = EXT.autoAnalysis && typeof EXT.autoAnalysis.getRareCounts === 'function';
      const options = {
        allowRareSwap: false, keepElement: true,
        allowedAffixes: EXT.autoAnalysis ? EXT.autoAnalysis.getAllowed() : undefined,
      };
      if (counted) options.rareCounts = EXT.autoAnalysis.getRareCounts();
      const r = await (counted ? EXT.solveRareCounts(cfg, options) : EXT.solveLocked(cfg, options));
      const after = EXT.metricsOf({ params: r.params, slots: r.slots });
      const sigAfter = rareSig(r.slots);
      const checks = counted ? EXT.verifyRareCounts(cfg.slots, r.slots, r.allowedAffixes, options.rareCounts) : null;
      if ((checks && !checks.ok) || (!counted && sigBefore !== sigAfter)) {
        throw new Error('内部校验失败：魂玉或稀有词条数量不符');
      }

      if (bar) { bar.style.width = '100%'; bar.classList.remove('running'); }
      const gainPct = before.dps > 0 ? ((after.dps - before.dps) / before.dps) * 100 : 0;
      const msg = gainPct > 0.01
        ? `固定阵容已拉满：${EXT.num(before.dps)} → ${EXT.num(after.dps)}（+${EXT.round1(gainPct)}%）`
        : `当前配装在锁定约束下已是最优（${EXT.num(after.dps)}/s）`;
      if (txt) txt.textContent = `${msg} · ${r.stats.evals} 次评估 · ${Date.now() - t0}ms`;

      /* 更新榜单（把 locked 结果排进去，方便一键载入对比） */
      S.ranking = [{
        rank: 1, tag: '当前阵容·词条拉满',
        params: r.params, slots: r.slots,
        metrics: after, dps: after.dps, value: after.dps,
        sig: EXT.signature({ params: r.params, slots: r.slots }),
      }].concat(S.ranking || []).map((x, i) => (x.rank = i + 1, x));
      renderRanking();

      /* 自动记录：加进历史 & 尝试刷新最高记录 */
      EXT.store.capture({ params: r.params, slots: r.slots }, { force: false, source: 'auto' });
      const rec = EXT.store.makeRecord(
        { params: r.params, slots: r.slots },
        { source: 'solver', label: `当前阵容拉满 · ${EXT.num(after.dps)}/s` });
      const res = EXT.store.maybeUpdateBest(rec);
      if (res.replaced) toast(`最高记录更新：${EXT.num(after.dps)}/s`);
      else toast(msg);
      renderBest(); renderHistory(); renderHeadStats();
    } catch (e) {
      console.error(e);
      if (bar) { bar.style.width = '0%'; bar.classList.remove('running'); }
      if (txt) txt.textContent = '出错：' + (e && e.message ? e.message : String(e));
      toast('求解出错：' + (e && e.message ? e.message : e));
    }
  }

  let solving = false;

  function syncSolveModeUI() {
    const mode = $('#extSolveMode');
    const wrap = $('#extSolveBaseWrap');
    if (mode && wrap) wrap.style.display = mode.value === 'locked' ? 'none' : '';
  }

  async function runSolve() {
    if (solving) return;
    solving = true;
    const btn = $('#extSolveBtn');
    const bar = $('#extSolveBar');
    const txt = $('#extSolveText');
    const t0 = Date.now();
    if (btn) { btn.disabled = true; btn.textContent = '求解中…'; }
    if (bar) { bar.style.width = '0%'; bar.classList.add('running'); }
    if (txt) txt.textContent = '正在建立评估器…';

    const mode = ($('#extSolveMode') && $('#extSolveMode').value) || 'locked';
    const objective = ($('#extSolveObjective') && $('#extSolveObjective').value) || 'dps';
    if (mode === 'locked') {
      try { await runSolveLocked(); }
      finally {
        solving = false;
        if (btn) { btn.disabled = false; btn.textContent = '求最优'; }
        if (bar) bar.classList.remove('running');
      }
      return;
    }
    const useCurrent = !$('#extSolveBase') || $('#extSolveBase').value === 'current';
    const baseCfg = useCurrent ? EXT.currentConfig()
      : (EXT.store.best ? EXT.store.best.config : EXT.currentConfig());

    /* fast：6 口径 × 单轮换玉，约 9~15 秒（笔记本 CPU 上）
       deep：12 口径 × 双轮换玉 + 池枚举放大，约 40~90 秒 */
    const preset = mode === 'deep'
      ? { slotCounts: [7], elements: ['ice', 'thunder', 'poison'],
          weapons: ['melee', 'cannon', 'bow', 'zhanmadao'],
          swapRounds: 2, seedKeep: 6, restarts: 3, poolSize: 14, refineN: 16,
          budgetMs: 300000, expandSlots: false, topReport: 8, useSeeds: true }
      : { slotCounts: [7], elements: ['ice', 'thunder', 'poison'],
          weapons: ['melee', 'cannon'],
          swapRounds: 1, seedKeep: 2, restarts: 0, poolSize: 12, refineN: 6,
          budgetMs: 45000, expandSlots: false, topReport: 6, useSeeds: true, soloSeed: false };

    /* 让出主线程，先把进度条刷出来 */
    await new Promise(r => setTimeout(r, 30));

    try {
      const res = await EXT.solve(baseCfg, Object.assign(preset, { objective }), p => {
        if (bar) bar.style.width = Math.max(2, Math.min(100, p.pct)) + '%';
        if (txt) txt.textContent = `${p.stage === 'done' ? '完成' : '搜索中'} · ${p.detail}`;
      });
      S.ranking = res.ranking;
      renderRanking();
      renderHeadStats();
      if (res.best) {
        const rec = EXT.store.makeRecord(
          { params: res.best.params, slots: res.best.slots },
          { source: 'solver', label: `求解最优 · ${fmt(res.best.metrics.dps)}/s` });
        EXT.store.capture({ params: res.best.params, slots: res.best.slots },
          { force: true, source: 'solver' });
        const prev = EXT.store.best;
        const r = EXT.store.maybeUpdateBest(rec);
        renderBest(); renderHistory(); renderHeadStats();
        const msg = r.replaced
          ? `找到更高配置：${fmt(res.best.metrics.dps)}/s（原 ${prev ? fmt(prev.metrics.dps) : '无'}）`
          : `求解完成：${fmt(res.best.metrics.dps)}/s，未超过已有最高记录`;
        toast(msg);
        if (txt) txt.textContent = `${msg} · ${res.stats.evals} 次评估 · ${res.stats.elapsedMs}ms`;
      } else {
        toast('没有找到可行解');
      }
    } catch (e) {
      console.error(e);
      toast('求解出错：' + (e && e.message ? e.message : e));
      if (txt) txt.textContent = '出错：' + (e && e.message ? e.message : String(e));
    } finally {
      solving = false;
      if (btn) { btn.disabled = false; btn.textContent = '求最优'; }
      if (bar) { bar.style.width = '100%'; bar.classList.remove('running'); }
      setTimeout(() => { if (bar) bar.style.width = '0%'; }, 1400);
      void t0;
    }
  }

  /* ------------------------------------------------------------------ *
   * 提示条（复用主页面 toast）
   * ------------------------------------------------------------------ */
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  /* ------------------------------------------------------------------ *
   * 骨架 HTML
   * ------------------------------------------------------------------ */
  function ensurePanel() {
    if ($('#panel-ext')) return;
    /* v2.1 单屏布局把扩展挂进 #extMount；旧长页回退到 .layout */
    const layout = $('#extMount') || $('.layout');
    if (!layout) return;

    const sec = document.createElement('section');
    sec.className = 'panel panel-ext';
    sec.id = 'panel-ext';
    sec.innerHTML = `
      <div class="panel-head">
        <h2>对比 · 自动最优</h2>
        <span class="panel-hint">历史快照 / 最高记录 / 动态对比 / 一键求最优</span>
      </div>

      <div class="nsjx-headstrip">
        <div class="nsjx-stat"><span>当前 DPS</span><b id="extCurDps">—</b><i>/秒</i></div>
        <div class="nsjx-stat"><span>相对基准</span><b id="extCurIndex">—</b></div>
        <div class="nsjx-stat best"><span>最高记录</span><b id="extBestDps">—</b></div>
        <div class="nsjx-stat"><span>快照</span><b id="extHistCount">0</b><i>条</i></div>
      </div>

      <div class="nsjx-body">
        <!-- 左：历史 -->
        <section class="nsjx-col">
          <h3 class="nsjx-title">历史快照 <span class="muted">改一次配装存一条，点任意一条看详情</span>
            <button type="button" class="nsjx-mini" id="extMarkBtn" title="把当前配置强制记为一条（绕过去重）">标记当前</button>
            <button type="button" class="nsjx-mini danger" id="extClearHist" title="清空全部历史快照">清空</button>
          </h3>
          <div class="nsjx-hist-list" id="extHistory"></div>
        </section>

        <!-- 右上：最高记录 -->
        <section class="nsjx-col">
          <h3 class="nsjx-title">自动保存的最高配置 <span class="muted">只增不减，可锁定</span></h3>
          <div class="nsjx-best" id="extBest"></div>
        </section>

        <!-- 右下：求解 -->
        <section class="nsjx-col">
          <h3 class="nsjx-title">自动求最优</h3>
          <div class="nsjx-solve">
            <div class="nsjx-solve-ctrl">
              <label class="nsjx-field"><span>口径</span>
                <select id="extSolveObjective">
                  <option value="dps">综合期望 DPS（推荐）</option>
                  <option value="score">魂玉评分</option>
                </select>
              </label>
              <label class="nsjx-field"><span>范围</span>
                <select id="extSolveMode">
                  <option value="locked">只调当前配装（秒回，推荐）</option>
                  <option value="fast">全库快速（约 10~20 秒）</option>
                  <option value="deep">全库深度（全武器，1~3 分钟）</option>
                </select>
              </label>
              <label class="nsjx-field" id="extSolveBaseWrap"><span>基准参数</span>
                <select id="extSolveBase">
                  <option value="current">用当前计算参数</option>
                  <option value="best">用最高记录的参数</option>
                </select>
              </label>
              <button type="button" class="btn btn-primary" id="extSolveBtn">求最优</button>
            </div>
            <div class="nsjx-progress"><div class="nsjx-progress-bar" id="extSolveBar"></div></div>
            <div class="nsjx-solve-text" id="extSolveText">尚未开始</div>
            <div class="nsjx-rank-list" id="extRanking"></div>
          </div>
        </section>
      </div>

      <!-- 对比区 -->
      <section class="nsjx-col nsjx-col-wide" id="extCompare"></section>
    `;
    layout.appendChild(sec);

    /* 旧长页的移动端标签页补一个入口（单屏布局已有工作标签，跳过） */
    const tabs = $('#extMount') ? null : $('#tabs');
    if (tabs && !tabs.querySelector('[data-tab="ext"]')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.dataset.tab = 'ext';
      b.innerHTML = '对比 <span class="tab-badge" id="tabExtBadge">0</span>';
      tabs.appendChild(b);
      b.addEventListener('click', () => {
        document.body.dataset.tab = 'ext';
        $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'ext'));
        $$('.panel').forEach(p => p.classList.toggle('tab-active', p.id === 'panel-ext'));
      });
    }

    $('#extMarkBtn').addEventListener('click', () => {
      const n = EXT.currentConfig().slots.filter(s => s && s.jadeId).length;
      if (!n) { toast('先佩戴魂玉再标记吧'); return; }
      EXT.store.captureManual(EXT.currentConfig());
      renderHistory(); renderBest(); renderHeadStats();
      toast('已标记为一条快照');
    });
    $('#extClearHist').addEventListener('click', () => {
      if (!confirm('清空全部历史快照？（最高记录保留）')) return;
      EXT.store.clearHistory();
      renderHistory(); renderHeadStats();
      toast('历史已清空');
    });
    $('#extSolveBtn').addEventListener('click', runSolve);
    const sm = $('#extSolveMode');
    if (sm) sm.addEventListener('change', syncSolveModeUI);
    syncSolveModeUI();
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    if (!EXT.ready()) { setTimeout(boot, 120); return; }
    EXT.store.load();
    ensurePanel();
    renderAll();
    startAutoCapture();

    EXT.on('best', () => { renderBest(); renderHeadStats(); });
    EXT.on('history', () => { renderHistory(); renderHeadStats(); });

    /* 主界面上任何会改变配装的动作 → 刷新指标条与对比区 */
    ['click', 'change'].forEach(evt => document.addEventListener(evt, () => {
      setTimeout(() => {
        if (S.suspendCapture) return;
        renderHeadStats();
        if (S.compareB && S.compareB.kind === 'current') renderCompare();
      }, 60);
    }, true));

    console.info('[NSJExt] 对比 / 自动最优 已挂载 · v' + EXT.version);
  }

  EXT.ui = { boot, renderAll, renderCompare, renderHistory, renderBest, runSolve, toast };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 60));
  } else {
    setTimeout(boot, 60);
  }
})(window);
