#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { boot } = require('./nsj-dom-stub');
(async () => {
  const { N, EXT, storage } = boot();
  N.applyPreset('bingyun');
  const config = EXT.currentConfig();
  const baseline = JSON.stringify(config), saved = JSON.stringify([...storage]);
  const allowed = ['critRate','critDmg','iceDmg','atkPct','bossDmg'];
  const target = { hedao: 3, huaqi: 1, meibu: 2 };
  const result = await EXT.solveRareCounts(config, { allowedAffixes: allowed, rareCounts: target });
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.countRares(result.slots))), target);
  assert(result.checks.ok);
  assert.equal(JSON.stringify(config), baseline);
  assert.equal(JSON.stringify(EXT.currentConfig()), baseline, 'dynamic analysis does not alter workspace');
  assert.equal(JSON.stringify([...storage]), saved, 'dynamic analysis does not persist history');
  assert.equal(result.slots.length, config.slots.length);
  assert.equal(result.slots.filter(Boolean).length, config.slots.filter(Boolean).length);
  result.slots.forEach((slot, index) => {
    assert.equal(slot.jadeId, config.slots[index].jadeId);
    assert.equal(slot.element, config.slots[index].element);
    const normal = slot.subs.filter(id => id && !['hedao','huaqi','meibu'].includes(id));
    assert.equal(new Set(normal).size, normal.length);
    assert(normal.every(id => allowed.includes(id)));
  });
  const zero = await EXT.solveRareCounts(config, { allowedAffixes: allowed, rareCounts: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.countRares(zero.slots))), { hedao: 0, huaqi: 0, meibu: 0 });
  const allRare = await EXT.solveRareCounts(config, { allowedAffixes: [], rareCounts: { hedao: 10, huaqi: 9, meibu: 9 } });
  assert.equal(allRare.slots.filter(Boolean).flatMap(slot => slot.subs).filter(Boolean).length, 28);
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.countRares(allRare.slots))), { hedao: 10, huaqi: 9, meibu: 9 });
  for (const bad of [{ hedao: 29 }, { meibu: -1 }, { huaqi: 1.5 }, { hedao: NaN }, { hedao: '3' }]) {
    await assert.rejects(EXT.solveRareCounts(config, { rareCounts: bad, allowedAffixes: allowed }), /数量|容纳/);
  }
  await assert.rejects(EXT.solveRareCounts(config, { rareCounts: {}, allowedAffixes: [] }), /普通词条/);
  const gaps = EXT.clone(config);
  gaps.slots[1] = null;
  const fewer = await EXT.solveRareCounts(gaps, { rareCounts: target, allowedAffixes: ['atkPct'] });
  assert.equal(fewer.slots[1], null);
  assert.equal(fewer.slots.filter(Boolean).length, 6);
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.countRares(fewer.slots))), target);
  const custom = EXT.clone(config);
  custom.slots[0].subs = ['meibu','meibu','huaqi','atkPct'];
  custom.slots[0].vals = [7.5,12.5,9,2];
  const inventory = slots => slots.filter(Boolean).flatMap(slot => slot.subs.map((id,k) => ['meibu','huaqi','hedao'].includes(id) ? `${id}:${slot.vals[k]}` : null).filter(Boolean)).sort();
  const moved = await EXT.solveRareCounts(custom, { rareCounts: EXT.countRares(custom.slots), allowedAffixes: allowed });
  assert.deepEqual(JSON.parse(JSON.stringify(inventory(moved.slots))), JSON.parse(JSON.stringify(inventory(custom.slots))), 'existing rare actual values follow the moved items');
  await assert.rejects(EXT.solveRareCounts(config, { rareCounts: target, allowedAffixes: allowed, isCancelled: () => true }), /更新/);
  const budgeted = await EXT.solveRareCounts(config, { rareCounts: target, allowedAffixes: allowed, candidateBudget: 1 });
  assert(budgeted.stats.limited);
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.countRares(budgeted.slots))), target, 'budget exit still satisfies exact inventory');
  console.log(`PASS: exact rare totals; all types; zero/max capacity; invalid counts; fixed jades/colors/gaps; actual values; preview isolation; cancellation; budget feasibility. ${result.stats.elapsedMs}ms / ${result.stats.evals} evaluations.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
