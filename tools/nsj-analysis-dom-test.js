#!/usr/bin/env node
/* Node-only interaction test; no Chromium/browser process.
 * NSJ_DOM_MODULE=/tmp/nsj-dom-check/node_modules/linkedom node tools/nsj-analysis-dom-test.js
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require(process.env.NSJ_DOM_MODULE || 'linkedom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const { window } = parseHTML(html);
const document = window.document;
Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
// LinkeDOM implements DOM structure/events but not browser selection/layout APIs.
Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
  configurable: true,
  get() { const option = [...this.options].find(item => item.hasAttribute('selected')); return option ? option.value : (this.options[0]?.value || ''); },
  set(value) { for (const option of this.options) value === option.value ? option.setAttribute('selected', '') : option.removeAttribute('selected'); },
});
window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 });
window.HTMLElement.prototype.focus = function () {};
window.HTMLElement.prototype.select = function () {};
const timers = new Set(), writes = [];
const storage = new Map();
const sandbox = {
  console, document, MutationObserver: window.MutationObserver,
  Event: window.Event, CustomEvent: window.CustomEvent, performance,
  URLSearchParams, URL, Math, Date, JSON, Promise, Map, Set, WeakMap,
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
  clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  setInterval: () => 0, clearInterval() {},
  location: { hash: '', protocol: 'https:', href: 'https://test.local/', pathname: '/', origin: 'https://test.local' },
  localStorage: { getItem: key => storage.get(key) ?? null, setItem(key, value) { writes.push(key); storage.set(key, String(value)); }, removeItem: key => storage.delete(key) },
  navigator: {}, confirm: () => true,
  addEventListener: (...args) => window.addEventListener(...args),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);
const change = input => input.dispatchEvent(new window.Event('change', { bubbles: true }));

(async () => {
  for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
    vm.runInContext(fs.readFileSync(path.join(root, match[1]), 'utf8'), sandbox, { filename: match[1] });
  }
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await wait(300);
  sandbox.NarakaSoulJade.applyPreset('bingyun');
  await wait(500);
  const { NSJExt: EXT, NarakaSoulJade: N } = sandbox;
  assert.equal(document.querySelectorAll('[data-auto-affix]').length, N.AFFIXES.length);
  assert.equal($('.drawer-tab.active').dataset.drawer, 'analysis');
  assert.match($('#autoStatus').textContent, /已自动分析/);
  assert(EXT.autoAnalysis.getLatest());
  const source = EXT.signature(EXT.currentConfig());
  const rareSignature = () => JSON.stringify(N.state.slots.map(slot => slot && slot.subs.filter(id => ['hedao','huaqi','meibu'].includes(id))));
  const oldRareSignature = rareSignature();
  const jadeIds = N.state.slots.map(slot => slot && slot.jadeId).join(',');
  // Clear all, then select one. No manual solve call is made.
  $('#autoNone').click();
  await wait(250);
  assert.match($('#autoStatus').textContent, /至少勾选/);
  assert($('#autoApply').disabled);
  const attack = $('[data-auto-affix="atkPct"]');
  attack.checked = true;
  change(attack);
  await wait(250);
  const latest = EXT.autoAnalysis.getLatest();
  assert(latest);
  assert.deepEqual(JSON.parse(JSON.stringify(latest.allowedAffixes)), ['atkPct']);
  assert.equal(EXT.signature(EXT.currentConfig()), source, 'checkbox previews do not modify workspace');
  const historyKey = EXT.store.KEYS.HISTORY_KEY;
  const historyBefore = storage.get(historyKey);
  const crit = $('[data-auto-affix="critDmg"]');
  crit.checked = true;
  change(crit);
  await wait(250);
  assert.equal(storage.get(historyKey), historyBefore, 'dynamic checkbox previews do not add history');
  assert(!$('#autoApply').disabled);
  $('#autoApply').click();
  await wait(300);
  assert.equal(N.state.slots.map(slot => slot && slot.jadeId).join(','), jadeIds);
  assert.equal(rareSignature(), oldRareSignature);
  assert(N.state.slots.every(slot => slot.subs.every(id => !id || ['hedao','huaqi','meibu','atkPct','critDmg'].includes(id))));
  assert.equal(JSON.parse(storage.get('naraka-souljade-analysis-options-v1')).selected.length, 2);
  assert.match($('#autoApply').textContent, /方案已应用|当前已符合/);
  // Fixed-solver button may be clicked repeatedly (previous guard regression).
  const solve = $('#extSolveBtn');
  solve.click();
  await wait(150);
  assert(!solve.disabled);
  solve.click();
  await wait(150);
  assert(!solve.disabled);
  assert.match($('#extSolveText').textContent, /固定阵容|当前配装/);
  console.log('PASS: actual HTML/script load order; checkbox change triggers analysis; preview isolation; apply; inventory; saved choices; repeated solve. No browser started.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
});
