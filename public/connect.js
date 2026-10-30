'use strict';
import { AiConnectionStatus } from './app.js';

const form = document.querySelector('#connect-form');
const field = document.querySelector('#api-key');
const button = document.querySelector('#connect-submit');
const message = document.querySelector('#connect-status');
const refreshButton = document.querySelector('#refresh-ai-status');
const connection = new AiConnectionStatus(renderStatus);
let submitting = false;
let configurationSaved = false;

function money(value) {
  return '¥' + value.toFixed(2);
}

function renderStatus() {
  const status = connection.view();
  if (connection.data?.configured === true) configurationSaved = true;
  const badge = document.querySelector('#mode-badge');
  badge.textContent = status.label;
  badge.classList.toggle('is-ready', status.canGenerateDraft);
  document.querySelector('#connection-message').textContent = status.reason;
  document.querySelector('#connection-times').textContent = status.times;
  document.querySelector('#connect-configuration').textContent = configurationSaved
    ? '配置已保存，不需要再次创建或粘贴密钥；当前能否尝试起草见下方状态。'
    : connection.data?.configured === false
      ? (status.fresh ? '本机尚未配置。' : '上次检查尚未配置。') + '保存前会再次只读检查，避免重复保存凭据。'
      : '配置状态未知，已禁用保存；请先刷新AI状态，不要重复创建凭据。';
  const budget = status.budget;
  document.querySelector('#connection-budget').textContent = budget
    ? (status.fresh ? '' : '上次读取：') + '测试预算剩余 ' + money(budget.remainingCny) + ' / 上限 ' + money(budget.limitCny)
      + ' · 已保守预留 ' + money(budget.reservedCny) + '（非实际扣费）· 请求尝试 ' + budget.attempts + ' 次'
    : connection.loading ? '测试预算读取中。' : '测试预算暂不可读，不能视为 0 或默认额度。';
  form.hidden = configurationSaved;
  field.disabled = submitting || configurationSaved;
  button.disabled = submitting || configurationSaved || !status.fresh || connection.data?.configured !== false || !budget;
  refreshButton.disabled = submitting || connection.loading;
}

function showStatus() {
  return connection.refresh();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting || button.disabled || !form.reportValidity()) return;
  submitting = true;
  message.textContent = '';
  renderStatus();
  let postStarted = false;
  try {
    const latest = await showStatus();
    if (configurationSaved || latest?.configured === true) {
      message.textContent = '已检测到本机保存过配置，未重复提交。';
      return;
    }
    if (!latest || !connection.view().fresh || latest.configured !== false || !latest.budget) {
      throw new Error('未确认可安全保存，未发送密钥。请先刷新AI状态。');
    }
    postStarted = true;
    message.textContent = '正在验证并加密保存配置，请稍候；不会付费生成。';
    const response = await fetch('/api/connection/key', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ apiKey: field.value.trim() }), signal: AbortSignal.timeout(50000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '保存未确认成功。');
    // Remember a confirmed save even if its subsequent GET fails: never reopen a creation form.
    configurationSaved = true;
    field.value = '';
    form.reset();
    message.textContent = '配置已加密保存，不代表生成必定成功；未发起草稿生成。';
    await showStatus();
  } catch (error) {
    if (postStarted) connection.invalidate();
    const detail = error.name === 'TimeoutError' ? '验证超时，保存结果未确认。'
      : error instanceof TypeError || error instanceof SyntaxError ? '连接或响应异常，保存结果未确认。' : error.message;
    message.textContent = detail + ' 输入保留在本页，未自动重试。' + (postStarted ? ' 保存可能已完成，请先只读刷新核实，勿重复创建凭据。' : '');
  } finally {
    submitting = false;
    renderStatus();
  }
});

refreshButton.addEventListener('click', () => {
  if (!submitting) showStatus();
});
window.addEventListener('focus', () => {
  if (!submitting) showStatus();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) connection.invalidate();
});
window.addEventListener('beforeunload', event => {
  if (submitting || field.value) {
    event.preventDefault();
    event.returnValue = '';
  }
});
showStatus();
