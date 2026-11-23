/**
 * 简课表查看 · 本地存储、Web Locks 跨窗口串行写入、硬配额校验、故障保护与可断点续传的子路径旧版迁移
 */

import { createDefaultData, normalizeScheduleData, validateScheduleQuotas } from './model.js';

export const LEGACY_KEYS = Object.freeze({
  dataKey: 'jkb_data_v1',
  snapshotKey: 'jkb_snapshot_v1',
  prefsKey: 'jkb_prefs_v1'
});

/**
 * 计算同源子路径隔离前缀：
 * - 根路径部署（/ 或 /index.html）保持 jkb_data_v1 向后兼容；
 * - 同域名不同子路径（如 /school/、/beta/）自动按目录名隔离存储键。
 */
export function resolveStorageScopeSuffix(pathname = typeof window !== 'undefined' ? window.location.pathname : '/') {
  const clean = String(pathname || '/').replace(/\/index\.html$/i, '/');
  const dir = clean.endsWith('/') ? clean : `${clean.slice(0, clean.lastIndexOf('/') + 1)}`;
  if (!dir || dir === '/') return '';
  return `::${dir}`;
}

export function getStorageKeys(pathname) {
  const suffix = resolveStorageScopeSuffix(pathname);
  return {
    suffix,
    scopePath: suffix ? suffix.slice(2) : '/',
    dataKey: `jkb_data_v1${suffix}`,
    snapshotKey: `jkb_snapshot_v1${suffix}`,
    prefsKey: `jkb_prefs_v1${suffix}`,
    legacyDismissedKey: `jkb_legacy_dismissed_v1${suffix}`,
    legacyProgressKey: `jkb_legacy_migration_v1${suffix}`,
    lockName: `jkb_write_lock_v1${suffix || '::/'}`
  };
}

const DEFAULT_KEYS = getStorageKeys();
export const STORAGE_KEY = DEFAULT_KEYS.dataKey;
export const SNAPSHOT_KEY = DEFAULT_KEYS.snapshotKey;
export const PREFS_KEY = DEFAULT_KEYS.prefsKey;
export const LOCK_NAME = DEFAULT_KEYS.lockName;

export const DEFAULT_PREFS = {
  theme: 'system',        // system | light | dark
  showWeekend: 'auto',    // auto | always | never
  defaultTab: 'today',    // today | week
  icsAlarmMinutes: 15,
  iosHintDismissed: false
};

const fallbackMutexQueues = new Map();

async function runWithFallbackMutex(lockName, fn) {
  const prev = fallbackMutexQueues.get(lockName) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => current);
  fallbackMutexQueues.set(lockName, tail);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fallbackMutexQueues.get(lockName) === tail) {
      fallbackMutexQueues.delete(lockName);
    }
  }
}

export async function withStorageLock(lockName, fn, customLockProvider = null) {
  if (typeof customLockProvider === 'function') {
    return customLockProvider(lockName, fn);
  }
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(lockName, { mode: 'exclusive' }, async () => fn());
  }
  return runWithFallbackMutex(lockName, fn);
}

function getStore(customStorage) {
  if (customStorage) return customStorage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * 区分读取现有主数据的三种状态：absent / ok / read_error / corrupted
 */
async function readExistingDataStrict(store, key) {
  let raw;
  try {
    raw = await store.getItem(key);
  } catch (err) {
    return {
      status: 'read_error',
      error: err?.message || '读取现有本地存储失败'
    };
  }

  if (raw === null || raw === undefined) {
    return { status: 'absent', raw: null, data: null };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'corrupted',
        raw: String(raw),
        error: '已存课表不是合法的 JSON 对象'
      };
    }
    return { status: 'ok', raw: String(raw), data: normalizeScheduleData(parsed) };
  } catch {
    return {
      status: 'corrupted',
      raw: String(raw),
      error: '已存课表 JSON 损坏，无法解析'
    };
  }
}

export function loadScheduleData(options = {}) {
  const store = getStore(options.storage);
  const key = options.dataKey || STORAGE_KEY;
  if (!store) return { data: createDefaultData(), isFirstRun: true, corrupted: false, rawContent: null, readError: null };
  let raw;
  try {
    raw = store.getItem(key);
  } catch (err) {
    return {
      data: createDefaultData(),
      isFirstRun: false,
      corrupted: false,
      rawContent: null,
      readError: err?.message || '读取本地存储失败'
    };
  }

  if (raw === null || raw === undefined) {
    return { data: createDefaultData(), isFirstRun: true, corrupted: false, rawContent: null, readError: null };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: createDefaultData(), isFirstRun: false, corrupted: true, rawContent: String(raw), readError: null };
    }
    return { data: normalizeScheduleData(parsed), isFirstRun: false, corrupted: false, rawContent: null, readError: null };
  } catch {
    return { data: createDefaultData(), isFirstRun: false, corrupted: true, rawContent: String(raw), readError: null };
  }
}

/**
 * 跨窗口原子提交（Web Lock 内执行）：
 * 1. 严格区分「键不存在」「读取失败」「内容损坏」，后两种一律中止覆盖（除非明确允许修复损坏内容）；
 * 2. 核对修订号防多标签覆盖；
 * 3. 在落盘前统一强制校验硬配额（validateScheduleQuotas）与自定义业务前校验，绝不静默挤掉已有课程；
 * 4. 以持久化最新态生成覆盖前快照，主写入失败时自动回滚快照。
 */
export async function commitScheduleDataAtomic(nextDataOrBuilder, expectedRevision = null, options = {}) {
  const store = getStore(options.storage);
  const keys = options.pathname ? getStorageKeys(options.pathname) : DEFAULT_KEYS;
  const dataKey = options.dataKey || keys.dataKey;
  const snapshotKey = options.snapshotKey || keys.snapshotKey;
  const lockName = options.lockName || keys.lockName;
  const force = Boolean(options.force);
  const allowOverwriteCorrupted = Boolean(options.allowOverwriteCorrupted);
  const snapshotMeta = options.snapshotBeforeOverwrite || null;
  const beforeWriteValidate = typeof options.beforeWriteValidate === 'function' ? options.beforeWriteValidate : null;

  if (!store) {
    return { ok: false, reason: 'storage_error', error: '当前环境不可用 localStorage。' };
  }

  return withStorageLock(lockName, async () => {
    const readRes = await readExistingDataStrict(store, dataKey);

    if (readRes.status === 'read_error') {
      return {
        ok: false,
        reason: 'read_error',
        error: `读取现有课表失败（${readRes.error}），已中止覆盖以保护原数据。`
      };
    }

    if (readRes.status === 'corrupted' && !allowOverwriteCorrupted) {
      return {
        ok: false,
        reason: 'corrupted_storage',
        rawContent: readRes.raw,
        error: '检测到本地已存课表数据损坏（JSON 无法解析），已中止覆盖以保护原始内容，建议先导出损坏原文。'
      };
    }

    const latestPersisted = readRes.status === 'ok' ? readRes.data : null;

    if (
      !force &&
      latestPersisted &&
      expectedRevision !== null &&
      expectedRevision !== undefined &&
      latestPersisted.revision !== expectedRevision
    ) {
      return {
        ok: false,
        reason: 'conflict',
        expectedRevision,
        actualRevision: latestPersisted.revision,
        latestData: latestPersisted
      };
    }

    const candidateRaw = typeof nextDataOrBuilder === 'function'
      ? nextDataOrBuilder(latestPersisted ? structuredClone(latestPersisted) : createDefaultData())
      : nextDataOrBuilder;

    // 统一在所有写入入口校验硬配额，防止手动编辑或合并满额课表静默挤掉已有课程
    const quotaCheck = validateScheduleQuotas(candidateRaw);
    if (!quotaCheck.ok) {
      return {
        ok: false,
        reason: 'validation_error',
        error: quotaCheck.error,
        latestData: latestPersisted
      };
    }

    if (beforeWriteValidate) {
      const checkRes = beforeWriteValidate(latestPersisted || createDefaultData(), candidateRaw);
      if (checkRes && !checkRes.ok) {
        return {
          ok: false,
          reason: 'validation_error',
          error: checkRes.error || '数据校验未通过',
          details: checkRes.details || null,
          latestData: latestPersisted
        };
      }
    }

    const normalized = normalizeScheduleData(candidateRaw);
    const baseRev = latestPersisted ? latestPersisted.revision : (Number(expectedRevision) || 0);
    normalized.revision = baseRev + 1;
    normalized.updatedAt = new Date().toISOString();

    // 以真实持久化最新态生成覆盖前快照
    let prevSnapshotRaw = null;
    let wroteSnapshot = false;
    if (snapshotMeta && latestPersisted) {
      try {
        prevSnapshotRaw = await store.getItem(snapshotKey);
        const snapPayload = {
          savedAt: new Date().toISOString(),
          label: snapshotMeta.label || '覆盖前自动快照',
          data: latestPersisted
        };
        await store.setItem(snapshotKey, JSON.stringify(snapPayload));
        wroteSnapshot = true;
      } catch (err) {
        return {
          ok: false,
          reason: 'storage_error',
          error: `保存覆盖前快照失败（${err?.message || '空间不足'}），已中止覆盖以保护旧数据。`
        };
      }
    }

    try {
      await store.setItem(dataKey, JSON.stringify(normalized));
      return { ok: true, data: normalized, snapshotSaved: wroteSnapshot };
    } catch (err) {
      if (wroteSnapshot) {
        try {
          if (prevSnapshotRaw === null || prevSnapshotRaw === undefined) {
            await store.removeItem(snapshotKey);
          } else {
            await store.setItem(snapshotKey, prevSnapshotRaw);
          }
        } catch {
          // best-effort rollback
        }
      }
      return {
        ok: false,
        reason: 'storage_error',
        error: err?.message || '写入本地存储失败（可能空间不足或浏览器隐私模式限制）。'
      };
    }
  }, options.lockProvider);
}

/**
 * 同步版本（同样强制硬配额与读错/损坏拦截）
 */
export function saveScheduleDataChecked(nextData, expectedRevision = null, options = {}) {
  const store = getStore(options.storage);
  const key = options.dataKey || STORAGE_KEY;
  const force = Boolean(options.force);

  if (!store) {
    return { ok: false, reason: 'storage_error', error: '当前环境不可用 localStorage。' };
  }

  let existingRaw = null;
  try {
    existingRaw = store.getItem(key);
  } catch (err) {
    return { ok: false, reason: 'read_error', error: err?.message || '读取现有本地存储失败' };
  }

  let latestPersisted = null;
  if (existingRaw !== null && existingRaw !== undefined) {
    try {
      const parsed = JSON.parse(existingRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'corrupted_storage', rawContent: String(existingRaw), error: '已存课表损坏' };
      }
      latestPersisted = normalizeScheduleData(parsed);
    } catch {
      return { ok: false, reason: 'corrupted_storage', rawContent: String(existingRaw), error: '已存课表 JSON 损坏' };
    }
  }

  if (
    !force &&
    latestPersisted &&
    expectedRevision !== null &&
    expectedRevision !== undefined &&
    latestPersisted.revision !== expectedRevision
  ) {
    return {
      ok: false,
      reason: 'conflict',
      expectedRevision,
      actualRevision: latestPersisted.revision,
      latestData: latestPersisted
    };
  }

  const quotaCheck = validateScheduleQuotas(nextData);
  if (!quotaCheck.ok) {
    return { ok: false, reason: 'validation_error', error: quotaCheck.error, latestData: latestPersisted };
  }

  const normalized = normalizeScheduleData(nextData);
  const baseRev = latestPersisted ? latestPersisted.revision : (Number(expectedRevision) || 0);
  normalized.revision = baseRev + 1;
  normalized.updatedAt = new Date().toISOString();

  try {
    store.setItem(key, JSON.stringify(normalized));
    return { ok: true, data: normalized };
  } catch (err) {
    return {
      ok: false,
      reason: 'storage_error',
      error: err?.message || '写入本地存储失败（可能空间不足或浏览器隐私模式限制）。'
    };
  }
}

export function saveScheduleData(data, options = {}) {
  const res = saveScheduleDataChecked(data, null, { ...options, force: true });
  if (!res.ok) throw new Error(res.error || '保存失败');
  return res.data;
}

export function saveSnapshot(data, label = '导入前自动快照', options = {}) {
  const store = getStore(options.storage);
  const key = options.snapshotKey || SNAPSHOT_KEY;
  if (!store) return { ok: false, error: '当前环境不可用 localStorage。' };

  const payload = {
    savedAt: new Date().toISOString(),
    label,
    data: normalizeScheduleData(data)
  };
  try {
    store.setItem(key, JSON.stringify(payload));
    return { ok: true, payload };
  } catch (err) {
    return { ok: false, error: err?.message || '保存快照失败（存储空间不足）。' };
  }
}

export function loadSnapshot(options = {}) {
  const store = getStore(options.storage);
  const key = options.snapshotKey || SNAPSHOT_KEY;
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data) return null;
    return {
      savedAt: parsed.savedAt || '',
      label: parsed.label || '导入前快照',
      data: normalizeScheduleData(parsed.data)
    };
  } catch {
    return null;
  }
}

export function clearSnapshot(options = {}) {
  const store = getStore(options.storage);
  const key = options.snapshotKey || SNAPSHOT_KEY;
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // ignore
  }
}

export function loadPrefs(options = {}) {
  const store = getStore(options.storage);
  const key = options.prefsKey || PREFS_KEY;
  if (!store) return { ...DEFAULT_PREFS };
  try {
    const raw = store.getItem(key);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs, options = {}) {
  const store = getStore(options.storage);
  const key = options.prefsKey || PREFS_KEY;
  const merged = { ...DEFAULT_PREFS, ...prefs };
  if (store) {
    try {
      store.setItem(key, JSON.stringify(merged));
    } catch {
      // 忽略偏好存储异常
    }
  }
  return merged;
}

function readLegacyProgressSync(store, keys) {
  const base = { data: false, prefs: false, snapshot: false, dismissed: false };
  try {
    if (store.getItem(keys.legacyDismissedKey)) base.dismissed = true;
    const raw = store.getItem(keys.legacyProgressKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          data: Boolean(parsed.data),
          prefs: Boolean(parsed.prefs),
          snapshot: Boolean(parsed.snapshot),
          dismissed: Boolean(parsed.dismissed) || base.dismissed
        };
      }
    }
  } catch {
    // ignore
  }
  return base;
}

/**
 * 检测子路径原址升级时的旧版（v1.0.2 通用键）遗留数据：
 * - 完整识别三类旧项：主数据（含 0 课程的自定义学期/作息）、旧快照（可能含晚课）、旧偏好；
 * - 按项跟踪迁移状态，支持部分失败后继续补齐缺项；
 * - 传 includeDismissed: true 可供设置页手动恢复入口查询。
 */
export function detectLegacyMigrationCandidate(options = {}) {
  const store = getStore(options.storage);
  const keys = options.pathname ? getStorageKeys(options.pathname) : DEFAULT_KEYS;
  const includeDismissed = Boolean(options.includeDismissed);
  if (!store || !keys.suffix) return null;

  try {
    const progress = readLegacyProgressSync(store, keys);
    if (progress.dismissed && !includeDismissed) return null;

    const legacyDataRaw = store.getItem(LEGACY_KEYS.dataKey);
    const legacySnapRaw = store.getItem(LEGACY_KEYS.snapshotKey);
    const legacyPrefsRaw = store.getItem(LEGACY_KEYS.prefsKey);

    const scopedDataRaw = store.getItem(keys.dataKey);
    const scopedSnapRaw = store.getItem(keys.snapshotKey);
    const scopedPrefsRaw = store.getItem(keys.prefsKey);

    let legacyData = null;
    if (legacyDataRaw) {
      try {
        legacyData = normalizeScheduleData(JSON.parse(legacyDataRaw));
      } catch {
        legacyData = null;
      }
    }

    let legacySnapshot = null;
    if (legacySnapRaw) {
      try {
        const parsedSnap = JSON.parse(legacySnapRaw);
        if (parsedSnap?.data) {
          legacySnapshot = {
            savedAt: parsedSnap.savedAt || '',
            label: parsedSnap.label || '旧版快照',
            data: normalizeScheduleData(parsedSnap.data)
          };
        }
      } catch {
        legacySnapshot = null;
      }
    }

    const needsData = Boolean(legacyData) && !scopedDataRaw && !progress.data;
    const needsSnapshot = Boolean(legacySnapshot) && !scopedSnapRaw && !progress.snapshot;
    const needsPrefs = Boolean(legacyPrefsRaw) && !scopedPrefsRaw && !progress.prefs;

    // 只要旧主数据（含自定义设置）、旧快照或旧偏好存在尚未迁入当前子路径的项，即提示恢复
    if (!needsData && !needsSnapshot && !needsPrefs) return null;

    return {
      scopePath: keys.scopePath,
      data: legacyData,
      legacySnapshot,
      hasLegacyData: Boolean(legacyData),
      hasLegacySnapshot: Boolean(legacySnapshot),
      hasLegacyPrefs: Boolean(legacyPrefsRaw),
      missing: {
        data: needsData,
        snapshot: needsSnapshot,
        prefs: needsPrefs
      },
      dismissed: progress.dismissed
    };
  } catch {
    return null;
  }
}

/**
 * 可断点续传的子路径旧版迁移：
 * - 逐项检查并仅补齐缺失的 data / prefs / snapshot，不覆盖新路径已有数据，也不删除旧原件；
 * - 任意一项写入失败时记录已成功项并返回 ok: false，下次重试只补缺项，绝不误报「已迁移」。
 */
export async function migrateLegacyDataToScoped(options = {}) {
  const store = getStore(options.storage);
  const keys = options.pathname ? getStorageKeys(options.pathname) : DEFAULT_KEYS;
  if (!store || !keys.suffix) {
    return { ok: false, error: '当前路径无需子路径迁移。' };
  }

  return withStorageLock(keys.lockName, async () => {
    const progress = { data: false, prefs: false, snapshot: false, dismissed: false };
    try {
      const prevRaw = await store.getItem(keys.legacyProgressKey);
      if (prevRaw) Object.assign(progress, JSON.parse(prevRaw));
    } catch {
      // ignore
    }

    let dataMigrated = false;
    let prefsMigrated = false;
    let snapshotMigrated = false;
    let resultData = null;
    const errors = [];

    // 1. 迁移主数据（若新路径尚无主数据）
    try {
      const existingScoped = await store.getItem(keys.dataKey);
      if (existingScoped) {
        resultData = normalizeScheduleData(JSON.parse(existingScoped));
        progress.data = true;
      } else {
        const legacyRaw = await store.getItem(LEGACY_KEYS.dataKey);
        if (legacyRaw) {
          const legacyData = normalizeScheduleData(JSON.parse(legacyRaw));
          legacyData.updatedAt = new Date().toISOString();
          await store.setItem(keys.dataKey, JSON.stringify(legacyData));
          resultData = legacyData;
          dataMigrated = true;
          progress.data = true;
        }
      }
    } catch (err) {
      errors.push(`主课表迁移失败：${err?.message || '写入受限'}`);
    }

    // 2. 迁移偏好（若新路径尚无偏好）
    try {
      const existingPrefs = await store.getItem(keys.prefsKey);
      if (existingPrefs) {
        progress.prefs = true;
      } else {
        const legacyPrefsRaw = await store.getItem(LEGACY_KEYS.prefsKey);
        if (legacyPrefsRaw) {
          await store.setItem(keys.prefsKey, legacyPrefsRaw);
          prefsMigrated = true;
          progress.prefs = true;
        }
      }
    } catch (err) {
      errors.push(`界面偏好迁移失败：${err?.message || '写入受限'}`);
    }

    // 3. 迁移旧快照（若新路径尚无快照）
    try {
      const existingSnap = await store.getItem(keys.snapshotKey);
      if (existingSnap) {
        progress.snapshot = true;
      } else {
        const legacySnapRaw = await store.getItem(LEGACY_KEYS.snapshotKey);
        if (legacySnapRaw) {
          await store.setItem(keys.snapshotKey, legacySnapRaw);
          snapshotMigrated = true;
          progress.snapshot = true;
        }
      }
    } catch (err) {
      errors.push(`旧快照迁移失败：${err?.message || '写入受限'}`);
    }

    progress.dismissed = false;
    try {
      await store.setItem(keys.legacyProgressKey, JSON.stringify(progress));
      await store.removeItem(keys.legacyDismissedKey);
    } catch {
      // ignore progress metadata write failure
    }

    if (errors.length > 0) {
      return {
        ok: false,
        partial: dataMigrated || prefsMigrated || snapshotMigrated,
        data: resultData,
        dataMigrated,
        prefsMigrated,
        snapshotMigrated,
        error: errors.join('；')
      };
    }

    if (!dataMigrated && !prefsMigrated && !snapshotMigrated && !resultData) {
      return { ok: false, error: '未找到可恢复的旧版课表、偏好或快照。' };
    }

    return {
      ok: true,
      alreadyMigrated: !dataMigrated && !prefsMigrated && !snapshotMigrated,
      data: resultData || loadScheduleData({ storage: store, dataKey: keys.dataKey }).data,
      dataMigrated,
      prefsMigrated,
      snapshotMigrated
    };
  }, options.lockProvider);
}

export function dismissLegacyMigration(options = {}) {
  const store = getStore(options.storage);
  const keys = options.pathname ? getStorageKeys(options.pathname) : DEFAULT_KEYS;
  if (!store || !keys.suffix) return;
  try {
    const progress = readLegacyProgressSync(store, keys);
    progress.dismissed = true;
    store.setItem(keys.legacyProgressKey, JSON.stringify(progress));
    store.setItem(keys.legacyDismissedKey, '1');
  } catch {
    // ignore
  }
}

export function isRunningStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator?.standalone === true
  );
}

export function isIOSDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
