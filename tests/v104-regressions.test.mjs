/**
 * 针对 v1.0.3-487f5ad0 复审报告全部 9 条问题（3 P1 + 6 P2）的专项回归测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  createDefaultData,
  getDateForWeekAndDay,
  minutesToTime,
  timeToMinutes
} from '../src/js/model.js';

import {
  addSingleOccurrence,
  applySingleOccurrenceEdit,
  findAffectedByPeriodLimit,
  findLegacyTransferResolution,
  resolveOccurrencesForDate,
  upgradeLegacyTransferPairs,
  upsertCourseGroup
} from '../src/js/engine.js';

import {
  LEGACY_KEYS,
  commitScheduleDataAtomic,
  detectLegacyMigrationCandidate,
  dismissLegacyMigration,
  getStorageKeys,
  loadScheduleData,
  loadSnapshot,
  migrateLegacyDataToScoped
} from '../src/js/storage.js';

import {
  buildImportPlan,
  parseJsonBackup,
  parseTimetableHtml
} from '../src/js/importers.js';

import { decodeTransferCode, encodeTransferCode } from '../src/js/transfer.js';
import { exportScheduleToICS } from '../src/js/ics.js';
import { PUBLIC_DEMO_JWGLXT_HTML } from '../src/js/sample-fixture.js';

function createAsyncMemoryStorage({ throwOnKey = null, delayGetMs = 0 } = {}) {
  const map = new Map();
  return {
    _map: map,
    getItem(k) {
      if (delayGetMs > 0) {
        return new Promise((resolve) => setTimeout(() => resolve(map.has(k) ? map.get(k) : null), delayGetMs));
      }
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnKey && k === throwOnKey) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    }
  };
}

// ── #1 [P1] 子路径原址升级：识别旧通用键、不静默复制、确认后一次性恢复并保留旧原件 ──
test('[v1.0.4 #1 P1] 子路径 /school/ 原址升级：检测旧键、确认恢复并保留旧原件且不自动复制到 /other/', async () => {
  const store = createAsyncMemoryStorage();

  // 模拟 v1.0.2 在 /school/ 上写入的旧通用键（11 门课 + 偏好 + 快照）
  const parsed = parseTimetableHtml(PUBLIC_DEMO_JWGLXT_HTML);
  const v102Data = buildImportPlan(createDefaultData('2026-11-23'), parsed).candidateData;
  v102Data.revision = 3;
  store.setItem(LEGACY_KEYS.dataKey, JSON.stringify(v102Data));
  store.setItem(LEGACY_KEYS.prefsKey, JSON.stringify({ theme: 'dark', defaultTab: 'week' }));
  store.setItem(LEGACY_KEYS.snapshotKey, JSON.stringify({ savedAt: '2026-11-22T00:00:00Z', label: 'old', data: createDefaultData() }));

  // 1. 升级后 /school/ 检测到旧版候选，但尚未静默写入隔离键
  const candSchool = detectLegacyMigrationCandidate({ storage: store, pathname: '/school/index.html' });
  assert.ok(candSchool);
  assert.equal(candSchool.scopePath, '/school/');
  assert.equal(candSchool.data.courses.length, 11);
  assert.equal(store.getItem(getStorageKeys('/school/').dataKey), null);

  // 2. 用户在 /school/ 确认迁移
  const migRes = await migrateLegacyDataToScoped({ storage: store, pathname: '/school/index.html' });
  assert.equal(migRes.ok, true);
  assert.equal(migRes.data.courses.length, 11);
  assert.equal(migRes.prefsMigrated, true);
  assert.equal(migRes.snapshotMigrated, true);

  // 3. /school/ 新隔离键已含 11 门课，且旧通用键原件完好保留
  const loadedSchool = loadScheduleData({ storage: store, dataKey: getStorageKeys('/school/').dataKey });
  assert.equal(loadedSchool.isFirstRun, false);
  assert.equal(loadedSchool.data.courses.length, 11);
  assert.ok(store.getItem(LEGACY_KEYS.dataKey));
  assert.equal(detectLegacyMigrationCandidate({ storage: store, pathname: '/school/' }), null);

  // 4. 同域另一个子路径 /other/ 不会被自动复制；用户点「暂不迁移」后不再提示且仍保留旧原件
  const candOther = detectLegacyMigrationCandidate({ storage: store, pathname: '/other/' });
  assert.ok(candOther);
  assert.equal(store.getItem(getStorageKeys('/other/').dataKey), null);
  dismissLegacyMigration({ storage: store, pathname: '/other/' });
  assert.equal(detectLegacyMigrationCandidate({ storage: store, pathname: '/other/' }), null);
  assert.ok(store.getItem(LEGACY_KEYS.dataKey));
});

// ── #2 [P1] 确定性跨窗口交错提交测试：排他锁保证绝不出现两个 rev 5 同时写成 rev 6 ──
test('[v1.0.4 #2 P1] 跨窗口确定性交错写入：排他锁串行化读-检-写，后提交者必报 conflict 绝不静默覆盖', async () => {
  const store = createAsyncMemoryStorage({ delayGetMs: 20 });
  const keys = getStorageKeys('/');

  const initData = createDefaultData('2026-11-23');
  initData.revision = 4; // 首次提交后进入 rev 5
  const seeded = await commitScheduleDataAtomic(initData, 4, { storage: store, pathname: '/', force: true });
  assert.equal(seeded.ok, true);
  assert.equal(seeded.data.revision, 5);

  // 两个窗口同时基于 rev 5 发起写入，且 getItem 存在 20ms 异步延迟，若无排他锁必然交错双双成功
  const draftA = structuredClone(seeded.data);
  draftA.term.name = '窗口A写入的学期';
  const draftB = structuredClone(seeded.data);
  draftB.periods[0].start = '08:05';

  const [resA, resB] = await Promise.all([
    commitScheduleDataAtomic(draftA, 5, { storage: store, pathname: '/' }),
    commitScheduleDataAtomic(draftB, 5, { storage: store, pathname: '/' })
  ]);

  const outcomes = [resA, resB];
  const succeeded = outcomes.filter((r) => r.ok);
  const conflicted = outcomes.filter((r) => !r.ok && r.reason === 'conflict');

  assert.equal(succeeded.length, 1, '只能有一个窗口成功进入 rev 6');
  assert.equal(conflicted.length, 1, '另一个交错窗口必须被判定为 conflict');
  assert.equal(succeeded[0].data.revision, 6);
  assert.equal(conflicted[0].actualRevision, 6);

  // 持久化中保留获胜窗口的完整修改，没有任何静默丢失
  const finalRaw = store._map.get(keys.dataKey);
  const finalObj = JSON.parse(finalRaw);
  assert.equal(finalObj.revision, 6);
  assert.equal(finalObj.term.name, '窗口A写入的学期');
});

// ── #3 [P1] 14 节作息 + 第 14 节晚课：切 13 节模板、直接保存与冲突合并均拦截并保留现有课程 ──
test('[v1.0.4 #3 P1] 缩短作息至 13 节时拦截保存，保护第 14 节课程与例外不被静默删除', async () => {
  const store = createAsyncMemoryStorage();
  let data = createDefaultData('2026-11-23');
  // 扩充到 14 节并添加第 14 节晚课
  const lastEnd = timeToMinutes(data.periods[12].end);
  data.periods.push({ index: 14, start: minutesToTime(lastEnd + 5), end: minutesToTime(lastEnd + 50) });
  data = upsertCourseGroup(data, {
    id: 'crs_night14',
    name: '深夜研讨课',
    schedules: [{ ruleId: 'r_n14', dayOfWeek: 4, startPeriod: 13, endPeriod: 14, weeks: [5, 6] }]
  });

  const seeded = await commitScheduleDataAtomic(data, null, { storage: store, pathname: '/', force: true });
  assert.equal(seeded.ok, true);

  // 验证 13 节校验命中受影响课程
  const affected = findAffectedByPeriodLimit(seeded.data, 13);
  assert.equal(affected.length, 1);
  assert.equal(affected[0].courseId, 'crs_night14');
  assert.equal(affected[0].endPeriod, 14);

  // 模拟最终保存入口（含冲突合并场景）传入 13 节作息
  const shortened = structuredClone(seeded.data);
  shortened.periods = shortened.periods.slice(0, 13);

  const saveRes = await commitScheduleDataAtomic(shortened, seeded.data.revision, {
    storage: store,
    pathname: '/',
    beforeWriteValidate: (latest, candidate) => {
      const hits = findAffectedByPeriodLimit(latest, candidate.periods.length);
      return hits.length > 0
        ? { ok: false, error: '受影响课程存在', details: { affectedPeriods: hits, targetPeriodCount: candidate.periods.length } }
        : { ok: true };
    }
  });

  assert.equal(saveRes.ok, false);
  assert.equal(saveRes.reason, 'validation_error');
  assert.equal(saveRes.details.affectedPeriods.length, 1);

  // 确认持久化里第 14 节作息与深夜研讨课完好无损
  const persisted = loadScheduleData({ storage: store, dataKey: getStorageKeys('/').dataKey }).data;
  assert.equal(persisted.periods.length, 14);
  assert.equal(persisted.courses[0].schedules.length, 1);
});

// ── #4 [P2] 覆盖前快照必须保存真正被覆盖的持久化最新态，取消不改原快照，写盘失败同回滚 ──
test('[v1.0.4 #4 P2] 覆盖前快照记录真正持久化最新态（含并发修改），取消不动旧快照，写盘失败回滚快照', async () => {
  const store = createAsyncMemoryStorage();
  const keys = getStorageKeys('/');

  const v1 = createDefaultData('2026-11-23');
  v1.term.name = '初始学期V1';
  const r1 = await commitScheduleDataAtomic(v1, null, { storage: store, pathname: '/', force: true });

  // 预置一份旧快照
  store.setItem(keys.snapshotKey, JSON.stringify({ savedAt: '2026-11-20T00:00:00Z', label: '最早快照', data: v1 }));

  // 窗口 B 在 rev 1 打开预览，窗口 A 修改学期名并保存到 rev 2
  const draftBImport = createDefaultData('2026-11-23');
  draftBImport.term.name = 'B要覆盖的新课表';

  const tabA = structuredClone(r1.data);
  tabA.term.name = 'A刚刚保存的学期';
  const rA = await commitScheduleDataAtomic(tabA, r1.data.revision, { storage: store, pathname: '/' });
  assert.equal(rA.ok, true);

  // B 以旧 rev 1 提交 -> 冲突拦截，此时旧快照绝不可被改写！
  const rBConflict = await commitScheduleDataAtomic(draftBImport, r1.data.revision, {
    storage: store,
    pathname: '/',
    snapshotBeforeOverwrite: { label: 'B覆盖前快照' }
  });
  assert.equal(rBConflict.ok, false);
  assert.equal(rBConflict.reason, 'conflict');
  assert.equal(loadSnapshot({ storage: store, snapshotKey: keys.snapshotKey }).label, '最早快照');

  // B 选择强制覆盖 -> 快照里保存的必须是 A 刚保存的「A刚刚保存的学期」（而非 B 的旧内存草稿 V1！）
  const rBForce = await commitScheduleDataAtomic(draftBImport, rA.data.revision, {
    storage: store,
    pathname: '/',
    force: true,
    snapshotBeforeOverwrite: { label: 'B强制覆盖前快照' }
  });
  assert.equal(rBForce.ok, true);
  const snapAfterForce = loadSnapshot({ storage: store, snapshotKey: keys.snapshotKey });
  assert.equal(snapAfterForce.label, 'B强制覆盖前快照');
  assert.equal(snapAfterForce.data.term.name, 'A刚刚保存的学期');

  // 若主数据写入抛 QuotaExceededError，快照必须回滚到上一次的值（同成功同失败）
  const failingStore = createAsyncMemoryStorage({ throwOnKey: keys.dataKey });
  failingStore._map.set(keys.dataKey, store._map.get(keys.dataKey));
  failingStore._map.set(keys.snapshotKey, store._map.get(keys.snapshotKey));

  const failRes = await commitScheduleDataAtomic(createDefaultData(), rBForce.data.revision, {
    storage: failingStore,
    pathname: '/',
    force: true,
    snapshotBeforeOverwrite: { label: '应被回滚的快照' }
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.reason, 'storage_error');
  assert.equal(loadSnapshot({ storage: failingStore, snapshotKey: keys.snapshotKey }).label, 'B强制覆盖前快照');
});

// ── #5 [P2] 完整 JSON 备份恢复忠实保留课程默认教师/教室/备注与规则层继承语义 ──
test('[v1.0.4 #5 P2] JSON 备份恢复忠实保留课程默认字段、课程备注与规则空串继承语义', () => {
  const orig = createDefaultData('2026-11-23');
  orig.courses = [{
    id: 'crs_chem',
    name: '分析化学',
    teacher: '王默认老师',
    location: '明理楼101',
    note: '带计算器与实验报告本',
    meta: { credits: '3.0' },
    schedules: [
      { ruleId: 'r_lab', dayOfWeek: 1, startPeriod: 6, endPeriod: 8, weeks: [5, 6], location: '实验楼303', teacher: '李实验老师', note: '穿实验服' },
      { ruleId: 'r_lec', dayOfWeek: 3, startPeriod: 1, endPeriod: 2, weeks: [5, 6], location: '', teacher: '', note: '' }
    ]
  }];

  const parsed = parseJsonBackup(JSON.stringify(orig));
  assert.equal(parsed.ok, true);
  const restored = buildImportPlan(createDefaultData(), parsed, { mode: 'replace', restoreSettings: true }).candidateData;

  const c = restored.courses[0];
  // 课程层默认值与备注未被首条实验规则覆写或清空
  assert.equal(c.teacher, '王默认老师');
  assert.equal(c.location, '明理楼101');
  assert.equal(c.note, '带计算器与实验报告本');

  // 规则 1 保留实验覆写值；规则 2 保留空串继承语义
  assert.equal(c.schedules[0].teacher, '李实验老师');
  assert.equal(c.schedules[0].location, '实验楼303');
  assert.equal(c.schedules[0].note, '穿实验服');
  assert.equal(c.schedules[1].teacher, '');
  assert.equal(c.schedules[1].location, '');
  assert.equal(c.schedules[1].note, '');

  // 验证后续编辑课程默认教室时，规则 2 依然自动继承新默认值！
  c.location = '新教学楼502';
  const w5Wed = getDateForWeekAndDay(restored.term.startMonday, 5, 3);
  const wedOcc = resolveOccurrencesForDate(restored, w5Wed)[0];
  assert.equal(wedOcc.location, '新教学楼502');
  assert.equal(wedOcc.teacher, '王默认老师');
});

// ── #6 [P2] 合并达到 600 条上限时保留全部已有排课，绝不挤掉末尾已有课程 ──
test('[v1.0.4 #6 P2] 满 600 条时段合并新项时不挤掉已有排课，且预览接纳数与最终增量严格一致', () => {
  const fullData = createDefaultData('2026-11-23');
  // 构造 20 门课 × 30 条时段 = 恰好 600 条合法时段
  for (let ci = 0; ci < 20; ci += 1) {
    const schedules = [];
    for (let ri = 0; ri < 30; ri += 1) {
      schedules.push({
        ruleId: `r_${ci}_${ri}`,
        dayOfWeek: (ri % 5) + 1,
        startPeriod: (ri % 10) + 1,
        endPeriod: (ri % 10) + 1,
        weeks: [Math.floor(ri / 5) + 1],
        location: `教室${ci}-${ri}`,
        teacher: `教师${ci}`
      });
    }
    fullData.courses.push({
      id: `crs_full_${ci}`,
      name: `满配课程${ci}`,
      teacher: `教师${ci}`,
      location: `教室${ci}`,
      note: '',
      meta: {},
      schedules
    });
  }

  // 向排在最前面的 crs_full_0 合并 1 个新时段
  const incoming = createDefaultData('2026-11-23');
  incoming.courses = [{
    id: 'crs_full_0',
    name: '满配课程0',
    teacher: '教师0',
    location: '新教室',
    schedules: [{ ruleId: 'r_extra', dayOfWeek: 7, startPeriod: 1, endPeriod: 2, weeks: [19], location: '新教室', teacher: '教师0' }]
  }];

  const plan = buildImportPlan(fullData, parseJsonBackup(JSON.stringify(incoming)), { mode: 'merge' });
  assert.equal(plan.accepted.length, 0, '剩余配额为 0，新项不得计入接纳');
  assert.equal(plan.unrecognized.length, 1, '超限跳过的新项必须在预览中明确列出');
  assert.equal(plan.finalRuleCount, LIMITS.MAX_TOTAL_RULES);
  // 最后一门已有课程的 30 条时段必须 100% 保留，绝不被挤掉
  assert.equal(plan.candidateData.courses[19].schedules.length, 30);
});

// ── #7 [P2] 旧版 v1.0.2 跨天调课恢复：唯一匹配自动成对撤回，有歧义时返回候选不误删独立补课 ──
test('[v1.0.4 #7 P2] 旧版 v1.0.2 无 transferGroupId 跨天调课：唯一匹配成对恢复，有歧义列候选不误删', () => {
  let data = createDefaultData('2026-11-23');
  data.term.startMonday = '2026-09-07';
  data = upsertCourseGroup(data, {
    id: 'crs_old',
    name: '旧版课程',
    schedules: [{ ruleId: 'r_1', dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: [5], location: 'A101' }]
  });
  const w5Mon = getDateForWeekAndDay(data.term.startMonday, 5, 1);
  const w5Tue = getDateForWeekAndDay(data.term.startMonday, 5, 2);

  // 场景 A：标准 v1.0.2 唯一成对记录（无 transferGroupId）+ 目标日一门无关独立补课
  const legacyUnique = structuredClone(data);
  legacyUnique.overrides = [
    { id: 'ov_c1', type: 'cancel', courseId: 'crs_old', ruleId: 'r_1', date: w5Mon, reason: `已调至 ${w5Tue}` },
    { id: 'ov_a1', type: 'add', courseId: 'crs_old', name: '旧版课程', date: w5Tue, startPeriod: 3, endPeriod: 4, note: `原 ${w5Mon} 调课` },
    { id: 'ov_ind', type: 'add', courseId: 'crs_other', name: '独立加课', date: w5Tue, startPeriod: 6, endPeriod: 7, note: '自愿补课' }
  ];

  // 自动升级识别唯一配对
  const upgraded = upgradeLegacyTransferPairs(legacyUnique);
  assert.equal(upgraded.upgradedCount, 1);
  const cancelledMon = resolveOccurrencesForDate(upgraded.data, w5Mon, { includeCancelled: true })[0];
  const restoredA = applySingleOccurrenceEdit(upgraded.data, cancelledMon, 'restore');
  assert.equal(resolveOccurrencesForDate(restoredA, w5Mon).length, 1);
  const tueAfterA = resolveOccurrencesForDate(restoredA, w5Tue);
  assert.equal(tueAfterA.length, 1);
  assert.equal(tueAfterA[0].name, '独立加课');

  // 场景 B：有歧义（目标日同课程两条未带标准备注的补课）-> 绝不自动误删，返回 ambiguous 候选给用户勾选
  const legacyAmbiguous = structuredClone(data);
  legacyAmbiguous.overrides = [
    { id: 'ov_c2', type: 'cancel', courseId: 'crs_old', ruleId: 'r_1', date: w5Mon, reason: `已调至 ${w5Tue}` },
    { id: 'ov_a2', type: 'add', courseId: 'crs_old', name: '旧版课程', date: w5Tue, startPeriod: 3, endPeriod: 4, note: '自定义备注1' },
    { id: 'ov_a3', type: 'add', courseId: 'crs_old', name: '旧版课程', date: w5Tue, startPeriod: 6, endPeriod: 7, note: '自定义备注2' }
  ];

  assert.equal(upgradeLegacyTransferPairs(legacyAmbiguous).upgradedCount, 0);
  const ambigRes = findLegacyTransferResolution(legacyAmbiguous, resolveOccurrencesForDate(legacyAmbiguous, w5Mon, { includeCancelled: true })[0]);
  assert.equal(ambigRes.status, 'ambiguous');
  assert.equal(ambigRes.candidates.length, 2);

  // 用户仅勾选删除 ov_a2，保留 ov_a3
  const restoredB = applySingleOccurrenceEdit(
    legacyAmbiguous,
    resolveOccurrencesForDate(legacyAmbiguous, w5Mon, { includeCancelled: true })[0],
    'restore',
    { skipAutoLegacyPair: true, alsoRemoveOverrideIds: ['ov_a2'] }
  );
  assert.equal(resolveOccurrencesForDate(restoredB, w5Mon).length, 1);
  const tueAfterB = resolveOccurrencesForDate(restoredB, w5Tue);
  assert.equal(tueAfterB.length, 1);
  assert.equal(tueAfterB[0].overrideId, 'ov_a3');
});

// ── #8 [P2] 同一份 HTML 两次独立覆盖导入，.ics 事件 UID 集合 100% 一致 ──
test('[v1.0.4 #8 P2] 同一份 HTML 两次独立覆盖导入，生成的 .ics 事件 UID 集合 100% 相同', () => {
  const run1 = buildImportPlan(createDefaultData('2026-11-23'), parseTimetableHtml(PUBLIC_DEMO_JWGLXT_HTML), { mode: 'replace' }).candidateData;
  const run2 = buildImportPlan(createDefaultData('2026-11-23'), parseTimetableHtml(PUBLIC_DEMO_JWGLXT_HTML), { mode: 'replace' }).candidateData;

  const ics1 = exportScheduleToICS(run1, { alarmMinutes: 15 });
  const ics2 = exportScheduleToICS(run2, { alarmMinutes: 15 });

  const uids1 = [...ics1.content.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
  const uids2 = [...ics2.content.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
  assert.ok(uids1.length > 100);
  assert.deepEqual(uids1, uids2);
});

// ── #9 [P2] 发送端采用与接收端一致的硬上限，拒生成 65536+ 字符的不可解码导入码 ──
test('[v1.0.4 #9 P2] 发送端硬拦截超过 65536 字符的未压缩导入码，绝不生成接收端必拒收的导入码', async () => {
  const big = createDefaultData('2026-11-23');
  for (let i = 0; i < 80; i += 1) {
    big.courses.push({
      id: `crs_big_${i}`,
      name: `大规模课程名称示例_${i}`,
      teacher: `授课教师_${i}`,
      location: `教学楼_${i}_教室`,
      note: '这是一段较长的课程备注用于验证大课表体积边界',
      meta: {},
      schedules: [
        { ruleId: `r_${i}_1`, dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: [1, 2, 3, 4, 5, 6, 7, 8], location: `教室A${i}`, teacher: `教师${i}` },
        { ruleId: `r_${i}_2`, dayOfWeek: 3, startPeriod: 3, endPeriod: 4, weeks: [1, 2, 3, 4, 5, 6, 7, 8], location: `教室B${i}`, teacher: `教师${i}` },
        { ruleId: `r_${i}_3`, dayOfWeek: 5, startPeriod: 6, endPeriod: 7, weeks: [9, 10, 11, 12, 13, 14, 15, 16], location: `教室C${i}`, teacher: `教师${i}` }
      ]
    });
  }

  // 未压缩兼容路径下超过 65536 字符 -> 发送端必须返回 ok: false 并提示导出 JSON
  const plainRes = await encodeTransferCode(big, { forceUncompressed: true });
  assert.equal(plainRes.ok, false);
  assert.equal(plainRes.reason, 'code_too_long');
  assert.match(plainRes.error, /JSON/);

  // 压缩路径若未超限，则必须能被接收端 100% 正常解码
  const compRes = await encodeTransferCode(big);
  if (compRes.ok) {
    assert.ok(compRes.encodedChars <= LIMITS.MAX_TRANSFER_CODE_CHARS);
    const decoded = await decodeTransferCode(compRes.code);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.data.courses.length, 80);
  }
});
