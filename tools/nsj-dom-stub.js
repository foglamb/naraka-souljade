/* =========================================================================
 * naraka-souljade 二改 · 无头 DOM 桩（Node，零依赖）
 * -------------------------------------------------------------------------
 * 只提供 app.js / ext/* 真正用到的那一小撮 DOM & 存储 API，
 * 让纯静态页面能在 Node 里按真实顺序执行，便于回归与求解验证。
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else { on ? set.add(c) : set.delete(c); } return set.has(c); },
    contains: c => set.has(c),
    _set: set,
  };
}

function makeEl(tag, doc) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    attributes: {},
    value: '',
    checked: false,
    textContent: '',
    _html: '',
    classList: null,
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    remove() {},
    focus() {},
    select() {},
    blur() {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] == null ? null : this.attributes[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 40, right: 100, width: 100, height: 40 }; },
    querySelector() { return makeEl('div', doc); },
    querySelectorAll() { return []; },
    closest() { return null; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
  };
  el.classList = makeClassList(el);
  return el;
}

function makeDocument() {
  const cache = new Map();
  const doc = {
    body: makeEl('body'),
    documentElement: makeEl('html'),
    createElement: tag => makeEl(tag, doc),
    createTextNode: t => ({ textContent: t }),
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) { return doc.querySelector('#' + id); },
    querySelector(sel) {
      if (!cache.has(sel)) cache.set(sel, makeEl('div', doc));
      return cache.get(sel);
    },
    querySelectorAll() { return []; },
    _cache: cache,
  };
  doc.body.dataset = {};
  return doc;
}

/* ------------------------------------------------------------------ *
 * 环境
 * ------------------------------------------------------------------ */
function makeSandbox(opts) {
  const o = opts || {};
  const document = makeDocument();
  const storage = new Map(o.storage || []);
  const sandbox = {
    console,
    Math, Date, JSON, Object, Array, Number, String, Boolean, Symbol, Error, TypeError,
    Map, Set, WeakMap, WeakSet, Promise, RegExp, isFinite, isNaN, parseFloat, parseInt,
    encodeURIComponent, decodeURIComponent, escape, unescape,
    URLSearchParams, URL,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    requestAnimationFrame: null,
    performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
    navigator: { clipboard: null },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: k => { storage.delete(k); },
      clear: () => storage.clear(),
      key: i => Array.from(storage.keys())[i] || null,
      get length() { return storage.size; },
    },
    document,
    location: { hash: '', protocol: 'file:', href: 'file:///app/index.html', origin: 'null', pathname: '/app/index.html' },
    confirm: () => true,
    alert: () => {},
    btoa: s => Buffer.from(String(s), 'binary').toString('base64'),
    atob: s => Buffer.from(String(s), 'base64').toString('binary'),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  return { sandbox, storage, document };
}

function loadScripts(sandbox, files) {
  files.forEach(f => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  });
}


const DEFAULT_SCRIPTS = [
  'data.js',
  'app.js',
  'ext/nsj-ext-core.js',
  'ext/nsj-ext-store.js',
  'ext/nsj-ext-optimizer.js',
];

/** 建一个独立的沙箱并加载脚本；opts.storage 可传入 Map 复用 localStorage */
function boot(opts) {
  const o = opts || {};
  const { sandbox, storage, document } = makeSandbox(o);
  loadScripts(sandbox, o.scripts || DEFAULT_SCRIPTS);
  const N = sandbox.NarakaSoulJade;
  const EXT = sandbox.NSJExt;
  if (!N) throw new Error('NarakaSoulJade 未挂载');
  if (!EXT) throw new Error('NSJExt 未挂载');
  if (o.noLoad !== true) EXT.store.load();
  return { sandbox, storage, document, N, EXT };
}

module.exports = { ROOT, makeSandbox, loadScripts, boot, DEFAULT_SCRIPTS };
