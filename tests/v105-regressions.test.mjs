/**
 * 简课表查看 · v1.0.5 终稿复审 6 项问题专项回归测试
 * 覆盖 docs/简课表-v1.0.4-代码复审.md 全部 2 个 P1 + 4 个 P2 实测复现场景。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  clonePeriodsTemplate,
  createDefaultData,
  getUtf8ByteLength,
  validatePeriodsSchedule,
  validateScheduleQuotas
} from '../src/js/model.js';

import {
  resolveAllTermOccurrences,
  resolveOccurrencesForDate,
  upsertCourseGroup
} from '../src/js/engine.js';

import {
  buildImportPlan,
  commitImportPreview,
  parseJsonBackup,
  parseTimetableHtml,
  tryExpandPeriodsSafely
} from '../src/js/importers.js';

import {
  LEGACY_KEYS,
  commitScheduleDataAtomic,
  detectLegacyMigrationCandidate,
  dismissLegacyMigration,
  getStorageKeys,
  loadScheduleData,
  loadSnapshot,
  migrateLegacyDataToScoped,
  saveScheduleDataChecked
} from '../src/js/storage.js';

import {
  decodeTransferCode,
  encodeTransferCode
} from '../src/js/transfer.js';

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    _map: map,
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    }
  };
}

// ── P1-1: 14 节已有晚课合并第 17 节实验课，绝不可因自动扩展溢出回退 13 节并删课 ──
test('[v1.0.5 P1-1] 14 节晚课合并第 17 节实验课：当日时间不足时明确拦截并完整保留原 14 节与晚课；若时间充足则双课并存', () => {
  const base = createDefaultData('2026-09-07');
  base.periods = [
    ...clonePeriodsTemplate('zjiet-13'),
    { index: 14, start: '21:35', end: '22:20' }
  ];
  const withNightCourse = upsertCourseGroup(base, {
    id: 'crs_night',
    name: '晚课',
    teacher: '陈老师',
    location: '晚间教室401',
    schedules: [
      { ruleId: 'r_night_14', dayOfWeek: 1, startPeriod: 14, endPeriod: 14, weeks: [1, 2, 3] }
    ]
  });

  // 构造含第 17 节「实验课」的正方教务 HTML
  const htmlPeriod17 = `
    <table id="kbgrid_table_0">
      <tr>
        <td id="2-17" class="td_wrap" rowspan="1">
          <div class="timetable_con">
            <span class="title">实验课★</span>
            <p><span title="节/周"></span>(17-17节)1-4周</p>
            <p><span title="上课地点"></span>实验楼502</p>
            <p><span title="教师"></span>王教授</p>
          </div>
        </td>
      </tr>
    </table>
  `;

  const parsed = parseTimetableHtml(htmlPeriod17);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.maxPeriodFound, 17);

  // 场景 A：默认开启自动扩展，22:20 后到 23:59 无法容纳 3 节 45 分钟课 -> 明确拒绝、不退回 13 节、原晚课完整保留
  const planBlocked = buildImportPlan(withNightCourse, parsed, { mode: 'merge', expandPeriodsIfNeeded: true });
  assert.equal(planBlocked.ok, true);
  assert.equal(planBlocked.canCommit, false);
  assert.ok(planBlocked.periodExpansionError.length > 0);
  assert.equal(planBlocked.writtenRuleCount, 0);
  assert.equal(planBlocked.accepted.length, 0);
  assert.equal(planBlocked.finalCourseCount, 1);
  assert.equal(planBlocked.finalRuleCount, 1);
  assert.equal(planBlocked.candidateData.periods.length, 14);
  assert.equal(validatePeriodsSchedule(planBlocked.candidateData.periods).ok, true);
  assert.equal(planBlocked.candidateData.courses[0].name, '晚课');
  assert.equal(planBlocked.candidateData.courses[0].schedules.length, 1);
  assert.equal(planBlocked.candidateData.courses[0].schedules[0].startPeriod, 14);
  assert.throws(() => commitImportPreview(withNightCourse, planBlocked));

  // 场景 B：若用户取消勾选自动扩展 -> 第 17 节进未识别跳过，原 14 节与晚课仍 100% 完整保留
  const planNoExpand = buildImportPlan(withNightCourse, parsed, { mode: 'merge', expandPeriodsIfNeeded: false });
  assert.equal(planNoExpand.ok, true);
  assert.equal(planNoExpand.periodExpansionError, '');
  assert.equal(planNoExpand.canCommit, false);
  assert.equal(planNoExpand.writtenRuleCount, 0);
  assert.equal(planNoExpand.unrecognized.length, 1);
  assert.equal(planNoExpand.candidateData.periods.length, 14);
  assert.equal(planNoExpand.candidateData.courses[0].schedules.length, 1);

  // 场景 C：如果当前 14 节作息结束较早（如 19:30），自动扩展到 17 节完全合法且同时保留「晚课」和「实验课」
  const earlySchedule = structuredClone(withNightCourse);
  earlySchedule.periods = Array.from({ length: 14 }, (_, i) => {
    const startMin = 8 * 60 + i * 50;
    const endMin = startMin + 40;
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return { index: i + 1, start: fmt(startMin), end: fmt(endMin) };
  }); // 第 14 节结束于 19:30
  assert.equal(validatePeriodsSchedule(earlySchedule.periods).ok, true);

  const expOk = tryExpandPeriodsSafely(earlySchedule.periods, 17);
  assert.equal(expOk.ok, true);
  assert.equal(expOk.periods.length, 17);
  assert.equal(validatePeriodsSchedule(expOk.periods).ok, true);

  const planMerged = buildImportPlan(earlySchedule, parsed, { mode: 'merge', expandPeriodsIfNeeded: true });
  assert.equal(planMerged.ok, true);
  assert.equal(planMerged.canCommit, true);
  assert.equal(planMerged.periodExpansionError, '');
  assert.equal(planMerged.writtenRuleCount, 1);
  assert.equal(planMerged.finalCourseCount, 2);
  assert.equal(planMerged.finalRuleCount, 2);
  assert.equal(planMerged.candidateData.periods.length, 17);
  assert.ok(planMerged.candidateData.courses.some((c) => c.name === '晚课' && c.schedules.length === 1));
  assert.ok(planMerged.candidateData.courses.some((c) => c.name === '实验课' && c.schedules.length === 1));
});

// ── P1-2: 完整 JSON 与导入码备份恢复两条同显示时段不同 ruleId 及关联停课例外，逐日课次 100% 相同 ──
test('[v1.0.5 P1-2] 恢复完整 JSON / 导入码备份保留两条独立规则及各自停课例外，逐日展开课次完全一致', async () => {
  const orig = createDefaultData('2026-09-07');
  orig.term.startMonday = '2026-09-07';
  orig.term.totalWeeks = 4;
  orig.courses = [{
    id: 'crs_lab',
    name: '分组实验课',
    teacher: '林老师',
    location: '实验中心B301',
    note: '',
    meta: {},
    schedules: [
      {
        ruleId: 'r_a',
        dayOfWeek: 1,
        startPeriod: 1,
        endPeriod: 2,
        weeks: [1, 2],
        location: '实验中心B301',
        teacher: '林老师',
        note: '',
        adjusted: false,
        courseType: '实验',
        status: 'confirmed'
      },
      {
        ruleId: 'r_b',
        dayOfWeek: 1,
        startPeriod: 1,
        endPeriod: 2,
        weeks: [1, 2],
        location: '实验中心B301',
        teacher: '林老师',
        note: '',
        adjusted: false,
        courseType: '实验',
        status: 'confirmed'
      }
    ]
  }];
  // 第一条在第 1 周（2026-09-07）停课，第二条在第 2 周（2026-09-14）停课 -> 两个周一都各上 1 节
  orig.overrides = [
    { id: 'ov_c1', type: 'cancel', courseId: 'crs_lab', ruleId: 'r_a', date: '2026-09-07', reason: 'A组第一周停课' },
    { id: 'ov_c2', type: 'cancel', courseId: 'crs_lab', ruleId: 'r_b', date: '2026-09-14', reason: 'B组第二周停课' }
  ];

  const beforeAll = resolveAllTermOccurrences(orig);
  const beforeSep7 = resolveOccurrencesForDate(orig, '2026-09-07');
  const beforeSep14 = resolveOccurrencesForDate(orig, '2026-09-14');
  assert.equal(beforeSep7.length, 1);
  assert.equal(beforeSep14.length, 1);
  assert.equal(beforeAll.length, 2);

  // 路径 1：完整 JSON 备份覆盖恢复
  const jsonStr = JSON.stringify(orig);
  const parsedJson = parseJsonBackup(jsonStr);
  assert.equal(parsedJson.ok, true);
  const planJson = buildImportPlan(createDefaultData('2026-09-07'), parsedJson, {
    mode: 'replace',
    restoreSettings: true
  });
  assert.equal(planJson.ok, true);
  assert.equal(planJson.duplicates.length, 0);
  assert.equal(planJson.writtenRuleCount, 2);
  assert.equal(planJson.finalRuleCount, 2);
  assert.equal(planJson.finalOverridesCount, 2);

  const afterJson = planJson.candidateData;
  const afterJsonAll = resolveAllTermOccurrences(afterJson);
  assert.equal(resolveOccurrencesForDate(afterJson, '2026-09-07').length, 1);
  assert.equal(resolveOccurrencesForDate(afterJson, '2026-09-14').length, 1);
  assert.deepEqual(
    afterJsonAll.map((o) => ({ date: o.date, ruleId: o.ruleId, startPeriod: o.startPeriod, endPeriod: o.endPeriod })),
    beforeAll.map((o) => ({ date: o.date, ruleId: o.ruleId, startPeriod: o.startPeriod, endPeriod: o.endPeriod }))
  );

  // 路径 2：导入码往返恢复同样走备份预览，逐日课次也必须完全一致
  const encoded = await encodeTransferCode(orig);
  assert.equal(encoded.ok, true);
  const decoded = await decodeTransferCode(encoded.code);
  assert.equal(decoded.ok, true);
  const parsedCode = parseJsonBackup(decoded.raw);
  const planCode = buildImportPlan(createDefaultData('2026-09-07'), parsedCode, {
    mode: 'replace',
    restoreSettings: true
  });
  const afterCodeAll = resolveAllTermOccurrences(planCode.candidateData);
  assert.equal(planCode.candidateData.overrides.length, 2);
  assert.deepEqual(
    afterCodeAll.map((o) => ({ date: o.date, ruleId: o.ruleId, startPeriod: o.startPeriod, endPeriod: o.endPeriod })),
    beforeAll.map((o) => ({ date: o.date, ruleId: o.ruleId, startPeriod: o.startPeriod, endPeriod: o.endPeriod }))
  );
});

// ── P2-1: 手动编辑满额 600 时段课表加第 601 条时统一在写入入口拒绝，不得挤掉末尾课程 ──
test('[v1.0.5 P2-1] 600 条满额课表在前端课程新增第 601 条时段时被统一拒绝，末尾课程完好无损', async () => {
  const storage = createMemoryStorage();
  const full = createDefaultData('2026-09-07');
  // 15 门课 × 39 条 = 585 条，第 16 门课 14 条，第 17 门课（末尾课）1 条 -> 合计恰好 600 条
  const makeRules = (prefix, count) => Array.from({ length: count }, (_, idx) => ({
    ruleId: `${prefix}_r${idx + 1}`,
    dayOfWeek: (idx % 7) + 1,
    startPeriod: (idx % 12) + 1,
    endPeriod: (idx % 12) + 1,
    weeks: [(idx % 18) + 1]
  }));

  for (let i = 0; i < 15; i += 1) {
    full.courses.push({ id: `crs_${i}`, name: `前置课${i + 1}`, teacher: '', location: '', note: '', meta: {}, schedules: makeRules(`c${i}`, 39) });
  }
  full.courses.push({ id: 'crs_15', name: '中段课', teacher: '', location: '', note: '', meta: {}, schedules: makeRules('c15', 14) });
  full.courses.push({ id: 'crs_last', name: '末尾守护课', teacher: '', location: '', note: '', meta: {}, schedules: makeRules('last', 1) });

  assert.equal(validateScheduleQuotas(full).ok, true);
  const seed = await commitScheduleDataAtomic(full, null, { storage, force: true });
  assert.equal(seed.ok, true);
  assert.equal(seed.data.courses.reduce((s, c) => s + c.schedules.length, 0), 600);

  // 把第一门课从 39 条编辑到 40 条（总计 601 条）
  const edited = upsertCourseGroup(seed.data, {
    ...seed.data.courses[0],
    schedules: [
      ...seed.data.courses[0].schedules,
      { ruleId: 'c0_r40', dayOfWeek: 7, startPeriod: 13, endPeriod: 13, weeks: [19] }
    ]
  });

  const atomicRes = await commitScheduleDataAtomic(edited, seed.data.revision, { storage });
  assert.equal(atomicRes.ok, false);
  assert.equal(atomicRes.reason, 'validation_error');
  assert.match(atomicRes.error, /600/);

  const syncRes = saveScheduleDataChecked(edited, seed.data.revision, { storage });
  assert.equal(syncRes.ok, false);
  assert.equal(syncRes.reason, 'validation_error');

  // 验证本地已存 600 条与末尾守护课 100% 完好
  const persisted = loadScheduleData({ storage }).data;
  assert.equal(persisted.courses.reduce((s, c) => s + c.schedules.length, 0), 600);
  const lastCourse = persisted.courses.find((c) => c.id === 'crs_last');
  assert.equal(lastCourse.schedules.length, 1);
});

// ── P2-2: 600 条含 400 中文字符备注的合法满额课表：导入码拒绝后，紧凑 JSON 可完整导出并 100% 导回 ──
test('[v1.0.5 P2-2] 600 条含 400 字中文备注的满额课表：导入码正确拒收，紧凑 JSON 导出可 100% 往返恢复', async () => {
  const big = createDefaultData('2026-09-07');
  const note400 = '中'.repeat(400); // 400 个中文字符 = 1200 UTF-8 字节
  // 20 门课 × 30 条 = 600 条
  for (let i = 0; i < 20; i += 1) {
    big.courses.push({
      id: `crs_big_${i}`,
      name: `满额测试课_${i + 1}`,
      teacher: '测试教师',
      location: '教学楼101',
      note: '',
      meta: {},
      schedules: Array.from({ length: 30 }, (_, j) => ({
        ruleId: `r_${i}_${j}`,
        dayOfWeek: (j % 7) + 1,
        startPeriod: (j % 12) + 1,
        endPeriod: (j % 12) + 1,
        weeks: [(j % 20) + 1],
        location: '教学楼101',
        teacher: '测试教师',
        note: note400,
        adjusted: false,
        courseType: '讲课',
        status: 'confirmed'
      }))
    });
  }

  // 发送端导入码超过 512 KiB 上限应明确拒收并引导导出 JSON
  const transferRes = await encodeTransferCode(big);
  assert.equal(transferRes.ok, false);
  assert.equal(transferRes.reason, 'payload_too_large');

  // 界面导出的紧凑 JSON 字节数 <= LIMITS.MAX_JSON_BYTES（4 MB）
  const exportedCompactJson = JSON.stringify(big);
  const compactUtf8Bytes = getUtf8ByteLength(exportedCompactJson);
  assert.ok(compactUtf8Bytes > 700 * 1024);
  assert.ok(compactUtf8Bytes <= LIMITS.MAX_JSON_BYTES);

  // 直接把导出内容送回 parseJsonBackup + buildImportPlan，验证 600 条规则全部无损恢复
  const parsed = parseJsonBackup(exportedCompactJson);
  assert.equal(parsed.ok, true);
  const plan = buildImportPlan(createDefaultData('2026-09-07'), parsed, {
    mode: 'replace',
    restoreSettings: true
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.writtenRuleCount, 600);
  assert.equal(plan.finalRuleCount, 600);
  assert.equal(plan.candidateData.courses[0].schedules[0].note.length, 400);
});

// ── P2-3: 旧版子路径迁移覆盖 0 课程自定义设置/旧快照，以及快照单次失败后的断点续传 ──
test('[v1.0.5 P2-3] 旧版子路径迁移识别 0 课程自定义作息与旧快照，且快照写入失败后重试可补齐缺项', async () => {
  const pathname = '/school-app/index.html';
  const keys = getStorageKeys(pathname);

  // 1. 0 课程但有自定义学期和 14 节作息的旧主数据 + 含晚课的旧快照
  const customEmptyLegacy = createDefaultData('2026-09-07');
  customEmptyLegacy.term.name = '2027-2028自定义空学期';
  customEmptyLegacy.periods = [
    ...clonePeriodsTemplate('zjiet-13'),
    { index: 14, start: '21:35', end: '22:20' }
  ];

  const snapshotWithNight = upsertCourseGroup(structuredClone(customEmptyLegacy), {
    id: 'crs_snap_night',
    name: '快照里的晚课',
    schedules: [{ ruleId: 'r_sn1', dayOfWeek: 3, startPeriod: 14, endPeriod: 14, weeks: [1, 2] }]
  });

  const baseStore = createMemoryStorage({
    [LEGACY_KEYS.dataKey]: JSON.stringify(customEmptyLegacy),
    [LEGACY_KEYS.snapshotKey]: JSON.stringify({
      savedAt: '2026-09-07T08:00:00.000Z',
      label: '旧版覆盖前快照',
      data: snapshotWithNight
    }),
    [LEGACY_KEYS.prefsKey]: JSON.stringify({ theme: 'dark', defaultTab: 'week' })
  });

  // 即使 0 课程，也必须检测到待迁移候选项
  const cand1 = detectLegacyMigrationCandidate({ storage: baseStore, pathname });
  assert.ok(cand1);
  assert.equal(cand1.missing.data, true);
  assert.equal(cand1.missing.snapshot, true);
  assert.equal(cand1.missing.prefs, true);

  // 即使横幅被忽略，设置页通过 includeDismissed: true 仍可发现手动恢复入口
  dismissLegacyMigration({ storage: baseStore, pathname });
  assert.equal(detectLegacyMigrationCandidate({ storage: baseStore, pathname }), null);
  const manualCand = detectLegacyMigrationCandidate({ storage: baseStore, pathname, includeDismissed: true });
  assert.ok(manualCand);
  assert.equal(manualCand.missing.snapshot, true);

  // 2. 故障注入：首次迁移时仅写新路径快照失败一次
  let failSnapOnce = true;
  const flakyStore = {
    getItem: (k) => baseStore.getItem(k),
    removeItem: (k) => baseStore.removeItem(k),
    setItem: (k, v) => {
      if (k === keys.snapshotKey && failSnapOnce) {
        failSnapOnce = false;
        throw new Error('QuotaExceededError: snapshot write failed once');
      }
      baseStore.setItem(k, v);
    }
  };

  const firstTry = await migrateLegacyDataToScoped({ storage: flakyStore, pathname });
  assert.equal(firstTry.ok, false);
  assert.equal(firstTry.partial, true);
  assert.equal(firstTry.dataMigrated, true);
  assert.equal(firstTry.snapshotMigrated, false);
  assert.equal(loadSnapshot({ storage: flakyStore, snapshotKey: keys.snapshotKey }), null);

  // 首次部分失败后，仍能检测到缺失的旧快照
  const candAfterPartial = detectLegacyMigrationCandidate({ storage: flakyStore, pathname });
  assert.ok(candAfterPartial);
  assert.equal(candAfterPartial.missing.data, false);
  assert.equal(candAfterPartial.missing.snapshot, true);

  // 第二次重试：不能误报「已迁移」，必须成功补齐旧快照，且旧原件完整保留
  const secondTry = await migrateLegacyDataToScoped({ storage: flakyStore, pathname });
  assert.equal(secondTry.ok, true);
  assert.equal(secondTry.alreadyMigrated, false);
  assert.equal(secondTry.snapshotMigrated, true);

  const migratedData = loadScheduleData({ storage: flakyStore, dataKey: keys.dataKey }).data;
  const migratedSnap = loadSnapshot({ storage: flakyStore, snapshotKey: keys.snapshotKey });
  assert.equal(migratedData.term.name, '2027-2028自定义空学期');
  assert.equal(migratedData.periods.length, 14);
  assert.ok(migratedSnap);
  assert.equal(migratedSnap.data.courses[0].name, '快照里的晚课');

  // 旧原件未被删除
  assert.ok(baseStore.getItem(LEGACY_KEYS.dataKey));
  assert.ok(baseStore.getItem(LEGACY_KEYS.snapshotKey));
  // 全部补齐后不再提示
  assert.equal(detectLegacyMigrationCandidate({ storage: flakyStore, pathname }), null);
});

// ── P2-4: 读取现有主数据失败或已有 JSON 损坏时，中止覆盖并完整保留原值 ──
test('[v1.0.5 P2-4] 现有主数据读取失败或 JSON 损坏时中止覆盖并保留原值，显式修复才允许覆写', async () => {
  const existing = upsertCourseGroup(createDefaultData('2026-09-07'), {
    id: 'crs_orig',
    name: '原课表课程',
    schedules: [{ ruleId: 'r_o1', dayOfWeek: 1, startPeriod: 1, endPeriod: 2, weeks: [1, 2] }]
  });
  const replacement = upsertCourseGroup(createDefaultData('2026-09-07'), {
    id: 'crs_new',
    name: '新覆盖课程',
    schedules: [{ ruleId: 'r_n1', dayOfWeek: 2, startPeriod: 1, endPeriod: 2, weeks: [1, 2] }]
  });

  // 场景 A：仅一次读取失败，后续写入正常 -> 必须中止覆盖，既不替换原课表也不产生空快照
  const rawStoreA = createMemoryStorage({
    jkb_data_v1: JSON.stringify(existing)
  });
  let failGetOnce = true;
  const flakyReadStore = {
    getItem(k) {
      if (k === 'jkb_data_v1' && failGetOnce) {
        failGetOnce = false;
        throw new Error('TransientStorageReadError');
      }
      return rawStoreA.getItem(k);
    },
    setItem: (k, v) => rawStoreA.setItem(k, v),
    removeItem: (k) => rawStoreA.removeItem(k)
  };

  const resReadErr = await commitScheduleDataAtomic(replacement, existing.revision, {
    storage: flakyReadStore,
    dataKey: 'jkb_data_v1',
    snapshotKey: 'jkb_snapshot_v1',
    snapshotBeforeOverwrite: { label: '测试覆盖快照' }
  });
  assert.equal(resReadErr.ok, false);
  assert.equal(resReadErr.reason, 'read_error');
  assert.equal(rawStoreA.getItem('jkb_snapshot_v1'), null);
  assert.equal(JSON.parse(rawStoreA.getItem('jkb_data_v1')).courses[0].name, '原课表课程');

  // 场景 B：现有主数据 JSON 损坏 -> 默认中止覆盖并返回损坏原文；显式 allowOverwriteCorrupted 才允许覆盖修复
  const corruptedRaw = '{"schemaVersion":1,"courses":[{"name":"截断了';
  const storeB = createMemoryStorage({ jkb_data_v1: corruptedRaw });

  const loadBroken = loadScheduleData({ storage: storeB, dataKey: 'jkb_data_v1' });
  assert.equal(loadBroken.corrupted, true);
  assert.equal(loadBroken.rawContent, corruptedRaw);

  const resCorrupted = await commitScheduleDataAtomic(replacement, null, {
    storage: storeB,
    dataKey: 'jkb_data_v1',
    snapshotKey: 'jkb_snapshot_v1',
    force: true,
    snapshotBeforeOverwrite: { label: '尝试覆盖损坏数据' }
  });
  assert.equal(resCorrupted.ok, false);
  assert.equal(resCorrupted.reason, 'corrupted_storage');
  assert.equal(resCorrupted.rawContent, corruptedRaw);
  assert.equal(storeB.getItem('jkb_data_v1'), corruptedRaw);

  const resRepair = await commitScheduleDataAtomic(replacement, null, {
    storage: storeB,
    dataKey: 'jkb_data_v1',
    snapshotKey: 'jkb_snapshot_v1',
    force: true,
    allowOverwriteCorrupted: true
  });
  assert.equal(resRepair.ok, true);
  assert.equal(JSON.parse(storeB.getItem('jkb_data_v1')).courses[0].name, '新覆盖课程');
});
