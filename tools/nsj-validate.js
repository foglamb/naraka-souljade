#!/usr/bin/env node
/* =========================================================================
 * naraka-souljade 二改 · 求解器正确性验证
 * -------------------------------------------------------------------------
 * 用「暴力枚举」对求解器的结果做交叉验证，确认启发式没有漏掉更优解。
 *   node tools/nsj-validate.js [--top 18] [--pick 7]
 * 暴力口径：单练分前 N 颗玉里 C(N,7) 全组合，每套都做词条坐标下降；
 * 若暴力结果优于求解器结果，说明求解器需要加强（脚本会退出码 1）。
 * ========================================================================= */
'use strict';

const { boot } = require('./nsj-dom-stub');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const TOPN = arg('top', 18);
const PICK = arg('pick', 7);

const COMBOS = [
  { element: 'ice',     weapon: 'melee' },
  { element: 'thunder', weapon: 'melee' },
  { element: 'poison',  weapon: 'cannon' },
  { element: 'poison',  weapon: 'bow' },
];

const fmt = v => Math.round(v).toLocaleString('en-US');

(async () => {
  const { N, EXT } = boot();
  N.applyPreset('bingyun');
  const base = EXT.currentConfig();
  const params0 = EXT.normalizeParams(base.params);
  let worst = 0, fail = 0;

  console.log(`单练池 ${TOPN} 颗 · 每套 ${PICK} 颗 · 暴力枚举 C(${TOPN},${PICK}) = ${
    binomial(TOPN, PICK).toLocaleString('en-US')} 套/口径`);

  for (const combo of COMBOS) {
    const params = Object.assign({}, params0, {
      element: combo.element, weapon: combo.weapon, slotCount: PICK,
    });

    /* 求解器口径 */
    const tS = Date.now();
    const solved = await EXT.solve({ params, slots: base.slots }, {
      slotCounts: [PICK], elements: [combo.element], weapons: [combo.weapon],
      swapRounds: 3, budgetMs: 300000, expandSlots: false, topReport: 3,
    });
    const solverDps = solved.best.metrics.dps;
    const solverMs = Date.now() - tS;

    /* 暴力口径 */
    const ev = EXT.makeEvaluator(params, 'dps');
    const cands = {}, all = [];
    N.JADES.forEach(j => {
      const c = EXT.candidateAffixes(params, j.id, 'dps');
      cands[j.id] = c;
      c.forEach(x => { if (!all.includes(x)) all.push(x); });
    });
    cands.__all = all;

    const one = new Array(PICK).fill(null);
    const solo = N.JADES.map(j => {
      one[0] = EXT.makeSlot(j.id, params.element, []);
      return { id: j.id, v: ev.evalSlots(one).value };
    }).sort((a, b) => b.v - a.v);
    const pool = solo.slice(0, TOPN).map(x => x.id);

    /* 暴力口径：池内全组合，先双模板粗排，只精修前 REFINE 名（与求解器同规则，公平对比） */
    const elemAffix = { ice: 'iceDmg', thunder: 'thunderDmg', poison: 'poisonDmg' }[combo.element];
    const tplA = [elemAffix, 'critDmg', 'atkPct', 'critRate'];
    const tplB = [elemAffix, 'critDmg', 'atkPct', 'hedao'];
    const REFINE = 40;

    let bruteV = -1;
    const tB = Date.now();
    const combos = [];
    const idx = [];
    (function rec(k, start) {
      if (k === 0) { combos.push(idx.map(i => pool[i])); return; }
      for (let i = start; i < pool.length; i++) { idx.push(i); rec(k - 1, i + 1); idx.pop(); }
    })(PICK, 0);
    const scored = combos.map(ids => {
      const v1 = ev.evalSlots(ids.map(id => EXT.makeSlot(id, params.element, tplA))).value;
      const v2 = ev.evalSlots(ids.map(id => EXT.makeSlot(id, params.element, tplB))).value;
      return { ids, v: Math.max(v1, v2) };
    }).sort((a, b) => b.v - a.v);
    for (const item of scored.slice(0, REFINE)) {
      const pol = EXT.optimizeWords(ev,
        item.ids.map(id => EXT.makeSlot(id, params.element, [])),
        { candidates: cands, maxPass: 3 });
      if (pol.value > bruteV) bruteV = pol.value;
    }
    const bruteMs = Date.now() - tB;

    const gap = ((bruteV - solverDps) / Math.max(1, bruteV)) * 100;
    worst = Math.max(worst, gap);
    const okk = gap <= 0.5;
    if (!okk) fail++;
    console.log(`  ${okk ? '✓' : '✗'} ${combo.element}/${combo.weapon}` +
      ` · 求解 ${fmt(solverDps)} (${solverMs}ms)` +
      ` · 暴力 ${fmt(bruteV)} (${bruteMs}ms)` +
      ` · 差 ${gap.toFixed(2)}%`);
  }

  console.log(`\n最大差距 ${worst.toFixed(2)}%，${fail ? '存在需要加强的口径' : '求解器结果不劣于暴力上界'}`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });

function binomial(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
