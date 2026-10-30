import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiClient, PRICE_CHECKED_UNTIL } from '../ai-client.mjs';
import { createApp } from '../server.mjs';

// 全部使用隔离文件和固定测试时钟；禁止网络或真实凭据解密。
const BEFORE = Date.parse('2026-10-29T12:00:00+08:00');
const EXPIRY = PRICE_CHECKED_UNTIL;
function fixture(t, { configured = true, cents = 0, paused = false, locked = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'solo-availability-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const budgetFile = join(directory, 'ai-budget.json');
  const keyFile = join(directory, 'deepseek-key.dpapi.json');
  const lockFile = join(directory, 'ai-request.lock');
  writeFileSync(budgetFile, JSON.stringify({ limitCents: 100, reservedCents: cents, paused,
    calls: Array.from({ length: cents / 5 }, (_, i) => ({ id: `synthetic-${i}`, status: 'failed', reservedCny: 0.05 })) }));
  if (configured) writeFileSync(keyFile, JSON.stringify({ provider: 'DeepSeek', encryptedKey: 'synthetic-no-real-key', verifiedAt: new Date(BEFORE).toISOString() }));
  if (locked) writeFileSync(lockFile, 'synthetic-lock');
  const f = { directory, budgetFile, keyFile, lockFile, now: BEFORE, requests: 0, decrypts: 0 };
  f.client = createAiClient({ directory, clock: () => f.now,
    fetchImpl: async () => { f.requests++; throw new Error('此测试不允许任何远端请求'); },
    unprotect: () => { f.decrypts++; throw new Error('此测试不允许解密'); },
  });
  return f;
}
function availability(f, code, allowed = false) {
  const before = readFileSync(f.budgetFile, 'utf8');
  const result = f.client.status();
  assert.equal(result.availability.code, code);
  assert.equal(result.availability.canGenerateDraft, allowed);
  assert.equal(result.availability.remoteChecked, false);
  assert.equal(result.availability.priceCheckedUntil, new Date(EXPIRY).toISOString());
  assert.equal(result.availability.checkedAt, new Date(f.now).toISOString());
  assert.ok(result.availability.message.length > 5);
  assert.equal(readFileSync(f.budgetFile, 'utf8'), before, '读取状态不得重写预算');
  assert.equal(f.requests, 0);
  assert.equal(f.decrypts, 0);
  assert.ok(!JSON.stringify(result).includes('synthetic-no-real-key'));
  return result;
}

test('状态：已配置且本地保护允许，仅表示可尝试，不代表远端已验证', t => {
  const f = fixture(t);
  const status = availability(f, 'ready', true);
  assert.equal(status.configured, true);
  assert.deepEqual(status.budget, { limitCny: 1, reservedCny: 0, remainingCny: 1, attempts: 0 });
});

test('状态：未配置和凭据被移走时拒绝，不解密也不联网', t => {
  const first = fixture(t, { configured: false });
  assert.equal(availability(first, 'not_configured').configured, false);
  const second = fixture(t);
  rmSync(second.keyFile);
  assert.equal(availability(second, 'not_configured').configured, false);
});

test('状态：价格到期边界前允许，到期以及之后暂停', t => {
  const f = fixture(t);
  f.now = EXPIRY - 1;
  availability(f, 'ready', true);
  for (const now of [EXPIRY, EXPIRY + 60000]) {
    f.now = now;
    availability(f, 'price_expired');
  }
});

for (const [cents, code, allowed] of [[90, 'ready', true], [95, 'budget_insufficient', false], [100, 'budget_exhausted', false]]) {
  test(`状态：已预留 ${cents} 分，按整轮两次请求判断 ${code}`, t => {
    const f = fixture(t, { cents });
    const status = availability(f, code, allowed);
    assert.equal(status.budget.reservedCny, cents / 100);
  });
}

test('状态：用量异常暂停优先于可用额度，不能读取即恢复', t => {
  const f = fixture(t, { paused: true });
  availability(f, 'usage_paused');
  assert.equal(JSON.parse(readFileSync(f.budgetFile, 'utf8')).paused, true);
});

test('状态：活动或残留锁暂停，GET 不删除锁', t => {
  const f = fixture(t, { locked: true });
  availability(f, 'request_locked');
  assert.equal(existsSync(f.lockFile), true);
});

test('状态：启动后账本被损坏，返回未知预算而非归零或泄漏异常', t => {
  const f = fixture(t);
  for (const bad of ['{', 'null', JSON.stringify({ limitCents: 100, reservedCents: 5, calls: [] })]) {
    writeFileSync(f.budgetFile, bad);
    const status = availability(f, 'budget_unreadable');
    assert.equal(status.budget, null);
    assert.equal(status.configured, true);
  }
});

test('状态：时钟不可读时不能误放行', t => {
  const f = fixture(t);
  f.now = NaN;
  const status = f.client.status();
  assert.equal(status.availability.canGenerateDraft, false);
  assert.equal(status.availability.code, 'price_expired');
});

test('HTTP 状态：无模型实例仍有完整禁用原因与截止说明', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'solo-status-http-test-'));
  const server = createApp({ dataFile: join(directory, 'state.json') });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/connection/status`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.configured, false);
  assert.equal(data.availability.code, 'not_configured');
  assert.equal(data.availability.canGenerateDraft, false);
  assert.equal(data.availability.remoteChecked, false);
});

test('HTTP 状态：运行中预算损坏仍能解释暂停，工作台读取不受影响', async t => {
  const f = fixture(t);
  const server = createApp({ dataFile: join(f.directory, 'state.json'), aiDirectory: f.directory });
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(f.budgetFile, '{');
  const data = await (await fetch(base + '/api/connection/status')).json();
  assert.equal(data.availability.code, 'budget_unreadable');
  assert.equal(data.budget, null);
  const denied = await fetch(base + '/api/items/placeholder/ai-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error, data.availability.message);
  assert.equal((await fetch(base + '/api/state')).status, 200);
  const state = await (await fetch(base + '/api/state')).json();
  const planned = await fetch(base + '/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"count":1}' });
  assert.equal(planned.status, 200);
  assert.equal((await planned.json()).items.length, state.items.length + 1);
  assert.equal(readFileSync(f.budgetFile, 'utf8'), '{');
});

for (const [label, setup, code, httpStatus, testTime = BEFORE] of [
  ['整轮预算不足', { cents: 95 }, 'budget_insufficient', 400],
  ['额度耗尽', { cents: 100 }, 'budget_exhausted', 400],
  ['用量异常', { paused: true }, 'usage_paused', 400],
  ['保护锁', { locked: true }, 'request_locked', 409],
  ['价格到期', {}, 'price_expired', 400, EXPIRY],
]) {
  test(`HTTP ${label}：页面状态和POST拒绝一致，预算与原稿不变`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: testTime });
    const f = fixture(t, setup);
    const dataFile = join(f.directory, 'state.json');
    const server = createApp({ dataFile, aiDirectory: f.directory });
    t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const budgetBefore = readFileSync(f.budgetFile, 'utf8');
    const dataBefore = readFileSync(dataFile, 'utf8');
    const status = await (await fetch(base + '/api/connection/status')).json();
    assert.equal(status.availability.code, code);
    const response = await fetch(base + '/api/items/placeholder/ai-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, httpStatus);
    assert.equal((await response.json()).error, status.availability.message);
    assert.equal(readFileSync(f.budgetFile, 'utf8'), budgetBefore);
    assert.equal(readFileSync(dataFile, 'utf8'), dataBefore);
  });
}
