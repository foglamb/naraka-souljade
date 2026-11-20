/* =========================================================================
 * 永劫无间 · 征神之路 魂玉配装工具 —— 二改扩展 · 快照仓库
 * -------------------------------------------------------------------------
 * 三件事：
 *   history  ——「前面修改的配置」：每次有效改动存一条快照（同签名去重、超量淘汰）
 *   best     ——「自动保存最高的配置」：全历史里综合 DPS 最高的那一份，独占一个槽位，
 *               只能被更强的配置替换（可锁定）。
 *   volatile ——「动态对比」：只在内存里，不进 localStorage，刷新即清空。
 * ========================================================================= */
(function (global) {
  'use strict';

  const EXT = global.NSJExt;
  if (!EXT) throw new Error('[NSJExt.store] 需要先加载 nsj-ext-core.js');

  const HISTORY_KEY = 'naraka-souljade-ext-history-v1';
  const BEST_KEY    = 'naraka-souljade-ext-best-v1';
  const META_KEY    = 'naraka-souljade-ext-meta-v1';

  const LIMITS = { history: 120, hardBytes: 3.5 * 1024 * 1024 };

  const store = EXT.store = {
    history: [],
    best: null,
    meta: { autoBest: true, autoCapture: true, bestLocked: false, bestMetric: 'dps' },
    volatile: { a: null, b: null, focused: 'b' },
    lastSignature: null,
    seq: 0,
  };

  /* ------------------------------------------------------------------ *
   * 读写
   * ------------------------------------------------------------------ */
  function readJSON(key, dft) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return dft;
      const v = JSON.parse(raw);
      return v == null ? dft : v;
    } catch (e) { return dft; }
  }
  /** 写不进去（配额满）时按「先删最旧」策略重试一次 */
  function writeJSON(key, value, onQuota) {
    const text = JSON.stringify(value);
    try {
      localStorage.setItem(key, text);
      return true;
    } catch (e) {
      if (onQuota && onQuota()) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e2) { /* fallthrough */ }
      }
      console.warn('[NSJExt.store] 写入失败（可能超配额）', key, e && e.message);
      return false;
    }
  }

  function uid(prefix) {
    store.seq++;
    return `${prefix}${Date.now().toString(36)}-${store.seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /* ------------------------------------------------------------------ *
   * 记录构造
   * ------------------------------------------------------------------ */
  function makeRecord(config, opts) {
    const o = opts || {};
    const norm = EXT.normalizeConfig(config);
    const m = EXT.measure(norm);
    const sig = EXT.signature(norm);
    return {
      id: o.id || uid('h'),
      ts: o.ts || Date.now(),
      sig,
      label: o.label || defaultLabel(m, norm),
      source: o.source || 'auto',
      metrics: slimMetrics(m),
      config: { params: norm.params, slots: norm.slots },
    };
  }

  function slimMetrics(m) {
    return {
      dps: m.dps, index: m.index, score: m.score, jadeCount: m.jadeCount,
      subCount: m.subCount, atk: m.atk, totalCritRate: m.totalCritRate,
      totalCritDmg: m.totalCritDmg, elemDPS: m.elemDPS, naDPS: m.naDPS,
      skillDPS: m.skillDPS, procDPS: m.procDPS, elemAccum: m.elemAccum,
      cdr: m.cdr, hedaoCount: m.hedaoCount,
      equipped: m.equipped.slice(),
    };
  }

  function defaultLabel(m, norm) {
    const p = norm.params;
    const el = EXT.ELEMENT_NAMES[p.element] || '';
    const wp = EXT.WEAPON_NAMES[p.weapon] || '';
    return `${el}·${wp} · ${m.jadeCount}玉 · ${EXT.num(m.dps)}/s`;
  }

  store.makeRecord = makeRecord;
  store.slimMetrics = slimMetrics;

  /* ------------------------------------------------------------------ *
   * 持久化 history
   * ------------------------------------------------------------------ */
  function persistHistory() {
    let list = store.history.slice();
    const ok = writeJSON(HISTORY_KEY, list, () => {
      list = list.slice(0, Math.max(20, Math.floor(list.length * 0.6)));
      store.history = list;
      return true;
    });
    /* 还有余量就顺手回收：配置里空槽位剪掉，减体积 */
    if (!ok) {
      store.history = store.history.slice(0, 40);
      writeJSON(HISTORY_KEY, store.history);
    }
    return store.history.length;
  }

  function persistBest() {
    return writeJSON(BEST_KEY, store.best);
  }
  function persistMeta() {
    return writeJSON(META_KEY, store.meta);
  }

  /* ------------------------------------------------------------------ *
   * 载入
   * ------------------------------------------------------------------ */
  store.load = function load() {
    const h = readJSON(HISTORY_KEY, []);
    store.history = Array.isArray(h) ? h.filter(r => r && r.config && r.sig).slice(0, LIMITS.history) : [];
    const b = readJSON(BEST_KEY, null);
    store.best = (b && b.config && b.sig) ? b : null;
    const m = readJSON(META_KEY, null);
    if (m && typeof m === 'object') store.meta = Object.assign(store.meta, m);
    if (!store.history.length && store.best) store.history = [store.best];
    store.lastSignature = null;
    return { history: store.history.length, best: !!store.best };
  };

  store.saveMeta = function (patch) {
    Object.assign(store.meta, patch || {});
    persistMeta();
    EXT.emit('meta', store.meta);
    return store.meta;
  };

  /* ------------------------------------------------------------------ *
   * 记录「前面修改的配置」
   * ------------------------------------------------------------------ */
  const MIN_GAP_MS = 120;

  /**
   * 抓一张快照。返回 {record, added, reason}
   *  - 与上一条签名相同 → 不存（这就是「同一份配置不重复堆」）
   *  - 与历史里任意一条签名相同 → 不存，只把那条的时间戳提前（表示又回到了这个配置）
   */
  store.capture = function capture(config, opts) {
    const o = opts || {};
    if (!store.meta.autoCapture && !o.force) return { record: null, added: false, reason: 'disabled' };

    const rec = makeRecord(config, o);
    if (rec.sig === store.lastSignature && !o.force) {
      return { record: null, added: false, reason: 'same-as-last' };
    }
    const hit = store.history.find(r => r.sig === rec.sig);
    if (hit) {
      hit.ts = Date.now();
      hit.metrics = rec.metrics;
      store.lastSignature = rec.sig;
      persistHistory();
      EXT.emit('history', { list: store.history, added: false, record: hit });
      maybeUpdateBest(hit, o);
      return { record: hit, added: false, reason: 'already-in-history' };
    }

    store.history.unshift(rec);
    if (store.history.length > LIMITS.history) store.history.length = LIMITS.history;
    store.lastSignature = rec.sig;
    persistHistory();
    EXT.emit('history', { list: store.history, added: true, record: rec });
    maybeUpdateBest(rec, o);
    return { record: rec, added: true, reason: o.source || 'auto' };
  };

  /** 手动「存这一份」：绕过去重，永远追加（用于打标记） */
  store.captureManual = function (config, label) {
    return store.capture(config, { force: true, source: 'manual', label });
  };

  store.removeHistory = function (id) {
    const i = store.history.findIndex(r => r.id === id);
    if (i < 0) return false;
    store.history.splice(i, 1);
    persistHistory();
    EXT.emit('history', { list: store.history, added: false, removed: id });
    return true;
  };

  store.clearHistory = function () {
    store.history = [];
    store.lastSignature = null;
    persistHistory();
    EXT.emit('history', { list: store.history, added: false, cleared: true });
    return 0;
  };

  /* ------------------------------------------------------------------ *
   * 自动保存「最高的配置」
   * ------------------------------------------------------------------ */
  function metricValue(m, key) {
    if (!m) return -Infinity;
    const k = key || store.meta.bestMetric || 'dps';
    const v = Number(m[k]);
    return isFinite(v) ? v : -Infinity;
  }
  store.metricValue = metricValue;

  /**
   * 只有「严格更高」才替换，避免同一分数反复抖动写盘。
   * 返回 {replaced, prev, next}
   */
  function maybeUpdateBest(rec, opts) {
    const o = opts || {};
    if (!store.meta.autoBest && !o.bypassMeta) return { replaced: false, reason: 'auto-best-off' };
    if (store.meta.bestLocked && !o.bypassMeta) return { replaced: false, reason: 'locked' };
    if (!rec) return { replaced: false, reason: 'no-record' };

    const cur = store.best ? metricValue(store.best.metrics) : -Infinity;
    const val = metricValue(rec.metrics);
    if (!(val > cur + 1e-9)) return { replaced: false, prev: cur, next: val };

    const prev = store.best;
    const next = Object.assign({}, rec, {
      id: store.best && store.best.id ? store.best.id : uid('b'),
      source: 'auto-best',
      label: rec.label,
      bestSince: Date.now(),
      prevDps: prev ? prev.metrics.dps : null,
    });
    store.best = next;
    persistBest();
    EXT.emit('best', { best: next, prev, record: rec });
    if (prev && prev.metrics && next.metrics && next.metrics.dps > prev.metrics.dps) {
      EXT.emit('best-upgraded', { best: next, prev, gain: next.metrics.dps - prev.metrics.dps });
    }
    return { replaced: true, prev: cur, next: val };
  }
  store.maybeUpdateBest = maybeUpdateBest;

  /** 手动把某条历史提升为「最高记录」 */
  store.promoteToBest = function (id) {
    const rec = store.history.find(r => r.id === id);
    if (!rec) return false;
    const prev = store.best;
    store.best = Object.assign({}, rec, {
      id: uid('b'), source: 'manual-best', bestSince: Date.now(), promoted: true,
    });
    persistBest();
    EXT.emit('best', { best: store.best, prev, record: rec });
    return true;
  };

  store.clearBest = function () {
    store.best = null;
    try { localStorage.removeItem(BEST_KEY); } catch (e) { /* ignore */ }
    EXT.emit('best', { best: null, prev: null, record: null });
  };

  /** 重新扫一遍历史，取最高（改了口径/解锁后调用） */
  store.recomputeBest = function () {
    let top = null, topV = -Infinity;
    store.history.forEach(r => {
      const v = metricValue(r.metrics);
      if (v > topV) { topV = v; top = r; }
    });
    if (!top) { store.clearBest(); return null; }
    if (store.best && metricValue(store.best.metrics) >= topV - 1e-9) return store.best;
    store.meta.bestLocked = false;
    maybeUpdateBest(top, { bypassMeta: true });
    return store.best;
  };

  /* ------------------------------------------------------------------ *
   * 动态对比（内存态，不落盘）
   * ------------------------------------------------------------------ */
  store.setVolatile = function (which, rec) {
    store.volatile[which] = rec || null;
    EXT.emit('volatile', store.volatile);
    return store.volatile;
  };
  store.clearVolatile = function () {
    store.volatile.a = null;
    store.volatile.b = null;
    EXT.emit('volatile', store.volatile);
  };
  /** 临时对比：A 固定，B 跟随当前工作区实时重算，不写任何东西 */
  store.liveCompare = function (cfgA) {
    const a = store.makeRecord(cfgA, { source: 'volatile', label: '基准 A（临时）' });
    store.volatile.a = a;
    store.volatile.b = null;
    return a;
  };

  /* ------------------------------------------------------------------ *
   * 导出 / 导入（纯 JSON，不依赖后端）
   * ------------------------------------------------------------------ */
  store.exportBundle = function () {
    return {
      app: 'naraka-souljade',
      ext: EXT.version,
      kind: 'nsj-ext-bundle',
      ts: Date.now(),
      meta: store.meta,
      best: store.best,
      history: store.history,
    };
  };
  store.importBundle = function (data, mode) {
    if (!data || typeof data !== 'object') return { ok: false, msg: '不是合法对象' };
    const m = mode || 'merge';
    const incoming = Array.isArray(data.history) ? data.history : [];
    if (m === 'replace') store.history = [];
    let added = 0;
    const seen = new Set(store.history.map(r => r.sig));
    incoming.forEach(r => {
      if (!r || !r.config || !r.sig || seen.has(r.sig)) return;
      seen.add(r.sig);
      store.history.push(Object.assign({}, r, { id: r.id || uid('h') }));
      added++;
    });
    store.history.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    store.history.length = Math.min(store.history.length, LIMITS.history);
    if (data.meta && typeof data.meta === 'object') {
      store.meta = Object.assign(store.meta, {
        autoBest: !!data.meta.autoBest, autoCapture: !!data.meta.autoCapture,
        bestLocked: false, bestMetric: data.meta.bestMetric || 'dps',
      });
    }
    persistHistory();
    persistMeta();
    if (data.best && data.best.config) {
      const cur = store.best ? metricValue(store.best.metrics) : -Infinity;
      if (metricValue(data.best.metrics) > cur) {
        store.best = data.best;
        persistBest();
      }
    }
    store.recomputeBest();
    EXT.emit('history', { list: store.history, imported: added });
    EXT.emit('best', { best: store.best, prev: null, record: null });
    return { ok: true, added, total: store.history.length };
  };

  store.LIMITS = LIMITS;
  store.KEYS = { HISTORY_KEY, BEST_KEY, META_KEY };
})(window);
