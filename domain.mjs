import { randomUUID } from 'node:crypto';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const now = () => new Date().toISOString();
const id = () => randomUUID();
const fail = (message, status) => { throw new InputError(message, status); };
const own = (obj, key) => Object.hasOwn(obj, key);

function text(value, label, max, required = true) {
  if (typeof value !== 'string') fail(`${label}必须是文字。`);
  const result = value.trim();
  if (required && !result) fail(`请填写${label}。`);
  if (result.length > max) fail(`${label}最多 ${max} 个字符。`);
  if (result.includes('\0')) fail(`${label}不能包含空字符。`);
  return result;
}
function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label}须为 ${min} 到 ${max} 之间的整数。`);
  }
  return value;
}
function webUrl(value, required = false) {
  const result = text(value, '链接', 2000, required);
  if (!result) return '';
  let url;
  try { url = new URL(result); } catch { fail('请输入完整的 HTTPS 网页链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('仅接受不包含账号密码的 HTTPS 网页链接。');
  return url.href;
}
function event(state, type, message) {
  state.events.unshift({ id: id(), type, message, createdAt: now() });
  state.events = state.events.slice(0, 300);
}

export function createInitialState() {
  return {
    schemaVersion: 1,
    mode: 'template',
    profile: {
      name: '一人效率实验室',
      audience: '希望把学习与工作安排得更清楚的大学生和职场新人',
      positioning: '分享亲自验证过的工具用法与小方法，一篇内容解决一个具体问题',
      platform: '小红书图文（人工发布）',
      tone: '清楚、具体、不夸大，不虚构使用体验',
      weeklyHours: 3,
      goal: '每周完成 3 篇经过人工核实的图文，积累可复盘的内容记录',
    },
    sources: [{
      id: id(), title: '内置演示：把一周待办整理成三类', kind: 'builtin', url: '',
      content: '这是一份用于体验流程的自编演示资料，不是外部研究或产品测评。示例方法：把待办分成必须完成、可以推进、暂缓处理三类；为必须完成的事项补上下一步动作；周末记录哪些完成、哪些需要调整。没有真实试验结果，不可声称必然提高效率或节省了具体时长。正式发布前请替换为自己验证过的资料。',
      createdAt: now(),
    }],
    items: [],
    events: [{ id: id(), type: 'setup', message: '本地工作台已准备好。当前为模板演示，尚未调用 AI 或连接平台账号。', createdAt: now() }],
  };
}

const ideas = [
  { title: '待办越写越多？试试先分成这三类', angle: '用一个具体的一周任务例子，讲清分类方法。', reason: '问题明确，可用自己的任务清单拍图验证，不依赖付费工具。' },
  { title: '一份能照着做的周末复盘清单', angle: '围绕完成、卡住、下周调整三个问题展开。', reason: '适合图文清单，也方便后续用自己的实践补充证据。' },
  { title: '任务清单为什么写了却没开始？', angle: '把模糊目标改写成能立刻执行的下一步动作。', reason: '切口小，能用修改前后的任务描述进行对照。' },
  { title: '用一页纸规划明天：先留出缓冲时间', angle: '展示一页计划如何容纳必要任务与意外事项。', reason: '制作成本低，不需要引用无法核实的产品功能。' },
  { title: '别急着换工具，先记录你卡在哪一步', angle: '从个人工作流程找问题，再决定是否需要新工具。', reason: '避免空泛推荐，鼓励真实记录而不是夸大效率收益。' },
];

export function calculateTimeBudget(state) {
  const active = state.items.filter(item => item.status !== 'published');
  const usedMinutes = active.reduce((sum, item) => sum + item.estimatedMinutes, 0);
  const totalMinutes = state.profile.weeklyHours * 60;
  const remainingMinutes = Math.max(0, totalMinutes - usedMinutes);
  return { totalMinutes, usedMinutes, remainingMinutes, activeCount: active.length };
}

function plan(state, body) {
  const budget = calculateTimeBudget(state);
  if (Array.isArray(body.items)) {
    if (!body.items.length || body.items.length > 5) fail('一次最多采纳 1 到 5 个选题。');
    const sourcesSet = new Set(state.sources.map(s => s.id));
    let totalNewMinutes = 0;
    const candidates = body.items.map((item, idx) => {
      if (!item || typeof item !== 'object') fail(`第 ${idx + 1} 个选题格式无效。`);
      const title = text(item.title, `第 ${idx + 1} 个选题标题`, 200);
      if (state.items.some(existing => existing.title === title)) {
        fail(`选题「${title}」已存在，请勿重复添加。`);
      }
      const angle = text(item.angle, `选题「${title}」的内容角度`, 2000);
      const reason = text(item.reason, `选题「${title}」的规划理由`, 2000);
      const estimatedMinutes = integer(item.estimatedMinutes ?? 40, `选题「${title}」预估用时`, 20, 180);
      totalNewMinutes += estimatedMinutes;
      const sourceIds = Array.isArray(item.sourceIds) ? item.sourceIds : [];
      if (!sourceIds.every(sourceId => sourcesSet.has(sourceId))) {
        fail(`选题「${title}」引用的资料不存在。`);
      }
      return {
        id: id(), title, angle, reason, estimatedMinutes, status: 'idea', body: '',
        sourceIds: [...new Set(sourceIds)], revision: 0, review: null, publishedUrl: null,
        publishedAt: null, metrics: null, createdAt: now(), updatedAt: now(),
      };
    });
    if (budget.usedMinutes + totalNewMinutes > budget.totalMinutes) {
      fail(`当前已有约 ${budget.usedMinutes} 分钟未完成任务，新选内容需 ${totalNewMinutes} 分钟，超出每周 ${state.profile.weeklyHours} 小时（${budget.totalMinutes} 分钟）预算。请减少勾选或调整每周时间。`);
    }
    if (state.items.length + candidates.length > 500) fail('本地原型最多保留 500 条内容，请先导出备份。');
    state.items.push(...candidates);
    event(state, 'plan', `已采纳 ${candidates.length} 个规划选题，预计制作 ${totalNewMinutes} 分钟（受每周 ${state.profile.weeklyHours} 小时预算约束）。`);
    return;
  }
  const count = integer(body.count ?? 3, '选题数量', 1, 5);
  if (budget.usedMinutes + count * 40 > budget.totalMinutes) {
    fail(`当前还有约 ${budget.usedMinutes} 分钟未完成任务，再加 ${count} 条会超出每周 ${state.profile.weeklyHours} 小时预算。请减少数量或调整预算。`);
  }
  if (state.items.length + count > 500) fail('本地原型最多保留 500 条内容，请先导出备份。');
  const available = ideas.filter(idea => !state.items.some(item => item.title === idea.title));
  if (available.length < count) fail(`内置模板只剩 ${available.length} 个未使用选题，请减少数量。更多选题需要后续接入 AI。`);
  const created = available.slice(0, count).map(idea => ({
    id: id(), ...idea, estimatedMinutes: 40, status: 'idea', body: '', sourceIds: [], revision: 0,
    review: null, publishedUrl: null, publishedAt: null, metrics: null, createdAt: now(), updatedAt: now(),
  }));
  state.items.push(...created);
  event(state, 'plan', `用内置模板创建了 ${created.length} 个选题，预计制作 ${created.length * 40} 分钟（人工估计，非模型预测）。`);
}

function draft(state, item) {
  if (item.status === 'published') fail('已发布内容不能重新生成，请保留历史记录。');
  if (item.body) fail('这条内容已有草稿。请直接编辑，避免覆盖你的修改。');
  const sources = state.sources.filter(source => source.kind === 'user');
  const selected = (sources.length ? sources : state.sources).slice(0, 3);
  item.sourceIds = selected.map(source => source.id);
  const refs = selected.map((source, index) => `资料 ${index + 1}：${source.title}\n摘录：${source.content.slice(0, 420)}`).join('\n\n');
  item.body = `${item.title}\n\n【模板草稿，请补充真实经历后再发布】\n\n写给：${state.profile.audience}\n内容角度：${item.angle}\n\n一、先说一个具体问题\n[待补充：你真实遇到的问题、使用场景，不要编造经历。]\n\n二、给出可执行的方法\n[待补充：结合下方资料，用自己的话写出 2—3 个步骤；资料不支持的结论不要写。]\n\n三、展示你的验证过程\n[待补充：自己的截图、操作过程和观察结果。没有验证就明确说明。]\n\n四、告诉读者适用边界\n[待补充：哪些情况可能不适用；不要承诺效果。]\n\n参考资料（供编辑核对，发布前整理）：\n${refs || '暂无资料。请先在参考资料页添加内容。'}\n\n写作约束：${state.profile.tone}\n说明：这是固定结构模板与资料摘录，不是 AI 自动创作，不代表事实已被核查。`;
  item.revision += 1;
  item.review = null;
  item.status = 'draft';
  event(state, 'draft', `「${item.title}」已建立模板草稿，需要人工补充真实内容。`);
}

function review(state, item) {
  if (item.status === 'published') fail('已发布内容不可重新审核。');
  const checks = [];
  if (!item.title.trim() || !item.body.trim()) checks.push({ level: 'blocker', message: '标题和正文不能为空。' });
  if (/\[待补充[：:]/.test(item.body)) checks.push({ level: 'blocker', message: '正文仍有“[待补充：…]”占位内容，请写成真实内容后再确认。' });
  if (item.body.length > 0 && item.body.length < 80) checks.push({ level: 'warning', message: '正文较短，请确认是否讲清问题、步骤和适用范围。' });
  if (/(100[%％]|保证|稳赚|全网第一|永久免费|完全免费|零风险)/.test(`${item.title}\n${item.body}`)) {
    checks.push({ level: 'warning', message: '发现可能夸大或需证据支持的用语，请逐一核实。这不是平台完整合规检测。' });
  }
  if (!item.sourceIds.length) checks.push({ level: 'warning', message: '没有关联参考资料，请自行核实事实依据。' });
  const builtin = item.sourceIds.some(sourceId => state.sources.find(source => source.id === sourceId)?.kind === 'builtin');
  if (builtin) checks.push({ level: 'warning', message: '引用了内置演示资料，不是外部权威证据；正式发布前请替换或自行验证。' });
  if (!checks.some(check => check.level === 'blocker')) checks.push({ level: 'pass', message: '基础完整性检查通过；不代表事实、版权或平台审核通过。' });
  for (const caution of item.ai?.cautions ?? []) checks.push({ level: 'warning', message: caution });
  const bodyPoints = Array.from(item.body).length;
  if (item.ai) {
    if (bodyPoints < 300) {
      checks.push({ level: 'warning', message: `当前 AI 草稿正文为 ${bodyPoints} 个字符（按码点计），严重短于本次起草目标 400—650 字，缺少充分的步骤展开，请人工补充。` });
    } else if (bodyPoints < 400) {
      checks.push({ level: 'warning', message: `当前 AI 草稿正文为 ${bodyPoints} 个字符（按码点计），略低于本次起草目标 400—650 字，建议补充具体操作细节或使用注意。` });
    } else if (bodyPoints > 650) {
      checks.push({ level: 'warning', message: `当前 AI 草稿正文为 ${bodyPoints} 个字符（按码点计），超出本次起草目标 400—650 字，建议精简冗余表述。` });
    }
  }
  checks.push({ level: 'warning', message: '本次检查只运行本地文字规则，未调用 AI 核查，也未联网核查；请人工核实内容并按平台要求标注 AI 使用情况。' });
  item.review = { revision: item.revision, checks, createdAt: now() };
  item.status = 'reviewed';
  event(state, 'review', `「${item.title}」完成本地规则检查：${checks.filter(check => check.level === 'blocker').length} 个待修复项。`);
}

function editProfile(state, body) {
  const limits = { name: 80, audience: 300, positioning: 600, platform: 100, tone: 300, goal: 600 };
  for (const [key, max] of Object.entries(limits)) {
    if (own(body, key)) state.profile[key] = text(body[key], '账号资料', max);
  }
  if (own(body, 'weeklyHours')) state.profile.weeklyHours = integer(body.weeklyHours, '每周投入小时数', 1, 40);
  event(state, 'profile', '账号定位已更新。已有草稿不会被覆盖。');
}

export function mutate(original, method, path, body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('请求内容必须是一个对象。');
  const state = structuredClone(original);
  if (method === 'POST' && path === '/api/profile') editProfile(state, body);
  else if (method === 'POST' && path === '/api/plan') plan(state, body);
  else if (method === 'POST' && path === '/api/sources') {
    if (state.sources.length >= 100) fail('最多保留 100 份参考资料。');
    const source = { id: id(), title: text(body.title, '资料标题', 200), content: text(body.content, '资料正文', 20000), url: webUrl(body.url ?? ''), kind: 'user', createdAt: now() };
    state.sources.push(source);
    event(state, 'source', `已保存资料「${source.title}」。链接仅作来源记录，不会自动抓取。`);
  } else {
    const sourceMatch = path.match(/^\/api\/sources\/([^/]+)$/);
    const itemMatch = path.match(/^\/api\/items\/([^/]+)(?:\/(draft|review|approve|publish|metrics))?$/);
    if (method === 'DELETE' && sourceMatch) {
      const source = state.sources.find(entry => entry.id === sourceMatch[1]);
      if (!source) fail('资料不存在。', 404);
      if (state.items.some(item => item.sourceIds.includes(source.id))) fail('该资料已被内容引用，不能删除。');
      state.sources = state.sources.filter(entry => entry.id !== source.id);
      event(state, 'source', `已删除资料「${source.title}」。`);
    } else if (itemMatch) {
      const item = state.items.find(entry => entry.id === itemMatch[1]);
      if (!item) fail('内容不存在。', 404);
      const action = itemMatch[2];
      if (method === 'PATCH' && !action) {
        if (item.status === 'published') fail('已发布内容不能编辑，请保留发布时版本。');
        if (!own(body, 'title') && !own(body, 'body')) fail('没有提交需要修改的内容。');
        // 多页面同时编辑时，用页面看到的修订号做乐观并发校验，避免后保存者静默覆盖别人。
        if (own(body, 'expectedRevision')) {
          if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) fail('版本号无效。');
          if (body.expectedRevision !== item.revision) {
            fail(`这条内容已在其他页面被修改（服务器当前为第 ${item.revision} 版）。本次保存未生效，请刷新查看最新版本后合并你的修改，避免覆盖。`, 409);
          }
        }
        if (own(body, 'title')) item.title = text(body.title, '标题', 200);
        if (own(body, 'body')) item.body = text(body.body, '正文', 20000, false);
        item.revision += 1;
        item.review = null;
        item.status = 'draft';
        event(state, 'edit', `「${item.title}」保存为第 ${item.revision} 版，需重新检查与确认。`);
      } else if (method === 'POST' && action === 'draft') draft(state, item);
      else if (method === 'POST' && action === 'review') review(state, item);
      else if (method === 'POST' && action === 'approve') {
        if (item.status !== 'reviewed' || item.review?.revision !== item.revision) fail('请先对当前版本运行内容检查。');
        if (item.review.checks.some(check => check.level === 'blocker')) fail('请先修复检查中的待修复项，再重新检查。');
        item.status = 'approved';
        event(state, 'approve', `用户已人工确认「${item.title}」第 ${item.revision} 版，尚未发布到平台。`);
      } else if (method === 'POST' && action === 'publish') {
        if (item.status !== 'approved') fail('请先完成检查并人工确认当前版本。');
        item.publishedUrl = webUrl(body.url, true);
        item.publishedAt = now();
        item.status = 'published';
        event(state, 'publish', `已登记「${item.title}」的人工发布链接；系统没有向平台发送内容，也未验证链接内容。`);
      } else if (method === 'POST' && action === 'metrics') {
        if (item.status !== 'published') fail('请先登记发布，再录入表现数据。');
        item.metrics = {
          views: integer(body.views, '浏览量', 0, 1_000_000_000),
          likes: integer(body.likes, '点赞数', 0, 1_000_000_000),
          comments: integer(body.comments, '评论数', 0, 1_000_000_000),
          saves: integer(body.saves, '收藏数', 0, 1_000_000_000), recordedAt: now(),
        };
        event(state, 'metrics', `已保存「${item.title}」的手动录入数据（累计快照，覆盖上一次数值，不重复累加）。`);
      } else fail('没有这个操作。', 404);
      item.updatedAt = now();
    } else fail('没有这个接口。', 404);
  }
  return state;
}

export function report(state) {
  const published = state.items.filter(item => item.status === 'published');
  const rows = published.filter(item => item.metrics).map(item => {
    const { views, likes, comments, saves } = item.metrics;
    const interactions = likes + comments + saves;
    return { id: item.id, title: item.title, views, likes, comments, saves, interactions, rate: views > 0 ? interactions / views : null };
  });
  const totals = rows.reduce((sum, row) => {
    for (const key of ['views', 'likes', 'comments', 'saves']) sum[key] += row[key];
    return sum;
  }, { views: 0, likes: 0, comments: 0, saves: 0 });
  const bestRow = rows.filter(row => row.views > 0).sort((a, b) => b.rate - a.rate || b.views - a.views)[0];
  const recommendations = [];
  if (!rows.length) recommendations.push('尚未录入已发布内容的数据。先手动发布并登记，再录入同一观察周期的数据；不要用虚构数字代替真实实验。');
  else {
    if (rows.length < 5) recommendations.push(`目前只有 ${rows.length} 条内容数据，样本不足，不能据此断言某种选题更有效。`);
    if (bestRow) recommendations.push(`在已录入内容中，「${bestRow.title}」的互动次数/浏览量比率最高。建议检查它的选题与表达差异，再用新内容验证，不能推断因果。`);
    if (rows.some(row => row.views === 0 && row.interactions > 0)) recommendations.push('存在浏览量为 0、互动量却大于 0 的记录，请检查统计口径或录入数值；这类记录不计算互动率。');
    if (rows.some(row => row.rate > 1)) recommendations.push('部分互动率超过 100%。同一人可多次互动，此指标不是独立用户占比；也请检查录入口径。');
    if (!bestRow) recommendations.push('当前浏览量均为 0，无法计算互动率，请等待有效数据。');
  }
  recommendations.push('请比较发布后相同时间长度的数据。这里是本地统计与规则提示，不是 AI 分析；不代表平台实时数据，也不能保证涨粉。');
  return {
    publishedCount: published.length, measuredCount: rows.length, totals,
    interactionRate: totals.views > 0 ? (totals.likes + totals.comments + totals.saves) / totals.views : null,
    best: bestRow ? { id: bestRow.id, title: bestRow.title, views: bestRow.views, interactions: bestRow.interactions, rate: bestRow.rate } : null,
    recommendations, rows,
  };
}
