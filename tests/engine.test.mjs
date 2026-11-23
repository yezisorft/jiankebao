import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultData,
  formatWeeksExpression,
  getCourseColorIndex,
  getDateForWeekAndDay,
  parseWeeksExpression
} from '../src/js/model.js';

import {
  addSingleOccurrence,
  applySingleOccurrenceEdit,
  findReferencesToPeriod,
  getLiveCourseStatus,
  getTermStatus,
  resolveAllTermOccurrences,
  resolveOccurrencesForDate,
  resolveOccurrencesForWeek,
  upsertCourseGroup
} from '../src/js/engine.js';

test('parseWeeksExpression & formatWeeksExpression 支持连续、单双周、单周与复合周次', () => {
  assert.deepEqual(parseWeeksExpression('5-16周'), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(parseWeeksExpression('5-17周(单)'), [5, 7, 9, 11, 13, 15, 17]);
  assert.deepEqual(parseWeeksExpression('6-18周(双)'), [6, 8, 10, 12, 14, 16, 18]);
  assert.deepEqual(parseWeeksExpression('第10周'), [10]);
  assert.deepEqual(parseWeeksExpression('1-3周, 5-9周（单）, 第12周'), [1, 2, 3, 5, 7, 9, 12]);

  assert.equal(formatWeeksExpression([5, 7, 9, 11, 13, 15, 17]), '5-17周(单)');
  assert.equal(formatWeeksExpression([6, 8, 10, 12, 14, 16, 18]), '6-18周(双)');
  assert.equal(formatWeeksExpression([10]), '第10周');
  assert.equal(formatWeeksExpression([5, 6, 7, 8]), '5-8周');
});

test('getTermStatus 正确区分开学前、学期中、本学期已结束与下学期倒计时', () => {
  const data = createDefaultData('2026-11-22');
  data.term.startMonday = '2026-09-07';
  data.term.totalWeeks = 20; // 第20周周日为 2027-01-24

  const before = getTermStatus(data, '2026-09-01');
  assert.equal(before.phase, 'before');
  assert.equal(before.daysUntilStart, 6);

  const active = getTermStatus(data, '2026-11-22');
  assert.equal(active.phase, 'active');
  assert.equal(active.currentWeek, 11);

  const endedNoNext = getTermStatus(data, '2027-01-26');
  assert.equal(endedNoNext.phase, 'ended');
  assert.equal(endedNoNext.nextTermDays, null);

  data.term.nextTermStartDate = '2027-03-01';
  const endedWithNext = getTermStatus(data, '2027-02-20');
  assert.equal(endedWithNext.phase, 'ended');
  assert.equal(endedWithNext.nextTermDays, 9);
});

test('单双周、仅此一次停课/调教室/跨天调课、单次补课与固定课程 ID 色卡', () => {
  let data = createDefaultData('2026-11-22');
  data.term.startMonday = '2026-09-07';
  data.term.totalWeeks = 20;

  data = upsertCourseGroup(data, {
    id: 'crs_org_chem',
    name: '有机化学',
    teacher: '杨老师',
    location: '4号楼113',
    schedules: [
      {
        ruleId: 'r_odd',
        dayOfWeek: 2,
        startPeriod: 3,
        endPeriod: 5,
        weeks: parseWeeksExpression('5-17周(单)'),
        location: '4号楼113',
        teacher: '杨老师'
      },
      {
        ruleId: 'r_even',
        dayOfWeek: 5,
        startPeriod: 3,
        endPeriod: 5,
        weeks: parseWeeksExpression('6-18周(双)'),
        location: '实验楼110(112)',
        teacher: '吴老师'
      }
    ]
  });

  // 同一课程 ID 颜色恒定
  const color1 = getCourseColorIndex('crs_org_chem');
  assert.equal(color1, getCourseColorIndex('crs_org_chem'));

  // 第 5 周（单周）：周二有课、周五无课
  const w5 = resolveOccurrencesForWeek(data, 5);
  assert.equal(w5.days[1].occurrences.length, 1);
  assert.equal(w5.days[1].occurrences[0].location, '4号楼113');
  assert.equal(w5.days[1].occurrences[0].teacher, '杨老师');
  assert.equal(w5.days[4].occurrences.length, 0);

  // 第 6 周（双周）：周二无课、周五有实验课
  const w6 = resolveOccurrencesForWeek(data, 6);
  assert.equal(w6.days[1].occurrences.length, 0);
  assert.equal(w6.days[4].occurrences.length, 1);
  assert.equal(w6.days[4].occurrences[0].location, '实验楼110(112)');
  assert.equal(w6.days[4].occurrences[0].teacher, '吴老师');

  // 仅此一次：把第 5 周周二改到 6号楼201、第 6-8 节（不影响第 7 周）
  const w5Tue = getDateForWeekAndDay(data.term.startMonday, 5, 2);
  const w7Tue = getDateForWeekAndDay(data.term.startMonday, 7, 2);
  const targetW5 = resolveOccurrencesForDate(data, w5Tue)[0];

  data = applySingleOccurrenceEdit(data, targetW5, 'modify', {
    location: '6号楼201',
    startPeriod: 6,
    endPeriod: 8,
    note: '临时换教室'
  });

  const modW5 = resolveOccurrencesForDate(data, w5Tue)[0];
  assert.equal(modW5.source, 'modified');
  assert.equal(modW5.location, '6号楼201');
  assert.equal(modW5.startPeriod, 6);
  assert.equal(modW5.endPeriod, 8);

  const untouchedW7 = resolveOccurrencesForDate(data, w7Tue)[0];
  assert.equal(untouchedW7.source, 'rule');
  assert.equal(untouchedW7.location, '4号楼113');
  assert.equal(untouchedW7.startPeriod, 3);

  // 仅此一次：停掉第 7 周周二
  data = applySingleOccurrenceEdit(data, untouchedW7, 'cancel', { reason: '学院活动停课' });
  assert.equal(resolveOccurrencesForDate(data, w7Tue).length, 0);
  const withCancelled = resolveOccurrencesForDate(data, w7Tue, { includeCancelled: true });
  assert.equal(withCancelled.length, 1);
  assert.equal(withCancelled[0].cancelled, true);

  // 单次补课（甚至可以落在周末）
  const w7Sat = getDateForWeekAndDay(data.term.startMonday, 7, 6);
  data = addSingleOccurrence(data, {
    courseId: 'crs_org_chem',
    name: '有机化学',
    date: w7Sat,
    startPeriod: 1,
    endPeriod: 3,
    location: '4号楼113',
    teacher: '杨老师',
    note: '周末补课'
  });

  const satList = resolveOccurrencesForDate(data, w7Sat);
  assert.equal(satList.length, 1);
  assert.equal(satList[0].source, 'added');
  assert.equal(satList[0].colorIndex, color1);

  // 整学期实际课次计数：单周 7 次 - 1 停课 + 双周 7 次 + 1 补课 = 14 次
  const all = resolveAllTermOccurrences(data);
  assert.equal(all.length, 14);
});

test('getLiveCourseStatus 准确判断上课中、下节倒计时与已结课', () => {
  const occs = [
    { name: '思法', startTime: '08:00', endTime: '09:35', location: '3号楼212', cancelled: false },
    { name: '毛概', startTime: '09:50', endTime: '11:25', location: '3号楼212', cancelled: false }
  ];

  assert.equal(getLiveCourseStatus(occs, '07:40').state, 'upcoming');
  assert.equal(getLiveCourseStatus(occs, '07:40').waitMinutes, 20);
  assert.equal(getLiveCourseStatus(occs, '08:30').state, 'ongoing');
  assert.equal(getLiveCourseStatus(occs, '08:30').remainingMinutes, 65);
  assert.equal(getLiveCourseStatus(occs, '12:00').state, 'finished');
  assert.equal(getLiveCourseStatus([], '10:00').state, 'free');
});

test('仅此一次跨天调课：原日期停课并在目标日期生成补课', () => {
  let data = createDefaultData('2026-11-22');
  data.term.startMonday = '2026-09-07';
  data = upsertCourseGroup(data, {
    id: 'crs_eng',
    name: '大学英语（一）',
    schedules: [{ ruleId: 'r_1', dayOfWeek: 3, startPeriod: 6, endPeriod: 9, weeks: [5, 6], location: '3号楼212' }]
  });

  const w5Wed = getDateForWeekAndDay(data.term.startMonday, 5, 3);
  const w5Sat = getDateForWeekAndDay(data.term.startMonday, 5, 6);
  const target = resolveOccurrencesForDate(data, w5Wed)[0];

  data = applySingleOccurrenceEdit(data, target, 'modify', {
    date: w5Sat,
    startPeriod: 1,
    endPeriod: 4,
    location: '3号楼305'
  });

  assert.equal(resolveOccurrencesForDate(data, w5Wed).length, 0);
  const satOccs = resolveOccurrencesForDate(data, w5Sat);
  assert.equal(satOccs.length, 1);
  assert.equal(satOccs[0].source, 'added');
  assert.equal(satOccs[0].location, '3号楼305');
  assert.equal(satOccs[0].startPeriod, 1);
  assert.equal(satOccs[0].endPeriod, 4);
});

test('删除作息节次前的课程引用检查', () => {
  let data = createDefaultData();
  data = upsertCourseGroup(data, {
    name: '人工智能通识与应用',
    schedules: [{ dayOfWeek: 4, startPeriod: 10, endPeriod: 13, weeks: [5, 6] }]
  });
  assert.equal(findReferencesToPeriod(data, 13).length, 1);
  assert.equal(findReferencesToPeriod(data, 14).length, 0);
});
