#!/usr/bin/env node
/**
 * remind-cli — Droid 通过 Execute 工具调用的提醒设置 CLI
 *
 * 用法:
 *   node remind-cli.js add --chat <chatId> --time "YYYY-MM-DD HH:MM" --text "内容" [--type once|daily|weekly|monthly] [--day N] [--exec] [--json]
 *   node remind-cli.js list --chat <chatId> [--json]
 *   node remind-cli.js delete --id <id> [--json]
 *
 * --json 模式：输出结构化 JSON，让 Droid 能感知成功/失败原因并自动纠正
 * 原子写入：先写 .tmp 再 rename，防止文件损坏
 */

const fs = require('fs');

const REMINDER_FILE = './reminders.json';
const VALID_TYPES = ['once', 'daily', 'weekly', 'monthly'];

// ---- 参数解析 ----
const args = process.argv.slice(2);
const cmd = args[0];

function getArg(name) {
  const i = args.indexOf('--' + name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}
function getFlag(name) {
  return args.includes('--' + name);
}

const useJson = getFlag('json');

// ---- 输出辅助 ----
function out(data) {
  if (useJson) {
    console.log(JSON.stringify(data));
  } else {
    if (data.status === 'error') {
      console.error(`❌ [${data.code}] ${data.message}`);
    } else if (data.status === 'ok' && data.reminder) {
      const r = data.reminder;
      console.log(`提醒已添加: [${r.id}] ${r.type} ${r.time} — ${r.text}`);
    } else if (data.status === 'ok' && data.deleted) {
      console.log(`已删除: ${data.deleted}`);
    } else if (data.status === 'ok' && data.reminders) {
      if (data.reminders.length === 0) { console.log('暂无提醒'); return; }
      const dn = ['日', '一', '二', '三', '四', '五', '六'];
      data.reminders.forEach((r, i) => {
        const cycle = r.type === 'daily' ? '每天'
          : r.type === 'weekly' ? `每周${dn[r.day]}`
          : r.type === 'monthly' ? `每月${r.day}号`
          : '一次';
        console.log(`${i + 1}. [${cycle}] ${r.exec ? '[任务]' : '[提醒]'} ${r.time} — ${r.text} (${r.id})`);
      });
    }
  }
}

function fail(code, message, extra = {}) {
  out({ status: 'error', code, message, ...extra });
  process.exit(1);
}

// ---- 文件操作 ----
function loadReminders() {
  try {
    if (fs.existsSync(REMINDER_FILE)) {
      return JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveReminders(reminders) {
  const tmp = REMINDER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(reminders, null, 2));
  fs.renameSync(tmp, REMINDER_FILE);
}

// ---- 时间格式化 ----
function fmtDatetime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- 时间验证 + 规范化 ----
// 对 daily/weekly/monthly：time 必须是 HH:MM（若传了全日期自动提取）
// 对 once：time 必须是 YYYY-MM-DD HH:MM（若只传 HH:MM 则推断日期，已过用明天）
// 返回规范化后的字符串，或 { error: code, message } 表示无法修复的格式错误
function normalizeTime(time, type) {
  if (!time) return { error: 'INVALID_TIME_FORMAT', message: `--time 不能为空` };
  const t = time.trim();

  if (type === 'daily' || type === 'weekly' || type === 'monthly') {
    // 接受 "HH:MM"
    if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, '0');
    // 接受 "YYYY-MM-DD HH:MM" → 提取 HH:MM（Droid 有时会传全日期）
    const full = /^\d{4}-\d{2}-\d{2} (\d{1,2}:\d{2})$/.exec(t);
    if (full) return full[1].padStart(5, '0');
    return {
      error: 'INVALID_TIME_FORMAT',
      message: `${type} 类型的 --time 必须是 HH:MM（如 "09:00"），收到: "${t}"`,
      hint: `正确示例: --time "09:00" --type ${type}`,
    };
  }

  if (type === 'once') {
    // 接受 "YYYY-MM-DD HH:MM"
    if (/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}$/.test(t)) return t;
    // 接受 "HH:MM" → 推断日期（已过则明天）
    if (/^\d{1,2}:\d{2}$/.test(t)) {
      const [h, m] = t.split(':').map(Number);
      const target = new Date();
      target.setHours(h, m, 0, 0);
      if (target <= new Date()) target.setDate(target.getDate() + 1);
      return fmtDatetime(target);
    }
    return {
      error: 'INVALID_TIME_FORMAT',
      message: `once 类型的 --time 必须是 YYYY-MM-DD HH:MM（如 "2026-05-15 09:00"），收到: "${t}"`,
      hint: `正确示例: --time "2026-05-15 09:00" --type once`,
    };
  }

  return { error: 'INVALID_TIME_FORMAT', message: `无法解析时间: "${t}"` };
}

// ---- 命令处理 ----

if (cmd === 'add') {
  const chatId = getArg('chat');
  const time   = getArg('time');
  const text   = getArg('text');
  const type   = getArg('type') || 'once';
  const exec   = getFlag('exec');
  const dayRaw = getArg('day');
  const day    = dayRaw !== undefined ? parseInt(dayRaw) : null;

  // 必填项检查
  if (!chatId) fail('MISSING_CHATID',
    '--chat 是必填项，值为当前会话的 chatId（从系统注入的 [系统: chatId=...] 中获取）');
  if (!time)   fail('MISSING_TIME', '--time 是必填项');
  if (!text)   fail('MISSING_TEXT', '--text 是必填项');

  // type 验证
  if (!VALID_TYPES.includes(type)) {
    fail('INVALID_TYPE',
      `--type "${type}" 无效，可用值: ${VALID_TYPES.join(', ')}`,
      { validTypes: VALID_TYPES });
  }

  // day 验证
  if (type === 'weekly') {
    if (day === null || isNaN(day) || day < 0 || day > 6) {
      fail('INVALID_DAY',
        `weekly 类型必须提供 --day 0-6（0=周日，1=周一，2=周二，3=周三，4=周四，5=周五，6=周六）`,
        { received: dayRaw });
    }
  }
  if (type === 'monthly') {
    if (day === null || isNaN(day) || day < 1 || day > 31) {
      fail('INVALID_DAY',
        `monthly 类型必须提供 --day 1-31`,
        { received: dayRaw });
    }
  }

  // 时间规范化
  const normalized = normalizeTime(time, type);
  if (typeof normalized !== 'string') {
    fail(normalized.error, normalized.message, { hint: normalized.hint });
  }

  // 写入
  const reminders = loadReminders();
  const r = {
    id:          Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    chatId,
    time:        normalized,
    text,
    type,
    exec:        exec || false,
    day:         (type === 'weekly' || type === 'monthly') ? day : null,
    createdAt:   Date.now(),
    lastFiredAt: null,
  };
  reminders.push(r);
  saveReminders(reminders);
  out({ status: 'ok', reminder: { id: r.id, chatId: r.chatId, time: r.time, type: r.type, text: r.text, day: r.day, exec: r.exec } });

} else if (cmd === 'list') {
  const chatId = getArg('chat');
  if (!chatId) fail('MISSING_CHATID', '--chat 是必填项');
  const reminders = loadReminders();
  const filtered  = reminders.filter(r => r.chatId === chatId);
  out({ status: 'ok', reminders: filtered });

} else if (cmd === 'delete') {
  const id = getArg('id');
  if (!id) fail('MISSING_ID', '--id 是必填项');
  const reminders = loadReminders();
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) fail('NOT_FOUND', `未找到 id="${id}" 的提醒`);
  const removed = reminders.splice(idx, 1)[0];
  saveReminders(reminders);
  out({ status: 'ok', deleted: removed.text, id: removed.id });

} else {
  console.log(`remind-cli: 提醒管理工具

用法:
  node remind-cli.js add --chat <chatId> --time <时间> --text <内容> [--type once|daily|weekly|monthly] [--day N] [--exec] [--json]
  node remind-cli.js list --chat <chatId> [--json]
  node remind-cli.js delete --id <id> [--json]

时间格式规则:
  once    → "YYYY-MM-DD HH:MM"  例: "2026-05-15 09:00"
  daily   → "HH:MM"             例: "09:00"
  weekly  → "HH:MM" + --day 0-6 例: "09:00" --day 3  (0=周日,1=周一,...,6=周六)
  monthly → "HH:MM" + --day 1-31 例: "09:00" --day 15

--json 模式输出结构化 JSON，便于 Droid 感知错误并自动重试`);
}
