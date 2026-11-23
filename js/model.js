/**
 * 简课表查看 · 数据模型、安全上限、作息/时区校验与周次/日期工具（Schema v1）
 * 零外部依赖，浏览器与 Node 单元测试共用。
 */

export const SCHEMA_VERSION = 1;
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
export const PALETTE_SIZE = 12;

export const LIMITS = Object.freeze({
  MAX_PERIODS: 20,
  MIN_PERIODS: 4,
  MAX_TOTAL_WEEKS: 35,
  MAX_HTML_BYTES: 2 * 1024 * 1024,          // 2 MB
  MAX_JSON_BYTES: 4 * 1024 * 1024,          // 4 MB（UTF-8 字节预算，覆盖满额 600 时段含长备注合法备份）
  MAX_TRANSFER_CODE_CHARS: 64 * 1024,       // 64K 字符
  MAX_DECOMPRESSED_BYTES: 512 * 1024,       // 512 KB 解压上限（防解压炸弹）
  MAX_COURSES: 200,
  MAX_RULES_PER_COURSE: 40,
  MAX_TOTAL_RULES: 600,
  MAX_OVERRIDES: 1000,
  MAX_PRACTICE_COURSES: 100,
  MAX_CONFLICT_DETAILS: 100,
  MAX_UNRECOGNIZED_DETAILS: 100,
  MAX_TEXT_LEN: 160,
  MAX_NOTE_LEN: 400,
  MAX_TABLE_ROWS: 200,
  MAX_TABLE_COLS: 30,
  MAX_HTML_NODES: 40000
});

const utf8Encoder = new TextEncoder();

export function getUtf8ByteLength(str) {
  return utf8Encoder.encode(String(str ?? '')).byteLength;
}

/**
 * 统一硬配额校验（所有写入入口共用，绝不在规整阶段静默截断/挤掉已有课程）
 */
export function validateScheduleQuotas(data) {
  if (!data || typeof data !== 'object') {
    return { ok: false, error: '课表数据格式无效。' };
  }
  if (Array.isArray(data.periods) && data.periods.length > LIMITS.MAX_PERIODS) {
    return { ok: false, error: `作息节次（${data.periods.length}）超过上限 ${LIMITS.MAX_PERIODS} 节，已拒绝保存。` };
  }
  const courses = Array.isArray(data.courses) ? data.courses : [];
  if (courses.length > LIMITS.MAX_COURSES) {
    return { ok: false, error: `课程门数（${courses.length}）超过上限 ${LIMITS.MAX_COURSES} 门，已拒绝保存以保护现有课程。` };
  }
  let totalRules = 0;
  for (const c of courses) {
    const schedules = Array.isArray(c?.schedules) ? c.schedules : [];
    if (schedules.length > LIMITS.MAX_RULES_PER_COURSE) {
      return {
        ok: false,
        error: `课程「${c?.name || '未命名'}」的排课时段（${schedules.length}）超过单课上限 ${LIMITS.MAX_RULES_PER_COURSE} 条，已拒绝保存。`
      };
    }
    totalRules += schedules.length;
  }
  if (totalRules > LIMITS.MAX_TOTAL_RULES) {
    return {
      ok: false,
      error: `全库排课时段总数（${totalRules}）超过上限 ${LIMITS.MAX_TOTAL_RULES} 条，已拒绝保存以保护现有课程，请先删减其他时段。`
    };
  }
  const overrides = Array.isArray(data.overrides) ? data.overrides : [];
  if (overrides.length > LIMITS.MAX_OVERRIDES) {
    return { ok: false, error: `调停课例外数量（${overrides.length}）超过上限 ${LIMITS.MAX_OVERRIDES} 条，已拒绝保存。` };
  }
  const practice = Array.isArray(data.practiceCourses) ? data.practiceCourses : [];
  if (practice.length > LIMITS.MAX_PRACTICE_COURSES) {
    return { ok: false, error: `集中实践课程数量（${practice.length}）超过上限 ${LIMITS.MAX_PRACTICE_COURSES} 项，已拒绝保存。` };
  }
  return { ok: true };
}

export const DAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
export const DAY_NAMES_FULL = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

export const PERIOD_TEMPLATES = {
  'zjiet-13': {
    id: 'zjiet-13',
    label: '13 节作息模板（早自习08:00-08:15 · 上午1-5 / 下午6-9 / 晚上10-13，每节40分钟）',
    morningStudy: { label: '早自习', start: '08:00', end: '08:15' },
    sections: [
      { label: '上午', start: 1, end: 5 },
      { label: '下午', start: 6, end: 9 },
      { label: '晚上', start: 10, end: 13 }
    ],
    periods: [
      { index: 1, start: '08:15', end: '08:55' },
      { index: 2, start: '09:00', end: '09:40' },
      { index: 3, start: '09:55', end: '10:35' },
      { index: 4, start: '10:40', end: '11:20' },
      { index: 5, start: '11:25', end: '12:05' },
      { index: 6, start: '13:25', end: '14:05' },
      { index: 7, start: '14:10', end: '14:50' },
      { index: 8, start: '15:05', end: '15:45' },
      { index: 9, start: '15:50', end: '16:30' },
      { index: 10, start: '17:40', end: '18:20' },
      { index: 11, start: '18:25', end: '19:05' },
      { index: 12, start: '19:15', end: '19:55' },
      { index: 13, start: '20:00', end: '20:40' }
    ]
  },
  'standard-12': {
    id: 'standard-12',
    label: '通用高校 12 节模板（上午1-4 / 下午5-8 / 晚上9-12）',
    sections: [
      { label: '上午', start: 1, end: 4 },
      { label: '下午', start: 5, end: 8 },
      { label: '晚上', start: 9, end: 12 }
    ],
    periods: [
      { index: 1, start: '08:00', end: '08:45' },
      { index: 2, start: '08:55', end: '09:40' },
      { index: 3, start: '10:00', end: '10:45' },
      { index: 4, start: '10:55', end: '11:40' },
      { index: 5, start: '14:00', end: '14:45' },
      { index: 6, start: '14:55', end: '15:40' },
      { index: 7, start: '16:00', end: '16:45' },
      { index: 8, start: '16:55', end: '17:40' },
      { index: 9, start: '19:00', end: '19:45' },
      { index: 10, start: '19:55', end: '20:40' },
      { index: 11, start: '20:50', end: '21:35' },
      { index: 12, start: '21:45', end: '22:30' }
    ]
  }
};

export function clonePeriodsTemplate(templateId = 'zjiet-13') {
  const tpl = PERIOD_TEMPLATES[templateId] || PERIOD_TEMPLATES['zjiet-13'];
  return tpl.periods.map((p) => ({ ...p }));
}

export function truncateText(str, maxLen = LIMITS.MAX_TEXT_LEN) {
  const clean = String(str ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
}

/**
 * 确定性 FNV-1a 哈希：按课程 ID 固定颜色索引，不受其他课程增删影响。
 */
export function getCourseColorIndex(courseId) {
  const str = String(courseId || 'default');
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % PALETTE_SIZE;
}

export function makeStableCourseId(name) {
  const clean = String(name || '').trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < clean.length; i += 1) {
    hash ^= clean.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `crs_${(hash >>> 0).toString(36)}`;
}

let idCounter = 0;
export function generateId(prefix = 'id') {
  idCounter = (idCounter + 1) % 100000;
  const rand = Math.random().toString(36).slice(2, 7);
  const ts = Date.now().toString(36).slice(-5);
  return `${prefix}_${ts}${idCounter.toString(36)}${rand}`;
}

export function generateUniqueRuleId(existingRuleIds = []) {
  const set = new Set(existingRuleIds);
  let id = generateId('r');
  while (set.has(id)) {
    id = generateId('r');
  }
  return id;
}

/**
 * 为来自同一外部课表源（如教务 HTML）的排课时段生成确定性稳定 ruleId，
 * 确保同一课表再次覆盖导入时 .ics 事件 UID 保持一致。
 */
export function makeStableRuleId(courseId, item, existingRuleIds = []) {
  const set = new Set(existingRuleIds);
  const weeksSorted = [...new Set((item.weeks || []).map(Number))].sort((a, b) => a - b);
  const sig = [
    String(courseId || ''),
    Number(item.dayOfWeek) || 0,
    Number(item.startPeriod) || 0,
    Number(item.endPeriod) || 0,
    weeksSorted.join(','),
    String(item.location || '').trim(),
    String(item.teacher || '').trim(),
    String(item.courseType || '').trim()
  ].join('|');

  let hash = 2166136261;
  for (let i = 0; i < sig.length; i += 1) {
    hash ^= sig.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const base = `rs_${(hash >>> 0).toString(36)}`;
  if (!set.has(base)) return base;
  let seq = 2;
  while (set.has(`${base}_${seq}`)) seq += 1;
  return `${base}_${seq}`;
}

export function isValidDateStr(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function isValidTimeStr(str) {
  if (typeof str !== 'string' || !/^\d{2}:\d{2}$/.test(str)) return false;
  const [hh, mm] = str.split(':').map(Number);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

/**
 * 严格校验 IANA 时区标识符：
 * 1. 拒绝控制字符、空白、分号、冒号等可能破坏 .ics 属性边界的字符；
 * 2. 通过 Intl.DateTimeFormat 确认运行时真实支持该时区。
 */
export function isValidIanaTimezone(tz) {
  if (typeof tz !== 'string') return false;
  const trimmed = tz.trim();
  if (trimmed !== tz || trimmed.length === 0 || trimmed.length > 64) return false;
  if (!/^(?:UTC|Etc\/GMT(?:[+-]\d{1,2})?|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(trimmed)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function timeToMinutes(hhmm) {
  if (!isValidTimeStr(hhmm)) return 0;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 统一校验作息时间表：
 * - 数量在 MIN_PERIODS..MAX_PERIODS 之间
 * - 每节均为合法 HH:MM 且 结束时间严格晚于开始时间
 * - 相邻节次不可时间重叠或倒序（上节结束 <= 下节开始）
 */
export function validatePeriodsSchedule(periods) {
  if (!Array.isArray(periods) || periods.length < 1) {
    return { ok: false, error: '作息时间表不能为空。' };
  }
  if (periods.length > LIMITS.MAX_PERIODS) {
    return { ok: false, error: `作息节次超过上限（最多 ${LIMITS.MAX_PERIODS} 节）。` };
  }

  let prevEndMin = -1;
  for (let i = 0; i < periods.length; i += 1) {
    const p = periods[i];
    if (!p || typeof p !== 'object') {
      return { ok: false, error: `第 ${i + 1} 节数据格式无效。` };
    }
    if (!isValidTimeStr(p.start) || !isValidTimeStr(p.end)) {
      return { ok: false, error: `第 ${i + 1} 节时间格式不正确（应为 HH:MM）。` };
    }
    const startMin = timeToMinutes(p.start);
    const endMin = timeToMinutes(p.end);
    if (endMin <= startMin) {
      return { ok: false, error: `第 ${i + 1} 节结束时间（${p.end}）必须晚于开始时间（${p.start}）。` };
    }
    if (prevEndMin > startMin) {
      return {
        ok: false,
        error: `第 ${i + 1} 节开始时间（${p.start}）早于第 ${i} 节结束时间（${periods[i - 1].end}），时段存在交叉或倒序。`
      };
    }
    prevEndMin = endMin;
  }

  return { ok: true };
}

export function parseDateUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function formatUTCDate(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(dateStr, days) {
  return formatUTCDate(parseDateUTC(dateStr) + days * 86400000);
}

export function diffDays(fromDateStr, toDateStr) {
  return Math.round((parseDateUTC(toDateStr) - parseDateUTC(fromDateStr)) / 86400000);
}

/**
 * ISO 星期：1=星期一 ... 7=星期日
 */
export function getDayOfWeekISO(dateStr) {
  const day = new Date(parseDateUTC(dateStr)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function getMondayOfDate(dateStr) {
  const dow = getDayOfWeekISO(dateStr);
  return addDays(dateStr, -(dow - 1));
}

export function getDateForWeekAndDay(startMonday, weekNum, dayOfWeek) {
  return addDays(startMonday, (weekNum - 1) * 7 + (dayOfWeek - 1));
}

export function getTodayInTimezone(timezone = DEFAULT_TIMEZONE, now = new Date()) {
  const safeTz = isValidIanaTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: safeTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
  } catch {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}

export function getNowTimeInTimezone(timezone = DEFAULT_TIMEZONE, now = new Date()) {
  const safeTz = isValidIanaTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: safeTz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const hh = map.hour === '24' ? '00' : map.hour;
    return `${hh}:${map.minute}`;
  } catch {
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }
}

export function formatShortDate(dateStr) {
  if (!isValidDateStr(dateStr)) return '';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}月${d}日`;
}

export function formatMonthDaySlash(dateStr) {
  if (!isValidDateStr(dateStr)) return '';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}`;
}

/**
 * 解析中文/通用周次表达式为升序去重数组：
 * 支持：5-16周、5-17周(单)、6-18周(双)、第10周、1-4,6-12(双),15、1-15单
 */
export function parseWeeksExpression(expr, maxWeek = LIMITS.MAX_TOTAL_WEEKS) {
  const cappedMax = Math.max(1, Math.min(LIMITS.MAX_TOTAL_WEEKS, Number(maxWeek) || LIMITS.MAX_TOTAL_WEEKS));
  if (Array.isArray(expr)) {
    return [...new Set(expr.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= cappedMax))].sort((a, b) => a - b);
  }
  if (typeof expr !== 'string' || !expr.trim()) return [];

  const normalized = expr
    .slice(0, 200)
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[，、;；]/g, ',')
    .replace(/[—–～~－]/g, '-')
    .replace(/\s+/g, '');

  const segments = normalized.split(',').filter(Boolean).slice(0, 40);
  const weekSet = new Set();

  for (const seg of segments) {
    let parity = 'all';
    if (/\(单\)|单周|单$/.test(seg)) parity = 'odd';
    else if (/\(双\)|双周|双$/.test(seg)) parity = 'even';

    const cleaned = seg
      .replace(/\(单\)|\(双\)/g, '')
      .replace(/单周|双周|单|双|第|周/g, '');

    const rangeMatch = cleaned.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      let start = Number(rangeMatch[1]);
      let end = Number(rangeMatch[2]);
      if (start > end) [start, end] = [end, start];
      for (let w = Math.max(1, start); w <= Math.min(cappedMax, end); w += 1) {
        if (parity === 'odd' && w % 2 === 0) continue;
        if (parity === 'even' && w % 2 !== 0) continue;
        weekSet.add(w);
      }
      continue;
    }

    const singleMatch = cleaned.match(/^(\d+)$/);
    if (singleMatch) {
      const w = Number(singleMatch[1]);
      if (w >= 1 && w <= cappedMax) weekSet.add(w);
    }
  }

  return [...weekSet].sort((a, b) => a - b);
}

/**
 * 将周次数组格式化为简洁人类可读文本，如 5-16周 / 5-17周(单) / 第10周 / 1-4, 6-12周
 */
export function formatWeeksExpression(weeks) {
  const list = [...new Set((weeks || []).map(Number).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b);
  if (list.length === 0) return '未设置周次';
  if (list.length === 1) return `第${list[0]}周`;

  const min = list[0];
  const max = list[list.length - 1];
  const isAllOdd = list.every((w) => w % 2 === 1);
  const isAllEven = list.every((w) => w % 2 === 0);

  if (list.length === max - min + 1) return `${min}-${max}周`;
  if (isAllOdd && list.length === Math.floor((max - min) / 2) + 1) return `${min}-${max}周(单)`;
  if (isAllEven && list.length === Math.floor((max - min) / 2) + 1) return `${min}-${max}周(双)`;

  const parts = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j += 1;
    if (j > i) {
      parts.push(`${list[i]}-${list[j]}`);
      i = j + 1;
      continue;
    }
    let k = i;
    while (k + 1 < list.length && list[k + 1] === list[k] + 2) k += 1;
    if (k - i >= 2) {
      const tag = list[i] % 2 === 1 ? '(单)' : '(双)';
      parts.push(`${list[i]}-${list[k]}${tag}`);
      i = k + 1;
      continue;
    }
    parts.push(`${list[i]}`);
    i += 1;
  }

  return `${parts.join(', ')}周`;
}

export function createDefaultData(todayStr = getTodayInTimezone()) {
  const defaultStartMonday = todayStr >= '2026-09-01' && todayStr <= '2027-02-15'
    ? '2026-09-07'
    : getMondayOfDate(todayStr);

  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    updatedAt: new Date().toISOString(),
    term: {
      name: '2026-2027学年第1学期',
      startMonday: defaultStartMonday,
      totalWeeks: 20,
      timezone: DEFAULT_TIMEZONE,
      nextTermStartDate: ''
    },
    periods: clonePeriodsTemplate('zjiet-13'),
    courses: [],
    overrides: [],
    practiceCourses: []
  };
}

/**
 * 严格校验原始 JSON / 导入码备份载荷（先校验，再明确规整，并列出丢弃原因）
 */
export function validateRawBackupPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '备份内容必须是 JSON 对象。' };
  }

  if (raw.schemaVersion === undefined || raw.schemaVersion === null) {
    return { ok: false, error: '缺少 schemaVersion 字段，无法确认是否为简课表查看备份文件。' };
  }

  if (!Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
    return { ok: false, error: `schemaVersion 字段无效（当前值：${String(raw.schemaVersion)}）。` };
  }

  if (raw.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `该备份为 Schema v${raw.schemaVersion}，高于当前应用支持的 v${SCHEMA_VERSION}，请更新应用后再导入。`
    };
  }

  if (!raw.term || typeof raw.term !== 'object' || Array.isArray(raw.term)) {
    return { ok: false, error: '备份缺少合法的 term（学期配置）字段。' };
  }

  if (!isValidDateStr(raw.term.startMonday)) {
    return { ok: false, error: '备份中的 term.startMonday（开学第一周日期）缺失或格式无效。' };
  }

  const totalWeeks = Number(raw.term.totalWeeks);
  if (!Number.isInteger(totalWeeks) || totalWeeks < 1 || totalWeeks > LIMITS.MAX_TOTAL_WEEKS) {
    return { ok: false, error: `备份中的 term.totalWeeks 必须在 1 到 ${LIMITS.MAX_TOTAL_WEEKS} 之间。` };
  }

  const tz = raw.term.timezone ?? DEFAULT_TIMEZONE;
  if (!isValidIanaTimezone(tz)) {
    return { ok: false, error: `备份中的时区无效或包含非法字符（"${truncateText(tz, 40)}"）。` };
  }

  if (raw.term.nextTermStartDate && !isValidDateStr(raw.term.nextTermStartDate)) {
    return { ok: false, error: '备份中的 nextTermStartDate 日期格式无效。' };
  }

  const periodCheck = validatePeriodsSchedule(raw.periods);
  if (!periodCheck.ok) {
    return { ok: false, error: `备份中的作息时间表无效：${periodCheck.error}` };
  }

  if (!Array.isArray(raw.courses)) {
    return { ok: false, error: '备份缺少 courses 数组。' };
  }
  if (raw.courses.length > LIMITS.MAX_COURSES) {
    return { ok: false, error: `备份课程数超过上限（最多 ${LIMITS.MAX_COURSES} 门）。` };
  }

  if (raw.overrides !== undefined && !Array.isArray(raw.overrides)) {
    return { ok: false, error: '备份中的 overrides 必须是数组。' };
  }
  if (Array.isArray(raw.overrides) && raw.overrides.length > LIMITS.MAX_OVERRIDES) {
    return { ok: false, error: `备份中的调停课例外数量超过上限（最多 ${LIMITS.MAX_OVERRIDES} 条）。` };
  }

  if (raw.practiceCourses !== undefined && !Array.isArray(raw.practiceCourses)) {
    return { ok: false, error: '备份中的 practiceCourses 必须是数组。' };
  }

  // 逐项检查可安全丢弃的局部脏数据，并生成明确明细
  const droppedIssues = [];
  const maxPeriod = raw.periods.length;
  const validRuleKeys = new Set();
  const validCourseIds = new Set();
  let totalRulesCount = 0;

  for (let ci = 0; ci < raw.courses.length; ci += 1) {
    const c = raw.courses[ci];
    if (!c || typeof c !== 'object' || !truncateText(c.name)) {
      droppedIssues.push({ raw: `courses[${ci}]`, reason: '缺少有效课程名称，已跳过' });
      continue;
    }
    const cid = typeof c.id === 'string' && c.id.trim() ? truncateText(c.id, 64) : makeStableCourseId(c.name);
    validCourseIds.add(cid);

    const schedules = Array.isArray(c.schedules) ? c.schedules : [];
    const seenRuleIds = new Set();
    for (let ri = 0; ri < schedules.length; ri += 1) {
      const r = schedules[ri];
      totalRulesCount += 1;
      if (totalRulesCount > LIMITS.MAX_TOTAL_RULES) {
        return { ok: false, error: `备份排课时段总数超过安全上限（最多 ${LIMITS.MAX_TOTAL_RULES} 条）。` };
      }
      if (!r || typeof r !== 'object') {
        droppedIssues.push({ raw: `${c.name} 时段 #${ri + 1}`, reason: '排课规则格式无效，已跳过' });
        continue;
      }
      const dow = Number(r.dayOfWeek);
      const sp = Number(r.startPeriod);
      const ep = Number(r.endPeriod);
      const weeks = parseWeeksExpression(r.weeks, Math.max(totalWeeks, LIMITS.MAX_TOTAL_WEEKS));

      if (!Number.isInteger(dow) || dow < 1 || dow > 7) {
        droppedIssues.push({ raw: `${c.name} 时段 #${ri + 1}`, reason: `星期数值越界（${r.dayOfWeek}），已跳过` });
        continue;
      }
      if (!Number.isInteger(sp) || !Number.isInteger(ep) || sp < 1 || ep < sp || ep > maxPeriod) {
        droppedIssues.push({ raw: `${c.name} 时段 #${ri + 1}`, reason: `节次范围（${sp}-${ep}）超出作息表（1-${maxPeriod}），已跳过` });
        continue;
      }
      if (weeks.length === 0) {
        droppedIssues.push({ raw: `${c.name} 时段 #${ri + 1}`, reason: '无有效上课周次，已跳过' });
        continue;
      }
      const rid = typeof r.ruleId === 'string' && r.ruleId.trim() ? truncateText(r.ruleId, 64) : `r_${ri + 1}`;
      if (seenRuleIds.has(rid)) {
        droppedIssues.push({ raw: `${c.name} (${rid})`, reason: '存在重复 ruleId，导入时将自动重分配唯一 ID' });
      }
      seenRuleIds.add(rid);
      validRuleKeys.add(`${cid}::${rid}`);
    }
  }

  for (let oi = 0; oi < (raw.overrides || []).length; oi += 1) {
    const ov = raw.overrides[oi];
    if (!ov || typeof ov !== 'object' || !['cancel', 'modify', 'add'].includes(ov.type) || !isValidDateStr(ov.date)) {
      droppedIssues.push({ raw: `overrides[${oi}]`, reason: '例外类型或日期无效，已跳过' });
      continue;
    }
    if (ov.type === 'cancel' || ov.type === 'modify') {
      if (!validRuleKeys.has(`${ov.courseId}::${ov.ruleId}`)) {
        droppedIssues.push({
          raw: `${ov.date} ${ov.type} (${ov.courseId}::${ov.ruleId})`,
          reason: '引用的课程或时段规则不存在，该例外已跳过'
        });
      }
    } else if (ov.type === 'add') {
      const sp = Number(ov.startPeriod);
      const ep = Number(ov.endPeriod);
      if (!truncateText(ov.name) && !validCourseIds.has(ov.courseId)) {
        droppedIssues.push({ raw: `${ov.date} 补课`, reason: '补课缺少名称且未关联已有课程，已跳过' });
      } else if (!Number.isInteger(sp) || !Number.isInteger(ep) || sp < 1 || ep < sp || ep > maxPeriod) {
        droppedIssues.push({ raw: `${ov.date} ${ov.name || '补课'}`, reason: `补课节次（${sp}-${ep}）超出作息表，已跳过` });
      }
    }
  }

  const normalized = normalizeScheduleData(raw, raw.term.startMonday, { strictOverrideRefs: true });
  return {
    ok: true,
    normalized,
    droppedIssues: droppedIssues.slice(0, LIMITS.MAX_UNRECOGNIZED_DETAILS)
  };
}

/**
 * 规整本地或已校验的数据为合法 Schema v1
 */
export function normalizeScheduleData(raw, fallbackToday = getTodayInTimezone(), options = {}) {
  const { strictOverrideRefs = false } = options;
  const base = createDefaultData(fallbackToday);
  if (!raw || typeof raw !== 'object') return base;

  const rawTerm = raw.term && typeof raw.term === 'object' ? raw.term : {};
  const startMonday = isValidDateStr(rawTerm.startMonday)
    ? getMondayOfDate(rawTerm.startMonday)
    : base.term.startMonday;
  const totalWeeks = Number.isInteger(Number(rawTerm.totalWeeks))
    ? Math.max(1, Math.min(LIMITS.MAX_TOTAL_WEEKS, Number(rawTerm.totalWeeks)))
    : base.term.totalWeeks;
  const timezone = isValidIanaTimezone(rawTerm.timezone)
    ? rawTerm.timezone
    : DEFAULT_TIMEZONE;
  const nextTermStartDate = isValidDateStr(rawTerm.nextTermStartDate)
    ? rawTerm.nextTermStartDate
    : '';

  let periods = base.periods;
  if (Array.isArray(raw.periods) && raw.periods.length > 0) {
    const candidatePeriods = raw.periods.slice(0, LIMITS.MAX_PERIODS).map((p, idx) => ({
      index: idx + 1,
      start: isValidTimeStr(p?.start) ? p.start : '',
      end: isValidTimeStr(p?.end) ? p.end : ''
    }));
    if (validatePeriodsSchedule(candidatePeriods).ok) {
      periods = candidatePeriods;
    }
  }

  const maxPeriod = Math.max(periods.length, 1);
  const courses = [];
  const seenCourseIds = new Set();
  const validRuleKeys = new Set();
  let totalRules = 0;

  if (Array.isArray(raw.courses)) {
    for (const c of raw.courses) {
      if (courses.length >= LIMITS.MAX_COURSES) break;
      if (!c || typeof c !== 'object') continue;
      const name = truncateText(c.name);
      if (!name) continue;
      let id = typeof c.id === 'string' && c.id.trim() ? truncateText(c.id, 64) : makeStableCourseId(name);
      while (seenCourseIds.has(id)) {
        id = `${id}_${seenCourseIds.size}`;
      }
      seenCourseIds.add(id);

      const schedules = [];
      const seenRuleIds = new Set();
      if (Array.isArray(c.schedules)) {
        for (let idx = 0; idx < c.schedules.length; idx += 1) {
          if (schedules.length >= LIMITS.MAX_RULES_PER_COURSE || totalRules >= LIMITS.MAX_TOTAL_RULES) break;
          const r = c.schedules[idx];
          if (!r || typeof r !== 'object') continue;
          const dayOfWeek = Number(r.dayOfWeek);
          let startPeriod = Number(r.startPeriod);
          let endPeriod = Number(r.endPeriod);
          if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) continue;
          if (!Number.isInteger(startPeriod) || startPeriod < 1 || startPeriod > maxPeriod) continue;
          if (!Number.isInteger(endPeriod) || endPeriod < startPeriod) endPeriod = startPeriod;
          if (endPeriod > maxPeriod) continue;

          const weeks = parseWeeksExpression(r.weeks, Math.max(totalWeeks, LIMITS.MAX_TOTAL_WEEKS));
          if (weeks.length === 0) continue;

          let ruleId = typeof r.ruleId === 'string' && r.ruleId.trim()
            ? truncateText(r.ruleId, 64)
            : generateUniqueRuleId(seenRuleIds);
          if (seenRuleIds.has(ruleId)) {
            ruleId = generateUniqueRuleId(seenRuleIds);
          }
          seenRuleIds.add(ruleId);
          validRuleKeys.add(`${id}::${ruleId}`);
          totalRules += 1;

          schedules.push({
            ruleId,
            dayOfWeek,
            startPeriod,
            endPeriod,
            weeks,
            location: truncateText(r.location),
            teacher: truncateText(r.teacher),
            note: truncateText(r.note, LIMITS.MAX_NOTE_LEN),
            adjusted: Boolean(r.adjusted),
            courseType: truncateText(r.courseType, 32),
            status: r.status === 'pending' ? 'pending' : 'confirmed'
          });
        }
      }

      const safeMeta = {};
      if (c.meta && typeof c.meta === 'object' && !Array.isArray(c.meta)) {
        for (const k of ['teachingClass', 'examType', 'credits', 'totalHours']) {
          if (c.meta[k] !== undefined && c.meta[k] !== null) {
            safeMeta[k] = truncateText(c.meta[k], 80);
          }
        }
      }

      courses.push({
        id,
        name,
        teacher: truncateText(c.teacher),
        location: truncateText(c.location),
        note: truncateText(c.note, LIMITS.MAX_NOTE_LEN),
        meta: safeMeta,
        schedules
      });
    }
  }

  const overrides = [];
  if (Array.isArray(raw.overrides)) {
    for (const ov of raw.overrides) {
      if (overrides.length >= LIMITS.MAX_OVERRIDES) break;
      if (!ov || typeof ov !== 'object') continue;
      if (!['cancel', 'modify', 'add'].includes(ov.type)) continue;
      if (!isValidDateStr(ov.date)) continue;

      const transferGroupId = typeof ov.transferGroupId === 'string' && ov.transferGroupId.trim()
        ? truncateText(ov.transferGroupId, 64)
        : '';

      if (ov.type === 'cancel') {
        if (!ov.courseId || !ov.ruleId) continue;
        const cid = truncateText(ov.courseId, 64);
        const rid = truncateText(ov.ruleId, 64);
        if (strictOverrideRefs && !validRuleKeys.has(`${cid}::${rid}`)) continue;
        const entry = {
          id: typeof ov.id === 'string' && ov.id ? truncateText(ov.id, 64) : generateId('ov'),
          type: 'cancel',
          courseId: cid,
          ruleId: rid,
          date: ov.date,
          reason: truncateText(ov.reason, LIMITS.MAX_NOTE_LEN)
        };
        if (transferGroupId) entry.transferGroupId = transferGroupId;
        overrides.push(entry);
      } else if (ov.type === 'modify') {
        if (!ov.courseId || !ov.ruleId) continue;
        const cid = truncateText(ov.courseId, 64);
        const rid = truncateText(ov.ruleId, 64);
        if (strictOverrideRefs && !validRuleKeys.has(`${cid}::${rid}`)) continue;
        const p = ov.patch && typeof ov.patch === 'object' ? ov.patch : {};
        const patch = {};
        if (Number.isInteger(Number(p.startPeriod)) && Number(p.startPeriod) >= 1) {
          patch.startPeriod = Math.min(maxPeriod, Number(p.startPeriod));
        }
        if (Number.isInteger(Number(p.endPeriod)) && Number(p.endPeriod) >= 1) {
          patch.endPeriod = Math.min(maxPeriod, Number(p.endPeriod));
        }
        if (patch.startPeriod && patch.endPeriod && patch.endPeriod < patch.startPeriod) {
          patch.endPeriod = patch.startPeriod;
        }
        if (typeof p.location === 'string') patch.location = truncateText(p.location);
        if (typeof p.teacher === 'string') patch.teacher = truncateText(p.teacher);
        if (typeof p.note === 'string') patch.note = truncateText(p.note, LIMITS.MAX_NOTE_LEN);

        overrides.push({
          id: typeof ov.id === 'string' && ov.id ? truncateText(ov.id, 64) : generateId('ov'),
          type: 'modify',
          courseId: cid,
          ruleId: rid,
          date: ov.date,
          patch
        });
      } else if (ov.type === 'add') {
        const name = truncateText(ov.name);
        const courseId = typeof ov.courseId === 'string' && ov.courseId
          ? truncateText(ov.courseId, 64)
          : makeStableCourseId(name || 'extra');
        const startPeriod = Number(ov.startPeriod);
        const endPeriod = Number(ov.endPeriod);
        if (!Number.isInteger(startPeriod) || startPeriod < 1 || startPeriod > maxPeriod) continue;
        const safeEnd = Number.isInteger(endPeriod) && endPeriod >= startPeriod && endPeriod <= maxPeriod
          ? endPeriod
          : startPeriod;
        if (!name && !seenCourseIds.has(courseId)) continue;
        const entry = {
          id: typeof ov.id === 'string' && ov.id ? truncateText(ov.id, 64) : generateId('ov'),
          type: 'add',
          courseId,
          name,
          date: ov.date,
          startPeriod,
          endPeriod: safeEnd,
          location: truncateText(ov.location),
          teacher: truncateText(ov.teacher),
          note: truncateText(ov.note, LIMITS.MAX_NOTE_LEN)
        };
        if (transferGroupId) entry.transferGroupId = transferGroupId;
        overrides.push(entry);
      }
    }
  }

  const practiceCourses = [];
  if (Array.isArray(raw.practiceCourses)) {
    for (const pc of raw.practiceCourses) {
      if (practiceCourses.length >= LIMITS.MAX_PRACTICE_COURSES) break;
      if (!pc || typeof pc !== 'object') continue;
      const rawText = truncateText(pc.raw || pc.name, LIMITS.MAX_NOTE_LEN);
      if (!rawText) continue;
      practiceCourses.push({
        id: typeof pc.id === 'string' && pc.id ? truncateText(pc.id, 64) : generateId('pc'),
        name: truncateText(pc.name || rawText),
        teacher: truncateText(pc.teacher),
        weeksText: truncateText(pc.weeksText, 80),
        raw: rawText
      });
    }
  }

  const revision = Number.isInteger(Number(raw.revision)) && Number(raw.revision) >= 1
    ? Number(raw.revision)
    : 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    term: {
      name: truncateText(rawTerm.name) || base.term.name,
      startMonday,
      totalWeeks,
      timezone,
      nextTermStartDate
    },
    periods,
    courses,
    overrides,
    practiceCourses
  };
}
