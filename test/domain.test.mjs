import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, mutate, report, calculateTimeBudget, InputError } from '../domain.mjs';

const BODY = '这是一段自动测试使用的完整正文：先列出待办，再标注下一步动作，最后记录未完成的原因。仅描述操作步骤，不宣称已经验证效果，也不承诺结果；使用时应结合自己的时间安排。';
const itemPath = (id, action = '') => `/api/items/${id}${action ? `/${action}` : ''}`;

// 每次成功或失败的操作都检查输入快照，防止事务部分写入原 state。
function apply(state, method, path, body) {
  const before = structuredClone(state);
  let next;
  try {
    next = mutate(state, method, path, body);
  } finally {
    assert.deepEqual(state, before, `${method} ${path} 不得改变原 state`);
  }
  assert.notStrictEqual(next, state);
  for (const key of ['profile', 'sources', 'items', 'events']) {
    assert.notStrictEqual(next[key], state[key], `${key} 应与原 state 隔离`);
  }
  return next;
}

function rejects(state, method, path, body, status = 400) {
  assert.throws(() => apply(state, method, path, body), error => {
    assert.ok(error instanceof InputError, `应为 InputError，实际为 ${error}`);
    assert.equal(error.status, status);
    assert.ok(error.message.length > 0);
    return true;
  });
}

function planned(count = 1, weeklyHours = 40) {
  let state = apply(createInitialState(), 'POST', '/api/profile', { weeklyHours });
  return apply(state, 'POST', '/api/plan', { count });
}

function approve(state, id) {
  state = apply(state, 'POST', itemPath(id, 'draft'));
  state = apply(state, 'PATCH', itemPath(id), { body: BODY });
  state = apply(state, 'POST', itemPath(id, 'review'));
  return apply(state, 'POST', itemPath(id, 'approve'));
}

function publish(state, id) {
  state = approve(state, id);
  return apply(state, 'POST', itemPath(id, 'publish'), { url: 'https://example.com/post' });
}

function published(count = 1) {
  let state = planned(count);
  for (const { id } of state.items) state = publish(state, id);
  return state;
}

const metrics = (state, id, values) => apply(state, 'POST', itemPath(id, 'metrics'), values);
const source = (state, title = '自有测试资料') => apply(state, 'POST', '/api/sources', {
  title, content: '这是测试资料，描述操作步骤，不构成效果证据。', url: 'https://example.com/reference',
});

test('createInitialState：独立初始对象，只标识本地模板而非已接入 AI', () => {
  const first = createInitialState();
  const second = createInitialState();
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.mode, 'template');
  assert.equal(first.profile.weeklyHours, 3);
  assert.deepEqual(first.items, []);
  assert.equal(first.sources.length, 1);
  assert.equal(first.sources[0].kind, 'builtin');
  assert.equal(first.events[0].type, 'setup');
  assert.match(first.events[0].message, /尚未调用 AI/);
  assert.notEqual(first.sources[0].id, second.sources[0].id);
  assert.notEqual(first.events[0].id, second.events[0].id);
  assert.ok(Number.isFinite(Date.parse(first.sources[0].createdAt)));
  const before = structuredClone(second);
  first.profile.name = '仅改变第一个实例';
  first.sources[0].content = '仅改变第一个实例';
  first.items.push({ id: 'isolated' });
  first.events[0].message = '仅改变第一个实例';
  assert.deepEqual(second, before);
});

test('mutate：返回值的嵌套对象与原 state 彻底隔离', () => {
  const original = planned();
  const before = structuredClone(original);
  const next = apply(original, 'POST', '/api/profile', { name: '新定位' });
  next.profile.audience = '另一个受众';
  next.sources[0].title = '另一个资料';
  next.items[0].sourceIds.push('not-original');
  next.events.at(-1).message = '另一个事件';
  assert.deepEqual(original, before);
});

test('账号资料：去除首尾空白，接受长度与小时数边界，忽略越权字段', () => {
  let state = createInitialState();
  const limits = { name: 80, audience: 300, positioning: 600, platform: 100, tone: 300, goal: 600 };
  for (const [key, length] of Object.entries(limits)) {
    state = apply(state, 'POST', '/api/profile', { [key]: ` ${'字'.repeat(length)} ` });
    assert.equal(state.profile[key], '字'.repeat(length));
  }
  for (const weeklyHours of [1, 40]) {
    state = apply(state, 'POST', '/api/profile', { weeklyHours });
    assert.equal(state.profile.weeklyHours, weeklyHours);
  }
  const next = apply(state, 'POST', '/api/profile', { mode: 'agent', schemaVersion: 99, items: [] });
  assert.equal(next.mode, 'template');
  assert.equal(next.schemaVersion, 1);
  assert.equal(Object.hasOwn(next.profile, 'mode'), false);
});

test('账号资料：拒绝空白、非文字、空字符、超长与非法小时数，失败无部分更新', () => {
  const state = createInitialState();
  const limits = { name: 80, audience: 300, positioning: 600, platform: 100, tone: 300, goal: 600 };
  for (const [key, length] of Object.entries(limits)) {
    for (const value of ['', ' \n ', null, 123, [], {}, '含\0空字符', '字'.repeat(length + 1)]) {
      rejects(state, 'POST', '/api/profile', { [key]: value });
    }
  }
  for (const weeklyHours of [0, -1, 41, 1.5, '3', true, null, NaN, Infinity]) {
    rejects(state, 'POST', '/api/profile', { name: '不得部分保存', weeklyHours });
  }
});

test('计划：默认创建三条，结构、修订与估计预算正确', () => {
  const state = apply(createInitialState(), 'POST', '/api/plan');
  assert.equal(state.items.length, 3);
  assert.equal(new Set(state.items.map(item => item.id)).size, 3);
  assert.equal(new Set(state.items.map(item => item.title)).size, 3);
  for (const item of state.items) {
    assert.equal(item.status, 'idea');
    assert.equal(item.estimatedMinutes, 40);
    assert.equal(item.revision, 0);
    assert.equal(item.body, '');
    assert.deepEqual(item.sourceIds, []);
    for (const key of ['review', 'publishedUrl', 'publishedAt', 'metrics']) assert.equal(item[key], null);
    assert.ok(Number.isFinite(Date.parse(item.createdAt)));
  }
  assert.equal(state.events[0].type, 'plan');
});

test('计划：恰好用满预算成功，超预算失败，已发布内容释放预算', () => {
  let state = planned(3, 2);
  rejects(state, 'POST', '/api/plan', { count: 1 });
  state = publish(state, state.items[0].id);
  state = apply(state, 'POST', '/api/plan', { count: 1 });
  assert.equal(state.items.length, 4);
  assert.equal(state.items.filter(item => item.status !== 'published').length, 3);
  rejects(state, 'POST', '/api/plan', { count: 1 });
  rejects(apply(createInitialState(), 'POST', '/api/profile', { weeklyHours: 1 }), 'POST', '/api/plan', { count: 2 });
});

test('V2 时间预算计算：未发布内容统计工时，已发布释放工时', () => {
  let state = createInitialState();
  let b = calculateTimeBudget(state);
  assert.equal(b.totalMinutes, 180);
  assert.equal(b.usedMinutes, 0);
  assert.equal(b.remainingMinutes, 180);
  assert.equal(b.activeCount, 0);

  state = planned(1, 3);
  b = calculateTimeBudget(state);
  assert.equal(b.usedMinutes, 40);
  assert.equal(b.remainingMinutes, 140);
  assert.equal(b.activeCount, 1);

  state = publish(state, state.items[0].id);
  b = calculateTimeBudget(state);
  assert.equal(b.usedMinutes, 0);
  assert.equal(b.remainingMinutes, 180);
  assert.equal(b.activeCount, 0);
});

test('V2 自定义/AI 规划采纳：成功添加多项、受总工时硬约束、校验资料有效性与防重名', () => {
  let state = createInitialState();
  const sourceId = state.sources[0].id;
  // 正常采纳 2 条
  state = apply(state, 'POST', '/api/plan', {
    items: [
      { title: '个性化新选题1', angle: '角度1', reason: '理由1', estimatedMinutes: 45, sourceIds: [sourceId] },
      { title: '个性化新选题2', angle: '角度2', reason: '理由2', estimatedMinutes: 45, sourceIds: [sourceId] },
    ],
  });
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].title, '个性化新选题1');
  assert.equal(state.items[0].estimatedMinutes, 45);
  assert.equal(state.items[0].status, 'idea');
  assert.deepEqual(state.items[0].sourceIds, [sourceId]);

  // 重复添加同名选题被拦截
  assert.throws(() => apply(state, 'POST', '/api/plan', {
    items: [{ title: '个性化新选题1', angle: '角度', reason: '理由', estimatedMinutes: 30, sourceIds: [] }],
  }), /已存在/);

  // 引用不存在的资料被拦截
  assert.throws(() => apply(state, 'POST', '/api/plan', {
    items: [{ title: '选题X', angle: '角度', reason: '理由', estimatedMinutes: 30, sourceIds: ['unknown-source-id'] }],
  }), /引用的资料不存在/);

  // 超出剩余时间预算（当前已有 90 分钟，总预算 180 分钟，再加 100 分钟超额）
  assert.throws(() => apply(state, 'POST', '/api/plan', {
    items: [{ title: '超时长选题', angle: '角度', reason: '理由', estimatedMinutes: 100, sourceIds: [] }],
  }), /超出每周/);
});

test('计划：idea、draft、reviewed、approved 均占用未完成预算', () => {
  let state = planned(1, 1);
  const id = state.items[0].id;
  rejects(state, 'POST', '/api/plan', { count: 1 });
  state = apply(state, 'POST', itemPath(id, 'draft'));
  rejects(state, 'POST', '/api/plan', { count: 1 });
  state = apply(state, 'PATCH', itemPath(id), { body: BODY });
  state = apply(state, 'POST', itemPath(id, 'review'));
  rejects(state, 'POST', '/api/plan', { count: 1 });
  state = apply(state, 'POST', itemPath(id, 'approve'));
  rejects(state, 'POST', '/api/plan', { count: 1 });
});

test('计划：拒绝非法数量，不重复创建已使用或已发布的五个模板', () => {
  let state = planned();
  for (const count of [0, -1, 6, 1.1, '2', false, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(state, 'POST', '/api/plan', { count });
  }
  state = apply(state, 'POST', '/api/plan', { count: 4 });
  assert.equal(new Set(state.items.map(item => item.title)).size, 5);
  rejects(state, 'POST', '/api/plan', { count: 1 });
  for (const { id } of state.items) state = publish(state, id);
  rejects(state, 'POST', '/api/plan', { count: 1 });
});

test('计划：500 条存储上限在边界生效', () => {
  const state = published();
  const prototype = state.items[0];
  state.items = Array.from({ length: 499 }, (_, index) => ({
    ...structuredClone(prototype), id: `historical-${index}`, title: `历史测试内容 ${index}`,
  }));
  const full = apply(state, 'POST', '/api/plan', { count: 1 });
  assert.equal(full.items.length, 500);
  rejects(full, 'POST', '/api/plan', { count: 1 });
});

test('参考资料：校验并规范化，不自动抓取链接', () => {
  const state = apply(createInitialState(), 'POST', '/api/sources', {
    title: ' 测试标题 ', content: ' 测试正文 ', url: ' HTTPS://EXAMPLE.COM:443/reference ',
    kind: 'builtin', id: 'forged-id',
  });
  const added = state.sources.at(-1);
  assert.equal(added.title, '测试标题');
  assert.equal(added.content, '测试正文');
  assert.equal(added.url, 'https://example.com/reference');
  assert.equal(added.kind, 'user');
  assert.notEqual(added.id, 'forged-id');
  assert.match(state.events[0].message, /不会自动抓取/);
  const noUrl = apply(state, 'POST', '/api/sources', { title: '无链接', content: '自有记录' });
  assert.equal(noUrl.sources.at(-1).url, '');
  const boundary = apply(state, 'POST', '/api/sources', { title: '字'.repeat(200), content: '字'.repeat(20000) });
  assert.equal(boundary.sources.at(-1).content.length, 20000);
});

test('参考资料：拒绝缺失、错误类型、空字符、过长和危险 URL', () => {
  const state = createInitialState();
  const valid = { title: '标题', content: '资料正文', url: 'https://example.com/' };
  for (const key of ['title', 'content']) {
    for (const value of [undefined, '', ' \t ', null, 1, [], {}, '恶意\0输入']) {
      rejects(state, 'POST', '/api/sources', { ...valid, [key]: value });
    }
  }
  rejects(state, 'POST', '/api/sources', { ...valid, title: '字'.repeat(201) });
  rejects(state, 'POST', '/api/sources', { ...valid, content: '字'.repeat(20001) });
  for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//example.com', 'not a url', 'https://user:pass@example.com', 'https://user@example.com', 'https://example.com/\0', 'https://example.com/' + 'a'.repeat(2000), 42, {}]) {
    rejects(state, 'POST', '/api/sources', { ...valid, url });
  }
});

test('参考资料：100 份上限，删除未引用资料后可再新增', () => {
  const state = source(createInitialState());
  const prototype = state.sources.at(-1);
  state.sources = Array.from({ length: 99 }, (_, index) => ({ ...prototype, id: `source-${index}` }));
  const full = source(state);
  assert.equal(full.sources.length, 100);
  rejects(full, 'POST', '/api/sources', { title: '第 101 份', content: '不应保存' });
  const removed = apply(full, 'DELETE', `/api/sources/${full.sources[0].id}`);
  assert.equal(removed.sources.length, 99);
  assert.equal(source(removed).sources.length, 100);
  rejects(removed, 'DELETE', '/api/sources/not-found', {}, 404);
});

test('草稿：优先引用最多三份用户资料，不覆盖已有正文', () => {
  let state = planned();
  for (let index = 1; index <= 4; index += 1) state = source(state, `用户资料 ${index}`);
  const id = state.items[0].id;
  const drafted = apply(state, 'POST', itemPath(id, 'draft'));
  const item = drafted.items[0];
  assert.equal(item.status, 'draft');
  assert.equal(item.revision, 1);
  assert.equal(item.review, null);
  assert.deepEqual(item.sourceIds, state.sources.filter(entry => entry.kind === 'user').slice(0, 3).map(entry => entry.id));
  assert.match(item.body, /用户资料 1/);
  assert.match(item.body, /用户资料 3/);
  assert.doesNotMatch(item.body, /用户资料 4|内置演示：/);
  assert.match(item.body, /不是 AI 自动创作/);
  rejects(drafted, 'POST', itemPath(id, 'draft'));
});

test('草稿：没有用户资料时引用内置演示，没有任何资料也给出提示', () => {
  let state = planned();
  const id = state.items[0].id;
  const drafted = apply(state, 'POST', itemPath(id, 'draft'));
  assert.deepEqual(drafted.items[0].sourceIds, [state.sources[0].id]);
  assert.match(drafted.items[0].body, /内置演示/);
  state = apply(state, 'DELETE', `/api/sources/${state.sources[0].id}`);
  state = apply(state, 'POST', itemPath(id, 'draft'));
  assert.deepEqual(state.items[0].sourceIds, []);
  assert.match(state.items[0].body, /暂无资料/);
});

test('草稿：默认占位符与两种冒号占位符均阻止人工确认', () => {
  let state = planned();
  const id = state.items[0].id;
  state = apply(state, 'POST', itemPath(id, 'draft'));
  const cases = [state.items[0].body, `${BODY}\n[待补充：真实经历]`, `${BODY}\n[待补充:真实经历]`];
  for (const body of cases) {
    let candidate = apply(state, 'PATCH', itemPath(id), { body });
    candidate = apply(candidate, 'POST', itemPath(id, 'review'));
    assert.equal(candidate.items[0].status, 'reviewed');
    assert.ok(candidate.items[0].review.checks.some(check => check.level === 'blocker' && /占位/.test(check.message)));
    rejects(candidate, 'POST', itemPath(id, 'approve'));
    rejects(candidate, 'POST', itemPath(id, 'publish'), { url: 'https://example.com/post' });
  }
});

test('状态机：draft → review → approve → publish，只登记人工发布', () => {
  let state = planned();
  const id = state.items[0].id;
  rejects(state, 'POST', itemPath(id, 'approve'));
  rejects(state, 'POST', itemPath(id, 'publish'), { url: 'https://example.com/post' });
  state = apply(state, 'POST', itemPath(id, 'draft'));
  rejects(state, 'POST', itemPath(id, 'approve'));
  state = apply(state, 'PATCH', itemPath(id), { body: BODY });
  assert.equal(state.items[0].revision, 2);
  state = apply(state, 'POST', itemPath(id, 'review'));
  assert.equal(state.items[0].status, 'reviewed');
  assert.equal(state.items[0].review.revision, 2);
  assert.ok(Number.isFinite(Date.parse(state.items[0].review.createdAt)));
  assert.ok(state.items[0].review.checks.some(check => check.level === 'pass'));
  rejects(state, 'POST', itemPath(id, 'publish'), { url: 'https://example.com/post' });
  state = apply(state, 'POST', itemPath(id, 'approve'));
  assert.equal(state.items[0].status, 'approved');
  assert.equal(state.items[0].publishedAt, null);
  rejects(state, 'POST', itemPath(id, 'metrics'), { views: 1, likes: 0, comments: 0, saves: 0 });
  state = apply(state, 'POST', itemPath(id, 'publish'), { url: ' HTTPS://EXAMPLE.COM:443/post ' });
  assert.equal(state.items[0].status, 'published');
  assert.equal(state.items[0].publishedUrl, 'https://example.com/post');
  assert.ok(Number.isFinite(Date.parse(state.items[0].publishedAt)));
  assert.match(state.events[0].message, /系统没有向平台发送内容/);
});

test('审核：空正文阻止确认，warning 不冒充事实核查也不等于 blocker', () => {
  let state = planned();
  const id = state.items[0].id;
  state = apply(state, 'POST', itemPath(id, 'review'));
  assert.ok(state.items[0].review.checks.some(check => check.level === 'blocker'));
  rejects(state, 'POST', itemPath(id, 'approve'));
  state = apply(state, 'PATCH', itemPath(id), { body: '保证 100% 完全免费：这是用于触发警告的测试文本。' });
  state = apply(state, 'POST', itemPath(id, 'review'));
  const checks = state.items[0].review.checks;
  assert.equal(checks.some(check => check.level === 'blocker'), false);
  for (const pattern of [/较短/, /夸大/, /没有关联参考资料/, /未调用 AI/]) {
    assert.ok(checks.some(check => check.level === 'warning' && pattern.test(check.message)));
  }
  state = apply(state, 'POST', itemPath(id, 'approve'));
  assert.equal(state.items[0].status, 'approved');
});

for (const status of ['reviewed', 'approved']) {
  for (const change of [{ title: '新的测试标题' }, { body: `${BODY}\n补充适用边界。` }]) {
    test(`修改${Object.keys(change)[0]}：使 ${status} 旧审核失效，必须重新检查确认`, () => {
      let state = planned();
      const id = state.items[0].id;
      state = approve(state, id);
      if (status === 'reviewed') state = apply(state, 'POST', itemPath(id, 'review'));
      const oldReview = structuredClone(state.items[0].review);
      const oldRevision = state.items[0].revision;
      state = apply(state, 'PATCH', itemPath(id), change);
      assert.equal(state.items[0].revision, oldRevision + 1);
      assert.equal(state.items[0].status, 'draft');
      assert.equal(state.items[0].review, null);
      rejects(state, 'POST', itemPath(id, 'approve'));
      rejects(state, 'POST', itemPath(id, 'publish'), { url: 'https://example.com/post' });
      const stale = structuredClone(state);
      stale.items[0].status = 'reviewed';
      stale.items[0].review = oldReview;
      rejects(stale, 'POST', itemPath(id, 'approve'));
      state = apply(state, 'POST', itemPath(id, 'review'));
      state = apply(state, 'POST', itemPath(id, 'approve'));
      assert.equal(state.items[0].status, 'approved');
    });
  }
}

test('编辑并发：过期版本号返回409且不保存，匹配或缺省才写入', () => {
  let state = planned();
  const id = state.items[0].id;
  const base = state.items[0].revision;
  assert.throws(() => apply(state, 'PATCH', itemPath(id), { body: BODY, expectedRevision: 99 }), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /其他页面/);
    return true;
  });
  state = apply(state, 'PATCH', itemPath(id), { title: '另一个页面的标题', expectedRevision: base });
  assert.equal(state.items[0].revision, base + 1);
  assert.throws(() => apply(state, 'PATCH', itemPath(id), { title: '旧页面覆盖', expectedRevision: base }), error => error.status === 409);
  const compatible = apply(state, 'PATCH', itemPath(id), { body: BODY });
  assert.equal(compatible.items[0].revision, base + 2, '未带版本号时保持旧接口兼容');
  for (const expectedRevision of [-1, 1.5, '0', null, true]) {
    assert.throws(() => apply(compatible, 'PATCH', itemPath(id), { title: '无效版本', expectedRevision }), error => error.status === 400);
  }
});

test('编辑：校验长度与类型，空正文可以保存但不可确认，额外字段不能伪造审核', () => {  const state = planned();
  const id = state.items[0].id;
  rejects(state, 'PATCH', itemPath(id), {});
  for (const title of ['', '  ', 1, null, {}, [], '字'.repeat(201), '标题\0']) {
    rejects(state, 'PATCH', itemPath(id), { title });
  }
  for (const body of [null, 1, {}, [], '字'.repeat(20001), '正文\0']) {
    rejects(state, 'PATCH', itemPath(id), { title: '不得部分更新', body });
  }
  let next = apply(state, 'PATCH', itemPath(id), {
    title: '字'.repeat(200), body: '字'.repeat(20000), status: 'published', revision: 999,
    review: { revision: 999, checks: [] }, sourceIds: ['fake'], publishedUrl: 'https://example.com/',
  });
  assert.equal(next.items[0].status, 'draft');
  assert.equal(next.items[0].revision, 1);
  assert.equal(next.items[0].review, null);
  assert.equal(next.items[0].publishedUrl, null);
  assert.deepEqual(next.items[0].sourceIds, []);
  next = apply(next, 'PATCH', itemPath(id), { body: ' \n ' });
  assert.equal(next.items[0].body, '');
  next = apply(next, 'POST', itemPath(id, 'review'));
  rejects(next, 'POST', itemPath(id, 'approve'));
});

test('发布：非法或带凭据 URL 不能改变 approved 状态', () => {
  let state = planned();
  const id = state.items[0].id;
  state = approve(state, id);
  for (const url of [undefined, null, '', ' ', 123, {}, [], '/relative', 'http://example.com', 'javascript:alert(1)', 'file:///tmp/secret', 'https://user:password@example.com', 'https://example.com/\0', 'https://example.com/' + 'x'.repeat(2000)]) {
    rejects(state, 'POST', itemPath(id, 'publish'), { url });
  }
  assert.equal(state.items[0].status, 'approved');
  assert.equal(state.items[0].publishedUrl, null);
});

test('已发布：锁定标题正文、草稿、审核、重复确认和重复登记', () => {
  const state = published();
  const id = state.items[0].id;
  rejects(state, 'PATCH', itemPath(id), { title: '不应保存' });
  rejects(state, 'PATCH', itemPath(id), { body: BODY });
  for (const action of ['draft', 'review', 'approve', 'publish']) {
    rejects(state, 'POST', itemPath(id, action), { url: 'https://example.com/changed' });
  }
});

test('引用资料：草稿与已发布引用不能删除，未引用资料可删', () => {
  let state = source(planned());
  const id = state.items[0].id;
  const sourceId = state.sources.at(-1).id;
  state = apply(state, 'POST', itemPath(id, 'draft'));
  rejects(state, 'DELETE', `/api/sources/${sourceId}`);
  state = apply(state, 'DELETE', `/api/sources/${state.sources[0].id}`);
  assert.deepEqual(state.sources.map(entry => entry.id), [sourceId]);
  state = apply(state, 'PATCH', itemPath(id), { body: BODY });
  state = apply(state, 'POST', itemPath(id, 'review'));
  state = apply(state, 'POST', itemPath(id, 'approve'));
  state = apply(state, 'POST', itemPath(id, 'publish'), { url: 'https://example.com/post' });
  rejects(state, 'DELETE', `/api/sources/${sourceId}`);
});

test('手动指标：累计快照覆盖而非累加，允许将旧值改小或归零', () => {
  let state = published();
  const id = state.items[0].id;
  const revision = state.items[0].revision;
  const publishedAt = state.items[0].publishedAt;
  state = metrics(state, id, { views: 100, likes: 20, comments: 5, saves: 10 });
  state = metrics(state, id, { views: 50, likes: 3, comments: 1, saves: 2 });
  assert.deepEqual(report(state).totals, { views: 50, likes: 3, comments: 1, saves: 2 });
  assert.equal(state.items[0].revision, revision);
  assert.equal(state.items[0].publishedAt, publishedAt);
  assert.equal(state.items[0].status, 'published');
  assert.ok(Number.isFinite(Date.parse(state.items[0].metrics.recordedAt)));
  state = metrics(state, id, { views: 0, likes: 0, comments: 0, saves: 0 });
  assert.deepEqual(report(state).totals, { views: 0, likes: 0, comments: 0, saves: 0 });
  assert.equal(report(state).measuredCount, 1);
});

test('手动指标：各字段仅接受 0 到十亿的整数，拒绝缺失且失败不覆盖旧快照', () => {
  let state = published();
  const id = state.items[0].id;
  const valid = { views: 1_000_000_000, likes: 1_000_000_000, comments: 1_000_000_000, saves: 1_000_000_000 };
  state = metrics(state, id, valid);
  assert.equal(report(state).rows[0].interactions, 3_000_000_000);
  for (const key of Object.keys(valid)) {
    for (const value of [undefined, null, -1, 1.5, 1_000_000_001, '1', true, {}, [], NaN, Infinity]) {
      rejects(state, 'POST', itemPath(id, 'metrics'), { ...valid, [key]: value });
    }
  }
  const idea = planned();
  rejects(idea, 'POST', itemPath(idea.items[0].id, 'metrics'), valid);
});

test('report：无数据时返回零总数、null 比率和有限样本提示，且不改变输入', () => {
  for (const state of [createInitialState(), planned(), published()]) {
    const before = structuredClone(state);
    const result = report(state);
    assert.deepEqual(state, before);
    assert.equal(result.publishedCount, state.items.filter(item => item.status === 'published').length);
    assert.equal(result.measuredCount, 0);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.totals, { views: 0, likes: 0, comments: 0, saves: 0 });
    assert.equal(result.interactionRate, null);
    assert.equal(result.best, null);
    assert.ok(result.recommendations.some(message => /尚未录入/.test(message)));
    assert.ok(result.recommendations.some(message => /不是 AI 分析/.test(message)));
  }
});

test('report：零分母不产生 Infinity/NaN，异常零浏览互动给出提醒', () => {
  let state = published(2);
  state = metrics(state, state.items[0].id, { views: 0, likes: 0, comments: 0, saves: 0 });
  state = metrics(state, state.items[1].id, { views: 0, likes: 3, comments: 2, saves: 1 });
  const result = report(state);
  assert.equal(result.interactionRate, null);
  assert.equal(result.best, null);
  assert.ok(result.rows.every(row => row.rate === null));
  assert.deepEqual(result.totals, { views: 0, likes: 3, comments: 2, saves: 1 });
  assert.ok(result.recommendations.some(message => /浏览量为 0、互动量却大于 0/.test(message)));
  assert.ok(result.recommendations.some(message => /无法计算互动率/.test(message)));
});

test('report：多条数据相加，按总浏览量计算比率而非平均各行比率', () => {
  let state = published(4);
  state = metrics(state, state.items[0].id, { views: 100, likes: 10, comments: 5, saves: 5 });
  state = metrics(state, state.items[1].id, { views: 300, likes: 15, comments: 10, saves: 5 });
  state = metrics(state, state.items[2].id, { views: 0, likes: 2, comments: 1, saves: 2 });
  state = apply(state, 'POST', '/api/plan', { count: 1 });
  // 非发布项即使含有导入的指标，也不应进入已发布统计。
  state.items[4].metrics = { views: 999, likes: 999, comments: 999, saves: 999 };
  const before = structuredClone(state);
  const result = report(state);
  assert.deepEqual(state, before);
  assert.equal(result.publishedCount, 4);
  assert.equal(result.measuredCount, 3);
  assert.deepEqual(result.totals, { views: 400, likes: 27, comments: 16, saves: 12 });
  assert.equal(result.interactionRate, 55 / 400);
  assert.deepEqual(result.rows.map(row => row.rate), [0.2, 0.1, null]);
  assert.equal(result.best.id, state.items[0].id);
  assert.equal(result.best.interactions, 20);
  assert.ok(result.recommendations.some(message => /样本不足/.test(message)));
  assert.ok(result.recommendations.some(message => /不能推断因果/.test(message)));
});

test('report：最高比率相同时优先高浏览量，超过 100% 给出解释', () => {
  let state = published(3);
  state = metrics(state, state.items[0].id, { views: 100, likes: 20, comments: 0, saves: 0 });
  state = metrics(state, state.items[1].id, { views: 200, likes: 40, comments: 0, saves: 0 });
  assert.equal(report(state).best.id, state.items[1].id);
  state = metrics(state, state.items[2].id, { views: 10, likes: 10, comments: 5, saves: 5 });
  const result = report(state);
  assert.equal(result.best.id, state.items[2].id);
  assert.equal(result.best.rate, 2);
  assert.ok(result.recommendations.some(message => /超过 100%/.test(message)));
});

test('恶意参数：拒绝非对象请求、未知资源与方法，不允许原型或越权字段注入', () => {
  const state = planned();
  const id = state.items[0].id;
  for (const body of [null, false, 1, 'text', [], NaN]) rejects(state, 'POST', '/api/profile', body);
  for (const [method, path] of [
    ['POST', '/api/unknown'], ['GET', '/api/profile'], ['PUT', itemPath(id)],
    ['POST', itemPath('missing', 'draft')], ['POST', itemPath(id, 'delete')],
    ['DELETE', '/api/sources/../../workspace.json'], ['PATCH', '/api/items/__proto__'],
    ['POST', '/api/items/%2e%2e/draft'],
  ]) rejects(state, method, path, {}, 404);
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"name":"安全标题","mode":"agent"}');
  const bodyBefore = structuredClone(input);
  const next = apply(state, 'POST', '/api/profile', input);
  assert.deepEqual(input, bodyBefore);
  assert.equal(next.profile.name, '安全标题');
  assert.equal(next.mode, 'template');
  assert.equal(Object.hasOwn(next.profile, '__proto__'), false);
  assert.equal(Object.hasOwn(next.profile, 'constructor'), false);
  assert.equal({}.polluted, undefined);
});

test('AI 草稿检查保留人工核实提醒，并细化字数分档报告', () => {
  let state = planned();
  const id = state.items[0].id;
  // 超出目标 (>650)
  state = apply(state, 'PATCH', itemPath(id), { body: '字'.repeat(699) });
  state.items[0].ai = { cautions: ['此内容尚未经过事实核查。'] };
  state = apply(state, 'POST', itemPath(id, 'review'));
  let warnings = state.items[0].review.checks.filter(check => check.level === 'warning');
  assert.ok(warnings.some(check => check.message.includes('699') && check.message.includes('400—650') && check.message.includes('超出')));
  assert.ok(warnings.some(check => check.message === '此内容尚未经过事实核查。'));
  assert.equal(state.items[0].status, 'reviewed');

  // 略低于目标 (300-399)
  state = apply(state, 'PATCH', itemPath(id), { body: '字'.repeat(350) });
  state.items[0].ai = { cautions: [] };
  state = apply(state, 'POST', itemPath(id, 'review'));
  warnings = state.items[0].review.checks.filter(check => check.level === 'warning');
  assert.ok(warnings.some(check => check.message.includes('350') && check.message.includes('400—650') && check.message.includes('略低于')));

  // 严重短于目标 (<300)
  state = apply(state, 'PATCH', itemPath(id), { body: '字'.repeat(250) });
  state.items[0].ai = { cautions: [] };
  state = apply(state, 'POST', itemPath(id, 'review'));
  warnings = state.items[0].review.checks.filter(check => check.level === 'warning');
  assert.ok(warnings.some(check => check.message.includes('250') && check.message.includes('400—650') && check.message.includes('严重短于')));

  // 达标区间 (400-650)
  state = apply(state, 'PATCH', itemPath(id), { body: '字'.repeat(500) });
  state.items[0].ai = { cautions: [] };
  state = apply(state, 'POST', itemPath(id, 'review'));
  warnings = state.items[0].review.checks.filter(check => check.level === 'warning');
  assert.ok(!warnings.some(check => check.message.includes('400—650')));
});

test('任务归档与取消归档：归档任务不计入当前周工时预算，已发布任务不可重复归档', () => {
  let state = planned(2, 3); // 2 items, 40m each = 80m. Total = 180m. Remaining = 100m.
  const [item1, item2] = state.items;
  let budget = calculateTimeBudget(state);
  assert.equal(budget.usedMinutes, 80);
  assert.equal(budget.remainingMinutes, 100);
  assert.equal(budget.activeCount, 2);

  // 归档 item1
  state = apply(state, 'POST', itemPath(item1.id, 'archive'));
  assert.equal(state.items.find(i => i.id === item1.id).archived, true);
  budget = calculateTimeBudget(state);
  assert.equal(budget.usedMinutes, 40); // 只有 item2 计入
  assert.equal(budget.remainingMinutes, 140);
  assert.equal(budget.activeCount, 1);

  // 取消归档 item1
  state = apply(state, 'POST', itemPath(item1.id, 'unarchive'));
  assert.equal(state.items.find(i => i.id === item1.id).archived, false);
  budget = calculateTimeBudget(state);
  assert.equal(budget.usedMinutes, 80);
  assert.equal(budget.remainingMinutes, 100);
  assert.equal(budget.activeCount, 2);

  // 已发布任务不可归档
  state = publish(state, item2.id);
  rejects(state, 'POST', itemPath(item2.id, 'archive'), {}, 400);
});
