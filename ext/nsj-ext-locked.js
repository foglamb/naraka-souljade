/* 固定阵容分析：魂玉、槽位、染色、稀有词条及其实填值保持不变。
 * allowedAffixes 是勾选的普通词条候选池；缺省时兼容原有固定阵容求解。
 * 逐玉枚举普通词条组合并迭代改善，返回当前约束下找到的方案，不声称全局最优。
 */
(function (global) {
  'use strict';
  const EXT = global.NSJExt;
  const rareIds = new Set(['hedao', 'huaqi', 'meibu']);
  const isRare = id => rareIds.has(id);
  const clone = x => EXT.clone(x);
  const clock = () => global.performance ? global.performance.now() : Date.now();

  function* combinations(pool, count, start = 0, picked = []) {
    if (picked.length === count) { yield picked.slice(); return; }
    for (let i = start; i <= pool.length - (count - picked.length); i++) {
      picked.push(pool[i]);
      yield* combinations(pool, count, i + 1, picked);
      picked.pop();
    }
  }

  function verifyLocked(before, after, allowedAffixes) {
    const errs = [];
    if (before.length !== after.length) errs.push('槽位数被改变');
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = after[i];
      if (!a || !b) {
        if (!!a !== !!b) errs.push(`第 ${i + 1} 槽魂玉数量被改变`);
        continue;
      }
      if (a.jadeId !== b.jadeId) errs.push(`第 ${i + 1} 槽魂玉被改变`);
      if (a.element !== b.element) errs.push(`第 ${i + 1} 槽染元素被改变`);
      const normals = [];
      for (let k = 0; k < 4; k++) {
        const oldId = a.subs[k], newId = b.subs[k];
        if (isRare(oldId)) {
          if (oldId !== newId || a.vals[k] !== b.vals[k]) errs.push(`第 ${i + 1} 槽稀有词条或数值被改变`);
        } else if (isRare(newId)) {
          errs.push(`第 ${i + 1} 槽新增了稀有词条`);
        } else if (newId) {
          normals.push(newId);
          if (allowedAffixes && !allowedAffixes.includes(newId)) errs.push(`出现未勾选词条 ${newId}`);
        }
      }
      if (new Set(normals).size !== normals.length) errs.push(`第 ${i + 1} 槽普通词条重复`);
    }
    return { ok: errs.length === 0, errs };
  }

  async function solveLocked(config, options) {
    const started = clock();
    const opts = options || {};
    const norm = EXT.normalizeConfig(config);
    const before = clone(norm.slots);
    const allIds = EXT.host().AFFIXES.map(a => a.id);
    const pool = [...new Set(opts.allowedAffixes === undefined
      ? EXT.candidateAffixes(norm.params, null, 'dps').filter(id => allIds.includes(id))
      : opts.allowedAffixes)];
    if (pool.some(id => !allIds.includes(id))) throw new Error('勾选列表包含无效的普通词条');
    const active = before.map((s, i) => s ? i : -1).filter(i => i >= 0);
    const editable = Array.isArray(opts.onlySlots) ? active.filter(i => opts.onlySlots.includes(i)) : active;
    const freePositions = slot => [0, 1, 2, 3].filter(i => !isRare(slot.subs[i]));
    const needsNormals = active.some(i => freePositions(before[i]).length);
    if (needsNormals && !pool.length) throw new Error('请至少勾选一种普通词条');

    const cache = new Map();
    let evals = 0;
    function measure(slots) {
      const key = JSON.stringify(slots);
      if (!cache.has(key)) {
        evals++;
        cache.set(key, EXT.measure({ params: norm.params, slots }));
      }
      return cache.get(key);
    }
    // 候选不足时保留空格，不借用未勾选词条，不添加稀有词条凑满。
    function withNormals(original, values) {
      const next = clone(original);
      freePositions(original).forEach((pos, i) => {
        next.subs[pos] = values[i] || null;
        next.vals[pos] = null;
      });
      return next;
    }
    let cur = before.map(slot => {
      if (!slot) return null;
      const retained = slot.subs.filter(id => id && !isRare(id) && pool.includes(id));
      const choices = [...new Set(retained.concat(pool))].slice(0, freePositions(slot).length);
      return withNormals(slot, choices);
    });
    const beforeMetrics = measure(before);
    let currentValue = measure(cur).dps;
    const passes = Math.max(1, Math.min(12, opts.maxPass || 6));
    for (let pass = 0; pass < passes; pass++) {
      let improved = false;
      for (const index of editable) {
        const slotsToFill = freePositions(before[index]).length;
        let bestSlot = cur[index], bestValue = currentValue;
        for (const words of combinations(pool, Math.min(slotsToFill, pool.length))) {
          const trial = cur.slice();
          trial[index] = withNormals(before[index], words);
          const value = measure(trial).dps;
          if (value > bestValue + 1e-9) { bestValue = value; bestSlot = trial[index]; }
        }
        if (bestValue > currentValue + 1e-9) {
          cur[index] = bestSlot;
          currentValue = bestValue;
          improved = true;
        }
      }
      if (!improved) break;
    }
    const checks = verifyLocked(before, cur, pool);
    if (!checks.ok) throw new Error('固定阵容校验失败：' + checks.errs.join('；'));
    const afterMetrics = measure(cur);
    return {
      params: clone(norm.params), slots: cur, metrics: afterMetrics,
      before: { value: beforeMetrics.dps, metrics: beforeMetrics, slots: before },
      after: { value: afterMetrics.dps, metrics: afterMetrics, slots: cur },
      gain: afterMetrics.dps - beforeMetrics.dps, checks, allowedAffixes: pool,
      stats: { evals, elapsedMs: Math.round(clock() - started) },
    };
  }
  EXT.solveLocked = solveLocked;
  EXT.verifyLocked = verifyLocked;
})(window);
