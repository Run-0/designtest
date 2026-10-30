import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createInitialState, mutate, report, calculateTimeBudget, InputError } from './domain.mjs';
import { createAiClient, describeAiAvailability } from './ai-client.mjs';
import { generateAiDraft, generateAiPlan, evaluateInspiration } from './ai-workflow.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 192 * 1024;
const PUBLIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/connect.html', ['connect.html', 'text/html; charset=utf-8']],
  ['/connect.js', ['connect.js', 'text/javascript; charset=utf-8']],
]);

function save(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', flag: 'wx' });
  renameSync(temporary, file);
}

function validStoredState(state) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = (value, max, empty = false) => typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= max && !value.includes('\0');
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const number = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const url = value => {
    if (!string(value, 2000)) return false;
    try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch { return false; }
  };
  if (!object(state) || state.schemaVersion !== 1 || state.mode !== 'template' || !object(state.profile)) return false;
  const limits = { name: 80, audience: 300, positioning: 600, platform: 100, tone: 300, goal: 600 };
  if (!Object.entries(limits).every(([key, max]) => string(state.profile[key], max)) || !number(state.profile.weeklyHours, 1, 40)) return false;
  if (!Array.isArray(state.sources) || state.sources.length > 100 || !Array.isArray(state.items) || state.items.length > 500 || !Array.isArray(state.events) || state.events.length > 300) return false;
  if (!state.sources.every(source => object(source) && string(source.id, 100) && string(source.title, 200) && string(source.content, 20000) &&
      ['builtin', 'user'].includes(source.kind) && (source.url === '' || url(source.url)) && date(source.createdAt))) return false;
  const sources = new Set(state.sources.map(source => source.id));
  if (sources.size !== state.sources.length) return false;
  if (!state.items.every(item => {
    if (!object(item) || !string(item.id, 100) || !string(item.title, 200) || !string(item.body, 20000, true) ||
        !string(item.angle, 2000) || !string(item.reason, 2000) || !number(item.estimatedMinutes, 1, 10000) || !number(item.revision, 0, Number.MAX_SAFE_INTEGER) ||
        !['idea', 'draft', 'reviewed', 'approved', 'published'].includes(item.status) || !date(item.createdAt) || !date(item.updatedAt) ||
        !Array.isArray(item.sourceIds) || !item.sourceIds.every(sourceId => sources.has(sourceId))) return false;
    if (item.review !== null && (!object(item.review) || !number(item.review.revision, 0, item.revision) || !date(item.review.createdAt) ||
        !Array.isArray(item.review.checks) || !item.review.checks.every(check => object(check) && ['pass', 'warning', 'blocker'].includes(check.level) && string(check.message, 2000)))) return false;
    if (['reviewed', 'approved', 'published'].includes(item.status) && item.review?.revision !== item.revision) return false;
    if (['approved', 'published'].includes(item.status) && item.review.checks.some(check => check.level === 'blocker')) return false;
    if (item.status === 'published' ? !url(item.publishedUrl) || !date(item.publishedAt) : item.publishedUrl !== null || item.publishedAt !== null || item.metrics !== null) return false;
    if (item.metrics !== null && (!object(item.metrics) || !date(item.metrics.recordedAt) || !['views', 'likes', 'comments', 'saves'].every(key => number(item.metrics[key], 0, 1_000_000_000)))) return false;
    if (item.ai !== undefined && item.ai !== null) {
      const ai = item.ai;
      if (!object(ai) || !string(ai.provider, 40) || !string(ai.model, 80) || !date(ai.createdAt)) return false;
      if (!Array.isArray(ai.cautions) || ai.cautions.length > 12 || !ai.cautions.every(value => string(value, 600))) return false;
      if (!Array.isArray(ai.toolTrace) || ai.toolTrace.length > 5 || !ai.toolTrace.every(entry => object(entry) && string(entry.tool, 80) && string(entry.summary, 2000))) return false;
      if (!Array.isArray(ai.usage) || ai.usage.length > 2 || !ai.usage.every(entry => object(entry) && number(entry.promptTokens, 0, 1_000_000_000) && number(entry.completionTokens, 0, 1_000_000_000) && number(entry.totalTokens, 0, 2_000_000_000))) return false;
      if (!Array.isArray(ai.requestIds) || ai.requestIds.length > 2 || !ai.requestIds.every(value => string(value, 100))) return false;
      if (ai.query !== undefined && !string(ai.query, 80)) return false;
      if (ai.querySource !== undefined && !['model', 'fallback:title'].includes(ai.querySource)) return false;
      if (ai.citations !== undefined) {
        if (!Array.isArray(ai.citations) || ai.citations.length > 20 || !ai.citations.every(c => object(c) && number(c.ref, 1, 100) && string(c.sourceTitle, 200) && string(c.quote, 300))) return false;
      }
      if (ai.retrievedChunks !== undefined) {
        if (!Array.isArray(ai.retrievedChunks) || ai.retrievedChunks.length > 20 || !ai.retrievedChunks.every(c => object(c) && string(c.chunkId, 100) && string(c.sourceId, 100) && string(c.sourceTitle, 200) && string(c.text, 5000))) return false;
      }
    }
    return true;
  })) return false;
  if (new Set(state.items.map(item => item.id)).size !== state.items.length) return false;
  return state.events.every(entry => object(entry) && string(entry.id, 100) && string(entry.type, 100) && string(entry.message, 4000) && date(entry.createdAt));
}

function load(file) {
  if (!existsSync(file)) {
    const state = createInitialState();
    save(file, state);
    return state;
  }
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('本地数据无法读取。为保护资料，服务已停止；原文件不会被覆盖。请从备份恢复。'); }
  if (!validStoredState(state)) {
    throw new Error('本地数据格式不受支持或记录已损坏。为保护资料，未重置或覆盖原文件。');
  }
  return state;
}

function json(res, status, value, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(value));
}

async function bodyOf(req) {
  const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new InputError('写入请求须使用 application/json。', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new InputError('提交内容过大，请精简参考资料。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new InputError('请求不是有效的 JSON。'); }
}

export function createApp({ dataFile = join(ROOT, 'data', 'workspace.json'), aiDirectory = null, aiClient = null } = {}) {
  let state = load(dataFile);
  // aiClient 仅供自动化测试注入假模型；正常运行只按 aiDirectory 创建真实客户端。
  const ai = aiClient ?? (aiDirectory ? createAiClient({ directory: aiDirectory, allowToppedUp: true }) : null);
  let aiOperation = false;
  const connectionStatus = () => {
    const budget = { limitCny: 1, reservedCny: 0, remainingCny: 1, attempts: 0 };
    const result = ai?.status() ?? { configured: false, provider: 'DeepSeek', model: 'deepseek-flash', lastVerifiedAt: null, budget,
      availability: describeAiAvailability({ configured: false, budget }) };
    if (aiOperation && result.availability.canGenerateDraft) {
      result.availability = describeAiAvailability({ configured: result.configured, budget: result.budget, locked: true });
    }
    return result;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host ?? '';
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) throw new InputError('仅接受本机地址访问。', 403);
      if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) {
        throw new InputError('不允许其他网站访问本地工作台接口。', 403);
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('不允许跨站请求。', 403);
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
      if (req.method === 'GET' && url.pathname === '/api/report') return json(res, 200, report(state));
      if (req.method === 'GET' && url.pathname === '/api/connection/status') return json(res, 200, connectionStatus());
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, mode: 'template', modelConnected: connectionStatus().configured, platformConnected: false });
      if (req.method === 'GET' && url.pathname === '/api/export') {
        return json(res, 200, state, { 'Content-Disposition': `attachment; filename="solo-workspace-${new Date().toISOString().slice(0, 10)}.json"` });
      }
      if (req.method === 'POST' && url.pathname === '/api/connection/key') {
        if (!ai) throw new InputError('隔离测试服务不允许保存真实凭据。');
        const input = await bodyOf(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('凭据请求格式错误。');
        return json(res, 200, await ai.installKey(input, { overwrite: true }));
      }
      if (req.method === 'POST' && url.pathname === '/api/plan/evaluate-idea') {
        const input = await bodyOf(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('请求格式错误。');
        if (!ai) throw new InputError('隔离测试服务未配置模型客户端。');
        const availability = connectionStatus().availability;
        if (!availability.canGenerateDraft) throw new InputError(availability.message, availability.code === 'request_locked' ? 409 : 400);
        aiOperation = true;
        try {
          const result = await evaluateInspiration(ai, structuredClone(state), { idea: input.idea });
          return json(res, 200, result);
        } finally { aiOperation = false; }
      }
      if (req.method === 'POST' && url.pathname === '/api/plan/ai-suggest') {
        await bodyOf(req);
        if (!ai) throw new InputError('隔离测试服务未配置模型客户端。');
        const availability = connectionStatus().availability;
        if (!availability.canGenerateDraft) throw new InputError(availability.message, availability.code === 'request_locked' ? 409 : 400);
        const budget = calculateTimeBudget(state);
        if (budget.remainingMinutes < 20) {
          throw new InputError(`当前本周时间预算仅剩约 ${budget.remainingMinutes} 分钟，不足以规划新内容（每篇至少需 20 分钟）。请先完成已有任务或调整每周时间。`, 400);
        }
        aiOperation = true;
        try {
          const result = await generateAiPlan(ai, structuredClone(state), { remainingMinutes: budget.remainingMinutes });
          return json(res, 200, {
            candidates: result.candidates,
            totalMinutes: result.totalMinutes,
            remainingMinutes: result.remainingMinutes,
            reason: result.reason,
            budget,
          });
        } finally { aiOperation = false; }
      }
      const aiMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/ai-draft$/);
      if (req.method === 'POST' && aiMatch) {
        await bodyOf(req);
        const availability = connectionStatus().availability;
        if (!availability.canGenerateDraft) throw new InputError(availability.message, availability.code === 'request_locked' ? 409 : 400);
        const item = state.items.find(entry => entry.id === aiMatch[1]);
        if (!item) throw new InputError('内容不存在。', 404);
        const originalRevision = item.revision;
        const originalSources = JSON.stringify(state.sources);
        const originalProfile = JSON.stringify(state.profile);
        aiOperation = true;
        try {
          const result = await generateAiDraft(ai, structuredClone(state), structuredClone(item));
          const current = state.items.find(entry => entry.id === item.id);
          if (!current || current.revision !== originalRevision || current.status === 'published' || JSON.stringify(state.sources) !== originalSources || JSON.stringify(state.profile) !== originalProfile) {
            throw new InputError('生成期间内容或资料已变化，为保护你的修改，未覆盖原稿；本次模型请求已发生。', 409);
          }
          const updated = mutate(state, 'PATCH', `/api/items/${item.id}`, { title: result.title, body: result.body });
          const generated = updated.items.find(entry => entry.id === item.id);
          generated.sourceIds = result.sourceIds;
          generated.ai = result.ai;
          updated.events.unshift({ id: randomUUID(), type: 'ai-draft', message: `「${result.title}」已通过真实 DeepSeek 模型与本机资料读取工具起草，尚待人工核实，未发布。`, createdAt: new Date().toISOString() });
          updated.events = updated.events.slice(0, 300);
          save(dataFile, updated);
          state = updated;
          return json(res, 200, state);
        } finally { aiOperation = false; }
      }
      if (['POST', 'PATCH', 'DELETE'].includes(req.method) && url.pathname.startsWith('/api/')) {
        const input = await bodyOf(req);
        // All mutations and writes are synchronous after body parsing. Failed transactions do not replace state.
        const updated = mutate(state, req.method, url.pathname, input);
        save(dataFile, updated);
        state = updated;
        return json(res, 200, state);
      }
      if (req.method === 'GET' && PUBLIC_FILES.has(url.pathname)) {
        const [name, type] = PUBLIC_FILES.get(url.pathname);
        let content;
        try { content = readFileSync(join(ROOT, 'public', name)); }
        catch (error) { if (error.code === 'ENOENT') throw new InputError('页面文件尚未准备好。', 503); throw error; }
        res.writeHead(200, { 'Content-Type': type });
        return res.end(content);
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      throw new InputError('未找到页面或接口。', 404);
    } catch (error) {
      if (error instanceof InputError) {
        return json(res, error.status, { error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) });
      }
      console.error('本地服务错误：', error.message);
      return json(res, 500, { error: '本地保存或读取失败，未确认成功。请检查磁盘空间与文件权限后重试。' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('PORT 必须是 1024 到 65535 的整数。');
    process.exitCode = 1;
  } else {
    try {
      const app = createApp({ aiDirectory: join(ROOT, '.local') });
      app.on('error', error => {
        console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。如果工作台已启动，请直接打开 http://127.0.0.1:${port}` : error.message);
        process.exitCode = 1;
      });
      app.listen(port, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${port}`;
        console.log(`一人效率实验室：${url}\n模式：本地人工审核工作台；AI 连接状态请看页面。不连接发布平台账号。\n数据保存在：${join(ROOT, 'data', 'workspace.json')}\n关闭此窗口或按 Ctrl+C 停止服务。`);
        if (process.argv.includes('--open') && process.platform === 'win32') {
          execFile('cmd.exe', ['/c', 'start', '', url], error => {
            if (error) console.log(`浏览器未自动打开，请手动访问：${url}`);
          });
        }
      });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
