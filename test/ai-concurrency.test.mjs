import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

// 注入假模型，只验证服务端并发与冲突处理；不联网、不读取真实凭据、不花钱。
const BODY = '这是并发测试用的合成正文，不代表真实内容。先列出待办，再写下一步动作，最后记录适用边界。'.repeat(4);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fakeAi({ gate, started, sourceId }) {
  let calls = 0;
  return {
    status: () => ({
      configured: true, provider: 'DeepSeek', model: 'deepseek-flash', lastVerifiedAt: new Date().toISOString(),
      budget: { limitCny: 1, reservedCny: 0, remainingCny: 1, attempts: 0 },
      availability: { code: 'ready', canGenerateDraft: true, message: '测试用已就绪', checkedAt: new Date().toISOString(), priceCheckedUntil: new Date(Date.now() + 3600_000).toISOString(), remoteChecked: false },
    }),
    async chat() {
      calls += 1;
      if (calls === 1) return { message: { content: JSON.stringify({ query: '待办 下一步' }) }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'deepseek-flash', requestId: 'fake-1' };
      started.resolve();
      await gate.promise;
      return {
        message: { content: JSON.stringify({ status: 'draft', reason: '', missing: [], title: '假模型草稿', body: BODY, usedSourceIds: [sourceId.value], cautions: [] }) },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: 'deepseek-flash', requestId: 'fake-2',
      };
    },
  };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'solo-concurrency-test-'));
  const dataFile = join(directory, 'workspace.json');
  const gate = deferred();
  const started = deferred();
  const sourceId = { value: '' };
  const app = createApp({ dataFile, aiClient: fakeAi({ gate, started, sourceId }) });
  t.after(async () => {
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const planned = await call('POST', '/api/plan', { count: 1 });
  assert.equal(planned.status, 200);
  sourceId.value = planned.data.sources[0].id;
  return { directory, dataFile, gate, started, call, itemId: planned.data.items[0].id };
}

test('生成期间被修改：结果不覆盖新稿，返回409并保留修改', async t => {
  const f = await fixture(t);
  const pending = f.call('POST', `/api/items/${f.itemId}/ai-draft`, {});
  await f.started.promise;
  const edited = await f.call('PATCH', `/api/items/${f.itemId}`, { title: '生成期间的新标题', body: '生成期间写下的新正文。', expectedRevision: 0 });
  assert.equal(edited.status, 200);
  f.gate.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.match(result.data.error, /生成期间内容或资料已变化/);
  const state = (await f.call('GET', '/api/state')).data;
  assert.equal(state.items[0].title, '生成期间的新标题');
  assert.equal(state.items[0].body, '生成期间写下的新正文。');
  assert.equal(state.items[0].ai, undefined, '失败时不得写入模型记录');
});

test('同一时间第二次起草被拒绝，不排队也不重复花费', async t => {
  const f = await fixture(t);
  const first = f.call('POST', `/api/items/${f.itemId}/ai-draft`, {});
  await f.started.promise;
  const second = await f.call('POST', `/api/items/${f.itemId}/ai-draft`, {});
  assert.equal(second.status, 409);
  assert.match(second.data.error, /正在执行/);
  f.gate.resolve();
  assert.equal((await first).status, 200);
});

test('生成期间修改账号定位也会阻止覆盖', async t => {
  const f = await fixture(t);
  const pending = f.call('POST', `/api/items/${f.itemId}/ai-draft`, {});
  await f.started.promise;
  const profile = await f.call('POST', '/api/profile', { audience: '生成期间改变的目标读者' });
  assert.equal(profile.status, 200);
  f.gate.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  const state = (await f.call('GET', '/api/state')).data;
  assert.equal(state.profile.audience, '生成期间改变的目标读者');
  assert.equal(state.items[0].ai, undefined);
  const bytes = await readFile(f.dataFile, 'utf8');
  assert.equal(JSON.parse(bytes).items[0].ai, undefined);
});
