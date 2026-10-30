// 浏览器回归检查：不依赖第三方包，使用 Node 22 内置 WebSocket 驱动本机 Edge/Chrome 的 CDP。
// 只连隔离临时数据实例，不读取真实凭据或用户工作区，不调用外部模型。
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createApp } from '../server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
  }
  async open() {
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', resolveOpen, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('无法连接浏览器调试端口')), { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else done(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(message.params.exceptionDetails?.text ?? '页面异常');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push((message.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' '));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`浏览器指令超时：${method}`));
      }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch { /* 已关闭 */ } }
}

const PAGE_SCRIPT = String.raw`async () => {
  const $ = selector => document.querySelector(selector);
  const results = [];
  const waitIdle = () => new Promise((resolveWait, reject) => {
    const main = $('#main-content');
    if (!main || main.getAttribute('aria-busy') !== 'true') return resolveWait();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('操作等待超时')); }, 15000);
    const observer = new MutationObserver(() => {
      if (main.getAttribute('aria-busy') !== 'true') { clearTimeout(timer); observer.disconnect(); resolveWait(); }
    });
    observer.observe(main, { attributes: true, attributeFilter: ['aria-busy'] });
  });
  const waitFor = (predicate, label) => new Promise((resolveWait, reject) => {
    if (predicate()) return resolveWait();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error(label)); }, 15000);
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolveWait(); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const set = (selector, value) => {
    const field = $(selector);
    if (!field) throw new Error('找不到输入框 ' + selector);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const step = async (name, work) => {
    try { const detail = await work(); results.push({ name, ok: true, detail: detail ?? null }); }
    catch (error) { results.push({ name, ok: false, detail: error.message }); }
  };
  const go = async page => { $('[data-page="' + page + '"]').click(); await waitFor(() => !$('#page-' + page).hidden, '页面未切换：' + page); };

  await step('AI 未配置时按钮禁用并给出原因', async () => {
    await go('studio');
    await waitFor(() => $('#mode-badge').textContent.length > 0, '状态未加载');
    if (!$('#ai-draft').disabled) throw new Error('AI 按钮应禁用');
    return $('#connection-message').textContent.slice(0, 60);
  });

  await step('添加参考资料', async () => {
    await go('sources');
    set('#source-form [name="title"]', '浏览器回归测试资料');
    set('#source-form [name="content"]', '这是浏览器回归脚本写入的合成资料，仅用于验证流程：先把待办分成必须完成、可以推进、暂缓处理三类，再为每项写下一步动作。');
    $('#source-form').requestSubmit();
    await waitIdle();
    await waitFor(() => document.querySelectorAll('.source-card').length === 2, '资料未出现');
  });

  await step('创建计划并生成模板草稿', async () => {
    await go('studio');
    set('#plan-count', '1');
    $('#plan-form').requestSubmit();
    await waitIdle();
    await waitFor(() => document.querySelectorAll('.content-card').length === 1, '计划未创建');
    $('#generate-draft').click();
    await waitIdle();
    if (!($('#editor-body').value || '').includes('模板草稿')) throw new Error('模板草稿未生成');
    if (!$('#generate-draft').disabled) throw new Error('已有正文时模板按钮应禁用');
  });

  await step('编辑、检查并人工确认', async () => {
    set('#editor-body', '这是浏览器回归脚本写入的完整正文，不是真实发布内容。把一周任务分为必须完成、可以推进、暂缓处理三类，再为每一项写下下一步动作。周末检查实际完成情况，并根据记录调整安排。本段仅用于验证编辑、检查、人工确认与发布登记流程，不声称已经验证效率收益。');
    $('#review-draft').click();
    await waitIdle();
    await waitFor(() => $('#review-results .check-list') !== null, '检查结果未出现');
    if ($('#approve-draft').disabled === false) throw new Error('未勾选人工确认时不应允许提交');
    $('#human-confirm').click();
    if ($('#approve-draft').disabled) throw new Error('勾选后仍不能确认');
    $('#approve-form').requestSubmit();
    await waitIdle();
    await waitFor(() => $('#editor-status').textContent.includes('待发布'), '未进入待发布');
  });

  await step('登记发布网址并录入数据', async () => {
    set('#published-url', 'https://example.com/browser-regression-not-a-real-post');
    $('#publish-form').requestSubmit();
    await waitIdle();
    await waitFor(() => $('#editor-status').textContent.includes('已登记发布'), '未登记发布');
    await go('report');
    await waitFor(() => $('#metrics-item').options.length > 0, '复盘下拉未加载');
    set('#metrics-form [name="views"]', '100');
    set('#metrics-form [name="likes"]', '15');
    set('#metrics-form [name="comments"]', '3');
    set('#metrics-form [name="saves"]', '2');
    $('#metrics-form').requestSubmit();
    await waitIdle();
    await waitFor(() => $('#report-rows').textContent.includes('20%'), '互动率未显示 20%');
  });

  return { results, title: document.title };
}`;

const NARROW_SCRIPT = String.raw`async () => {
  const $ = selector => document.querySelector(selector);
  const waitFor = predicate => new Promise((resolveWait, reject) => {
    if (predicate()) return resolveWait();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('页面切换超时')); }, 10000);
    const observer = new MutationObserver(() => {
      if (predicate()) { clearTimeout(timer); observer.disconnect(); resolveWait(); }
    });
    observer.observe(document.body, { subtree: true, attributes: true });
  });
  const overflow = [];
  for (const page of ['overview', 'studio', 'sources', 'report', 'roadmap']) {
    $('[data-page="' + page + '"]').click();
    await waitFor(() => !$('#page-' + page).hidden);
    if (document.documentElement.scrollWidth > window.innerWidth + 1) overflow.push(page);
  }
  return { width: window.innerWidth, overflow };
}`;

async function main() {
  const browserPath = BROWSERS.find(existsSync);
  if (!browserPath) throw new Error('未找到 Edge 或 Chrome，可手动执行浏览器检查');
  const dataDirectory = mkdtempSync(join(tmpdir(), 'solo-ui-data-'));
  const profileDirectory = mkdtempSync(join(tmpdir(), 'solo-ui-profile-'));
  const debugPort = await freePort();
  const app = createApp({ dataFile: join(dataDirectory, 'workspace.json') });
  await new Promise((resolveListen, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolveListen); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDirectory}`, 'about:blank',
  ], { stdio: 'ignore' });
  let cdp;
  try {
    let version = null;
    for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (response.ok) version = await response.json();
      } catch { await sleep(250); }
    }
    if (!version) throw new Error('浏览器调试端口未就绪');
    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.navigate', { url: `${base}/#studio` }, sessionId);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const state = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId);
      if (state.result.value === 'complete' && (await cdp.send('Runtime.evaluate', { expression: "Boolean(document.querySelector('#main-content'))", returnByValue: true }, sessionId)).result.value) break;
      await sleep(250);
    }
    const evaluated = await cdp.send('Runtime.evaluate', { expression: `(${PAGE_SCRIPT})()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (evaluated.exceptionDetails) throw new Error(`页面脚本异常：${evaluated.exceptionDetails.text}`);
    const report = evaluated.result.value;
    const failures = report.results.filter(entry => !entry.ok);
    for (const entry of report.results) console.log(`${entry.ok ? '通过' : '失败'}｜${entry.name}${entry.detail ? '｜' + entry.detail : ''}`);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
    await sleep(400);
    const narrow = await cdp.send('Runtime.evaluate', { expression: `(${NARROW_SCRIPT})()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (narrow.exceptionDetails) throw new Error(`窄屏检查异常：${narrow.exceptionDetails.text}`);
    const narrowReport = narrow.result.value;
    const narrowOk = narrowReport.width === 390 && narrowReport.overflow.length === 0;
    console.log(`${narrowOk ? '通过' : '失败'}｜390px 五页无横向溢出｜宽度 ${narrowReport.width}${narrowReport.overflow.length ? '，溢出 ' + narrowReport.overflow.join(',') : ''}`);
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

    if (cdp.consoleErrors.length) console.log('控制台错误：' + cdp.consoleErrors.join(' / '));
    if (failures.length) throw new Error(`${failures.length} 个步骤失败`);
    if (!narrowOk) throw new Error('390px 布局检查失败');
    if (cdp.consoleErrors.length) throw new Error('页面控制台出现错误');
    console.log('浏览器回归完成：全部步骤通过（隔离数据，未调用模型）');
  } finally {
    cdp?.close();
    browser.kill();
    await new Promise(resolveClose => { app.close(resolveClose); app.closeAllConnections(); });
    await sleep(500);
    try { rmSync(dataDirectory, { recursive: true, force: true }); } catch { /* Windows 可能仍占用 */ }
    try { rmSync(profileDirectory, { recursive: true, force: true }); } catch { /* Windows 可能仍占用 */ }
  }
}

main().catch(error => {
  console.error('浏览器回归失败：' + error.message);
  process.exitCode = 1;
});
