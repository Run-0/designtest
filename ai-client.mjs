import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { InputError } from './domain.mjs';

const API = 'https://api.deepseek.com';
const MODEL = 'deepseek-flash';
const RESERVE_CENTS = 5;

export const PROVIDERS = {
  DeepSeek: {
    name: 'DeepSeek',
    defaultModel: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    probePath: '/models',
    keyLink: 'https://platform.deepseek.com/api_keys',
  },
  OpenAI: {
    name: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    probePath: '/models',
    keyLink: 'https://platform.openai.com/api-keys',
  },
  Gemini: {
    name: 'Google Gemini',
    defaultModel: 'gemini-1.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    probePath: '/models',
    keyLink: 'https://aistudio.google.com/app/apikey',
  },
  Custom: {
    name: '自定义 OpenAI 兼容接口',
    defaultModel: 'default',
    baseUrl: '',
    probePath: '/models',
    keyLink: '',
  },
};
// 新账本默认 ¥1；已有账本以自己的 limitCents 为准。扩大额度只能通过离线脚本
// evaluation/extend-budget.mjs 显式修改，服务端没有修改预算的接口。
const LIMIT_CENTS = 100;
const MAX_LIMIT_CENTS = 1000;
const MAX_OUTPUT_TOKENS = 1600;
const MAX_REQUEST_BYTES = 12000;
// 2026-10-30 复核官方定价：deepseek-flash 峰值 2/0.04/8 元每百万 token（未命中输入/命中输入/输出），
// 空闲为一半。按 <=12000 请求字节、<=1600 输出 token 保守预留每次 ¥0.05，且不使用收费服务端工具。
export const PRICE_CHECKED_UNTIL = Date.parse('2026-11-06T00:00:00+08:00');

// Only describes local guards. This function never probes the provider or grants new budget.
export function describeAiAvailability({ configured, budget, paused = false, locked = false, now = Date.now() }) {
  const checkedAt = Number.isFinite(now) ? new Date(now).toISOString() : null;
  let code = 'ready';
  let message = '本机保护允许尝试 AI 起草；未实时验证远端网络、密钥或赠送余额，实际调用仍可能失败。';
  if (budget === null) {
    code = 'budget_unreadable';
    message = '无法读取可靠的测试预算，AI 已暂停。请人工核对账本，不要清零或删除；已有草稿仍可查看和编辑。';
  } else if (!configured) {
    code = 'not_configured';
    message = '尚未配置可用的本机专用凭据。请在连接页完成只读验证；模板与已有草稿仍可使用。';
  } else if (paused) {
    code = 'usage_paused';
    message = '用量异常保护已暂停 AI，请人工核对预算记录。刷新不会解除保护，已有草稿不受影响。';
  } else if (locked) {
    // 请求进行中时，更具体的原因是“正在执行”而不是价格到期；两者都阻止调用。
    code = 'request_locked';
    message = '模型请求正在执行，或上次退出遗留了保护锁。请稍后刷新；若持续锁定，先核对进程，不能直接删锁。';
  } else if (!Number.isFinite(now) || now >= PRICE_CHECKED_UNTIL) {
    code = 'price_expired';
    message = '价格核验窗口已到期或时钟不可读，AI 测试已暂停。请重新核对官方价格与授权；不要删除保护，已有草稿仍可编辑。';
  } else if (budget.remainingCny <= 0) {
    code = 'budget_exhausted';
    message = '本次累计测试额度已用完，不能继续调用。系统不会自动充值或重置额度；已有草稿仍可编辑。';
  } else if (Math.round(budget.remainingCny * 100) < RESERVE_CENTS * 2) {
    code = 'budget_insufficient';
    message = '剩余测试额度不足整轮起草所需的 ¥0.10 保守预留，已暂停起草；这不是实际账单，也不会自动充值。';
  }
  return { code, canGenerateDraft: code === 'ready', message, checkedAt,
    priceCheckedUntil: new Date(PRICE_CHECKED_UNTIL).toISOString(), remoteChecked: false };
}

function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
}
function dpapi(value, decrypt = false) {
  if (process.platform !== 'win32') throw new InputError('当前凭据保护仅支持 Windows，请勿改为明文存储。');
  const command = decrypt
    ? "$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd());[System.Net.NetworkCredential]::new('', $s).Password"
    : "$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force;$s|ConvertFrom-SecureString";
  const env = { ...process.env };
  delete env.PSModulePath;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: value, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env,
  });
  if (result.status !== 0 || !result.stdout?.trim()) throw new InputError('Windows 本机密钥保护失败；没有改用明文。');
  return result.stdout.trim();
}

export function createAiClient({ directory, fetchImpl = fetch, protect = value => dpapi(value), unprotect = value => dpapi(value, true), clock = () => Date.now() }) {
  mkdirSync(directory, { recursive: true });
  const keyFile = join(directory, 'deepseek-key.dpapi.json');
  const budgetFile = join(directory, 'ai-budget.json');
  let configured = false;
  let lastVerifiedAt = null;
  let busy = false;
  let keyCache;
  let currentProvider = 'DeepSeek';
  let currentModel = MODEL;
  let currentBaseUrl = API;

  if (existsSync(keyFile)) {
    try {
      const saved = JSON.parse(readFileSync(keyFile, 'utf8'));
      if (typeof saved.encryptedKey !== 'string') throw new Error();
      configured = Boolean(saved.verifiedAt);
      lastVerifiedAt = saved.verifiedAt ?? null;
      if (saved.provider && Object.hasOwn(PROVIDERS, saved.provider)) currentProvider = saved.provider;
      if (typeof saved.model === 'string' && saved.model.trim()) currentModel = saved.model.trim();
      if (typeof saved.baseUrl === 'string' && saved.baseUrl.trim()) currentBaseUrl = saved.baseUrl.trim();
    } catch { throw new Error('本机加密凭据文件损坏，已停止加载；没有覆盖原文件。'); }
  }
  let ledger;
  if (existsSync(budgetFile)) {
    try { ledger = JSON.parse(readFileSync(budgetFile, 'utf8')); } catch { throw new Error('测试预算记录损坏，拒绝重置，以免重复花费。'); }
    if (!Number.isInteger(ledger.limitCents) || ledger.limitCents < RESERVE_CENTS || ledger.limitCents > MAX_LIMIT_CENTS ||
        !Number.isInteger(ledger.reservedCents) || ledger.reservedCents < 0 || ledger.reservedCents > ledger.limitCents ||
        !Array.isArray(ledger.calls) || ledger.calls.length * RESERVE_CENTS !== ledger.reservedCents) throw new Error('测试预算记录不一致，已暂停模型调用。');
  } else {
    if (existsSync(keyFile)) throw new Error('已有凭据但预算记录缺失，拒绝自动重置额度。');
    ledger = { limitCents: LIMIT_CENTS, reservedCents: 0, calls: [] };
    atomic(budgetFile, ledger);
  }
  const saveLedger = () => atomic(budgetFile, ledger);
  const lockFile = join(directory, 'ai-request.lock');
  function refreshLedger() {
    let latest;
    try { latest = JSON.parse(readFileSync(budgetFile, 'utf8')); } catch { throw new InputError('预算记录无法读取，模型调用已暂停。'); }
    if (!latest || !Number.isInteger(latest.limitCents) || latest.limitCents < RESERVE_CENTS || latest.limitCents > MAX_LIMIT_CENTS ||
        !Number.isInteger(latest.reservedCents) || latest.reservedCents < 0 || latest.reservedCents > latest.limitCents ||
        !Array.isArray(latest.calls) || latest.calls.length * RESERVE_CENTS !== latest.reservedCents) throw new InputError('预算记录不一致，模型调用已暂停。');
    ledger = latest;
  }
  const key = () => {
    if (!existsSync(keyFile)) throw new InputError('请先在本机连接页保存专用 API 密钥。');
    if (!keyCache) keyCache = unprotect(JSON.parse(readFileSync(keyFile, 'utf8')).encryptedKey);
    return keyCache;
  };
  function status() {
    let budget = null;
    try {
      refreshLedger();
      budget = { limitCny: ledger.limitCents / 100, reservedCny: ledger.reservedCents / 100, remainingCny: (ledger.limitCents - ledger.reservedCents) / 100, attempts: ledger.calls.length };
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      // Do not show stale/zero credit when the ledger cannot be verified. Never repair it on GET.
    }
    const hasConfiguration = configured && existsSync(keyFile);
    return {
      configured: hasConfiguration, provider: currentProvider, model: currentModel, baseUrl: currentBaseUrl, lastVerifiedAt, budget,
      availability: describeAiAvailability({ configured: hasConfiguration, budget,
        paused: Boolean(ledger.paused), locked: busy || existsSync(lockFile), now: clock() }),
    };
  }
  async function readOnly(path, apiKey = key(), baseUrl = currentBaseUrl) {
    const target = `${baseUrl.replace(/\/+$/, '')}${path}`;
    const response = await fetchImpl(target, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new InputError(response.status === 401 ? '密钥验证失败，请检查是否复制完整。' : `模型服务只读验证失败（HTTP ${response.status}），未发起付费生成。`);
    return response.json();
  }
  function giftBalance(balance) {
    const cny = Array.isArray(balance?.balance_infos) ? balance.balance_infos.find(entry => entry?.currency === 'CNY') : null;
    const amount = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const granted = amount(cny?.granted_balance);
    const topped = amount(cny?.topped_up_balance);
    if (balance?.is_available !== true || !cny || !Number.isFinite(granted) || !Number.isFinite(topped)) throw new InputError('无法确认可用赠送余额，已暂停模型生成。');
    if (topped !== 0) throw new InputError('本次仅授权使用赠送余额；检测到充值余额后暂停，请重新确认资金边界。');
    if (granted < RESERVE_CENTS / 100) throw new InputError('可用赠送余额不足单次保守预算，已停止，不会充值。');
    return { grantedCny: granted, toppedUpCny: topped };
  }
  async function installKey(value, options = {}) {
    let provider = 'DeepSeek';
    let apiKey = '';
    let model = '';
    let baseUrl = '';
    let overwrite = Boolean(options?.overwrite);

    if (typeof value === 'string') {
      apiKey = value.trim();
    } else if (value && typeof value === 'object') {
      provider = typeof value.provider === 'string' && Object.hasOwn(PROVIDERS, value.provider) ? value.provider : 'DeepSeek';
      apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
      model = typeof value.model === 'string' ? value.model.trim() : '';
      baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
      if (value.overwrite) overwrite = true;
    }

    const isDeepSeek = provider === 'DeepSeek';
    const keyPattern = isDeepSeek || provider === 'OpenAI'
      ? /^sk-[a-zA-Z0-9_-]{20,240}$/
      : /^[a-zA-Z0-9_-]{10,240}$/;

    if (!apiKey || !keyPattern.test(apiKey)) {
      throw new InputError(isDeepSeek ? '请输入完整的 DeepSeek API 密钥。' : '请输入完整的 API 密钥。');
    }

    if (existsSync(keyFile) && !overwrite) {
      throw new InputError('本机已有专用凭据，为避免覆盖，未重复保存。');
    }

    const conf = PROVIDERS[provider] || PROVIDERS.DeepSeek;
    if (!model) model = conf.defaultModel;
    if (!baseUrl) baseUrl = conf.baseUrl;

    let verifiedBalance = null;
    let observedModelIds = [];

    if (provider === 'DeepSeek') {
      const balance = await readOnly('/user/balance', apiKey, baseUrl);
      const models = await readOnly('/models', apiKey, baseUrl);
      verifiedBalance = giftBalance(balance);
      if (!Array.isArray(models?.data) || !models.data.some(entry => entry.id === model)) {
        throw new InputError(`当前账号可用模型列表中没有已配置型号（${model}），未保存密钥。`);
      }
      observedModelIds = models.data.map(entry => entry.id).filter(entry => typeof entry === 'string');
    } else {
      const probeRes = await readOnly(conf.probePath, apiKey, baseUrl);
      if (Array.isArray(probeRes?.data)) {
        observedModelIds = probeRes.data.map(entry => entry.id).filter(entry => typeof entry === 'string');
      }
    }

    const encryptedKey = protect(apiKey);
    lastVerifiedAt = new Date(clock()).toISOString();
    currentProvider = provider;
    currentModel = model;
    currentBaseUrl = baseUrl;
    atomic(keyFile, { provider, model, baseUrl, encryptedKey, verifiedAt: lastVerifiedAt });
    keyCache = apiKey;
    configured = true;
    return { ...status(), verifiedBalance, observedModelIds };
  }
  async function chat(messages, options = {}) {
    if (!configured) throw new InputError('请先连接并验证模型密钥。');
    refreshLedger();
    if (ledger.paused) throw new InputError('用量异常保护已暂停后续调用，请人工核对预算记录。');
    if (busy) throw new InputError('另一个模型请求正在执行，请稍后再试。', 409);
    const requestTime = clock();
    if (!Number.isFinite(requestTime) || requestTime >= PRICE_CHECKED_UNTIL) throw new InputError('价格核验窗口已过期或时钟不可读，模型测试已暂停。请重新核对官方价格和预算后再开启。');
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(name => !['tools', 'tool_choice', 'response_format'].includes(name))) throw new InputError('模型请求超出已授权参数范围。');

    const activeModel = currentModel || MODEL;
    const isDeepSeek = currentProvider === 'DeepSeek';
    const payload = {
      model: activeModel,
      messages,
      stream: false,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...options,
    };
    if (isDeepSeek) {
      payload.thinking = { type: 'disabled' };
    }

    if (payload.model !== activeModel || payload.stream !== false || payload.max_tokens !== MAX_OUTPUT_TOKENS || (isDeepSeek && payload.thinking?.type !== 'disabled')) {
      throw new InputError('模型请求超出已授权参数范围。');
    }
    if (payload.tools && (!Array.isArray(payload.tools) || payload.tools.length !== 1 || payload.tools[0]?.type !== 'function' || payload.tools[0]?.function?.name !== 'read_materials')) throw new InputError('不允许调用未授权工具。');
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) throw new InputError('本次资料过长，超过测试费用保护上限。请缩短资料后重试。');
    if (ledger.reservedCents + RESERVE_CENTS > ledger.limitCents) throw new InputError(`已达到本次 ¥${(ledger.limitCents / 100).toFixed(2)} 测试额度上限，系统不会继续调用或自动充值。`);
    busy = true;
    let record;
    let lockHandle;
    try {
      try { lockHandle = openSync(lockFile, 'wx', 0o600); }
      catch (error) {
        if (error.code === 'EEXIST') throw new InputError('另一个本机实例正在调用模型，或上次退出遗留了保护锁。未继续花费，请稍后或人工检查。', 409);
        throw error;
      }
      refreshLedger();
      if (ledger.paused || ledger.reservedCents + RESERVE_CENTS > ledger.limitCents) throw new InputError('已达到测试额度上限或触发用量保护，不能继续调用。');
      if (isDeepSeek) {
        giftBalance(await readOnly('/user/balance'));
      }
      record = { id: randomUUID(), createdAt: new Date(clock()).toISOString(), reservedCny: 0.05, status: 'pending', model: activeModel, provider: currentProvider };
      ledger.reservedCents += RESERVE_CENTS;
      ledger.calls.push(record);
      // Persist reservation BEFORE requesting inference; errors/timeouts never restore it automatically.
      saveLedger();
      const endpoint = `${currentBaseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
        body: serialized, signal: AbortSignal.timeout(65000), redirect: 'error',
      });
      if (!response.ok) throw new InputError(`模型生成未成功（HTTP ${response.status}）。没有自动重试，也没有替换成模板。`);
      const result = await response.json();
      const choice = result?.choices?.[0];
      record.responseShape = {
        finishReason: choice?.finish_reason ?? null,
        messageFields: Object.keys(choice?.message ?? {}).filter(field => field !== 'reasoning_content'),
        toolCalls: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls.map(call => ({ type: call.type, name: call.function?.name, hasId: typeof call.id === 'string' })) : null,
        contentPreview: typeof choice?.message?.content === 'string' ? choice.message.content.slice(0, 300) : null,
      };
      if (!choice?.message || !['stop', 'tool_calls'].includes(choice.finish_reason)) throw new InputError('模型返回内容不完整或被截断，未保存为草稿。');
      const usage = result.usage;
      if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens) || usage.prompt_tokens < 0 || usage.completion_tokens < 0) throw new InputError('模型没有返回可核对的用量信息，未保存生成结果。');
      record.usage = { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens };
      // Upper estimate, not an invoice: assume all input misses cache and use peak prices.
      record.estimatedUpperCny = (usage.prompt_tokens * 2 + usage.completion_tokens * 8) / 1_000_000;
      record.status = 'success';
      record.completedAt = new Date(clock()).toISOString();
      if (record.estimatedUpperCny > 0.05) ledger.paused = true;
      saveLedger();
      if (ledger.paused) throw new InputError('模型用量超出单次保守预估，已停止后续调用，需要人工核对。');
      return { message: choice.message, usage: record.usage, model: activeModel, provider: currentProvider, requestId: record.id };
    } catch (error) {
      if (record) { record.status = 'failed'; record.completedAt = new Date(clock()).toISOString(); saveLedger(); }
      if (error instanceof InputError) throw error;
      throw new InputError('模型请求超时或连接失败。已保留原稿，没有自动重试；该次预算预留不自动退回。');
    } finally {
      busy = false;
      if (lockHandle !== undefined) { closeSync(lockHandle); unlinkSync(lockFile); }
    }
  }
  return { status, installKey, chat };
}
