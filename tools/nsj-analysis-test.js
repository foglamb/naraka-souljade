#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { boot, loadScripts } = require('./nsj-dom-stub');

(async () => {
  const { N, EXT, sandbox, storage } = boot();
  N.applyPreset('bingyun');
  const cfg = EXT.currentConfig();
  const input = JSON.stringify(cfg), storageBefore = JSON.stringify([...storage]);
  const allowed = ['critRate', 'critDmg', 'iceDmg', 'atkPct', 'bossDmg'];
  const first = await EXT.solveLocked(cfg, { allowedAffixes: allowed });
  assert.equal(JSON.stringify(cfg), input, 'solver does not mutate caller input');
  assert.equal(JSON.stringify(EXT.currentConfig()), input, 'preview does not mutate workspace');
  assert.equal(JSON.stringify([...storage]), storageBefore, 'solver does not persist dynamic preview');
  assert(first.checks.ok);
  assert(first.metrics.dps >= first.before.value);
  assert.equal(first.slots.length, cfg.slots.length);
  for (let i = 0; i < cfg.slots.length; i++) {
    const a = cfg.slots[i], b = first.slots[i];
    assert.equal(b.jadeId, a.jadeId);
    assert.equal(b.element, a.element);
    for (let k = 0; k < 4; k++) {
      if (['hedao','meibu','huaqi'].includes(a.subs[k])) assert.equal(b.subs[k], a.subs[k]);
      else if (b.subs[k]) assert(allowed.includes(b.subs[k]));
    }
  }
  const restricted = await EXT.solveLocked(cfg, { allowedAffixes: ['atkPct'] });
  assert(restricted.slots.every(slot => slot.subs.filter(id => id === 'atkPct').length === 1));
  assert(restricted.slots.some(slot => slot.subs.includes(null)), 'leave gaps when choices are insufficient');
  const notRecommended = await EXT.solveLocked(cfg, { allowedAffixes: ['divineEff', 'rangedDmg', 'thunderDmg'] });
  assert(notRecommended.slots.every(slot => slot.subs.includes('divineEff')), 'honor selected non-damage-model affixes');
  await assert.rejects(EXT.solveLocked(cfg, { allowedAffixes: [] }), /至少勾选/);
  await assert.rejects(EXT.solveLocked(cfg, { allowedAffixes: ['hedao'] }), /无效/);

  const withRareValues = EXT.clone(cfg);
  withRareValues.slots[0].subs = ['meibu','meibu','huaqi','atkPct'];
  withRareValues.slots[0].vals = [7.5, 12.5, 9, 1.2];
  const rareValues = await EXT.solveLocked(withRareValues, { allowedAffixes: allowed });
  for (let k = 0; k < 3; k++) {
    assert.equal(rareValues.slots[0].subs[k], withRareValues.slots[0].subs[k]);
    assert.equal(rareValues.slots[0].vals[k], withRareValues.slots[0].vals[k]);
  }
  const gaps = EXT.clone(cfg);
  gaps.slots[1] = null;
  const withGaps = await EXT.solveLocked(gaps, { allowedAffixes: allowed });
  assert.equal(withGaps.slots[1], null);
  assert.equal(withGaps.slots.filter(Boolean).length, gaps.slots.filter(Boolean).length);
  const rareOnly = { params: cfg.params, slots: [EXT.makeSlot('baobingjue','ice',['hedao','meibu','huaqi','hedao'])] };
  const rareResult = await EXT.solveLocked(rareOnly, { allowedAffixes: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(rareResult.slots[0])), JSON.parse(JSON.stringify(rareOnly.slots[0])));

  sandbox.document.readyState = 'loading';
  loadScripts(sandbox, ['ext/nsj-auto-analysis.js']);
  let nextId = 0, calls = 0;
  const timers = new Map(), completed = [], errors = [], pending = [];
  const controller = EXT.createAutoAnalyzer({
    getConfig: () => cfg,
    solve: async (config, options) => { calls++; return EXT.solveLocked(config, options); },
    onResult: result => completed.push(result), onError: error => errors.push(error),
    onPending: () => pending.push(true),
    setTimeout: fn => { timers.set(++nextId, fn); return nextId; },
    clearTimeout: id => timers.delete(id),
  });
  controller.schedule(['iceDmg']);
  controller.schedule(['critDmg']);
  controller.schedule(['atkPct']);
  assert.equal(timers.size, 1, 'rapid toggles coalesce');
  for (const fn of timers.values()) await fn();
  timers.clear();
  assert.equal(calls, 1);
  assert.equal(completed.length, 1);
  assert.equal(errors.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(completed[0].allowedAffixes)), ['atkPct']);
  assert(controller.getLatest());
  cfg.params.baseAtk++;
  assert.equal(controller.getLatest(), null, 'never apply a preview for changed inputs');
  controller.dispose();

  let resolveOld;
  const queue = new Map(), raceResults = [];
  const race = EXT.createAutoAnalyzer({
    getConfig: () => cfg,
    solve: () => new Promise(resolve => { resolveOld = resolve; }),
    onResult: result => raceResults.push(result),
    setTimeout: fn => { queue.set(++nextId, fn); return nextId; },
    clearTimeout: id => queue.delete(id),
  });
  race.schedule(['iceDmg']);
  const oldWork = [...queue.values()][0]();
  queue.clear();
  race.schedule(['atkPct']);
  resolveOld(first);
  await oldWork;
  assert.equal(raceResults.length, 0, 'discard results superseded by newer checkbox selections');
  race.dispose();
  assert.equal(queue.size, 0);
  console.log('PASS: selected-affix pool, fixed jades/rares/rare values, gaps, preview isolation, debounce, stale-result rejection.');
  console.log(`Example: ${first.before.value} -> ${first.after.value} DPS, ${first.stats.evals} evaluations, ${first.stats.elapsedMs}ms.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
