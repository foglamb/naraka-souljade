/* =========================================================================
 * 二改 v2.2 · 固定阵容优化器
 * -------------------------------------------------------------------------
 * 需求：在「你已选的魂玉集合 + 已选稀有词条」基础上找最优，魂玉数量不变。
 *
 * 锁定规则（严格模式，用户需求原话）：
 *   · 魂玉集合与顺序：不换玉、不增删、不改槽位位置
 *   · 稀有词条：用户已选的合道/枚卜/化气 按原数量、原位置保留
 *     —— 用户选了几条合道，结果就有几条合道；枚卜同理
 *   · 普通词条：完全放开（这是优化主体）
 *   · 染元素：默认保留用户的选择；只有「玉本身无固定元素绑定」时才允许
 *     尝试换染色（默认关，开 lockElement 关掉）
 *   · 词条数值：一律拉满（满值必然不劣）
 *
 * 实现路径：完全复用主求解器的全枚举引擎 optimizeWords()，
 * 只是每颗玉的候选池换成「普通词条全集 ∪ 用户已选稀有词条」，
 * 再按位置硬约束已选稀有词条 → 保证数量与位置不变。
 * ========================================================================= */
(function (global) {
  'use strict';

  const EXT = global.NSJExt;
  if (!EXT) throw new Error('[NSJExt.locked] 需要先加载 nsj-ext-core.js');

  const RARE_IDS = new Set(['hedao', 'huaqi', 'meibu']);
  const isRareId = id => RARE_IDS.has(id);

  /* ------------------------------------------------------------------ *
   * 每颗玉的「允许词条」列表
   * ------------------------------------------------------------------ */
  /**
   * @param {object} slot      用户当前的槽位（含 subs）
   * @param {object} params    求解参数（决定 DPS 剪枝口径）
   * @param {object} o         { allowRareSwap: 是否允许在稀有词条之间换位置 }
   * @returns {string[]}       该玉 4 格允许填的词条 id（含重复项表达多选稀有）
   */
  function allowedSubsFor(slot, params, o) {
    const opt = o || {};
    const all = EXT.candidateAffixes(params, slot.jadeId, 'dps');
    const normals = all.filter(id => !isRareId(id));
    const usersRares = (slot.subs || []).filter(id => isRareId(id));   // 用户已选的稀有，按位置顺序

    /* 每一格：若原本就是稀有 → 允许「它自己 ∪（可选：其它已选稀有）」；否则 → 普通全集 */
    const out = [];
    (slot.subs || []).slice(0, 4).forEach((cur, i) => {
      if (cur && isRareId(cur)) {
        if (opt.allowRareSwap) {
          /* 稀有词条之间可以互换位置（数量不变，位置可换） */
          usersRares.forEach(r => { if (!out.includes(r)) out.push(r); });
        } else {
          if (!out.includes(cur)) out.push(cur);
        }
      } else {
        normals.forEach(n => { if (!out.includes(n)) out.push(n); });
      }
    });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 按位置约束生成填法枚举
   * ------------------------------------------------------------------ */
  /**
   * 枚举「这颗玉 4 格」的合法填法：
   *  · 稀有格：固定为用户原选（或 allowRareSwap 时在已选稀有间排列）
   *  · 普通格：从 normals 里选不重复的填入
   * 返回的是「普通格选哪几个普通词条」的组合，稀有格由调用方按位回填。
   */
  function* lockedCombos(slot, params, o) {
    const opt = o || {};
    const all = EXT.candidateAffixes(params, slot.jadeId, 'dps');
    const normals = all.filter(id => !isRareId(id));
    const subs = (slot.subs || []).slice(0, 4);
    const rarePositions = [];
    subs.forEach((id, i) => { if (id && isRareId(id)) rarePositions.push(i); });
    const normalPositions = [];
    subs.forEach((id, i) => { if (!id || !isRareId(id)) normalPositions.push(i); });

    const nNormal = normalPositions.length;
    /* 普通格全枚举：从 normals 里选 nNormal 个不重复（同玉普通词条不重复） */
    const usersRares = subs.filter(id => id && isRareId(id));

    function* kPicks(arr, k, start, acc) {
      if (acc.length === k) { yield acc.slice(); return; }
      for (let i = start; i < arr.length; i++) {
        acc.push(arr[i]);
        yield* kPicks(arr, k, i + 1, acc);
        acc.pop();
      }
    }

    if (nNormal === 0) {
      /* 全是稀有格：位置固定（或允许交换时给排列）—— 统一回填成 {rares, normals} */
      if (opt.allowRareSwap && rarePositions.length > 1) {
        for (const p of permute(usersRares)) yield { rares: p, normals: [] };
      } else {
        yield { rares: usersRares, normals: [] };
      }
      return;
    }

    for (const picks of kPicks(normals, nNormal, 0, [])) {
      yield { rares: usersRares.slice(), normals: picks };
    }

    function* permute(arr) {
      if (arr.length <= 1) { yield arr.slice(); return; }
      for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permute(rest)) yield [arr[i]].concat(p);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 把枚举结果回填成完整槽位
   * ------------------------------------------------------------------ */
  function buildSlotWithCombo(slot, combo, element, params, o) {
    const opt = o || {};
    const subs = (slot.subs || []).slice(0, 4);
    const rarePositions = [];
    subs.forEach((id, i) => { if (id && isRareId(id)) rarePositions.push(i); });
    const normalPositions = [];
    subs.forEach((id, i) => { if (!id || !isRareId(id)) normalPositions.push(i); });

    const out = new Array(4).fill(null);
    /* 关键：combo.rares 的长度必须等于 rarePositions 的长度；
       permute 打乱后仍是同一多重集，只是位置重排 —— 逐位回填即可 */
    if (combo.rares.length !== rarePositions.length) {
      /* 防御：长度不符时按多重集从原槽位恢复，保证锁定不破 */
      subs.forEach((id, i) => { if (id && isRareId(id)) out[i] = id; });
    } else {
      rarePositions.forEach((pos, i) => { out[pos] = combo.rares[i] || null; });
    }
    normalPositions.forEach((pos, i) => { out[pos] = combo.normals[i] || null; });

    return EXT.makeSlot(slot.jadeId, element, out);
  }

  /* ------------------------------------------------------------------ *
   * 单颗玉：固定阵容下的最优词条（全枚举）
   * ------------------------------------------------------------------ */
  function bestSubsForLocked(ev, slots, idx, o) {
    const opt = o || {};
    const base = slots.slice();
    const slot = base[idx];
    const params = ev.params;
    const element = opt.keepElement === false ? params.element : slot.element;
    let best = null, bestVal = -Infinity;

    for (const combo of lockedCombos(slot, params, opt)) {
      const trial = base.slice();
      trial[idx] = buildSlotWithCombo(slot, combo, element, params, opt);
      const r = ev.evalSlots(trial);
      if (r.value > bestVal + 1e-9) { bestVal = r.value; best = combo; }
    }
    base[idx] = slot;
    return { combo: best, value: bestVal };
  }

  /* ------------------------------------------------------------------ *
   * 整套：坐标下降到不动点（固定阵容）
   * ------------------------------------------------------------------ */
  function optimizeLocked(ev, slots, o) {
    const opt = o || {};
    let cur = slots.map(s => (s ? EXT.makeSlot(s.jadeId, s.element, s.subs) : null));
    let curVal = ev.evalSlots(cur).value;

    const order = cur.map((s, i) => i).filter(i => cur[i]);
    for (let pass = 0; pass < (opt.maxPass || 4); pass++) {
      let improved = false;
      for (const i of order) {
        const r = bestSubsForLocked(ev, cur, i, opt);
        if (r.combo && r.value > curVal + 1e-9) {
          const slot = cur[i];
          const element = opt.keepElement === false ? ev.params.element : slot.element;
          cur[i] = buildSlotWithCombo(slot, r.combo, element, ev.params, opt);
          curVal = r.value;
          improved = true;
        }
      }
      if (!improved) break;
    }
    const m = ev.evalSlots(cur);
    return { slots: cur, metrics: m.metrics, dps: m.dps, value: m.value };
  }

  /* ------------------------------------------------------------------ *
   * 校验：锁定约束是否被满足（自检用）
   * ------------------------------------------------------------------ */
  function verifyLocked(before, after) {
    const errs = [];
    if (before.length !== after.length) errs.push('槽位数不一致');
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      const a = before[i], b = after[i];
      if (!!a !== !!b) { errs.push(`槽 ${i + 1} 有无玉不一致`); continue; }
      if (!a) continue;
      if (a.jadeId !== b.jadeId) errs.push(`槽 ${i + 1} 换了玉：${a.jadeId} → ${b.jadeId}`);
      const ra = (a.subs || []).filter(id => isRareId(id));
      const rb = (b.subs || []).filter(id => isRareId(id));
      const ca = {}, cb = {};
      ra.forEach(x => ca[x] = (ca[x] || 0) + 1);
      rb.forEach(x => cb[x] = (cb[x] || 0) + 1);
      const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
      keys.forEach(k => {
        if ((ca[k] || 0) !== (cb[k] || 0)) errs.push(`槽 ${i + 1} 稀有词条 ${k} 数量变化 ${ca[k] || 0} → ${cb[k] || 0}`);
      });
    }
    return { ok: errs.length === 0, errs };
  }

  /* ------------------------------------------------------------------ *
   * 对外主入口
   * ------------------------------------------------------------------ */
  /**
   * 固定阵容求最优。
   * @param {object} cfg    当前配装（会取 slots 与 params）
   * @param {object} opts   { allowRareSwap: 稀有词条之间允许换位置, keepElement: 染元素跟随原槽位 }
   * @returns {Promise<{params, slots, metrics, before, after, checks}>}
   */
  async function solveLocked(cfg, opts) {
    const opt = Object.assign({ allowRareSwap: false, keepElement: true }, opts || {});
    const norm = EXT.normalizeConfig(cfg);
    const ev = EXT.makeEvaluator(norm.params, 'dps');
    const before = norm.slots.map(s => (s ? EXT.makeSlot(s.jadeId, s.element, s.subs) : null));
    const beforeVal = ev.evalSlots(before).value;

    const r = optimizeLocked(ev, before, opt);
    const checks = verifyLocked(before, r.slots);
    if (!checks.ok) {
      throw new Error('固定约束校验失败：' + checks.errs.join('；'));
    }

    return {
      params: norm.params,
      slots: r.slots,
      metrics: r.metrics,
      before: { value: beforeVal, metrics: ev.evalSlots(before).metrics, slots: before },
      after: { value: r.value, metrics: r.metrics, slots: r.slots },
      gain: r.value - beforeVal,
      checks,
      stats: { evals: ev.evals, elapsedMs: 0 },
    };
  }
  EXT.solveLocked = solveLocked;
  EXT.verifyLocked = verifyLocked;
})(window);
