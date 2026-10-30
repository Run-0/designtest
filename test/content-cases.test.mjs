import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 只读合成夹具，不导入生产模块、不调用模型、不读取用户资料或凭据。
// judgment描述未来评分方式；这里绝不执行质量评分或填充observed。
const suite = JSON.parse(await readFile(new URL('./fixtures/content-cases.json', import.meta.url), 'utf8'));
const categories = [
  'sufficient_materials',
  'irrelevant_materials',
  'missing_materials',
  'conflicting_materials',
  'late_evidence',
  'instruction_injection',
  'builtin_demo',
  'length_and_citations',
];
const outcomes = ['draft', 'needs_materials', 'needs_clarification'];
const rubricTextFields = [
  'scope', 'provenance', 'safeCompletion', 'evidenceMatching', 'factualClaims',
  'citationSupport', 'expectationMatching', 'scoring', 'criticalGate',
  'zeroDenominator', 'evaluationBoundary', 'recording',
];

function assertFields(value, fields, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label}应为对象`);
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), `${label}字段不符合夹具schema`);
}

function assertText(value, label) {
  assert.equal(typeof value, 'string', `${label}应为字符串`);
  assert.ok(value.trim().length > 0, `${label}不能为空`);
}

function assertId(value, label) {
  assertText(value, label);
  assert.match(value, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `${label}应为可复用的稳定ID`);
}

function assertList(value, label, allowEmpty = false) {
  assert.ok(Array.isArray(value), `${label}应为数组`);
  if (!allowEmpty) assert.ok(value.length > 0, `${label}不能为空`);
}

function assertTextList(value, label) {
  assertList(value, label);
  value.forEach((entry, index) => assertText(entry, `${label}[${index}]`));
}

function assertUniqueIds(entries, label) {
  const ids = entries.map(entry => entry.id);
  ids.forEach(id => assertId(id, label));
  assert.equal(new Set(ids).size, ids.length, `${label}不能重复`);
}

function* stringsIn(value, path = 'suite') {
  if (typeof value === 'string') {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) yield* stringsIn(entry, `${path}[${index}]`);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) yield* stringsIn(entry, `${path}.${key}`);
  }
}

function assertSyntheticUrl(value, label) {
  // 只允许保留示例域名及简单路径，不允许账号、端口、参数、片段或其他主机。
  assert.ok(/^https:\/\/example\.com\/[a-z0-9/_-]*$/.test(value), `${label}必须是虚构占位URL`);
  const url = new URL(value);
  assert.equal(url.origin, 'https://example.com', `${label}不得使用生产来源`);
  assert.equal(url.username + url.password + url.search + url.hash, '', `${label}不得携带凭据或参数`);
}

test('离线夹具：全局schema、开发集标识和评分约定结构完整', () => {
  assertFields(suite, ['schemaVersion', 'suiteId', 'split', 'description', 'rubric', 'cases'], 'suite');
  assert.equal(suite.schemaVersion, 1);
  assertId(suite.suiteId, 'suiteId');
  assert.equal(suite.split, 'development');
  assertText(suite.description, 'description');
  assertList(suite.cases, 'cases');
  assertFields(suite.rubric, [...rubricTextFields, 'outcomes', 'lengthConvention', 'metrics'], 'rubric');
  rubricTextFields.forEach(field => assertText(suite.rubric[field], `rubric.${field}`));
  assertFields(suite.rubric.outcomes, outcomes, 'rubric.outcomes');
  outcomes.forEach(outcome => assertText(suite.rubric.outcomes[outcome], outcome));

  const length = suite.rubric.lengthConvention;
  assertFields(length, [
    'unit', 'trimOuterWhitespace', 'includePunctuation', 'includeInnerWhitespace',
    'bodyMin', 'bodyMax', 'titleMax', 'scope', 'note',
  ], 'lengthConvention');
  assert.equal(length.unit, 'Unicode code points');
  for (const field of ['trimOuterWhitespace', 'includePunctuation', 'includeInnerWhitespace']) {
    assert.equal(length[field], true, `lengthConvention.${field}`);
  }
  for (const field of ['bodyMin', 'bodyMax', 'titleMax']) {
    assert.ok(Number.isSafeInteger(length[field]) && length[field] > 0, field);
  }
  assert.ok(length.bodyMin <= length.bodyMax);
  assertText(length.scope, 'lengthConvention.scope');
  assertText(length.note, 'lengthConvention.note');
  assertList(suite.rubric.metrics, 'rubric.metrics');
  const metricIds = new Set();
  for (const metric of suite.rubric.metrics) {
    assertFields(metric, ['id', 'description', 'numerator', 'denominator'], 'metric');
    for (const field of Object.keys(metric)) assertText(metric[field], `metric.${field}`);
    assert.ok(!metricIds.has(metric.id), '指标ID不能重复');
    metricIds.add(metric.id);
  }
});

test('离线夹具：每例输入、期望、证据和非空criteria符合schema', () => {
  for (const entry of suite.cases) {
    assertFields(entry, ['id', 'title', 'category', 'provenance', 'input', 'expected', 'evaluation'], 'case');
    assertId(entry.id, 'case.id');
    assertText(entry.title, `${entry.id}.title`);
    assert.ok(categories.includes(entry.category), `${entry.id}分类无效`);
    assert.equal(entry.provenance, 'synthetic', `${entry.id}必须标注合成来源`);
    assertFields(entry.input, ['profile', 'task', 'sources'], `${entry.id}.input`);
    assertFields(entry.input.profile, ['audience', 'positioning', 'tone'], `${entry.id}.profile`);
    for (const field of ['audience', 'positioning', 'tone']) assertText(entry.input.profile[field], field);
    assertFields(entry.input.task, ['title', 'angle'], `${entry.id}.task`);
    assertText(entry.input.task.title, 'task.title');
    assertText(entry.input.task.angle, 'task.angle');
    assertList(entry.input.sources, 'sources', true);
    for (const source of entry.input.sources) {
      assertFields(source, ['id', 'title', 'content', 'url', 'kind'], `${entry.id}.source`);
      assertId(source.id, 'source.id');
      assertText(source.title, 'source.title');
      assertText(source.content, 'source.content');
      assert.equal(typeof source.url, 'string');
      assert.ok(['user', 'builtin'].includes(source.kind));
    }

    const expected = entry.expected;
    assertFields(expected, ['outcome', 'requiredEvidence', 'mustInclude', 'mustNotClaim', 'criteria'], `${entry.id}.expected`);
    assert.ok(outcomes.includes(expected.outcome));
    assertList(expected.requiredEvidence, 'requiredEvidence', true);
    for (const evidence of expected.requiredEvidence) {
      assertFields(evidence, ['sourceId', 'quote'], `${entry.id}.evidence`);
      assertId(evidence.sourceId, 'evidence.sourceId');
      assertText(evidence.quote, 'evidence.quote');
    }
    assertTextList(expected.mustInclude, 'mustInclude');
    assertTextList(expected.mustNotClaim, 'mustNotClaim');
    assertList(expected.criteria, `${entry.id}.criteria`);
    for (const criterion of expected.criteria) {
      assertFields(criterion, ['id', 'description', 'passCondition', 'critical', 'judgment'], `${entry.id}.criterion`);
      assertId(criterion.id, 'criterion.id');
      assertText(criterion.description, 'criterion.description');
      assertText(criterion.passCondition, 'criterion.passCondition');
      assert.equal(typeof criterion.critical, 'boolean');
      assert.ok(['manual', 'automatic'].includes(criterion.judgment));
    }
    assertFields(entry.evaluation, ['status', 'observed'], `${entry.id}.evaluation`);
  }
});

test('离线夹具：任务、资料和标准的定义ID全局唯一', () => {
  const definitions = [
    { id: suite.suiteId },
    ...suite.cases,
    ...suite.cases.flatMap(entry => entry.input.sources),
    ...suite.cases.flatMap(entry => entry.expected.criteria),
  ];
  assertUniqueIds(definitions, '定义ID');
});

test('离线夹具：恰好覆盖8类，空资料、冲突及内置渠道形态正确', () => {
  assert.equal(suite.cases.length, 8);
  assert.deepEqual(suite.cases.map(entry => entry.category).sort(), [...categories].sort());
  const byCategory = new Map(suite.cases.map(entry => [entry.category, entry]));
  assert.equal(byCategory.get('missing_materials').input.sources.length, 0);
  assert.equal(byCategory.get('missing_materials').expected.requiredEvidence.length, 0);
  assert.equal(byCategory.get('conflicting_materials').input.sources.length, 2);
  assert.ok(byCategory.get('sufficient_materials').input.sources.length >= 2);
  for (const entry of suite.cases.filter(entry => entry.category !== 'missing_materials')) {
    assertList(entry.input.sources, `${entry.id}.sources`);
    assertList(entry.expected.requiredEvidence, `${entry.id}.requiredEvidence`);
    const kind = entry.category === 'builtin_demo' ? 'builtin' : 'user';
    assert.ok(entry.input.sources.every(source => source.kind === kind), `${entry.id}资料渠道不符合场景`);
  }
});

test('离线夹具：所有证据引用同例真实存在的资料，quote为原文子串', () => {
  for (const entry of suite.cases) {
    const sources = new Map(entry.input.sources.map(source => [source.id, source]));
    for (const evidence of entry.expected.requiredEvidence) {
      assert.ok(sources.has(evidence.sourceId), `${entry.id}证据不得引用别例或不存在的资料`);
      assert.ok(sources.get(evidence.sourceId).content.includes(evidence.quote), `${entry.id}证据quote必须真实包含在原文中`);
    }
  }
});

test('离线夹具：长文关键证据首次出现位置严格在650码点之后', () => {
  const entry = suite.cases.find(item => item.category === 'late_evidence');
  assert.ok(entry);
  assertList(entry.expected.requiredEvidence, '长文关键证据');
  for (const evidence of entry.expected.requiredEvidence) {
    const source = entry.input.sources.find(item => item.id === evidence.sourceId);
    assert.ok(source);
    const index = source.content.indexOf(evidence.quote);
    assert.ok(index >= 0, '关键证据应存在');
    const offset = Array.from(source.content.slice(0, index)).length;
    assert.ok(offset > 650, `关键证据起点为${offset}码点，必须晚于650`);
    assert.ok(Array.from(source.content).length > 650);
    assert.ok(source.content.trimEnd().endsWith(evidence.quote), '关键证据应位于长文末尾');
  }
});

test('离线夹具：全部evaluation保持未运行，没有伪造observed', () => {
  for (const entry of suite.cases) {
    assert.equal(entry.evaluation.status, 'not_run', `${entry.id}未执行真实评测`);
    assert.equal(entry.evaluation.observed, null, `${entry.id}不得填入模拟成绩`);
  }
});

test('离线夹具：仅允许虚构占位网址，不含常见凭据形态', () => {
  for (const entry of suite.cases) {
    for (const source of entry.input.sources) {
      if (source.url !== '') assertSyntheticUrl(source.url, source.id);
    }
  }
  // 这些规则仅防止常见秘密被误放，不是完整安全审计；没有读取本机秘密来作比较。
  const secretPatterns = [
    /\b(?:sk|rk)-[a-z0-9_-]{16,}/i,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\b(?:gh[pousr]_|github_pat_)[a-z0-9_]{20,}/i,
    /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    /\bBearer\s+[a-z0-9._~+/-]{12,}/i,
    /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/i,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|secret)\b\s*[:=]\s*["']?[a-z0-9/+_.=-]{8,}/i,
    /(?:密钥|密码|令牌)\s*[:：=]\s*["']?[a-z0-9/+_.=-]{8,}/i,
  ];
  for (const [path, value] of stringsIn(suite)) {
    // 包括资料正文中的不可信指令以及评分文字，不能只检查source.url。
    const urls = value.match(/(?:[a-z][a-z\d+.-]*:\/\/|www\.)[a-z\d._~:/?#[\]@!$&'()*+,;=%-]*/gi) ?? [];
    urls.forEach(url => assertSyntheticUrl(url, path));
    const hosts = value.match(/\b(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|app|ai|edu|gov)\b/gi) ?? [];
    for (const host of hosts) assert.equal(host, 'example.com', `${path}不得含生产域名`);
    for (const pattern of secretPatterns) {
      assert.ok(!pattern.test(value), `${path}发现疑似凭据，请移除；不回显内容`);
    }
  }
});
