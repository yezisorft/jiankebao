/**
 * 针对 v1.0.2 审查报告全部 9 条 P1/P2 问题与 4 条边界条件的专项回归测试套件
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIMITS,
  createDefaultData,
  generateUniqueRuleId,
  getDateForWeekAndDay,
  isValidIanaTimezone,
  validatePeriodsSchedule,
  validateRawBackupPayload
} from '../src/js/model.js';

import {
  addSingleOccurrence,
  applySingleOccurrenceEdit,
  resolveOccurrencesForDate,
  upsertCourseGroup
} from '../src/js/engine.js';

import {
  getStorageKeys,
  loadScheduleData,
  saveScheduleDataChecked
} from '../src/js/storage.js';

import {
  buildImportPlan,
  parseJsonBackup,
  parseTimetableHtml
} from '../src/js/importers.js';

import { decodeTransferCode } from '../src/js/transfer.js';
import { exportScheduleToICS } from '../src/js/ics.js';
import { PUBLIC_DEMO_JWGLXT_HTML } from '../src/js/sample-fixture.js';
import { computeReleaseMeta, renderSwWithMeta } from '../scripts/build-release.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMemoryStorage({ throwOnSet = false } = {}) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if (throwOnSet) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k)
  };
}

// ── #1 [P1] 分享链接与文件资源上限、流式解压炸弹防御、超大 rowspan/colspan 防御 ──
test('[#1 P1] 流式解压防御 deflate 炸弹，且拒绝超长导入码与超大 rowspan/colspan HTML', async () => {
  // 构造 1 MB 高度可压缩载荷，压缩后仅约 ~1 KB，验证流式解压在 512 KB 上限处立即中止
  const bombBytes = new Uint8Array(1024 * 1024);
  bombBytes.fill(65); // 'A'
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const writeP = writer.write(bombBytes).then(() => writer.close());
  const compBuf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  await writeP;
  assert.ok(compBuf.byteLength < 4096, 'deflate bomb 压缩后体积应极小');

  const bombCode = `JKB1:${Buffer.from(compBuf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  const res = await decodeTransferCode(bombCode);
  assert.equal(res.ok, false);
  assert.match(res.error, /安全上限|体积超过/);

  // 超长导入码字符串直接拦截
  const hugeStr = `JKB1:${'A'.repeat(LIMITS.MAX_TRANSFER_CODE_CHARS + 100)}`;
  const resHuge = await decodeTransferCode(hugeStr);
  assert.equal(resHuge.ok, false);

  // 畸形超大 rowspan / colspan 不发生内存溢出且正常解析
  const crazySpanHtml = `
    <table>
      <tr><th>节</th><th>周一</th><th>周二</th><th>周三</th><th>周四</th><th>周五</th></tr>
      <tr><td>1</td><td rowspan="99999999" colspan="99999999">大学语文<br>(1-2节)1-8周<br>主楼101<br>周老师</td></tr>
      <tr><td>2</td></tr>
    </table>
  `;
  const parsed = parseTimetableHtml(crazySpanHtml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].name, '大学语文');
});

// ── #2 [P1] 多标签页修订号乐观锁防静默覆盖 + 存储异常捕获 + 同源子路径隔离 ──
test('[#2 P1 & 边界4] 多标签页修订号防覆盖、QuotaExceeded 捕获与子路径存储隔离', () => {
  const store = createMemoryStorage();
  const key = getStorageKeys('/').dataKey;

  const initRes = saveScheduleDataChecked(createDefaultData('2026-11-23'), null, { storage: store, dataKey: key, force: true });
  assert.equal(initRes.ok, true);
  const rev1 = initRes.data.revision;

  // 标签页 A 和 B 同时读到 rev1
  const tabA = loadScheduleData({ storage: store, dataKey: key }).data;
  const tabB = loadScheduleData({ storage: store, dataKey: key }).data;
  assert.equal(tabA.revision, rev1);
  assert.equal(tabB.revision, rev1);

  // 标签页 A 修改学期名并保存
  tabA.term.name = '2026-2027 新学期（A修改）';
  const resA = saveScheduleDataChecked(tabA, tabA.revision, { storage: store, dataKey: key });
  assert.equal(resA.ok, true);
  assert.equal(resA.data.revision, rev1 + 1);

  // 标签页 B 仍持旧 revision 尝试写入作息表 -> 必须拦截为 conflict，不得回退 A 的学期名！
  tabB.periods[0].start = '08:10';
  const resB = saveScheduleDataChecked(tabB, tabB.revision, { storage: store, dataKey: key });
  assert.equal(resB.ok, false);
  assert.equal(resB.reason, 'conflict');
  assert.equal(resB.latestData.term.name, '2026-2027 新学期（A修改）');

  // 确认持久化里依然是 A 的新学期名
  const persisted = loadScheduleData({ storage: store, dataKey: key }).data;
  assert.equal(persisted.term.name, '2026-2027 新学期（A修改）');

  // 写入异常（QuotaExceeded）不抛未捕获异常
  const brokenStore = createMemoryStorage({ throwOnSet: true });
  const errRes = saveScheduleDataChecked(createDefaultData(), null, { storage: brokenStore, dataKey: key, force: true });
  assert.equal(errRes.ok, false);
  assert.equal(errRes.reason, 'storage_error');

  // 同源子路径存储键隔离
  const rootKeys = getStorageKeys('/index.html');
  const stagingKeys = getStorageKeys('/staging/index.html');
  const prodKeys = getStorageKeys('/prod/');
  assert.equal(rootKeys.dataKey, 'jkb_data_v1');
  assert.notEqual(stagingKeys.dataKey, rootKeys.dataKey);
  assert.notEqual(stagingKeys.dataKey, prodKeys.dataKey);
});

// ── #3 [P2] 公开演示样本不包含真实院校名、教学班内部 ID 或真实课程编号 ──
test('[#3 P2] 公开演示样本已完全替换为人工虚构数据，不含真实校名与内部教学班标识', () => {
  assert.equal(PUBLIC_DEMO_JWGLXT_HTML.includes('浙江经贸'), false);
  assert.equal(PUBLIC_DEMO_JWGLXT_HTML.includes('zjiet'), false);
  assert.equal(PUBLIC_DEMO_JWGLXT_HTML.includes('559B6D20E9592069E0630B02A8C01FBE'), false);
  assert.equal(PUBLIC_DEMO_JWGLXT_HTML.includes('51007-26'), false);
  const parsed = parseTimetableHtml(PUBLIC_DEMO_JWGLXT_HTML);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.length, 18);
  assert.equal(parsed.practiceCourses.length, 1);
});

// ── #4 [P2] 发布构建脚本按资源内容自动更新 sw.js 缓存哈希 ──
test('[#4 P2] 发布脚本按业务资源内容自动生成不同的 SW 缓存版本', () => {
  const srcDir = path.resolve(__dirname, '../src');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jkb-build-test-'));
  try {
    fs.cpSync(srcDir, tmpDir, { recursive: true });
    const metaA = computeReleaseMeta(tmpDir, 'v1.0.3');
    const swTpl = fs.readFileSync(path.join(tmpDir, 'sw.js'), 'utf8');
    const swA = renderSwWithMeta(swTpl, metaA.cacheVersion, metaA.coreAssets);

    // 仅改动业务 JS 一个注释字节
    fs.appendFileSync(path.join(tmpDir, 'js/app.js'), '\n// release B\n');
    const metaB = computeReleaseMeta(tmpDir, 'v1.0.3');
    const swB = renderSwWithMeta(swTpl, metaB.cacheVersion, metaB.coreAssets);

    assert.notEqual(metaA.cacheVersion, metaB.cacheVersion);
    assert.notEqual(swA, swB);
    assert.ok(swB.includes(metaB.cacheVersion));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── #6 [P2] 跨天调课成对关联 transferGroupId，恢复时不留双份课也不误删同日独立补课 ──
test('[#6 P2] 跨天调课恢复时成对清理目标日调课，并保留目标日其他独立补课', () => {
  let data = createDefaultData('2026-11-23');
  data.term.startMonday = '2026-09-07';
  data = upsertCourseGroup(data, {
    id: 'crs_math',
    name: '高等数学',
    schedules: [{ ruleId: 'r_mon', dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: [5, 6], location: '明理楼201' }]
  });

  const w5Mon = getDateForWeekAndDay(data.term.startMonday, 5, 1);
  const w5Tue = getDateForWeekAndDay(data.term.startMonday, 5, 2);

  // 先在周二加一门无关的独立补课
  data = addSingleOccurrence(data, {
    name: '独立专题讲座',
    date: w5Tue,
    startPeriod: 6,
    endPeriod: 7,
    location: '报告厅'
  });

  // 把周一高等数学调到周二第 3-4 节
  const monOcc = resolveOccurrencesForDate(data, w5Mon)[0];
  data = applySingleOccurrenceEdit(data, monOcc, 'modify', {
    date: w5Tue,
    startPeriod: 3,
    endPeriod: 4,
    location: '明理楼305'
  });

  assert.equal(resolveOccurrencesForDate(data, w5Mon).length, 0);
  assert.equal(resolveOccurrencesForDate(data, w5Tue).length, 2);

  // 在周一点击「恢复本次」-> 周一恢复，周二的高等数学调课被成对删除，周二的独立专题讲座仍保留！
  const cancelledMon = resolveOccurrencesForDate(data, w5Mon, { includeCancelled: true })[0];
  assert.ok(cancelledMon.transferGroupId);
  data = applySingleOccurrenceEdit(data, cancelledMon, 'restore');

  assert.equal(resolveOccurrencesForDate(data, w5Mon).length, 1);
  const tueAfter = resolveOccurrencesForDate(data, w5Tue);
  assert.equal(tueAfter.length, 1);
  assert.equal(tueAfter[0].name, '独立专题讲座');

  // 反向测试：再次调到周二，这次直接在周二点「撤回调课（restore）」同样成对恢复周一
  data = applySingleOccurrenceEdit(data, resolveOccurrencesForDate(data, w5Mon)[0], 'modify', {
    date: w5Tue,
    startPeriod: 3,
    endPeriod: 4
  });
  const movedTue = resolveOccurrencesForDate(data, w5Tue).find((o) => o.name === '高等数学');
  assert.ok(movedTue.transferGroupId);
  data = applySingleOccurrenceEdit(data, movedTue, 'restore');
  assert.equal(resolveOccurrencesForDate(data, w5Mon).length, 1);
  assert.equal(resolveOccurrencesForDate(data, w5Tue).length, 1);
});

// ── #7 [P2] 导入预览与实际落盘严格一致（HTML 表格去重、备份忠实保真、merge 已有冲突、取消恢复例外） ──
test('[#7 P2] 导入预览与最终落盘完全一致（HTML 去重、备份按规则 ID 保真、合并已有冲突、不恢复例外）', () => {
  const base = createDefaultData('2026-11-23');
  const existing = upsertCourseGroup(base, {
    id: 'crs_exist',
    name: '已有课程',
    schedules: [{ ruleId: 'r_e1', dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: [5, 6, 7], location: 'A101' }]
  });

  // 1. 无稳定 ID 的 HTML 表格内含 2 条完全重复条目 -> 必须按展示字段去重且预览 === 落盘
  const dupHtml = `
    <table id="kbgrid_table_0">
      <tr>
        <td id="1-2" class="td_wrap" rowspan="2">
          <div class="timetable_con"><span class="title">重复HTML课●</span><p><span title="节/周"></span>(2-3节)6-7周</p><p><span title="上课地点"></span>B202</p><p><span title="教师"></span>张老师</p></div>
          <div class="timetable_con"><span class="title">重复HTML课●</span><p><span title="节/周"></span>(2-3节)6-7周</p><p><span title="上课地点"></span>B202</p><p><span title="教师"></span>张老师</p></div>
        </td>
      </tr>
    </table>
  `;
  const parsedDupHtml = parseTimetableHtml(dupHtml);
  assert.equal(parsedDupHtml.ok, true);
  const planHtmlReplace = buildImportPlan(existing, parsedDupHtml, { mode: 'replace' });
  assert.equal(planHtmlReplace.writtenRuleCount, 1);
  assert.equal(planHtmlReplace.accepted.length, 1);
  assert.equal(planHtmlReplace.duplicates.length, 1);
  assert.equal(planHtmlReplace.finalRuleCount, 1);
  assert.equal(planHtmlReplace.candidateData.courses[0].schedules.length, 1);

  // 2. 完整 JSON 备份内含 2 条不同 ruleId 的独立规则 + 1 条补课例外
  const backupObj = createDefaultData('2026-11-23');
  backupObj.term.name = '备份学期名';
  backupObj.courses = [{
    id: 'crs_dup',
    name: '重复样例课',
    teacher: '张老师',
    location: 'B202',
    schedules: [
      { ruleId: 'r_1', dayOfWeek: 1, startPeriod: 2, endPeriod: 3, weeks: [6, 7], location: 'B202', teacher: '张老师' },
      { ruleId: 'r_2', dayOfWeek: 1, startPeriod: 2, endPeriod: 3, weeks: [6, 7], location: 'B202', teacher: '张老师' }
    ]
  }];
  backupObj.overrides = [
    { id: 'ov_1', type: 'add', courseId: 'crs_dup', name: '备份补课', date: '2026-11-28', startPeriod: 1, endPeriod: 2 }
  ];

  const parsedBackup = parseJsonBackup(JSON.stringify(backupObj));
  assert.equal(parsedBackup.ok, true);

  // 情况 A：备份覆盖且恢复设置 -> 按唯一 (courseId, ruleId) 忠实保留全部 2 条独立规则，预览写入数 === 落盘数 === 2
  const planReplaceFull = buildImportPlan(existing, parsedBackup, { mode: 'replace', restoreSettings: true });
  assert.equal(planReplaceFull.writtenRuleCount, 2);
  assert.equal(planReplaceFull.accepted.length, 2);
  assert.equal(planReplaceFull.duplicates.length, 0);
  assert.equal(planReplaceFull.finalRuleCount, 2);
  assert.equal(planReplaceFull.candidateData.courses[0].schedules.length, 2);
  assert.equal(planReplaceFull.candidateData.overrides.length, 1);

  // 情况 B：覆盖但取消勾选「同时恢复设置与例外」-> 备份里的例外绝不泄漏，学期名保持旧值
  const planReplaceNoSettings = buildImportPlan(existing, parsedBackup, { mode: 'replace', restoreSettings: false });
  assert.equal(planReplaceNoSettings.candidateData.overrides.length, 0);
  assert.equal(planReplaceNoSettings.finalOverridesCount, 0);

  // 情况 C：合并模式 -> 必须检测出与 existing（周一 1-2 节 5-7 周）在 6-7 周的重叠冲突！
  const planMerge = buildImportPlan(existing, parsedBackup, { mode: 'merge' });
  assert.ok(planMerge.conflicts.some((c) => /\[已有\]已有课程/.test(c.a)));
});

// ── #8 [P2] 严格前置校验：拒绝 schemaVersion: 2、空对象、畸形导入码与越界作息 ──
test('[#8 P2 & 边界3] JSON 与导入码拒绝高版本 Schema、空对象与乱序作息表', async () => {
  const v2 = createDefaultData();
  v2.schemaVersion = 2;
  assert.equal(parseJsonBackup(JSON.stringify(v2)).ok, false);

  // 缺少 schemaVersion / 空对象通过导入码入口也必须被拒绝（不得变成可确认空课表）
  const badPlain = `JKB1U:${Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url')}`;
  const badRes = await decodeTransferCode(badPlain);
  assert.equal(badRes.ok, false);

  // 作息结束时间早于开始时间、时段交叉必须拦截
  const reversedCheck = validatePeriodsSchedule([
    { index: 1, start: '09:00', end: '08:30' }
  ]);
  assert.equal(reversedCheck.ok, false);

  const overlapCheck = validatePeriodsSchedule([
    { index: 1, start: '08:00', end: '09:00' },
    { index: 2, start: '08:50', end: '09:40' }
  ]);
  assert.equal(overlapCheck.ok, false);

  // 备份内含重叠作息表应被严格拒绝
  const badPeriodsBackup = createDefaultData();
  badPeriodsBackup.periods[1].start = '08:30'; // 与第 1 节 08:00-08:45 交叉
  assert.equal(validateRawBackupPayload(badPeriodsBackup).ok, false);
});

// ── #9 [P2] 严格 IANA 时区校验 + RFC 5545 非上海时区精确 UTC 导出 ──
test('[#9 P2] 拒绝非法/含换行时区，非 Asia/Shanghai 合法时区按精确 UTC 导出符合 RFC 5545', () => {
  assert.equal(isValidIanaTimezone('Asia/Shanghai'), true);
  assert.equal(isValidIanaTimezone('America/New_York'), true);
  assert.equal(isValidIanaTimezone('Asia/Shanghai\r\nSUMMARY:EVIL'), false);
  assert.equal(isValidIanaTimezone('Mars/Olympus'), false);
  assert.equal(isValidIanaTimezone('Asia/Shanghai;X=1'), false);

  const injectedBackup = createDefaultData();
  injectedBackup.term.timezone = 'Asia/Shanghai\r\nSUMMARY:INJECTED';
  assert.equal(validateRawBackupPayload(injectedBackup).ok, false);

  // America/New_York（2026-10-05 仍处夏令时 EDT UTC-4，默认第1节 08:15-08:55 本地 = 12:15Z-12:55Z）
  let nyData = createDefaultData('2026-10-05');
  nyData.term.startMonday = '2026-10-05';
  nyData.term.totalWeeks = 1;
  nyData.term.timezone = 'America/New_York';
  nyData = upsertCourseGroup(nyData, {
    id: 'crs_ny',
    name: 'Seminar',
    schedules: [{ ruleId: 'r_ny', dayOfWeek: 1, startPeriod: 1, endPeriod: 1, weeks: [1], location: 'Hall 1' }]
  });

  const ics = exportScheduleToICS(nyData, { alarmMinutes: 0 });
  assert.equal(ics.utcConverted, true);
  assert.equal(ics.content.includes('TZID=America/New_York'), false); // 严禁无 VTIMEZONE 的悬空 TZID
  assert.ok(ics.content.includes('DTSTART:20261005T121500Z'));
  assert.ok(ics.content.includes('DTEND:20261005T125500Z'));
});

// ── 边界2：删除中间规则再新增不会复用已有 ruleId ──
test('[边界2] 删除中间排课规则后新增不会复用冲突 ruleId，且自动清理被删规则例外', () => {
  const id1 = generateUniqueRuleId([]);
  const id2 = generateUniqueRuleId([id1]);
  const id3 = generateUniqueRuleId([id1, id2]);
  assert.equal(new Set([id1, id2, id3]).size, 3);

  let data = createDefaultData('2026-11-23');
  data = upsertCourseGroup(data, {
    id: 'crs_multi',
    name: '多时段课程',
    schedules: [
      { ruleId: id1, dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: [5] },
      { ruleId: id2, dayOfWeek: 1, startPeriod: 3, endPeriod: 4, weeks: [5] },
      { ruleId: id3, dayOfWeek: 1, startPeriod: 6, endPeriod: 7, weeks: [5] }
    ]
  });

  const w5Mon = getDateForWeekAndDay(data.term.startMonday, 5, 1);
  const secondOcc = resolveOccurrencesForDate(data, w5Mon).find((o) => o.ruleId === id2);
  data = applySingleOccurrenceEdit(data, secondOcc, 'cancel', { reason: '停第2条' });
  assert.equal(data.overrides.length, 1);

  // 删除中间规则 id2 并追加一条新规则
  const newId = generateUniqueRuleId([id1, id2, id3]);
  assert.notEqual(newId, id3);
  data = upsertCourseGroup(data, {
    id: 'crs_multi',
    name: '多时段课程',
    schedules: [
      { ruleId: id1, dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: [5] },
      { ruleId: id3, dayOfWeek: 1, startPeriod: 6, endPeriod: 7, weeks: [5] },
      { ruleId: newId, dayOfWeek: 1, startPeriod: 10, endPeriod: 11, weeks: [5] }
    ]
  });

  // 被删规则 id2 的停课例外应已清理，不得误伤新规则或 id3
  assert.equal(data.overrides.length, 0);
  assert.equal(resolveOccurrencesForDate(data, w5Mon).length, 3);
});
