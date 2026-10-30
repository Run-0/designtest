import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

// 全部是合成状态；直接导入共享类，不创建 DOM、不访问服务或真实数据。
const CHECKED_AT = '2026-10-29T12:00:00+08:00';
const PRICE_UNTIL = '2026-10-29T12:01:00+08:00';
let AiConnectionStatus;

function replaceGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

function statusData({
  code = 'ready', configured = code !== 'not_configured',
  budget = { limitCny: 1, reservedCny: 0.3, remainingCny: 0.7, attempts: 6 },
  checkedAt = CHECKED_AT, priceCheckedUntil = PRICE_UNTIL
} = {}) {
  return {
    provider: 'DeepSeek', model: 'deepseek-flash', configured, budget,
    availability: {
      code, message: `合成测试：${code}，仅检查本机保护。`,
      canGenerateDraft: code === 'ready', remoteChecked: false,
      checkedAt, priceCheckedUntil
    }
  };
}

function ok(data) {
  return { ok: true, status: 200, json: async () => data };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  let now = 1000;
  let wallNow = Date.parse('2040-01-01T00:00:00Z');
  let nextTimer = 0;
  let reply = async () => ok(statusData());
  const timers = new Map();
  const fakeWindow = {
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  const restoreWindow = replaceGlobal('window', fakeWindow);
  let fetchMock;
  t.after(() => {
    try {
      for (const { arguments: [url, options = {}] } of fetchMock?.mock.calls || []) {
        assert.equal(url, '/api/connection/status', '只允许读取状态端点');
        assert.equal(options.method || 'GET', 'GET', '刷新不得 POST 或写入');
        assert.equal(options.body, undefined, '读取状态不得携带请求体');
      }
    } finally {
      timers.clear();
      t.mock.restoreAll();
      restoreWindow();
    }
  });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(Date, 'now', () => wallNow);
  t.mock.method(fakeWindow, 'setTimeout');
  t.mock.method(fakeWindow, 'clearTimeout');
  // 避免 AbortSignal.timeout 建立真实计时器；超时异常由测试显式注入。
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  fetchMock = t.mock.method(globalThis, 'fetch', (...args) => reply(...args));
  const views = [];
  const onChange = t.mock.fn(() => { views.push(connection.view()); });
  const connection = new AiConnectionStatus(onChange);
  return {
    connection, onChange, views, timers, window: fakeWindow, fetch: fetchMock,
    replyWith(handler) { reply = handler; },
    setWallNow(value) { wallNow = value; },
    advance(milliseconds) {
      assert.ok(milliseconds >= 0);
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.callback();
      }
      now = target;
    }
  };
}

function assertUnknown(connection) {
  const view = connection.view();
  assert.equal(connection.data, null);
  assert.equal(view.fresh, false);
  assert.equal(view.canGenerateDraft, false);
  assert.equal(view.label, 'AI状态未知 · 已禁用');
  assert.equal(view.budget, null);
  assert.ok(view.reason.length > 0);
}

// 全局替身只用于本 worker，并逐个测试恢复；禁止并发修改这些全局对象。
describe('AiConnectionStatus 共享类（离线）', { concurrency: false }, () => {
  beforeEach(async t => {
    if (AiConnectionStatus) return;
    const querySelector = t.mock.fn(() => null);
    const restoreDocument = replaceGlobal('document', { querySelector });
    const noNetwork = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('导入共享类时禁止任何网络请求');
    });
    try {
      ({ AiConnectionStatus } = await import('../public/app.js'));
      assert.equal(querySelector.mock.callCount(), 1);
      assert.equal(querySelector.mock.calls[0].arguments[0], '#main-content');
      assert.equal(noNetwork.mock.callCount(), 0);
    } finally {
      t.mock.restoreAll();
      restoreDocument();
    }
  });

  test('初始禁用；ready 仅表示本机允许尝试，远端仍未验证', async t => {
    const f = fixture(t);
    assertUnknown(f.connection);
    const data = await f.connection.refresh();
    const view = f.connection.view();
    assert.equal(data.availability.remoteChecked, false);
    assert.equal(view.fresh, true);
    assert.equal(view.canGenerateDraft, true);
    assert.equal(view.label, 'AI可尝试 · 未实时验证远端');
    assert.equal(view.reason, data.availability.message);
    assert.match(view.times, /本机检查：.*价格核验到期：.*北京时间 UTC\+8/);
    assert.equal(f.views[0].canGenerateDraft, false, '读取期间必须禁用');
    assert.equal(f.views.at(-1).canGenerateDraft, true);
    assert.equal(f.fetch.mock.callCount(), 1);
  });

  test('所有不允许状态均禁用并保留明确原因', async t => {
    const f = fixture(t);
    const cases = [
      ['not_configured', 'AI未配置'],
      ['price_expired', 'AI暂停 · 价格核验已到期'],
      ['budget_exhausted', 'AI暂停 · 测试额度已耗尽'],
      ['budget_insufficient', 'AI暂停 · 额度不足一轮起草'],
      ['usage_paused', 'AI暂停 · 用量保护'],
      ['request_locked', 'AI暂停 · 请求锁定'],
      ['budget_unreadable', 'AI暂停 · 预算不可读']
    ];
    for (const [code, label] of cases) {
      const data = statusData({ code, ...(code === 'budget_unreadable' ? { budget: null } : {}) });
      f.replyWith(async () => ok(data));
      assert.strictEqual(await f.connection.refresh(), data, code);
      const view = f.connection.view();
      assert.equal(view.fresh, true, code);
      assert.equal(view.canGenerateDraft, false, code);
      assert.equal(view.label, label, code);
      assert.equal(view.reason, data.availability.message, code);
    }
  });

  test('旧响应缺 availability 或字段格式错误时清除旧许可并显示未知', async t => {
    const f = fixture(t);
    const malformed = [
      ['旧版无 availability', data => { delete data.availability; }],
      ['配置类型错误', data => { data.configured = 'true'; }],
      ['提供方错误', data => { data.provider = 'other'; }],
      ['模型错误', data => { data.model = 'other'; }],
      ['未知状态', data => { data.availability.code = 'other'; }],
      ['ready 却不允许', data => { data.availability.canGenerateDraft = false; }],
      ['暂停却允许', data => { data.availability.code = 'request_locked'; }],
      ['错误声称远端已验证', data => { data.availability.remoteChecked = true; }],
      ['没有原因', data => { data.availability.message = ' '; }],
      ['检查时间无时区', data => { data.availability.checkedAt = '2026-10-29T12:00:00'; }],
      ['到期时间错误', data => { data.availability.priceCheckedUntil = 'invalid'; }],
      ['缺少预算', data => { delete data.budget; }],
      ['负预算', data => { data.budget.remainingCny = -1; }],
      ['非有限预算', data => { data.budget.remainingCny = Infinity; }],
      ['ready 预算不可读', data => { data.budget = null; }],
      ['ready 但未配置', data => { data.configured = false; }]
    ];
    for (const [name, mutate] of malformed) {
      f.replyWith(async () => ok(statusData()));
      await f.connection.refresh();
      assert.equal(f.connection.view().canGenerateDraft, true, name);
      const bad = statusData();
      mutate(bad);
      f.replyWith(async () => ok(bad));
      assert.equal(await f.connection.refresh(), null, name);
      assertUnknown(f.connection);
    }
    for (const bad of [null, [], 'not a status']) {
      f.replyWith(async () => ok(bad));
      assert.equal(await f.connection.refresh(), null);
      assertUnknown(f.connection);
    }
  });

  test('错误 JSON、HTTP 拒绝、网络异常及超时均禁用，不沿用旧状态', async t => {
    const f = fixture(t);
    const rejectedJson = t.mock.fn(async () => statusData());
    const failures = [
      async () => ({ ok: true, json: async () => { throw new SyntaxError('synthetic invalid JSON'); } }),
      ...[403, 500].map(status => async () => ({ ok: false, status, json: rejectedJson })),
      async () => { throw new TypeError('synthetic network failure'); },
      async () => { throw new DOMException('synthetic timeout', 'TimeoutError'); }
    ];
    for (const failure of failures) {
      f.replyWith(async () => ok(statusData()));
      await f.connection.refresh();
      assert.equal(f.connection.view().canGenerateDraft, true);
      f.replyWith(failure);
      assert.equal(await f.connection.refresh(), null);
      assertUnknown(f.connection);
      assert.equal(f.connection.loading, false);
      assert.equal(f.connection.pending, null);
      assert.equal(f.timers.size, 0);
    }
    assert.equal(rejectedJson.mock.callCount(), 0, 'HTTP 拒绝不得信任响应体中的 ready');
    assert.match(f.connection.view().reason, /超时/);
  });

  test('budget:null 保持不可读，不能伪装成数值为 0 的预算', async t => {
    const f = fixture(t);
    f.replyWith(async () => ok(statusData({ code: 'budget_unreadable', budget: null })));
    const data = await f.connection.refresh();
    assert.equal(data.budget, null);
    assert.equal(f.connection.view().budget, null);
    assert.equal(f.connection.view().canGenerateDraft, false);
    assert.match(f.connection.view().label, /预算不可读/);
    const zero = { limitCny: 1, reservedCny: 1, remainingCny: 0, attempts: 20 };
    f.replyWith(async () => ok(statusData({ code: 'budget_exhausted', budget: zero })));
    await f.connection.refresh();
    assert.deepEqual(f.connection.view().budget, zero, '真实的零余额与未知预算必须可区分');
  });

  test('30 秒失鲜使用单调时钟，系统时间前后跳变不延长许可', async t => {
    const f = fixture(t);
    await f.connection.refresh();
    f.setWallNow(Date.parse('2100-01-01T00:00:00Z'));
    assert.equal(f.connection.view().canGenerateDraft, true);
    f.advance(29999);
    f.setWallNow(Date.parse('2000-01-01T00:00:00Z'));
    assert.equal(f.connection.view().fresh, true);
    assert.equal(f.connection.view().canGenerateDraft, true);
    const notifications = f.onChange.mock.callCount();
    f.advance(1);
    assert.equal(f.connection.view().fresh, false);
    assert.equal(f.connection.view().canGenerateDraft, false);
    assert.match(f.connection.view().label, /需刷新/);
    assert.equal(f.onChange.mock.callCount(), notifications + 1);
    assert.equal(f.views.at(-1).canGenerateDraft, false, '到期定时器必须通知消费页面禁用');
    assert.equal(f.timers.size, 0);
    assert.equal(f.fetch.mock.callCount(), 1, '失鲜不得自动发起请求');
  });

  test('价格窗口从服务端 checkedAt 计算，到期临界点及之后立即禁止', async t => {
    const f = fixture(t);
    f.replyWith(async () => ok(statusData({ priceCheckedUntil: '2026-10-29T04:00:10Z' })));
    await f.connection.refresh();
    assert.equal(f.connection.view().canGenerateDraft, true, '不能使用偏离服务端的浏览器系统时间');
    f.advance(9999);
    assert.equal(f.connection.view().canGenerateDraft, true);
    const notifications = f.onChange.mock.callCount();
    f.advance(1);
    assert.equal(f.connection.view().fresh, true, '此时尚未到 30 秒失鲜边界');
    assert.equal(f.connection.view().canGenerateDraft, false);
    assert.equal(f.connection.view().label, 'AI暂停 · 价格核验已到期');
    assert.equal(f.onChange.mock.callCount(), notifications + 1);
    assert.equal(f.views.at(-1).canGenerateDraft, false);
    f.advance(1);
    assert.equal(f.connection.view().canGenerateDraft, false);
    for (const priceCheckedUntil of [CHECKED_AT, '2026-10-29T11:59:59+08:00']) {
      f.replyWith(async () => ok(statusData({ priceCheckedUntil })));
      await f.connection.refresh();
      assert.equal(f.connection.view().canGenerateDraft, false, '已到期或过期的服务端窗口不得恢复许可');
    }
  });

  test('GET 和 JSON 读取延迟均从 30 秒新鲜有效期中扣除', async t => {
    const f = fixture(t);
    const response = deferred();
    const body = deferred();
    const readJson = t.mock.fn(() => body.promise);
    f.replyWith(() => response.promise);
    const pending = f.connection.refresh();
    f.advance(2000);
    response.resolve({ ok: true, json: readJson });
    await Promise.resolve();
    assert.equal(readJson.mock.callCount(), 1);
    f.advance(3000);
    assert.equal(f.connection.view().canGenerateDraft, false, 'JSON 尚未读取完时不得允许');
    body.resolve(statusData());
    await pending;
    assert.equal(f.connection.view().canGenerateDraft, true);
    f.advance(24999);
    assert.equal(f.connection.view().canGenerateDraft, true);
    f.advance(1);
    assert.equal(f.connection.view().fresh, false, '有效期从请求开始计算，不从响应完成重新起算');
    assert.equal(f.connection.view().canGenerateDraft, false);
  });

  test('请求延迟扣除价格窗口，响应到达时窗口已过则直接禁用', async t => {
    const f = fixture(t);
    let response = deferred();
    f.replyWith(() => response.promise);
    let pending = f.connection.refresh();
    f.advance(4000);
    response.resolve(ok(statusData({ priceCheckedUntil: '2026-10-29T12:00:10+08:00' })));
    await pending;
    f.advance(5999);
    assert.equal(f.connection.view().canGenerateDraft, true);
    f.advance(1);
    assert.equal(f.connection.view().canGenerateDraft, false);
    response = deferred();
    pending = f.connection.refresh();
    f.advance(1500);
    response.resolve(ok(statusData({ priceCheckedUntil: '2026-10-29T12:00:01+08:00' })));
    await pending;
    assert.equal(f.connection.view().fresh, true);
    assert.equal(f.connection.view().canGenerateDraft, false, '不能从收到响应时重新获得一秒价格窗口');
    assert.match(f.connection.view().label, /价格核验已到期/);
  });

  test('并发 refresh 共用同一 GET 和 Promise，等待新数据而非返回旧数据', async t => {
    const f = fixture(t);
    const old = await f.connection.refresh();
    const response = deferred();
    const latest = statusData({ code: 'request_locked' });
    f.replyWith(() => response.promise);
    const first = f.connection.refresh();
    const second = f.connection.refresh();
    const third = f.connection.refresh();
    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
    assert.equal(f.fetch.mock.callCount(), 2, '包含第一次预热请求，并发刷新只能再增加一次');
    assert.equal(f.connection.view().fresh, false);
    assert.equal(f.connection.view().canGenerateDraft, false);
    assert.match(f.connection.view().label, /读取中/);
    let settled = false;
    second.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, '不能立即 resolve 为旧 ready 数据');
    response.resolve(ok(latest));
    for (const result of await Promise.all([first, second, third])) {
      assert.strictEqual(result, latest);
      assert.notStrictEqual(result, old);
    }
    assert.equal(f.connection.pending, null);
    assert.equal(f.connection.loading, false);
    assert.equal(f.connection.view().canGenerateDraft, false);
    assert.match(f.connection.view().label, /请求锁定/);
    f.replyWith(async () => ok(statusData()));
    await f.connection.refresh();
    assert.equal(f.fetch.mock.callCount(), 3, '结束后刷新必须允许建立新的 GET');
    assert.equal(f.connection.view().canGenerateDraft, true);
  });

  test('invalidate 立即禁用、通知页面并清除到期计时器，直到重新刷新', async t => {
    const f = fixture(t);
    const lastKnown = await f.connection.refresh();
    assert.equal(f.timers.size, 1);
    const notifications = f.onChange.mock.callCount();
    f.connection.invalidate();
    assert.equal(f.connection.view().fresh, false);
    assert.equal(f.connection.view().canGenerateDraft, false);
    assert.match(f.connection.view().label, /需刷新/);
    assert.strictEqual(f.connection.data, lastKnown, '保留上次状态用于解释，不保留许可');
    assert.equal(f.onChange.mock.callCount(), notifications + 1);
    assert.equal(f.views.at(-1).canGenerateDraft, false);
    assert.equal(f.timers.size, 0);
    f.advance(30000);
    assert.equal(f.onChange.mock.callCount(), notifications + 1);
    assert.equal(f.fetch.mock.callCount(), 1);
    await f.connection.refresh();
    assert.equal(f.connection.view().canGenerateDraft, true);
  });

  test('刷新始终只发无缓存 GET，查看、失鲜和 invalidate 均不 POST 或自动调用', async t => {
    const f = fixture(t);
    for (let index = 0; index < 3; index++) {
      await f.connection.refresh();
      f.connection.view();
      f.connection.invalidate();
    }
    await f.connection.refresh();
    f.advance(60000);
    assert.equal(f.fetch.mock.callCount(), 4);
    for (const { arguments: [url, options] } of f.fetch.mock.calls) {
      assert.equal(url, '/api/connection/status');
      assert.equal(options.method || 'GET', 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers.Accept, 'application/json');
      assert.ok(options.signal instanceof AbortSignal);
    }
  });
});
