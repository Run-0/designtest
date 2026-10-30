// V1-02 小规模真实试验运行器（合成案例、隔离数据、共享授权预算）
// 直接用案例的标题与角度构造隔离工作区，避免只改标题造成“任务与角度不一致”。
// 不使用也不输出任何凭据；预算账本由 ai-client 维护。每次运行都会真实计费。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { createInitialState } from '../domain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CASE_IDS = process.argv.slice(2).length ? process.argv.slice(2) : ['v1-01-02', 'v1-01-05', 'v1-01-06'];
const MAX_REQUESTS = CASE_IDS.length * 2;

const suite = JSON.parse(await readFile(join(ROOT, 'test/fixtures/content-cases.json'), 'utf8'));
const cases = CASE_IDS.map(id => {
  const entry = suite.cases.find(item => item.id === id);
  if (!entry) throw new Error(`案例不存在：${id}`);
  return entry;
});

const directory = mkdtempSync(join(tmpdir(), 'solo-pilot-data-'));
const dataFile = join(directory, 'workspace.json');

function workspaceFor(entry) {
  const state = createInitialState();
  const now = new Date().toISOString();
  state.profile.audience = entry.input.profile.audience;
  state.profile.positioning = entry.input.profile.positioning;
  state.profile.tone = entry.input.profile.tone;
  state.sources = entry.input.sources.map(source => ({ ...source, createdAt: now }));
  const item = {
    id: randomUUID(), title: entry.input.task.title, angle: entry.input.task.angle,
    reason: '合成测试案例', estimatedMinutes: 40, status: 'idea', body: '', sourceIds: [],
    revision: 0, review: null, publishedUrl: null, publishedAt: null, metrics: null,
    createdAt: now, updatedAt: now,
  };
  state.items = [item];
  writeFileSync(dataFile, JSON.stringify(state));
  return item;
}

// 每个案例使用全新的服务实例，避免读取到上一个案例的内存状态。
async function withApp(run) {
  const app = createApp({ dataFile, aiDirectory: join(ROOT, '.local') });
  await new Promise((resolveListen, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolveListen);
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(150000),
    });
    let data = null;
    try { data = await response.json(); } catch { /* 保留 null，由调用处报告 */ }
    return { status: response.status, data };
  };
  try { return await run(call); }
  finally {
    await new Promise(resolveClose => { app.close(resolveClose); app.closeAllConnections(); });
  }
}

const before = (await withApp(call => call('GET', '/api/connection/status'))).data;
let lastAttempts = before?.budget?.attempts ?? 0;
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const run = {
  runId: `v1-02-pilot-${stamp}`,
  executedAt: new Date().toISOString(),
  scope: '开发集小规模试跑，不是最终对照实验，也不能用于泛化结论',
  dataset: 'test/fixtures/content-cases.json',
  caseIds: CASE_IDS,
  model: before?.model ?? null,
  budgetBefore: before?.budget ?? null,
  availabilityBefore: before?.availability ?? null,
  plannedMaxRequests: MAX_REQUESTS,
  scorer: 'assistant（实现者自评，不能替代独立评分）',
  cases: [],
};

try {
  for (const entry of cases) {
    const record = { caseId: entry.id, category: entry.category, expectedOutcome: entry.expected.outcome, task: entry.input.task, error: null, errorCode: null, httpStatus: null, body: null, sourceIds: [], cautions: [], toolTrace: null, aiQuery: null, querySource: null };
    try {
      const item = workspaceFor(entry);
      record.itemId = item.id;
      await withApp(async call => {
        const startedAt = new Date().toISOString();
        const draft = await call('POST', `/api/items/${item.id}/ai-draft`, {});
        record.requestWindow = { startedAt, finishedAt: new Date().toISOString() };
        const statusAfter = (await call('GET', '/api/connection/status')).data;
        const attemptsAfter = statusAfter?.budget?.attempts ?? lastAttempts;
        record.requests = attemptsAfter - lastAttempts;
        lastAttempts = attemptsAfter;
        record.budgetAfter = statusAfter?.budget ?? null;

        if (draft.status !== 200) {
          record.error = draft.data?.error ?? `HTTP ${draft.status}`;
          record.errorCode = draft.data?.code ?? null;
          record.httpStatus = draft.status;
        } else {
          const saved = draft.data.items.find(candidate => candidate.id === item.id);
          record.result = saved?.status ?? null;
          record.body = saved?.body ?? null;
          record.sourceIds = saved?.sourceIds ?? [];
          record.cautions = saved?.ai?.cautions ?? [];
          record.toolTrace = saved?.ai?.toolTrace ?? null;
          record.aiQuery = saved?.ai?.query ?? null;
          record.querySource = saved?.ai?.querySource ?? null;
          record.usage = saved?.ai?.usage ?? null;
        }
      });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
    }
    run.cases.push(record);
    console.log(JSON.stringify({ caseId: record.caseId, http: record.httpStatus, code: record.errorCode, bodyLength: record.body ? Array.from(record.body.trim()).length : null, query: record.aiQuery, requests: record.requests }));
  }
} finally {
  const after = (await withApp(call => call('GET', '/api/connection/status'))).data;
  run.budgetAfter = after?.budget ?? null;
  run.requestsTotal = (after?.budget?.attempts ?? 0) - (before?.budget?.attempts ?? 0);
  run.assessment = '待逐条人工核对；未把夹具结构通过或文案可读当成通过';
  mkdirSync(join(HERE, 'runs'), { recursive: true });
  const out = join(HERE, 'runs', `${run.runId}.json`);
  writeFileSync(out, JSON.stringify(run, null, 2));
  console.log(JSON.stringify({ savedTo: out, requestsTotal: run.requestsTotal, budgetAfter: run.budgetAfter }));
}
