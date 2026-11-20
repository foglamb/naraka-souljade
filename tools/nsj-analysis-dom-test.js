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
let viewportWidth = 375;
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
  matchMedia(query) { const max = /max-width:\s*(\d+)px/.exec(query); return { matches: max ? viewportWidth <= Number(max[1]) : false }; },
  addEventListener: (...args) => window.addEventListener(...args),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);
const change = input => input.dispatchEvent(new window.Event('change', { bubbles: true }));
async function waitFor(check, message) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(message || 'Timed out'); await wait(30); }
}
const analyzed = () => sandbox.NSJExt.autoAnalysis.getLatest();

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
  const rareSignature = () => JSON.stringify(EXT.countRares(N.state.slots));
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
  await waitFor(analyzed);
  const latest = EXT.autoAnalysis.getLatest();
  assert(latest);
  assert.deepEqual(JSON.parse(JSON.stringify(latest.allowedAffixes)), ['atkPct']);
  assert.equal(EXT.signature(EXT.currentConfig()), source, 'checkbox previews do not modify workspace');
  const historyKey = EXT.store.KEYS.HISTORY_KEY;
  const historyBefore = storage.get(historyKey);
  const crit = $('[data-auto-affix="critDmg"]');
  crit.checked = true;
  change(crit);
  await waitFor(analyzed);
  assert.equal(storage.get(historyKey), historyBefore, 'dynamic checkbox previews do not add history');
  assert(!$('#autoApply').disabled);
  $('#autoApply').click();
  await waitFor(analyzed);
  assert.equal(N.state.slots.map(slot => slot && slot.jadeId).join(','), jadeIds);
  assert.equal(rareSignature(), oldRareSignature);
  assert(N.state.slots.every(slot => slot.subs.every(id => !id || ['hedao','huaqi','meibu','atkPct','critDmg'].includes(id))));
  assert.equal(JSON.parse(storage.get('naraka-souljade-analysis-options-v1')).selected.length, 2);
  assert.match($('#autoApply').textContent, /方案已应用|当前已符合/);
  // Exact rare types/counts: all edits trigger analysis without clicking solve.
  assert.equal(document.querySelectorAll('[data-auto-rare]').length, 3);
  const targets = { hedao: 3, huaqi: 1, meibu: 2 };
  for (const [type, count] of Object.entries(targets)) {
    const toggle = $(`[data-auto-rare="${type}"]`);
    toggle.checked = true; change(toggle);
    const number = $(`[data-rare-count="${type}"]`);
    number.value = String(count);
    number.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  await waitFor(analyzed);
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.countRares(analyzed().slots))), targets);
  assert.equal(JSON.stringify(EXT.countRares(N.state.slots)), oldRareSignature, 'rare quantity previews do not alter workspace');
  $('#autoApply').click();
  await waitFor(analyzed);
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.countRares(N.state.slots))), targets);
  assert.equal(N.state.slots.map(slot => slot && slot.jadeId).join(','), jadeIds);
  const selectedRare = $('[data-auto-rare="meibu"]');
  selectedRare.checked = false; change(selectedRare);
  await waitFor(analyzed);
  assert.equal(EXT.countRares(analyzed().slots).meibu, 0);
  const tooMany = $('[data-rare-count="hedao"]');
  tooMany.value = '29';
  tooMany.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => /容纳/.test($('#autoStatus').textContent));
  assert($('#autoApply').disabled);
  $('#autoUseCurrentRares').click();
  await waitFor(analyzed);
  assert.deepEqual(JSON.parse(JSON.stringify(EXT.autoAnalysis.getRareCounts())), targets);
  $('[data-rare-step="1"][data-rare-id="huaqi"]').click();
  await waitFor(analyzed);
  assert.equal(EXT.countRares(analyzed().slots).huaqi, 2);

  // Mobile navigation/data attributes and responsive contract (Node DOM, no layout engine).
  const mobileCss = fs.readFileSync(path.join(root, 'ext/nsj-mobile.css'), 'utf8');
  assert(html.includes('viewport-fit=cover'));
  assert(mobileCss.includes('100dvh') && mobileCss.includes('100vh'));
  assert(mobileCss.includes('safe-area-inset-bottom'));
  assert(mobileCss.includes('font-size: 16px !important'));
  assert(mobileCss.includes('.view-compare .panel-ext { display: block !important; }'));
  for (const width of [320, 375, 430, 768]) {
    viewportWidth = width;
    sandbox.NSJLayout.setView('build', false);
    for (const name of ['pool','slots','analysis']) {
      $(`.mobile-build-tabs [data-build-pane="${name}"]`).click();
      assert.equal(document.body.dataset.buildPane, name);
      assert.equal($(`.mobile-build-tabs [data-build-pane="${name}"]`).getAttribute('aria-pressed'), 'true');
    }
    sandbox.NSJLayout.setView('compare', false);
    assert.equal(document.body.dataset.view, 'compare');
    sandbox.NSJLayout.setView('result', false);
    assert.equal(document.body.dataset.view, 'result');
  }

  // Fixed-solver button may be clicked repeatedly (previous guard regression).
  const solve = $('#extSolveBtn');
  solve.click();
  await waitFor(() => !solve.disabled);
  assert(!solve.disabled);
  solve.click();
  await waitFor(() => !solve.disabled);
  assert(!solve.disabled);
  assert.match($('#extSolveText').textContent, /固定阵容|当前配装/);
  console.log('PASS: real HTML/scripts; ordinary/rare toggles; exact rare numbers; steppers; overflow guard; previews/apply; saved choices; 320/375/430/768 mobile navigation and responsive contract; repeated solve. No browser started.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
});
