/**
 * 简课表查看 · RFC 5545 展开式 .ics 日历导出
 * - 严格复用 engine.js 的 resolveAllTermOccurrences
 * - 严格校验 IANA 时区，拒绝控制字符与非法时区
 * - 对 Asia/Shanghai 输出标准 VTIMEZONE + TZID；对其他合法 IANA 时区精确转换为真实 UTC 时刻（YYYYMMDDTHHMMSSZ），
 *   严格符合 RFC 5545 §3.2.19（不在无对应 VTIMEZONE 时输出悬空 TZID）
 */

import { resolveAllTermOccurrences } from './engine.js';
import { DEFAULT_TIMEZONE, isValidIanaTimezone } from './model.js';

function escapeIcsText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function foldIcsLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const chunks = [];
  let current = '';
  let maxBytes = 75;

  for (const ch of line) {
    const next = current + ch;
    if (encoder.encode(next).length > maxBytes) {
      chunks.push(current);
      current = ch;
      maxBytes = 74;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.join('\r\n ');
}

function formatIcsLocalDateTime(dateStr, hhmm) {
  const d = dateStr.replace(/-/g, '');
  const t = `${hhmm.replace(':', '')}00`;
  return `${d}T${t}`;
}

function formatIcsUtcStamp(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}T${hh}${mm}${ss}Z`;
}

/**
 * 将指定 IANA 时区的本地墙上时间（dateStr + hhmm）精确转换为真实 UTC Date（兼容夏令时切换）
 */
function wallTimeToUtcDate(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const desiredUtcMs = Date.UTC(y, m - 1, d, hh, mm, 0);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const getWallMs = (utcMs) => {
    const parts = fmt.formatToParts(new Date(utcMs));
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const hourVal = map.hour === '24' ? 0 : Number(map.hour);
    return Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      hourVal,
      Number(map.minute),
      Number(map.second)
    );
  };

  // 两轮迭代收敛，处理夏令时边界偏移差异
  let guess = desiredUtcMs;
  for (let i = 0; i < 2; i += 1) {
    const offset = getWallMs(guess) - guess;
    guess = desiredUtcMs - offset;
  }
  return new Date(guess);
}

function sanitizeUidPart(str) {
  return String(str || 'x').replace(/[^a-zA-Z0-9_-]/g, '');
}

export function exportScheduleToICS(data, options = {}) {
  const { alarmMinutes = 15, now = new Date() } = options;
  const rawTz = data.term?.timezone;
  const tz = isValidIanaTimezone(rawTz) ? rawTz : DEFAULT_TIMEZONE;
  const useShanghaiTzid = tz === 'Asia/Shanghai';
  const dtStamp = formatIcsUtcStamp(now);
  const occurrences = resolveAllTermOccurrences(data);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JianKeBiao//Schedule PWA V1//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(data.term?.name || '简课表查看')}`,
    `X-WR-TIMEZONE:${escapeIcsText(tz)}`
  ];

  if (useShanghaiTzid) {
    lines.push(
      'BEGIN:VTIMEZONE',
      'TZID:Asia/Shanghai',
      'X-LIC-LOCATION:Asia/Shanghai',
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0800',
      'TZOFFSETTO:+0800',
      'TZNAME:CST',
      'DTSTART:19700101T000000',
      'END:STANDARD',
      'END:VTIMEZONE'
    );
  }

  const termTag = sanitizeUidPart(data.term?.startMonday || 'term');

  for (const occ of occurrences) {
    const uid = [
      'jkb',
      termTag,
      sanitizeUidPart(occ.courseId),
      sanitizeUidPart(occ.ruleId || occ.overrideId || 'once'),
      occ.date.replace(/-/g, ''),
      `p${occ.startPeriod}`
    ].join('-') + '@jiankebiao.local';

    const descParts = [
      `第${occ.week > 0 ? occ.week : '?'}周 · 第${occ.startPeriod}-${occ.endPeriod}节`
    ];
    if (occ.teacher) descParts.push(`教师：${occ.teacher}`);
    if (occ.courseType) descParts.push(`类型：${occ.courseType}`);
    if (occ.source === 'modified') descParts.push('状态：单次已调整');
    if (occ.source === 'added') descParts.push(occ.transferGroupId ? '状态：跨天调课' : '状态：单次补课');
    if (occ.adjusted) descParts.push('标记：教务调课');
    if (occ.note) descParts.push(`备注：${occ.note}`);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${dtStamp}`);

    if (useShanghaiTzid) {
      lines.push(`DTSTART;TZID=Asia/Shanghai:${formatIcsLocalDateTime(occ.date, occ.startTime)}`);
      lines.push(`DTEND;TZID=Asia/Shanghai:${formatIcsLocalDateTime(occ.date, occ.endTime)}`);
    } else {
      lines.push(`DTSTART:${formatIcsUtcStamp(wallTimeToUtcDate(occ.date, occ.startTime, tz))}`);
      lines.push(`DTEND:${formatIcsUtcStamp(wallTimeToUtcDate(occ.date, occ.endTime, tz))}`);
    }

    lines.push(`SUMMARY:${escapeIcsText(occ.name)}`);
    if (occ.location) {
      lines.push(`LOCATION:${escapeIcsText(occ.location)}`);
    }
    lines.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`);

    if (Number.isInteger(alarmMinutes) && alarmMinutes > 0) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`TRIGGER:-PT${alarmMinutes}M`);
      lines.push(`DESCRIPTION:${escapeIcsText(`${occ.name} 即将开始（${occ.location || '请查看教室'}）`)}`);
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return {
    content: lines.map(foldIcsLine).join('\r\n') + '\r\n',
    eventCount: occurrences.length,
    timezone: tz,
    utcConverted: !useShanghaiTzid
  };
}
