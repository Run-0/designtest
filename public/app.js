'use strict';

// Both pages share the same read-only status, freshness and price-window checks.
export class AiConnectionStatus {
  constructor(onChange) {
    this.onChange = onChange;
    this.data = null;
    this.loading = false;
    this.pending = null;
    this.error = 'AI 状态尚未确认，请刷新。';
    this.freshUntil = 0;
    this.priceUntil = 0;
    this.timer = null;
  }

  static labels = {
    ready: 'AI可尝试 · 未实时验证远端',
    not_configured: 'AI未配置',
    price_expired: 'AI暂停 · 价格核验已到期',
    budget_exhausted: 'AI暂停 · 测试额度已耗尽',
    budget_insufficient: 'AI暂停 · 额度不足一轮起草',
    usage_paused: 'AI暂停 · 用量保护',
    request_locked: 'AI暂停 · 请求锁定',
    budget_unreadable: 'AI暂停 · 预算不可读'
  };

  static timestamp(value) {
    return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  }

  static time(value) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(new Date(value));
  }

  view() {
    const data = this.data;
    const availability = data?.availability;
    const now = performance.now();
    const fresh = Boolean(data && !this.loading && now < this.freshUntil);
    const priceExpired = Boolean(data && now >= this.priceUntil);
    const canGenerateDraft = fresh && !priceExpired && data.configured === true && availability.canGenerateDraft === true;
    let label = availability ? AiConnectionStatus.labels[availability.code] : 'AI状态未知 · 已禁用';
    let reason = availability?.message || this.error;
    if (this.loading) {
      label = 'AI状态读取中 · 已禁用';
      reason = '正在只读检查本机保护状态，不调用外部模型。';
    } else if (availability?.code === 'ready' && priceExpired) {
      label = AiConnectionStatus.labels.price_expired;
      reason = '本次价格核验窗口已到期，已暂停起草；请刷新状态并核对价格。上次检查：' + availability.message;
    } else if (data && !fresh) {
      label = 'AI状态需刷新 · 已暂停起草';
      reason = '状态超过 30 秒或页面已离开，不能据此调用。上次检查：' + availability.message;
    }
    return {
      fresh, canGenerateDraft, label, reason,
      times: availability
        ? '本机检查：' + AiConnectionStatus.time(availability.checkedAt) + '；价格核验到期：' + AiConnectionStatus.time(availability.priceCheckedUntil) + '（北京时间 UTC+8）'
        : '价格核验到期时间暂不可读。',
      budget: data?.budget || null
    };
  }

  invalidate() {
    this.freshUntil = 0;
    window.clearTimeout(this.timer);
    this.onChange();
  }

  scheduleExpiry() {
    window.clearTimeout(this.timer);
    const now = performance.now();
    if (!this.data || now >= this.freshUntil) return;
    const deadline = this.priceUntil > now ? Math.min(this.priceUntil, this.freshUntil) : this.freshUntil;
    this.timer = window.setTimeout(() => {
      this.onChange();
      this.scheduleExpiry();
    }, Math.max(1, Math.ceil(deadline - now)));
  }

  refresh() {
    // All callers await the same GET; a concurrent refresh must never return old data.
    if (this.pending) return this.pending;
    this.loading = true;
    this.freshUntil = 0;
    window.clearTimeout(this.timer);
    this.onChange();
    const startedAt = performance.now();
    this.pending = (async () => {
      try {
        const response = await fetch('/api/connection/status', {
          credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) throw new Error('无法读取 AI 状态，请确认本机服务正常后刷新。');
        const data = await response.json();
        const availability = data?.availability;
        const budget = data?.budget;
        if (typeof data?.configured !== 'boolean' || data.provider !== 'DeepSeek' || data.model !== 'deepseek-flash'
          || (budget !== null && (!budget || !['limitCny', 'reservedCny', 'remainingCny', 'attempts'].every(key => typeof budget[key] === 'number' && Number.isFinite(budget[key]) && budget[key] >= 0)))
          || !availability || !Object.hasOwn(AiConnectionStatus.labels, availability.code)
          || typeof availability.message !== 'string' || !availability.message.trim()
          || availability.canGenerateDraft !== (availability.code === 'ready') || availability.remoteChecked !== false
          || !Number.isFinite(AiConnectionStatus.timestamp(availability.checkedAt))
          || !Number.isFinite(AiConnectionStatus.timestamp(availability.priceCheckedUntil))
          || (availability.code === 'ready' && (!data.configured || !budget))) {
          throw new Error('AI 状态格式不完整（需要 availability），请检查本地服务版本后刷新。');
        }
        this.data = data;
        // Use server-relative time and a monotonic clock, conservatively including GET latency.
        // Changing the user's wall clock cannot extend either deadline.
        this.freshUntil = startedAt + 30000;
        this.priceUntil = startedAt + Math.max(0, AiConnectionStatus.timestamp(availability.priceCheckedUntil) - AiConnectionStatus.timestamp(availability.checkedAt));
        this.error = '';
        return data;
      } catch (error) {
        this.data = null;
        this.error = error.name === 'TimeoutError' ? 'AI 状态读取超时，请刷新后再操作。'
          : error instanceof TypeError || error instanceof SyntaxError ? 'AI 状态读取失败，请确认本机服务正常后刷新。' : error.message;
        return null;
      } finally {
        this.loading = false;
        this.pending = null;
        this.onChange();
        this.scheduleExpiry();
      }
    })();
    return this.pending;
  }
}

(() => {
  // connect.js imports only the shared status reader; do not boot the workbench there.
  if (!document.querySelector('#main-content')) return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const pageNames = { overview: '工作台', planning: '选题策划', studio: '创作空间', publish: '待发布', sources: '知识库', report: '数据复盘' };
  const statusNames = { idea: '待起草', draft: '草稿', reviewed: '已检查', approved: '待发布', published: '已登记发布' };
  const PROVIDER_METAS = {
    DeepSeek: {
      name: 'DeepSeek',
      defaultModel: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      keyLink: 'https://platform.deepseek.com/api_keys',
    },
    OpenAI: {
      name: 'OpenAI',
      defaultModel: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      keyLink: 'https://platform.openai.com/api-keys',
    },
    Gemini: {
      name: 'Google Gemini',
      defaultModel: 'gemini-1.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      keyLink: 'https://aistudio.google.com/app/apikey',
    },
    Custom: {
      name: '自定义 OpenAI 兼容接口',
      defaultModel: 'default',
      baseUrl: '',
      keyLink: '',
    },
  };
  const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const formBaselines = new WeakMap();
  const aiConnection = new AiConnectionStatus(renderConnectionStatus);
  let state = null;
  let busy = false;
  let report = null;
  let reportLoading = false;
  let reportSequence = 0;
  let toastTimer;
  let stateChanged = false;
  const ui = {
    page: pageFromHash(), filter: 'all', selectedId: null, renderedId: null,
    editorBaseline: { title: '', body: '' }, editorRefresh: false,
    profileRefresh: true, metricsRefresh: true, metricsSelected: '', discardPublish: false
  };

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function button(text, className, action) {
    const result = el('button', className, text);
    result.type = 'button';
    if (action) result.addEventListener('click', action);
    return result;
  }

  function text(selector, value) {
    const node = $(selector);
    if (node) node.textContent = String(value ?? '');
  }

  function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(value) : '—';
  }

  function rate(value) {
    return typeof value === 'number' && Number.isFinite(value) ? number(value * 100) + '%' : '—';
  }

  function date(value) {
    if (!value) return '时间未记录';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '时间未记录' : dateFormat.format(parsed);
  }

  function newest(items, key = 'createdAt') {
    return [...items].sort((a, b) => (Date.parse(b[key]) || 0) - (Date.parse(a[key]) || 0));
  }

  function safeUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  function externalLink(value, label) {
    const url = safeUrl(value);
    if (!url) return el('span', 'muted', label ? label + '（网址不可用）' : '网址不可用');
    const link = el('a', '', label || url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    link.setAttribute('aria-label', (label || url) + '（在新标签页打开）');
    return link;
  }

  function statusPill(status) {
    const known = Object.hasOwn(statusNames, status) ? status : 'idea';
    return el('span', 'status-pill status-' + known, statusNames[known]);
  }

  function emptyState(title, description, iconName = 'file', actionLabel, action, compact = false) {
    const container = el('div', 'empty-state' + (compact ? ' compact' : ''));
    const image = el('span', 'empty-icon');
    image.append(icon(iconName));
    container.append(image, el('h3', '', title), el('p', '', description));
    if (actionLabel) container.append(button(actionLabel, 'btn btn-small btn-secondary', action));
    return container;
  }

  function statCard(label, value, foot, iconName, onClick) {
    const card = onClick ? button('', 'stat-card stat-card-clickable', onClick) : el('div', 'stat-card');
    if (onClick) card.setAttribute('title', `点击前往：${label}`);
    const labelRow = el('div', 'stat-label');
    const image = el('span', 'stat-icon');
    image.append(icon(iconName));
    labelRow.append(el('span', '', label), image);
    card.append(labelRow, el('strong', 'stat-value', value), el('p', 'stat-foot', foot));
    return card;
  }

  function showToast(message, isError = false) {
    window.clearTimeout(toastTimer);
    const toast = el('div', 'toast' + (isError ? ' toast-error' : ''));
    toast.append(icon(isError ? 'info' : 'check'), el('span', '', message));
    $('#toast-region').replaceChildren(toast);
    toastTimer = window.setTimeout(() => $('#toast-region').replaceChildren(), isError ? 9000 : 5000);
  }

  function setError(selector, message) {
    const target = typeof selector === 'string' ? $(selector) : selector;
    if (!target) return;
    target.textContent = message || '';
    target.hidden = !message;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const method = options.method || 'GET';
    const requestBody = options.body === undefined && ['POST', 'PATCH', 'DELETE'].includes(method) ? {} : options.body;
    const isAiDraft = method === 'POST' && /^\/api\/items\/[^/]+\/ai-draft$/.test(path);
    const timeout = window.setTimeout(() => controller.abort(), isAiDraft ? 150000 : 20000);
    try {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: requestBody === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody)
      });
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(method === 'GET' ? '本地服务没有返回有效数据，请确认正在通过 Node 服务访问页面。' : '服务返回格式异常，写入可能已完成。请先刷新确认，不要重复提交。');
      }
      if (!response.ok) {
        const failure = new Error(typeof data?.error === 'string' ? data.error : '操作未完成，请稍后重试。');
        if (typeof data?.code === 'string') failure.code = data.code;
        throw failure;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(method === 'GET' ? '读取本地数据超时，请确认服务正常后重试。' : '请求超时，写入可能已完成。请先刷新页面核实，避免重复提交。');
      }
      if (error instanceof TypeError) {
        throw new Error(method === 'GET' ? '无法连接本地服务。请启动 Node 服务，并使用它提供的本地网址打开工作台。' : '连接中断，输入已保留。写入可能已完成，请先核实本地服务状态再重试。');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function money(value) {
    return typeof value === 'number' && Number.isFinite(value) ? '¥' + value.toFixed(2) : '—';
  }

  function remainingBudget() {
    const budget = aiConnection.data?.budget;
    return budget ? '测试预算剩余 ' + money(budget.remainingCny) : '测试预算暂不可读';
  }

  function renderConnectionStatus() {
    const status = aiConnection.view();
    const badge = $('#mode-badge');
    const provider = aiConnection.data?.provider || 'DeepSeek';
    const model = aiConnection.data?.model || 'deepseek-flash';
    if (status.canGenerateDraft) {
      text('#mode-badge', `${provider} · 就绪`);
      badge?.setAttribute('title', `已连接 ${provider} (${model})，本地预算正常`);
    } else {
      text('#mode-badge', status.label);
      badge?.setAttribute('title', status.reason);
    }
    badge?.classList.toggle('is-ready', status.canGenerateDraft);
    text('#connection-message', status.reason);
    text('#connection-times', status.times);
    const budget = status.budget;
    text('#connection-budget', budget
      ? (status.fresh ? '' : '上次读取：') + remainingBudget() + ' / 上限 ' + money(budget.limitCny) + ' · 已保守预留 ' + money(budget.reservedCny) + '（非实际扣费）· 请求尝试 ' + number(budget.attempts) + ' 次'
      : aiConnection.loading ? '测试预算读取中。' : '测试预算暂不可读，不能视为 0 或默认额度。');
    $('#refresh-ai-status').disabled = busy || aiConnection.loading;
    syncEditorActions();
  }

  function loadConnectionStatus() {
    return aiConnection.refresh();
  }

  function validateState(data) {
    if (!data || data.schemaVersion !== 1 || !data.profile || !Array.isArray(data.items) || !Array.isArray(data.sources) || !Array.isArray(data.events)) {
      throw new Error('本地服务返回的数据结构不完整，请检查服务版本。');
    }
    return data;
  }

  function updateSyncTime() {
    try {
      const timeStr = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).format(new Date());
      text('#statusbar-sync-time', '最近同步：' + timeStr);
    } catch {
      text('#statusbar-sync-time', '最近同步：刚刚');
    }
  }

  async function writeState(path, method, body, refresh = {}) {
    state = validateState(await request(path, { method, body }));
    stateChanged = true;
    Object.assign(ui, refresh);
    updateSyncTime();
    return state;
  }

  async function runAction(trigger, errorSelector, task) {
    if (busy) return;
    busy = true;
    stateChanged = false;
    setError(errorSelector, '');
    const disabledBefore = new Map();
    $$('button, input, textarea, select').forEach(control => {
      disabledBefore.set(control, control.disabled);
      control.disabled = true;
    });
    $('#main-content').setAttribute('aria-busy', 'true');
    if (trigger) trigger.classList.add('is-loading');
    try {
      await task();
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作没有完成，输入已保留，请重试。';
      setError(errorSelector, message);
      showToast(message, true);
    } finally {
      disabledBefore.forEach((wasDisabled, control) => { control.disabled = wasDisabled; });
      if (trigger) trigger.classList.remove('is-loading');
      busy = false;
      $('#main-content').removeAttribute('aria-busy');
      if (stateChanged) renderState();
      renderConnectionStatus();
      stateChanged = false;
    }
  }

  function formSnapshot(form) {
    return JSON.stringify(Array.from(form.elements)
      .filter(control => control.name && !['submit', 'button'].includes(control.type))
      .map(control => [control.name, control.type === 'checkbox' ? control.checked : control.value]));
  }

  function stampForm(form) {
    formBaselines.set(form, formSnapshot(form));
  }

  function formDirty(form) {
    return formBaselines.has(form) && formBaselines.get(form) !== formSnapshot(form);
  }

  function currentItem() {
    return state?.items.find(item => item.id === ui.selectedId) || null;
  }

  function editorDirty() {
    if (!ui.renderedId || !currentItem() || currentItem().status === 'published') return false;
    return $('#editor-title').value !== ui.editorBaseline.title || $('#editor-body').value !== ui.editorBaseline.body;
  }

  function publishDirty() {
    const form = $('#publish-form');
    return Boolean(form && !form.hidden && formDirty(form));
  }

  function confirmLeaveEditor() {
    if (!editorDirty() && !publishDirty()) return true;
    if (!window.confirm('这条内容有尚未保存的修改或未提交的发布网址。离开会丢弃这些输入，确定离开吗？')) return false;
    ui.discardPublish = true;
    renderEditor();
    return true;
  }

  function pageFromHash() {
    const candidate = window.location.hash.slice(1);
    if (candidate === 'settings') {
      setTimeout(() => openSettings('profile'), 0);
      return 'overview';
    }
    return Object.hasOwn(pageNames, candidate) ? candidate : 'overview';
  }

  function navigate(page, options = {}) {
    if (page === 'settings') {
      openSettings('profile');
      return false;
    }
    if (!Object.hasOwn(pageNames, page) || busy) return false;
    if (ui.page === 'studio' && page !== 'studio' && !confirmLeaveEditor()) return false;
    ui.page = page;
    if (options.updateHistory !== false && window.location.hash !== '#' + page) {
      window.history.pushState(null, '', '#' + page);
    }
    renderNavigation();
    if (options.focus !== false && state) {
      const heading = $('#' + page + '-title') || $('#' + page + '-heading') || $('#' + page + '-page-title');
      heading?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
    if (page === 'planning' && state) renderPlanning();
    if (page === 'studio' && state) renderStudio();
    if (page === 'publish' && state) renderPublish();
    if (page === 'report' && state && !report && !reportLoading) loadReport();
    return true;
  }

  function renderNavigation() {
    $$('.page').forEach(section => { section.hidden = section.id !== 'page-' + ui.page; });
    $$('.nav-link').forEach(link => {
      const active = link.dataset.page === ui.page;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    text('#breadcrumb-current', pageNames[ui.page]);
    document.title = pageNames[ui.page] + ' · 一人效率实验室';
  }

  function openItem(id) {
    if (busy || !state.items.some(item => item.id === id)) return;
    const changed = id !== ui.selectedId;
    if (changed && !confirmLeaveEditor()) return;
    ui.selectedId = id;
    if (!navigate('studio', { focus: false })) return;
    renderContentList();
    if (changed || ui.renderedId !== id) renderEditor();
    else syncEditorActions();
    setError('#editor-error', '');
    if (window.matchMedia('(max-width: 1020px)').matches) $('#editor-panel').scrollIntoView({ block: 'start', behavior: 'instant' });
    $('#editor-title').focus({ preventScroll: true });
  }

  function renderOverview() {
    const profile = state.profile;
    const pendingMinutes = state.items.filter(item => item.status !== 'published').reduce((sum, item) => sum + (Number(item.estimatedMinutes) || 0), 0);
    const budgetMinutes = Math.max(0, Number(profile.weeklyHours) * 60 || 0);
    const draftCount = state.items.filter(item => ['draft', 'reviewed'].includes(item.status)).length;
    text('#today-label', new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()));
    const greeting = $('#overview-title');
    greeting.replaceChildren(document.createTextNode('你好，' + (profile.name || '独立创作者')), el('span', 'heading-dot', '。'));
    text('#overview-platform', profile.platform || '小红书图文');
    text('#budget-hours', number(Number(profile.weeklyHours)));
    $('#budget-fill').style.width = Math.min(100, budgetMinutes > 0 ? pendingMinutes / budgetMinutes * 100 : 0) + '%';
    text('#budget-description', '未发布内容预计 ' + number(pendingMinutes) + ' 分钟 / 每周 ' + number(budgetMinutes) + ' 分钟');
    text('#plan-budget', '每条预计 40 分钟；每周预算 ' + number(budgetMinutes) + ' 分钟，未发布内容预计 ' + number(pendingMinutes) + ' 分钟。');
    text('#profile-summary', [profile.platform, profile.audience].filter(Boolean).join(' · '));
    $('#overview-stats').replaceChildren(
      statCard('全部内容', number(state.items.length), '包含计划到发布的全部状态 · 点击查看', 'file', () => {
        ui.filter = 'all';
        navigate('planning');
      }),
      statCard('草稿内容', number(draftCount), '草稿与已检查、未人工确认 · 点击查看', 'pen', () => {
        ui.filter = 'draft';
        navigate('planning');
      }),
      statCard('待发布', number(state.items.filter(item => item.status === 'approved').length), '已人工确认，等待自行发布 · 点击前往', 'shield', () => {
        navigate('publish');
      }),
      statCard('已登记发布', number(state.items.filter(item => item.status === 'published').length), '仅代表已登记发布网址 · 点击复盘', 'link', () => {
        navigate('report');
      })
    );
    const recent = $('#recent-items');
    recent.replaceChildren();
    const items = newest(state.items, 'updatedAt').slice(0, 4);
    if (!items.length) {
      recent.append(emptyState('你的第一条内容，还在等你', '先创建一条计划，再逐步把想法写完整。', 'pen', '去创建计划', () => navigate('planning'), true));
    } else {
      items.forEach(item => {
        const row = button('', 'recent-row', () => openItem(item.id));
        const image = el('span', 'recent-icon');
        image.append(icon('file'));
        const copy = el('span', 'recent-copy');
        copy.append(el('span', 'recent-title', item.title), el('span', 'recent-date', '更新于 ' + date(item.updatedAt || item.createdAt)));
        row.append(image, copy, statusPill(item.status));
        row.setAttribute('aria-label', '编辑：' + item.title + '，' + (statusNames[item.status] || '待起草'));
        recent.append(row);
      });
    }
    const events = $('#recent-events');
    events.replaceChildren();
    if (!state.events.length) {
      const row = el('li');
      row.append(emptyState('从第一步开始记录', '创建计划、保存资料或完善内容后，真实操作会出现在这里。', 'clock', null, null, true));
      events.append(row);
    } else {
      newest(state.events).slice(0, 5).forEach(event => {
        const row = el('li', 'event-row');
        const time = el('time', '', date(event.createdAt));
        const parsed = new Date(event.createdAt);
        if (!Number.isNaN(parsed.getTime())) time.dateTime = parsed.toISOString();
        row.append(el('p', '', event.message), time);
        events.append(row);
      });
    }
    if (ui.profileRefresh) fillProfile();
  }

  function fillProfile() {
    const form = $('#profile-form');
    ['name', 'audience', 'positioning', 'platform', 'tone', 'weeklyHours', 'goal'].forEach(name => {
      form.elements.namedItem(name).value = state.profile[name] ?? '';
    });
    stampForm(form);
    ui.profileRefresh = false;
  }

  function renderPlanning() {
    renderFilters();
    renderContentList();
    if (state?.profile) {
      const budgetMinutes = Math.max(0, Number(state.profile.weeklyHours) * 60 || 0);
      const pendingMinutes = state.items.filter(item => item.status !== 'published' && !item.archived).reduce((sum, item) => sum + (Number(item.estimatedMinutes) || 0), 0);
      const remainingMinutes = Math.max(0, budgetMinutes - pendingMinutes);
      text('#plan-budget', '每条预计 40 分钟；每周预算 ' + number(budgetMinutes) + ' 分钟，未发布内容预计 ' + number(pendingMinutes) + ' 分钟。');
      text('#planning-budget-text', '剩余 ' + number(remainingMinutes) + ' 分钟 / 共 ' + number(budgetMinutes) + ' 分钟');
    }
  }

  function renderStudio() {
    if (ui.selectedId && state.items.some(item => item.id === ui.selectedId && !item.archived)) {
      renderEditor();
    } else {
      const unarchived = newest(state.items).filter(item => !item.archived);
      if (unarchived.length) {
        ui.selectedId = unarchived[0].id;
        renderEditor();
      } else {
        ui.selectedId = null;
        ui.renderedId = null;
        $('#editor-empty').hidden = false;
        $('#editor-content').hidden = true;
        text('#studio-active-title', '专注正文写作 · 规则检查 · 人工确认');
      }
    }
  }

  function renderFilters() {
    const filters = $('#status-filters');
    filters.replaceChildren();
    const unarchived = state.items.filter(item => !item.archived);
    Object.entries({ all: '全部', ...statusNames }).forEach(([value, label]) => {
      const count = value === 'all' ? unarchived.length : unarchived.filter(item => item.status === value).length;
      const control = button('', 'filter-button' + (ui.filter === value ? ' active' : ''), () => {
        if (busy) return;
        ui.filter = value;
        renderFilters();
        renderContentList();
        const replacement = $$('.filter-button').find(candidate => candidate.dataset.filter === value);
        replacement?.focus({ preventScroll: true });
      });
      control.dataset.filter = value;
      control.setAttribute('aria-pressed', String(ui.filter === value));
      control.append(el('span', '', label), el('span', 'filter-count', count));
      filters.append(control);
    });
  }

  function renderContentList() {
    const list = $('#content-list');
    list.replaceChildren();
    const unarchived = newest(state.items).filter(item => !item.archived);
    const items = unarchived.filter(item => ui.filter === 'all' || item.status === ui.filter);
    if (!items.length) {
      const title = unarchived.length ? '这个状态下还没有内容' : '先计划一条，让创作开始';
      const description = unarchived.length ? '切换到其他状态，或创建新的内容计划。正在编辑的内容会继续保留。' : '选择上方计划数量，点击「生成模板计划」。每条预计 40 分钟，请量力而行。';
      list.append(emptyState(title, description, 'pen', unarchived.length ? '查看全部内容' : '设置计划数量', () => {
        if (unarchived.length) { ui.filter = 'all'; renderFilters(); renderContentList(); }
        else $('#plan-count').focus();
      }));
      return;
    }
    items.forEach((item, index) => {
      const card = button('', 'content-card' + (item.id === ui.selectedId ? ' selected' : ''), () => openItem(item.id));
      card.setAttribute('aria-pressed', String(item.id === ui.selectedId));
      const top = el('span', 'content-card-top');
      const cardIndex = el('span', 'content-card-index', '内容 ' + String(index + 1).padStart(2, '0'));
      top.append(cardIndex, statusPill(item.status));
      const foot = el('span', 'content-card-foot');
      const estimate = el('span');
      estimate.append(icon('clock'), document.createTextNode('预计 ' + number(item.estimatedMinutes) + ' 分钟'));
      foot.append(estimate, el('span', '', '第 ' + number(item.revision) + ' 版'));
      card.append(top, el('h3', '', item.title));
      if (item.angle) card.append(el('p', '', item.angle));
      if (item.reason) card.append(el('p', 'content-reason', '选题理由：' + item.reason));
      card.append(foot);
      list.append(card);
    });
  }

  function renderEditor() {
    const item = currentItem();
    $('#editor-empty').hidden = Boolean(item);
    $('#editor-content').hidden = !item;
    if (!item) {
      ui.renderedId = null;
      text('#studio-active-title', '专注正文写作 · 规则检查 · 人工确认');
      return;
    }
    text('#studio-active-title', item.title || '无标题草稿');
    const approvedBanner = $('#studio-approved-banner');
    if (approvedBanner) approvedBanner.hidden = item.status !== 'approved';
    const preserveUrl = $('#published-url') && ui.renderedId === item.id && !ui.discardPublish ? $('#published-url').value : '';
    ui.discardPublish = false;
    ui.renderedId = item.id;
    ui.editorRefresh = false;
    ui.editorBaseline = { title: item.title || '', body: item.body || '' };
    $('#editor-title').value = ui.editorBaseline.title;
    $('#editor-body').value = ui.editorBaseline.body;
    $('#editor-title').readOnly = item.status === 'published';
    $('#editor-body').readOnly = item.status === 'published';
    $('#editor-status').replaceChildren(statusPill(item.status));
    text('#editor-meta', '预计 ' + number(item.estimatedMinutes) + ' 分钟 · 第 ' + number(item.revision) + ' 版');
    text('#editor-angle', item.angle ? '创作角度：' + item.angle : '结合实际体验与参考资料，完成这份内容。');
    $('#human-confirm').checked = false;
    $('#approve-form').hidden = ['approved', 'published'].includes(item.status);
    if ($('#publish-form')) {
      $('#publish-form').hidden = item.status === 'published';
      stampForm($('#publish-form'));
      $('#published-url').value = item.status === 'published' ? (item.publishedUrl || '') : preserveUrl;
    }
    $('#published-info').hidden = item.status !== 'published';
    text('#editor-help', item.status === 'published' ? '已登记发布的内容不可再修改。可导出文本，或到数据复盘录入实际反馈。' : '修改标题或正文后，已有检查与人工确认会失效，需要重新检查。');
    const references = $('#editor-sources');
    references.replaceChildren();
    const sourceIds = Array.isArray(item.sourceIds) ? item.sourceIds : [];
    text('#reference-count', sourceIds.length);
    if (!sourceIds.length) {
      references.append(el('p', '', '当前草稿没有引用资料。可先添加可信资料；模板仅供无正文时起草，AI 起草需配置并明确确认。固定选取资料不等于语义检索。'));
    } else {
      sourceIds.forEach(id => {
        const source = state.sources.find(candidate => candidate.id === id);
        const row = el('div', 'reference-item');
        row.append(icon('book'));
        if (!source) row.append(el('span', '', '资料记录暂不可用：' + id));
        else if (source.url) row.append(externalLink(source.url, source.title));
        else row.append(el('span', '', source.title + ' · 未填写网址'));
        references.append(row);
      });
    }
    renderAiDetails(item);
    renderReview(item);
    if (item.status === 'published') {
      const card = el('div', 'published-card');
      card.append(externalLink(item.publishedUrl, '打开已登记的发布内容'), el('p', '', '登记时间：' + date(item.publishedAt)));
      card.append(button('去录入真实数据', 'btn btn-small btn-secondary', () => goToMetrics(item.id)));
      $('#published-info').replaceChildren(card);
    } else $('#published-info').replaceChildren();
    syncEditorActions();
  }

  function renderAiDetails(item) {
    const target = $('#editor-ai');
    target.replaceChildren();
    const ai = item.ai;
    target.hidden = !ai;
    if (!ai) return;
    const provider = typeof ai.provider === 'string' ? ai.provider : '未记录提供方';
    const model = typeof ai.model === 'string' ? ai.model : '未记录模型';
    target.append(el('h3', '', 'AI 草稿生成记录'), el('p', '', provider + ' / ' + model + ' · ' + date(ai.createdAt)),
      el('p', '', '仅标记该次生成来源，正文可能经人工修改；不代表事实已核实。实际引用见下方资料列表。'));
    const cautions = Array.isArray(ai.cautions) ? ai.cautions.filter(value => typeof value === 'string') : [];
    if (cautions.length) {
      target.append(el('h3', '', '待人工核实'));
      const list = el('ul');
      cautions.forEach(value => list.append(el('li', '', value)));
      target.append(list);
    }
    const citations = Array.isArray(ai.citations) ? ai.citations : [];
    if (citations.length) {
      target.append(el('h3', '', '知识切片溯源引用依据（轻量 RAG）'));
      const citationList = el('div', 'citation-list');
      citations.forEach(c => {
        const itemEl = el('div', 'citation-card');
        const badge = el('span', 'citation-badge', `依据 ${c.ref}`);
        const titleEl = el('strong', 'citation-title', c.sourceTitle || '参考资料');
        const quoteEl = el('p', 'citation-quote', `原句摘录：“${c.quote}”`);
        itemEl.append(badge, titleEl, quoteEl);
        citationList.append(itemEl);
      });
      target.append(citationList);
    }
    const retrievedChunks = Array.isArray(ai.retrievedChunks) ? ai.retrievedChunks : [];
    if (retrievedChunks.length) {
      const details = el('details', 'rag-chunks-details');
      const summary = el('summary', '', `命中的知识切片微段落（共 ${retrievedChunks.length} 个）`);
      const chunksList = el('div', 'chunks-list');
      retrievedChunks.forEach(chunk => {
        const cEl = el('div', 'rag-chunk-item');
        cEl.append(
          el('div', 'rag-chunk-meta', `${chunk.sourceTitle} · ${chunk.chunkId}`),
          el('div', 'rag-chunk-text', chunk.text)
        );
        chunksList.append(cEl);
      });
      details.append(summary, chunksList);
      target.append(details);
    }
    target.append(el('h3', '', '工具调用摘要（不含隐藏推理）'));
    const trace = Array.isArray(ai.toolTrace) ? ai.toolTrace.filter(entry => entry && typeof entry.tool === 'string' && typeof entry.summary === 'string') : [];
    if (trace.length) {
      const list = el('ul');
      trace.forEach(entry => list.append(el('li', '', entry.tool + '：' + entry.summary)));
      target.append(list);
    } else target.append(el('p', '', '本次未返回工具调用摘要。'));
  }

  function renderReview(item) {
    const target = $('#review-results');
    target.replaceChildren();
    if (!item.review) {
      target.append(el('p', 'check-context', '还没有当前版本的检查记录。完成草稿后，先运行一次规则检查。'));
      return;
    }
    const current = item.review.revision === item.revision;
    target.append(el('p', 'check-context', '检查版本：第 ' + number(item.review.revision) + ' 版 · ' + date(item.review.createdAt) + (current ? '' : ' · 已过期，请重新检查')));
    const list = el('ul', 'check-list');
    const levels = { pass: '通过', warning: '需核实', blocker: '需修正' };
    (item.review.checks || []).forEach(check => {
      const level = Object.hasOwn(levels, check.level) ? check.level : 'warning';
      const row = el('li', 'check-row check-' + level);
      const copy = el('span');
      copy.append(el('strong', 'check-label', levels[level]), document.createTextNode(String(check.message || '请人工核实此项。')));
      row.append(icon(level === 'pass' ? 'check' : 'info'), copy);
      list.append(row);
    });
    target.append(list);
    if ((item.review.checks || []).some(check => check.level === 'warning')) {
      target.append(el('p', 'check-context', '提醒项不会自动阻止确认，但必须由你逐条核实；确认并不代表系统已验证事实。'));
    }
  }

  function syncEditorActions() {
    const item = currentItem();
    if (!item || busy) return;
    const dirty = editorDirty();
    const published = item.status === 'published';
    const hasBody = Boolean($('#editor-body').value.trim());
    const validText = hasBody && Boolean($('#editor-title').value.trim());
    const checks = item.review?.checks || [];
    const reviewed = Boolean(item.review && item.review.revision === item.revision && !dirty);
    const blocked = checks.some(check => check.level === 'blocker');
    text('#save-indicator', published ? '已发布 · 只读' : dirty ? '有未保存修改' : '已保存到本地');
    $('#save-indicator').classList.toggle('dirty', dirty);
    const bodyVal = $('#editor-body').value || '';
    const bodyLen = [...bodyVal].length;
    const countEl = $('#body-count');
    if (countEl) {
      if (bodyLen === 0) {
        countEl.textContent = '0 字符';
        countEl.className = 'word-count-pill count-short';
      } else if (bodyLen < 400) {
        countEl.textContent = `${bodyLen} 字符 · 建议充实步骤`;
        countEl.className = 'word-count-pill count-short';
      } else if (bodyLen <= 650) {
        countEl.textContent = `${bodyLen} 字符 · 达标`;
        countEl.className = 'word-count-pill count-optimal';
      } else {
        countEl.textContent = `${bodyLen} 字符 · 偏长`;
        countEl.className = 'word-count-pill count-long';
      }
    }
    $('#save-draft').hidden = published;
    $('#save-draft').disabled = !dirty;
    $('#generate-draft').disabled = published || Boolean(item.body) || hasBody;
    $('#generate-draft').title = item.body || hasBody ? '已有正文，不能用模板覆盖；模板起草不花费预算。' : '使用内置模板，不调用模型、不花费预算。';
    const aiStatus = aiConnection.view();
    $('#ai-draft').disabled = published || !aiStatus.canGenerateDraft;
    $('#editor-connect').hidden = aiConnection.data?.configured !== false;
    text('#ai-draft-hint', published ? '已登记发布的内容不能重新起草。' : aiStatus.canGenerateDraft
      ? '点击后先只读刷新，再确认费用。最多两次请求，每次预留 ¥0.05；失败也计入预留，不自动重试或改用模板。'
      : aiStatus.label + '。原因见顶部，可点击「刷新AI状态」；模板起草不花费预算。');
    $('#export-draft').disabled = !hasBody;
    text('#export-draft span', dirty ? '保存后导出 TXT' : '导出 TXT');
    if ($('#archive-draft-btn')) {
      $('#archive-draft-btn').hidden = published;
      text('#archive-draft-btn span', '移入归档（不占本周）');
    }
    $('#review-draft').disabled = published || !validText;
    text('#review-draft', dirty ? '保存并规则检查' : '运行规则检查');
    $('#human-confirm').disabled = !reviewed || blocked || published;
    $('#approve-draft').disabled = !reviewed || blocked || !$('#human-confirm').checked || published;
    if ($('#published-url')) $('#published-url').disabled = item.status !== 'approved' || dirty;
    if ($('#publish-item')) $('#publish-item').disabled = item.status !== 'approved' || dirty;
    let hint = '先运行当前版本的规则检查，再勾选人工核实确认。';
    if (dirty) hint = '有未保存修改：请先保存并重新检查，再人工确认。';
    else if (reviewed && blocked) hint = '仍有「需修正」项，修改内容并重新检查后才能确认。';
    else if (reviewed) hint = '检查记录有效。请自行核实事实和提醒项，再明确点击人工确认。';
    text('#approve-hint', hint);
    const order = { idea: 0, draft: 0, reviewed: 1, approved: 2, published: 3 };
    const step = dirty ? 0 : (order[item.status] ?? 0);
    $$('[data-flow]').forEach((element, index) => {
      element.classList.toggle('is-done', index < step || published);
      element.classList.toggle('is-current', index === step && !published);
    });
  }

  function renderSources() {
    text('#source-total', number(state.sources.length) + ' 份资料');
    const target = $('#source-list');
    target.replaceChildren();
    if (!state.sources.length) {
      target.append(emptyState('好的内容，从一份可信资料开始', '添加工具说明、公开资料或自己的实测记录。网址可选，不会自动抓取。', 'book', '添加第一份资料', () => $('#source-form [name="title"]').focus()));
      return;
    }
    newest(state.sources).forEach(source => {
      const card = el('article', 'source-card');
      const header = el('div', 'source-card-head');
      const title = el('div');
      let badgeClass = 'source-tag tag-text';
      let badgeLabel = '参考资料';
      if (source.kind === 'builtin') {
        badgeClass = 'source-tag tag-builtin';
        badgeLabel = '内置参考 · 需核实';
      } else if (source.sourceType === 'video_transcript') {
        badgeClass = 'source-tag tag-video';
        badgeLabel = '短视频台词';
      } else if (source.sourceType === 'manual_post') {
        badgeClass = 'source-tag tag-post';
        badgeLabel = '历史笔记/对标';
      }
      title.append(el('span', badgeClass, badgeLabel), el('h3', '', source.title));
      const usedCount = state.items.filter(item => (item.sourceIds || []).includes(source.id)).length;
      const remove = button('', 'icon-button', () => deleteSource(source));
      remove.append(icon('trash'));
      remove.setAttribute('aria-label', '删除资料：' + source.title);
      remove.disabled = usedCount > 0;
      remove.title = usedCount ? '已被内容引用，不能删除' : '删除未被引用的资料';
      remove.dataset.sourceId = source.id;
      header.append(title, remove);
      card.append(header);
      const content = String(source.content || '');
      card.append(el('p', 'source-preview', content.length > 260 ? content.slice(0, 260) + '…' : content));
      if (content.length > 260) {
        const details = el('details', 'source-expand');
        details.append(el('summary', '', '展开完整资料'), el('p', 'source-preview', content));
        card.append(details);
      }
      const foot = el('div', 'source-card-foot');
      if (source.url) foot.append(externalLink(source.url, '查看来源'));
      else foot.append(el('span', '', '未填写来源网址'));
      foot.append(el('span', '', usedCount ? '已被 ' + usedCount + ' 条内容引用 · 不可删除' : '未被引用'), el('span', '', date(source.createdAt)));
      card.append(foot);
      target.append(card);
    });
  }

  async function deleteSource(source) {
    if (busy || !window.confirm('确定删除「' + source.title + '」吗？删除后无法在工作台撤销。已被内容引用的资料不能删除。')) return;
    const trigger = $$('[data-source-id]').find(candidate => candidate.dataset.sourceId === source.id);
    await runAction(trigger, '#source-error', async () => {
      await writeState('/api/sources/' + encodeURIComponent(source.id), 'DELETE');
      showToast('资料已删除。');
    });
  }

  async function publishItemById(itemId, urlString, triggerButton, errorContainer) {
    const item = state.items.find(i => i.id === itemId);
    if (!item) return;
    await runAction(triggerButton, errorContainer, async () => {
      if (item.status !== 'approved') throw new Error('仅已人工确认的内容可登记发布。');
      const url = safeUrl(urlString);
      if (!url) throw new Error('请填写合法的 https:// 网址，不要填写账号密码。');
      await writeState('/api/items/' + encodeURIComponent(item.id) + '/publish', 'POST', { url }, { editorRefresh: true, metricsRefresh: true });
      report = null;
      reportSequence += 1;
      reportLoading = false;
      $('#report-loading').hidden = true;
      showToast('已登记发布网址，已进入数据复盘！');
    });
  }

  const CARD_THEMES = {
    'theme-warm': {
      name: '温润东方',
      bg: '#f8f5ed',
      color: '#273022',
      borderColor: '#e4dbca',
      badgeBg: '#ebdccb',
      badgeColor: '#7d4a2a',
      angleBg: '#f4f0e6',
      angleColor: '#5d6754',
      angleBorder: '#e2d7c5',
      pillBg: '#b84b29',
      pillColor: '#ffffff',
      quoteBg: '#fdfcf7',
      quoteBorder: '#d8cebe',
      watermarkColor: '#85907e',
      accent: '#b84b29',
    },
    'theme-sage': {
      name: '极简青竹',
      bg: '#f0f5eb',
      color: '#1c291c',
      borderColor: '#cadac2',
      badgeBg: '#d7e6d1',
      badgeColor: '#2b582f',
      angleBg: '#e7efe1',
      angleColor: '#495e46',
      angleBorder: '#c6d8be',
      pillBg: '#336938',
      pillColor: '#ffffff',
      quoteBg: '#f7fbf5',
      quoteBorder: '#c6d8be',
      watermarkColor: '#6b8268',
      accent: '#336938',
    },
    'theme-terracotta': {
      name: '赭石秋序',
      bg: '#fdf5f0',
      color: '#36231d',
      borderColor: '#e8c9bd',
      badgeBg: '#eed3c7',
      badgeColor: '#873922',
      angleBg: '#f6e4dc',
      angleColor: '#704b40',
      angleBorder: '#e8cbbf',
      pillBg: '#ba4f30',
      pillColor: '#ffffff',
      quoteBg: '#fff9f7',
      quoteBorder: '#e8cbbf',
      watermarkColor: '#9e6b5d',
      accent: '#ba4f30',
    },
    'theme-dark': {
      name: '深夜墨静',
      bg: '#1c201c',
      color: '#ede8dc',
      borderColor: '#3d463d',
      badgeBg: '#3d3429',
      badgeColor: '#dfa680',
      angleBg: '#2a312a',
      angleColor: '#b0baa9',
      angleBorder: '#444f44',
      pillBg: '#d88b5d',
      pillColor: '#1c201c',
      quoteBg: '#242c23',
      quoteBorder: '#3f4a3e',
      watermarkColor: '#7a8877',
      accent: '#d88b5d',
    },
  };

  let currentCardItem = null;
  let currentCardTheme = 'theme-warm';
  let currentCardMode = 'question';

  function generateQuestionHook(item) {
    if (!item) return { title: '', sub: '', point: '', points: [] };
    const rawTitle = (item.title || '').trim();
    const rawAngle = (item.angle || '').trim();
    const rawBody = (item.body || '').replace(/\[\d+\]/g, '').trim();

    let questionTitle = '';
    const angleQuoteMatch = rawAngle.match(/[“「]([^”」]+[？?为何怎么如何为什么][^”」]*)[”」]/);
    if (angleQuoteMatch && angleQuoteMatch[1]) {
      questionTitle = angleQuoteMatch[1].trim();
      if (!questionTitle.endsWith('？') && !questionTitle.endsWith('?')) questionTitle += '？';
    } else if (/[？?]/.test(rawTitle)) {
      questionTitle = rawTitle;
    } else if (rawTitle.includes('不必')) {
      const parts = rawTitle.split(/[，,]/);
      if (parts.length >= 2) {
        questionTitle = `${parts[0].replace(/不必.*$/, '')}，为何${parts[1].replace(/里的.*$/, '')}才是真意？`;
      } else {
        questionTitle = `${rawTitle}，究竟有何深意？`;
      }
    } else if (rawTitle.includes('为何') || rawTitle.includes('为什么') || rawTitle.includes('如何') || rawTitle.includes('怎么')) {
      questionTitle = rawTitle.endsWith('？') ? rawTitle : rawTitle + '？';
    } else {
      questionTitle = `${rawTitle}，到底有何不同？`;
    }

    let sub = '';
    const reflectionMatch = rawBody.match(/(?:其实|原来|比起)[^，。；\n]+[，。；]/);
    if (reflectionMatch) {
      sub = reflectionMatch[0].replace(/[，。；]$/, '').trim();
    } else if (rawAngle) {
      const angleParts = rawAngle.split(/[，；。]/).filter(s => s.length >= 8 && !s.includes('切入') && !s.includes('先补'));
      sub = angleParts[0] || '顺应物候与时令生活的小小体悟';
    } else {
      sub = '顺应时令生活的小小体悟';
    }

    // 提取单句核心疑问句（只保留 1 句最吸睛的核心反问）
    let singlePoint = '';
    if (rawBody.includes('茶') || rawTitle.includes('茶')) {
      singlePoint = '时令温茶，为何一盅微暖胜过过量滋补？';
    } else if (rawBody.includes('登高') || rawBody.includes('慢走')) {
      singlePoint = '登高慢走，怎样呼吸才得松弛不累？';
    } else if (rawBody.includes('案几') || rawBody.includes('收拾') || rawBody.includes('留白')) {
      singlePoint = '居室收拾留白，怎样真正呼应万物收藏？';
    } else {
      const bodyQuestions = rawBody.match(/[^。！？\n]+[？?]/g);
      if (bodyQuestions && bodyQuestions.length > 0) {
        singlePoint = bodyQuestions[0].trim();
      } else {
        singlePoint = '顺应时令物候，如何用一件生活小事安顿身心？';
      }
    }

    return {
      title: questionTitle,
      sub,
      point: singlePoint,
      points: [singlePoint],
    };
  }

  function generateHashtags(item) {
    if (!item) return ['#时令生活', '#东方美学', '#治愈系生活', '#松弛感日常'];
    const text = `${item.title || ''} ${item.angle || ''} ${item.body || ''}`;
    const tags = new Set();

    // 1. 时令与节气热点
    if (text.includes('重阳')) {
      tags.add('#重阳节');
      tags.add('#重阳习俗');
    }
    if (text.includes('霜降')) tags.add('#霜降');
    if (text.includes('立冬')) tags.add('#立冬');
    if (text.includes('秋')) {
      tags.add('#秋日生活打卡');
      tags.add('#秋天');
    }

    // 2. 核心生活方式与内容垂类
    if (text.includes('茶')) {
      tags.add('#秋天喝什么茶');
      tags.add('#茶生活');
      tags.add('#围炉煮茶');
    }
    if (text.includes('登高') || text.includes('行')) tags.add('#户外慢走');
    if (text.includes('物候') || text.includes('时令') || text.includes('节气')) {
      tags.add('#时令生活');
      tags.add('#我的节气生活');
    }

    // 3. 高流量美学与情绪底座
    tags.add('#东方美学');
    tags.add('#松弛感日常');
    tags.add('#治愈系生活');
    tags.add('#生活美学');
    tags.add('#日签');

    return Array.from(tags).slice(0, 8);
  }

  function extractCardPoints(body) {
    if (!body) return [];
    const cleaned = body.replace(/\[\d+\]/g, '').trim();
    const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const points = [];
    const numberedPattern = /^(?:[0-9]+[、.．]|(?:其[一二三四五]|第[一二三四五])[、，：:]|[•·\-\*])\s*(.+)$/;
    for (const line of lines) {
      const match = line.match(numberedPattern);
      if (match && match[1]) points.push(match[1].trim());
    }
    if (points.length < 2) {
      const inlinePattern = /(?:其[一二三四五]|第[一二三四五])[，、：:]([^，。；\n]+[。；]?)/g;
      let m;
      while ((m = inlinePattern.exec(cleaned)) !== null) {
        if (m[1].trim()) points.push(m[1].trim());
      }
    }
    if (points.length < 2) {
      const sentences = cleaned.split(/[。\n]+/).map(s => s.trim()).filter(s => s.length >= 10 && !s.startsWith('需注意') && !s.startsWith('注：'));
      for (const s of sentences) {
        if (points.length >= 4) break;
        points.push(s);
      }
    }
    return points.slice(0, 4).map(p => p.length > 55 ? p.slice(0, 52) + '…' : p);
  }

  function extractCardQuote(body, angle) {
    if (!body) return angle || '不负时令，慢品日常。';
    const cleaned = body.replace(/\[\d+\]/g, '').trim();
    const quoteMatch = cleaned.match(/[“「]([^”」]{10,60})[”」]/);
    if (quoteMatch && quoteMatch[1]) return quoteMatch[1].trim();
    const sentences = cleaned.split(/[。\n]+/).map(s => s.trim()).filter(s => s.length >= 15 && s.length <= 60 && !s.startsWith('需注意'));
    if (sentences.length) return sentences[0];
    return cleaned.slice(0, 50) + (cleaned.length > 50 ? '…' : '');
  }

  function extractCardExcerpt(body) {
    if (!body) return '暂无正文内容。';
    const cleaned = body.replace(/\[\d+\]/g, '').trim();
    const paragraphs = cleaned.split(/\r?\n+/).map(p => p.trim()).filter(p => p && !p.startsWith('需注意') && !p.startsWith('注：'));
    const text = paragraphs.join('\n\n');
    return text.length > 180 ? text.slice(0, 175) + '…' : text;
  }

  function drawRoundRect(ctx, x, y, width, height, radius) {
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, radius);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function getWrappedLines(ctx, text, maxWidth) {
    const chars = [...text];
    const lines = [];
    let current = '';
    for (let i = 0; i < chars.length; i++) {
      const test = current + chars[i];
      if (ctx.measureText(test).width > maxWidth && i > 0) {
        lines.push(current);
        current = chars[i];
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 10) {
    const lines = getWrappedLines(ctx, text, maxWidth);
    let currentY = y;
    for (let i = 0; i < lines.length; i++) {
      if (i >= maxLines) break;
      let lineText = lines[i];
      if (i === maxLines - 1 && lines.length > maxLines) {
        lineText = lineText.slice(0, -1) + '…';
      }
      ctx.fillText(lineText, x, currentY);
      currentY += lineHeight;
    }
    return currentY;
  }

  function renderCardToCanvas(ctx, item, mode, theme) {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, 1080, 1440);

    ctx.strokeStyle = theme.borderColor;
    ctx.lineWidth = 3;
    drawRoundRect(ctx, 36, 36, 1080 - 72, 1440 - 72, 32);
    ctx.stroke();

    // 1. Category Tag at top
    ctx.font = '600 24px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = theme.accent;
    ctx.fillText('「 岁时生活问答 」', 64, 100);

    // 2. Question Title
    const customTitle = $('#card-custom-question')?.value.trim();
    const questionTitle = customTitle || item.title || '无标题';
    ctx.font = 'bold 50px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = theme.color;
    let currentY = wrapText(ctx, questionTitle, 64, 175, 952, 68, 2);

    // 3. Subtitle / Reflection
    currentY += 24;
    const customSub = $('#card-custom-sub')?.value.trim();
    const subTitle = customSub || item.angle || '顺应物候与时令生活的小小体悟';
    ctx.font = '500 24px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const subLines = getWrappedLines(ctx, subTitle, 952 - 40);
    const subBoxH = subLines.length * 36 + 28;
    drawRoundRect(ctx, 64, currentY, 952, subBoxH, 12);
    ctx.fillStyle = theme.angleBg;
    ctx.fill();
    ctx.strokeStyle = theme.angleBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = theme.angleColor;
    let sy = currentY + 34;
    for (const line of subLines) {
      ctx.fillText(line, 84, sy);
      sy += 36;
    }
    currentY += subBoxH + 48;

    // 4. Content Body
    if (mode === 'question') {
      const customPoint = $('#card-custom-point')?.value.trim();
      const hook = generateQuestionHook(item);
      const singlePoint = customPoint || hook.point || '顺应物候与时令，如何用一件生活小事安顿身心？';

      // 单句核心疑问句，无圆标问号，大字通透排版
      const qBoxY = currentY + 40;
      const qBoxH = 260;
      drawRoundRect(ctx, 64, qBoxY, 952, qBoxH, 20);
      ctx.fillStyle = theme.quoteBg;
      ctx.fill();
      ctx.strokeStyle = theme.quoteBorder;
      ctx.lineWidth = 1.8;
      ctx.stroke();

      ctx.font = 'bold 36px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = theme.color;
      ctx.textAlign = 'center';
      wrapText(ctx, singlePoint, 540, qBoxY + 115, 860, 56, 3);
      ctx.textAlign = 'left';
    } else if (mode === 'zen_quote') {
      const qBoxY = currentY + 20;
      const qBoxH = 340;
      drawRoundRect(ctx, 64, qBoxY, 952, qBoxH, 16);
      ctx.fillStyle = theme.quoteBg;
      ctx.fill();
      ctx.strokeStyle = theme.quoteBorder;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 8]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = 'bold 84px Georgia, serif';
      ctx.fillStyle = theme.accent;
      ctx.fillText('“', 96, qBoxY + 80);

      ctx.font = 'italic 500 32px system-ui, -apple-system, "PingFang SC", sans-serif';
      ctx.fillStyle = theme.color;
      wrapText(ctx, `${questionTitle}\n${subTitle}`, 96, qBoxY + 130, 952 - 64, 52, 3);

      ctx.font = '500 24px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = theme.color;
      ctx.globalAlpha = 0.7;
      ctx.textAlign = 'right';
      ctx.fillText('—— 下滑阅读全文', 64 + 952 - 32, qBoxY + qBoxH - 32);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1.0;
    } else if (mode === 'summary') {
      const points = customPoints.length ? customPoints : extractCardPoints(item.body);
      let py = currentY + 10;
      points.slice(0, 3).forEach((p, idx) => {
        ctx.beginPath();
        ctx.arc(88, py + 14, 20, 0, Math.PI * 2);
        ctx.fillStyle = theme.pillBg;
        ctx.fill();
        ctx.fillStyle = theme.pillColor;
        ctx.font = 'bold 22px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(String(idx + 1), 88, py + 22);
        ctx.textAlign = 'left';

        ctx.fillStyle = theme.color;
        ctx.font = '500 28px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
        py = wrapText(ctx, p, 126, py + 22, 952 - 64, 44, 2);
        py += 36;
      });
    }

    // 5. Bottom Swipe Hint & Evidence
    ctx.font = '600 24px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = 0.85;
    ctx.textAlign = 'center';
    ctx.fillText('下滑查看笔记完整拆解 ▾', 540, 1325);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1.0;

    const sourceNames = (item.sourceIds || []).map(id => state.sources.find(s => s.id === id)?.title).filter(Boolean);
    if (sourceNames.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = theme.borderColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.moveTo(64, 1355);
      ctx.lineTo(1080 - 64, 1355);
      ctx.stroke();
      ctx.setLineDash([]);

      const sourceStr = '依据：' + sourceNames.join(' / ');
      ctx.font = '22px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = theme.color;
      ctx.globalAlpha = 0.65;
      ctx.textAlign = 'center';
      ctx.fillText(sourceStr.length > 40 ? sourceStr.slice(0, 38) + '…' : sourceStr, 540, 1390);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1.0;
    }
  }

  function downloadCardImage(item, mode, themeKey) {
    const theme = CARD_THEMES[themeKey] || CARD_THEMES['theme-warm'];
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1440;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      showToast('浏览器不支持 Canvas 图像导出', true);
      return;
    }
    renderCardToCanvas(ctx, item, mode, theme);
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const safeTitle = (item.title || 'card_cover').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 30);
      const filename = `${safeTitle}_3-4通用图文封面卡片.png`;
      const link = document.createElement('a');
      link.download = filename;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast(`已成功导出 3:4 通用图文封面卡片：${filename}！可直接上传小红书或抖音图文。`);
    } catch (err) {
      showToast('图片导出失败：' + (err.message || '未知错误'), true);
    }
  }

  function renderCardPreview(item, mode, themeKey) {
    if (!item) return;
    const viewport = $('#card-preview-viewport');
    if (!viewport) return;

    viewport.className = `card-preview-viewport ${themeKey}`;

    const customTitle = $('#card-custom-question')?.value.trim();
    const customSub = $('#card-custom-sub')?.value.trim();

    text('#card-tag-text', '「 岁时生活问答 」');
    text('#card-title-text', customTitle || item.title || '无标题');
    text('#card-angle-text', customSub || item.angle || '顺应物候与时令生活的小小体悟');

    const bodyEl = $('#card-content-body');
    bodyEl.replaceChildren();

    if (mode === 'question') {
      const customPoint = $('#card-custom-point')?.value.trim();
      const hook = generateQuestionHook(item);
      const singlePoint = customPoint || hook.point || '顺应物候与时令，如何用一件生活小事安顿身心？';

      const box = el('div', 'card-single-question');
      const textP = el('p', 'card-single-question-text', singlePoint);
      box.append(textP);
      bodyEl.append(box);
    } else if (mode === 'zen_quote') {
      const box = el('div', 'card-quote-box');
      const mark = el('span', 'card-quote-mark', '“');
      const textP = el('p', 'card-quote-text', `${customTitle || item.title || ''}\n${customSub || item.angle || ''}`);
      const auth = el('div', '', '—— 下滑阅读全文');
      auth.style.textAlign = 'right';
      auth.style.fontSize = '11px';
      auth.style.opacity = '0.75';
      auth.style.marginTop = '6px';
      box.append(mark, textP, auth);
      bodyEl.append(box);
    } else if (mode === 'summary') {
      const points = extractCardPoints(item.body);
      points.slice(0, 3).forEach((point, idx) => {
        const row = el('div', 'card-point-row');
        const pill = el('span', 'card-point-pill', String(idx + 1));
        const pointText = el('span', 'card-point-text', point);
        row.append(pill, pointText);
        bodyEl.append(row);
      });
    }

    const sourceNames = (item.sourceIds || []).map(id => state.sources.find(s => s.id === id)?.title).filter(Boolean);
    const sourceEl = $('#card-source-tag');
    if (sourceNames.length > 0) {
      if (sourceEl) {
        sourceEl.hidden = false;
        sourceEl.textContent = '依据：' + sourceNames.join(' / ');
      }
    } else {
      if (sourceEl) sourceEl.hidden = true;
    }
  }

  function renderHashtagsChips(item) {
    const container = $('#card-tags-container');
    if (!container) return;
    container.replaceChildren();
    const tags = generateHashtags(item);
    tags.forEach((tag, idx) => {
      const chip = el('button', 'topic-tag-chip' + (idx < 2 ? ' hot' : ''), tag);
      chip.type = 'button';
      chip.title = '点击单独复制此话题';
      chip.addEventListener('click', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(tag);
          }
          showToast(`已复制话题：${tag}`);
        } catch {
          showToast(`复制失败：${tag}`, true);
        }
      });
      container.append(chip);
    });
  }

  function openCardGenerator(item) {
    if (!item) return;
    currentCardItem = item;
    const modal = $('#card-generator-modal');
    if (!modal) return;
    modal.hidden = false;

    $$('#card-theme-options .theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === currentCardTheme);
    });

    const hook = generateQuestionHook(item);
    if ($('#card-custom-question')) $('#card-custom-question').value = hook.title;
    if ($('#card-custom-sub')) $('#card-custom-sub').value = hook.sub;
    if ($('#card-custom-point')) $('#card-custom-point').value = hook.point;

    const modeSelect = $('#card-extract-mode');
    if (modeSelect) modeSelect.value = currentCardMode;

    const pointGroup = $('#card-custom-point-group');
    if (pointGroup) pointGroup.hidden = currentCardMode === 'zen_quote';

    renderHashtagsChips(item);
    renderCardPreview(currentCardItem, currentCardMode, currentCardTheme);
  }

  function closeCardGenerator() {
    const modal = $('#card-generator-modal');
    if (modal) modal.hidden = true;
  }

  function renderPublish() {
    const pendingTarget = $('#publish-pending-list');
    const historyTarget = $('#publish-history-list');
    if (!pendingTarget || !historyTarget) return;

    pendingTarget.replaceChildren();
    historyTarget.replaceChildren();

    const approvedItems = state.items.filter(item => item.status === 'approved' && !item.archived);
    const publishedItems = newest(state.items.filter(item => item.status === 'published'), 'publishedAt');

    text('#publish-count-chip', number(approvedItems.length) + ' 篇待发布');

    if (!approvedItems.length) {
      pendingTarget.append(emptyState(
        '暂无待发布内容',
        '在「创作空间」完成草稿起草、通过内置规则检查并勾选人工确认后，内容将进入待发布队列。',
        'check',
        '前往创作空间',
        () => navigate('studio'),
        true
      ));
    } else {
      approvedItems.forEach((item, index) => {
        // Styled like task queue card (.content-card.selected)
        const card = el('div', 'content-card selected publish-task-card');

        // Top line: 内容 01 + 待发布 status pill
        const top = el('span', 'content-card-top');
        const cardIndex = el('span', 'content-card-index', '内容 ' + String(index + 1).padStart(2, '0'));
        top.append(cardIndex, statusPill(item.status));

        // Title: h3
        const title = el('h3', '', item.title);

        // Angle paragraph: p
        const angle = el('p', '', item.angle || '结合实际体验与参考资料，完成内容发布。');

        // Reason or excerpt: content-reason
        const charCount = [...(item.body || '')].length;
        const excerptText = item.body ? item.body.trim().slice(0, 160) + (item.body.length > 160 ? '…' : '') : '';
        const reason = el('p', 'content-reason', item.reason ? '选题理由：' + item.reason : (excerptText ? '正文预览：' + excerptText : '已通过规则检查与人工确认'));

        // Foot line: 预计时间 · 第 X 版 · 字符数 + Action Buttons
        const foot = el('span', 'content-card-foot');
        const estimate = el('span');
        estimate.append(icon('clock'), document.createTextNode('预计 ' + number(item.estimatedMinutes) + ' 分钟 · 第 ' + number(item.revision) + ' 版 · ' + charCount + ' 字符'));

        const actionGroup = el('div', 'publish-card-actions-compact');

        const cardBtn = button('', 'btn btn-secondary btn-small', (e) => {
          e.stopPropagation();
          openCardGenerator(item);
        });
        cardBtn.append(icon('spark'), document.createTextNode(' 生成图文卡片'));

        const copyBtn = button('', 'btn btn-secondary btn-small', async (e) => {
          e.stopPropagation();
          try {
            const fullText = (item.title ? item.title + '\n\n' : '') + (item.body || '');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(fullText);
            } else {
              const ta = document.createElement('textarea');
              ta.value = fullText;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
            }
            showToast('正文与标题已复制到剪贴板，可粘贴至小红书等平台发布！');
          } catch {
            showToast('复制失败，请进入创作空间手动复制。');
          }
        });
        copyBtn.append(icon('file'), document.createTextNode(' 一键复制正文'));

        const editBtn = button('', 'btn btn-quiet btn-small', (e) => {
          e.stopPropagation();
          openItem(item.id);
        });
        editBtn.append(icon('pen'), document.createTextNode(' 创作空间修改'));

        actionGroup.append(cardBtn, copyBtn, editBtn);
        foot.append(estimate, actionGroup);

        // Seamless inline publish URL register row
        const form = el('form', 'publish-register-bar');
        const label = el('span', 'publish-register-label', '登记发布网址：');
        const input = el('input');
        input.type = 'url';
        input.placeholder = '在平台发布后粘贴网址（https://...）并登记以进入复盘';
        input.required = true;
        input.autocomplete = 'off';

        const submitBtn = button('登记已发布网址', 'btn btn-primary btn-small', () => {});
        submitBtn.type = 'submit';

        const errorEl = el('p', 'form-error full-width');
        errorEl.setAttribute('role', 'alert');
        errorEl.hidden = true;

        form.append(label, input, submitBtn, errorEl);

        form.addEventListener('submit', event => {
          event.preventDefault();
          const val = input.value.trim();
          publishItemById(item.id, val, submitBtn, errorEl);
        });

        card.append(top, title, angle, reason, foot, form);
        pendingTarget.append(card);
      });
    }

    // Render published items history
    if (!publishedItems.length) {
      historyTarget.append(el('p', 'tiny muted', '暂无已登记发布的内容。在上方登记发布网址后，内容将进入已发布列表，并可在「数据复盘」中追踪运营指标。'));
    } else {
      publishedItems.forEach(item => {
        const row = el('div', 'publish-history-row');
        const left = el('div', 'publish-history-left');
        const urlLink = externalLink(item.publishedUrl, '打开平台链接 ↗');
        const metaLine = el('div', 'publish-history-meta');
        metaLine.append(el('span', '', '发布时间：' + date(item.publishedAt) + ' · '), urlLink);
        left.append(
          el('strong', 'publish-history-title', item.title),
          metaLine
        );
        const right = el('div', 'publish-history-right');
        const metricsBtn = button('', 'btn btn-small btn-secondary', () => goToMetrics(item.id));
        metricsBtn.append(icon('chart'), document.createTextNode(' 录入/查看运营指标'));
        right.append(metricsBtn);

        row.append(left, right);
        historyTarget.append(row);
      });
    }
  }

  function renderMetricsOptions() {
    const form = $('#metrics-form');
    const select = $('#metrics-item');
    const previous = select.value || ui.metricsSelected;
    const published = newest(state.items.filter(item => item.status === 'published'), 'publishedAt');
    select.replaceChildren();
    form.hidden = !published.length;
    $('#metrics-empty').hidden = Boolean(published.length);
    $('#save-metrics').disabled = !published.length;
    if (!published.length) {
      select.append(new Option('暂无已登记发布的内容', ''));
      ui.metricsSelected = '';
      stampForm(form);
      return;
    }
    published.forEach(item => select.append(new Option(item.title + (item.metrics ? ' · 已录数据' : ' · 待录数据'), item.id)));
    const desired = ui.metricsRefresh && ui.metricsSelected ? ui.metricsSelected : previous;
    select.value = published.some(item => item.id === desired) ? desired : published[0].id;
    if (ui.metricsRefresh || previous !== select.value || !formBaselines.has(form)) fillMetrics(select.value);
    ui.metricsSelected = select.value;
    ui.metricsRefresh = false;
  }

  function fillMetrics(id) {
    const item = state.items.find(candidate => candidate.id === id);
    const form = $('#metrics-form');
    ['views', 'likes', 'comments', 'saves'].forEach(name => {
      form.elements.namedItem(name).value = item?.metrics?.[name] ?? '';
    });
    text('#metrics-last-recorded', item?.metrics ? '上次录入：' + date(item.metrics.recordedAt) + '。请更新为平台当前累计数据。' : '尚未录入。没有数据时请留空，不要用 0 代替未知值。');
    ui.metricsSelected = id;
    stampForm(form);
    setError('#metrics-error', '');
  }

  function goToMetrics(id) {
    if (busy) return;
    const form = $('#metrics-form');
    if (ui.metricsSelected !== id && formDirty(form) && !window.confirm('另一条内容的指标尚未保存，确定丢弃这些指标并切换吗？')) return;
    if (!navigate('report')) return;
    $('#metrics-item').value = id;
    fillMetrics(id);
    $('#metrics-form [name="views"]').focus();
  }

  function renderReport() {
    const stats = $('#report-stats');
    const recommendations = $('#recommendations');
    const best = $('#best-item');
    const rows = $('#report-rows');
    recommendations.replaceChildren();
    best.replaceChildren();
    best.hidden = true;
    rows.replaceChildren();
    if (!report) {
      stats.replaceChildren(
        statCard('总浏览', '—', '等待读取真实记录', 'chart'),
        statCard('总互动', '—', '点赞 + 评论 + 收藏', 'spark'),
        statCard('综合互动率', '—', '按浏览总量计算', 'chart'),
        statCard('已录数据的内容', '—', '只统计手动录入记录', 'file')
      );
      text('#sample-note', '尚未读取复盘结果。没有记录时不会补入演示数据；你仍可录入已登记内容的实际指标。');
      const row = el('tr');
      const cell = el('td', 'table-empty', '暂无可展示的复盘结果，请读取数据后查看。');
      cell.colSpan = 6;
      row.append(cell);
      rows.append(row);
      return;
    }
    const totals = report.totals;
    const totalInteractions = totals.likes + totals.comments + totals.saves;
    const measured = report.measuredCount;
    stats.replaceChildren(
      statCard('总浏览', number(totals.views), '来自手动录入的累计浏览', 'chart'),
      statCard('总互动', number(totalInteractions), '赞 ' + number(totals.likes) + ' · 评 ' + number(totals.comments) + ' · 藏 ' + number(totals.saves), 'spark'),
      statCard('综合互动率', rate(report.interactionRate), totals.views === 0 ? '浏览为 0，不能计算比率' : '互动总次数 ÷ 浏览总次数', 'chart'),
      statCard('已录数据的内容', number(measured), '已登记发布 ' + number(report.publishedCount) + ' 条', 'file')
    );
    const sampleMessage = measured === 0
      ? '还没有手动录入的数据。空白不等于表现差：先在平台自行发布、登记网址，再录入真实指标。'
      : '当前只有 ' + number(measured) + ' 条已录数据的内容。样本有限，发布时间与观察窗口也会影响结果；不足以证明因果或保证增长。';
    text('#sample-note', sampleMessage);
    report.recommendations.forEach(message => recommendations.append(el('li', '', message)));
    if (!report.recommendations.length) recommendations.append(el('li', '', measured ? '继续积累同一观察窗口的真实数据，再比较内容差异。' : '先完成一条内容的发布登记与指标录入。'));
    if (report.best) {
      best.hidden = false;
      best.append(el('p', '', '当前记录中的参考内容 · 不代表长期最优'), el('h3', '', report.best.title));
      best.append(el('p', '', '浏览 ' + number(report.best.views) + ' · 互动 ' + number(report.best.interactions) + ' · 互动率 ' + rate(report.best.rate)));
      best.append(button('查看这条内容 →', 'text-button', () => openItem(report.best.id)));
    }
    if (!report.rows.length) {
      const row = el('tr');
      const cell = el('td', 'table-empty', '还没有指标记录。请先录入已登记发布内容的真实数据。');
      cell.colSpan = 6;
      row.append(cell);
      rows.append(row);
    } else {
      report.rows.forEach(item => {
        const row = el('tr');
        const title = el('td');
        title.append(button(item.title, 'table-title-button', () => openItem(item.id)));
        row.append(title, el('td', '', number(item.views)), el('td', '', number(item.likes)), el('td', '', number(item.comments)), el('td', '', number(item.saves)), el('td', '', rate(item.rate)));
        rows.append(row);
      });
    }
  }

  async function loadReport() {
    const sequence = ++reportSequence;
    reportLoading = true;
    $('#report-loading').hidden = false;
    $('#refresh-report').disabled = true;
    setError('#report-error', '');
    try {
      const next = await request('/api/report');
      if (!next?.totals || !Array.isArray(next.rows) || !Array.isArray(next.recommendations)) throw new Error('复盘数据格式不完整，请检查本地服务。');
      if (sequence !== reportSequence) return false;
      report = next;
      renderReport();
      return true;
    } catch (error) {
      if (sequence === reportSequence) {
        report = null;
        renderReport();
        setError('#report-error', error.message + ' 已输入的指标仍保留，可稍后点击「刷新复盘」。');
      }
      return false;
    } finally {
      if (sequence === reportSequence) {
        reportLoading = false;
        $('#report-loading').hidden = true;
        $('#refresh-report').disabled = busy;
      }
    }
  }

  function renderState() {
    if (!state) return;
    renderOverview();
    renderPlanning();
    renderPublish();
    renderSources();
    if (ui.page === 'studio') {
      if (ui.editorRefresh || (!editorDirty() && !publishDirty())) renderStudio();
      else syncEditorActions();
    } else {
      if (ui.editorRefresh || (!editorDirty() && !publishDirty())) renderEditor();
      else syncEditorActions();
    }
    renderMetricsOptions();
    renderReport();
    renderNavigation();
    $('#refresh-report').disabled = reportLoading;
  }

  async function saveEditorIfDirty() {
    const item = currentItem();
    if (!item || !editorDirty()) return;
    const title = $('#editor-title').value.trim();
    const body = $('#editor-body').value;
    if (!title || !body.trim()) throw new Error('请填写内容标题和正文，再保存或运行检查。');
    if (title.length > 200 || body.length > 20000) throw new Error('标题最多 200 字符，正文最多 20000 字符。');
    if (item.status === 'published') throw new Error('已登记发布的内容不能修改。');
    // 带上页面看到的版本号：若另一个页面已保存，服务器会拒绝而不是静默覆盖。
    await writeState('/api/items/' + encodeURIComponent(item.id), 'PATCH', { title, body, expectedRevision: item.revision }, { editorRefresh: true });
    const saved = currentItem();
    ui.editorBaseline = { title: saved.title || '', body: saved.body || '' };
  }

  function downloadDraft(item) {
    const references = (item.sourceIds || []).map(id => state.sources.find(source => source.id === id)).filter(Boolean);
    const sourceText = references.length ? '\n\n参考资料（请人工核实）：\n' + references.map((source, index) => (index + 1) + '. ' + source.title + (safeUrl(source.url) ? '\n' + safeUrl(source.url) : '')).join('\n') : '';
    const contents = '\uFEFF' + item.title + '\n\n' + (item.body || '') + sourceText;
    const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a');
    anchor.href = url;
    anchor.download = (item.title || '内容草稿').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) + '.txt';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function boot() {
    if (busy) return;
    $('#boot-state').hidden = false;
    $('#boot-error').hidden = true;
    $('#retry-state').disabled = true;
    loadConnectionStatus();
    try {
      state = validateState(await request('/api/state'));
      ui.profileRefresh = true;
      ui.metricsRefresh = true;
      renderState();
      updateSyncTime();
      $('#pages').hidden = false;
      $('#boot-state').hidden = true;
      if (ui.page === 'report') loadReport();
    } catch (error) {
      $('#boot-state').hidden = true;
      $('#boot-error').hidden = false;
      text('#boot-error-message', error.message);
    } finally {
      $('#retry-state').disabled = false;
    }
  }

  document.addEventListener('click', event => {
    // Connection links use normal navigation so beforeunload still guards all unsaved forms.
    if (event.target.closest('[data-connect]')) {
      if (busy) event.preventDefault();
      return;
    }
    const trigger = event.target.closest('[data-page], [data-go]');
    if (!trigger) return;
    event.preventDefault();
    const target = trigger.dataset.page || trigger.dataset.go;
    if (target === 'content') {
      navigate('planning');
      $('#idea-input')?.focus();
      return;
    }
    navigate(target);
  });

  window.addEventListener('hashchange', () => {
    if (!navigate(pageFromHash(), { updateHistory: false })) window.history.replaceState(null, '', '#' + ui.page);
  });

  window.addEventListener('beforeunload', event => {
    if (busy || editorDirty() || $$('form[data-track]').some(formDirty)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  $('#retry-state').addEventListener('click', boot);
  $('#edit-profile-shortcut')?.addEventListener('click', () => {
    if (busy) return;
    openSettings('profile');
  });

  $('#profile-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    values.weeklyHours = Number(values.weeklyHours);
    runAction(event.submitter, '#profile-error', async () => {
      if (!Number.isInteger(values.weeklyHours) || values.weeklyHours < 1 || values.weeklyHours > 40) throw new Error('每周可投入时间应为 1 到 40 的整数小时。');
      await writeState('/api/profile', 'POST', values, { profileRefresh: true });
      showToast('工作底稿已保存，后续计划将使用这些设置。');
    });
  });

  $('#plan-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    if ((editorDirty() || publishDirty()) && !window.confirm('创建成功后将打开新计划，当前未保存的内容或网址会被丢弃。确定继续吗？')) return;
    const count = Number($('#plan-count').value);
    const existing = new Set(state.items.map(item => item.id));
    runAction(event.submitter, '#plan-error', async () => {
      await writeState('/api/plan', 'POST', { count });
      const created = state.items.filter(item => !existing.has(item.id));
      if (created.length) {
        ui.selectedId = created[0].id;
        ui.filter = 'all';
        ui.editorRefresh = true;
        ui.discardPublish = true;
      }
      showToast(created.length ? '已新增 ' + created.length + ' 条模板计划，选择一条开始完善。' : '计划已更新，没有新增重复选题。');
    });
  });

  let aiPlanSuggestions = [];

  function updateAiPlanFooter() {
    const checkboxes = $$('#ai-plan-candidates input[type="checkbox"]');
    const selected = [];
    let minutes = 0;
    checkboxes.forEach((cb, idx) => {
      if (cb.checked && aiPlanSuggestions[idx]) {
        selected.push(aiPlanSuggestions[idx]);
        minutes += (aiPlanSuggestions[idx].estimatedMinutes || 40);
      }
    });
    text('#ai-plan-total-time', '已选 ' + selected.length + ' 个选题，合计耗时约 ' + minutes + ' 分钟');
    $('#ai-plan-confirm').disabled = selected.length === 0;
  }

  function renderAiPlanPanel(data) {
    aiPlanSuggestions = data?.candidates || [];
    const panel = $('#ai-plan-panel');
    const container = $('#ai-plan-candidates');
    container.replaceChildren();
    if (!aiPlanSuggestions.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    text('#ai-plan-summary', '智能体基于剩余 ' + data.remainingMinutes + ' 分钟工时推荐了 ' + aiPlanSuggestions.length + ' 个选题（' + (data.reason || '围绕定位与资料') + '）：');

    aiPlanSuggestions.forEach((c, index) => {
      const card = el('div', 'candidate-card');
      card.dataset.index = index;

      const header = el('div', 'candidate-header');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'cand-' + index;
      checkbox.checked = true;

      const title = el('label', 'candidate-title', c.title);
      title.htmlFor = 'cand-' + index;
      header.append(checkbox, title);

      const angle = el('p', 'candidate-angle', '【切入角度】' + c.angle);
      const reason = el('p', 'candidate-reason', '【推荐理由】' + c.reason);

      const meta = el('div', 'candidate-meta');
      const badge = el('span', 'candidate-badge', c.estimatedMinutes + ' 分钟');
      const sourcesUsed = (c.sourceIds || []).map(sid => {
        const s = state.sources.find(src => src.id === sid);
        return s ? s.title : '资料';
      }).join('、');
      const srcText = el('span', '', '依据：' + (sourcesUsed.length > 20 ? sourcesUsed.slice(0, 20) + '…' : sourcesUsed));
      meta.append(badge, srcText);

      card.append(header, angle, reason, meta);
      card.classList.toggle('selected', checkbox.checked);

      checkbox.addEventListener('change', () => {
        card.classList.toggle('selected', checkbox.checked);
        updateAiPlanFooter();
      });

      container.append(card);
    });

    updateAiPlanFooter();
  }

  $('#ai-plan-btn').addEventListener('click', event => {
    if (busy) return;
    runAction(event.currentTarget, '#plan-error', async () => {
      text('#plan-error', '');
      $('#plan-error').hidden = true;
      const res = await request('/api/plan/ai-suggest', { method: 'POST', body: {} });
      renderAiPlanPanel(res);
      showToast('AI 智能体规划了 ' + res.candidates.length + ' 个选题建议，请在下方预览勾选。');
    });
  });

  $('#ai-plan-close').addEventListener('click', () => {
    $('#ai-plan-panel').hidden = true;
    aiPlanSuggestions = [];
  });

  $('#ai-plan-confirm').addEventListener('click', event => {
    if (busy) return;
    const checkboxes = $$('#ai-plan-candidates input[type="checkbox"]');
    const selected = [];
    checkboxes.forEach((cb, idx) => {
      if (cb.checked && aiPlanSuggestions[idx]) {
        selected.push(aiPlanSuggestions[idx]);
      }
    });
    if (!selected.length) return;
    const existing = new Set(state.items.map(item => item.id));
    runAction(event.currentTarget, '#ai-plan-error', async () => {
      await writeState('/api/plan', 'POST', { items: selected });
      $('#ai-plan-panel').hidden = true;
      aiPlanSuggestions = [];
      const created = state.items.filter(item => !existing.has(item.id));
      if (created.length) {
        ui.selectedId = created[0].id;
        ui.filter = 'all';
        ui.editorRefresh = true;
        ui.discardPublish = true;
      }
      showToast('已采纳并创建 ' + created.length + ' 条个性化选题任务！');
    });
  });

  $('#editor-title').addEventListener('input', syncEditorActions);
  $('#editor-body').addEventListener('input', syncEditorActions);
  $('#human-confirm').addEventListener('change', syncEditorActions);

  $('#editor-form').addEventListener('submit', event => {
    event.preventDefault();
    runAction(event.submitter, '#editor-error', async () => {
      await saveEditorIfDirty();
      showToast('草稿已保存。修改后的版本需要重新检查与人工确认。');
    });
  });

  $('#generate-draft').addEventListener('click', event => {
    const item = currentItem();
    if (!item || busy || item.status === 'published' || item.body || $('#editor-body').value.trim()) return;
    if ((editorDirty() || publishDirty()) && !window.confirm('模板起草成功后会丢弃未保存的修改或发布网址输入。确定继续吗？此操作不花费预算。')) return;
    runAction(event.currentTarget, '#editor-error', async () => {
      await writeState('/api/items/' + encodeURIComponent(item.id) + '/draft', 'POST', {}, { editorRefresh: true, discardPublish: true });
      showToast('模板草稿已保存，未调用模型、不花费预算。请结合真实体验核实和改写。');
    });
  });

  $('#ai-draft').addEventListener('click', event => {
    const item = currentItem();
    if (!item || busy || item.status === 'published') return;
    runAction(event.currentTarget, '#editor-error', async () => {
      const latest = await loadConnectionStatus();
      if (!latest || !aiConnection.view().canGenerateDraft) {
        throw new Error(aiConnection.view().reason + ' 未发送生成请求，原稿和输入均保留。');
      }
      if ((editorDirty() || publishDirty()) && !window.confirm('有未保存的内容或发布网址。AI 起草成功后会丢弃这些输入，失败仍保留。确定继续吗？')) return;
      if ((item.body || item.status === 'approved') && !window.confirm('AI 起草成功后将替换当前标题和正文，并使已有检查与人工审批失效；需要重新检查和人工确认。确定重新生成吗？')) return;
      if (!window.confirm('会向DeepSeek发送当前账号定位和所选参考资料，最多预留¥0.10测试预算；不自动发布。是否继续？')) return;
      // Native confirmation dialogs can outlive both deadlines while timers are suspended.
      if (!aiConnection.view().canGenerateDraft) {
        throw new Error('确认期间 AI 状态已过期或价格核验已到期。未发送生成请求，输入已保留；请刷新AI状态后重新确认。');
      }
      try {
        await writeState('/api/items/' + encodeURIComponent(item.id) + '/ai-draft', 'POST', {}, { editorRefresh: true, discardPublish: true });
      } catch (error) {
        const suffix = error?.code === 'needs_materials' || error?.code === 'needs_clarification'
          ? ' 这是资料不足或需要澄清导致的受控停止，不是网络故障；未覆盖原稿，补充资料后可再试。'
          : ' 未自动重试或改用模板，原有编辑输入已保留。';
        throw new Error((error instanceof Error ? error.message : 'AI 起草未确认完成。') + suffix);
      } finally {
        await loadConnectionStatus();
      }
      showToast('AI 草稿已保存，请重新检查与人工确认；' + remainingBudget() + '。');
    });
  });

  $('#review-draft').addEventListener('click', event => {
    const item = currentItem();
    if (!item) return;
    runAction(event.currentTarget, '#editor-error', async () => {
      await saveEditorIfDirty();
      await writeState('/api/items/' + encodeURIComponent(item.id) + '/review', 'POST', {}, { editorRefresh: true });
      showToast('规则检查已完成。请阅读结果并自行核实事实。');
    });
  });

  $('#approve-form').addEventListener('submit', event => {
    event.preventDefault();
    const item = currentItem();
    if (!item || busy) return;
    const confirmed = $('#human-confirm').checked;
    runAction(event.submitter, '#editor-error', async () => {
      if (editorDirty()) throw new Error('内容尚未保存，请先保存并重新检查。');
      if (!confirmed) throw new Error('请先勾选人工核实声明，再确认可发布。');
      if (!item.review || item.review.revision !== item.revision) throw new Error('请先检查当前版本。');
      if (item.review.checks.some(check => check.level === 'blocker')) throw new Error('仍有需修正项，请修改后重新检查。');
      await writeState('/api/items/' + encodeURIComponent(item.id) + '/approve', 'POST', {}, { editorRefresh: true });
      showToast('人工确认已记录。请自行去平台发布，再回来登记网址。');
    });
  });

  $('#publish-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const item = currentItem();
    const value = $('#published-url').value.trim();
    if (!item) return;
    runAction(event.submitter, '#editor-error', async () => {
      if (editorDirty() || item.status !== 'approved') throw new Error('请先保存、检查并人工确认当前版本。');
      const url = safeUrl(value);
      if (!url) throw new Error('请填写完整的 https:// 发布内容网址，不要填写账号密码。');
      await writeState('/api/items/' + encodeURIComponent(item.id) + '/publish', 'POST', { url }, { editorRefresh: true, metricsRefresh: true });
      report = null;
      reportSequence += 1;
      reportLoading = false;
      $('#report-loading').hidden = true;
      showToast('已登记发布网址。此操作没有向平台发布内容。');
    });
  });

  $('#export-draft').addEventListener('click', event => {
    const item = currentItem();
    if (!item) return;
    runAction(event.currentTarget, '#editor-error', async () => {
      await saveEditorIfDirty();
      const saved = currentItem();
      if (!saved.body?.trim()) throw new Error('请先生成或填写草稿正文。');
      downloadDraft(saved);
      showToast('已导出本地保存版本的 TXT，请人工核实后使用。');
    });
  });

  $('#archive-draft-btn')?.addEventListener('click', event => {
    const item = currentItem();
    if (!item || item.status === 'published') return;
    runAction(event.currentTarget, '#editor-error', async () => {
      await saveEditorIfDirty();
      const current = currentItem();
      await writeState('/api/items/' + encodeURIComponent(current.id) + '/archive', 'POST', {}, { editorRefresh: true });
      ui.selectedId = null;
      ui.renderedId = null;
      showToast(`已将「${current.title}」移入归档，已从活跃任务列表中隐去`);
      renderStudio();
      renderArchivedList();
    });
  });

  function cleanSubtitleToTranscript(raw) {
    if (!raw || typeof raw !== 'string') return { title: '', content: '' };
    let text = raw.replace(/^WEBVTT[^\n]*\n+/i, '');
    text = text.replace(/^\d+[\r\n]+(?=\d{1,2}:\d{2})/gm, '');
    text = text.replace(/^\d{1,2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,\.]\d{3}[^\r\n]*$/gm, '');
    text = text.replace(/^\d{1,2}:\d{2}[,\.]\d{3}\s*-->\s*\d{1,2}:\d{2}[,\.]\d{3}[^\r\n]*$/gm, '');
    text = text.replace(/^\s*\d+\s*$/gm, '');
    text = text.replace(/<\/?\d{2}:\d{2}[^>]*>/g, '');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const cleaned = lines.join(' ');
    const firstSentence = (cleaned.split(/[。！？!?]/)[0] || '').trim();
    const recommendedTitle = firstSentence.length >= 3 ? (firstSentence.length > 35 ? firstSentence.slice(0, 34) + '…' : firstSentence) : '短视频口播文案';
    return { title: recommendedTitle, content: cleaned };
  }

  // 素材资产库选项卡与字幕解析交互
  const sourceTypeTabs = $$('.source-type-tab');
  sourceTypeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      sourceTypeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.sourceType;
      $('#source-type-input').value = type;
      const dropzone = $('#subtitle-upload-box');
      const titleLabel = $('#source-title-label');
      const contentLabel = $('#source-content-label');
      const titleInput = $('#source-form [name="title"]');
      const contentInput = $('#source-form [name="content"]');
      const modeIntro = $('#source-mode-intro');
      const hint = $('#source-hint');

      if (type === 'video_transcript') {
        dropzone.hidden = false;
        titleLabel.textContent = '视频 / 台词标题';
        contentLabel.textContent = '口播正文台词';
        titleInput.placeholder = '例如：高效工作的3个底层逻辑';
        contentInput.placeholder = '支持直接在上方拖入剪映导出的 .srt / .vtt 字幕文件，系统将自动去除分秒时间戳并转换为通顺的口播台词。';
        modeIntro.textContent = '支持剪映等字幕文件直接导入，自动剔除分秒时间码并拼成完整口播稿，供后续延展创作与复用。';
        hint.textContent = '短视频台词来源于你已剪辑或录制的内容，无需填写网址。';
      } else if (type === 'manual_post') {
        dropzone.hidden = true;
        titleLabel.textContent = '笔记 / 选题标题';
        contentLabel.textContent = '高赞正文或爆款拆解';
        titleInput.placeholder = '例如：重阳来历不必玄，一盅秋茶里的岁时心意';
        contentInput.placeholder = '粘贴你在小红书、朋友圈发过的高赞文案，或收藏的同行爆款结构。';
        modeIntro.textContent = '记录自己或同赛道的高赞文案，AI 在起草和规划时将参考这套语气风格与行文节奏。';
        hint.textContent = '如果是同行爆款，可将笔记原链接附在下方，便于追溯。';
      } else {
        dropzone.hidden = true;
        titleLabel.textContent = '资料标题';
        contentLabel.textContent = '资料正文';
        titleInput.placeholder = '例如：某款工具的官方功能说明';
        contentInput.placeholder = '写下可核实的信息，并注明适用条件与时间。避免粘贴个人隐私或机密。';
        modeIntro.textContent = '粘贴公开干货、产品说明或自己的实测记录。保存后供 AI 规划与起草调用。';
        hint.textContent = '自己的经验或台词可以不填网址。资料内容仍需人工核实，不等于已完成检索验证。';
      }
    });
  });

  const dropTrigger = $('#subtitle-drop-trigger');
  const fileInput = $('#subtitle-file-input');
  if (dropTrigger && fileInput) {
    dropTrigger.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        const { title, content } = cleanSubtitleToTranscript(raw);
        if (!content) {
          showToast('未能从文件中提取出有效字幕文本，请检查文件格式。', 'error');
          return;
        }
        $('#source-form [name="title"]').value = title;
        $('#source-form [name="content"]').value = content;
        showToast(`已成功解析字幕：提取出 ${content.length} 字完整口播台词！`);
      } catch (err) {
        showToast('读取字幕文件失败：' + err.message, 'error');
      }
    });

    const dropzoneBox = $('#subtitle-upload-box');
    dropzoneBox.addEventListener('dragover', e => {
      e.preventDefault();
      dropzoneBox.classList.add('drag-over');
    });
    dropzoneBox.addEventListener('dragleave', () => dropzoneBox.classList.remove('drag-over'));
    dropzoneBox.addEventListener('drop', async e => {
      e.preventDefault();
      dropzoneBox.classList.remove('drag-over');
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      try {
        const raw = await file.text();
        const { title, content } = cleanSubtitleToTranscript(raw);
        if (!content) {
          showToast('未能从文件中提取出有效字幕文本，请检查文件格式。', 'error');
          return;
        }
        $('#source-form [name="title"]').value = title;
        $('#source-form [name="content"]').value = content;
        showToast(`已成功解析字幕：提取出 ${content.length} 字完整口播台词！`);
      } catch (err) {
        showToast('读取字幕文件失败：' + err.message, 'error');
      }
    });
  }

  $('#source-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    runAction(event.submitter, '#source-error', async () => {
      const title = values.title.trim();
      const content = values.content.trim();
      if (!title || !content) throw new Error('请填写资料标题和正文，不能只有空格。');
      const sourceType = values.sourceType || 'text';
      const payload = { title, content, sourceType };
      if (values.url && values.url.trim()) {
        const url = safeUrl(values.url.trim());
        if (!url) throw new Error('来源网址请以 https:// 开头，也可以留空。');
        payload.url = url;
      }
      await writeState('/api/sources', 'POST', payload);
      form.reset();
      $('#source-type-input').value = sourceType;
      stampForm(form);
      const tip = sourceType === 'video_transcript' ? '短视频台词已保存入库。' : (sourceType === 'manual_post' ? '历史高赞文案已保存入库。' : '参考资料已保存。');
      showToast(tip + ' 生成新草稿时会使用当时已有的资料。');
    });
  });

  $('#metrics-item').addEventListener('change', event => {
    if (busy) return;
    const select = event.currentTarget;
    const targetId = select.value;
    select.value = ui.metricsSelected;
    if (formDirty($('#metrics-form')) && !window.confirm('当前指标尚未保存，确定丢弃输入并切换到另一条内容吗？')) return;
    select.value = targetId;
    fillMetrics(targetId);
  });

  $('#metrics-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    runAction(event.submitter, '#metrics-error', async () => {
      const payload = {};
      for (const name of ['views', 'likes', 'comments', 'saves']) {
        const value = Number(values[name]);
        if (!values[name]?.trim() || !Number.isSafeInteger(value) || value < 0 || value > 1000000000) throw new Error('四项指标都必须填写 0 到 1000000000 的真实整数；未知数据不要用 0 代替。');
        payload[name] = value;
      }
      const item = state.items.find(candidate => candidate.id === values.itemId);
      if (!item || item.status !== 'published') throw new Error('请先选择已登记发布的内容。');
      await writeState('/api/items/' + encodeURIComponent(item.id) + '/metrics', 'POST', payload, { metricsRefresh: true, metricsSelected: item.id });
      report = null;
      const refreshed = await loadReport();
      showToast(refreshed ? '实际数据已保存，复盘已更新。' : '实际数据已保存；复盘暂未刷新，可稍后重试读取。');
    });
  });

  $('#refresh-report').addEventListener('click', () => {
    if (!busy && !reportLoading) loadReport();
  });

  $('#refresh-ai-status').addEventListener('click', () => {
    if (!busy) loadConnectionStatus();
  });
  window.addEventListener('focus', () => {
    if (!busy) loadConnectionStatus();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) aiConnection.invalidate();
  });

  $('#copy-draft-btn')?.addEventListener('click', async () => {
    const body = $('#editor-body').value;
    if (!body.trim()) {
      showToast('当前草稿正文为空，请先起草或填写内容。', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(body);
      showToast('正文已成功复制到剪贴板，可粘贴至小红书发布！');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = body;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('正文已复制到剪贴板！');
    }
  });

  $('#preview-card-btn')?.addEventListener('click', () => {
    const item = currentItem();
    if (!item) {
      showToast('请先选择或创建一篇内容。', true);
      return;
    }
    const editorTitle = $('#editor-title')?.value.trim();
    const editorBody = $('#editor-body')?.value.trim();
    const virtualItem = {
      ...item,
      title: editorTitle || item.title,
      body: editorBody !== undefined ? editorBody : item.body,
    };
    openCardGenerator(virtualItem);
  });

  $('#card-gen-close')?.addEventListener('click', closeCardGenerator);
  $('#card-generator-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'card-generator-modal') closeCardGenerator();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#card-generator-modal')?.hidden) {
      closeCardGenerator();
    }
  });

  $$('#card-theme-options .theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentCardTheme = btn.dataset.theme || 'theme-warm';
      $$('#card-theme-options .theme-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderCardPreview(currentCardItem, currentCardMode, currentCardTheme);
    });
  });

  $('#card-extract-mode')?.addEventListener('change', (e) => {
    currentCardMode = e.target.value || 'question';
    const pointGroup = $('#card-custom-point-group');
    if (pointGroup) pointGroup.hidden = currentCardMode !== 'question';
    renderCardPreview(currentCardItem, currentCardMode, currentCardTheme);
  });

  $('#card-custom-question')?.addEventListener('input', () => {
    if (currentCardItem) renderCardPreview(currentCardItem, currentCardMode, currentCardTheme);
  });

  $('#card-custom-sub')?.addEventListener('input', () => {
    if (currentCardItem) renderCardPreview(currentCardItem, currentCardMode, currentCardTheme);
  });

  $('#card-custom-point')?.addEventListener('input', () => {
    if (currentCardItem) renderCardPreview(currentCardItem, currentCardMode, currentCardTheme);
  });

  $('#card-regen-question-btn')?.addEventListener('click', () => {
    if (!currentCardItem) return;
    const hook = generateQuestionHook(currentCardItem);
    if ($('#card-custom-question')) $('#card-custom-question').value = hook.title;
    if ($('#card-custom-sub')) $('#card-custom-sub').value = hook.sub;
    if ($('#card-custom-point')) $('#card-custom-point').value = hook.point;
    renderHashtagsChips(currentCardItem);
    renderCardPreview(currentCardItem, currentCardMode, currentCardTheme);
    showToast('已重新提取并刷新封面疑问句与话题！');
  });

  $('#card-copy-tags-btn')?.addEventListener('click', async () => {
    if (!currentCardItem) return;
    const tags = generateHashtags(currentCardItem).join(' ');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(tags);
      } else {
        const ta = document.createElement('textarea');
        ta.value = tags;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast(`已成功复制全部热门话题：${tags}`);
    } catch {
      showToast('复制话题标签失败，请手动选取复制。', true);
    }
  });

  $('#download-card-png-btn')?.addEventListener('click', () => {
    if (!currentCardItem) return;
    downloadCardImage(currentCardItem, currentCardMode, currentCardTheme);
  });

  $('#copy-text-from-modal-btn')?.addEventListener('click', async () => {
    if (!currentCardItem) return;
    const tags = generateHashtags(currentCardItem).join(' ');
    const fullText = (currentCardItem.title ? currentCardItem.title + '\n\n' : '') +
      (currentCardItem.body || '') +
      '\n\n' + tags;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(fullText);
      } else {
        const ta = document.createElement('textarea');
        ta.value = fullText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast('文案与热门话题已成功复制！可直接在小红书、抖音图文粘贴发布。');
    } catch {
      showToast('复制文案失败，请在页面手动复制。', true);
    }
  });

  let currentDiagnosed = null;
  $('#diagnose-idea-btn')?.addEventListener('click', event => {
    const input = $('#idea-input');
    const idea = input ? input.value.trim() : '';
    if (!idea || idea.length < 3) {
      showToast('请输入至少 3 个字的灵感或粗选题想法。', true);
      return;
    }
    runAction(event.currentTarget, '#plan-error', async () => {
      const res = await request('/api/plan/evaluate-idea', {
        method: 'POST',
        body: { idea },
      });
      currentDiagnosed = res;
      $('#idea-diagnosis-result').hidden = false;
      const badge = $('#idea-fit-badge');
      const fits = {
        recommended: { text: '契合推荐', cls: 'status-approved' },
        needs_materials: { text: '缺少资料', cls: 'status-reviewed' },
        off_topic: { text: '偏离定位', cls: 'status-draft' },
      };
      const fitInfo = fits[res.fit] || fits.recommended;
      badge.textContent = fitInfo.text;
      badge.className = 'status-pill ' + fitInfo.cls;
      text('#idea-est-time', `预计 ${res.estimatedMinutes || 40} 分钟`);
      text('#idea-fit-reason', res.fitReason);
      text('#idea-evidence-eval', `【资料支撑度】${res.evidenceEvaluation}`);
      text('#idea-rec-title', res.recommendedTitle);
      text('#idea-rec-angle', `【切入角度】${res.recommendedAngle}`);
      showToast('灵感可行性诊断已完成！');
    });
  });

  $('#adopt-diagnosed-idea-btn')?.addEventListener('click', event => {
    if (!currentDiagnosed) return;
    const existing = new Set(state.items.map(item => item.id));
    runAction(event.currentTarget, '#plan-error', async () => {
      await writeState('/api/plan', 'POST', {
        items: [{
          title: currentDiagnosed.recommendedTitle,
          angle: currentDiagnosed.recommendedAngle,
          reason: `灵感诊断采纳：${currentDiagnosed.fitReason}`,
          estimatedMinutes: currentDiagnosed.estimatedMinutes,
          sourceIds: currentDiagnosed.matchedSourceIds,
        }],
      });
      $('#idea-diagnosis-result').hidden = true;
      $('#idea-input').value = '';
      currentDiagnosed = null;
      const created = state.items.filter(item => !existing.has(item.id));
      if (created.length) {
        ui.selectedId = created[0].id;
        ui.filter = 'all';
        ui.editorRefresh = true;
        ui.discardPublish = true;
      }
      showToast('新选题已成功采纳进入任务队列！');
    });
  });

  function openSettings(tab = 'profile') {
    const modal = $('#settings-modal');
    if (!modal) return;
    modal.hidden = false;
    switchSettingsTab(tab);
    renderSettings();
  }

  function closeSettings() {
    const modal = $('#settings-modal');
    if (modal) modal.hidden = true;
  }

  function switchSettingsTab(tab) {
    const validTabs = ['profile', 'ai', 'archived', 'account'];
    const activeTab = validTabs.includes(tab) ? tab : 'profile';
    validTabs.forEach(t => {
      const btn = $(`#settings-tab-${t}`);
      const pane = $(`#settings-pane-${t}`);
      if (btn) btn.classList.toggle('active', t === activeTab);
      if (pane) pane.hidden = t !== activeTab;
    });
    if (activeTab === 'archived') {
      renderArchivedList();
    }
    if (activeTab === 'account') {
      renderAccountSettings();
    }
  }

  function renderSettings() {
    fillModalProfile();
    fillAiSettings();
    renderArchivedList();
    renderAccountSettings();
  }

  function renderAccountSettings() {
    const name = state?.profile?.name || '独立创作者';
    const avatarEl = $('#account-avatar-preview');
    const nameEl = $('#account-display-name');
    if (avatarEl) avatarEl.textContent = name.trim().charAt(0) || '创';
    if (nameEl) nameEl.textContent = name;
  }

  function fillAiSettings() {
    const prov = aiConnection.data?.provider || 'DeepSeek';
    const select = $('#ai-provider-select');
    if (select) {
      select.value = prov;
      const meta = PROVIDER_METAS[prov] || PROVIDER_METAS.DeepSeek;
      $('#ai-model-input').value = aiConnection.data?.model || meta.defaultModel;
      $('#ai-baseurl-input').value = aiConnection.data?.baseUrl || meta.baseUrl;
      const link = $('#ai-key-link');
      if (link) {
        if (meta.keyLink) {
          link.href = meta.keyLink;
          link.textContent = meta.keyLink + ' ↗';
          link.parentElement.hidden = false;
        } else {
          link.parentElement.hidden = true;
        }
      }
    }
  }

  function renderArchivedList() {
    const container = $('#archived-list');
    if (!container || !state?.items) return;
    container.replaceChildren();
    const archived = state.items.filter(item => item.archived);
    text('#archived-tasks-badge', String(archived.length));
    text('#archived-count-chip', `${archived.length} 条归档`);
    text('#archived-tasks-caption', `已归档 ${archived.length} 个选题`);

    if (!archived.length) {
      container.append(emptyState(
        '暂无归档选题',
        '在「创作空间」点击任务下方的「移入归档」，不匹配或暂不撰写的选题将从任务列表隐去并保存在这里，避免误删并释放每周工时。',
        'book'
      ));
      return;
    }

    archived.forEach((item, index) => {
      const card = el('article', 'archived-card');
      const header = el('div', 'archived-card-header');
      const titleGroup = el('div', 'archived-title-group');
      titleGroup.append(
        el('span', 'archived-index', `#${String(index + 1).padStart(2, '0')}`),
        el('h3', 'archived-title', item.title),
        statusPill(item.status)
      );
      const meta = el('div', 'archived-meta', `原预计耗时 ${item.estimatedMinutes} 分钟 · 第 ${item.revision} 版`);
      header.append(titleGroup, meta);

      const body = el('div', 'archived-card-body');
      if (item.angle) {
        body.append(el('p', 'archived-angle', `切入角度：${item.angle}`));
      }
      if (item.reason) {
        body.append(el('p', 'archived-reason', `选题理由：${item.reason}`));
      }

      const actions = el('div', 'archived-card-actions');
      const unarchiveBtn = el('button', 'btn btn-secondary btn-small', '恢复到任务队列');
      unarchiveBtn.type = 'button';
      unarchiveBtn.title = '将该选题移回活跃任务队列，重新计入每周工时预算';
      unarchiveBtn.addEventListener('click', async () => {
        await writeState('/api/items/' + encodeURIComponent(item.id) + '/unarchive', 'POST', {}, { editorRefresh: true });
        showToast(`已将「${item.title}」恢复至任务队列，重新计入本周工时预算`);
        renderArchivedList();
      });

      const deleteBtn = el('button', 'btn btn-quiet btn-danger-text btn-small', '彻底删除');
      deleteBtn.type = 'button';
      deleteBtn.title = '永久删除此选题（不可恢复）';
      deleteBtn.addEventListener('click', async () => {
        if (item.status === 'published') {
          showToast('已发布内容已计入发布历史，不能删除。');
          return;
        }
        if (!window.confirm(`确定要彻底删除已归档选题「${item.title}」吗？\n删除后不可恢复。`)) return;
        await writeState('/api/items/' + encodeURIComponent(item.id), 'DELETE', {}, { editorRefresh: true });
        showToast(`已彻底删除选题「${item.title}」`);
        renderArchivedList();
      });

      actions.append(unarchiveBtn, deleteBtn);
      card.append(header, body, actions);
      container.append(card);
    });
  }

  function toggleAiPopover(force) {
    const popover = $('#ai-status-popover');
    const badge = $('#mode-badge');
    if (!popover || !badge) return;
    const shouldShow = typeof force === 'boolean' ? force : popover.hidden;
    popover.hidden = !shouldShow;
    badge.setAttribute('aria-expanded', String(shouldShow));
  }

  $('#mode-badge')?.addEventListener('click', () => toggleAiPopover());
  $('#close-ai-popover')?.addEventListener('click', () => toggleAiPopover(false));
  $('#popover-settings-btn')?.addEventListener('click', () => {
    toggleAiPopover(false);
    openSettings('ai');
  });

  document.addEventListener('click', event => {
    const popover = $('#ai-status-popover');
    if (!popover || popover.hidden) return;
    if (!event.target.closest('#ai-status-container')) {
      toggleAiPopover(false);
    }
  });

  $('#open-settings-modal')?.addEventListener('click', () => openSettings('profile'));
  $('#close-settings-modal')?.addEventListener('click', closeSettings);
  $('#settings-modal')?.addEventListener('click', event => {
    if (event.target === $('#settings-modal')) closeSettings();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#settings-modal')?.hidden) {
      closeSettings();
    }
  });

  $('#open-profile-btn')?.addEventListener('click', () => openSettings('profile'));
  $('#sidebar-settings-btn')?.addEventListener('click', () => openSettings('profile'));
  $('#open-settings-btn')?.addEventListener('click', () => openSettings('profile'));
  $('#settings-tab-profile')?.addEventListener('click', () => switchSettingsTab('profile'));
  $('#settings-tab-ai')?.addEventListener('click', () => switchSettingsTab('ai'));
  $('#settings-tab-archived')?.addEventListener('click', () => switchSettingsTab('archived'));
  $('#settings-tab-account')?.addEventListener('click', () => switchSettingsTab('account'));

  $('#saas-login-btn')?.addEventListener('click', () => {
    const userInput = $('#saas-user-input')?.value?.trim();
    if (!userInput) {
      showToast('请输入创作者账号或邮箱');
      $('#saas-user-input')?.focus();
      return;
    }
    showToast('当前处于本地单机工作区模式，数据全部保存在本机。公网多租户云端版本就绪后将直接支持无缝登录！');
  });

  $('#saas-register-btn')?.addEventListener('click', () => {
    showToast('当前单机模式拥有最高创作者权限，数据保存在本机。公网 SaaS 开放注册时可一键迁移。');
  });

  function fillModalProfile() {
    const form = $('#modal-profile-form');
    if (!form || !state?.profile) return;
    ['name', 'audience', 'positioning', 'platform', 'tone', 'weeklyHours', 'goal'].forEach(name => {
      if (form.elements.namedItem(name)) form.elements.namedItem(name).value = state.profile[name] ?? '';
    });
    stampForm(form);
  }

  $('#modal-profile-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    values.weeklyHours = Number(values.weeklyHours);
    runAction(event.submitter, '#modal-profile-error', async () => {
      if (!Number.isInteger(values.weeklyHours) || values.weeklyHours < 1 || values.weeklyHours > 40) throw new Error('每周可投入时间应为 1 到 40 的整数小时。');
      await writeState('/api/profile', 'POST', values, { profileRefresh: true });
      showToast('人设工作底稿已保存！');
    });
  });

  $('#ai-provider-select')?.addEventListener('change', () => {
    const p = $('#ai-provider-select').value;
    const meta = PROVIDER_METAS[p] || PROVIDER_METAS.DeepSeek;
    $('#ai-model-input').value = meta.defaultModel;
    $('#ai-baseurl-input').value = meta.baseUrl;
    const link = $('#ai-key-link');
    if (link) {
      if (meta.keyLink) {
        link.href = meta.keyLink;
        link.textContent = meta.keyLink + ' ↗';
        link.parentElement.hidden = false;
      } else {
        link.parentElement.hidden = true;
      }
    }
  });

  $('#ai-key-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const provider = $('#ai-provider-select').value;
    const model = $('#ai-model-input').value.trim();
    const baseUrl = $('#ai-baseurl-input').value.trim();
    const apiKey = $('#ai-key-input').value.trim();
    runAction(event.submitter, '#ai-key-feedback', async () => {
      if (!apiKey) throw new Error('请输入 API Key 密钥。');
      const payload = { provider, model, baseUrl, apiKey, overwrite: true };
      await request('/api/connection/key', { method: 'POST', body: payload });
      $('#ai-key-input').value = '';
      await loadConnectionStatus();
      showToast(`已成功验证并保存 ${provider} 凭据（DPAPI 本机加密锁定）！`);
    });
  });

  $$('form[data-track]').forEach(stampForm);
  renderNavigation();
  boot();
})();
