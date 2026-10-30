import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createApp } from '../server.mjs';
import { createInitialState, mutate } from '../domain.mjs';

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

// 所有磁盘写入限于本次 mkdtemp 目录；从不调用默认 dataFile。
async function sandbox(t, existingBytes) {
  const directory = await mkdtemp(join(tmpdir(), 'solo-workbench-node-test-'));
  const dataFile = join(directory, 'workspace.json');
  const servers = new Set();
  t.after(async () => {
    try {
      await Promise.all([...servers].map(closeServer));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  if (existingBytes !== undefined) await writeFile(dataFile, existingBytes, 'utf8');
  function create() {
    const server = createApp({ dataFile });
    servers.add(server);
    return server;
  }
  async function start() {
    const server = create();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    assert.equal(server.address().address, '127.0.0.1');
    assert.ok(server.address().port > 0);
    return server;
  }
  return { directory, dataFile, create, start };
}

// 使用原生 http.request，保留原始请求路径，避免 fetch 预先规范化遍历路径。
function request(server, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, path, method, agent: false,
      // 禁止 Node 自动补全空 Host，确保恶意请求测试真正发送指定头。
      setHost: false,
      headers: {
        Host: `127.0.0.1:${server.address().port}`,
        ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }), ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({
            status: res.statusCode, headers: res.headers, text,
            json: text && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : null,
          });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('本机测试请求超时')));
    req.end(body);
  });
}

const write = (server, method, path, body = {}, headers = {}) => request(server, path, {
  method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
});

async function getState(server) {
  const response = await request(server, '/api/state');
  assert.equal(response.status, 200);
  return response.json;
}

async function snapshot(server, fixture) {
  return { state: await getState(server), bytes: await readFile(fixture.dataFile, 'utf8') };
}

async function unchanged(server, fixture, before) {
  assert.deepEqual(await getState(server), before.state, '拒绝请求后内存 state 不变');
  assert.equal(await readFile(fixture.dataFile, 'utf8'), before.bytes, '拒绝请求后磁盘字节不变');
}

function errorResponse(response, status) {
  assert.equal(response.status, status, response.text);
  assert.match(response.headers['content-type'], /^application\/json\b/);
  assert.equal(typeof response.json.error, 'string');
  assert.ok(response.json.error.length > 0);
}

test('HTTP：随机 loopback 端口，新状态仅写入临时目录，健康检查明确未连接模型和平台', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const state = await getState(server);
  assert.equal(state.mode, 'template');
  assert.deepEqual(state.items, []);
  assert.deepEqual(JSON.parse(await readFile(fixture.dataFile, 'utf8')), state);
  assert.deepEqual(await readdir(fixture.directory), ['workspace.json']);
  const health = await request(server, '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, mode: 'template', modelConnected: false, platformConnected: false });
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.match(health.headers['content-security-policy'], /default-src 'self'/);
});

test('HTTP：完整人工工作流持久化，关闭服务再启动后 state 与报告保持一致', async t => {
  const fixture = await sandbox(t);
  const first = await fixture.start();
  let response = await write(first, 'POST', '/api/profile', { name: '隔离测试工作台', weeklyHours: 40 });
  assert.equal(response.status, 200);
  response = await write(first, 'POST', '/api/sources', { title: '测试自有记录', content: '先记录待办，再复盘下一步，不宣称已有真实实验结果。' });
  assert.equal(response.status, 200);
  const sourceId = response.json.sources.at(-1).id;
  response = await write(first, 'POST', '/api/plan', { count: 1 });
  assert.equal(response.status, 200);
  const id = response.json.items[0].id;
  for (const [method, suffix, body] of [
    ['POST', '/draft', {}],
    ['PATCH', '', { title: '持久化测试标题', body: '这是自动测试正文：先写出要做的事情，再拆解下一步，最后记录适用边界；只是测试工作流，不代表真实实验数据，也不声称有自动发布或事实核查能力。' }],
    ['POST', '/review', {}],
    ['POST', '/approve', {}],
    ['POST', '/publish', { url: 'https://example.com/manual-post' }],
    ['POST', '/metrics', { views: 100, likes: 10, comments: 5, saves: 5 }],
  ]) {
    response = await write(first, method, `/api/items/${id}${suffix}`, body);
    assert.equal(response.status, 200, `${method} ${suffix}: ${response.text}`);
    assert.deepEqual(JSON.parse(await readFile(fixture.dataFile, 'utf8')), response.json);
  }
  const saved = response.json;
  assert.equal(saved.profile.name, '隔离测试工作台');
  assert.equal(saved.items[0].status, 'published');
  assert.deepEqual(saved.items[0].sourceIds, [sourceId]);
  const reportBefore = await request(first, '/api/report');
  assert.equal(reportBefore.status, 200);
  assert.equal(reportBefore.json.publishedCount, 1);
  assert.equal(reportBefore.json.measuredCount, 1);
  assert.deepEqual(reportBefore.json.totals, { views: 100, likes: 10, comments: 5, saves: 5 });
  assert.equal(reportBefore.json.interactionRate, 0.2);
  const bytes = await readFile(fixture.dataFile, 'utf8');
  await closeServer(first);
  const restarted = await fixture.start();
  assert.deepEqual(await getState(restarted), saved);
  assert.deepEqual((await request(restarted, '/api/report')).json, reportBefore.json);
  assert.equal(await readFile(fixture.dataFile, 'utf8'), bytes, '重启不重写已有有效文件');
  assert.deepEqual(await readdir(fixture.directory), ['workspace.json']);
});

test('HTTP 编辑并发：旧页面携带过期版本号时409，不覆盖新版本', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  let response = await write(server, 'POST', '/api/plan', { count: 1 });
  assert.equal(response.status, 200);
  const id = response.json.items[0].id;
  const original = response.json.items[0].revision;
  response = await write(server, 'PATCH', `/api/items/${id}`, { title: '页面甲保存', body: '页面甲的正文，用于并发测试。', expectedRevision: original });
  assert.equal(response.status, 200);
  const afterFirst = await readFile(fixture.dataFile, 'utf8');
  const stale = await write(server, 'PATCH', `/api/items/${id}`, { title: '页面乙覆盖', body: '页面乙的正文。', expectedRevision: original });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /其他页面/);
  assert.equal(await readFile(fixture.dataFile, 'utf8'), afterFirst, '冲突不得写盘');
  const state = await getState(server);
  assert.equal(state.items[0].title, '页面甲保存');
  const current = await write(server, 'PATCH', `/api/items/${id}`, { title: '页面乙合并', body: '页面乙合并后的正文。', expectedRevision: state.items[0].revision });
  assert.equal(current.status, 200);
  assert.equal(current.json.items[0].title, '页面乙合并');
});

test('HTTP 启动保护：AI 生成记录字段损坏时拒绝启动且不覆盖原文件', async t => {
  let state = mutate(createInitialState(), 'POST', '/api/plan', { count: 1 });
  state.items[0].ai = { provider: 'DeepSeek' };
  const bytes = JSON.stringify(state);
  const fixture = await sandbox(t, bytes);
  assert.throws(() => fixture.create(), /记录已损坏|格式不受支持/);
  assert.equal(await readFile(fixture.dataFile, 'utf8'), bytes);
});

test('HTTP：业务校验失败不部分更新内存或磁盘，后续有效操作仍可保存', async t => {  const fixture = await sandbox(t);
  const server = await fixture.start();
  const before = await snapshot(server, fixture);
  errorResponse(await write(server, 'POST', '/api/profile', { name: '不得部分保存', weeklyHours: -1 }), 400);
  errorResponse(await write(server, 'POST', '/api/plan', { count: 5 }), 400);
  errorResponse(await write(server, 'POST', '/api/sources', { title: '资料', content: '正文', url: 'javascript:alert(1)' }), 400);
  await unchanged(server, fixture, before);
  const valid = await write(server, 'POST', '/api/profile', { name: '合法修改' });
  assert.equal(valid.status, 200);
  assert.equal(valid.json.profile.name, '合法修改');
  assert.deepEqual(JSON.parse(await readFile(fixture.dataFile, 'utf8')), valid.json);

  // V2 自定义 items 格式保存
  const sourceId = valid.json.sources[0].id;
  const customPlan = await write(server, 'POST', '/api/plan', {
    items: [{ title: 'HTTP自定义选题', angle: '从接口切入', reason: '针对测试', estimatedMinutes: 45, sourceIds: [sourceId] }],
  });
  assert.equal(customPlan.status, 200);
  assert.equal(customPlan.json.items.length, 1);
  assert.equal(customPlan.json.items[0].title, 'HTTP自定义选题');
  assert.deepEqual(JSON.parse(await readFile(fixture.dataFile, 'utf8')), customPlan.json);

  // V2 AI 规划接口在无模型实例时受控拒绝
  const noAiSuggest = await write(server, 'POST', '/api/plan/ai-suggest', {});
  errorResponse(noAiSuggest, 400);
});

test('HTTP：允许本机 Origin 与 Host，拒绝外域、错误端口和 null Origin', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const port = server.address().port;
  const before = await snapshot(server, fixture);
  for (const hostname of ['127.0.0.1', 'localhost']) {
    const response = await request(server, '/api/state', { headers: { Host: `${hostname}:${port}`, Origin: `http://${hostname}:${port}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, before.state);
  }
  for (const origin of [
    'https://evil.example', 'null', `http://127.0.0.1:${port === 65535 ? 65534 : port + 1}`,
    `https://localhost:${port}`, `http://127.0.0.1:${port}.evil.example`,
  ]) {
    errorResponse(await request(server, '/api/state', { headers: { Origin: origin } }), 403);
    errorResponse(await write(server, 'POST', '/api/profile', { name: '跨域不得写入' }, { Origin: origin }), 403);
  }
  await unchanged(server, fixture, before);
});

test('HTTP：拒绝恶意 Host、缺失 Host 及跨站请求，不泄露状态或修改文件', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const port = server.address().port;
  const before = await snapshot(server, fixture);
  for (const host of ['', 'evil.example', 'localhost', `127.0.0.1:${port}.evil.example`, `evil.example:${port}`, `localhost:${port === 65535 ? 65534 : port + 1}`]) {
    errorResponse(await request(server, '/api/state', { headers: { Host: host } }), 403);
    errorResponse(await write(server, 'POST', '/api/profile', { name: '伪造 Host' }, { Host: host }), 403);
  }
  errorResponse(await request(server, '/api/export', { headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403);
  errorResponse(await write(server, 'POST', '/api/profile', { name: '跨站不得写入' }, { 'Sec-Fetch-Site': 'cross-site' }), 403);
  await unchanged(server, fixture, before);
});

for (const contentType of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=test', 'application/jsonp', 'application/json-evil']) {
  test(`HTTP：拒绝非 JSON 媒体类型 ${contentType ?? '(缺失)'}，即使正文是合法 JSON`, async t => {
    const fixture = await sandbox(t);
    const server = await fixture.start();
    const before = await snapshot(server, fixture);
    const response = await request(server, '/api/profile', {
      method: 'POST', body: JSON.stringify({ name: '不应保存的媒体类型' }),
      headers: contentType === undefined ? {} : { 'Content-Type': contentType },
    });
    const after = await snapshot(server, fixture);
    assert.deepEqual({
      status: response.status,
      memoryUnchanged: isDeepStrictEqual(after.state, before.state),
      diskUnchanged: after.bytes === before.bytes,
    }, { status: 415, memoryUnchanged: true, diskUnchanged: true }, `拒绝 ${contentType ?? '缺失 Content-Type'}`);
    errorResponse(response, 415);
  });
}

test('HTTP：允许 JSON charset 参数与大小写媒体类型', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  for (const contentType of ['application/json; charset=utf-8', 'Application/JSON']) {
    const response = await write(server, 'POST', '/api/profile', { name: '合法 JSON 请求' }, { 'Content-Type': contentType });
    assert.equal(response.status, 200);
    assert.equal(response.json.profile.name, '合法 JSON 请求');
  }
});

test('HTTP：拒绝损坏 JSON、数组、null 与标量，不改变 state', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const before = await snapshot(server, fixture);
  for (const body of ['{"name":', '{invalid}', '[]', 'null', 'true', '42', '"text"']) {
    errorResponse(await request(server, '/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), 400);
  }
  await unchanged(server, fixture, before);
});

test('HTTP：超出 192 KiB 的 JSON 请求被拒绝且不写入数据', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const before = await snapshot(server, fixture);
  try {
    const response = await write(server, 'POST', '/api/profile', { name: '过大请求', padding: 'x'.repeat(256 * 1024) });
    errorResponse(response, 413);
  } finally {
    await unchanged(server, fixture, before);
  }
});

test('HTTP：原型污染与越权字段不能更改运行模式或审核状态', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const payload = '{"name":"安全请求","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"mode":"agent","schemaVersion":99,"items":[{"status":"published"}]}';
  const response = await request(server, '/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  assert.equal(response.status, 200);
  assert.equal(response.json.mode, 'template');
  assert.equal(response.json.schemaVersion, 1);
  assert.deepEqual(response.json.items, []);
  assert.equal(Object.hasOwn(response.json.profile, '__proto__'), false);
  assert.equal(Object.hasOwn(response.json.profile, 'constructor'), false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(JSON.parse(await readFile(fixture.dataFile, 'utf8')), response.json);
});

test('HTTP：未知页面、接口、资源及不支持的方法返回 404', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const before = await snapshot(server, fixture);
  for (const path of ['/not-found', '/api/not-found', '/api/state/extra']) {
    errorResponse(await request(server, path), 404);
  }
  for (const [method, path] of [
    ['POST', '/api/not-found'], ['POST', '/api/items/missing/draft'],
    ['DELETE', '/api/sources/missing'], ['PUT', '/api/profile'], ['PATCH', '/'],
  ]) errorResponse(await write(server, method, path), 404);
  await unchanged(server, fixture, before);
});

test('HTTP：静态文件白名单不能读取源码、真实数据路径或任意临时文件', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  const secretFile = join(fixture.directory, 'private-test.txt');
  const secret = 'PRIVATE_TEMPORARY_FIXTURE_NOT_FOR_HTTP';
  await writeFile(secretFile, secret, 'utf8');
  const before = await snapshot(server, fixture);
  const paths = [
    '/domain.mjs', '/server.mjs', '/package.json', '/data/workspace.json',
    '/../server.mjs', '/public/../domain.mjs', '/%2e%2e/server.mjs',
    '/%2e%2e%2fserver.mjs', '/..%5cserver.mjs', '/%00/server.mjs',
    `/${secretFile.replaceAll('\\', '/')}`, `/${encodeURIComponent(secretFile)}`,
    `/${encodeURIComponent(fixture.dataFile)}`, '/styles.css/../../server.mjs',
    '/styles.css?file=../../server.mjs',
  ];
  for (const path of paths) {
    const response = await request(server, path);
    assert.equal(response.text.includes(secret), false, path);
    if (path.startsWith('/styles.css?')) {
      // 后端测试不要求前端资源已经生成；查询参数不可变成任意文件入口。
      if (response.status === 200) assert.match(response.headers['content-type'], /^text\/css/);
      else {
        errorResponse(response, 503);
        assert.match(response.json.error, /页面文件尚未准备好/);
      }
      assert.doesNotMatch(response.text, /export function createApp/);
    } else {
      errorResponse(response, 404);
    }
  }
  assert.equal(await readFile(secretFile, 'utf8'), secret);
  await unchanged(server, fixture, before);
});

test('HTTP：备份以 JSON 附件下载完整当前 state，下载本身不写入文件', async t => {
  const fixture = await sandbox(t);
  const server = await fixture.start();
  assert.equal((await write(server, 'POST', '/api/profile', { name: '备份测试工作台' })).status, 200);
  assert.equal((await write(server, 'POST', '/api/plan', { count: 2 })).status, 200);
  const before = await snapshot(server, fixture);
  const response = await request(server, '/api/export');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json; charset=utf-8$/);
  assert.match(response.headers['content-disposition'], /^attachment; filename="solo-workspace-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json, before.state);
  await unchanged(server, fixture, before);
  // 备份还可作为另一个隔离目录的数据文件加载。
  const restoredFixture = await sandbox(t, response.text);
  const restored = await restoredFixture.start();
  assert.deepEqual(await getState(restored), before.state);
});

for (const [label, bytes] of [
  ['截断 JSON', '{"schemaVersion":1,'],
  ['空文件', ''],
  ['JSON null', 'null'],
  ['缺失必要结构', '{}'],
  ['不支持的 schemaVersion', JSON.stringify({ ...createInitialState(), schemaVersion: 2 })],
  ['不支持的模式', JSON.stringify({ ...createInitialState(), mode: 'agent' })],
  ['items 不是数组', JSON.stringify({ ...createInitialState(), items: {} })],
  ['sources 不是数组', JSON.stringify({ ...createInitialState(), sources: null })],
  ['events 不是数组', JSON.stringify({ ...createInitialState(), events: false })],
  ['损坏的嵌套内容记录', JSON.stringify({ ...createInitialState(), items: [null] })],
]) {
  test(`HTTP 启动保护：已有${label}时拒绝启动，原字节不被覆盖`, async t => {
    const fixture = await sandbox(t, bytes);
    try {
      assert.throws(() => fixture.create(), '损坏的已有数据必须拒绝加载，不可默默初始化或继续使用');
    } finally {
      assert.equal(await readFile(fixture.dataFile, 'utf8'), bytes);
      assert.deepEqual(await readdir(fixture.directory), ['workspace.json']);
    }
  });
}
