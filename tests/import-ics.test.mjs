import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultData, getDateForWeekAndDay } from '../src/js/model.js';
import {
  addSingleOccurrence,
  applySingleOccurrenceEdit,
  resolveAllTermOccurrences,
  resolveOccurrencesForDate,
  resolveOccurrencesForWeek
} from '../src/js/engine.js';
import {
  buildImportPlan,
  commitImportPreview,
  parseJsonBackup,
  parseTimetableHtml
} from '../src/js/importers.js';
import {
  buildScheduleShareUrl,
  decodeTransferCode,
  encodeTransferCode
} from '../src/js/transfer.js';
import { exportScheduleToICS } from '../src/js/ics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGRESSION_FIXTURE_PATH = path.resolve(__dirname, './fixtures/jwglxt-v9-regression.html');

test('正方 jwglxt V-9.0 结构保真回归样本完整精准解析', () => {
  const html = fs.readFileSync(REGRESSION_FIXTURE_PATH, 'utf8');
  const parsed = parseTimetableHtml(html);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.adapter, 'zjiet-jwglxt-v9');
  assert.equal(parsed.termName, '2026-2027学年第1学期');
  assert.equal(parsed.maxPeriodFound, 13);
  assert.equal(parsed.items.length, 18);
  assert.equal(parsed.unrecognized.length, 0);
  assert.equal(parsed.practiceCourses.length, 1);
  assert.equal(parsed.practiceCourses[0].name, '校园实践训练');
  assert.equal(parsed.practiceCourses[0].teacher, '张明哲');
  assert.equal(parsed.practiceCourses[0].weeksText, '2-3周');

  const plan = buildImportPlan(createDefaultData(), parsed, { mode: 'replace' });
  assert.equal(plan.ok, true);
  assert.equal(plan.accepted.length, 18);
  assert.equal(plan.duplicates.length, 0);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.unrecognized.length, 0);
  assert.equal(plan.finalCourseCount, 11);

  const committed = plan.candidateData;
  assert.equal(committed.periods.length, 13);

  // 验证单双周：第 5 周（单）周二有程序设计基础讲课，周五无双周实验
  const w5 = resolveOccurrencesForWeek(committed, 5);
  const w5Tue = w5.days[1].occurrences.find((o) => o.name === '程序设计基础');
  assert.ok(w5Tue);
  assert.equal(w5Tue.location, '启迪楼112');
  assert.equal(w5Tue.teacher, '孙文博');
  assert.equal(w5.days[4].occurrences.some((o) => o.name === '程序设计基础'), false);

  // 第 6 周（双）周五有实验课，与周二讲课同 courseId 与同颜色
  const w6 = resolveOccurrencesForWeek(committed, 6);
  const w6Fri = w6.days[4].occurrences.find((o) => o.name === '程序设计基础');
  assert.ok(w6Fri);
  assert.equal(w6Fri.location, '实验中心204');
  assert.equal(w6Fri.teacher, '郑明轩');
  assert.equal(w6Fri.colorIndex, w5Tue.colorIndex);

  // 验证同格双块【调】课程：第 6 周周四赵景行，第 7 周周四吴清和
  const w6Thu = resolveOccurrencesForWeek(committed, 6).days[3].occurrences.find((o) => o.name === '工程伦理与导论');
  const w7Thu = resolveOccurrencesForWeek(committed, 7).days[3].occurrences.find((o) => o.name === '工程伦理与导论');
  assert.equal(w6Thu.teacher, '赵景行');
  assert.equal(w6Thu.adjusted, true);
  assert.equal(w7Thu.teacher, '吴清和');

  // 验证跨下午-晚上课程：第 9 周周二 8-10 节
  const w9Tue = resolveOccurrencesForWeek(committed, 9).days[1].occurrences.find((o) => o.name === '工程伦理与导论');
  assert.equal(w9Tue.startPeriod, 8);
  assert.equal(w9Tue.endPeriod, 10);
  assert.equal(w9Tue.location, '博雅楼103');

  // 验证单周课：第 10 周周五 6-8 节
  const w10Fri = resolveOccurrencesForWeek(committed, 10).days[4].occurrences.find((o) => o.name === '工程伦理与导论');
  assert.equal(w10Fri.startPeriod, 6);
  assert.equal(w10Fri.endPeriod, 8);

  // 验证同一门课不同教室保留：高等数学（上） 周一 明理楼201 / 周三 明理楼205
  const w5MonMath = w5.days[0].occurrences.find((o) => o.name === '高等数学（上）');
  const w5WedMath = w5.days[2].occurrences.find((o) => o.name === '高等数学（上）');
  assert.equal(w5MonMath.location, '明理楼201');
  assert.equal(w5WedMath.location, '明理楼205');
  assert.equal(w5MonMath.courseId, w5WedMath.courseId);
  assert.equal(w5MonMath.teacher, '林明远');
});

test('完整教师姓名（含全名与多位联合授课教师）原样保留不截断不脱敏', () => {
  const fullNameHtml = `
    <table id="kbgrid_table_0"><tbody>
      <tr><td id="1-1" class="td_wrap" rowspan="2">
        <div class="timetable_con">
          <span class="title"><font color="blue">食品微生物学●</font></span>
          <p><span data-toggle="tooltip" title="节/周"></span><font color="blue">(1-2节)5-16周</font></p>
          <p><span data-toggle="tooltip" title="上课地点"></span><font color="blue">实验楼205</font></p>
          <p><span data-toggle="tooltip" title="教师 "></span><font color="blue">陈明远,欧阳静雯</font></p>
        </div>
      </td></tr>
    </tbody></table>
  `;
  const parsed = parseTimetableHtml(fullNameHtml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items[0].teacher, '陈明远,欧阳静雯');
  const committed = buildImportPlan(createDefaultData(), parsed).candidateData;
  const w5Mon = resolveOccurrencesForWeek(committed, 5).days[0].occurrences[0];
  assert.equal(w5Mon.teacher, '陈明远,欧阳静雯');
});

test('纯文本隔离 HTML 解析忽略 <script> 载荷，且预览正确识别重复与冲突条目', () => {
  const malicious = `
    <table id="kbgrid_table_0"><tbody>
      <tr><td id="1-1" class="td_wrap" rowspan="2">
        <div class="timetable_con">
          <span class="title"><script>window.__xss=1</script>高等数学●</span>
          <p><span title="节/周"></span>(1-2节)1-8周</p>
          <p><span title="上课地点"></span>1号楼101</p>
          <p><span title="教师 "></span>钱老师</p>
        </div>
        <div class="timetable_con">
          <span class="title">高等数学●</span>
          <p><span title="节/周"></span>(1-2节)1-8周</p>
          <p><span title="上课地点"></span>1号楼101</p>
          <p><span title="教师 "></span>钱老师</p>
        </div>
        <div class="timetable_con">
          <span class="title">冲突选修课●</span>
          <p><span title="节/周"></span>(2-3节)5-10周</p>
          <p><span title="上课地点"></span>2号楼202</p>
          <p><span title="教师 "></span>孙老师</p>
        </div>
        <div class="timetable_con">
          <span class="title">损坏周次课●</span>
          <p><span title="节/周"></span>未知时间</p>
        </div>
      </td></tr>
    </tbody></table>
  `;

  const parsed = parseTimetableHtml(malicious);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items[0].name, '高等数学');
  assert.equal(parsed.items[0].name.includes('script'), false);

  const plan = buildImportPlan(createDefaultData(), parsed);
  assert.equal(plan.accepted.length, 2);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.unrecognized.length, 1);
});

test('JSON 备份恢复 + 发送课表压缩导入码与 #schedule= 链接完整往返', async () => {
  const html = fs.readFileSync(REGRESSION_FIXTURE_PATH, 'utf8');
  let data = commitImportPreview(createDefaultData(), buildImportPlan(createDefaultData(), parseTimetableHtml(html)));

  const w11Mon = getDateForWeekAndDay(data.term.startMonday, 11, 1);
  const firstMon = resolveOccurrencesForDate(data, w11Mon)[0];
  data = applySingleOccurrenceEdit(data, firstMon, 'cancel', { reason: '测试停课' });
  data = addSingleOccurrence(data, {
    name: '期末答疑课',
    date: '2026-12-06',
    startPeriod: 6,
    endPeriod: 7,
    location: '明理楼101',
    teacher: '林明远'
  });

  // 1. JSON 备份恢复往返
  const backupParsed = parseJsonBackup(JSON.stringify(data));
  assert.equal(backupParsed.ok, true);
  assert.equal(backupParsed.overridesCount, 2);
  const restoredFromJson = buildImportPlan(createDefaultData(), backupParsed, { mode: 'replace', restoreSettings: true }).candidateData;
  assert.equal(restoredFromJson.courses.length, 11);
  assert.equal(restoredFromJson.overrides.length, 2);
  assert.equal(restoredFromJson.periods.length, 13);

  // 2. 压缩导入码 + #schedule= URL 往返
  const encoded = await encodeTransferCode(data);
  assert.equal(encoded.compressed, true);
  assert.ok(encoded.code.startsWith('JKB1:'));
  assert.ok(encoded.encodedChars < encoded.rawBytes);

  const url = buildScheduleShareUrl('https://example.github.io/jkb/', encoded.code);
  const decoded = await decodeTransferCode(url);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.data.courses.length, 11);
  assert.equal(decoded.data.overrides.length, 2);
  assert.equal(decoded.data.practiceCourses.length, 1);

  // 3. 降级未压缩导入码往返
  const plain = await encodeTransferCode(data, { forceUncompressed: true });
  assert.ok(plain.code.startsWith('JKB1U:'));
  const decodedPlain = await decodeTransferCode(plain.code);
  assert.equal(decodedPlain.ok, true);
  assert.equal(decodedPlain.data.courses.length, 11);
});

test('.ics 展开导出与统一实际课次引擎严格一致（含停课、换教室、补课与单双周）', () => {
  const html = fs.readFileSync(REGRESSION_FIXTURE_PATH, 'utf8');
  let data = buildImportPlan(createDefaultData(), parseTimetableHtml(html)).candidateData;

  const w5Mon = getDateForWeekAndDay(data.term.startMonday, 5, 1);
  const mathW5 = resolveOccurrencesForDate(data, w5Mon).find((o) => o.name === '高等数学（上）');
  data = applySingleOccurrenceEdit(data, mathW5, 'modify', { location: '学术报告厅A' });

  const w6Mon = getDateForWeekAndDay(data.term.startMonday, 6, 1);
  const mathW6 = resolveOccurrencesForDate(data, w6Mon).find((o) => o.name === '高等数学（上）');
  data = applySingleOccurrenceEdit(data, mathW6, 'cancel', { reason: '公假停课' });

  data = addSingleOccurrence(data, {
    name: '实验安全培训',
    date: '2026-11-29',
    startPeriod: 10,
    endPeriod: 11,
    location: '实验楼报告厅'
  });

  const expectedOccurrences = resolveAllTermOccurrences(data);
  const { content, eventCount } = exportScheduleToICS(data, { alarmMinutes: 15 });

  assert.equal(eventCount, expectedOccurrences.length);
  const veventMatches = content.match(/BEGIN:VEVENT/g) || [];
  assert.equal(veventMatches.length, expectedOccurrences.length);
  assert.ok(content.includes('BEGIN:VTIMEZONE'));
  assert.ok(content.includes('TZID=Asia/Shanghai'));
  assert.ok(content.includes('TRIGGER:-PT15M'));
  assert.ok(content.includes('LOCATION:学术报告厅A'));
  assert.ok(content.includes('SUMMARY:实验安全培训'));
  assert.ok(content.includes('\r\n'));
  const uids = [...content.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
  assert.equal(new Set(uids).size, expectedOccurrences.length);
});

test('通用已渲染表格兜底解析（独立断言课程名、教室与教师）与 sw.js 清单完整性', () => {
  const genericHtml = `
    <table>
      <tr><th>节次</th><th>周一</th><th>周二</th><th>周三</th><th>周四</th><th>周五</th></tr>
      <tr>
        <td>1</td>
        <td rowspan="2">线性代数<br>(1-2节)1-16周<br>教一201<br>刘老师</td>
        <td></td><td></td><td></td><td></td>
      </tr>
      <tr><td>2</td><td></td><td></td><td></td><td></td></tr>
    </table>
  `;
  const parsed = parseTimetableHtml(genericHtml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.adapter, 'generic-table');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].name, '线性代数');
  assert.equal(parsed.items[0].location, '教一201');
  assert.equal(parsed.items[0].teacher, '刘老师');
  assert.equal(parsed.items[0].startPeriod, 1);
  assert.equal(parsed.items[0].endPeriod, 2);

  // 校验 sw.js 中的 CORE_ASSETS 全部真实存在
  const swSrc = fs.readFileSync(path.resolve(__dirname, '../src/sw.js'), 'utf8');
  const assetsBlock = swSrc.match(/const CORE_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(assetsBlock);
  const assetPaths = [...assetsBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(assetPaths.length >= 10);
  for (const rel of assetPaths) {
    if (rel === './') continue;
    const abs = path.resolve(__dirname, '../src', rel);
    assert.ok(fs.existsSync(abs), `sw.js CORE_ASSETS 缺失文件：${rel}`);
  }
});
