/* =========================================================================
 * 二改 v2.1 · 单屏布局适配层
 * -------------------------------------------------------------------------
 * 上游 app.js 是按「三栏长页面」写的：它假设 #slots / #statGrid / #paramGrid
 * 这些节点永远可见，且用 `#dmgTotal` 显示总数。v2.1 把版面改成
 * 「① 配置 / ② 结果 / ③ 对比」三个视图 + 一次只显示一屏，
 * 本文件负责在不改 app.js 的前提下把两边对齐：
 *
 *   1) 视图切换（配置 / 结果 / 对比），状态存 localStorage，刷新回到上次那屏
 *   2) 抽屉标签（魂玉说明 / 计算参数 / 条件加成）—— 把参数面板从长页搬进抽屉
 *   3) 补 #heroDps：上游只写 #dmgTotal .num，这里同步一个大数字
 *   4) 「更多」菜单（导出 / 导入 / 清空）
 *   5) 点玉卡标题 → 在抽屉里显示该玉完整效果
 *   6) 首次打开给一句引导，并把 ③ 的角标接上历史条数
 * ========================================================================= */
(function (global) {
  'use strict';

  const EXT = global.NSJExt;
  const VIEW_KEY = 'naraka-souljade-view-v2';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const state = { view: 'build', drawer: 'analysis', lastJadeId: null };

  function toast(msg) {
    if (EXT && EXT.ui && EXT.ui.toast) return EXT.ui.toast(msg);
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.__t);
    toast.__t = setTimeout(() => t.classList.remove('show'), 2000);
  }

  /* ------------------------------------------------------------------ *
   * ① 视图切换
   * ------------------------------------------------------------------ */
  const VIEW_HINT = {
    build: '点左侧魂玉 → 中间槽位',
    result: '改词条/参数后这里实时重算',
    compare: '历史快照 / 最高记录 / 动态对比 / 求最优',
  };

  function setView(v, persist) {
    if (!['build', 'result', 'compare'].includes(v)) v = 'build';
    state.view = v;
    $$('.worktab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    ['build', 'result', 'compare'].forEach(k => {
      const el = $('#view-' + k);
      if (el) el.classList.toggle('active', k === v);
    });
    const hint = $('#worktabHint');
    if (hint) hint.textContent = VIEW_HINT[v] || '';
    /* 上游的移动端 data-tab 也同步，避免它的 syncTabs 把我们的视图关掉 */
    document.body.dataset.tab = v;
    document.body.dataset.view = v;
    if (persist !== false) {
      try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* 忽略 */ }
    }
    /* 切到结果时刷一遍，保证数字是最新的 */
    if (v === 'result') refreshHero();
    if (v === 'compare' && EXT && EXT.ui && EXT.ui.renderAll) EXT.ui.renderAll();
  }

  function initTabs() {
    $$('.worktab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    let saved = 'build';
    try { saved = localStorage.getItem(VIEW_KEY) || 'build'; } catch (e) { /* 忽略 */ }
    setView(saved, false);

    /* 键盘 1/2/3 切视图 */
    document.addEventListener('keydown', e => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '1') setView('build');
      if (e.key === '2') setView('result');
      if (e.key === '3') setView('compare');
    });
  }

  /* ------------------------------------------------------------------ *
   * ② 抽屉标签
   * ------------------------------------------------------------------ */
  function setDrawer(name) {
    state.drawer = name;
    $$('.drawer-tab').forEach(b => b.classList.toggle('active', b.dataset.drawer === name));
    const map = { analysis: '#drawerAnalysis', jade: '#drawerJade', param: '#drawerParam', cond: '#drawerCond' };
    Object.keys(map).forEach(k => {
      const el = $(map[k]);
      if (el) el.style.display = (k === name) ? '' : 'none';
    });
    if (global.matchMedia && global.matchMedia('(max-width: 980px)').matches) setBuildPane('analysis');
    if (name === 'param') {
      /* 参数面板里的控件是上游 renderParams 生成的，切过来时同步一次选中值 */
      const sc = $('#slotCountSelect');
      if (sc && global.NarakaSoulJade) sc.value = String(global.NarakaSoulJade.state.params.slotCount);
    }
  }

  function setBuildPane(name) {
    if (!['pool', 'slots', 'analysis'].includes(name)) name = 'analysis';
    document.body.dataset.buildPane = name;
    $$('.mobile-build-tabs [data-build-pane]').forEach(button => {
      const active = button.dataset.buildPane === name;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  function initMobilePanes() {
    $$('.mobile-build-tabs [data-build-pane]').forEach(button => button.addEventListener('click', () => {
      setBuildPane(button.dataset.buildPane);
      if (button.dataset.buildPane === 'analysis') setDrawer('analysis');
    }));
    const equipped = global.NarakaSoulJade.state.slots.some(slot => slot && slot.jadeId);
    setBuildPane(equipped ? 'analysis' : 'pool');
  }

  function initDrawer() {
    $$('.drawer-tab').forEach(b => b.addEventListener('click', () => setDrawer(b.dataset.drawer)));
    setDrawer('analysis');
  }

  /* ------------------------------------------------------------------ *
   * ③ 同步大数字（#heroDps ← #dmgTotal .num）
   * ------------------------------------------------------------------ */
  function refreshHero() {
    const src = $('#dmgTotal .num');
    const hero = $('#heroDps');
    if (src && hero && src.textContent) hero.textContent = src.textContent;
    const badge = $('#tabBuildBadge');
    if (badge && global.NarakaSoulJade) {
      const n = global.NarakaSoulJade.state.slots.filter(s => s && s.jadeId).length;
      badge.textContent = String(n);
    }
    /* 条件加成抽屉的空态 */
    const cond = $('#condBlock');
    const empty = $('#condEmpty');
    if (cond && empty) empty.style.display = (cond.style.display === 'none' || !cond.innerHTML.trim()) ? '' : 'none';
  }
  global.addEventListener('nsj:refresh', refreshHero);

  /* #dmgTotal 被上游重写时自动同步 */
  function watchDom() {
    const target = $('#dmgTotal');
    if (!target || target.__nsjWatched) return;
    target.__nsjWatched = true;
    new MutationObserver(refreshHero).observe(target, { childList: true, subtree: true, characterData: true });
  }

  /* ------------------------------------------------------------------ *
   * ④ 「更多」菜单
   * ------------------------------------------------------------------ */
  function initMore() {
    const btn = $('#btnMore');
    const menu = $('#moreMenu');
    if (!btn || !menu) return;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.addEventListener('click', () => menu.classList.remove('open'));
  }

  /* ------------------------------------------------------------------ *
   * ⑤ 玉详情抽屉
   * ------------------------------------------------------------------ */
  const MOD_LABELS = {
    atkPct: '攻击力', critRate: '暴击率', critDmg: '暴击伤害', elemCritRate: '元素暴击率',
    iceDmg: '冰爆伤害', thunderDmg: '天雷伤害', poisonDmg: '毒爆伤害', elemAccum: '元素积累',
    bossDmg: '对首领伤害', rangedDmg: '远程招式增伤', divineEff: '神射值效率',
    skillDmg: '招式伤害', cdr: '冷却缩减', meibu: '枚卜', dmgPct: '全局增伤',
    elemDmgPct: '元素伤害', yudian: '御电', frostCap: '霜冻值上限',
    poisonLayerNeed: '瘴毒层数', iceDmgMul: '冰爆倍率', iceCdr: '冰爆冷却',
    rangedHits: '发射数', rangedSelfMul: '远程自伤',
  };
  const pct = v => (v > 0 ? '+' : '') + v + '%';

  function modsText(mods) {
    if (!mods) return '';
    return Object.keys(mods).map(k => {
      const v = mods[k];
      if (k === 'cannotImbue') return '无法染元素';
      if (k === 'perPoint') return '按潜能点缩放';
      return (MOD_LABELS[k] || k) + ' ' + pct(v);
    }).join('　');
  }

  function renderJadeDrawer(jadeId) {
    const box = $('#drawerJade');
    const N = global.NarakaSoulJade;
    if (!box || !N) return;
    const j = N.JADES.find(x => x.id === jadeId);
    if (!j) {
      const equipped = N.state.slots.filter(s => s && s.jadeId);
      const quick = equipped.slice(0, 8).map(s => {
        const jj = N.JADES.find(x => x.id === s.jadeId);
        return `<button type="button" class="jd-quick" data-jade="${s.jadeId}">
            <img src="${jj.icon}" alt=""><span>${jj.name}</span></button>`;
      }).join('');
      box.innerHTML = `
        <div class="jd-welcome">
          <div class="jd-welcome-title">点任意一颗玉，这里显示它的完整效果</div>
          <div class="jd-welcome-sub">池子里悬停也会预览；中间槽位点玉卡标题同样能看。</div>
          ${quick ? `<div class="jd-label" style="margin-top:10px">当前配装（点一下看说明）</div>
            <div class="jd-quicklist">${quick}</div>` : ''}
        </div>`;
      box.querySelectorAll('[data-jade]').forEach(b => b.addEventListener('click', () => {
        renderJadeDrawer(b.dataset.jade);
      }));
      return;
    }
    state.lastJadeId = jadeId;
    const slot = N.state.slots.find(s => s && s.jadeId === jadeId);

    const bullets = (j.bullets || []).map(b => {
      const neg = /降低|负面|减少/.test(b) && !/层数减|冷却时间降低/.test(b);
      return `<li class="${neg ? 'neg' : ''}">${b}</li>`;
    }).join('');

    let subRows = '';
    if (slot) {
      const subs = (slot.subs || []).slice(0, 4);
      for (let i = 0; i < 4; i++) {
        const id = subs[i];
        if (!id) { subRows += `<div class="jd-sub empty">第 ${i + 1} 格 · 空</div>`; continue; }
        const a = N.AFFIXES.find(x => x.id === id);
        const r = N.RARES.find(x => x.id === id);
        const name = a ? `${a.name} +${a.value}%` : (r ? `${r.name} · ${r.short}` : id);
        const ov = (slot.vals || [])[i];
        subRows += `<div class="jd-sub"><b>第 ${i + 1} 格</b><span>${name}</span>${ov != null ? `<i>实填 ${ov}%</i>` : ''}</div>`;
      }
    }

    box.innerHTML = `
      <div class="jd-head">
        <img src="${j.icon}" alt="">
        <div>
          <div class="jd-name">${j.name}
            <span class="tag rarity-${j.rarity}">${j.rarity}</span>
            <span class="tag cat">${j.category}</span>
          </div>
          <div class="jd-meta">评分 ${j.score}${slot ? ` · 已佩戴 · 第 ${N.state.slots.indexOf(slot) + 1} 槽` : ' · 未佩戴'}</div>
        </div>
      </div>
      <div class="jd-brief">${j.brief || ''}</div>
      <ul class="jd-bullets">${bullets}</ul>
      ${Object.keys(j.mods || {}).length ? `<div class="jd-row"><span>计入数值</span><b>${modsText(j.mods)}</b></div>` : ''}
      ${slot && subRows ? `<div class="jd-subs"><div class="jd-label">当前 4 格词条</div>${subRows}</div>` : ''}
      ${(j.specials || []).length ? `<div class="jd-specials"><div class="jd-label">机制效果（不计入数值）</div>${
        j.specials.map(s => `<div>· ${s}</div>`).join('')}</div>` : ''}
      ${j.note ? `<div class="jd-note">${j.note}</div>` : ''}`;
  }

  /* 点玉卡标题（或卡片空白处）→ 抽屉显示该玉 */
  function hookJadeClick() {
    const wrap = $('#slots');
    if (!wrap || wrap.__nsjHooked) return;
    wrap.__nsjHooked = true;
    wrap.addEventListener('click', e => {
      const card = e.target.closest('.jade-card');
      if (!card) return;
      /* 点的是交互控件（下拉/输入/按钮/染元素）就不抢 */
      if (e.target.closest('select,input,button')) return;
      const idx = +card.parentElement.dataset.slot;
      const slot = global.NarakaSoulJade.state.slots[idx];
      if (!slot) return;
      setDrawer('jade');
      renderJadeDrawer(slot.jadeId);
    });
  }

  /* 池子里悬停/点击也顺手更新抽屉 */
  function hookPoolHover() {
    const list = $('#poolList');
    if (!list || list.__nsjHooked) return;
    list.__nsjHooked = true;
    list.addEventListener('mouseover', e => {
      const card = e.target.closest('.pool-card');
      if (!card) return;
      const id = card.dataset.id;
      if (id && id !== state.lastJadeId && state.drawer === 'jade') renderJadeDrawer(id);
    });
  }

  /* ------------------------------------------------------------------ *
   * ⑥ 首次引导
   * ------------------------------------------------------------------ */
  function firstRunHint() {
    let seen = false;
    try { seen = localStorage.getItem('naraka-souljade-v2-seen') === '1'; } catch (e) { /* 忽略 */ }
    if (seen) return;
    try { localStorage.setItem('naraka-souljade-v2-seen', '1'); } catch (e) { /* 忽略 */ }
    setTimeout(() => toast('三步：① 选玉 → ② 看结果 → ③ 求最优'), 700);
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    if (!global.NarakaSoulJade || !global.NarakaSoulJade.state) {
      setTimeout(boot, 100);
      return;
    }
    initTabs();
    initDrawer();
    initMobilePanes();
    initMore();
    watchDom();
    hookJadeClick();
    hookPoolHover();
    refreshHero();
    firstRunHint();

    /* 上游每次 renderAll 后，把首页需要的派生值同步一遍 */
    const orig = global.NarakaSoulJade.renderAll;
    if (typeof orig === 'function' && !orig.__nsjWrapped) {
      const wrapped = function () {
        const r = orig.apply(this, arguments);
        setTimeout(() => {
          refreshHero();
          if (state.drawer === 'jade' && state.lastJadeId) {
            const still = global.NarakaSoulJade.state.slots.some(s => s && s.jadeId === state.lastJadeId);
            if (still) renderJadeDrawer(state.lastJadeId);
          }
          hookJadeClick();
          hookPoolHover();
        }, 0);
        return r;
      };
      wrapped.__nsjWrapped = true;
      global.NarakaSoulJade.renderAll = wrapped;
    }
  }

  function tick() {
    if (!global.NarakaSoulJade || !global.NarakaSoulJade.state) { setTimeout(tick, 100); return; }
    boot();
    /* 兜底：池子/槽位被重渲染后重新挂钩 */
    setInterval(() => { hookJadeClick(); hookPoolHover(); refreshHero(); }, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tick, 80));
  } else {
    setTimeout(tick, 80);
  }

  global.NSJLayout = { setView, setDrawer, setBuildPane, refreshHero, renderJadeDrawer };
})(window);
