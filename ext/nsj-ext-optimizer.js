/* =========================================================================
 * 永劫无间 · 征神之路 魂玉配装工具 —— 二改扩展 · 自动求最优配置
 * -------------------------------------------------------------------------
 * 目标：在游戏规则允许的配装空间里，找出综合期望 DPS 最高的那一套。
 *
 * 搜索空间（按游戏规则硬裁剪，不搜非法组合）：
 *   输出元素 3 × 武器 4 × 槽位 4~8
 *   × 魂玉组合（34 选 N，互不重复）
 *   × 每颗玉 4 个词条位（普通词条同玉不��复、稀有词条不限条数）
 *   × 每颗玉的染元素
 * 词条数值一律取满值：实际洗练值 ≤ 满值，满值必然不劣，因此不需要枚举。
 *
 * 求解链路（每一步都用主引擎 totals()/damage() 打分，与界面同源）：
 *   ① 词条剪枝 —— 对不上输出元素的元素词条、开关关掉的首领/远程词条、
 *      不进伤害模型的神射值效率，直接踢出候选：单玉组合数 ~1.3 万 → 160
 *   ② 词条边际 —— 每个候选词条单独上场的增益排序，得到「启发式填法」，
 *      只用于粗筛（1 次评估/词条），精确解仍走全枚举
 *   ③ 单玉单练 —— 每颗玉单独上场（启发式填法）排序，34 次评估定种子
 *   ④ 贪心凑套 —— 按单练分依次补玉，每补一颗只优化新加的那颗
 *   ⑤ 精修 —— 整套做词条坐标下降到不动点（全枚举）
 *   ⑥ 换玉下降 —— 逐位换未上场魂玉：先用启发式填法粗筛，只对赢家做全枚举
 *   ⑦ 多口径扫 —— 元素 × 武器 × 槽位数 全扫，取全局最高，输出 Top 榜单
 * ========================================================================= */
(function (global) {
  'use strict';

  const EXT = global.NSJExt;
  if (!EXT) throw new Error('[NSJExt.optimizer] 需要先加载 nsj-ext-core.js');

  const RARE_IDS = new Set(['hedao', 'huaqi', 'meibu']);
  const isRareId = id => RARE_IDS.has(id);
  const now = () => ((global.performance && global.performance.now) ? global.performance.now() : Date.now());

  /* ------------------------------------------------------------------ *
   * ① 词条候选剪枝
   * ------------------------------------------------------------------ */
  function candidateAffixes(params, forJade, objective) {
    const H = EXT.host();
    const p = params;
    const out = [];

    if (objective && objective !== 'dps') {
      H.AFFIXES.forEach(a => out.push(a.id));
      H.RARES.filter(r => r.id !== 'none').forEach(r => out.push(r.id));
      return out;
    }

    const isRanged = (p.weapon === 'cannon' || p.weapon === 'bow');
    const elemAffix = EXT.AFFIX_DMG[p.element];

    H.AFFIXES.forEach(a => {
      if (a.id === 'divineEff') return;                                   // 不进伤害模型
      if (a.id === 'bossDmg' && !p.bossDmgOn) return;
      if (a.id === 'rangedDmg' && !(isRanged && p.rangedDmgOn)) return;
      if (['iceDmg', 'thunderDmg', 'poisonDmg'].includes(a.id) && a.id !== elemAffix) return;
      out.push(a.id);
    });
    H.RARES.filter(r => r.id !== 'none').forEach(r => out.push(r.id));
    void forJade;
    return out;
  }
  EXT.candidateAffixes = candidateAffixes;

  /* ------------------------------------------------------------------ *
   * ② 组合枚举
   * ------------------------------------------------------------------ */
  function combinations(arr, k) {
    const res = [];
    const n = arr.length;
    if (k === 0) return [[]];
    if (k > n) return res;
    const idx = [];
    (function rec(start) {
      if (idx.length === k) { res.push(idx.map(i => arr[i])); return; }
      for (let i = start; i < n; i++) { idx.push(i); rec(i + 1); idx.pop(); }
    })(0);
    return res;
  }

  /** 从 arr 里取 k 个，允许重复（多重组合） */
  function multiset(arr, k) {
    const res = [];
    const pick = [];
    (function rec(start) {
      if (pick.length === k) { res.push(pick.slice()); return; }
      for (let i = start; i < arr.length; i++) { pick.push(arr[i]); rec(i); pick.pop(); }
    })(0);
    return res;
  }

  /** 4 格填法：普通词条不重复，稀有词条可重复 */
  function* affixCombos(cands) {
    const normals = cands.filter(id => !isRareId(id));
    const rares = cands.filter(isRareId);
    for (let k = 0; k <= 4; k++) {
      if (k > normals.length) break;
      const need = 4 - k;
      const rareCombos = need === 0 ? [[]] : multiset(rares, need);
      for (const nsel of combinations(normals, k)) {
        for (const rsel of rareCombos) {
          if (nsel.length + rsel.length === 4) yield nsel.concat(rsel);
        }
      }
    }
  }
  EXT.affixCombos = affixCombos;
  EXT.countCombos = cands => {
    let n = 0;
    // eslint-disable-next-line no-unused-vars
    for (const _ of affixCombos(cands)) n++;
    return n;
  };

  /* ------------------------------------------------------------------ *
   * 配置构造 + 带缓存的评估器
   * ------------------------------------------------------------------ */
  function makeSlot(jadeId, element, subs) {
    const H = EXT.host();
    const j = H.JADES.find(x => x.id === jadeId);
    const cannot = !!(j && j.mods && j.mods.cannotImbue);
    const subsArr = new Array(4).fill(null);
    (subs || []).forEach((id, i) => { if (i < 4) subsArr[i] = id || null; });
    return {
      jadeId,
      subs: subsArr,
      vals: new Array(4).fill(null),
      element: cannot ? null : (element || null),
    };
  }
  EXT.makeSlot = makeSlot;

  function slotKey(s) {
    if (!s) return '∅';
    return s.jadeId + '|' + (s.element || '-') + '|' + (s.subs || []).map(x => x || '_').join(',');
  }

  function makeEvaluator(params, objective) {
    const obj = objective || 'dps';
    const cache = new Map();
    let evals = 0;
    function value(m) { return obj === 'score' ? m.score : m.dps; }

    function evalSlots(slots) {
      let key = '';
      for (let i = 0; i < slots.length; i++) key += slotKey(slots[i]) + ';';
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      evals++;
      const m = EXT.measure({ params, slots });
      const rec = { key, metrics: m, dps: m.dps, value: value(m) };
      if (cache.size > 200000) cache.clear();
      cache.set(key, rec);
      return rec;
    }
    return {
      params, objective: obj, evalSlots,
      get evals() { return evals; },
      get cacheSize() { return cache.size; },
      clear: () => cache.clear(),
    };
  }
  EXT.makeEvaluator = makeEvaluator;

  /* ------------------------------------------------------------------ *
   * ② 词条边际 → 启发式填法（只用于粗筛）
   * ------------------------------------------------------------------ */
  /**
   * 每个候选词条单独上场带来的增益，降序。
   * 用一个「真实存在的探针魂玉」来承载词条（不存在的 jadeId 会让主引擎
   * 直接跳过整颗玉，导致增益恒为 0）；探针玉自身的固定加成在相减时抵消。
   */
  const PROBE_JADE = 'zhaosheng';       // 征神魂玉、无 mods、可染元素
  function affixMarginals(ev, cands) {
    const params = ev.params;
    const jade = EXT.host().JADES.find(j => j.id === PROBE_JADE) ? PROBE_JADE
      : EXT.host().JADES.find(j => !(j.mods && Object.keys(j.mods).length))?.id
        || EXT.host().JADES[0].id;

    const blanks = new Array(params.slotCount).fill(null);
    const zeroSlots = blanks.slice();
    zeroSlots[0] = makeSlot(jade, params.element, []);
    const zero = ev.evalSlots(zeroSlots).value;

    const out = cands.map(id => {
      const trial = blanks.slice();
      trial[0] = makeSlot(jade, params.element, [id, null, null, null]);
      return { id, gain: ev.evalSlots(trial).value - zero };
    });
    out.sort((a, b) => b.gain - a.gain);
    return out.map(x => x.id);
  }

  /** 用边际排序取前 4 个（普通词条天然不重复，稀有词条不重复取也够用于粗筛） */
  function heuristicSubs(ev, cands, cache) {
    if (cache && cache.heuristic) return cache.heuristic;
    const out = fillTemplates(ev, cands)[0];
    if (cache) cache.heuristic = out;
    return out;
  }

  /**
   * 粗筛用的「填法模板」。
   * 单套模板会在某些魂玉上误杀（例如蚀骨春带 hedao 比带 critRate 高一大截，
   * 用 critRate 模板粗排就排不进前列）。这里给出 3~4 套各自成立的模板，
   * 粗筛时取最大值，再由全枚举定案。
   */
  function fillTemplates(ev, cands) {
    const order = (ev.objective === 'score') ? cands.slice() : affixMarginals(ev, cands);
    const normals = order.filter(id => !isRareId(id));
    const rares = order.filter(isRareId);
    const has = id => cands.includes(id);
    const elem = normals.find(id => /Dmg$/.test(id)) || normals[0];
    const n1 = normals.find(id => id !== elem) || normals[1];
    const n2 = normals.filter(id => id !== elem && id !== n1)[0] || normals[2];

    const tpls = [];
    const push = arr => {
      const a = arr.slice(0, 4);
      while (a.length < 4) a.push(null);
      const key = a.join(',');
      if (!tpls.some(x => x.join(',') === key)) tpls.push(a);
    };

    /* 模板 A：最优普通 + 合道 + 次优普通 + 枚卜（或第三普通） */
    if (elem) {
      const a = [elem];
      if (has('hedao')) a.push('hedao');
      if (n1) a.push(n1);
      if (has('meibu')) a.push('meibu'); else if (n2) a.push(n2);
      push(a);
    }
    /* 模板 B：最优普通 + 合道 + 次优普通 + 第三普通（纯堆数值） */
    if (elem) {
      const b = [elem];
      if (has('hedao')) b.push('hedao');
      if (n1) b.push(n1);
      if (n2) b.push(n2);
      push(b);
    }
    /* 模板 C：双合道 + 双普通（合道可叠加，双合道能把副属性拉到 ×2） */
    if (elem && has('hedao')) {
      const c = [elem];
      if (n1) c.push(n1);
      c.push('hedao', 'hedao');
      push(c);
    }
    /* 模板 D：双枚卜 + 双普通 */
    if (elem && has('meibu')) {
      const d = [elem];
      if (n1) d.push(n1);
      d.push('meibu', 'meibu');
      push(d);
    }
    /* 兜底：边际前 4 */
    push(order.slice(0, 4));
    return tpls.filter(t => t[0]);
  }

  /* ------------------------------------------------------------------ *
   * 全枚举精修
   * ------------------------------------------------------------------ */
  /** 在其余槽位固定的前提下，穷举 idx 这颗玉的 4 格填法 */
  function bestSubsFor(ev, slots, idx, cands) {
    const base = slots.slice();
    const slot = base[idx];
    let best = null, bestVal = -Infinity;
    for (const combo of affixCombos(cands)) {
      base[idx] = makeSlot(slot.jadeId, slot.element, combo);
      const r = ev.evalSlots(base);
      if (r.value > bestVal + 1e-9) { bestVal = r.value; best = combo; }
    }
    base[idx] = slot;
    return { combo: best, value: bestVal };
  }

  /**
   * 词条坐标下降（全枚举）。
   * @param onlySlots 只优化这些下标（换玉时只需重算被换的那颗）
   */
  function optimizeWords(ev, slots, opts) {
    const o = opts || {};
    const cands = o.candidates || null;
    const objective = o.objective || ev.objective;
    const maxPass = o.maxPass || 3;

    let cur = slots.map(s => (s ? makeSlot(s.jadeId, s.element, s.subs) : null));
    let curVal = ev.evalSlots(cur).value;

    const order = (o.onlySlots || cur.map((s, i) => i)).filter(i => cur[i]);
    for (let pass = 0; pass < maxPass; pass++) {
      let improved = false;
      for (const i of order) {
        const slot = cur[i];
        if (!slot) continue;
        const cs = (cands && cands[slot.jadeId]) ||
          candidateAffixes(ev.params, slot.jadeId, objective);
        const r = bestSubsFor(ev, cur, i, cs);
        if (r.combo && r.value > curVal + 1e-9) {
          cur[i] = makeSlot(slot.jadeId, slot.element, r.combo);
          curVal = r.value;
          improved = true;
        }
      }
      if (!improved) break;
    }
    const m = ev.evalSlots(cur);
    return { slots: cur, metrics: m.metrics, dps: m.dps, value: m.value };
  }
  EXT.optimizeWords = optimizeWords;

  /* ------------------------------------------------------------------ *
   * ③④ 单玉单练 + 贪心凑套
   * ------------------------------------------------------------------ */
  function allJadeIds() { return EXT.host().JADES.map(j => j.id); }

  function presetToConfig(preset, params) {
    const H = EXT.host();
    const p = Object.assign({}, params, {
      element: preset.element,
      weapon: preset.weapon || params.weapon,
      slotCount: Math.max(params.slotCount, preset.jades.length),
    });
    const slots = new Array(p.slotCount).fill(null);
    preset.jades.forEach((jid, i) => {
      if (i >= p.slotCount) return;
      const j = H.JADES.find(x => x.id === jid);
      const cannot = !!(j && j.mods && j.mods.cannotImbue);
      slots[i] = makeSlot(jid, cannot ? null : preset.element, preset.subs[i] || []);
    });
    return { params: p, slots };
  }
  EXT.presetToConfig = presetToConfig;

  /** 每颗玉「单练」能拿多少分（启发式填法，1 次评估/颗） */
  function soloScores(ev, params, cands) {
    const cache = {};
    const hs = heuristicSubs(ev, (cands && (cands.__all || cands[allJadeIds()[0]])) || [], cache);
    const out = [];
    const one = new Array(params.slotCount).fill(null);
    allJadeIds().forEach(jid => {
      one[0] = makeSlot(jid, params.element, hs);
      out.push({ jadeId: jid, value: ev.evalSlots(one).value, subs: hs });
    });
    one[0] = null;
    out.sort((a, b) => b.value - a.value);
    return out;
  }

  /**
   * 增量贪心：每一步遍历全部未上场魂玉，选「加入后整体最优」的那颗，
   * 并对它做词条全枚举。与「按单练分排序取前 N」相比，能抓到
   * 单练不出彩但互相成体系的玉（三才印、御电、状态流）。
   *
   * @param order 可选：候选取用顺序（用于多起点重启，打乱搜索路径）
   */
  function greedySet(ev, params, cands, order) {
    const pool = order || allJadeIds();
    const cache = {};
    const hs = heuristicSubs(ev, (cands && (cands.__all || cands[allJadeIds()[0]])) || [], cache);
    const slots = new Array(params.slotCount).fill(null);
    const used = new Set();
    let curVal = ev.evalSlots(slots).value;

    for (let step = 0; step < params.slotCount; step++) {
      let best = null;
      let bestVal = curVal;
      for (const cand of pool) {
        if (used.has(cand)) continue;
        const trial = slots.slice();
        trial[step] = makeSlot(cand, params.element, hs);
        const scr = ev.evalSlots(trial).value;
        if (scr > bestVal + 1e-9) { bestVal = scr; best = { cand, trial }; }
      }
      if (!best) break;
      const refined = optimizeWords(ev, best.trial, {
        candidates: cands, maxPass: 2, onlySlots: [step],
      });
      slots[step] = refined.slots[step];
      used.add(best.cand);
      curVal = refined.value;
    }
    return optimizeWords(ev, slots, { candidates: cands, maxPass: 4 });
  }

  /**
   * 按单练分取前 N 直接成型。
   * 两条路径（soloSeed / greedySet）产生的局部最优不在同一个盆地，
   * 都留作种子，交给换玉下降去收敛。
   */
  function soloSeed(ev, params, cands) {
    const solos = soloScores(ev, params, cands);
    const slots = new Array(params.slotCount).fill(null);
    solos.slice(0, params.slotCount).forEach((s, i) => { slots[i] = makeSlot(s.jadeId, params.element, s.subs); });
    return optimizeWords(ev, slots, { candidates: cands, maxPass: 3 });
  }

  /** 打乱单练序后再取前 N：多起点的一种廉价形式 */
  function soloSeedShuffled(ev, params, cands, rng) {
    const solos = soloScores(ev, params, cands);
    const per = params.slotCount;
    const chosen = [];
    const pool = solos.slice();
    while (chosen.length < per && pool.length) {
      const pick = Math.floor(rng() * Math.min(pool.length, per + 3));
      chosen.push(pool.splice(pick, 1)[0]);
    }
    const slots = new Array(per).fill(null);
    chosen.forEach((s, i) => { slots[i] = makeSlot(s.jadeId, params.element, s.subs); });
    return optimizeWords(ev, slots, { candidates: cands, maxPass: 2 });
  }

  /** 线性同余伪随机（固定种子，保证同参数下结果可复现） */
  function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function shuffled(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ------------------------------------------------------------------ *
   * ⑤b 破坏-重建（ruin & recreate）
   * ------------------------------------------------------------------ */
  /**
   * 抠掉 k 颗玉（k=1..maxK，逐组合），用全局贪心重新填满，返回最好的一版。
   * 用启发式填法做重建打分（便宜），只对最终赢家做一次全枚举精修。
   * 这样单次调用的评估量 ≈ C(n,k) × k × |pool|，n=7/k=2 时约 21×2×28 ≈ 1200 次。
   */
  function ruinRecreate(ev, slots, params, cands, hs, opt) {
    const o = opt || {};
    const opt2 = o;
    const ns = slots.length;
    const maxK = Math.min(o.ruinK || 2, ns - 1);
    const pool = allJadeIds();
    let best = null;
    let bestVal = ev.evalSlots(slots).value;
    const startVal = bestVal;

    const idxAll = slots.map((s, i) => i).filter(i => slots[i]);
    for (let k = 1; k <= maxK; k++) {
      /* 枚举要抠掉的位置组合 */
      const combosOfIdx = kCombinations(idxAll, k);
      for (const removed of combosOfIdx) {
        const trial = slots.slice();
        removed.forEach(i => { trial[i] = null; });
        const keep = new Set(trial.filter(Boolean).map(s => s.jadeId));
        const freeSlots = trial.map((s, i) => (s ? -1 : i)).filter(i => i >= 0);

        /* 贪心重建：每次填一个空位，选加分最多的玉 */
        let cur = trial.slice();
        let curVal = ev.evalSlots(cur).value;
        const tplsR = (opt2 && opt2.tpls) || fillTemplates(ev, cands ? (cands.__all || []) : []);
        for (const pos of freeSlots) {
          let bestCand = null, bestGain = 0, bestSubs = null;
          for (const cand of pool) {
            if (keep.has(cand)) continue;
            for (const tpl of tplsR) {
              const t2 = cur.slice();
              t2[pos] = makeSlot(cand, params.element, tpl);
              const v = ev.evalSlots(t2).value;
              if (v > curVal + 1e-9 && v - curVal > bestGain) { bestGain = v - curVal; bestCand = cand; bestSubs = tpl; }
            }
          }
          if (!bestCand) break;
          cur[pos] = makeSlot(bestCand, params.element, bestSubs);
          keep.add(bestCand);
          curVal = ev.evalSlots(cur).value;
        }
        if (curVal > bestVal + 1e-9) { bestVal = curVal; best = cur; }
      }
    }

    if (!best) { if (startVal > 0) void startVal; return null; }

    /* 赢家做全枚举精修 */
    const refined = optimizeWords(ev, best, { candidates: cands, maxPass: 4 });
    return refined.value > startVal + 1e-9 ? refined : null;
  }

  function kCombinations(arr, k) {
    const res = [];
    const pick = [];
    (function rec(start) {
      if (pick.length === k) { res.push(pick.slice()); return; }
      for (let i = start; i < arr.length; i++) { pick.push(arr[i]); rec(i + 1); pick.pop(); }
    })(0);
    return res;
  }

  /* ------------------------------------------------------------------ *
   * ⑤c 池枚举：单练 top-K 全组合粗排 → 前 N 全枚举精修
   * ------------------------------------------------------------------ */
  /**
   * 为什么需要它：
   * 贪心 / 换玉下降都是「单点」移动，遇到「必须同时换 3~4 颗才更优」的
   * 组合陷阱会卡住。这里退一步：把单练分前 K 颗玉的 C(K,7) 种组合全列出来，
   * 用两套词条模板做 O(1) 粗排，只对前 N 名做全枚举精修。
   * K=14 时粗排 3432 套只要 ~160ms，能把贪心漏掉的组合直接纳入候选。
   */
  function poolEnumerate(ev, params, cands, o) {
    const opt = o || {};
    const K = Math.min(opt.poolSize || 14, allJadeIds().length);
    const N_REFINE = opt.refineN || 16;
    const per = params.slotCount;
    if (K < per) return null;

    const allC = (cands && (cands.__all || [])) || [];
    const tpls = fillTemplates(ev, allC).slice(0, 4);
    const one = new Array(per).fill(null);
    const solo = allJadeIds().map(id => {
      one[0] = makeSlot(id, params.element, tpls[0] || []);
      return { id, v: ev.evalSlots(one).value };
    }).sort((a, b) => b.v - a.v);
    one[0] = null;
    const pool = solo.slice(0, K).map(x => x.id);

    /* 粗排 */
    const coarse = [];
    for (const ids of kCombinations(pool, per)) {
      let best = -Infinity;
      for (const tpl of tpls) {
        const slots = ids.map(id => makeSlot(id, params.element, tpl));
        const v = ev.evalSlots(slots).value;
        if (v > best) best = v;
      }
      coarse.push({ ids, v: best });
    }
    coarse.sort((a, b) => b.v - a.v);

    /* 精修前 N */
    let bestRes = null;
    for (const item of coarse.slice(0, N_REFINE)) {
      const slots = item.ids.map(id => makeSlot(id, params.element, []));
      const r = optimizeWords(ev, slots, { candidates: cands, maxPass: 3 });
      if (!bestRes || r.value > bestRes.value) bestRes = r;
    }
    return bestRes;
  }

  /* ------------------------------------------------------------------ *
   * ⑥ 换玉下降（启发式粗筛 Top-K → 全枚举精修）
   * ------------------------------------------------------------------ */
  function improveSet(ev, slots, params, o) {
    const opt = o || {};
    const cands = opt.candidates || null;
    const maxRounds = opt.maxRounds || 3;
    const topK = opt.topK || 6;          // 每个槽位精修多少名候选
    const useLns = opt.lns !== false;    // 卡住后是否启用破坏-重建
    const cache = {};
    const allC = (cands && (cands.__all || cands[allJadeIds()[0]])) || [];
    const hs = heuristicSubs(ev, allC, cache);
    const tpls = fillTemplates(ev, allC);
    let cur = slots.slice();
    let curVal = ev.evalSlots(cur).value;
    const pool = allJadeIds();

    for (let round = 0; round < maxRounds; round++) {
      let bestSlots = null;
      let bestVal = curVal;
      const used = new Set(cur.filter(Boolean).map(s => s.jadeId));

      for (let i = 0; i < cur.length; i++) {
        const s = cur[i];
        if (!s) continue;
        /* ① 粗筛：全部候选玉用多套填法模板打分取最大，再取 Top-K */
        const scored = [];
        for (const cand of pool) {
          if (used.has(cand)) continue;
          let v = -Infinity;
          for (const tpl of tpls) {
            const trial = cur.slice();
            trial[i] = makeSlot(cand, params.element, tpl);
            const x = ev.evalSlots(trial).value;
            if (x > v) v = x;
          }
          scored.push({ cand, v });
        }
        scored.sort((a, b) => b.v - a.v);

        /* ② 精修：只对 Top-K 做全枚举，赢家才计入 */
        for (const item of scored.slice(0, topK)) {
          const trial = cur.slice();
          trial[i] = makeSlot(item.cand, params.element, []);
          const refined = optimizeWords(ev, trial, {
            candidates: cands, maxPass: 3, onlySlots: [i],
          });
          if (refined.value > bestVal + 1e-9) { bestVal = refined.value; bestSlots = refined.slots; }
        }
      }

      if (bestSlots) {
        cur = bestSlots;
        curVal = bestVal;
        /* 每轮结束再做一次全槽位精修，避免「逐位精修」留下的局部最优 */
        const all = optimizeWords(ev, cur, { candidates: cands, maxPass: 4 });
        if (all.value > curVal + 1e-9) { cur = all.slots; curVal = all.value; }
      } else if (!opt.lns) {
        break;
      }

      /* 单点下降卡住时：破坏-重建（ruin & recreate）
         —— 抠掉 k 颗玉，用全局贪心重新填满。能跳出「必须同时换 3~4 颗
            才更优」的坑，正是单点/两点下降跨不过去的那种。 */
      if (opt.lns) {
        const better = ruinRecreate(ev, cur, params, cands, hs, opt);
        if (better && better.value > curVal + 1e-9) { cur = better.slots; curVal = better.value; }
      }

      EXT.emit('optimizer-round', { round: round + 1, value: curVal });
      if (!bestSlots && !opt.lns) break;
    }
    const m = ev.evalSlots(cur);
    return { slots: cur, metrics: m.metrics, dps: m.dps, value: m.value };
  }

  /* ------------------------------------------------------------------ *
   * 主流程
   * ------------------------------------------------------------------ */
  const DEFAULT_OPTIONS = {
    objective: 'dps',
    slotCounts: [7],
    elements: ['ice', 'thunder', 'poison'],
    weapons: ['melee', 'cannon', 'bow', 'zhanmadao'],
    useSeeds: true,
    swapRounds: 2,
    topReport: 6,
    budgetMs: 25000,
    expandSlots: true,     // 胜出口径再额外扫 4~8 槽位
    seedKeep: 6,           // 几个种子进换玉下降
    restarts: 3,           // 贪心多起点重启次数
    poolEnum: true,        // 是否启用「单练池全组合」种子
    poolSize: 14,          // 池枚举用单练前多少颗
    refineN: 16,           // 粗排后精修多少名
    soloSeed: true,
  };

  const yieldTick = () => new Promise(res => global.setTimeout(res, 0));

  async function solve(baseConfig, options, onProgress) {
    const t0 = now();
    const opt = Object.assign({}, DEFAULT_OPTIONS, options || {});
    const baseParams = EXT.normalizeParams((baseConfig && baseConfig.params) || {});
    const report = (stage, pct, detail, best) => {
      if (typeof onProgress === 'function') onProgress({ stage, pct, detail: detail || '', best: best || null });
    };

    const ranking = [];
    let bestOverall = null;
    let bestVal = -Infinity;
    let totalEvals = 0;

    const run = async (combo, pct) => {
      const params = Object.assign({}, baseParams, {
        element: combo.element, weapon: combo.weapon, slotCount: combo.slotCount,
      });
      const ev = makeEvaluator(params, opt.objective);
      const cands = {};
      const all = [];
      EXT.host().JADES.forEach(j => {
        const c = candidateAffixes(params, j.id, opt.objective);
        cands[j.id] = c;
        c.forEach(x => { if (!all.includes(x)) all.push(x); });
      });
      cands.__all = all;

      const seeds = [];
      if (opt.useSeeds) {
        EXT.host().PRESETS.forEach(pr => {
          const cfg = presetToConfig(pr, params);
          if (cfg.params.slotCount !== params.slotCount) return;
          const r = optimizeWords(ev, cfg.slots, { candidates: cands, maxPass: 2 });
          seeds.push({ tag: `preset:${pr.id}`, ...r });
        });
      }

      /* 增量贪心（主种子）：每步全局选最优，能抓到单练不出彩但成体系的玉 */
      seeds.push({ tag: 'greedy', ...greedySet(ev, params, cands) });

      /* 多起点重启：按固定种子打乱候选顺序再跑几轮，跳出贪心路径依赖 */
      const restarts = opt.restarts == null ? 3 : opt.restarts;
      const pool = allJadeIds();
      for (let ri = 0; ri < restarts; ri++) {
        const rng = makeRng(0x9e3779b9 ^ (ri + 1) * 2654435761 ^ combo.slotCount * 40503);
        seeds.push({ tag: `greedy#${ri + 1}`, ...greedySet(ev, params, cands, shuffled(pool, rng)) });
      }
      if (opt.soloSeed !== false) {
        seeds.push({ tag: 'solo', ...soloSeed(ev, params, cands) });
        const rng2 = makeRng(0x85ebca6b ^ combo.slotCount * 1315423911);
        seeds.push({ tag: 'solo#1', ...soloSeedShuffled(ev, params, cands, rng2) });
      }
      if (opt.poolEnum !== false) {
        const pe = poolEnumerate(ev, params, cands, {
          poolSize: opt.poolSize, refineN: opt.refineN,
        });
        if (pe) seeds.push({ tag: 'pool', ...pe });
      }

      seeds.sort((a, b) => b.value - a.value);

      /* 换玉下降：对所有不重复的种子做，便宜的粗筛让它撑得住 */
      const keep = opt.seedKeep || 4;
      const topSeeds = seeds.slice(0, Math.max(1, Math.min(keep, seeds.length)));
      const seenSets = new Set();
      for (const seed of topSeeds) {
        const sig = seed.slots.map(s => (s ? s.jadeId : '∅')).join(',');
        if (seenSets.has(sig)) continue;
        seenSets.add(sig);
        const r = improveSet(ev, seed.slots, params, { candidates: cands, maxRounds: opt.swapRounds });
        const entry = {
          tag: `${seed.tag}→swap`, params, slots: r.slots, metrics: r.metrics,
          dps: r.dps, value: r.value,
        };
        ranking.push(entry);
        if (r.value > bestVal + 1e-9) { bestVal = r.value; bestOverall = entry; }
      }

      totalEvals += ev.evals;
      report('search', pct,
        `${EXT.ELEMENT_NAMES[combo.element]}·${EXT.WEAPON_NAMES[combo.weapon]}·${combo.slotCount}槽` +
        ` · ${ev.evals} 评估`, bestOverall);
      await yieldTick();
      return now() - t0;
    };

    const combos = [];
    opt.elements.forEach(el => opt.weapons.forEach(wp => opt.slotCounts.forEach(sc => {
      combos.push({ element: el, weapon: wp, slotCount: sc });
    })));
    let done = 0;
    for (const c of combos) {
      const elapsed = await run(c, (done / combos.length) * 100);
      done++;
      if (elapsed > opt.budgetMs) {
        report('budget', (done / combos.length) * 100, '达到时间预算，提前收敛', bestOverall);
        break;
      }
    }

    /* 胜出口径再扩扫槽位数 */
    if (opt.expandSlots && bestOverall && opt.slotCounts.length === 1) {
      const win = bestOverall.params;
      for (const sc of [4, 5, 6, 8]) {
        if (sc === win.slotCount) continue;
        await run({ element: win.element, weapon: win.weapon, slotCount: sc }, 100);
        if (now() - t0 > opt.budgetMs) break;
      }
    }

    /* --- 去重排序 --- */
    ranking.sort((a, b) => b.value - a.value);
    const seen = new Set();
    const top = [];
    for (const r of ranking) {
      const sig = EXT.signature({ params: r.params, slots: r.slots });
      if (seen.has(sig)) continue;
      seen.add(sig);
      top.push({
        rank: top.length + 1, tag: r.tag, params: r.params, slots: r.slots,
        metrics: r.metrics, dps: r.dps, value: r.value, sig,
      });
      if (top.length >= opt.topReport) break;
    }

    const elapsedMs = Math.round(now() - t0);
    report('done', 100, `完成 · ${totalEvals} 次评估 · ${elapsedMs}ms`, bestOverall);
    return {
      best: bestOverall ? {
        params: bestOverall.params, slots: bestOverall.slots,
        metrics: bestOverall.metrics, tag: bestOverall.tag, dps: bestOverall.dps,
      } : null,
      ranking: top,
      stats: { evals: totalEvals, elapsedMs, combos: combos.length, objective: opt.objective },
    };
  }

  EXT.solve = solve;
  EXT.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
  EXT.__debug = { improveSet, greedySet, soloSeed, makeEvaluator, optimizeWords, ruinRecreate };

  /* ------------------------------------------------------------------ *
   * 快速优化「当前这一套」：魂玉不动，只把词条拉到最优
   * ------------------------------------------------------------------ */
  function polishCurrent(cfg, options) {
    const o = options || {};
    const norm = EXT.normalizeConfig(cfg);
    const ev = makeEvaluator(norm.params, o.objective || 'dps');
    const r = optimizeWords(ev, norm.slots, { objective: o.objective || 'dps', maxPass: 4 });
    return { params: norm.params, slots: r.slots, metrics: r.metrics };
  }
  EXT.polishCurrent = polishCurrent;
})(window);
