'use strict';

const STATUSES = [
  'pending_confirm',
  'confirmed',
  'queued',
  'printing',
  'post_processing',
  'completed',
  'delivered',
  'cancelled',
];

const LABELS = {
  pending_confirm: '待确认',
  confirmed: '已确认',
  queued: '排队中',
  printing: '打印中',
  post_processing: '后处理',
  completed: '已完成',
  delivered: '已交付',
  cancelled: '已取消',
};

// 客户时间线上展示的主流程（不含 cancelled）
const TIMELINE = [
  'pending_confirm',
  'confirmed',
  'queued',
  'printing',
  'post_processing',
  'completed',
  'delivered',
];

// 每个非终态都允许回退一步。误点状态是日常操作，
// 强制单向会逼出"删单重建"这种更糟的补救 —— 那样会丢掉全部历史记录。
const TRANSITIONS = {
  pending_confirm: ['confirmed', 'cancelled'],
  confirmed: ['queued', 'cancelled', 'pending_confirm'],
  queued: ['printing', 'cancelled', 'confirmed'],
  printing: ['post_processing', 'cancelled', 'queued'],
  post_processing: ['completed', 'cancelled', 'printing'],
  completed: ['delivered', 'cancelled', 'post_processing'],
  delivered: [],
  cancelled: [],
};

const TERMINAL = new Set(['delivered', 'cancelled']);

// 营业额只认「已交付」。放在状态机里而不是在统计 SQL 和前端各写一遍 ——
// 以后想改成"已完成也算钱"，只改这一处。
const REVENUE_STATUS = 'delivered';

function isStatus(value) {
  return STATUSES.includes(value);
}

function label(status) {
  return LABELS[status] || status;
}

function allowedNext(status) {
  return TRANSITIONS[status] || [];
}

function isTransitionAllowed(from, to) {
  if (!isStatus(from) || !isStatus(to)) return false;
  if (from === to) return false;
  return allowedNext(from).includes(to);
}

/**
 * @returns {{ok: true} | {ok: false, message: string}}
 */
function check(from, to, { force = false, note = '' } = {}) {
  if (!isStatus(to)) return { ok: false, message: '未知的目标状态' };
  if (from === to) return { ok: false, message: '订单已经是该状态' };

  if (isTransitionAllowed(from, to)) return { ok: true };

  if (force) {
    // 越级迁移必须留下原因。没有 note 的 force 等于把状态机关掉，
    // 会在审计时留下一串无法解释的跳变。
    if (TERMINAL.has(from)) {
      return { ok: false, message: `订单已${label(from)}，不能再变更状态` };
    }
    if (!note || !note.trim()) {
      return { ok: false, message: '强制变更状态时必须填写原因' };
    }
    return { ok: true };
  }

  if (TERMINAL.has(from)) {
    return { ok: false, message: `订单已${label(from)}，不能再变更状态` };
  }

  const next = allowedNext(from).map(label).join('、');
  return { ok: false, message: `不能从「${label(from)}」直接变更为「${label(to)}」。可选：${next}` };
}

module.exports = {
  STATUSES,
  LABELS,
  TIMELINE,
  TRANSITIONS,
  TERMINAL,
  REVENUE_STATUS,
  isStatus,
  label,
  allowedNext,
  isTransitionAllowed,
  check,
};
