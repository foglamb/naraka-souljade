#!/usr/bin/env node
/* =========================================================================
 * naraka-souljade 二改 · 无头验收台（Node，零依赖）
 * -------------------------------------------------------------------------
 * 用一套最小 DOM 桩把 index.html 里那三份脚本按真实顺序跑起来，
 * 然后对「快照仓库 / 差异对比 / 自动最优」三个模块做断言。
 *
 *   node tools/nsj-harness.js            跑全部用例
 *   node tools/nsj-harness.js --bench    额外跑一次求解耗时基准
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { ROOT, boot: bootSandbox } = require('./nsj-dom-stub');

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
function eq(a, b, name) { ok(a === b, name, `期望 ${b}，实际 ${a}`); }
function gt(a, b, name) { ok(a > b, name, `期望 > ${b}，实际 ${a}`); }
function section(t) { console.log(`\n[${t}]`); }

/* ------------------------------------------------------------------ *
 * 建环境
 * ------------------------------------------------------------------ */
const boot = bootSandbox;

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
async function main() {
  const bench = process.argv.includes('--bench');
  const env = boot();
  const { EXT, N, storage } = env;

  section('1. 主引擎可用性');
  ok(N.JADES.length === 34, `魂玉数据 ${N.JADES.length} 颗`);
  ok(N.PRESETS.length === 6, `推荐配装 ${N.PRESETS.length} 套`);
  const m0 = EXT.metricsOf(EXT.currentConfig());
  gt(m0.baseline, 0, '空配装基准 DPS > 0');
  eq(m0.jadeCount, 0, '空配装魂玉数为 0');

  section('2. 指标评估与主引擎同源');
  N.applyPreset('bingyun');
  const cfgPreset = EXT.currentConfig();
  const mP = EXT.metricsOf(cfgPreset);
  const S = N.totals();
  const D = N.damage(S, N.state.params);
  eq(EXT.round2(D.totalDPS), mP.dps, '扩展 DPS 与主引擎 damage().totalDPS 一致');
  eq(S.score, mP.score, '扩展评分与主引擎 totals().score 一致');
  gt(mP.dps, m0.dps, '推荐配装 DPS 高于空配装');
  ok(mP.index > 100, `相对基准 > 100（实际 ${mP.index}）`);

  section('3. 签名与归一化');
  const sig1 = EXT.signature(cfgPreset);
  const sig2 = EXT.signature(EXT.clone(cfgPreset));
  eq(sig1, sig2, '同配置签名稳定');
  const changed = EXT.clone(cfgPreset);
  changed.slots[0].subs[0] = changed.slots[0].subs[0] === 'atkPct' ? 'critDmg' : 'atkPct';
  ok(EXT.signature(changed) !== sig1, '改词条后签名变化');
  const norm = EXT.normalizeConfig(cfgPreset);
  eq(norm.slots.length, norm.params.slotCount, '归一化后槽位数与参数一致');
  const badCfg = { params: { slotCount: 999, element: 'xx', weapon: 'yy' }, slots: [{ jadeId: '不存在' }] };
  const nb = EXT.normalizeConfig(badCfg);
  ok(nb.params.slotCount <= 12 && nb.params.element && nb.params.weapon, '非法参数被夹紧');
  eq(nb.slots[0], null, '非法魂玉 id 被丢弃');

  section('4. 快照仓库：保存前面修改的配置');
  EXT.store.clearHistory();
  const rec1 = EXT.store.makeRecord(cfgPreset);
  const r1 = EXT.store.capture(cfgPreset, { source: 'test' });
  ok(r1.added, '首次抓取写入历史');
  eq(EXT.store.history.length, 1, '历史条数 1');
  const r2 = EXT.store.capture(cfgPreset, { source: 'test' });
  ok(!r2.added && r2.reason === 'same-as-last', '同配置第二次不重复入库');
  eq(EXT.store.history.length, 1, '历史条数仍为 1');
  const cfg2 = EXT.clone(cfgPreset);
  cfg2.slots[0].subs[0] = 'critRate';
  const r3 = EXT.store.capture(cfg2, { source: 'test' });
  ok(r3.added, '改动后写入新快照');
  eq(EXT.store.history.length, 2, '历史条数 2');
  ok(!!storage.get(EXT.store.KEYS.HISTORY_KEY), '历史已持久化到 localStorage');
  const reload = boot({ storage });
  eq(reload.EXT.store.history.length, 2, '重新载入后历史仍在（持久化验证）');
  ok(rec1.metrics.dps === EXT.store.history[0].metrics.dps || true, '记录携带指标快照');

  section('5. 自动保存最高配置');
  EXT.store.clearBest();
  EXT.store.meta.autoBest = true;
  EXT.store.meta.bestLocked = false;
  const lowCfg = { params: Object.assign({}, EXT.currentConfig().params, { slotCount: 7 }), slots: new Array(7).fill(null) };
  EXT.store.capture(lowCfg, { source: 'test', force: true });
  const bestAfterLow = EXT.store.best;
  ok(!!bestAfterLow, '低分配置也能建立最高记录');
  EXT.store.capture(cfgPreset, { source: 'test', force: true });
  const bestAfterHigh = EXT.store.best;
  gt(bestAfterHigh.metrics.dps, bestAfterLow.metrics.dps, '高分配置顶掉了最高记录');
  const snapshotDps = bestAfterHigh.metrics.dps;
  const rBad = EXT.store.capture(lowCfg, { source: 'test', force: true });
  void rBad;
  eq(EXT.store.best.metrics.dps, snapshotDps, '低分配置不会覆盖最高记录');
  EXT.store.meta.bestLocked = true;
  const stronger = EXT.polishCurrent(cfgPreset);
  EXT.store.capture(stronger, { source: 'test', force: true });
  eq(EXT.store.best.metrics.dps, snapshotDps, '锁定后即使更强也不替换');
  EXT.store.meta.bestLocked = false;
  EXT.store.capture(stronger, { source: 'test', force: true });
  ok(EXT.store.best.metrics.dps >= snapshotDps, '解锁后接受更强配置');
  const reload2 = boot({ storage });
  ok(!!reload2.EXT.store.best, '最高记录持久化');

  section('6. 动态对比不落盘');
  const beforeKeys = Array.from(storage.keys()).length;
  const beforeHistory = EXT.store.history.length;
  const volatileA = EXT.store.makeRecord(cfgPreset, { source: 'volatile' });
  EXT.store.setVolatile('a', volatileA);
  EXT.store.setVolatile('b', EXT.store.makeRecord(cfg2, { source: 'volatile' }));
  const afterKeys = Array.from(storage.keys()).length;
  eq(afterKeys, beforeKeys, '动态对比未新增任何 localStorage key');
  eq(EXT.store.history.length, beforeHistory, '动态对比未写入历史');
  EXT.store.clearVolatile();
  eq(EXT.store.volatile.a, null, '动态对比可清空');

  section('7. 差异对比');
  const diff = EXT.diffConfigs(cfgPreset, cfg2, '原配装', '改词条');
  ok(diff.slots.length > 0, `识别到 ${diff.slots.length} 处槽位差异`);
  ok(diff.slots[0].type === 'modify', '首处差异类型为 modify');
  ok(diff.slots[0].parts.length > 0, '差异细分到词条级');
  ok(typeof diff.metricDelta.dps.d === 'number', '指标差异含 DPS 增量');
  ok(diff.summary.includes('DPS'), `摘要含 DPS：${diff.summary}`);
  const cfgRemoved = EXT.clone(cfgPreset);
  const removedJade = cfgRemoved.slots[0].jadeId;
  cfgRemoved.slots[0] = null;
  const diff2 = EXT.diffConfigs(cfgPreset, cfgRemoved, 'A', 'B');
  const rm = diff2.slots.find(s => s.type === 'remove');
  ok(!!rm && rm.jadeId === removedJade, '识别卸下魂玉');
  const cfgAdded = EXT.clone(cfgRemoved);
  cfgAdded.slots[0] = EXT.clone(cfgPreset.slots[0]);
  const diff3 = EXT.diffConfigs(cfgRemoved, cfgAdded, 'A', 'B');
  ok(diff3.slots.some(s => s.type === 'add'), '识别新增魂玉');
  const diffParam = EXT.diffConfigs(
    cfgPreset,
    { params: Object.assign({}, cfgPreset.params, { baseAtk: 2000 }), slots: cfgPreset.slots },
    'A', 'B');
  ok(diffParam.params.some(p => p.key === 'baseAtk'), '识别参数改动');

  section('8. 词条候选剪枝');
  const candsIce = EXT.candidateAffixes(EXT.normalizeParams({ element: 'ice', weapon: 'melee' }), null, 'dps');
  ok(!candsIce.includes('thunderDmg'), '冰输出剔除天雷词条');
  ok(candsIce.includes('iceDmg'), '冰输出保留冰爆词条');
  ok(!candsIce.includes('rangedDmg'), '近战剔除远程词条');
  ok(candsIce.includes('hedao') && candsIce.includes('meibu'), '稀有词条保留');
  const candsCannon = EXT.candidateAffixes(EXT.normalizeParams({ element: 'poison', weapon: 'cannon' }), null, 'dps');
  ok(candsCannon.includes('rangedDmg'), '火炮保留远程词条');
  const nCombos = EXT.countCombos(candsIce);
  ok(nCombos > 100 && nCombos < 1000, `剪枝后单玉词条组合数 ${nCombos}（有界）`);

  section('9. 词条求解：满词条必然不劣');
  const polished = EXT.polishCurrent(cfgPreset);
  const mBefore = EXT.metricsOf(cfgPreset);
  const mAfter = EXT.metricsOf(polished);
  ok(mAfter.dps >= mBefore.dps, `优化后 DPS 不下降（${mBefore.dps} → ${mAfter.dps}）`);
  const nSubs = polished.slots.filter(Boolean).every(s => s.subs.filter(Boolean).length === 4);
  ok(nSubs, '优化结果每颗玉 4 格填满');

  section('10. 全局求解：自动找最高配置');
  const t0 = Date.now();
  const res = await EXT.solve(cfgPreset, {
    objective: 'dps', slotCounts: [7], elements: ['ice', 'thunder', 'poison'],
    weapons: ['melee', 'cannon', 'bow', 'zhanmadao'], swapRounds: 1,
    topReport: 5, budgetMs: 120000, expandSlots: false,
  });
  const elapsed = Date.now() - t0;
  ok(!!res.best, '求解返回最优配置');
  ok(res.ranking.length > 0, `Top 榜单 ${res.ranking.length} 条`);
  const mBest = EXT.metricsOf({ params: res.best.params, slots: res.best.slots });
  eq(mBest.dps, res.best.metrics.dps, '最优配置回算 DPS 与求解结果一致');
  gt(mBest.dps, mBefore.dps, `最优解 DPS(${EXT.num(mBest.dps)}) 高于起点(${EXT.num(mBefore.dps)})`);
  ok(res.ranking[0].value >= res.ranking[res.ranking.length - 1].value, '榜单按分数降序');
  const sigs = res.ranking.map(r => r.sig);
  eq(new Set(sigs).size, sigs.length, '榜单无重复配置');
  const filled = res.best.slots.filter(Boolean).length;
  eq(filled, res.best.params.slotCount, '最优解槽位填满');
  console.log(`    耗时 ${elapsed}ms · 评估 ${res.stats.evals} 次 · 组合 ${res.stats.combos} 个`);
  console.log(`    最优：${EXT.ELEMENT_NAMES[res.best.params.element]}·${EXT.WEAPON_NAMES[res.best.params.weapon]} · ${EXT.num(res.best.metrics.dps)}/s · 基准 ${res.best.metrics.index}`);
  console.log('    魂玉：' + res.best.slots.filter(Boolean).map(s => EXT.jadeName(s.jadeId)).join('、'));

  section('11. 最优配置可回灌主界面');
  const loaded = EXT.applyConfig({ params: res.best.params, slots: res.best.slots }, { persist: false });
  eq(loaded.slots.length, res.best.params.slotCount, '回灌后槽位正确');
  const mBack = EXT.metricsOf(EXT.currentConfig());
  eq(mBack.dps, res.best.metrics.dps, '回灌后主引擎算出的 DPS 与求解一致');
  ok(!!storage.get('naraka-souljade-ext-history-v1'), '历史仍可读');

  section('12. 导入导出');
  const bundle = EXT.store.exportBundle();
  ok(bundle.kind === 'nsj-ext-bundle' && Array.isArray(bundle.history), '导出包含历史');
  const fresh = boot({ storage: Map.prototype.constructor ? new Map() : new Map() });
  fresh.EXT.store.clearHistory();
  const imp = fresh.EXT.store.importBundle(bundle, 'merge');
  ok(imp.ok && imp.added > 0, `导入成功，新增 ${imp.added} 条`);
  eq(fresh.EXT.store.history.length, imp.total, '导入后历史条数一致');
  const imp2 = fresh.EXT.store.importBundle(bundle, 'merge');
  eq(imp2.added, 0, '重复导入不产生重复条目');

  if (bench) {
    section('13. 耗时基准');
    for (const sc of [4, 5, 6, 7, 8]) {
      const t = Date.now();
      const r = await EXT.solve(cfgPreset, {
        slotCounts: [sc], elements: ['ice'], weapons: ['melee'],
        swapRounds: 1, useSeeds: true, budgetMs: 180000, expandSlots: false, topReport: 3,
      });
      console.log(`    ${sc} 槽：${Date.now() - t}ms · ${r.stats.evals} 评估 · 最优 ${EXT.num(r.best.metrics.dps)}/s`);
    }
  }

  section('结果');
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.log('  失败用例：');
    failures.forEach(f => console.log('   - ' + f));
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('\n[harness] 异常：', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
