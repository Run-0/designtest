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
  const pageNames = { overview: '工作台', studio: '创作空间', sources: '知识库', report: '数据复盘', roadmap: '毕设路线' };
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

  function statCard(label, value, foot, iconName) {
    const card = el('div', 'stat-card');
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
    const target = $(selector);
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
      text('#mode-badge', `⚡ ${provider} · 就绪`);
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
    return !$('#publish-form').hidden && formDirty($('#publish-form'));
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
    return Object.hasOwn(pageNames, candidate) ? candidate : 'overview';
  }

  function navigate(page, options = {}) {
    if (!Object.hasOwn(pageNames, page) || busy) return false;
    if (ui.page === 'studio' && page !== 'studio' && !confirmLeaveEditor()) return false;
    ui.page = page;
    if (options.updateHistory !== false && window.location.hash !== '#' + page) {
      window.history.pushState(null, '', '#' + page);
    }
    renderNavigation();
    if (options.focus !== false && state) {
      const heading = $('#' + page + '-title');
      heading.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
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
      statCard('全部内容', number(state.items.length), '包含计划到发布的全部状态', 'file'),
      statCard('草稿内容', number(draftCount), '草稿与已检查、未人工确认', 'pen'),
      statCard('待发布', number(state.items.filter(item => item.status === 'approved').length), '已人工确认，等待自行发布', 'shield'),
      statCard('已登记发布', number(state.items.filter(item => item.status === 'published').length), '仅代表已登记发布网址', 'link')
    );
    const recent = $('#recent-items');
    recent.replaceChildren();
    const items = newest(state.items, 'updatedAt').slice(0, 4);
    if (!items.length) {
      recent.append(emptyState('你的第一条内容，还在等你', '先创建一条计划，再逐步把想法写完整。', 'pen', '去创建计划', () => navigate('studio'), true));
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

  function renderFilters() {
    const filters = $('#status-filters');
    filters.replaceChildren();
    Object.entries({ all: '全部', ...statusNames }).forEach(([value, label]) => {
      const count = value === 'all' ? state.items.length : state.items.filter(item => item.status === value).length;
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
    const items = newest(state.items).filter(item => ui.filter === 'all' || item.status === ui.filter);
    if (!items.length) {
      const title = state.items.length ? '这个状态下还没有内容' : '先计划一条，让创作开始';
      const description = state.items.length ? '切换到其他状态，或创建新的内容计划。正在编辑的内容会继续保留。' : '选择上方计划数量，点击「生成模板计划」。每条预计 40 分钟，请量力而行。';
      list.append(emptyState(title, description, 'pen', state.items.length ? '查看全部内容' : '设置计划数量', () => {
        if (state.items.length) { ui.filter = 'all'; renderFilters(); renderContentList(); }
        else $('#plan-count').focus();
      }));
      return;
    }
    items.forEach((item, index) => {
      const card = button('', 'content-card' + (item.id === ui.selectedId ? ' selected' : ''), () => openItem(item.id));
      card.setAttribute('aria-pressed', String(item.id === ui.selectedId));
      const top = el('span', 'content-card-top');
      top.append(el('span', 'content-card-index', '内容 ' + String(index + 1).padStart(2, '0')), statusPill(item.status));
      const foot = el('span', 'content-card-foot');
      const estimate = el('span');
      estimate.append(icon('clock'), document.createTextNode('预计 ' + number(item.estimatedMinutes) + ' 分钟'));
      foot.append(estimate, el('span', '', '第 ' + number(item.revision) + ' 版'));
      if (item.archived) foot.append(el('span', 'status-pill', '📦 已归档'));
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
    if (!item) { ui.renderedId = null; return; }
    const preserveUrl = ui.renderedId === item.id && !ui.discardPublish ? $('#published-url').value : '';
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
    $('#publish-form').hidden = item.status === 'published';
    $('#published-info').hidden = item.status !== 'published';
    $('#published-url').value = item.status === 'published' ? (item.publishedUrl || '') : '';
    stampForm($('#publish-form'));
    if (item.status !== 'published') $('#published-url').value = preserveUrl;
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
      target.append(el('h3', '', '📌 知识切片溯源引用依据（轻量 RAG）'));
      const citationList = el('div', 'citation-list');
      citations.forEach(c => {
        const itemEl = el('div', 'citation-card');
        const badge = el('span', 'citation-badge', `[${c.ref}]`);
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
      const summary = el('summary', '', `🔍 命中的知识切片微段落（共 ${retrievedChunks.length} 个）`);
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
        countEl.textContent = `${bodyLen} 字符 · 达标 🟢`;
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
      text('#archive-draft-btn span', item.archived ? '📦 移出归档（计入本周）' : '📦 移入归档（不占本周）');
    }
    $('#review-draft').disabled = published || !validText;
    text('#review-draft', dirty ? '保存并规则检查' : '运行规则检查');
    $('#human-confirm').disabled = !reviewed || blocked || published;
    $('#approve-draft').disabled = !reviewed || blocked || !$('#human-confirm').checked || published;
    $('#published-url').disabled = item.status !== 'approved' || dirty;
    $('#publish-item').disabled = item.status !== 'approved' || dirty;
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
      title.append(el('span', 'mini-tag', source.kind === 'builtin' ? '内置参考 · 需核实' : '手动添加'), el('h3', '', source.title));
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
    renderFilters();
    renderContentList();
    renderSources();
    if (ui.editorRefresh || (!editorDirty() && !publishDirty())) renderEditor();
    else syncEditorActions();
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
      navigate('studio');
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
  $('#edit-profile-shortcut').addEventListener('click', () => {
    if (busy) return;
    $('#profile-details').open = true;
    $('#profile-form [name="name"]').focus();
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

  $('#publish-form').addEventListener('submit', event => {
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
      const action = current.archived ? 'unarchive' : 'archive';
      await writeState('/api/items/' + encodeURIComponent(current.id) + '/' + action, 'POST', {}, { editorRefresh: true });
      showToast(current.archived ? '已移出归档，重新计入本周工时预算' : '已移入归档，不再计入本周工时预算');
    });
  });

  $('#source-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    runAction(event.submitter, '#source-error', async () => {
      const title = values.title.trim();
      const content = values.content.trim();
      if (!title || !content) throw new Error('请填写资料标题和正文，不能只有空格。');
      const payload = { title, content };
      if (values.url.trim()) {
        const url = safeUrl(values.url.trim());
        if (!url) throw new Error('来源网址请以 https:// 开头，也可以留空。');
        payload.url = url;
      }
      await writeState('/api/sources', 'POST', payload);
      form.reset();
      stampForm(form);
      showToast('参考资料已保存。生成新草稿时会使用当时已有的资料。');
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
        recommended: { text: '🟢 契合推荐', cls: 'status-approved' },
        needs_materials: { text: '🟡 缺少资料', cls: 'status-reviewed' },
        off_topic: { text: '🔴 偏离定位', cls: 'status-draft' },
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
    $('#settings-modal').hidden = false;
    switchSettingsTab(tab);
    fillModalProfile();
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
  function closeSettings() {
    $('#settings-modal').hidden = true;
    setError('#modal-profile-error', '');
    setError('#ai-key-feedback', '');
  }
  function switchSettingsTab(tab) {
    const isProfile = tab === 'profile';
    $('#modal-tab-profile')?.classList.toggle('active', isProfile);
    $('#modal-tab-ai')?.classList.toggle('active', !isProfile);
    if ($('#modal-pane-profile')) $('#modal-pane-profile').hidden = !isProfile;
    if ($('#modal-pane-ai')) $('#modal-pane-ai').hidden = isProfile;
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

  $('#open-profile-btn')?.addEventListener('click', () => openSettings('profile'));
  $('#sidebar-settings-btn')?.addEventListener('click', () => openSettings('profile'));
  $('#open-settings-btn')?.addEventListener('click', () => openSettings('profile'));
  $('#close-settings-btn')?.addEventListener('click', closeSettings);
  $('#settings-modal')?.addEventListener('click', event => {
    if (event.target === $('#settings-modal')) closeSettings();
  });
  $('#modal-tab-profile')?.addEventListener('click', () => switchSettingsTab('profile'));
  $('#modal-tab-ai')?.addEventListener('click', () => switchSettingsTab('ai'));

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
      closeSettings();
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

  $('#cancel-ai-key-btn')?.addEventListener('click', closeSettings);

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
      window.setTimeout(closeSettings, 800);
    });
  });

  $$('form[data-track]').forEach(stampForm);
  renderNavigation();
  boot();
})();
