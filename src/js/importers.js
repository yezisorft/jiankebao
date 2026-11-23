/**
 * 简课表查看 · 统一导入与恢复管线
 * 核心原则：
 * 1. 所有外部 HTML 仅经纯文本隔离解析，绝不触碰活动页面 DOM 或加载子资源；
 * 2. 所有 JSON / 导入码先通过 validateRawBackupPayload 严格校验版本与边界；
 * 3. buildImportPlan 按当前写入选项构造唯一 candidateData，预览展示与确认落盘使用同一份结果，零偏差。
 */

import { extractTextLines, parseInertHtmlDocument } from './html-inert-dom.js';
import { upgradeLegacyTransferPairs } from './engine.js';
import {
  DAY_NAMES,
  LIMITS,
  clonePeriodsTemplate,
  formatWeeksExpression,
  generateId,
  getUtf8ByteLength,
  makeStableCourseId,
  makeStableRuleId,
  minutesToTime,
  normalizeScheduleData,
  parseWeeksExpression,
  timeToMinutes,
  truncateText,
  validatePeriodsSchedule,
  validateRawBackupPayload,
  validateScheduleQuotas
} from './model.js';

const COURSE_TYPE_SYMBOLS = {
  '●': '讲课',
  '★': '课程实践',
  '◆': '上机'
};

function cleanText(str, maxLen = LIMITS.MAX_TEXT_LEN) {
  return truncateText(
    String(str || '').replace(/[\u00A0\u3000]+/g, ' ').replace(/\s+/g, ' '),
    maxLen
  );
}

function parseCourseTitleMeta(rawTitle) {
  let title = cleanText(rawTitle);
  let adjusted = false;
  let courseType = '';

  if (/^【调】/.test(title)) {
    adjusted = true;
    title = title.replace(/^【调】\s*/, '').trim();
  }

  const lastChar = title.slice(-1);
  if (COURSE_TYPE_SYMBOLS[lastChar]) {
    courseType = COURSE_TYPE_SYMBOLS[lastChar];
    title = title.slice(0, -1).trim();
  }

  return { name: title, adjusted, courseType };
}

function parsePeriodAndWeeks(rawText, fallbackStart, fallbackSpan = 1) {
  const text = cleanText(rawText)
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')');

  let startPeriod = fallbackStart || 1;
  let endPeriod = fallbackStart ? fallbackStart + Math.max(1, fallbackSpan) - 1 : 1;

  let remaining = text;
  const periodMatch = text.match(/\(?(\d+)(?:-(\d+))?节\)?/);
  if (periodMatch) {
    startPeriod = Number(periodMatch[1]);
    endPeriod = periodMatch[2] ? Number(periodMatch[2]) : startPeriod;
    remaining = text.replace(periodMatch[0], '').trim();
  }

  const weeks = parseWeeksExpression(remaining, LIMITS.MAX_TOTAL_WEEKS);
  return { startPeriod, endPeriod, weeks, rawWeeksText: remaining };
}

function parsePracticeRowText(text) {
  const cleaned = cleanText(text, LIMITS.MAX_NOTE_LEN).replace(/^实践课程[：:]\s*/, '');
  if (!cleaned) return [];
  return cleaned
    .split(/[;；]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, LIMITS.MAX_PRACTICE_COURSES)
    .map((item) => {
      const slashParts = item.split('/');
      const left = (slashParts[0] || '').trim();
      const weeksText = (slashParts[1] || '').trim();
      const starIdx = left.search(/[★●◆]/);
      let name = left;
      let teacher = '';
      if (starIdx > 0) {
        name = left.slice(0, starIdx).trim();
        teacher = left.slice(starIdx + 1).replace(/\(共\d+周\)/, '').trim();
      }
      return {
        id: generateId('pc'),
        name: truncateText(name || item),
        teacher: truncateText(teacher),
        weeksText: truncateText(weeksText, 80),
        raw: truncateText(item, LIMITS.MAX_NOTE_LEN)
      };
    });
}

/**
 * 适配器 1（首批真实样本验证）：正方新版教务管理系统 jwglxt V-9.0（table#kbgrid_table_0）
 */
export function parseJwglxtDocument(doc) {
  const table =
    doc.querySelector('table#kbgrid_table_0') ||
    doc.querySelector('table.timetable1') ||
    [...doc.querySelectorAll('table')].find((t) => t.querySelector('.timetable_con'));

  if (!table) return null;

  const items = [];
  const unrecognized = [];
  const practiceCourses = [];
  let termName = '';
  let maxPeriodFound = 0;
  let itemsTruncated = 0;

  const titleHeadings = table.querySelectorAll('.timetable_title h6');
  for (const h6 of titleHeadings) {
    const t = cleanText(h6.textContent);
    if (/\d{4}-\d{4}/.test(t) || /学期/.test(t)) {
      termName = t;
      break;
    }
  }

  for (const fest of table.querySelectorAll('.festival')) {
    const n = Number(cleanText(fest.textContent));
    if (Number.isInteger(n) && n >= 1 && n <= LIMITS.MAX_PERIODS && n > maxPeriodFound) {
      maxPeriodFound = n;
    }
  }

  const cells = table.querySelectorAll('td.td_wrap, td[id]');
  for (const td of cells) {
    const blocks = td.querySelectorAll('.timetable_con');
    if (blocks.length === 0) continue;

    const idAttr = cleanText(td.getAttribute('id') || '', 32);
    const idMatch = idAttr.match(/^(\d+)-(\d+)$/);
    const dayFromId = idMatch ? Number(idMatch[1]) : null;
    const periodFromId = idMatch ? Number(idMatch[2]) : null;
    const rawRowspan = Number(td.getAttribute('rowspan')) || 1;
    const rowspan = Math.max(1, Math.min(LIMITS.MAX_PERIODS, rawRowspan));

    for (const block of blocks) {
      if (items.length >= LIMITS.MAX_TOTAL_RULES) {
        itemsTruncated += 1;
        continue;
      }

      const titleEl = block.querySelector('.title');
      const rawTitle = cleanText(titleEl?.textContent || '');
      if (!rawTitle) {
        if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
          unrecognized.push({
            raw: cleanText(block.textContent, 120),
            reason: '未找到课程标题（.title）'
          });
        }
        continue;
      }

      const { name, adjusted, courseType } = parseCourseTitleMeta(rawTitle);
      const redFont = titleEl?.querySelector('font[color="red"]');
      const isPending = Boolean(redFont && (redFont.querySelector('i') || titleEl?.querySelector('i')));

      const fieldMap = Object.create(null);
      const paragraphs = block.querySelectorAll('p');
      for (const p of paragraphs) {
        const tipEl = p.querySelector('[title]');
        const label = cleanText(tipEl?.getAttribute('title') || '', 40);
        const value = cleanText(p.textContent);
        if (label) fieldMap[label] = value;
      }

      const periodWeekRaw = fieldMap['节/周'] || '';
      const location = fieldMap['上课地点'] || '';
      const teacher = fieldMap['教师'] || '';
      const teachingClass = fieldMap['教学班名称'] || '';
      const examType = fieldMap['考核方式'] || '';
      const credits = fieldMap['学分'] || '';
      const totalHours = fieldMap['总学时'] || '';
      const selectNote = fieldMap['选课备注'] || '';

      const { startPeriod, endPeriod, weeks } = parsePeriodAndWeeks(
        periodWeekRaw,
        periodFromId,
        rowspan
      );

      if (!dayFromId || dayFromId < 1 || dayFromId > 7) {
        if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
          unrecognized.push({
            raw: `${rawTitle} ${periodWeekRaw}`,
            reason: `无法确定星期列（单元格 id="${idAttr}"）`
          });
        }
        continue;
      }

      if (startPeriod < 1 || endPeriod < startPeriod || endPeriod > LIMITS.MAX_PERIODS) {
        if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
          unrecognized.push({
            raw: `${rawTitle} ${periodWeekRaw}`,
            reason: `节次范围（${startPeriod}-${endPeriod}）超出支持上限（1-${LIMITS.MAX_PERIODS}）`
          });
        }
        continue;
      }

      if (weeks.length === 0) {
        if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
          unrecognized.push({
            raw: `${rawTitle} ${periodWeekRaw}`,
            reason: `周次格式无法解析（"${periodWeekRaw}"）`
          });
        }
        continue;
      }

      if (endPeriod > maxPeriodFound) maxPeriodFound = endPeriod;

      const noteParts = [];
      if (adjusted) noteParts.push('教务已调课');
      if (isPending) noteParts.push('待筛选课程');
      if (selectNote) noteParts.push(selectNote);

      items.push({
        name,
        dayOfWeek: dayFromId,
        startPeriod,
        endPeriod,
        weeks,
        location,
        teacher,
        courseType: courseType || (location.includes('实验') ? '实验' : ''),
        adjusted,
        status: isPending ? 'pending' : 'confirmed',
        note: truncateText(noteParts.join(' · '), LIMITS.MAX_NOTE_LEN),
        meta: {
          teachingClass: truncateText(teachingClass, 80),
          examType: truncateText(examType, 40),
          credits: truncateText(credits, 20),
          totalHours: truncateText(totalHours, 20)
        }
      });
    }
  }

  if (itemsTruncated > 0 && unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
    unrecognized.push({
      raw: `超出上限条目（${itemsTruncated} 条）`,
      reason: `超过单次导入排课时段上限（${LIMITS.MAX_TOTAL_RULES} 条），已截断`
    });
  }

  for (const td of table.querySelectorAll('td[colspan]')) {
    const txt = cleanText(td.textContent, LIMITS.MAX_NOTE_LEN);
    if (txt.startsWith('实践课程：') || txt.startsWith('实践课程:')) {
      practiceCourses.push(...parsePracticeRowText(txt));
    }
  }

  return {
    adapter: 'zjiet-jwglxt-v9',
    adapterLabel: '正方新版教务表格（jwglxt V-9.0）',
    termName,
    maxPeriodFound: Math.min(maxPeriodFound, LIMITS.MAX_PERIODS),
    items,
    practiceCourses,
    unrecognized
  };
}

/**
 * 适配器 2（兜底）：通用已渲染课表 HTML 表格解析
 * - 严格按表格真实行列数上限钳制 rowspan / colspan，防止恶意超大跨度导致内存溢出；
 * - 使用 extractTextLines 跨环境一致提取 <br> / <p> / <div> 文本行。
 */
export function parseGenericTableDocument(doc) {
  const tables = doc.querySelectorAll('table');
  const dayHeaderPatterns = [
    { dow: 1, re: /星期一|周一|Mon/i },
    { dow: 2, re: /星期二|周二|Tue/i },
    { dow: 3, re: /星期三|周三|Wed/i },
    { dow: 4, re: /星期四|周四|Thu/i },
    { dow: 5, re: /星期五|周五|Fri/i },
    { dow: 6, re: /星期六|周六|Sat/i },
    { dow: 7, re: /星期日|星期天|周日|周天|Sun/i }
  ];

  for (const table of tables) {
    const allRows = table.querySelectorAll('tr');
    const rowLimit = Math.min(allRows.length, LIMITS.MAX_TABLE_ROWS);
    if (rowLimit < 3) continue;

    let headerRowIdx = -1;
    let colToDow = new Map();

    for (let r = 0; r < Math.min(rowLimit, 4); r += 1) {
      const cells = allRows[r].querySelectorAll('td, th');
      const map = new Map();
      let col = 0;
      for (const cell of cells) {
        if (col >= LIMITS.MAX_TABLE_COLS) break;
        const rawSpan = Number(cell.getAttribute('colspan')) || 1;
        const span = Math.max(1, Math.min(LIMITS.MAX_TABLE_COLS - col, rawSpan));
        const txt = cleanText(cell.textContent, 60);
        const match = dayHeaderPatterns.find((p) => p.re.test(txt));
        if (match) map.set(col, match.dow);
        col += span;
      }
      if (map.size >= 5) {
        headerRowIdx = r;
        colToDow = map;
        break;
      }
    }

    if (headerRowIdx < 0) continue;

    const occupied = Array.from({ length: rowLimit }, () => new Array(LIMITS.MAX_TABLE_COLS).fill(false));
    const items = [];
    const unrecognized = [];
    let currentPeriod = 0;
    let maxPeriodFound = 0;

    for (let r = headerRowIdx + 1; r < rowLimit; r += 1) {
      const cells = allRows[r].querySelectorAll('td, th');
      if (cells.length === 1 && (Number(cells[0].getAttribute('colspan')) || 1) >= 5) {
        continue;
      }
      currentPeriod += 1;
      if (currentPeriod > LIMITS.MAX_PERIODS) break;

      let col = 0;
      for (const cell of cells) {
        while (col < LIMITS.MAX_TABLE_COLS && occupied[r][col]) col += 1;
        if (col >= LIMITS.MAX_TABLE_COLS) break;

        const rawRowspan = Number(cell.getAttribute('rowspan')) || 1;
        const rawColspan = Number(cell.getAttribute('colspan')) || 1;
        const rowspan = Math.max(1, Math.min(rowLimit - r, LIMITS.MAX_PERIODS, rawRowspan));
        const colspan = Math.max(1, Math.min(LIMITS.MAX_TABLE_COLS - col, rawColspan));

        for (let dr = 0; dr < rowspan; dr += 1) {
          for (let dc = 0; dc < colspan; dc += 1) {
            occupied[r + dr][col + dc] = true;
          }
        }

        const dow = colToDow.get(col);
        const lines = extractTextLines(cell);

        if (dow && lines.length > 0 && items.length < LIMITS.MAX_TOTAL_RULES) {
          const joined = lines.join(' ');
          const weekRegex = /(?:\(\d+(?:-\d+)?节\))?\s*(?:第?\d+(?:-\d+)?周(?:\([单双]\)|[单双])?(?:[,，]\s*第?\d+(?:-\d+)?周(?:\([单双]\)|[单双])?)*)/;
          const weekLineIdx = lines.findIndex((l) => weekRegex.test(l));
          const weekMatch = weekLineIdx >= 0 ? lines[weekLineIdx].match(weekRegex) : joined.match(weekRegex);

          const rawTitle = lines[0] || '';
          if (!rawTitle || !weekMatch) {
            if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
              unrecognized.push({
                raw: truncateText(joined, 120),
                reason: '通用表格无法识别周次信息，建议手动补录'
              });
            }
          } else {
            const { name, adjusted, courseType } = parseCourseTitleMeta(
              weekLineIdx === 0 ? rawTitle.replace(weekMatch[0], '') : rawTitle
            );
            const { startPeriod, endPeriod, weeks } = parsePeriodAndWeeks(
              weekMatch[0],
              currentPeriod,
              rowspan
            );

            // 从剩余行中依次提取地点与教师
            const restLines = lines.filter((_, idx) => idx !== 0 && idx !== weekLineIdx);
            const location = truncateText(restLines[0] || '');
            const teacher = truncateText(restLines[1] || '');

            if (name && weeks.length > 0 && startPeriod >= 1 && endPeriod <= LIMITS.MAX_PERIODS) {
              if (endPeriod > maxPeriodFound) maxPeriodFound = endPeriod;
              items.push({
                name,
                dayOfWeek: dow,
                startPeriod,
                endPeriod,
                weeks,
                location,
                teacher,
                courseType,
                adjusted,
                status: 'confirmed',
                note: '',
                meta: {}
              });
            } else if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
              unrecognized.push({
                raw: truncateText(joined, 120),
                reason: '课程名、周次或节次超出有效范围'
              });
            }
          }
        }

        col += colspan;
      }
    }

    return {
      adapter: 'generic-table',
      adapterLabel: '通用已渲染 HTML 表格解析（兜底模式）',
      termName: '',
      maxPeriodFound: Math.min(Math.max(maxPeriodFound, currentPeriod), LIMITS.MAX_PERIODS),
      items,
      practiceCourses: [],
      unrecognized
    };
  }

  return null;
}

export function parseTimetableHtml(html) {
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, error: '输入内容为空，请粘贴已渲染课表的 <table> HTML。' };
  }
  if (getUtf8ByteLength(html) > LIMITS.MAX_HTML_BYTES) {
    return {
      ok: false,
      error: `HTML 体积超过安全上限（最大 ${Math.round(LIMITS.MAX_HTML_BYTES / 1024 / 1024)} MB），请仅复制课表 <table> 部分。`
    };
  }

  let doc;
  try {
    doc = parseInertHtmlDocument(html);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const jwResult = parseJwglxtDocument(doc);
  if (jwResult) return { ok: true, kind: 'html', ...jwResult };

  const genericResult = parseGenericTableDocument(doc);
  if (genericResult) return { ok: true, kind: 'html', ...genericResult };

  return {
    ok: false,
    error: '未在内容中识别到有效的课表表格（<table>）。请确认复制的是「已渲染后的课表 DOM」，而不是动态页面的空壳网页源代码。'
  };
}

/**
 * 解析完整 JSON 备份（严格先按 UTF-8 字节预算与 validateRawBackupPayload 校验版本与边界）
 */
export function parseJsonBackup(jsonTextOrObj) {
  let raw;
  if (typeof jsonTextOrObj === 'string') {
    if (getUtf8ByteLength(jsonTextOrObj) > LIMITS.MAX_JSON_BYTES) {
      return {
        ok: false,
        error: `JSON 文件体积超过安全上限（最大 ${Math.round(LIMITS.MAX_JSON_BYTES / 1024 / 1024)} MB）。`
      };
    }
    try {
      raw = JSON.parse(jsonTextOrObj);
    } catch {
      return { ok: false, error: 'JSON 格式解析失败，请确认文件完整未被截断。' };
    }
  } else {
    raw = jsonTextOrObj;
  }

  const validation = validateRawBackupPayload(raw);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  // 对备份中唯一可确认的旧版 v1.0.2 跨天调课自动补齐关联标识（有歧义的保持不动）
  const normalized = upgradeLegacyTransferPairs(validation.normalized).data;
  const courseDefaultsById = new Map();
  const items = [];
  for (const c of normalized.courses) {
    courseDefaultsById.set(c.id, {
      id: c.id,
      name: c.name,
      teacher: c.teacher || '',
      location: c.location || '',
      note: c.note || '',
      meta: c.meta ? { ...c.meta } : {}
    });
    for (const r of c.schedules) {
      items.push({
        courseId: c.id,
        ruleId: r.ruleId,
        name: c.name,
        dayOfWeek: r.dayOfWeek,
        startPeriod: r.startPeriod,
        endPeriod: r.endPeriod,
        weeks: r.weeks,
        // 展示、去重与冲突检测用有效值（回退到课程默认值）
        location: r.location || c.location,
        teacher: r.teacher || c.teacher,
        note: r.note || c.note,
        // 落盘时忠实保留规则层原始覆盖值（含空串继承语义）
        hasExplicitRuleFields: true,
        ruleLocation: r.location || '',
        ruleTeacher: r.teacher || '',
        ruleNote: r.note || '',
        courseType: r.courseType,
        adjusted: r.adjusted,
        status: r.status,
        meta: c.meta
      });
    }
  }

  return {
    ok: true,
    kind: 'backup',
    adapter: 'schema-v1-json',
    adapterLabel: '完整备份 Schema v1（含课程、调停课例外、作息与学期设置）',
    termName: normalized.term.name,
    maxPeriodFound: normalized.periods.length,
    fullData: normalized,
    courseDefaultsById,
    items,
    overridesCount: normalized.overrides.length,
    practiceCourses: normalized.practiceCourses,
    unrecognized: validation.droppedIssues
  };
}

function slotSignature(item) {
  return [
    item.name,
    item.dayOfWeek,
    item.startPeriod,
    item.endPeriod,
    item.weeks.join(','),
    item.location || '',
    item.teacher || ''
  ].join('|');
}

function hasWeekOverlap(w1, w2) {
  const set = new Set(w1);
  return w2.some((w) => set.has(w));
}

function hasPeriodOverlap(a, b) {
  return a.startPeriod <= b.endPeriod && b.startPeriod <= a.endPeriod;
}

/**
 * 安全扩展作息表（绝不把晚间节次反复钳制到同一分钟导致交叉重叠）：
 * - 生成候选作息后立即使用 validatePeriodsSchedule 校验；
 * - 若当日剩余时间（至 23:59 止）不足以扩展到目标节次，明确返回 ok: false，由调用方保留原课表并引导手动调整作息。
 */
export function tryExpandPeriodsSafely(periods, targetCount) {
  const baseCheck = validatePeriodsSchedule(periods);
  if (!baseCheck.ok) {
    return { ok: false, error: `当前作息表无效：${baseCheck.error}` };
  }
  const cappedTarget = Math.min(LIMITS.MAX_PERIODS, Math.max(periods.length, Number(targetCount) || 0));
  const next = periods.map((p, idx) => ({ ...p, index: idx + 1 }));
  if (cappedTarget <= next.length) return { ok: true, periods: next };

  const tpl13 = clonePeriodsTemplate('zjiet-13');
  const MAX_MINUTE = 23 * 60 + 59; // 23:59
  for (let i = next.length; i < cappedTarget; i += 1) {
    const prevEnd = timeToMinutes(next[next.length - 1].end);
    const tplItem = tpl13[i];
    if (tplItem && timeToMinutes(tplItem.start) >= prevEnd) {
      next.push({ index: i + 1, start: tplItem.start, end: tplItem.end });
    } else {
      const startMin = prevEnd + 5;
      const endMin = startMin + 45;
      if (endMin > MAX_MINUTE) {
        const lastPeriod = periods[periods.length - 1];
        return {
          ok: false,
          error: `当前作息表第 ${periods.length} 节结束于 ${lastPeriod.end}，当日剩余时间不足以自动扩展至第 ${cappedTarget} 节（不可超过 23:59），已保留原课表；请先在「设置 → 作息时间」中手动调整后再导入。`
        };
      }
      next.push({ index: i + 1, start: minutesToTime(startMin), end: minutesToTime(endMin) });
    }
  }

  const finalCheck = validatePeriodsSchedule(next);
  if (!finalCheck.ok) {
    return {
      ok: false,
      error: `自动扩展作息至第 ${cappedTarget} 节失败（${finalCheck.error}），已保留原课表；请先在「设置 → 作息时间」中手动调整。`
    };
  }
  return { ok: true, periods: next };
}

/**
 * 唯一候选计划构建器：
 * 按当前选项（mode / restoreSettings / expandPeriodsIfNeeded）直接构造最终将保存的 candidateData，
 * 并基于最终候选数据与原课表的真实差异计算写入统计、冲突明细与保存前不变量——确保预览所见即落盘所得。
 */
export function buildImportPlan(currentData, parseResult, options = {}) {
  if (!parseResult || !parseResult.ok) {
    return { ok: false, error: parseResult?.error || '解析失败' };
  }

  const baseCurrent = normalizeScheduleData(currentData);
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const restoreSettings = options.restoreSettings !== undefined
    ? Boolean(options.restoreSettings)
    : (parseResult.kind === 'backup' && mode === 'replace');
  const expandPeriodsIfNeeded = options.expandPeriodsIfNeeded !== undefined
    ? Boolean(options.expandPeriodsIfNeeded)
    : true;

  // 决定最终作息表与学期设置
  const useBackupSettings = parseResult.kind === 'backup' && parseResult.fullData && mode === 'replace' && restoreSettings;
  let nextTerm = useBackupSettings ? structuredClone(parseResult.fullData.term) : structuredClone(baseCurrent.term);
  let nextPeriods = useBackupSettings ? structuredClone(parseResult.fullData.periods) : structuredClone(baseCurrent.periods);

  if (!useBackupSettings && parseResult.termName && mode === 'replace') {
    nextTerm.name = parseResult.termName;
  }

  const rawMaxPeriodNeeded = Math.min(
    LIMITS.MAX_PERIODS,
    Math.max(
      parseResult.maxPeriodFound || 0,
      ...(parseResult.items || []).map((a) => Number(a.endPeriod) || 0),
      0
    )
  );
  const needsMorePeriods = !useBackupSettings && rawMaxPeriodNeeded > nextPeriods.length;

  let periodExpansionError = '';
  if (needsMorePeriods && expandPeriodsIfNeeded) {
    const expanded = tryExpandPeriodsSafely(nextPeriods, rawMaxPeriodNeeded);
    if (expanded.ok) {
      nextPeriods = expanded.periods;
    } else {
      periodExpansionError = expanded.error;
    }
  }

  const activeMaxPeriod = nextPeriods.length;

  // 若用户启用了自动扩展作息但当日剩余时间不足以安全扩展：立即中止本次写入计划，完整保留原课表与原作息（绝不退回默认 13 节）
  if (periodExpansionError) {
    const blockedUnrecognized = [...(parseResult.unrecognized || [])].slice(0, LIMITS.MAX_UNRECOGNIZED_DETAILS);
    for (const item of parseResult.items || []) {
      if (item.endPeriod > activeMaxPeriod && blockedUnrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
        blockedUnrecognized.push({
          raw: `${item.name}（第${item.startPeriod}-${item.endPeriod}节）`,
          reason: `超出当前作息（1-${activeMaxPeriod} 节）且自动扩展至第 ${rawMaxPeriodNeeded} 节失败，请先手动调整作息`
        });
      }
    }
    const preserved = structuredClone(baseCurrent);
    return {
      ok: true,
      canCommit: false,
      commitBlockedReason: periodExpansionError,
      periodExpansionError,
      kind: parseResult.kind,
      mode,
      restoreSettings: useBackupSettings,
      expandPeriodsIfNeeded,
      adapter: parseResult.adapter,
      adapterLabel: parseResult.adapterLabel,
      termName: parseResult.termName || '',
      maxPeriodNeeded: rawMaxPeriodNeeded,
      needsMorePeriods,
      incomingCourseCount: 0,
      writtenRuleCount: 0,
      finalCourseCount: preserved.courses.length,
      finalRuleCount: preserved.courses.reduce((sum, c) => sum + c.schedules.length, 0),
      finalOverridesCount: preserved.overrides.length,
      courses: preserved.courses,
      accepted: [],
      duplicates: [],
      conflicts: [],
      conflictsTruncated: 0,
      unrecognized: blockedUnrecognized,
      practiceCourses: preserved.practiceCourses,
      overridesCount: parseResult.overridesCount || 0,
      candidateData: preserved
    };
  }

  // 预建已有条目签名表、稳定规则键与配额统计（merge 模式下先全量保留现有记录，仅用剩余配额接纳新项）
  const existingFlatSlots = [];
  const existingDisplaySigs = new Set();
  const existingRuleKeys = new Set();
  const knownCourseIds = new Set();
  const perCourseRuleCounts = new Map();
  const existingRuleIdBySig = new Map();
  let existingTotalRules = 0;

  for (const c of baseCurrent.courses) {
    for (const r of c.schedules) {
      const slot = {
        source: 'existing',
        courseId: c.id,
        ruleId: r.ruleId,
        name: c.name,
        dayOfWeek: r.dayOfWeek,
        startPeriod: r.startPeriod,
        endPeriod: r.endPeriod,
        weeks: r.weeks,
        location: r.location || c.location,
        teacher: r.teacher || c.teacher
      };
      const sig = slotSignature(slot);
      if (!existingRuleIdBySig.has(sig)) {
        existingRuleIdBySig.set(sig, r.ruleId);
      }
      if (mode === 'merge') {
        existingFlatSlots.push(slot);
        existingDisplaySigs.add(sig);
        existingRuleKeys.add(`${c.id}::${r.ruleId}`);
        existingTotalRules += 1;
      }
    }
    if (mode === 'merge') {
      knownCourseIds.add(c.id);
      perCourseRuleCounts.set(c.id, c.schedules.length);
    }
  }

  // 完整 JSON / 导入码备份已具备通过校验的稳定 (courseId, ruleId) 与关联例外，绝不按展示字段合并不同规则；
  // 仅对无稳定 ID 的 HTML 课表按展示字段去重。
  const preserveDistinctBackupRules = parseResult.kind === 'backup';
  const seenIncomingDisplaySigs = new Set();
  const seenIncomingRuleKeys = new Set();

  let remainingGlobalRules = Math.max(0, LIMITS.MAX_TOTAL_RULES - existingTotalRules);
  const accepted = [];
  const duplicates = [];
  const unrecognized = [...(parseResult.unrecognized || [])].slice(0, LIMITS.MAX_UNRECOGNIZED_DETAILS);
  const keptRuleKeyMap = new Map();

  for (const item of parseResult.items || []) {
    if (!item.name || !Array.isArray(item.weeks) || item.weeks.length === 0) {
      if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
        unrecognized.push({ raw: item.name || '未命名', reason: '缺少课程名或有效周次' });
      }
      continue;
    }

    if (item.startPeriod < 1 || item.endPeriod < item.startPeriod || item.endPeriod > activeMaxPeriod) {
      if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
        unrecognized.push({
          raw: `${item.name}（第${item.startPeriod}-${item.endPeriod}节）`,
          reason: `超出当前作息表节数（1-${activeMaxPeriod} 节），请勾选自动扩展作息或先在设置中增加节次`
        });
      }
      continue;
    }

    const sig = slotSignature(item);
    const targetCourseId = item.courseId || makeStableCourseId(item.name);
    const incomingRuleKey = item.courseId && item.ruleId ? `${item.courseId}::${item.ruleId}` : '';

    let isDuplicate = false;
    let duplicateReason = '';
    if (preserveDistinctBackupRules) {
      if (incomingRuleKey && seenIncomingRuleKeys.has(incomingRuleKey)) {
        isDuplicate = true;
        duplicateReason = '备份内存在完全相同的规则标识，已自动去重';
      } else if (mode === 'merge' && ((incomingRuleKey && existingRuleKeys.has(incomingRuleKey)) || existingDisplaySigs.has(sig))) {
        isDuplicate = true;
        duplicateReason = '与现有课表条目一致，合并时已去重跳过';
      }
    } else if (mode === 'merge' && existingDisplaySigs.has(sig)) {
      isDuplicate = true;
      duplicateReason = '与现有课表条目完全一致，已去重跳过';
    } else if (seenIncomingDisplaySigs.has(sig)) {
      isDuplicate = true;
      duplicateReason = '与本次导入内已有条目重复，已自动去重';
    }

    if (isDuplicate) {
      duplicates.push({
        name: item.name,
        summary: `${DAY_NAMES[item.dayOfWeek]} 第${item.startPeriod}-${item.endPeriod}节 · ${formatWeeksExpression(item.weeks)} · ${item.location || '未标地点'}`,
        reason: duplicateReason
      });
      continue;
    }

    // 严格先检容量配额（不挤掉任何已有记录）
    if (!knownCourseIds.has(targetCourseId) && knownCourseIds.size >= LIMITS.MAX_COURSES) {
      if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
        unrecognized.push({
          raw: item.name,
          reason: `课程总数已达上限（${LIMITS.MAX_COURSES} 门），保留全部现有课程，此新增条目未写入`
        });
      }
      continue;
    }

    if (remainingGlobalRules <= 0) {
      if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
        unrecognized.push({
          raw: `${item.name}（${DAY_NAMES[item.dayOfWeek]} 第${item.startPeriod}-${item.endPeriod}节）`,
          reason: `全库排课时段已达上限（${LIMITS.MAX_TOTAL_RULES} 条），保留全部现有排课，此新增条目未写入`
        });
      }
      continue;
    }

    const courseUsedRules = perCourseRuleCounts.get(targetCourseId) || 0;
    if (courseUsedRules >= LIMITS.MAX_RULES_PER_COURSE) {
      if (unrecognized.length < LIMITS.MAX_UNRECOGNIZED_DETAILS) {
        unrecognized.push({
          raw: `${item.name}（${DAY_NAMES[item.dayOfWeek]} 第${item.startPeriod}-${item.endPeriod}节）`,
          reason: `该课程排课时段已达上限（${LIMITS.MAX_RULES_PER_COURSE} 条），此新增条目未写入`
        });
      }
      continue;
    }

    if (incomingRuleKey) seenIncomingRuleKeys.add(incomingRuleKey);
    if (!preserveDistinctBackupRules) seenIncomingDisplaySigs.add(sig);
    knownCourseIds.add(targetCourseId);
    perCourseRuleCounts.set(targetCourseId, courseUsedRules + 1);
    remainingGlobalRules -= 1;
    accepted.push(item);
  }

  // 基于「最终将存在的全部排课」做冲突检测
  const conflicts = [];
  let conflictsTruncated = 0;
  const comparePool = [...existingFlatSlots];

  for (const item of accepted) {
    for (const prev of comparePool) {
      if (
        prev.dayOfWeek === item.dayOfWeek &&
        hasPeriodOverlap(prev, item) &&
        hasWeekOverlap(prev.weeks, item.weeks)
      ) {
        if (conflicts.length < LIMITS.MAX_CONFLICT_DETAILS) {
          const sharedWeeks = item.weeks.filter((w) => prev.weeks.includes(w));
          const prefix = prev.source === 'existing' ? '[已有]' : '';
          conflicts.push({
            a: `${prefix}${prev.name}（第${prev.startPeriod}-${prev.endPeriod}节）`,
            b: `${item.name}（第${item.startPeriod}-${item.endPeriod}节）`,
            detail: `${DAY_NAMES[item.dayOfWeek]} · 冲突周次：${formatWeeksExpression(sharedWeeks)}`
          });
        } else {
          conflictsTruncated += 1;
        }
      }
    }
    comparePool.push({ ...item, source: 'incoming' });
  }

  // 组装最终 courses（replace 从空开始，merge 完整保留 baseCurrent.courses 并忠实保留备份的课程默认字段）
  const courseMap = new Map();
  if (mode === 'merge') {
    for (const c of baseCurrent.courses) {
      courseMap.set(c.id, structuredClone(c));
    }
  }

  const courseDefaultsById = parseResult.courseDefaultsById instanceof Map ? parseResult.courseDefaultsById : null;

  for (const item of accepted) {
    const courseId = item.courseId || makeStableCourseId(item.name);
    if (!courseMap.has(courseId)) {
      const defaults = courseDefaultsById?.get(courseId);
      if (defaults) {
        courseMap.set(courseId, {
          id: courseId,
          name: defaults.name,
          teacher: defaults.teacher,
          location: defaults.location,
          note: defaults.note,
          meta: { ...defaults.meta },
          schedules: []
        });
      } else {
        courseMap.set(courseId, {
          id: courseId,
          name: item.name,
          teacher: item.teacher || '',
          location: item.location || '',
          note: '',
          meta: item.meta ? { ...item.meta } : {},
          schedules: []
        });
      }
    }

    const course = courseMap.get(courseId);
    const existingRuleIds = course.schedules.map((s) => s.ruleId);
    const sig = slotSignature(item);
    let desiredRuleId;

    if (item.ruleId && !existingRuleIds.includes(item.ruleId)) {
      desiredRuleId = item.ruleId;
    } else if (!preserveDistinctBackupRules && existingRuleIdBySig.has(sig) && !existingRuleIds.includes(existingRuleIdBySig.get(sig))) {
      desiredRuleId = existingRuleIdBySig.get(sig);
    } else {
      desiredRuleId = makeStableRuleId(courseId, item, existingRuleIds);
    }

    if (item.courseId && item.ruleId) {
      keptRuleKeyMap.set(`${item.courseId}::${item.ruleId}`, `${courseId}::${desiredRuleId}`);
    }

    course.schedules.push({
      ruleId: desiredRuleId,
      dayOfWeek: item.dayOfWeek,
      startPeriod: item.startPeriod,
      endPeriod: item.endPeriod,
      weeks: [...item.weeks].sort((a, b) => a - b),
      location: item.hasExplicitRuleFields ? item.ruleLocation : (item.location || ''),
      teacher: item.hasExplicitRuleFields ? item.ruleTeacher : (item.teacher || ''),
      note: item.hasExplicitRuleFields ? item.ruleNote : (item.note || ''),
      adjusted: Boolean(item.adjusted),
      courseType: item.courseType || '',
      status: item.status === 'pending' ? 'pending' : 'confirmed'
    });
  }

  // 若备份里存在没有任何排课时段但有课程定义的课程（仅在 replace + restoreSettings 时完整保留）
  if (useBackupSettings && courseDefaultsById) {
    for (const [cid, defaults] of courseDefaultsById.entries()) {
      if (!courseMap.has(cid) && courseMap.size < LIMITS.MAX_COURSES) {
        courseMap.set(cid, {
          id: cid,
          name: defaults.name,
          teacher: defaults.teacher,
          location: defaults.location,
          note: defaults.note,
          meta: { ...defaults.meta },
          schedules: []
        });
      }
    }
  }

  const finalCourses = [...courseMap.values()];

  // 严格按选项决定 overrides 与 practiceCourses（勾选恢复设置时才恢复备份里的例外）
  let finalOverrides = [];
  if (mode === 'merge') {
    finalOverrides = structuredClone(baseCurrent.overrides);
  } else if (useBackupSettings && parseResult.fullData) {
    // 过滤并保留指向已保留规则的例外 + 有效补课
    const validRuleKeys = new Set();
    for (const c of finalCourses) {
      for (const r of c.schedules) validRuleKeys.add(`${c.id}::${r.ruleId}`);
    }
    finalOverrides = structuredClone(parseResult.fullData.overrides).filter((ov) => {
      if (ov.type === 'cancel' || ov.type === 'modify') {
        const mapped = keptRuleKeyMap.get(`${ov.courseId}::${ov.ruleId}`);
        if (mapped) {
          const [cid, rid] = mapped.split('::');
          ov.courseId = cid;
          ov.ruleId = rid;
        }
        return validRuleKeys.has(`${ov.courseId}::${ov.ruleId}`);
      }
      return ov.endPeriod <= activeMaxPeriod;
    });
  }

  let finalPracticeCourses = [];
  if (mode === 'merge') {
    finalPracticeCourses = structuredClone(baseCurrent.practiceCourses || []);
    const seenRaw = new Set(finalPracticeCourses.map((p) => p.raw));
    for (const pc of parseResult.practiceCourses || []) {
      if (!seenRaw.has(pc.raw) && finalPracticeCourses.length < LIMITS.MAX_PRACTICE_COURSES) {
        finalPracticeCourses.push(structuredClone(pc));
        seenRaw.add(pc.raw);
      }
    }
  } else {
    finalPracticeCourses = structuredClone(parseResult.practiceCourses || []).slice(0, LIMITS.MAX_PRACTICE_COURSES);
  }

  const rawCandidate = {
    schemaVersion: baseCurrent.schemaVersion,
    revision: baseCurrent.revision,
    updatedAt: new Date().toISOString(),
    term: nextTerm,
    periods: nextPeriods,
    courses: finalCourses,
    overrides: finalOverrides,
    practiceCourses: finalPracticeCourses
  };

  // 硬前置不变量校验：作息必须有效且绝不静默回退、配额不得超限
  const periodValid = validatePeriodsSchedule(rawCandidate.periods);
  if (!periodValid.ok) {
    return { ok: false, error: `作息时间表校验失败（${periodValid.error}），已中止此次导入以保护原课表。` };
  }
  const quotaValid = validateScheduleQuotas(rawCandidate);
  if (!quotaValid.ok) {
    return { ok: false, error: quotaValid.error };
  }

  const candidateData = normalizeScheduleData(rawCandidate, nextTerm.startMonday, { strictOverrideRefs: true });

  // 确认规整后作息未被回退，且合并模式下全部原有规则 100% 完整保留
  if (candidateData.periods.length !== nextPeriods.length) {
    return { ok: false, error: '作息时间表在规整阶段出现异常回退，已中止此次导入以保护原课表。' };
  }

  const candidateRuleKeys = new Set();
  const writtenCourseIds = new Set();
  for (const c of candidateData.courses) {
    for (const r of c.schedules) {
      const rk = `${c.id}::${r.ruleId}`;
      candidateRuleKeys.add(rk);
      if (mode === 'replace' || !existingRuleKeys.has(rk)) {
        writtenCourseIds.add(c.id);
      }
    }
  }

  if (mode === 'merge') {
    if (candidateData.periods.length < baseCurrent.periods.length) {
      return { ok: false, error: '合并后作息节数小于原课表，已中止合并以保护现有排课。' };
    }
    for (const oldKey of existingRuleKeys) {
      if (!candidateRuleKeys.has(oldKey)) {
        return { ok: false, error: '合并校验未通过：检测到原有排课时段可能丢失，已中止此次合并以保护原课表。' };
      }
    }
  }

  // 从最终 candidateData 与原课表的真实差异计算本次写入数（预览所见 === 最终落盘增量）
  const writtenRuleCount = mode === 'merge'
    ? candidateRuleKeys.size - existingRuleKeys.size
    : candidateRuleKeys.size;
  const canCommit = writtenRuleCount > 0 || (parseResult.kind === 'backup' && mode === 'replace' && useBackupSettings);

  return {
    ok: true,
    canCommit,
    commitBlockedReason: canCommit ? '' : '本次无可写入的新增排课时段',
    periodExpansionError: '',
    kind: parseResult.kind,
    mode,
    restoreSettings: useBackupSettings,
    expandPeriodsIfNeeded,
    adapter: parseResult.adapter,
    adapterLabel: parseResult.adapterLabel,
    termName: parseResult.termName || '',
    maxPeriodNeeded: rawMaxPeriodNeeded,
    needsMorePeriods,
    incomingCourseCount: writtenCourseIds.size,
    writtenRuleCount,
    finalCourseCount: candidateData.courses.length,
    finalRuleCount: candidateRuleKeys.size,
    finalOverridesCount: candidateData.overrides.length,
    courses: candidateData.courses,
    accepted,
    duplicates,
    conflicts,
    conflictsTruncated,
    unrecognized,
    practiceCourses: candidateData.practiceCourses,
    overridesCount: parseResult.overridesCount || 0,
    candidateData
  };
}

// 兼容便捷包装
export function buildImportPreview(parseResult, currentData = null, options = {}) {
  return buildImportPlan(currentData, parseResult, options);
}

export function commitImportPreview(currentData, previewOrPlan, options = {}) {
  if (previewOrPlan?.periodExpansionError) {
    throw new Error(previewOrPlan.periodExpansionError);
  }
  if (previewOrPlan?.candidateData && !options._recompute) {
    return structuredClone(previewOrPlan.candidateData);
  }
  const plan = buildImportPlan(currentData, previewOrPlan, options);
  if (!plan.ok) throw new Error(plan.error || '导入计划构建失败');
  if (plan.periodExpansionError) throw new Error(plan.periodExpansionError);
  return plan.candidateData;
}

export function getSameOriginExtractorSnippet() {
  return `(() => {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (_) {}
  }
  let table = null;
  for (const d of docs) {
    table = d.querySelector('table#kbgrid_table_0') || d.querySelector('table.timetable1');
    if (table) break;
  }
  if (!table) {
    for (const d of docs) {
      table = [...d.querySelectorAll('table')].find(t => /星期一|周一/.test(t.textContent || ''));
      if (table) break;
    }
  }
  if (!table) return console.warn('未在当前页面或同源 iframe 中找到已渲染的课表表格。');
  const html = table.outerHTML;
  if (typeof copy === 'function') {
    copy(html);
    console.log('✅ 已复制课表表格 HTML（长度 ' + html.length + ' 字符），请回到「简课表查看」粘贴导入。');
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(html).then(() => alert('已复制课表表格 HTML，请回到「简课表查看」粘贴导入。'));
  } else {
    console.log(html);
  }
})();`;
}
