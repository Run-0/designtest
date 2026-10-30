import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiClient, PRICE_CHECKED_UNTIL } from '../ai-client.mjs';

// 全部响应仅作离线软件测试，不是真实 AI 验证；不使用现存凭据或本机保护服务。
const NOW = Date.parse('2026-10-29T00:30:00+08:00');
const KEY = 'sk-test-software-only-000000000000';
const CIPHER = 'simulated-protection-not-real-encryption';
const MODEL = 'deepseek-flash';
const MESSAGES = [{ role: 'user', content: '仅作软件测试' }];
const TOOL = { type: 'function', function: { name: 'read_materials' } };
const balance = (fields = {}, available = true) => ({ is_available: available, balance_infos: [{ currency: 'CNY', granted_balance: '1.00', topped_up_balance: '0.00', ...fields }] });
const result = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '仅作软件测试的模拟输出' } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-client-software-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'deepseek-key.dpapi.json');
  const budgetFile = join(directory, 'ai-budget.json');
  const f = { directory, keyFile, budgetFile, requests: [], protected: [], unprotected: [], now: NOW, balance: balance(), models: { data: [{ id: MODEL }] }, completion: () => response(result()), balanceStatus: 200 };
  f.options = {
    directory,
    clock: () => f.now,
    protect: value => { f.protected.push(value); assert.equal(value, KEY); return CIPHER; },
    unprotect: value => { f.unprotected.push(value); assert.equal(value, CIPHER); return KEY; },
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.deepseek.com');
      assert.equal(parsed.username + parsed.password + parsed.search + parsed.hash, '');
      assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      f.requests.push({ url, options });
      if (parsed.pathname === '/user/balance') return response(f.balance, f.balanceStatus);
      if (parsed.pathname === '/models') return response(f.models);
      assert.equal(parsed.pathname, '/chat/completions');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      return f.completion(JSON.parse(options.body));
    },
  };
  f.client = createAiClient(f.options);
  f.install = () => f.client.installKey(KEY);
  f.ledger = () => JSON.parse(readFileSync(budgetFile, 'utf8'));
  f.posts = () => f.requests.filter(request => request.options.method === 'POST');
  return f;
}

function noSecret(value) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(KEY));
  assert.ok(!serialized.includes(CIPHER));
  assert.ok(!serialized.includes('encryptedKey'));
}

test('状态不泄露凭据；模拟保护保存、重启解保护且禁止覆盖', async t => {
  const f = fixture(t);
  assert.equal(f.client.status().configured, false);
  noSecret(f.client.status());
  const installed = await f.client.installKey(` ${KEY} `);
  noSecret(installed);
  assert.equal(installed.configured, true);
  assert.equal(installed.lastVerifiedAt, new Date(NOW).toISOString());
  assert.deepEqual(installed.verifiedBalance, { grantedCny: 1, toppedUpCny: 0 });
  assert.deepEqual(f.protected, [KEY]);
  const saved = readFileSync(f.keyFile, 'utf8');
  assert.ok(!saved.includes(KEY));
  assert.equal(JSON.parse(saved).encryptedKey, CIPHER);
  const restarted = createAiClient(f.options);
  noSecret(restarted.status());
  assert.deepEqual(f.unprotected, []);
  await restarted.chat(MESSAGES);
  assert.deepEqual(f.unprotected, [CIPHER]);
  await assert.rejects(restarted.installKey(KEY), /已有专用凭据/);
  assert.equal(readFileSync(f.keyFile, 'utf8'), saved);
  assert.deepEqual(readdirSync(f.directory).sort(), ['ai-budget.json', 'deepseek-key.dpapi.json']);
});

test('非法密钥、无法核对的余额和缺失型号均不保存凭据', async t => {
  const f = fixture(t);
  for (const key of ['', 'sk-test-short', null, 42, `sk-${'a'.repeat(241)}`]) {
    await assert.rejects(f.client.installKey(key), /完整.*密钥/);
  }
  assert.equal(f.requests.length, 0);
  const cases = [
    { balance: {} },
    { balance: balance({ currency: 'USD' }) },
    { balance: balance({ granted_balance: 'NaN' }) },
    { balance: balance({ topped_up_balance: undefined }) },
    { balance: balance({ granted_balance: '0.049' }) },
    { balance: balance({}, false) },
    { balance: balance({ topped_up_balance: '0.01' }) },
    { models: { data: [{ id: 'unapproved-model' }] } },
    { models: { data: null } },
    { balanceStatus: 401 },
  ];
  for (const invalid of cases) {
    Object.assign(f, { balance: balance(), models: { data: [{ id: MODEL }] }, balanceStatus: 200 }, invalid);
    await assert.rejects(f.install(), /余额|型号|密钥验证失败/);
    assert.equal(f.client.status().configured, false);
    assert.equal(existsSync(f.keyFile), false);
    assert.equal(f.ledger().reservedCents, 0);
  }
  assert.deepEqual(f.protected, []);
  assert.equal(f.posts().length, 0);
});

test('每次先落盘预留 ¥0.05；网络、HTTP、截断、JSON 和用量失败不退不重试', async t => {
  const f = fixture(t);
  await f.install();
  const failures = [
    () => { throw new Error('simulated offline failure'); },
    () => response({}, 503),
    () => response({ ...result(), choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    () => ({ ok: true, json: async () => { throw new SyntaxError('simulated malformed JSON'); } }),
    () => response({ ...result(), usage: undefined }),
    () => response({ ...result(), usage: { prompt_tokens: -1, completion_tokens: 2 } }),
  ];
  for (const [index, failure] of failures.entries()) {
    f.completion = () => {
      const pending = f.ledger();
      assert.equal(pending.reservedCents, (index + 1) * 5);
      assert.equal(pending.calls.at(-1).status, 'pending');
      assert.equal(pending.calls.at(-1).createdAt, new Date(NOW).toISOString());
      return failure();
    };
    await assert.rejects(f.client.chat(MESSAGES), /超时|未成功|截断|用量/);
    assert.equal(f.posts().length, index + 1);
    assert.equal(f.ledger().reservedCents, (index + 1) * 5);
    assert.ok(f.ledger().calls.every(call => call.status === 'failed' && call.reservedCny === 0.05));
  }
  f.completion = () => response(result());
  await f.client.chat(MESSAGES);
  assert.equal(f.ledger().reservedCents, 35);
  assert.equal(f.ledger().calls.at(-1).status, 'success');
});

test('¥1 总预算含失败尝试：允许二十次、第二十一次在 fetch 前拒绝', async t => {
  const f = fixture(t);
  await f.install();
  for (let i = 0; i < 20; i++) {
    f.completion = () => response(result(), i % 2 ? 503 : 200);
    if (i % 2) await assert.rejects(f.client.chat(MESSAGES), /HTTP 503/);
    else await f.client.chat(MESSAGES);
  }
  assert.deepEqual(f.client.status().budget, { limitCny: 1, reservedCny: 1, remainingCny: 0, attempts: 20 });
  const before = f.requests.length;
  await assert.rejects(f.client.chat(MESSAGES), /¥1/);
  assert.equal(f.requests.length, before);
  assert.equal(f.posts().length, 20);
  assert.equal(f.ledger().reservedCents, 100);
});

test('重新创建客户端不重置已预留预算，包括失败记录', async t => {
  const f = fixture(t);
  await f.install();
  f.completion = () => response({}, 500);
  await assert.rejects(f.client.chat(MESSAGES));
  const restarted = createAiClient(f.options);
  assert.equal(restarted.status().budget.reservedCny, 0.05);
  f.completion = () => response(result());
  await restarted.chat(MESSAGES);
  assert.equal(restarted.status().budget.attempts, 2);
  assert.equal(f.ledger().reservedCents, 10);
  assert.deepEqual(f.ledger().calls.map(call => call.status), ['failed', 'success']);
});

test('价格窗口截止及之后拒绝，且不查询余额或预留', async t => {
  const f = fixture(t);
  await f.install();
  const before = f.requests.length;
  for (const now of [PRICE_CHECKED_UNTIL, PRICE_CHECKED_UNTIL + 1000]) {
    f.now = now; // 仅过期边界用例偏离固定测试时刻。
    await assert.rejects(f.client.chat(MESSAGES), /价格核验窗口已过期/);
  }
  assert.equal(f.requests.length, before);
  assert.equal(f.ledger().reservedCents, 0);
});

test('拒绝越界模型、输出、思考、流式及工具；按 UTF-8 字节限制请求', async t => {
  const f = fixture(t);
  await f.install();
  const before = f.requests.length;
  for (const options of [
    { model: 'other-model' }, { max_tokens: 1601 }, { max_tokens: 0 },
    { stream: true }, { thinking: { type: 'enabled' } },
    { n: 2 }, { reasoning_effort: 'max' }, { max_completion_tokens: 99999 },
    { tools: [] }, { tools: {} }, { tools: [TOOL, TOOL] },
    { tools: [{ type: 'web_search' }] },
    { tools: [{ type: 'function', function: { name: 'read_file' } }] },
  ]) await assert.rejects(f.client.chat(MESSAGES, options), /参数范围|未授权工具/);
  await assert.rejects(f.client.chat([{ role: 'user', content: '汉'.repeat(4000) }]), /资料过长/);
  assert.equal(f.requests.length, before);
  assert.equal(f.ledger().reservedCents, 0);
  const empty = [{ role: 'user', content: '' }];
  const overhead = Buffer.byteLength(JSON.stringify({ model: MODEL, messages: empty, stream: false, thinking: { type: 'disabled' }, max_tokens: 1600 }));
  const boundary = [{ role: 'user', content: 'x'.repeat(12000 - overhead) }];
  await assert.rejects(f.client.chat([{ role: 'user', content: `${boundary[0].content}x` }]), /资料过长/);
  await f.client.chat(boundary);
  assert.equal(Buffer.byteLength(f.posts()[0].options.body), 12000);
  await f.client.chat(MESSAGES, { tools: [TOOL] });
  assert.deepEqual(JSON.parse(f.posts()[1].options.body).tools, [TOOL]);
});

test('生成前重新查询赠送余额：充值、不可用和不足均停止且不扣预留', async t => {
  const f = fixture(t);
  await f.install();
  for (const value of [balance({ topped_up_balance: '0.01' }), balance({}, false), balance({ granted_balance: '0.04' }), {}]) {
    f.balance = value;
    await assert.rejects(f.client.chat(MESSAGES), /余额/);
    assert.equal(f.posts().length, 0);
    assert.equal(f.ledger().reservedCents, 0);
  }
  assert.equal(f.requests.length, 6);
});

test('显式授权充值余额后允许使用：充值可用且满足单次预算时正常调用，不足仍停止', async t => {
  const f = fixture(t);
  f.options.allowToppedUp = true;
  f.client = createAiClient(f.options);
  await f.install();
  // 充值余额 5.00，赠送 0，授权允许使用
  f.balance = balance({ granted_balance: '0.00', topped_up_balance: '5.00' });
  await f.client.chat(MESSAGES);
  assert.equal(f.posts().length, 1);

  // 充值余额 0.02，不足单次 0.05 预留，依然安全停止
  f.balance = balance({ granted_balance: '0.00', topped_up_balance: '0.02' });
  await assert.rejects(f.client.chat(MESSAGES), /可用账户余额不足/);
});

test('Authorization 仅交给 api.deepseek.com，所有请求禁止重定向', async t => {
  const f = fixture(t);
  await f.install();
  await f.client.chat(MESSAGES);
  assert.deepEqual(f.requests.map(({ url }) => url), [
    'https://api.deepseek.com/user/balance', 'https://api.deepseek.com/models',
    'https://api.deepseek.com/user/balance', 'https://api.deepseek.com/chat/completions',
  ]);
  f.balanceStatus = 302;
  await assert.rejects(f.client.chat(MESSAGES), /HTTP 302/);
  assert.equal(f.posts().length, 1);
  assert.equal(f.requests.at(-1).options.redirect, 'error');
});

test('账本可显式扩充上限：保留已用预留并继续计费', async t => {
  const f = fixture(t);
  await f.install();
  const calls = Array.from({ length: 19 }, (_, index) => ({ id: `synthetic-${index}`, status: 'failed', reservedCny: 0.05 }));
  writeFileSync(f.budgetFile, JSON.stringify({ limitCents: 300, reservedCents: 95, calls }));
  const restarted = createAiClient(f.options);
  assert.equal(restarted.status().budget.limitCny, 3);
  assert.equal(restarted.status().budget.reservedCny, 0.95);
  assert.equal(restarted.status().budget.remainingCny, 2.05);
  assert.equal(restarted.status().availability.code, 'ready');
  f.completion = () => response(result());
  await restarted.chat(MESSAGES);
  assert.equal(restarted.status().budget.reservedCny, 1);
  assert.equal(restarted.status().budget.attempts, 20);
});

test('坏 ledger 和有凭据但缺失 ledger 拒绝加载，不覆盖或自动清零', t => {
  const f = fixture(t);
  const valid = { limitCents: 100, reservedCents: 0, calls: [] };
  const invalid = ['{', 'null', ...[
    { ...valid, limitCents: 1001 }, { ...valid, limitCents: 0 }, { ...valid, limitCents: 100.5 },
    { ...valid, reservedCents: -5 }, { ...valid, reservedCents: 101 },
    { ...valid, reservedCents: 0.5 }, { ...valid, reservedCents: 5 }, { ...valid, calls: {} },
  ].map(value => JSON.stringify(value))];
  for (const text of invalid) {
    writeFileSync(f.budgetFile, text);
    assert.throws(() => createAiClient(f.options));
    assert.equal(readFileSync(f.budgetFile, 'utf8'), text);
  }
  rmSync(f.budgetFile);
  const saved = JSON.stringify({ provider: 'DeepSeek', encryptedKey: CIPHER, verifiedAt: new Date(NOW).toISOString() });
  writeFileSync(f.keyFile, saved);
  assert.throws(() => createAiClient(f.options), /预算记录缺失/);
  assert.equal(existsSync(f.budgetFile), false);
  assert.equal(readFileSync(f.keyFile, 'utf8'), saved);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.unprotected, []);
});

test('同一实例并发请求拒绝第二次，首个请求完成后释放 busy', async t => {
  const f = fixture(t);
  await f.install();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.completion = async () => { entered(); await gate; return response(result()); };
  const first = f.client.chat(MESSAGES);
  await started;
  try {
    await assert.rejects(f.client.chat(MESSAGES), error => error.status === 409);
    assert.equal(f.posts().length, 1);
  } finally { release(); await first; }
  f.completion = () => response(result());
  await f.client.chat(MESSAGES);
  assert.equal(f.ledger().reservedCents, 10);
});

test('安全回归：用量超出单次预估后，本实例及重启均应停止后续调用', async t => {
  const f = fixture(t);
  await f.install();
  f.completion = () => response({ ...result(), usage: { prompt_tokens: 30000, completion_tokens: 0, total_tokens: 30000 } });
  await assert.rejects(f.client.chat(MESSAGES), /用量超出/);
  assert.equal(f.ledger().calls[0].status, 'failed');
  assert.equal(f.ledger().calls[0].estimatedUpperCny, 0.06);
  const restarted = createAiClient(f.options);
  f.completion = () => response(result());
  const outcomes = [];
  for (const client of [f.client, restarted]) {
    outcomes.push((await Promise.allSettled([client.chat(MESSAGES)]))[0].status);
  }
  assert.deepEqual(outcomes, ['rejected', 'rejected'], '超预估后没有持久化停机状态，仍允许继续调用');
});

test('安全回归：共用目录的两个存活实例合计二十次后应拒绝第二十一次', async t => {
  const f = fixture(t);
  await f.install();
  const second = createAiClient(f.options);
  for (let i = 0; i < 20; i++) await (i % 2 ? second : f.client).chat(MESSAGES);
  assert.equal(f.posts().length, 20);
  await assert.rejects(f.client.chat(MESSAGES), /¥1/, '实例各持旧 ledger，丢失预算更新后可超过授权总额');
});

test('安全回归：余额 null、空串或布尔值不应当作已核验金额', async t => {
  const accepted = [];
  for (const fields of [{ topped_up_balance: null }, { topped_up_balance: '' }, { granted_balance: true }]) {
    const f = fixture(t);
    f.balance = balance(fields);
    const [outcome] = await Promise.allSettled([f.install()]);
    if (outcome.status === 'fulfilled') accepted.push(fields);
  }
  assert.deepEqual(accepted, [], 'Number 强制转换把未知充值额当成零、把布尔赠送额当成一元');
});
