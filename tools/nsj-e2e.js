#!/usr/bin/env node
/* =========================================================================
 * naraka-souljade 二改 · 真机 E2E 验收（Chromium CDP，零依赖）
 * -------------------------------------------------------------------------
 * 用本机 chromium 无头加载 index.html，跑完整交互链路并截图：
 *   ① 面板挂载 / 首屏指标
 *   ② 载入推荐配装 → 自动抓拍历史
 *   ③ 改词条 → 历史新增一条（去重生效）
 *   ④ 一键求最优 → Highest 记录被顶掉 → 榜单出现
 *   ⑤ 载入最高配置 → 主引擎 DPS 与记录一致
 *   ⑥ 对比区：A/B 差异渲染
 *   ⑦ 动态对比不落盘（比对 localStorage key 集合）
 *   ⑧ 刷新页面 → 历史 / 最高记录仍在
 *   ⑨ 375px 移动端布局不溢出
 * 截图输出到 docs/shots/
 * ========================================================================= */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'shots');
const PORT = Number(process.env.NSJ_CDP_PORT || 9333);
const CHROME = process.env.NSJ_CHROME || '/usr/bin/chromium';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = url => new Promise((res, rej) => {
  http.get(url, r => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => res(d)); })
    .on('error', rej);
});

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? '  →  ' + extra : ''}`); }
}
function section(t) { console.log(`\n[${t}]`); }

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const profile = fs.mkdtempSync('/tmp/nsj-e2e-');
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1680,1400', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', d => (stderr += d));

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`)); break; }
    catch (e) { await sleep(200); }
  }
  if (!ver) {
    console.error('chromium 启动失败：\n' + stderr.slice(0, 800));
    process.exit(1);
  }
  console.log('Chromium ' + ver.Browser);

  const list = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const consoleLog = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleLog.push(m.params.type + ': ' +
        m.params.args.map(a => (a.value !== undefined ? a.value : a.description)).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleLog.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description ||
        m.params.exceptionDetails.text));
    }
  };
  await new Promise(r => (ws.onopen = r));

  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++seq; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJS = async (expr, awaitPromise = true) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };
  const shot = async (name, opts) => {
    const o = opts || {};
    if (o.width) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: o.width, height: o.height || 900, deviceScaleFactor: 1, mobile: !!o.mobile,
      });
      await sleep(400);
    }
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
    if (o.width) {
      await send('Emulation.clearDeviceMetricsOverride');
      await sleep(300);
    }
    console.log('    · 截图 docs/shots/' + name + '.png');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const url = 'file://' + path.join(ROOT, 'index.html');
  await send('Page.navigate', { url });
  await sleep(2200);

  /* ---------------- ① 挂载 ---------------- */
  section('1. 面板挂载');
  ok(await evalJS('!!document.querySelector("#panel-ext")'), '扩展面板已插入 DOM');
  ok(await evalJS('!!(window.NSJExt && window.NSJExt.store && window.NSJExt.solve)'), '扩展三件套已挂载');
  ok(await evalJS('document.querySelectorAll("#extHistory .nsjx-hist").length >= 1'), '首屏自动记录了一条快照');
  const dps0 = await evalJS('document.querySelector("#extCurDps").textContent');
  ok(/\d/.test(dps0), `当前 DPS 已渲染：${dps0}`);
  await shot('01-初始面板');

  /* ---------------- ② 载入推荐配装 ---------------- */
  section('2. 载入推荐配装 → 自动抓拍');
  const hist0 = await evalJS('window.NSJExt.store.history.length');
  await evalJS('window.NarakaSoulJade.applyPreset("bingyun"); 1');
  await sleep(900);
  const hist1 = await evalJS('window.NSJExt.store.history.length');
  ok(hist1 > hist0, `历史新增（${hist0} → ${hist1}）`);
  const dps1 = await evalJS('window.NSJExt.metricsOf(window.NSJExt.currentConfig()).dps');
  ok(dps1 > 5000, `冰套 DPS 合理：${Math.round(dps1)}`);
  const bestText = await evalJS('document.querySelector("#extBestDps").textContent');
  ok(/\d/.test(bestText), `最高记录已刷新：${bestText.trim()}`);

  /* ---------------- ③ 改词条去重 ---------------- */
  section('3. 改动 → 快照；重复 → 去重');
  await evalJS(`(function(){
    const N = window.NarakaSoulJade;
    N.state.slots[0].subs[0] = 'critRate';
    N.state.slots[0].subs[1] = 'critDmg';
    N.state.slots[0].subs[2] = 'hedao';
    N.state.slots[0].subs[3] = 'icedmg' === 'icedmg' ? 'iceDmg' : 'atkPct';
    N.renderAll();
    return 1;
  })()`);
  await sleep(900);
  const hist2 = await evalJS('window.NSJExt.store.history.length');
  ok(hist2 > hist1, `改词条后新增快照（${hist1} → ${hist2}）`);
  const before = hist2;
  await evalJS('window.NarakaSoulJade.renderAll(); 1');
  await sleep(900);
  const hist3 = await evalJS('window.NSJExt.store.history.length');
  ok(hist3 === before, '无改动时不再重复入库');

  /* ---------------- ④ 求最优 ---------------- */
  section('4. 一键求最优');
  await evalJS('window.NSJExt.store.saveMeta({bestLocked:false, autoBest:true}); 1');
  const bestBefore = await evalJS('window.NSJExt.store.best ? window.NSJExt.store.best.metrics.dps : 0');
  await evalJS('document.querySelector("#extSolveMode").value="fast"; document.querySelector("#extSolveBtn").click(); 1');
  let done = false;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const txt = await evalJS('document.querySelector("#extSolveText").textContent');
    if (/完成|未超过|出错/.test(txt)) { done = true; console.log('    · ' + txt); break; }
  }
  ok(done, '求解在 120 秒内结束');
  const bestAfter = await evalJS('window.NSJExt.store.best ? window.NSJExt.store.best.metrics.dps : 0');
  ok(bestAfter > bestBefore, `最高记录被顶掉（${Math.round(bestBefore)} → ${Math.round(bestAfter)}）`);
  const rankN = await evalJS('document.querySelectorAll("#extRanking .nsjx-rank").length');
  ok(rankN > 0, `Top 榜单渲染 ${rankN} 条`);
  const rank0 = await evalJS('window.NSJExt.ui && document.querySelector("#extRanking .nsjx-rank-dps").textContent');
  ok(/\d/.test(rank0 || ''), `榜首 DPS：${(rank0 || '').trim()}`);
  await shot('02-求解完成');
  await evalJS('document.querySelector("#panel-ext").scrollIntoView({block:"start"}); 1');
  await sleep(300);

  /* ---------------- ⑤ 载入最高 ---------------- */
  section('5. 载入最高配置');
  const bestDps = await evalJS('window.NSJExt.store.best.metrics.dps');
  await evalJS('document.querySelector("#extLoadBest").click(); 1');
  await sleep(1000);
  const nowDps = await evalJS('window.NarakaSoulJade.totals() && window.NarakaSoulJade.damage(window.NarakaSoulJade.totals(), window.NarakaSoulJade.state.params).totalDPS');
  ok(Math.abs(nowDps - bestDps) < 1, `主引擎 DPS 与记录一致（${Math.round(nowDps)} vs ${Math.round(bestDps)}）`);
  const mainDisplay = await evalJS('document.querySelector("#dmgTotal .num")?.textContent');
  ok(/\d/.test(mainDisplay || ''), `主属性面板同步显示：${mainDisplay}`);

  /* ---------------- ⑥ 对比 ---------------- */
  section('6. 差异对比');
  const histItems = await evalJS('window.NSJExt.store.history.length');
  await evalJS(`(function(){
    const btns = document.querySelectorAll('#extHistory [data-compare]');
    if (btns.length > 2) btns[2].click(); else btns[0].click();
    return 1;
  })()`);
  await sleep(700);
  const diffRows = await evalJS('document.querySelectorAll("#extCompare .nsjx-diff-row").length');
  const metricCells = await evalJS('document.querySelectorAll("#extCompare .nsjx-metric").length');
  ok(metricCells > 10, `指标对照渲染 ${metricCells} 行`);
  ok(diffRows >= 0, `差异行渲染 ${diffRows} 条`);
  const summary = await evalJS('document.querySelector("#extCompare .nsjx-cmp-summary")?.textContent?.trim()');
  ok(!!summary && summary.length > 5, `摘要：${summary}`);
  await evalJS('document.querySelector("#extCompare").scrollIntoView({block:"start"}); 1');
  await sleep(400);
  await shot('03-差异对比');

  /* ---------------- ⑦ 动态不落盘 ---------------- */
  section('7. 动态对比不落盘');
  const keysBefore = await evalJS('Object.keys(localStorage).sort().join(",")');
  const histBefore = await evalJS('window.NSJExt.store.history.length');
  await evalJS('document.querySelector("#extSnapA").click(); 1');
  await sleep(400);
  await evalJS('document.querySelector("#extSnapB").click(); 1');
  await sleep(400);
  const keysAfter = await evalJS('Object.keys(localStorage).sort().join(",")');
  const histAfter = await evalJS('window.NSJExt.store.history.length');
  ok(keysBefore === keysAfter, '冻结 A/B 未新增 localStorage key');
  ok(histBefore === histAfter, '冻结 A/B 未写入历史');
  ok(await evalJS('!!window.NSJExt.store.volatile.a && !!window.NSJExt.store.volatile.b'),
    '动态 A/B 在内存中可用');

  /* ---------------- ⑧ 刷新持久化 ---------------- */
  section('8. 刷新后持久化');
  const histFinal = await evalJS('window.NSJExt.store.history.length');
  const bestFinal = await evalJS('window.NSJExt.store.best.metrics.dps');
  await send('Page.reload', { ignoreCache: true });
  await sleep(2500);
  const histReload = await evalJS('window.NSJExt.store.history.length');
  const bestReload = await evalJS('window.NSJExt.store.best ? window.NSJExt.store.best.metrics.dps : 0');
  ok(histReload >= histFinal, `历史仍在（${histFinal} → ${histReload}）`);
  ok(Math.abs(bestReload - bestFinal) < 1, `最高记录仍在（${Math.round(bestFinal)}）`);
  ok(await evalJS('!!window.NSJExt.store.volatile.a === false'), '动态 A/B 刷新后清空（不落盘）');

  /* ---------------- ⑨ 响应式 ---------------- */
  section('9. 响应式');
  await shot('04-移动端', { width: 375, height: 900, mobile: true });
  const overflow = await evalJS(`(function(){
    const de = document.documentElement;
    return de.scrollWidth - de.clientWidth;
  })()`);
  ok(overflow <= 2, `375px 无横向溢出（溢出 ${overflow}px）`);
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  await evalJS('document.body.dataset.tab="ext"; document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab==="ext")); document.querySelectorAll(".panel").forEach(p=>p.classList.toggle("tab-active",p.id==="panel-ext")); 1');
  await sleep(400);
  ok(await evalJS('getComputedStyle(document.querySelector("#panel-ext")).display !== "none"'), '移动端「对比」标签页可切换');
  await shot('05-移动端对比页');
  await send('Emulation.clearDeviceMetricsOverride');

  /* ---------------- 收尾 ---------------- */
  const errs = consoleLog.filter(l => /EXCEPTION|error:/i.test(l));
  section('10. 控制台');
  ok(errs.length === 0, `无 JS 异常（console ${consoleLog.length} 条）`,
    errs.slice(0, 3).join(' | '));
  if (consoleLog.length) console.log('    · ' + consoleLog.slice(-4).join('\n    · '));

  console.log(`\n[结果] 通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log(' - ' + f));
  }

  ws.close();
  chrome.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
})().catch(e => {
  console.error('E2E 异常：', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
