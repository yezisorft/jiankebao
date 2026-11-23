/**
 * 简课表查看 · 统一实际课次引擎（Single Source of Truth）
 * 今日视图、周视图、.ics 导出严格共用此模块输出的 Occurrence。
 */

import {
  addDays,
  diffDays,
  formatWeeksExpression,
  generateId,
  generateUniqueRuleId,
  getCourseColorIndex,
  getDateForWeekAndDay,
  getDayOfWeekISO,
  isValidDateStr,
  makeStableCourseId,
  timeToMinutes,
  truncateText
} from './model.js';

export function getTermStatus(data, todayStr) {
  const { startMonday, totalWeeks, nextTermStartDate } = data.term;
  const termEndDate = addDays(startMonday, totalWeeks * 7 - 1);
  const delta = diffDays(startMonday, todayStr);

  if (delta < 0) {
    return {
      phase: 'before',
      currentWeek: 1,
      daysUntilStart: -delta,
      termEndDate,
      nextTermDays: null
    };
  }

  const weekNum = Math.floor(delta / 7) + 1;
  if (weekNum <= totalWeeks) {
    return {
      phase: 'active',
      currentWeek: weekNum,
      daysUntilStart: 0,
      termEndDate,
      nextTermDays: null
    };
  }

  let nextTermDays = null;
  if (isValidDateStr(nextTermStartDate)) {
    const nextDelta = diffDays(todayStr, nextTermStartDate);
    if (nextDelta > 0) nextTermDays = nextDelta;
  }

  return {
    phase: 'ended',
    currentWeek: totalWeeks,
    daysUntilStart: 0,
    termEndDate,
    nextTermDays
  };
}

export function getWeekNumberForDate(data, dateStr) {
  const delta = diffDays(data.term.startMonday, dateStr);
  if (delta < 0) return Math.floor(delta / 7);
  return Math.floor(delta / 7) + 1;
}

export function getPeriodTimeRange(periods, startPeriod, endPeriod) {
  const startP = periods.find((p) => p.index === startPeriod) || periods[startPeriod - 1];
  const endP = periods.find((p) => p.index === endPeriod) || periods[endPeriod - 1] || startP;
  return {
    startTime: startP ? startP.start : '08:00',
    endTime: endP ? endP.end : '08:45'
  };
}

/**
 * 计算某一具体日期的实际课次（包含 rule、modify、add，并过滤 cancel）
 */
export function resolveOccurrencesForDate(data, dateStr, options = {}) {
  const { includeCancelled = false } = options;
  if (!isValidDateStr(dateStr)) return [];

  const weekNum = getWeekNumberForDate(data, dateStr);
  const dayOfWeek = getDayOfWeekISO(dateStr);
  const courseMap = new Map(data.courses.map((c) => [c.id, c]));

  const cancelMap = new Map();
  const modifyMap = new Map();
  const addedList = [];

  for (const ov of data.overrides || []) {
    if (ov.date !== dateStr) continue;
    if (ov.type === 'cancel') {
      cancelMap.set(`${ov.courseId}::${ov.ruleId}`, ov);
    } else if (ov.type === 'modify') {
      modifyMap.set(`${ov.courseId}::${ov.ruleId}`, ov);
    } else if (ov.type === 'add') {
      addedList.push(ov);
    }
  }

  const results = [];

  if (weekNum >= 1 && weekNum <= data.term.totalWeeks) {
    for (const course of data.courses || []) {
      for (const rule of course.schedules || []) {
        if (rule.dayOfWeek !== dayOfWeek) continue;
        if (!rule.weeks.includes(weekNum)) continue;

        const key = `${course.id}::${rule.ruleId}`;
        const cancelledOv = cancelMap.get(key);
        const modifiedOv = modifyMap.get(key);

        if (cancelledOv && !includeCancelled) continue;

        const patch = modifiedOv?.patch || {};
        const startPeriod = patch.startPeriod ?? rule.startPeriod;
        const endPeriod = patch.endPeriod ?? rule.endPeriod;
        const location = patch.location !== undefined ? patch.location : (rule.location || course.location || '');
        const teacher = patch.teacher !== undefined ? patch.teacher : (rule.teacher || course.teacher || '');
        const note = patch.note !== undefined ? patch.note : (rule.note || course.note || '');
        const { startTime, endTime } = getPeriodTimeRange(data.periods, startPeriod, endPeriod);

        results.push({
          occurrenceKey: `${dateStr}::${course.id}::${rule.ruleId}`,
          date: dateStr,
          week: weekNum,
          dayOfWeek,
          courseId: course.id,
          ruleId: rule.ruleId,
          overrideId: cancelledOv?.id || modifiedOv?.id || null,
          transferGroupId: cancelledOv?.transferGroupId || null,
          source: cancelledOv ? 'cancelled' : (modifiedOv ? 'modified' : 'rule'),
          cancelled: Boolean(cancelledOv),
          cancelReason: cancelledOv?.reason || '',
          name: course.name,
          location,
          teacher,
          note,
          meta: course.meta || {},
          courseType: rule.courseType || '',
          adjusted: Boolean(rule.adjusted),
          status: rule.status || 'confirmed',
          weeksText: formatWeeksExpression(rule.weeks),
          startPeriod,
          endPeriod,
          startTime,
          endTime,
          colorIndex: getCourseColorIndex(course.id)
        });
      }
    }
  }

  for (const ov of addedList) {
    const linked = courseMap.get(ov.courseId);
    const name = ov.name || linked?.name || '临时课程';
    const location = ov.location || linked?.location || '';
    const teacher = ov.teacher || linked?.teacher || '';
    const { startTime, endTime } = getPeriodTimeRange(data.periods, ov.startPeriod, ov.endPeriod);

    results.push({
      occurrenceKey: `${dateStr}::add::${ov.id}`,
      date: dateStr,
      week: weekNum,
      dayOfWeek,
      courseId: ov.courseId,
      ruleId: null,
      overrideId: ov.id,
      transferGroupId: ov.transferGroupId || null,
      source: 'added',
      cancelled: false,
      cancelReason: '',
      name,
      location,
      teacher,
      note: ov.note || '',
      meta: linked?.meta || {},
      courseType: '',
      adjusted: false,
      status: 'confirmed',
      weeksText: ov.transferGroupId ? '跨天调课' : '单次补课',
      startPeriod: ov.startPeriod,
      endPeriod: ov.endPeriod,
      startTime,
      endTime,
      colorIndex: getCourseColorIndex(ov.courseId)
    });
  }

  results.sort((a, b) => {
    if (a.startPeriod !== b.startPeriod) return a.startPeriod - b.startPeriod;
    if (a.endPeriod !== b.endPeriod) return a.endPeriod - b.endPeriod;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return results;
}

export function resolveOccurrencesForWeek(data, weekNum, options = {}) {
  const days = [];
  for (let dow = 1; dow <= 7; dow += 1) {
    const date = getDateForWeekAndDay(data.term.startMonday, weekNum, dow);
    days.push({
      dayOfWeek: dow,
      date,
      occurrences: resolveOccurrencesForDate(data, date, options)
    });
  }
  return { week: weekNum, days };
}

export function resolveAllTermOccurrences(data) {
  const dateSet = new Set();
  const totalDays = data.term.totalWeeks * 7;
  for (let i = 0; i < totalDays; i += 1) {
    dateSet.add(addDays(data.term.startMonday, i));
  }
  for (const ov of data.overrides || []) {
    if (ov.type === 'add' && isValidDateStr(ov.date)) {
      dateSet.add(ov.date);
    }
  }

  const dates = [...dateSet].sort();
  const all = [];
  for (const dateStr of dates) {
    all.push(...resolveOccurrencesForDate(data, dateStr, { includeCancelled: false }));
  }
  return all;
}

export function getLiveCourseStatus(occurrences, nowHHMM) {
  const active = (occurrences || []).filter((o) => !o.cancelled);
  if (active.length === 0) {
    return { state: 'free', title: '今天没有安排课程', subtitle: '好好休息或安排自主学习' };
  }

  const nowMin = timeToMinutes(nowHHMM);

  for (const occ of active) {
    const startMin = timeToMinutes(occ.startTime);
    const endMin = timeToMinutes(occ.endTime);
    if (nowMin >= startMin && nowMin < endMin) {
      const remain = endMin - nowMin;
      return {
        state: 'ongoing',
        occurrence: occ,
        remainingMinutes: remain,
        title: `正在上课 · ${occ.name}`,
        subtitle: `${occ.location || '地点待定'} · 距离下课还有 ${remain} 分钟（${occ.endTime} 结束）`
      };
    }
  }

  const upcoming = active.find((occ) => timeToMinutes(occ.startTime) > nowMin);
  if (upcoming) {
    const waitMin = timeToMinutes(upcoming.startTime) - nowMin;
    const waitText = waitMin >= 60
      ? `${Math.floor(waitMin / 60)} 小时 ${waitMin % 60 ? `${waitMin % 60} 分钟` : ''}`
      : `${waitMin} 分钟`;
    return {
      state: 'upcoming',
      occurrence: upcoming,
      waitMinutes: waitMin,
      title: `下节 ${waitText}后 · ${upcoming.name}`,
      subtitle: `${upcoming.startTime}-${upcoming.endTime} · ${upcoming.location || '地点待定'}`
    };
  }

  return {
    state: 'finished',
    title: '今日课程已全部结束',
    subtitle: `今天共完成了 ${active.length} 节课程安排`
  };
}

/**
 * 检测旧版（v1.0.2）未带 transferGroupId 的跨天调课关联候选：
 * - status: 'linked'    已有 transferGroupId
 * - status: 'unique'    唯一确认的 v1.0.2 成对记录（原日原因「已调至 <targetDate>」且目标日恰好有 1 条同课程且备注含「原 <srcDate> 调课」的未关联补课）
 * - status: 'ambiguous' 目标日存在多条或备注无法唯一确定的同课程补课，须交由用户确认以防误删独立补课
 * - status: 'none'      无关联目标日补课
 */
export function findLegacyTransferResolution(data, target) {
  if (!target) return { status: 'none', candidates: [] };
  if (target.transferGroupId) {
    return { status: 'linked', transferGroupId: target.transferGroupId, candidates: [] };
  }

  const cancelOv = (data.overrides || []).find(
    (ov) =>
      ov.type === 'cancel' &&
      ov.date === target.date &&
      ov.courseId === target.courseId &&
      ov.ruleId === target.ruleId
  );
  if (!cancelOv) return { status: 'none', candidates: [] };
  if (cancelOv.transferGroupId) {
    return { status: 'linked', transferGroupId: cancelOv.transferGroupId, candidates: [] };
  }

  const m = String(cancelOv.reason || '').trim().match(/^已调至\s*(\d{4}-\d{2}-\d{2})$/);
  if (!m) return { status: 'none', candidates: [] };
  const targetDate = m[1];

  // 检查是否有多条同课程同源日/目标日的旧 cancel 指向同一个目标日
  const competingCancels = (data.overrides || []).filter(
    (ov) =>
      ov.type === 'cancel' &&
      !ov.transferGroupId &&
      ov.courseId === cancelOv.courseId &&
      String(ov.reason || '').trim() === `已调至 ${targetDate}`
  );

  const targetAdds = (data.overrides || []).filter(
    (ov) =>
      ov.type === 'add' &&
      !ov.transferGroupId &&
      ov.courseId === cancelOv.courseId &&
      ov.date === targetDate
  );
  if (targetAdds.length === 0) return { status: 'none', candidates: [] };

  const expectedNote = `原 ${cancelOv.date} 调课`;
  const exactNoteMatches = targetAdds.filter((ov) => String(ov.note || '').includes(expectedNote));

  if (exactNoteMatches.length === 1 && competingCancels.length === 1) {
    return { status: 'unique', match: exactNoteMatches[0], targetDate, candidates: exactNoteMatches };
  }

  return { status: 'ambiguous', targetDate, candidates: targetAdds };
}

/**
 * 升级时仅对「100% 唯一可确认」的旧版 v1.0.2 跨天调课补齐 transferGroupId，
 * 有任何歧义则保留未关联状态，防止误删独立补课。
 */
export function upgradeLegacyTransferPairs(data) {
  const next = structuredClone(data);
  let upgradedCount = 0;

  for (const ov of next.overrides || []) {
    if (ov.type !== 'cancel' || ov.transferGroupId) continue;
    const res = findLegacyTransferResolution(next, ov);
    if (res.status === 'unique' && res.match) {
      const tg = `tg_leg_${ov.id}`;
      ov.transferGroupId = tg;
      const pairedAdd = next.overrides.find((item) => item.id === res.match.id);
      if (pairedAdd) {
        pairedAdd.transferGroupId = tg;
        upgradedCount += 1;
      }
    }
  }

  return { data: next, upgradedCount };
}

/**
 * 编辑「仅此一次」：停课 / 调时间换教室 / 跨天调课（成对关联 transferGroupId）/ 恢复原课
 */
export function applySingleOccurrenceEdit(data, target, action, patch = {}) {
  const next = structuredClone(data);
  next.updatedAt = new Date().toISOString();

  // 若是跨天调课生成的目标日 add，支持 restore 成对撤回（同时移除原日 cancel 与目标日 add）
  if (target.source === 'added' && target.overrideId) {
    const existingAdd = next.overrides.find((ov) => ov.id === target.overrideId);
    if (action === 'restore' && existingAdd?.transferGroupId) {
      const tg = existingAdd.transferGroupId;
      next.overrides = next.overrides.filter((ov) => ov.transferGroupId !== tg);
      return next;
    }
    if (action === 'cancel' || action === 'delete') {
      next.overrides = next.overrides.filter((ov) => ov.id !== target.overrideId);
      return next;
    }
    if (action === 'modify') {
      next.overrides = next.overrides.map((ov) => {
        if (ov.id !== target.overrideId) return ov;
        return {
          ...ov,
          date: patch.date && isValidDateStr(patch.date) ? patch.date : ov.date,
          name: patch.name !== undefined ? truncateText(patch.name) : ov.name,
          startPeriod: Number(patch.startPeriod) || ov.startPeriod,
          endPeriod: Number(patch.endPeriod) || ov.endPeriod,
          location: patch.location !== undefined ? truncateText(patch.location) : ov.location,
          teacher: patch.teacher !== undefined ? truncateText(patch.teacher) : ov.teacher,
          note: patch.note !== undefined ? truncateText(patch.note, 400) : ov.note
        };
      });
      return next;
    }
    return next;
  }

  const isSameTarget = (ov) =>
    ov.date === target.date &&
    ov.courseId === target.courseId &&
    ov.ruleId === target.ruleId &&
    (ov.type === 'cancel' || ov.type === 'modify');

  // 收集将被清理的旧 cancel 上关联的 transferGroupId
  const matchedTransferGroups = new Set();
  for (const ov of next.overrides) {
    if (isSameTarget(ov) && ov.transferGroupId) {
      matchedTransferGroups.add(ov.transferGroupId);
    }
  }
  if (target.transferGroupId) {
    matchedTransferGroups.add(target.transferGroupId);
  }

  // 收集待一并清理的旧版配对 add ID（仅唯一匹配或用户明确勾选的候选）
  const extraRemoveIds = new Set(Array.isArray(patch.alsoRemoveOverrideIds) ? patch.alsoRemoveOverrideIds : []);
  if (action === 'restore' && matchedTransferGroups.size === 0 && !patch.skipAutoLegacyPair) {
    const legacy = findLegacyTransferResolution(next, target);
    if (legacy.status === 'unique' && legacy.match) {
      extraRemoveIds.add(legacy.match.id);
    }
  }

  next.overrides = next.overrides.filter((ov) => {
    if (isSameTarget(ov)) return false;
    if (ov.transferGroupId && matchedTransferGroups.has(ov.transferGroupId)) return false;
    if (extraRemoveIds.has(ov.id)) return false;
    return true;
  });

  if (action === 'restore') {
    return next;
  }

  if (action === 'cancel') {
    next.overrides.push({
      id: generateId('ov'),
      type: 'cancel',
      courseId: target.courseId,
      ruleId: target.ruleId,
      date: target.date,
      reason: truncateText(patch.reason || '临时停课', 400)
    });
    return next;
  }

  if (action === 'modify') {
    if (patch.date && isValidDateStr(patch.date) && patch.date !== target.date) {
      const transferGroupId = generateId('tg');
      next.overrides.push({
        id: generateId('ov'),
        type: 'cancel',
        courseId: target.courseId,
        ruleId: target.ruleId,
        date: target.date,
        reason: `已调至 ${patch.date}`,
        transferGroupId
      });
      next.overrides.push({
        id: generateId('ov'),
        type: 'add',
        courseId: target.courseId,
        name: target.name,
        date: patch.date,
        startPeriod: Number(patch.startPeriod) || target.startPeriod,
        endPeriod: Number(patch.endPeriod) || target.endPeriod,
        location: patch.location !== undefined ? truncateText(patch.location) : target.location,
        teacher: patch.teacher !== undefined ? truncateText(patch.teacher) : target.teacher,
        note: truncateText(patch.note || `原 ${target.date} 调课`, 400),
        transferGroupId
      });
      return next;
    }

    next.overrides.push({
      id: generateId('ov'),
      type: 'modify',
      courseId: target.courseId,
      ruleId: target.ruleId,
      date: target.date,
      patch: {
        startPeriod: Number(patch.startPeriod) || target.startPeriod,
        endPeriod: Number(patch.endPeriod) || target.endPeriod,
        location: patch.location !== undefined ? truncateText(patch.location) : target.location,
        teacher: patch.teacher !== undefined ? truncateText(patch.teacher) : target.teacher,
        note: patch.note !== undefined ? truncateText(patch.note, 400) : target.note
      }
    });
  }

  return next;
}

export function addSingleOccurrence(data, payload) {
  const next = structuredClone(data);
  next.updatedAt = new Date().toISOString();
  const name = truncateText(payload.name);
  if (!name || !isValidDateStr(payload.date)) return next;

  const existing = next.courses.find((c) => c.name === name);
  const courseId = payload.courseId || existing?.id || makeStableCourseId(name);
  const startPeriod = Math.max(1, Number(payload.startPeriod) || 1);
  const endPeriod = Math.max(startPeriod, Number(payload.endPeriod) || startPeriod);

  next.overrides.push({
    id: generateId('ov'),
    type: 'add',
    courseId,
    name,
    date: payload.date,
    startPeriod,
    endPeriod,
    location: truncateText(payload.location),
    teacher: truncateText(payload.teacher),
    note: truncateText(payload.note, 400)
  });

  return next;
}

/**
 * 编辑或新增「整组课程」（严格保证 ruleId 唯一，不复用已删规则 ID，并清理悬挂例外）
 */
export function upsertCourseGroup(data, courseInput) {
  const next = structuredClone(data);
  next.updatedAt = new Date().toISOString();
  const name = truncateText(courseInput.name);
  if (!name) return next;

  const idx = courseInput.id ? next.courses.findIndex((c) => c.id === courseInput.id) : -1;
  const id = idx >= 0 ? next.courses[idx].id : (courseInput.id || makeStableCourseId(name));

  let finalId = id;
  if (idx < 0 && next.courses.some((c) => c.id === finalId)) {
    finalId = `${finalId}_${generateId('c').slice(-4)}`;
  }

  const usedRuleIds = new Set();
  const schedules = [];
  for (const r of courseInput.schedules || []) {
    const dayOfWeek = Number(r.dayOfWeek);
    const startPeriod = Number(r.startPeriod);
    const endPeriod = Math.max(startPeriod, Number(r.endPeriod));
    const weeks = [...new Set((r.weeks || []).map(Number))].sort((a, b) => a - b);
    if (weeks.length === 0 || dayOfWeek < 1 || dayOfWeek > 7) continue;

    let ruleId = typeof r.ruleId === 'string' && r.ruleId.trim() ? truncateText(r.ruleId, 64) : '';
    if (!ruleId || usedRuleIds.has(ruleId)) {
      ruleId = generateUniqueRuleId(usedRuleIds);
    }
    usedRuleIds.add(ruleId);

    schedules.push({
      ruleId,
      dayOfWeek,
      startPeriod,
      endPeriod,
      weeks,
      location: truncateText(r.location),
      teacher: truncateText(r.teacher),
      note: truncateText(r.note, 400),
      adjusted: Boolean(r.adjusted),
      courseType: truncateText(r.courseType, 32),
      status: r.status === 'pending' ? 'pending' : 'confirmed'
    });
  }

  const courseObj = {
    id: finalId,
    name,
    teacher: truncateText(courseInput.teacher),
    location: truncateText(courseInput.location),
    note: truncateText(courseInput.note, 400),
    meta: courseInput.meta && typeof courseInput.meta === 'object' ? { ...courseInput.meta } : {},
    schedules
  };

  if (idx >= 0) {
    next.courses[idx] = courseObj;
    // 清理被删除规则的悬挂 cancel/modify（含成对 transferGroupId）
    const activeRuleIds = new Set(schedules.map((s) => s.ruleId));
    const orphanTransfers = new Set();
    for (const ov of next.overrides) {
      if (ov.courseId === finalId && (ov.type === 'cancel' || ov.type === 'modify') && !activeRuleIds.has(ov.ruleId)) {
        if (ov.transferGroupId) orphanTransfers.add(ov.transferGroupId);
      }
    }
    next.overrides = next.overrides.filter((ov) => {
      if (ov.transferGroupId && orphanTransfers.has(ov.transferGroupId)) return false;
      if (ov.courseId === finalId && (ov.type === 'cancel' || ov.type === 'modify')) {
        return activeRuleIds.has(ov.ruleId);
      }
      return true;
    });
  } else {
    next.courses.push(courseObj);
  }

  return next;
}

export function deleteCourseGroup(data, courseId) {
  const next = structuredClone(data);
  next.updatedAt = new Date().toISOString();
  next.courses = next.courses.filter((c) => c.id !== courseId);
  next.overrides = next.overrides.filter((ov) => ov.courseId !== courseId);
  return next;
}

/**
 * 检查将作息总节数调整为 newPeriodCount 后，会受到影响的现有课程时段与调停课例外。
 * 所有缩短作息或切换模板的最终保存入口共用此校验，防止静默删课。
 */
export function findAffectedByPeriodLimit(data, newPeriodCount) {
  const affected = [];
  const limit = Number(newPeriodCount) || 0;
  const courseMap = new Map((data.courses || []).map((c) => [c.id, c]));

  for (const c of data.courses || []) {
    for (const r of c.schedules || []) {
      if (r.endPeriod > limit) {
        affected.push({
          kind: 'rule',
          courseId: c.id,
          ruleId: r.ruleId,
          startPeriod: r.startPeriod,
          endPeriod: r.endPeriod,
          label: `${c.name}（第${r.startPeriod}-${r.endPeriod}节）`
        });
      }
    }
  }

  for (const ov of data.overrides || []) {
    if (ov.type === 'add' && ov.endPeriod > limit) {
      const name = ov.name || courseMap.get(ov.courseId)?.name || '补课';
      affected.push({
        kind: 'add',
        courseId: ov.courseId,
        overrideId: ov.id,
        date: ov.date,
        startPeriod: ov.startPeriod,
        endPeriod: ov.endPeriod,
        label: `${name}（${ov.date} 补课 第${ov.startPeriod}-${ov.endPeriod}节）`
      });
    }
    if (ov.type === 'modify' && (ov.patch?.endPeriod || 0) > limit) {
      const name = courseMap.get(ov.courseId)?.name || '调课例外';
      affected.push({
        kind: 'modify',
        courseId: ov.courseId,
        ruleId: ov.ruleId,
        overrideId: ov.id,
        date: ov.date,
        startPeriod: ov.patch?.startPeriod || 1,
        endPeriod: ov.patch.endPeriod,
        label: `${name}（${ov.date} 单次调整 第${ov.patch?.startPeriod || '?'}-${ov.patch.endPeriod}节）`
      });
    }
  }

  return affected;
}

export function findReferencesToPeriod(data, periodIndex) {
  return findAffectedByPeriodLimit(data, periodIndex - 1).map((item) => item.label);
}
