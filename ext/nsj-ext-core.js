/* =========================================================================
 * 永劫无间 · 征神之路 魂玉配装工具 —— 二改扩展 · 核心评估层
 * -------------------------------------------------------------------------
 * 设计原则：
 *   1) 不复制主引擎公式。所有分数一律调用 app.js 暴露的 totals()/damage()，
 *      保证「扩展面板显示的数字」与「属性面板显示的数字」永远同一个来源，
 *      上游升级计算模型时本层自动跟随，不会出现两套公式漂移。
 *   2) 评估过程对 state 是「借用 + 还原」，不改动用户当前配装。
 *   3) 只做纯计算，不碰 localStorage（持久化在 nsj-ext-store.js）。
 * ========================================================================= */
(function (global) {
  'use strict';

  const EXT = global.NSJExt = global.NSJExt || {};
  EXT.version = '2.0.0';
  EXT.tag = 'naraka-souljade-ext';

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */
  function host() {
    const N = global.NarakaSoulJade;
    if (!N || !N.state) throw new Error('[NSJExt] NarakaSoulJade 尚未就绪（需先加载 app.js）');
    return N;
  }
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const round1 = v => Math.round((v + (v >= 0 ? 1e-9 : -1e-9)) * 10) / 10;
  const round2 = v => Math.round((v + (v >= 0 ? 1e-9 : -1e-9)) * 100) / 100;

  EXT.host = host;
  EXT.clone = clone;
  EXT.round1 = round1;
  EXT.round2 = round2;

  EXT.WEAPON_NAMES = { melee: '近战通用', cannon: '火炮', bow: '弓箭', zhanmadao: '斩马刀' };
  EXT.ELEMENT_NAMES = { thunder: '雷', ice: '冰', poison: '毒', none: '未染' };
  EXT.AFFIX_DMG = { thunder: 'thunderDmg', ice: 'iceDmg', poison: 'poisonDmg' };

  EXT.num = v => (isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
  EXT.pct = v => (v > 0 ? '+' : '') + round1(v) + '%';
  EXT.fmtTime = ts => {
    const d = new Date(ts || Date.now());
    const p2 = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };

  /* ------------------------------------------------------------------ *
   * 归一化
   * ------------------------------------------------------------------ */
  function normalizeParams(raw) {
    const N = host();
    const out = Object.assign({}, N.DEFAULT_PARAMS, clone(raw) || {});
    out.slotCount = Math.max(1, Math.min(12, parseInt(out.slotCount, 10) || 7));
    out.unusedPoints = Math.max(0, Math.min(300, parseInt(out.unusedPoints, 10) || 0));
    const c = out.conds;
    out.conds = (c && typeof c === 'object' && !Array.isArray(c)) ? Object.assign({}, c) : {};
    ['baseAtk', 'naMul', 'naFreq', 'baseCritRate', 'baseCritDmg', 'elemMul', 'elemFreq',
     'skillMul', 'skillFreq', 'meteorMul', 'meteorCd', 'pv'].forEach(k => {
      const d = N.DEFAULT_PARAMS[k];
      const v = parseFloat(out[k]);
      out[k] = isFinite(v) ? v : d;
    });
    if (!EXT.WEAPON_NAMES[out.weapon]) out.weapon = N.DEFAULT_PARAMS.weapon;
    if (!['thunder', 'ice', 'poison'].includes(out.element)) out.element = N.DEFAULT_PARAMS.element;
    ['bossDmgOn', 'rangedDmgOn', 'meteorOn'].forEach(k => { out[k] = !!out[k]; });
    return out;
  }

  /** 把任意来源（存档 / 分享链接 / 求解器产物）夹成合法且定长的配置 */
  function normalizeConfig(cfg) {
    const N = host();
    const params = normalizeParams(cfg && cfg.params);
    const src = (cfg && Array.isArray(cfg.slots)) ? cfg.slots : [];
    const slots = [];
    for (let i = 0; i < params.slotCount; i++) {
      slots.push(src[i] ? (N.normalizeSlot(clone(src[i])) || null) : null);
    }
    return { params, slots };
  }

  EXT.normalizeParams = normalizeParams;
  EXT.normalizeConfig = normalizeConfig;

  /* ------------------------------------------------------------------ *
   * 签名 / 基准缓存
   * ------------------------------------------------------------------ */
  /** 同一个 params 对象只序列化一次（求解器里会被调用上百万次） */
  const keyCache = new WeakMap();
  function paramsKey(p) {
    if (p && typeof p === 'object') {
      const hit = keyCache.get(p);
      if (hit) return hit;
    }
    const k = JSON.stringify([
      p.slotCount, p.baseAtk, p.element, p.weapon, p.naMul, p.naFreq,
      p.baseCritRate, p.baseCritDmg, p.elemMul, p.elemFreq, p.skillMul, p.skillFreq,
      p.bossDmgOn ? 1 : 0, p.rangedDmgOn ? 1 : 0, p.meteorOn ? 1 : 0,
      p.meteorMul, p.meteorCd, p.unusedPoints, p.conds || {},
    ]);
    if (p && typeof p === 'object') keyCache.set(p, k);
    return k;
  }
  EXT.paramsKey = paramsKey;

  /** 全局唯一签名：参数 + 槽位（含词条与填值）完全一致才视为同一份配置 */
  function signature(cfg) {
    const n = normalizeConfig(cfg);
    const slots = n.slots.map(s => (s
      ? [
          s.jadeId,
          s.element || '-',
          (s.subs || []).map(x => x || '_').join(','),
          (s.vals || []).map(v => (v == null ? '_' : v)).join(','),
        ].join(':')
      : '∅')).join(';');
    return paramsKey(n.params) + '#' + slots;
  }
  EXT.signature = signature;

  const baseCache = new Map();
  function baselineFor(params) {
    const key = paramsKey(params);
    const hit = baseCache.get(key);
    if (hit != null) return hit;
    const N = host();
    const sP = N.state.params, sS = N.state.slots;
    let v = 1;
    try {
      N.state.params = params;
      N.state.slots = new Array(params.slotCount).fill(null);
      const S = N.totals();
      v = N.damage(S, params).totalDPS || 1;
    } finally {
      N.state.params = sP;
      N.state.slots = sS;
    }
    if (baseCache.size > 256) baseCache.clear();
    baseCache.set(key, v);
    return v;
  }
  EXT.baselineFor = baselineFor;

  /* ------------------------------------------------------------------ *
   * 指标评估
   * ------------------------------------------------------------------ */

  /** 指标字段定义：[key, 中文名, 单位, 类型] —— 类型 num 直接显示，pct 显示百分号 */
  const METRIC_FIELDS = [
    ['dps',        '综合期望 DPS',   '/s',  'num'],
    ['index',      '相对基准',       '',    'num'],
    ['score',      '魂玉评分',       '',    'num'],
    ['atk',        '攻击力（含加成）', '',   'num'],
    ['totalCritRate', '暴击率',      '%',   'pct'],
    ['totalCritDmg',  '暴击伤害',    '%',   'pct'],
    ['effCrit',    '有效暴击率',     '%',   'pct'],
    ['effElemCrit', '元素有效暴击率', '%',  'pct'],
    ['naDPS',      '普攻 DPS',       '',    'num'],
    ['elemDPS',    '元素 DPS',       '',    'num'],
    ['skillDPS',   '技能 DPS',       '',    'num'],
    ['procDPS',    '流星 DPS',       '',    'num'],
    ['atkPct',     '攻击力加成',     '%',   'pct'],
    ['elemAccum',  '元素积累效率',   '%',   'pct'],
    ['cdr',        '冷却缩减',       '%',   'pct'],
    ['hedaoCount', '合道条数',       '条',  'num'],
    ['jadeCount',  '佩戴魂玉',       '颗',  'num'],
    ['subCount',   '已填词条',       '条',  'num'],
  ];
  EXT.METRIC_FIELDS = METRIC_FIELDS;

  /**
   * 对「已归一化」的配置做一次评估。
   * norm.slots 必须定长且元素合法（求解器内部手工构造时也要满足）。
   */
  function measure(norm) {
    const N = host();
    const sP = N.state.params, sS = N.state.slots;
    let S, D;
    try {
      N.state.params = norm.params;
      N.state.slots = norm.slots;
      S = N.totals();
      D = N.damage(S, norm.params);
    } finally {
      N.state.params = sP;
      N.state.slots = sS;
    }
    const dps = D.totalDPS || 0;
    const base = baselineFor(norm.params);
    return {
      dps: round2(dps),
      baseline: round2(base),
      index: round1(base > 0 ? (dps / base) * 100 : 100),
      score: S.score,
      jadeCount: S.jadeCount,
      subCount: S.subCount,
      atk: round1(D.atk),
      totalCritRate: round1(D.totalCritRate),
      totalCritDmg: round1(D.totalCritDmg),
      effCrit: round1(D.effCrit * 100),
      effElemCrit: round1(D.effElemCrit * 100),
      naDPS: round2(D.naDPS),
      elemDPS: round2(D.elemDPS),
      skillDPS: round2(D.skillDPS),
      procDPS: round2(D.procDPS),
      atkPct: round1(S.atkPct),
      elemAccum: round1(S.elemAccum),
      cdr: round1(S.cdr),
      meibu: round1(S.meibu),
      hedaoCount: S.hedaoCount,
      iceHits: S.iceHits,
      bossDmg: round1(S.bossDmg),
      rangedDmg: round1(S.rangedDmg),
      skillDmg: round1(S.skillDmg),
      dmgPct: round1(S.dmgPct),
      elemDmgPct: round1(S.elemDmgPct),
      yudian: S.yudian,
      equipped: S.equippedIds.slice(),
      rares: S.rareList.map(r => `${r.jade}·${r.name}`),
      specials: S.specials.map(s => `${s.jade}·${s.text}`),
    };
  }

  function metricsOf(cfg) {
    return measure(normalizeConfig(cfg));
  }

  EXT.measure = measure;
  EXT.metricsOf = metricsOf;

  /* ------------------------------------------------------------------ *
   * 差异对比
   * ------------------------------------------------------------------ */
  const PARAM_LABELS = {
    baseAtk: '基础攻击力', element: '武器输出元素', weapon: '武器类型',
    naMul: '普攻倍率', naFreq: '普攻频率', baseCritRate: '基础暴击率', baseCritDmg: '基础暴击伤害',
    elemMul: '元素倍率', elemFreq: '元素频率', skillMul: '技能倍率', skillFreq: '技能频率',
    bossDmgOn: '计入对首领伤害', rangedDmgOn: '计入远程招式增伤', meteorOn: '启用流星估算',
    meteorMul: '流星倍率', meteorCd: '流星冷却', slotCount: '配装槽位数',
    unusedPoints: '未使用潜能点', conds: '条件加成开关',
  };
  EXT.PARAM_LABELS = PARAM_LABELS;

  function paramText(key, value) {
    if (key === 'element') return EXT.ELEMENT_NAMES[value] || String(value);
    if (key === 'weapon') return EXT.WEAPON_NAMES[value] || String(value);
    if (key === 'bossDmgOn' || key === 'rangedDmgOn' || key === 'meteorOn') return value ? '开' : '关';
    if (key === 'conds') {
      const k = Object.keys(value || {});
      if (!k.length) return '全默认';
      return k.map(x => `${x}=${value[x] ? '开' : '关'}`).join(' ');
    }
    return String(value);
  }

  function affixName(id) {
    if (!id || id === 'none') return '空';
    const N = host();
    const a = N.AFFIXES.find(x => x.id === id);
    if (a) return `${a.name} +${a.value}%`;
    const r = N.RARES.find(x => x.id === id);
    if (r) return `${r.name}（${r.short}）`;
    return id;
  }
  EXT.affixName = affixName;

  function jadeName(id) {
    if (!id) return '空';
    const j = host().JADES.find(x => x.id === id);
    return j ? j.name : id;
  }
  EXT.jadeName = jadeName;

  /**
   * 结构化差异：入口两份「原始配置」，内部统一归一化后再比。
   * 返回 { a, b, metricDelta, params:[], slots:[], summary }
   */
  function diffConfigs(cfgA, cfgB, labelA, labelB) {
    const A = normalizeConfig(cfgA);
    const B = normalizeConfig(cfgB);
    const mA = measure(A);
    const mB = measure(B);

    /* ---- 参数差异 ---- */
    const params = [];
    Object.keys(PARAM_LABELS).forEach(k => {
      const va = A.params[k], vb = B.params[k];
      const ta = paramText(k, va), tb = paramText(k, vb);
      if (ta !== tb) params.push({ key: k, label: PARAM_LABELS[k], a: ta, b: tb });
    });

    /* ---- 槽位差异 ---- */
    const n = Math.max(A.slots.length, B.slots.length);
    const raw = [];
    for (let i = 0; i < n; i++) {
      const sa = A.slots[i], sb = B.slots[i];
      if (!sa && !sb) continue;
      if (!sa && sb) { raw.push({ type: 'add', slot: i, jadeId: sb.jadeId }); continue; }
      if (sa && !sb) { raw.push({ type: 'remove', slot: i, jadeId: sa.jadeId }); continue; }
      if (sa.jadeId !== sb.jadeId) {
        raw.push({ type: 'swap', slot: i, from: sa.jadeId, to: sb.jadeId });
        continue;
      }
      /* 同一颗玉：细分 元素 / 词条 / 数值 */
      const parts = [];
      const elA = sa.element || null, elB = sb.element || null;
      if (elA !== elB) {
        parts.push({
          key: 'element', label: '染元素',
          a: EXT.ELEMENT_NAMES[elA || 'none'], b: EXT.ELEMENT_NAMES[elB || 'none'],
        });
      }
      for (let k = 0; k < 4; k++) {
        const xa = (sa.subs || [])[k] || null;
        const xb = (sb.subs || [])[k] || null;
        if (xa !== xb) parts.push({ key: 'sub' + k, label: `词条位 ${k + 1}`, a: affixName(xa), b: affixName(xb) });
      }
      for (let k = 0; k < 4; k++) {
        const va = (sa.vals || [])[k];
        const vb = (sb.vals || [])[k];
        const na = (va == null ? null : va), nb = (vb == null ? null : vb);
        if (na !== nb) {
          const nm = (sb.subs || [])[k] || (sa.subs || [])[k];
          parts.push({ key: 'val' + k, label: `词条位 ${k + 1} 数值`, a: na == null ? '满值' : na + '%', b: nb == null ? '满值' : nb + '%', hint: affixName(nm) });
        }
      }
      if (parts.length) raw.push({ type: 'modify', slot: i, jadeId: sa.jadeId, parts });
    }

    /* ---- 跨槽位移动识别：把 remove/swap 中「只是换了位置」的挑出来 ---- */
    const posB = new Map();
    B.slots.forEach((s, i) => { if (s) posB.set(s.jadeId, i); });
    const posA = new Map();
    A.slots.forEach((s, i) => { if (s) posA.set(s.jadeId, i); });
    const entries = raw.map(e => {
      if (e.type === 'remove' && posB.has(e.jadeId)) {
        return { type: 'move', slot: e.slot, toSlot: posB.get(e.jadeId), jadeId: e.jadeId };
      }
      if (e.type === 'swap' && posB.get(e.from) != null && posA.get(e.to) != null) {
        return { type: 'move', slot: e.slot, toSlot: posB.get(e.from), jadeId: e.from, alsoSwap: e.to };
      }
      return e;
    });

    /* ---- 指标差异 ---- */
    const metricDelta = {};
    METRIC_FIELDS.forEach(([k]) => {
      metricDelta[k] = { a: mA[k], b: mB[k], d: round2(mB[k] - mA[k]) };
    });

    /* ---- 一行摘要 ---- */
    const bits = [];
    const nAdd = entries.filter(e => e.type === 'add').length;
    const nRem = entries.filter(e => e.type === 'remove').length;
    const nSwp = entries.filter(e => e.type === 'swap').length;
    const nMod = entries.filter(e => e.type === 'modify').length;
    if (nAdd) bits.push(`+${nAdd} 玉`);
    if (nRem) bits.push(`−${nRem} 玉`);
    if (nSwp) bits.push(`换 ${nSwp} 玉`);
    if (nMod) bits.push(`改 ${nMod} 玉词条/元素`);
    if (params.length) bits.push(`参数 ${params.length} 项`);
    const dp = mA.dps > 0 ? ((mB.dps - mA.dps) / mA.dps) * 100 : 0;
    const summary = (bits.length ? bits.join('，') : '无结构差异') +
      `　DPS ${EXT.num(mA.dps)} → ${EXT.num(mB.dps)}（${dp >= 0 ? '+' : ''}${round1(dp)}%）`;

    return {
      a: { label: labelA || 'A', metrics: mA, config: A },
      b: { label: labelB || 'B', metrics: mB, config: B },
      params,
      slots: entries,
      metricDelta,
      deltaPct: round2(dp),
      summary,
    };
  }
  EXT.diffConfigs = diffConfigs;

  /* ------------------------------------------------------------------ *
   * 应用配置到主界面
   * ------------------------------------------------------------------ */
  const APP_STORAGE_KEY = 'naraka-souljade-v1';

  /** 把配置写进主引擎状态并刷新 UI（含参数面板控件同步 + 本地存档） */
  function applyConfig(cfg, opts) {
    const o = opts || {};
    const N = host();
    const norm = normalizeConfig(cfg);

    N.state.params = norm.params;
    N.state.slots = norm.slots;

    /* 参数面板控件同步（renderParams 未对外暴露，这里手工对齐） */
    const sc = document.querySelector('#slotCountSelect');
    if (sc) sc.value = String(norm.params.slotCount);
    document.querySelectorAll('[data-param]').forEach(inp => {
      const k = inp.dataset.param;
      if (Object.prototype.hasOwnProperty.call(norm.params, k)) inp.value = String(norm.params[k]);
    });
    document.querySelectorAll('[data-flag]').forEach(inp => {
      const k = inp.dataset.flag;
      if (Object.prototype.hasOwnProperty.call(norm.params, k)) inp.checked = !!norm.params[k];
    });

    N.renderAll();

    if (o.persist !== false) {
      try {
        localStorage.setItem(APP_STORAGE_KEY, JSON.stringify({
          params: N.state.params, slots: N.state.slots, v: 1,
        }));
      } catch (e) { /* 隐私模式忽略 */ }
    }
    return norm;
  }
  EXT.applyConfig = applyConfig;

  /** 从主引擎当前状态取一份可存档的原始配置 */
  function currentConfig() {
    const N = host();
    return { params: clone(N.state.params), slots: clone(N.state.slots) };
  }
  EXT.currentConfig = currentConfig;

  /* ------------------------------------------------------------------ *
   * 极简事件总线（store / ui / optimizer 之间解耦）
   * ------------------------------------------------------------------ */
  const bus = new Map();
  EXT.on = (evt, fn) => {
    if (!bus.has(evt)) bus.set(evt, new Set());
    bus.get(evt).add(fn);
    return () => bus.get(evt).delete(fn);
  };
  EXT.emit = (evt, payload) => {
    const set = bus.get(evt);
    if (!set) return;
    set.forEach(fn => { try { fn(payload); } catch (e) { console.error('[NSJExt]', evt, e); } });
  };

  EXT.ready = () => !!(global.NarakaSoulJade && global.NarakaSoulJade.state);
})(window);
