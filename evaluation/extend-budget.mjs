// 显式扩充本机测试额度上限（离线脚本，不由服务端调用）。
// 只修改账本的 limitCents，保留已用预留与调用记录；不充值、不重置使用量。
// 用法：node evaluation/extend-budget.mjs 3 "原因"
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budgetFile = join(ROOT, '.local', 'ai-budget.json');
const RESERVE_CENTS = 5;
const MAX_LIMIT_CENTS = 1000;

const raw = process.argv[2];
const reason = process.argv.slice(3).join(' ').trim();
const newLimitCents = Number(raw) * 100;
if (!Number.isInteger(newLimitCents) || newLimitCents < RESERVE_CENTS || newLimitCents > MAX_LIMIT_CENTS) {
  console.error('用法：node evaluation/extend-budget.mjs <新上限元，1–10 的整数> "原因"');
  process.exit(1);
}
if (!reason) {
  console.error('必须写明扩充原因，便于以后核对。');
  process.exit(1);
}
if (!existsSync(budgetFile)) {
  console.error('账本不存在，无法扩充；请先通过连接页完成一次验证。');
  process.exit(1);
}

const ledger = JSON.parse(readFileSync(budgetFile, 'utf8'));
if (!Number.isInteger(ledger.limitCents) || !Number.isInteger(ledger.reservedCents) ||
    !Array.isArray(ledger.calls) || ledger.calls.length * RESERVE_CENTS !== ledger.reservedCents) {
  console.error('账本结构不一致，拒绝修改。');
  process.exit(1);
}
if (newLimitCents <= ledger.limitCents) {
  console.error(`新上限 ¥${newLimitCents / 100} 必须大于当前 ¥${ledger.limitCents / 100}；本脚本不会降低额度。`);
  process.exit(1);
}
if (ledger.reservedCents > newLimitCents) {
  console.error('已预留金额超过新上限，拒绝修改。');
  process.exit(1);
}

const updated = {
  ...ledger,
  limitCents: newLimitCents,
  extensions: [...(Array.isArray(ledger.extensions) ? ledger.extensions : []), {
    at: new Date().toISOString(), previousLimitCents: ledger.limitCents, newLimitCents, reason,
  }],
};
const temporary = `${budgetFile}.${randomUUID()}.tmp`;
writeFileSync(temporary, JSON.stringify(updated, null, 2), { flag: 'wx', encoding: 'utf8', mode: 0o600 });
renameSync(temporary, budgetFile);
console.log(JSON.stringify({ limitCny: updated.limitCents / 100, reservedCny: updated.reservedCents / 100, remainingCny: (updated.limitCents - updated.reservedCents) / 100, attempts: updated.calls.length }, null, 2));
