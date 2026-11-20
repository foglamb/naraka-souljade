/* 固定魂玉阵容，按用户指定的稀有词条总数分配；普通词条只来自勾选池。
 * 数量是精确约束，不是上限。有限预算内做普通词条枚举和稀有词条移动/交换。
 * 旧有稀有词条实填值随词条移动；新增条目按满值估算。预览不写工作区。
 */
(function (global) {
  'use strict';
  const EXT = global.NSJExt;
  const TYPES = ['hedao', 'huaqi', 'meibu'];
  const isRare = id => TYPES.includes(id);
  const copy = value => EXT.clone(value);
  const now = () => global.performance ? global.performance.now() : Date.now();

  function countRares(slots) {
    const counts = { hedao: 0, huaqi: 0, meibu: 0 };
    (slots || []).filter(Boolean).forEach(slot => (slot.subs || []).forEach(id => {
      if (isRare(id)) counts[id]++;
    }));
    return counts;
  }
  function validateCounts(counts, capacity) {
    const result = {};
    for (const type of TYPES) {
      const n = counts && counts[type] !== undefined ? counts[type] : 0;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
        throw new Error('稀有词条数量必须是大于等于 0 的整数');
      }
      result[type] = n;
    }
    const total = TYPES.reduce((sum, type) => sum + result[type], 0);
    if (total > capacity) throw new Error(`稀有词条共 ${total} 条，但已选魂玉最多容纳 ${capacity} 条，请减少数量`);
    return result;
  }

  function verifyRareCounts(before, after, allowed, target) {
    const errs = [];
    if (before.length !== after.length) errs.push('槽位数被改变');
    for (let i = 0; i < before.length; i++) {
      const a = before[i], b = after[i];
      if (!a || !b) { if (!!a !== !!b) errs.push(`第 ${i + 1} 槽魂玉数量被改变`); continue; }
      if (a.jadeId !== b.jadeId) errs.push(`第 ${i + 1} 槽魂玉被改变`);
      if (a.element !== b.element) errs.push(`第 ${i + 1} 槽染元素被改变`);
      if (!Array.isArray(b.subs) || b.subs.length !== 4) { errs.push('每颗魂玉必须恰好有 4 格'); continue; }
      const normals = b.subs.filter(id => id && !isRare(id));
      if (new Set(normals).size !== normals.length) errs.push(`第 ${i + 1} 槽普通词条重复`);
      if (normals.some(id => !allowed.includes(id))) errs.push('出现未勾选的普通词条');
    }
    const actual = countRares(after);
    TYPES.forEach(type => { if (actual[type] !== target[type]) errs.push(`稀有词条 ${type} 数量未按指定值分配`); });
    return { ok: !errs.length, errs, actual };
  }

  async function solveRareCounts(config, options) {
    const started = now(), opts = options || {};
    const norm = EXT.normalizeConfig(config);
    const before = copy(norm.slots);
    const active = before.map((slot, i) => slot ? i : -1).filter(i => i >= 0);
    const target = validateCounts(opts.rareCounts, active.length * 4);
    const allNormals = EXT.host().AFFIXES.map(affix => affix.id);
    const allowed = [...new Set(opts.allowedAffixes === undefined
      ? EXT.candidateAffixes(norm.params, null, 'dps').filter(id => allNormals.includes(id)) : opts.allowedAffixes)];
    if (allowed.some(id => !allNormals.includes(id))) throw new Error('勾选列表包含无效的普通词条');
    const total = TYPES.reduce((sum, type) => sum + target[type], 0);
    if (active.length * 4 > total && !allowed.length) throw new Error('还有普通词条空位，请至少勾选一种普通词条');
    const remaining = { ...target }, seeded = copy(before);
    for (const i of active) {
      for (let k = 0; k < 4; k++) {
        const id = seeded[i].subs[k];
        if (!isRare(id)) continue;
        if (remaining[id] > 0) remaining[id]--;
        else { seeded[i].subs[k] = null; seeded[i].vals[k] = null; }
      }
    }
    // 先建立数量完全正确的可行起点；随后计算移动到哪颗玉收益更高。
    for (const type of TYPES) {
      while (remaining[type] > 0) {
        const candidates = active.filter(i => seeded[i].subs.some(id => !isRare(id)));
        candidates.sort((a, b) => seeded[a].subs.filter(isRare).length - seeded[b].subs.filter(isRare).length || a - b);
        const i = candidates[0];
        if (i === undefined) throw new Error('当前魂玉无法容纳指定数量');
        const k = seeded[i].subs.findIndex(id => !isRare(id));
        seeded[i].subs[k] = type;
        seeded[i].vals[k] = null;
        remaining[type]--;
      }
    }
    const cancelled = () => typeof opts.isCancelled === 'function' && opts.isCancelled();
    const checkCancelled = () => { if (cancelled()) throw new Error('分析已更新'); };
    const refine = async (slots, onlySlots) => {
      checkCancelled();
      const result = await EXT.solveLocked({ params: norm.params, slots }, {
        allowedAffixes: allowed, onlySlots, maxPass: 2,
      });
      evaluations += result.stats.evals;
      return result;
    };
    let evaluations = 0, candidatesTested = 0, limited = false;
    let current = await refine(seeded);
    const evaluationBudget = Math.max(100, opts.evaluationBudget || 6500);
    const candidateBudget = Math.max(1, opts.candidateBudget || 140);
    const timeBudget = Math.max(20, opts.timeBudgetMs || 450);
    const exhausted = () => evaluations >= evaluationBudget || candidatesTested >= candidateBudget || now() - started >= timeBudget;
    let lastYield = now();
    for (let pass = 0; pass < 2; pass++) {
      let best = current;
      const seen = new Set();
      async function consider(trial, changed) {
        const key = JSON.stringify(trial);
        if (seen.has(key)) return;
        seen.add(key);
        const result = await refine(trial, changed);
        candidatesTested++;
        if (result.metrics.dps > best.metrics.dps + 1e-9) best = result;
        if (now() - lastYield > 12) {
          await new Promise(resolve => global.setTimeout(resolve, 0));
          lastYield = now();
          checkCancelled();
        }
      }
      outer: for (const i of active) {
        for (let k = 0; k < 4; k++) {
          const id = current.slots[i].subs[k];
          if (!isRare(id)) continue;
          for (const j of active) {
            if (i === j) continue;
            // 一次移动只需要一个普通格，随后会重新枚举该玉的全部普通词条。
            const normalIndex = current.slots[j].subs.findIndex(word => !isRare(word));
            if (normalIndex >= 0) {
              if (exhausted()) { limited = true; break outer; }
              const trial = copy(current.slots);
              trial[i].subs[k] = null; trial[i].vals[k] = null;
              trial[j].subs[normalIndex] = id; trial[j].vals[normalIndex] = current.slots[i].vals[k];
              await consider(trial, [i, j]);
            }
            if (j < i) continue;
            for (let l = 0; l < 4; l++) {
              const other = current.slots[j].subs[l];
              if (!isRare(other) || other === id) continue;
              if (exhausted()) { limited = true; break outer; }
              const trial = copy(current.slots);
              [trial[i].subs[k], trial[j].subs[l]] = [trial[j].subs[l], trial[i].subs[k]];
              [trial[i].vals[k], trial[j].vals[l]] = [trial[j].vals[l], trial[i].vals[k]];
              await consider(trial, [i, j]);
            }
          }
        }
      }
      const improved = best.metrics.dps > current.metrics.dps + 1e-9;
      current = best;
      if (limited || !improved) break;
    }
    checkCancelled();
    const checks = verifyRareCounts(before, current.slots, allowed, target);
    if (!checks.ok) throw new Error('数量校验失败：' + checks.errs.join('；'));
    const beforeMetrics = EXT.metricsOf({ params: norm.params, slots: before });
    return {
      params: copy(norm.params), slots: current.slots, metrics: current.metrics,
      before: { slots: before, metrics: beforeMetrics, value: beforeMetrics.dps },
      after: { slots: current.slots, metrics: current.metrics, value: current.metrics.dps },
      gain: current.metrics.dps - beforeMetrics.dps, allowedAffixes: allowed,
      targetRareCounts: target, checks,
      stats: { evals: evaluations, elapsedMs: Math.round(now() - started), limited, candidates: candidatesTested },
    };
  }
  EXT.countRares = countRares;
  EXT.verifyRareCounts = verifyRareCounts;
  EXT.solveRareCounts = solveRareCounts;
})(window);
