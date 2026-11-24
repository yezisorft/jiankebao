/**
 * 简课表查看 · 主应用控制器（纯原生 ES Modules，全量 textContent 安全渲染）
 */

import {
  DAY_NAMES,
  DAY_NAMES_FULL,
  LIMITS,
  addDays,
  clonePeriodsTemplate,
  createDefaultData,
  formatMonthDaySlash,
  formatShortDate,
  formatWeeksExpression,
  generateUniqueRuleId,
  getDayOfWeekISO,
  getMondayOfDate,
  getNowTimeInTimezone,
  getTodayInTimezone,
  isValidDateStr,
  isValidIanaTimezone,
  minutesToTime,
  parseWeeksExpression,
  timeToMinutes,
  validatePeriodsSchedule
} from './model.js';

import {
  addSingleOccurrence,
  applySingleOccurrenceEdit,
  deleteCourseGroup,
  findAffectedByPeriodLimit,
  findLegacyTransferResolution,
  findReferencesToPeriod,
  getLiveCourseStatus,
  getTermStatus,
  resolveAllTermOccurrences,
  resolveOccurrencesForDate,
  resolveOccurrencesForWeek,
  upgradeLegacyTransferPairs,
  upsertCourseGroup
} from './engine.js';

import {
  PREFS_KEY,
  STORAGE_KEY,
  commitScheduleDataAtomic,
  detectLegacyMigrationCandidate,
  dismissLegacyMigration,
  isIOSDevice,
  isRunningStandalone,
  loadPrefs,
  loadScheduleData,
  loadSnapshot,
  migrateLegacyDataToScoped,
  savePrefs
} from './storage.js';

import {
  buildImportPlan,
  getSameOriginExtractorSnippet,
  parseJsonBackup,
  parseTimetableHtml
} from './importers.js';

import {
  buildScheduleShareUrl,
  decodeTransferCode,
  encodeTransferCode,
  extractScheduleCode
} from './transfer.js';

import { exportScheduleToICS } from './ics.js';
import { PUBLIC_DEMO_JWGLXT_HTML } from './sample-fixture.js';

// ── 安全 DOM 构建辅助函数（所有文本均走 TextNode，杜绝 innerHTML 注入） ──
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else if (k in node && ['value', 'checked', 'disabled', 'selected'].includes(k)) node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
  return node;
}

// ── 不蒜子（Busuanzi）主线路 + Vercount 备用线路（兼容华为/鸿蒙浏览器防跟踪拦截） ──
const BUSUANZI_JSONP_URL = 'https://busuanzi.ibruce.info/busuanzi';
const VERCOUNT_API_URL = 'https://events.vercount.one/api/v2/log';

// ── 全局应用状态 ──
const initialLoad = loadScheduleData();
const upgradedInitial = upgradeLegacyTransferPairs(initialLoad.data);
const state = {
  data: upgradedInitial.data,
  prefs: loadPrefs(),
  activeTab: 'today',
  selectedDate: '',
  selectedWeek: 1,
  legacyCandidate: detectLegacyMigrationCandidate(),
  storageIssue: initialLoad.corrupted
    ? {
      kind: 'corrupted',
      rawContent: initialLoad.rawContent,
      error: '检测到本地已保存的课表 JSON 已损坏，已暂停覆盖写入以保护原始数据，请先导出损坏原文后再决定修复。'
    }
    : (initialLoad.readError
      ? {
        kind: 'read_error',
        rawContent: null,
        error: `启动读取本地课表失败（${initialLoad.readError}），已阻止自动覆盖以保护原数据。`
      }
      : null),
  offlineStatus: {
    checked: false,
    ready: false,
    secure: typeof window !== 'undefined' ? window.isSecureContext : false,
    version: '',
    detail: '正在检测离线状态…'
  },
  waitingSW: null,
  swRegistration: null,
  lastTransferInfo: null
};

state.activeTab = state.prefs.defaultTab || 'today';
state.selectedDate = getTodayInTimezone(state.data.term.timezone);
state.selectedWeek = getTermStatus(state.data, state.selectedDate).currentWeek;

// ── DOM 引用 ──
const mainView = document.getElementById('mainView');
const modalOverlay = document.getElementById('modalOverlay');
const conflictOverlay = document.getElementById('conflictOverlay');
const toastEl = document.getElementById('toast');
const offlineBadge = document.getElementById('offlineBadge');
const updateBanner = document.getElementById('updateBanner');
const applyUpdateBtn = document.getElementById('applyUpdateBtn');
const quickAddBtn = document.getElementById('quickAddBtn');

let toastTimer = null;

function showToast(msg, duration = 2800) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), duration);
}

async function copyTextToClipboard(text, successMsg = '已复制到剪贴板') {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(successMsg);
      return true;
    }
  } catch {
    // 降级
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(successMsg);
    return true;
  } catch {
    showToast('复制失败，请手动长按复制');
    return false;
  }
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function applyTheme() {
  const root = document.documentElement;
  let effectiveDark = false;
  if (state.prefs.theme === 'light' || state.prefs.theme === 'dark') {
    root.setAttribute('data-theme', state.prefs.theme);
    effectiveDark = state.prefs.theme === 'dark';
  } else {
    root.removeAttribute('data-theme');
    effectiveDark = Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  }
  const meta = document.getElementById('themeColorMeta');
  if (meta) {
    meta.setAttribute('content', effectiveDark ? '#0D1117' : '#F6F7F9');
  }
}

function closeConflictDialog() {
  conflictOverlay.classList.add('hidden');
  conflictOverlay.replaceChildren();
}

function openPeriodAffectedDialog(affectedList, targetPeriodCount, latestDataForLookup = state.data) {
  const rows = affectedList.map((item) => {
    const course = latestDataForLookup.courses.find((c) => c.id === item.courseId);
    return el('div', { className: 'preview-item row-between' },
      el('span', {}, item.label),
      item.kind === 'rule' && course
        ? el('button', {
          type: 'button',
          className: 'btn btn-xs btn-soft',
          onClick: () => {
            closeConflictDialog();
            openCourseGroupModal(course);
          }
        }, '去重排该课')
        : (item.date
          ? el('button', {
            type: 'button',
            className: 'btn btn-xs btn-soft',
            onClick: () => {
              closeConflictDialog();
              state.selectedDate = item.date;
              setTab('today');
            }
          }, '查看该日')
          : null)
    );
  });

  openModal(`无法缩短至 ${targetPeriodCount} 节作息`, [
    el('div', { className: 'notice-box notice-warn' },
      `以下 ${affectedList.length} 项排课或调停课例外超出第 ${targetPeriodCount} 节。为避免静默删课，已拦截保存并保留你的作息草稿，请先重排或删除这些课程后再缩短作息。`
    ),
    el('div', { className: 'preview-list' }, ...rows)
  ], [
    el('button', { type: 'button', className: 'btn btn-primary btn-sm', onClick: closeModal }, '我知道了')
  ]);
}

/**
 * 多标签页修订号冲突对话框（叠加于活动编辑弹窗之上，绝不销毁用户未保存草稿，且保留原快照与校验选项）
 */
function openConflictDialog(conflictInfo, pendingNextData, toastMessage, options = {}) {
  conflictOverlay.replaceChildren();
  const { expectedRevision, actualRevision, latestData } = conflictInfo;

  const actions = [
    el('button', {
      type: 'button',
      className: 'btn btn-sm',
      onClick: closeConflictDialog
    }, '返回继续编辑'),
    el('button', {
      type: 'button',
      className: 'btn btn-sm btn-soft',
      onClick: () => {
        state.data = latestData;
        closeConflictDialog();
        closeModal();
        render();
        showToast(`已加载最新课表（v${actualRevision}）`);
      }
    }, '加载最新版本（放弃本次草稿）')
  ];

  if (typeof options.mergeWithLatest === 'function') {
    actions.push(
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-primary',
        onClick: async () => {
          const res = await commitScheduleDataAtomic(
            (latest) => options.mergeWithLatest(latest),
            actualRevision,
            {
              beforeWriteValidate: options.beforeWriteValidate,
              snapshotBeforeOverwrite: options.snapshotBeforeOverwrite
            }
          );
          if (res.ok) {
            state.data = res.data;
            state.legacyCandidate = detectLegacyMigrationCandidate();
            closeConflictDialog();
            if (options.onResolvedSuccess) options.onResolvedSuccess();
            render();
            showToast(toastMessage ? `${toastMessage}（已合并最新版本）` : '已合并保存');
          } else if (res.reason === 'conflict') {
            openConflictDialog(res, pendingNextData, toastMessage, options);
          } else if (res.reason === 'validation_error') {
            closeConflictDialog();
            if (res.details?.affectedPeriods) {
              openPeriodAffectedDialog(res.details.affectedPeriods, res.details.targetPeriodCount, res.latestData || state.data);
            } else {
              showToast(res.error || '合并校验未通过', 4200);
            }
          } else {
            closeConflictDialog();
            showToast(`保存失败：${res.error}`, 4200);
          }
        }
      }, options.mergeLabel || '仅合并本项改动到最新课表')
    );
  }

  actions.push(
    el('button', {
      type: 'button',
      className: 'btn btn-sm btn-danger',
      onClick: async () => {
        const res = await commitScheduleDataAtomic(pendingNextData, actualRevision, {
          force: true,
          beforeWriteValidate: options.beforeWriteValidate,
          snapshotBeforeOverwrite: options.snapshotBeforeOverwrite
        });
        if (res.ok) {
          state.data = res.data;
          state.legacyCandidate = detectLegacyMigrationCandidate();
          closeConflictDialog();
          if (options.onResolvedSuccess) options.onResolvedSuccess();
          render();
          showToast(toastMessage || '已强制覆盖保存');
        } else if (res.reason === 'validation_error') {
          closeConflictDialog();
          if (res.details?.affectedPeriods) {
            openPeriodAffectedDialog(res.details.affectedPeriods, res.details.targetPeriodCount, res.latestData || state.data);
          } else {
            showToast(res.error || '数据校验未通过', 4200);
          }
        } else {
          closeConflictDialog();
          showToast(`保存失败：${res.error}`, 4200);
        }
      }
    }, '强制以当前内容覆盖')
  );

  const sheet = el(
    'div',
    { className: 'modal-sheet', onClick: (e) => e.stopPropagation() },
    el('div', { className: 'modal-header' },
      el('h3', { className: 'modal-title' }, '检测到多标签页写入冲突')
    ),
    el('div', { className: 'modal-body' },
      el('div', { className: 'notice-box notice-warn' },
        `你在另一个浏览器标签页已修改并保存了课表（当前草稿基于 v${expectedRevision}，本地最新为 v${actualRevision}）。已拦截直接覆盖，以防丢失另一标签页的改动。`
      ),
      el('p', { className: 'muted', style: { margin: 0, fontSize: '13px' } },
        `最新已保存状态：${latestData.term.name} · ${latestData.courses.length} 门课 · ${latestData.periods.length} 节作息 · ${latestData.overrides.length} 条例外。`
      )
    ),
    el('div', { className: 'modal-footer' }, ...actions)
  );

  conflictOverlay.appendChild(sheet);
  conflictOverlay.classList.remove('hidden');
}

/**
 * 检测到本地已存 JSON 损坏时的保护对话框（允许先导出损坏原文，再明确确认覆盖修复）
 */
function openCorruptedStorageDialog(rawContent, pendingNextData, toastMessage, options = {}) {
  conflictOverlay.replaceChildren();
  const sheet = el(
    'div',
    { className: 'modal-sheet', onClick: (e) => e.stopPropagation() },
    el('div', { className: 'modal-header' },
      el('h3', { className: 'modal-title' }, '本地已存课表损坏 · 已中止覆盖')
    ),
    el('div', { className: 'modal-body' },
      el('div', { className: 'notice-box notice-warn' },
        '写入前检测到本地存储中的现有课表 JSON 已损坏（无法解析）。为防止覆盖导致原始数据彻底丢失，已中止本次写入。建议先导出损坏原文留档，再决定是否覆盖修复。'
      ),
      el('p', { className: 'muted', style: { margin: 0, fontSize: '12.5px' } },
        `损坏原文长度：${String(rawContent || '').length} 字符。`
      )
    ),
    el('div', { className: 'modal-footer' },
      el('button', { type: 'button', className: 'btn btn-sm', onClick: closeConflictDialog }, '取消并返回'),
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-soft',
        onClick: () => {
          const filename = `简课表损坏原文_${Date.now()}.txt`;
          downloadTextFile(filename, String(rawContent || ''), 'text/plain;charset=utf-8');
          showToast(`已导出损坏原文：${filename}`);
        }
      }, '导出损坏原文 (.txt)'),
      el('button', {
        type: 'button',
        className: 'btn btn-sm btn-danger',
        onClick: async () => {
          const res = await commitScheduleDataAtomic(pendingNextData, null, {
            force: true,
            allowOverwriteCorrupted: true,
            beforeWriteValidate: options.beforeWriteValidate || null
          });
          if (res.ok) {
            state.data = res.data;
            state.storageIssue = null;
            state.legacyCandidate = detectLegacyMigrationCandidate();
            closeConflictDialog();
            if (options.onResolvedSuccess) options.onResolvedSuccess();
            render();
            showToast(toastMessage || '已使用当前数据覆盖修复本地存储');
          } else {
            closeConflictDialog();
            showToast(`覆盖修复失败：${res.error || '写入受限'}`, 4500);
          }
        }
      }, '用当前数据覆盖修复')
    )
  );
  conflictOverlay.appendChild(sheet);
  conflictOverlay.classList.remove('hidden');
}

/**
 * 统一跨窗口原子落盘（基于 Web Locks 串行执行）：
 * - 在排他锁内重读最新状态、核对 revision、拦截读取故障或损坏存储、执行配额与业务前校验、以最新持久化状态写入快照并提交主数据；
 * - 任何失败或冲突均返回 false，保留当前编辑草稿与原有快照。
 */
async function persistData(nextData, toastMessage = '', options = {}) {
  const res = await commitScheduleDataAtomic(nextData, state.data.revision, {
    force: Boolean(options.force),
    allowOverwriteCorrupted: Boolean(options.allowOverwriteCorrupted),
    snapshotBeforeOverwrite: options.snapshotBeforeOverwrite || null,
    beforeWriteValidate: options.beforeWriteValidate || null
  });
  if (res.ok) {
    state.data = res.data;
    state.storageIssue = null;
    state.legacyCandidate = detectLegacyMigrationCandidate();
    render();
    if (toastMessage) showToast(toastMessage);
    return true;
  }

  if (res.reason === 'conflict') {
    openConflictDialog(res, nextData, toastMessage, options);
    return false;
  }

  if (res.reason === 'corrupted_storage') {
    state.storageIssue = {
      kind: 'corrupted',
      rawContent: res.rawContent,
      error: res.error
    };
    openCorruptedStorageDialog(res.rawContent, nextData, toastMessage, options);
    return false;
  }

  if (res.reason === 'read_error') {
    showToast(res.error || '读取本地存储失败，已中止覆盖以保护原数据', 5000);
    return false;
  }

  if (res.reason === 'validation_error') {
    if (res.details?.affectedPeriods) {
      openPeriodAffectedDialog(res.details.affectedPeriods, res.details.targetPeriodCount, res.latestData || state.data);
    } else {
      showToast(res.error || '数据校验未通过', 4500);
    }
    return false;
  }

  showToast(`保存失败：${res.error || '本地存储不可用'}`, 4500);
  return false;
}

function persistPrefs(patch) {
  state.prefs = savePrefs({ ...state.prefs, ...patch });
  applyTheme();
  render();
}

const statsRuntime = {
  loading: false,
  error: ''
};

function fetchBusuanziStats(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const cbName = `BusuanziCallback_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement('script');
    let settled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try { delete window[cbName]; } catch { window[cbName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('timeout'));
    }, timeoutMs);

    window[cbName] = (data) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    script.async = true;
    script.referrerPolicy = 'no-referrer-when-downgrade';
    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('network_error'));
    };
    script.src = `${BUSUANZI_JSONP_URL}?jsonpCallback=${encodeURIComponent(cbName)}`;
    document.head.appendChild(script);
  });
}

async function fetchVercountStats(timeoutMs = 8000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const pageUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://yezisorft.github.io/jiankebao/';
    const resp = await fetch(VERCOUNT_API_URL, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pageUrl, token: '' }),
      signal: controller?.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const uv = Number(json?.data?.site_uv);
    if (!Number.isFinite(uv) || uv < 0) throw new Error('invalid_vercount_payload');
    return { site_uv: Math.max(1, Math.floor(uv)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function syncUsageStats({ manual = false } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (manual) showToast('当前处于断网状态，已展示本地缓存数据');
    return;
  }
  if (statsRuntime.loading) return;

  statsRuntime.loading = true;
  statsRuntime.error = '';
  if (manual && state.activeTab === 'settings') render();

  try {
    let payload = null;
    try {
      payload = await fetchBusuanziStats(6000);
    } catch {
      payload = await fetchVercountStats(8000);
    }
    const uv = Number(payload?.site_uv);
    if (Number.isFinite(uv) && uv >= 0) {
      state.prefs = savePrefs({
        ...state.prefs,
        statsReported: true,
        cachedTotalUsers: Math.floor(uv),
        cachedStatsAt: new Date().toISOString()
      });
      if (manual) showToast('已刷新使用人数统计');
    } else {
      throw new Error('invalid_payload');
    }
  } catch {
    statsRuntime.error = '离线或暂不可达';
    if (manual) showToast('统计服务暂不可达，已保留本地缓存');
  } finally {
    statsRuntime.loading = false;
    if (state.activeTab === 'settings') render();
  }
}

function setTab(tab) {
  state.activeTab = tab;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── 弹窗控制 ──
let modalOnCloseCallback = null;

function openModal(title, bodyNodes, footerNodes = [], options = {}) {
  modalOverlay.replaceChildren();
  modalOnCloseCallback = typeof options.onClose === 'function' ? options.onClose : null;
  const closeBtn = el('button', {
    type: 'button',
    className: 'btn btn-ghost btn-xs',
    'aria-label': '关闭弹窗',
    onClick: closeModal
  }, '关闭');

  const sheet = el(
    'div',
    { className: 'modal-sheet', onClick: (e) => e.stopPropagation() },
    el('div', { className: 'modal-header' }, el('h3', { className: 'modal-title' }, title), closeBtn),
    el('div', { className: 'modal-body' }, ...bodyNodes),
    footerNodes.length ? el('div', { className: 'modal-footer' }, ...footerNodes) : null
  );

  modalOverlay.appendChild(sheet);
  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  const onClose = modalOnCloseCallback;
  modalOnCloseCallback = null;
  modalOverlay.classList.add('hidden');
  modalOverlay.replaceChildren();
  if (onClose) onClose();
}

function openWelcomeNameModal({ isFirstUse = false } = {}) {
  const nameInput = el('input', {
    type: 'text',
    value: state.prefs.userName || '',
    placeholder: '请输入你的名字或昵称',
    maxLength: 24,
    'aria-label': '你的名字'
  });

  const submit = () => {
    const trimmed = nameInput.value.trim();
    modalOnCloseCallback = null;
    closeModal();
    persistPrefs({ userName: trimmed, namePromptDone: true });
    showToast(trimmed ? `你好，${trimmed}！` : '已保存称呼设置');
  };

  const skip = () => {
    modalOnCloseCallback = null;
    closeModal();
    if (isFirstUse) {
      persistPrefs({ namePromptDone: true });
    }
  };

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });

  openModal(
    isFirstUse ? '欢迎使用简课表' : '设置你的称呼',
    [
      el('p', { className: 'muted', style: { margin: 0, fontSize: '13.5px', lineHeight: '1.6' } },
        '输入你想显示的名字后，将在「今日」界面最上方为你展示专属问候语（也可随时在「设置」中修改或清空）。'),
      el('div', { className: 'field' },
        el('label', {}, '你的名字'),
        nameInput
      )
    ],
    [
      el('button', { type: 'button', className: 'btn', onClick: skip }, isFirstUse ? '暂不设置' : '取消'),
      el('button', { type: 'button', className: 'btn btn-primary', onClick: submit }, '确定')
    ],
    {
      onClose: () => {
        if (isFirstUse && !state.prefs.namePromptDone) {
          persistPrefs({ namePromptDone: true });
        }
      }
    }
  );
  setTimeout(() => nameInput.focus(), 0);
}

modalOverlay.addEventListener('click', closeModal);
conflictOverlay.addEventListener('click', closeConflictDialog);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!conflictOverlay.classList.contains('hidden')) {
      closeConflictDialog();
      return;
    }
    if (!modalOverlay.classList.contains('hidden')) {
      closeModal();
      return;
    }
  }
  if (!modalOverlay.classList.contains('hidden') || !conflictOverlay.classList.contains('hidden')) return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;

  if (state.activeTab === 'week') {
    if (e.key === 'ArrowLeft') {
      state.selectedWeek = Math.max(1, state.selectedWeek - 1);
      render();
    } else if (e.key === 'ArrowRight') {
      state.selectedWeek = Math.min(state.data.term.totalWeeks, state.selectedWeek + 1);
      render();
    } else if (e.key.toLowerCase() === 't') {
      const today = getTodayInTimezone(state.data.term.timezone);
      state.selectedWeek = getTermStatus(state.data, today).currentWeek;
      render();
    }
  } else if (state.activeTab === 'today') {
    if (e.key === 'ArrowLeft') {
      state.selectedDate = addDays(state.selectedDate, -1);
      render();
    } else if (e.key === 'ArrowRight') {
      state.selectedDate = addDays(state.selectedDate, 1);
      render();
    } else if (e.key.toLowerCase() === 't') {
      state.selectedDate = getTodayInTimezone(state.data.term.timezone);
      render();
    }
  }
});

// ── 多标签页实时同步监听（storage 事件） ──
window.addEventListener('storage', (e) => {
  if (e.key === PREFS_KEY) {
    state.prefs = loadPrefs();
    applyTheme();
    if (modalOverlay.classList.contains('hidden')) render();
    return;
  }
  if (e.key === STORAGE_KEY) {
    const latest = loadScheduleData().data;
    if (latest.revision === state.data.revision) return;
    const isModalOpen = !modalOverlay.classList.contains('hidden');
    const isEditingSettings = state.activeTab === 'settings';
    if (!isModalOpen && !isEditingSettings) {
      state.data = latest;
      render();
      showToast(`已自动同步另一标签页的更新（v${latest.revision}）`);
    } else {
      showToast(`提示：另一标签页已更新课表（v${latest.revision}），保存时将自动检测冲突`, 3600);
    }
  }
});

// ── 离线状态与原子 Service Worker 管理 ──
function updateOfflineBadgeUI() {
  const s = state.offlineStatus;
  offlineBadge.className = 'status-pill';
  if (s.ready) {
    offlineBadge.classList.add('status-ready');
    offlineBadge.textContent = '已可离线使用';
  } else if (!s.secure) {
    offlineBadge.classList.add('status-online');
    offlineBadge.textContent = '仅在线预览（需 HTTPS）';
  } else if (s.checked) {
    offlineBadge.classList.add('status-online');
    offlineBadge.textContent = '离线缓存准备中';
  } else {
    offlineBadge.classList.add('status-pending');
    offlineBadge.textContent = '检测离线状态…';
  }
}

async function querySwOfflineStatus(sw) {
  if (!sw) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data || null);
    };
    sw.postMessage({ type: 'GET_OFFLINE_STATUS' }, [channel.port2]);
  });
}

async function refreshOfflineStatus() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    state.offlineStatus = {
      checked: true,
      ready: false,
      secure: window.isSecureContext,
      version: '',
      detail: window.isSecureContext
        ? '当前浏览器不支持 Service Worker，无法启用离线模式。'
        : '当前通过非 HTTPS 局域网地址访问（非安全上下文），仅可预览界面布局；离线验收请使用受信任的 HTTPS 地址。'
    };
    updateOfflineBadgeUI();
    return;
  }

  try {
    const reg = state.swRegistration || await navigator.serviceWorker.getRegistration();
    const active = navigator.serviceWorker.controller || reg?.active;
    if (!active) {
      state.offlineStatus = {
        checked: true,
        ready: false,
        secure: true,
        version: '',
        detail: '离线核心资源正在缓存，请稍候或刷新一次页面以完成激活。'
      };
      updateOfflineBadgeUI();
      return;
    }

    const res = await querySwOfflineStatus(active);
    if (res && res.ready) {
      state.offlineStatus = {
        checked: true,
        ready: true,
        secure: true,
        version: res.version || '',
        detail: `核心资源已完整缓存（${res.cachedCount}/${res.totalCount}，${res.version}），可断开网络直接打开。`
      };
    } else {
      state.offlineStatus = {
        checked: true,
        ready: false,
        secure: true,
        version: res?.version || '',
        detail: res
          ? `缓存尚未齐全（${res.cachedCount}/${res.totalCount}），请在联网状态下稍候重试。`
          : '正在等待 Service Worker 响应离线校验。'
      };
    }
  } catch {
    state.offlineStatus = {
      checked: true,
      ready: false,
      secure: window.isSecureContext,
      version: '',
      detail: '离线状态校验异常，请检查 HTTPS 证书或刷新重试。'
    };
  }
  updateOfflineBadgeUI();
  if (state.activeTab === 'settings') render();
}

let shouldReloadOnControllerChange = false;

async function initServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    await refreshOfflineStatus();
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (shouldReloadOnControllerChange) {
      shouldReloadOnControllerChange = false;
      window.location.reload();
    } else {
      refreshOfflineStatus();
    }
  });

  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    state.swRegistration = reg;

    const showUpdateIfWaiting = (worker) => {
      if (!worker) return;
      state.waitingSW = worker;
      updateBanner.classList.remove('hidden');
    };

    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdateIfWaiting(reg.waiting);
    }

    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') {
          if (navigator.serviceWorker.controller) {
            showUpdateIfWaiting(installing);
          } else {
            refreshOfflineStatus();
          }
        } else if (installing.state === 'activated') {
          refreshOfflineStatus();
        }
      });
    });

    await navigator.serviceWorker.ready;
    await refreshOfflineStatus();
    // 首次冷启动时若 SW 刚激活但控制权尚未完全附加，追加一次短重试确保离线就绪徽章稳定刷新
    if (!state.offlineStatus.ready) {
      setTimeout(() => { refreshOfflineStatus(); }, 800);
    }
  } catch {
    await refreshOfflineStatus();
  }
}

applyUpdateBtn.addEventListener('click', () => {
  if (state.waitingSW) {
    shouldReloadOnControllerChange = true;
    state.waitingSW.postMessage({ type: 'SKIP_WAITING' });
  }
});

// ── 辅助：学期阶段可读描述 ──
function formatTermStatusText(termStatus) {
  if (termStatus.phase === 'before') {
    return `距离开学还有 ${termStatus.daysUntilStart} 天`;
  }
  if (termStatus.phase === 'active') {
    return `第 ${termStatus.currentWeek} 周`;
  }
  if (termStatus.nextTermDays !== null) {
    return `本学期已结束 · 距下学期开学 ${termStatus.nextTermDays} 天`;
  }
  return '本学期已结束';
}

// ── 视图 1：今日视图 ──
function renderTodayView() {
  const todayStr = getTodayInTimezone(state.data.term.timezone);
  const nowHHMM = getNowTimeInTimezone(state.data.term.timezone);
  const termStatus = getTermStatus(state.data, todayStr);
  const viewingStr = state.selectedDate || todayStr;
  const isViewingToday = viewingStr === todayStr;

  const allForDay = resolveOccurrencesForDate(state.data, viewingStr, { includeCancelled: true });
  const activeForDay = allForDay.filter((o) => !o.cancelled);
  const cancelledForDay = allForDay.filter((o) => o.cancelled);

  const root = el('div', { className: 'stack' });

  const greetingName = (state.prefs.userName || '').trim();
  if (greetingName) {
    root.appendChild(
      el('div', { className: 'today-greeting' }, `${greetingName}，你好！祝顺利`)
    );
  }

  if (state.data.courses.length === 0 && state.data.overrides.length === 0) {
    root.appendChild(renderEmptyOnboardingCard());
    return root;
  }

  const dow = getDayOfWeekISO(viewingStr);
  const viewingWeek = getTermStatus(state.data, viewingStr);
  const viewingWeekLabel = viewingWeek.phase === 'active'
    ? `第 ${viewingWeek.currentWeek} 周`
    : formatTermStatusText(viewingWeek);

  const metaLine = el(
    'div',
    { className: 'today-meta tabular' },
    el('span', { className: 'tag tag-primary' }, viewingWeekLabel),
    el('span', {}, `${formatShortDate(viewingStr)} ${DAY_NAMES_FULL[dow]}`),
    el('span', { className: 'muted' }, `· ${state.data.term.name}`)
  );

  let heroNode;
  if (isViewingToday) {
    const live = getLiveCourseStatus(activeForDay, nowHHMM);
    const heroCls = live.state === 'ongoing'
      ? 'hero-card hero-ongoing'
      : live.state === 'upcoming'
        ? 'hero-card hero-upcoming'
        : 'hero-card';

    heroNode = el(
      'section',
      { className: heroCls },
      metaLine,
      el('div', { className: 'hero-title' }, live.title),
      el('div', { className: 'hero-sub' }, live.subtitle),
      termStatus.phase === 'ended'
        ? el('div', { className: 'hero-sub' },
          termStatus.nextTermDays !== null
            ? `本学期已结束（截止 ${termStatus.termEndDate}），距离下学期开学还有 ${termStatus.nextTermDays} 天。`
            : `本学期已结束（截止 ${termStatus.termEndDate}），如需下学期倒计时可在「设置」中填写下学期开学日。`)
        : null
    );
  } else {
    heroNode = el(
      'section',
      { className: 'hero-card' },
      metaLine,
      el('div', { className: 'hero-title' },
        activeForDay.length > 0 ? `当天共有 ${activeForDay.length} 节课程安排` : '当天没有安排课程'),
      el('div', { className: 'hero-sub' },
        `当前正在查看 ${viewingStr}（今天是 ${todayStr}）`)
    );
  }
  root.appendChild(heroNode);

  const yesterdayStr = addDays(todayStr, -1);
  const tomorrowStr = addDays(todayStr, 1);

  const dateJump = el('input', {
    type: 'date',
    value: viewingStr,
    'aria-label': '选择查看日期',
    style: { width: 'auto', padding: '6px 10px' },
    onChange: (e) => {
      if (isValidDateStr(e.target.value)) {
        state.selectedDate = e.target.value;
        render();
      }
    }
  });

  const switcher = el(
    'div',
    { className: 'day-switcher' },
    el(
      'div',
      { className: 'seg-group' },
      el('button', {
        type: 'button',
        className: `seg-btn ${viewingStr === yesterdayStr ? 'active' : ''}`,
        onClick: () => { state.selectedDate = yesterdayStr; render(); }
      }, '昨天'),
      el('button', {
        type: 'button',
        className: `seg-btn ${isViewingToday ? 'active' : ''}`,
        onClick: () => { state.selectedDate = todayStr; render(); }
      }, '今天'),
      el('button', {
        type: 'button',
        className: `seg-btn ${viewingStr === tomorrowStr ? 'active' : ''}`,
        onClick: () => { state.selectedDate = tomorrowStr; render(); }
      }, '明天')
    ),
    el(
      'div',
      { className: 'row' },
      !isViewingToday
        ? el('button', {
          type: 'button',
          className: 'btn btn-soft btn-xs',
          onClick: () => { state.selectedDate = todayStr; render(); }
        }, '回到今天')
        : null,
      dateJump
    )
  );
  root.appendChild(switcher);

  const hasFirstPeriodClass = activeForDay.some((o) => o.startPeriod <= 1 && o.endPeriod >= 1);
  if (hasFirstPeriodClass) {
    root.appendChild(
      el('div', {
        className: 'notice-box notice-info row-between tabular',
        style: { padding: '8px 12px', fontSize: '12.5px' }
      },
        el('strong', {}, '早自习'),
        el('span', { className: 'muted' }, '08:00 – 08:15（第 1 节有课）')
      )
    );
  }

  if (activeForDay.length === 0) {
    root.appendChild(
      el(
        'div',
        { className: 'card empty-state' },
        el('h2', {}, '这一天没有排课'),
        el('p', {}, '可以切换到「周课表」查看整周安排，或点击下方添加一次临时补课。'),
        el(
          'div',
          { className: 'row' },
          el('button', { type: 'button', className: 'btn btn-soft btn-sm', onClick: () => setTab('week') }, '查看周课表'),
          el('button', { type: 'button', className: 'btn btn-sm', onClick: () => openAddCourseModal('once', viewingStr) }, '+ 添加单次补课')
        )
      )
    );
  } else {
    const timeline = el('div', { className: 'timeline' });
    for (const occ of activeForDay) {
      timeline.appendChild(renderOccurrenceTimelineCard(occ));
    }
    root.appendChild(timeline);
  }

  if (cancelledForDay.length > 0) {
    const cancelBox = el('div', { className: 'stack' },
      el('div', { className: 'muted', style: { fontSize: '12px', fontWeight: '600' } }, `当天已停课 / 已调出（${cancelledForDay.length}）`)
    );
    for (const occ of cancelledForDay) {
      cancelBox.appendChild(
        el(
          'div',
          { className: `occ-card occ-cancelled color-${occ.colorIndex}` },
          el('div', { className: 'occ-time' },
            el('span', { className: 'occ-time-start' }, occ.startTime),
            el('span', { className: 'occ-time-end' }, occ.endTime)
          ),
          el('div', { className: 'occ-accent' }),
          el('div', { className: 'occ-body' },
            el('div', { className: 'row-between' },
              el('div', { className: 'occ-name-row' },
                el('span', { className: 'occ-name', style: { textDecoration: 'line-through' } }, occ.name),
                el('span', { className: 'tag tag-danger' }, occ.transferGroupId ? '已调至他日' : '已停课')
              ),
              el('button', {
                type: 'button',
                className: 'btn btn-xs btn-soft',
                onClick: async (e) => {
                  e.stopPropagation();
                  const legacyRes = findLegacyTransferResolution(state.data, occ);
                  if (legacyRes.status === 'ambiguous' && legacyRes.candidates.length > 0) {
                    openAmbiguousLegacyRestoreModal(occ, legacyRes);
                    return;
                  }
                  const next = applySingleOccurrenceEdit(state.data, occ, 'restore');
                  const paired = Boolean(occ.transferGroupId) || legacyRes.status === 'unique';
                  const msg = paired
                    ? `已恢复 ${occ.name}，并同步撤回目标日调课`
                    : `已恢复 ${occ.name}`;
                  await persistData(next, msg);
                }
              }, occ.transferGroupId ? '恢复本次（撤回调课）' : '恢复本次')
            ),
            el('div', { className: 'occ-details' },
              el('span', {}, `第${occ.startPeriod}-${occ.endPeriod}节`),
              occ.cancelReason ? el('span', {}, `原因：${occ.cancelReason}`) : null
            )
          )
        )
      );
    }
    root.appendChild(cancelBox);
  }

  return root;
}

function renderOccurrenceTimelineCard(occ) {
  const tags = [];
  if (occ.source === 'modified') tags.push(el('span', { className: 'tag tag-warn' }, '已调整'));
  if (occ.source === 'added') tags.push(el('span', { className: 'tag tag-success' }, occ.transferGroupId ? '跨天调课' : '补课'));
  if (occ.adjusted) tags.push(el('span', { className: 'tag tag-warn' }, '教务调课'));
  if (occ.courseType) tags.push(el('span', { className: 'tag tag-muted' }, occ.courseType));
  if (occ.status === 'pending') tags.push(el('span', { className: 'tag tag-danger' }, '待筛选'));

  const roomBtn = occ.location
    ? el('button', {
      type: 'button',
      className: 'occ-room-btn',
      title: '点击复制教室',
      onClick: (e) => {
        e.stopPropagation();
        copyTextToClipboard(occ.location, `已复制教室：${occ.location}`);
      }
    }, `@ ${occ.location}`)
    : null;

  return el(
    'article',
    {
      className: `occ-card color-${occ.colorIndex}`,
      onClick: () => openOccurrenceDetailModal(occ)
    },
    el(
      'div',
      { className: 'occ-time' },
      el('span', { className: 'occ-time-start' }, occ.startTime),
      el('span', { className: 'occ-time-end' }, occ.endTime),
      el('span', { className: 'occ-time-period' }, `${occ.startPeriod}-${occ.endPeriod}节`)
    ),
    el('div', { className: 'occ-accent' }),
    el(
      'div',
      { className: 'occ-body' },
      el('div', { className: 'occ-name-row' }, el('span', { className: 'occ-name' }, occ.name), ...tags),
      el(
        'div',
        { className: 'occ-details' },
        roomBtn,
        occ.teacher ? el('span', { className: 'occ-teacher' }, `教师：${occ.teacher}`) : null,
        occ.note ? el('span', { className: 'muted' }, `· ${occ.note}`) : null
      )
    )
  );
}

function renderEmptyOnboardingCard() {
  return el(
    'section',
    { className: 'card empty-state' },
    el('h2', {}, '还没有课表数据'),
    el('p', {}, '支持导入已验证的正方新版教务（jwglxt）已渲染课表、恢复 JSON 备份、粘贴导入码，或手动录入课程。'),
    el(
      'div',
      { className: 'row', style: { justifyContent: 'center' } },
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => setTab('import')
      }, '导入我的课表 / 备份'),
      el('button', {
        type: 'button',
        className: 'btn btn-soft',
        onClick: () => handleHtmlImportPreview(PUBLIC_DEMO_JWGLXT_HTML, '公开演示课表样例')
      }, '载入演示课表样例'),
      el('button', {
        type: 'button',
        className: 'btn',
        onClick: () => openAddCourseModal('group')
      }, '手动添加课程')
    )
  );
}

// ── 视图 2：周课表视图 ──
function detectSectionBreakIndices(periods) {
  const breaks = new Set();
  for (let i = 0; i < periods.length - 1; i += 1) {
    const gap = timeToMinutes(periods[i + 1].start) - timeToMinutes(periods[i].end);
    if (gap >= 40) breaks.add(periods[i].index);
  }
  return breaks;
}

function layoutDayOccurrences(occurrences) {
  const placed = occurrences.map((occ) => ({ occ, lane: 0, laneCount: 1 }));
  for (let i = 0; i < placed.length; i += 1) {
    const cur = placed[i];
    const overlapping = placed.filter((p) =>
      p.occ.startPeriod <= cur.occ.endPeriod && cur.occ.startPeriod <= p.occ.endPeriod
    );
    if (overlapping.length > 1) {
      overlapping.forEach((item, idx) => {
        item.lane = idx;
        item.laneCount = overlapping.length;
      });
    }
  }
  return placed;
}

function computeNowLinePercent(periods, nowHHMM) {
  if (!periods.length) return null;
  const nowMin = timeToMinutes(nowHHMM);
  const firstStart = timeToMinutes(periods[0].start);
  const lastEnd = timeToMinutes(periods[periods.length - 1].end);
  if (nowMin < firstStart || nowMin > lastEnd) return null;

  for (let i = 0; i < periods.length; i += 1) {
    const s = timeToMinutes(periods[i].start);
    const e = timeToMinutes(periods[i].end);
    if (nowMin >= s && nowMin <= e) {
      const frac = e > s ? (nowMin - s) / (e - s) : 0;
      return ((i + frac) / periods.length) * 100;
    }
    if (i + 1 < periods.length) {
      const nextS = timeToMinutes(periods[i + 1].start);
      if (nowMin > e && nowMin < nextS) {
        return ((i + 1) / periods.length) * 100;
      }
    }
  }
  return null;
}

function renderWeekView() {
  const todayStr = getTodayInTimezone(state.data.term.timezone);
  const nowHHMM = getNowTimeInTimezone(state.data.term.timezone);
  const termStatus = getTermStatus(state.data, todayStr);
  const totalWeeks = state.data.term.totalWeeks;
  const weekNum = Math.max(1, Math.min(totalWeeks, state.selectedWeek));
  state.selectedWeek = weekNum;

  const weekData = resolveOccurrencesForWeek(state.data, weekNum, { includeCancelled: false });
  const hasWeekendCourses = weekData.days[5].occurrences.length > 0 || weekData.days[6].occurrences.length > 0;

  let visibleDayCount = 7;
  if (state.prefs.showWeekend === 'never') visibleDayCount = 5;
  else if (state.prefs.showWeekend === 'auto') visibleDayCount = hasWeekendCourses ? 7 : 5;

  const visibleDays = weekData.days.slice(0, visibleDayCount);
  const periods = state.data.periods;
  const sectionBreaks = detectSectionBreakIndices(periods);

  const root = el('div', { className: 'stack' });
  const weekendLabelMap = { auto: '周末: 自动', always: '周末: 显示', never: '周末: 隐藏' };
  const nextWeekendMode = { auto: 'always', always: 'never', never: 'auto' };
  const isViewingCurrentWeek = termStatus.phase === 'active' && weekNum === termStatus.currentWeek;

  const toolbar = el(
    'div',
    { className: 'week-toolbar' },
    el(
      'div',
      { className: 'row' },
      el(
        'div',
        { className: 'week-stepper' },
        el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-xs',
          disabled: weekNum <= 1,
          'aria-label': '上一周',
          onClick: () => { state.selectedWeek = Math.max(1, weekNum - 1); render(); }
        }, '‹'),
        el('button', {
          type: 'button',
          className: 'week-pill-btn tabular',
          onClick: () => openWeekPickerModal(weekNum, termStatus.currentWeek, totalWeeks)
        }, `第 ${weekNum} 周${isViewingCurrentWeek ? '（本周）' : ''}`),
        el('button', {
          type: 'button',
          className: 'btn btn-ghost btn-xs',
          disabled: weekNum >= totalWeeks,
          'aria-label': '下一周',
          onClick: () => { state.selectedWeek = Math.min(totalWeeks, weekNum + 1); render(); }
        }, '›')
      ),
      !isViewingCurrentWeek
        ? el('button', {
          type: 'button',
          className: 'btn btn-soft btn-xs',
          onClick: () => { state.selectedWeek = termStatus.currentWeek; render(); }
        }, '回到本周')
        : null
    ),
    el(
      'div',
      { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-xs',
        onClick: () => persistPrefs({ showWeekend: nextWeekendMode[state.prefs.showWeekend] })
      }, weekendLabelMap[state.prefs.showWeekend]),
      el('button', {
        type: 'button',
        className: 'btn btn-xs btn-soft',
        onClick: () => openAddCourseModal('group')
      }, '+ 排课')
    )
  );
  root.appendChild(toolbar);

  if (state.data.courses.length === 0 && state.data.overrides.length === 0) {
    root.appendChild(renderEmptyOnboardingCard());
    return root;
  }

  const firstPeriodDays = visibleDays.filter((day) =>
    day.occurrences.some((o) => !o.cancelled && o.startPeriod <= 1 && o.endPeriod >= 1)
  );
  if (firstPeriodDays.length > 0) {
    const dayLabels = firstPeriodDays.map((d) => DAY_NAMES[d.dayOfWeek]).join('、');
    root.appendChild(
      el('div', {
        className: 'notice-box notice-info row-between tabular',
        style: { padding: '7px 12px', fontSize: '12px' }
      },
        el('strong', {}, '早自习 · 08:00 – 08:15'),
        el('span', { className: 'muted' }, `第 1 节有课（${dayLabels}）`)
      )
    );
  }

  const gridWrap = el('div', {
    className: 'week-grid-wrap',
    style: {
      '--day-cols': String(visibleDayCount),
      '--period-count': String(periods.length)
    }
  });

  let touchStartX = 0;
  let touchStartY = 0;
  gridWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  gridWrap.addEventListener('touchend', (e) => {
    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0 && state.selectedWeek < totalWeeks) {
        state.selectedWeek += 1;
        render();
      } else if (dx > 0 && state.selectedWeek > 1) {
        state.selectedWeek -= 1;
        render();
      }
    }
  }, { passive: true });

  const header = el('div', { className: 'week-header' },
    el('div', { className: 'week-head-cell' },
      el('span', {}, '节'),
      el('span', { className: 'week-head-date' }, `${periods.length}节`)
    )
  );
  for (const day of visibleDays) {
    header.appendChild(
      el(
        'div',
        { className: `week-head-cell ${day.date === todayStr ? 'is-today' : ''}` },
        el('span', {}, DAY_NAMES[day.dayOfWeek]),
        el('span', { className: 'week-head-date' }, formatMonthDaySlash(day.date))
      )
    );
  }
  gridWrap.appendChild(header);

  const body = el('div', { className: 'week-body' });

  const axis = el('div', { className: 'period-axis' });
  for (const p of periods) {
    axis.appendChild(
      el(
        'div',
        { className: `period-tick ${sectionBreaks.has(p.index) ? 'section-break' : ''}` },
        el('span', { className: 'period-tick-num' }, String(p.index)),
        el('span', { className: 'period-tick-time' }, p.start),
        el('span', { className: 'period-tick-time period-tick-end' }, p.end)
      )
    );
  }
  body.appendChild(axis);

  const nowPct = computeNowLinePercent(periods, nowHHMM);

  for (const day of visibleDays) {
    const isTodayCol = day.date === todayStr;
    const col = el('div', { className: `day-column ${isTodayCol ? 'is-today' : ''}` });

    for (const p of periods) {
      col.appendChild(el('div', { className: `grid-slot-line ${sectionBreaks.has(p.index) ? 'section-break' : ''}` }));
    }

    const eventsLayer = el('div', { className: 'day-events-layer' });
    const laidOut = layoutDayOccurrences(day.occurrences);

    for (const { occ, lane, laneCount } of laidOut) {
      const topPct = ((occ.startPeriod - 1) / periods.length) * 100;
      const heightPct = ((occ.endPeriod - occ.startPeriod + 1) / periods.length) * 100;
      const widthPct = 100 / laneCount;
      const leftPct = lane * widthPct;

      const badges = [];
      if (occ.source === 'modified') badges.push(el('span', { className: 'mini-badge' }, '改'));
      else if (occ.source === 'added') badges.push(el('span', { className: 'mini-badge' }, occ.transferGroupId ? '调' : '补'));
      else if (occ.adjusted) badges.push(el('span', { className: 'mini-badge' }, '调'));
      if (occ.status === 'pending') badges.push(el('span', { className: 'mini-badge' }, '待筛'));

      const block = el(
        'div',
        {
          className: `grid-block color-${occ.colorIndex}`,
          style: {
            top: `calc(${topPct}% + 2px)`,
            height: `calc(${heightPct}% - 4px)`,
            left: `calc(${leftPct}% + 2px)`,
            width: `calc(${widthPct}% - 4px)`
          },
          onClick: () => openOccurrenceDetailModal(occ)
        },
        el('div', { className: 'grid-block-name' }, occ.name),
        occ.location ? el('div', { className: 'grid-block-loc' }, `@${occ.location}`) : null,
        occ.teacher ? el('div', { className: 'grid-block-teacher' }, `师：${occ.teacher}`) : null,
        badges.length ? el('div', { className: 'grid-block-badges' }, ...badges) : null
      );
      eventsLayer.appendChild(block);
    }

    if (isTodayCol && nowPct !== null) {
      eventsLayer.appendChild(el('div', { className: 'now-line', style: { top: `${nowPct}%` } }));
    }

    col.appendChild(eventsLayer);
    body.appendChild(col);
  }

  gridWrap.appendChild(body);
  root.appendChild(gridWrap);

  if (state.data.practiceCourses && state.data.practiceCourses.length > 0) {
    const pcCard = el('div', { className: 'card stack' },
      el('div', { className: 'row-between' },
        el('strong', { style: { fontSize: '14px' } }, `集中实践 / 无固定节次课程（${state.data.practiceCourses.length}）`),
        el('span', { className: 'muted', style: { fontSize: '12px' } }, '不占用日常节次网格')
      ),
      ...state.data.practiceCourses.map((pc) =>
        el('div', { className: 'preview-item' },
          `${pc.name}${pc.teacher ? ` · ${pc.teacher}` : ''}${pc.weeksText ? ` · ${pc.weeksText}` : ''}`
        )
      )
    );
    root.appendChild(pcCard);
  }

  return root;
}

function openWeekPickerModal(selectedWeek, currentWeek, totalWeeks) {
  const grid = el('div', { className: 'week-picker-grid' });
  for (let w = 1; w <= totalWeeks; w += 1) {
    const cls = [
      'week-pick-btn',
      w === selectedWeek ? 'active' : '',
      w === currentWeek ? 'is-current' : ''
    ].filter(Boolean).join(' ');
    grid.appendChild(
      el('button', {
        type: 'button',
        className: cls,
        onClick: () => {
          state.selectedWeek = w;
          closeModal();
          render();
        }
      }, `第${w}周`)
    );
  }
  openModal('选择教学周', [
    el('div', { className: 'muted', style: { fontSize: '13px' } },
      `当前开学第一周周一为 ${state.data.term.startMonday}，共 ${totalWeeks} 周。`),
    grid
  ]);
}

// ── 视图 3：导入与传输视图 ──
function renderImportView() {
  const root = el('div', { className: 'stack' });
  const snapshot = loadSnapshot();
  const isIOS = isIOSDevice();
  const standalone = isRunningStandalone();

  if (isIOS && !standalone) {
    root.appendChild(
      el('div', { className: 'notice-box notice-warn' },
        el('strong', {}, 'iPhone 安装提示：'),
        'Safari 与主屏幕 Web App 使用独立存储。建议先在 HTTPS 地址下点底部「分享 → 添加到主屏幕」，从主屏幕打开并等顶部显示「已可离线使用」后，再在主屏幕 App 内用 JSON 文件或导入码导入课表。'
      )
    );
  } else {
    root.appendChild(
      el('div', { className: 'notice-box notice-info' },
        el('strong', {}, '统一导入流程：'),
        '所有导入方式都会按所选模式计算最终候选课表，并进入「解析 → 严格校验 → 纯文本预览 → 覆盖前保留完整快照 → 确认保存」。'
      )
    );
  }

  if (snapshot) {
    const savedTime = snapshot.savedAt ? snapshot.savedAt.replace('T', ' ').slice(0, 16) : '';
    root.appendChild(
      el('div', { className: 'card row-between' },
        el('div', {},
          el('strong', { style: { fontSize: '14px', display: 'block' } }, `上次覆盖前快照可用（${snapshot.data.courses.length} 门课 · ${snapshot.data.periods.length} 节作息）`),
          el('span', { className: 'muted', style: { fontSize: '12px' } }, `${snapshot.label} · ${savedTime}`)
        ),
        el('button', {
          type: 'button',
          className: 'btn btn-soft btn-sm',
          onClick: async () => {
            await persistData(snapshot.data, '已恢复到导入前快照', {
              snapshotBeforeOverwrite: { label: '撤回快照前的当前状态' }
            });
          }
        }, '撤回上次导入')
      )
    );
  }

  const grid = el('div', { className: 'two-col' });

  // 卡片 1：教务已渲染课表 HTML 导入
  const htmlTextarea = el('textarea', {
    className: 'code-area',
    placeholder: '粘贴学校教务「个人课表」已渲染后的 <table> HTML（支持正方新版 jwglxt 表格与通用已渲染表格）…'
  });

  const htmlFileInput = el('input', {
    type: 'file',
    accept: '.html,.htm,.txt',
    className: 'hidden',
    onChange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > LIMITS.MAX_HTML_BYTES) {
        showToast(`HTML 文件超过上限（最大 ${Math.round(LIMITS.MAX_HTML_BYTES / 1024 / 1024)} MB），请仅导出课表表格`, 4000);
        return;
      }
      const text = await file.text();
      htmlTextarea.value = text;
      handleHtmlImportPreview(text, `文件：${file.name}`);
    }
  });

  const extractorCode = getSameOriginExtractorSnippet();

  const htmlCard = el(
    'section',
    { className: 'card stack' },
    el('div', {},
      el('h3', { className: 'section-title' }, '1. 教务已渲染课表导入'),
      el('p', { className: 'muted', style: { margin: 0, fontSize: '13px' } },
        '支持正方新版 jwglxt 表格和通用已渲染 HTML 表格。粘贴的 HTML 在纯文本解析器中处理，不加载外部子资源、不执行脚本，预览仅渲染纯文本。')
    ),
    htmlTextarea,
    htmlFileInput,
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: () => handleHtmlImportPreview(htmlTextarea.value, '教务已渲染 HTML')
      }, '解析并预览'),
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: () => htmlFileInput.click()
      }, '选择 HTML 文件'),
      el('button', {
        type: 'button',
        className: 'btn btn-soft btn-sm',
        onClick: () => handleHtmlImportPreview(PUBLIC_DEMO_JWGLXT_HTML, '公开演示课表样例')
      }, '载入演示样例')
    ),
    el(
      'details',
      { className: 'disclosure' },
      el('summary', {}, '高级入口：同源表格提取脚本（附 Self-XSS 说明）'),
      el('div', { className: 'stack' },
        el('p', { className: 'muted', style: { margin: 0, fontSize: '12px', lineHeight: '1.5' } },
          '动态课表请勿「查看网页源代码」（常为空壳）。推荐在课表网格上右键「检查 → 选 table → Copy outerHTML」。若使用控制台脚本：仅可读取当前文档与同源 iframe，Chrome 首次粘贴会要求先输入 allow pasting 以防 Self-XSS。'),
        el('textarea', { className: 'code-area', readOnly: true, value: extractorCode, style: { minHeight: '90px' } }),
        el('div', { className: 'row' },
          el('button', {
            type: 'button',
            className: 'btn btn-xs',
            onClick: () => copyTextToClipboard(extractorCode, '已复制同源提取脚本')
          }, '复制提取脚本')
        )
      )
    )
  );
  grid.appendChild(htmlCard);

  // 卡片 2：JSON 完整备份与恢复
  const jsonFileInput = el('input', {
    type: 'file',
    accept: '.json,application/json',
    className: 'hidden',
    onChange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > LIMITS.MAX_JSON_BYTES) {
        showToast(`JSON 文件超过上限（最大 ${Math.round(LIMITS.MAX_JSON_BYTES / 1024 / 1024)} MB）`, 4000);
        return;
      }
      const text = await file.text();
      handleJsonBackupPreview(text, `JSON 备份：${file.name}`);
    }
  });

  const jsonCard = el(
    'section',
    { className: 'card stack' },
    el('div', {},
      el('h3', { className: 'section-title' }, '2. JSON 备份与恢复（推荐）'),
      el('p', { className: 'muted', style: { margin: 0, fontSize: '13px' } },
        '完整包含课程、单双周规则、调停课例外、作息时间和学期设置。导出采用紧凑 UTF-8 JSON 格式，在 iPhone 主屏幕 App 内恢复最稳定且不受链接长度限制。')
    ),
    jsonFileInput,
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: () => jsonFileInput.click()
      }, '选择 JSON 文件恢复'),
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: () => {
          const filename = `简课表备份_${state.data.term.startMonday}.json`;
          downloadTextFile(filename, JSON.stringify(state.data), 'application/json;charset=utf-8');
          showToast(`已导出 ${filename}`);
        }
      }, '导出完整 JSON 备份')
    ),
    el('div', { className: 'notice-box', style: { fontSize: '12px' } },
      `当前本地库（v${state.data.revision}）：${state.data.courses.length} 门课程 · ${state.data.overrides.length} 条调停课例外 · ${state.data.periods.length} 节作息。建议在更换域名、换手机或清理浏览器数据前导出一份备份。`
    )
  );
  grid.appendChild(jsonCard);

  // 卡片 3：发送课表 / 导入副本
  const transferInput = el('textarea', {
    className: 'code-area',
    placeholder: '粘贴电脑端生成的导入码（JKB1:...）或完整 #schedule=... 链接…',
    style: { minHeight: '78px' }
  });

  const transferStatsEl = el('div', { className: 'muted', style: { fontSize: '12px' } },
    state.lastTransferInfo
      ? `最近生成：${state.lastTransferInfo.encodedChars} 字符（${state.lastTransferInfo.compressed ? 'deflate-raw 压缩' : 'UTF-8'}）${state.lastTransferInfo.warnLongUrl ? ' · 长度偏长，建议改用导入码或 JSON 文件以防链接被截断' : ''}`
      : '生成导入码或快捷链接后可直接粘贴到另一台设备的「简课表查看」中恢复副本。'
  );

  const transferCard = el(
    'section',
    { className: 'card stack' },
    el('div', {},
      el('h3', { className: 'section-title' }, '3. 发送课表 / 导入副本'),
      el('div', { className: 'notice-box', style: { fontSize: '12px', marginTop: '6px' } },
        '隐私与渠道说明：快捷链接把版本化压缩课表存在 #schedule=… 片段中，常规网页请求不会把片段发送给托管服务器；但',
        el('strong', {}, '持有完整链接或导入码的人均可解码课表'),
        '，经微信等软件发送时，链接/文本本身会经过对应通信渠道。iPhone 主屏幕 App 内推荐使用「复制导入码」或「JSON 文件」。'
      )
    ),
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-soft btn-sm',
        onClick: async () => {
          const encoded = await encodeTransferCode(state.data);
          if (!encoded.ok) {
            openTransferLimitFallbackModal(encoded.error);
            return;
          }
          state.lastTransferInfo = encoded;
          await copyTextToClipboard(encoded.code, `已复制导入码（${encoded.encodedChars} 字符）`);
          render();
        }
      }, '复制导入码'),
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: async () => {
          const encoded = await encodeTransferCode(state.data);
          if (!encoded.ok) {
            openTransferLimitFallbackModal(encoded.error);
            return;
          }
          state.lastTransferInfo = encoded;
          const url = buildScheduleShareUrl(window.location.href, encoded.code);
          await copyTextToClipboard(url, encoded.warnLongUrl ? '已复制链接（偏长，若截断请用导入码或 JSON）' : '已复制 #schedule 快捷链接');
          render();
        }
      }, '复制快捷链接')
    ),
    transferStatsEl,
    transferInput,
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: async () => {
          const res = await decodeTransferCode(transferInput.value);
          if (!res.ok) {
            showToast(res.error, 4000);
            return;
          }
          const parsed = parseJsonBackup(res.raw);
          if (!parsed.ok) {
            showToast(parsed.error, 4000);
            return;
          }
          openImportPreviewModal(parsed, { title: '预览：导入课表副本' });
        }
      }, '解析导入码 / 链接')
    )
  );
  grid.appendChild(transferCard);

  // 卡片 4：.ics 系统日历导出
  const totalOccurrences = resolveAllTermOccurrences(state.data).length;
  const alarmSelect = el(
    'select',
    {
      style: { width: 'auto' },
      onChange: (e) => persistPrefs({ icsAlarmMinutes: Number(e.target.value) })
    },
    el('option', { value: '0', selected: state.prefs.icsAlarmMinutes === 0 }, '不添加课前提醒'),
    el('option', { value: '10', selected: state.prefs.icsAlarmMinutes === 10 }, '课前 10 分钟提醒'),
    el('option', { value: '15', selected: state.prefs.icsAlarmMinutes === 15 }, '课前 15 分钟提醒'),
    el('option', { value: '30', selected: state.prefs.icsAlarmMinutes === 30 }, '课前 30 分钟提醒')
  );

  const icsCard = el(
    'section',
    { className: 'card stack' },
    el('div', {},
      el('h3', { className: 'section-title' }, '4. 导出 .ics 系统日历'),
      el('p', { className: 'muted', style: { margin: 0, fontSize: '13px' } },
        `复用同一套实际课次引擎，将整学期展开为 ${totalOccurrences} 条独立日历事件（含稳定 UID、合规时区处理与可选 VALARM），单双周、停课、补课与换教室完整同步。`)
    ),
    el('div', { className: 'row' },
      alarmSelect,
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        disabled: totalOccurrences === 0,
        onClick: () => {
          const { content, eventCount } = exportScheduleToICS(state.data, {
            alarmMinutes: state.prefs.icsAlarmMinutes
          });
          const filename = `${state.data.term.name || '简课表'}.ics`;
          downloadTextFile(filename, content, 'text/calendar;charset=utf-8');
          showToast(`已导出 ${eventCount} 节实际课次到 .ics`);
        }
      }, '导出整学期 .ics')
    ),
    el('div', { className: 'notice-box', style: { fontSize: '12px' } },
      '提示：提醒由目标系统日历负责。Google Calendar 官方文件导入入口位于电脑端网页；iPhone 导入 .ics 后的打开路径与提醒效果请以真机核对为准。'
    )
  );
  grid.appendChild(icsCard);

  root.appendChild(grid);
  return root;
}

function handleHtmlImportPreview(htmlText, label) {
  const parsed = parseTimetableHtml(htmlText);
  if (!parsed.ok) {
    showToast(parsed.error, 4200);
    return;
  }
  openImportPreviewModal(parsed, { title: `导入预览 · ${label}` });
}

function handleJsonBackupPreview(jsonText, label) {
  const parsed = parseJsonBackup(jsonText);
  if (!parsed.ok) {
    showToast(parsed.error, 4200);
    return;
  }
  openImportPreviewModal(parsed, { title: `恢复预览 · ${label}` });
}

// ── 统一动态导入预览弹窗（随选项实时重算唯一 candidateData，预览 === 实际保存结果） ──
function openImportPreviewModal(parseResult, options = {}) {
  if (!parseResult?.ok) {
    showToast(parseResult?.error || '解析失败');
    return;
  }

  let mode = 'replace';
  let restoreSettings = parseResult.kind === 'backup';
  let expandPeriods = true;

  const renderPreviewModalContent = () => {
    const plan = buildImportPlan(state.data, parseResult, {
      mode,
      restoreSettings: mode === 'replace' ? restoreSettings : false,
      expandPeriodsIfNeeded: expandPeriods
    });

    if (!plan.ok) {
      showToast(plan.error || '预览构建失败');
      return;
    }

    const nodes = [];

    if (options.iosSafariWarning) {
      nodes.push(
        el('div', { className: 'notice-box notice-warn' },
          '检测到你正在 iPhone Safari 浏览器中打开链接。若已把「简课表查看」添加到主屏幕，此处的导入仅写入 Safari 存储；建议复制导入码并在主屏幕 App 内导入。'
        )
      );
    }

    if (plan.periodExpansionError) {
      nodes.push(
        el('div', { className: 'notice-box notice-warn stack', style: { gap: '8px' } },
          el('div', {}, plan.periodExpansionError),
          el('div', { className: 'row' },
            el('button', {
              type: 'button',
              className: 'btn btn-xs btn-primary',
              onClick: () => {
                closeModal();
                setTab('settings');
              }
            }, '去设置调整作息')
          )
        )
      );
    }

    const writtenCount = plan.writtenRuleCount ?? plan.accepted.length;

    nodes.push(
      el('div', { className: 'notice-box', style: { fontSize: '12px' } },
        `解析器：${plan.adapterLabel}`,
        plan.termName ? ` · 识别学期：${plan.termName}` : '',
        ` · 确认后库内：${plan.finalCourseCount} 门课 / ${plan.finalRuleCount} 个时段 / ${plan.finalOverridesCount} 条例外 / ${plan.candidateData.periods.length} 节作息`
      )
    );

    nodes.push(
      el('div', { className: 'preview-stats' },
        el('div', { className: 'stat-tile' },
          el('span', { className: 'stat-num', style: { color: writtenCount > 0 ? 'var(--success)' : 'inherit' } }, String(writtenCount)),
          el('span', { className: 'stat-lbl' }, `本次写入（${plan.incomingCourseCount}门）`)
        ),
        el('div', { className: 'stat-tile' },
          el('span', { className: 'stat-num' }, String(plan.duplicates.length)),
          el('span', { className: 'stat-lbl' }, '重复去重')
        ),
        el('div', { className: 'stat-tile' },
          el('span', { className: 'stat-num', style: { color: plan.conflicts.length ? 'var(--warning)' : 'inherit' } },
            plan.conflictsTruncated > 0 ? `${plan.conflicts.length}+` : String(plan.conflicts.length)),
          el('span', { className: 'stat-lbl' }, '时间冲突')
        ),
        el('div', { className: 'stat-tile' },
          el('span', { className: 'stat-num', style: { color: plan.unrecognized.length ? 'var(--danger)' : 'inherit' } }, String(plan.unrecognized.length)),
          el('span', { className: 'stat-lbl' }, '无法识别/跳过')
        )
      )
    );

    if (plan.conflicts.length > 0) {
      nodes.push(
        el('details', { className: 'disclosure', open: true },
          el('summary', {},
            `时间冲突明细（${plan.conflicts.length}${plan.conflictsTruncated > 0 ? `，另有 ${plan.conflictsTruncated} 条已折叠` : ''}）`
          ),
          el('div', { className: 'preview-list' },
            ...plan.conflicts.map((c) =>
              el('div', { className: 'preview-item' }, `${c.a} ↔ ${c.b} · ${c.detail}`)
            )
          )
        )
      );
    }

    if (plan.unrecognized.length > 0) {
      nodes.push(
        el('details', { className: 'disclosure', open: true },
          el('summary', {}, `无法识别 / 跳过项（${plan.unrecognized.length}）`),
          el('div', { className: 'preview-list' },
            ...plan.unrecognized.map((u) =>
              el('div', { className: 'preview-item' }, `${u.reason}：${u.raw}`)
            )
          )
        )
      );
    }

    if (plan.duplicates.length > 0) {
      nodes.push(
        el('details', { className: 'disclosure' },
          el('summary', {}, `重复已去重条目（${plan.duplicates.length}）`),
          el('div', { className: 'preview-list' },
            ...plan.duplicates.map((d) =>
              el('div', { className: 'preview-item' }, `${d.name} · ${d.summary}（${d.reason}）`)
            )
          )
        )
      );
    }

    nodes.push(
      el('details', { className: 'disclosure', open: true },
        el('summary', {}, `本次将写入的排课时段（${writtenCount} 条）`),
        el('div', { className: 'preview-list' },
          ...plan.accepted.map((item) =>
            el('div', { className: 'preview-item' },
              `${item.adjusted ? '【调】' : ''}${item.name} · ${DAY_NAMES[item.dayOfWeek]} 第${item.startPeriod}-${item.endPeriod}节 · ${formatWeeksExpression(item.weeks)}${item.location ? ` · ${item.location}` : ''}${item.teacher ? ` · ${item.teacher}` : ''}`
            )
          )
        )
      )
    );

    const modeSelect = el('select', {
      onChange: (e) => {
        mode = e.target.value;
        renderPreviewModalContent();
      }
    },
      el('option', { value: 'replace', selected: mode === 'replace' }, '覆盖当前课表（自动保存完整覆盖前快照，支持一键撤回）'),
      el('option', { value: 'merge', selected: mode === 'merge' }, '合并到当前课表（保留现有课程与例外，同时检测冲突）')
    );

    nodes.push(el('div', { className: 'field' }, el('label', {}, '写入方式'), modeSelect));

    if (parseResult.kind === 'backup' && mode === 'replace') {
      const chk = el('input', {
        type: 'checkbox',
        checked: restoreSettings,
        onChange: (e) => {
          restoreSettings = e.target.checked;
          renderPreviewModalContent();
        }
      });
      nodes.push(
        el('label', { className: 'row', style: { fontSize: '13px', cursor: 'pointer' } },
          chk,
          `同时恢复备份中的学期起始日、作息时间表与调停课例外（共 ${parseResult.overridesCount || 0} 条）`
        )
      );
    }

    if (plan.needsMorePeriods) {
      const chk = el('input', {
        type: 'checkbox',
        checked: expandPeriods,
        onChange: (e) => {
          expandPeriods = e.target.checked;
          renderPreviewModalContent();
        }
      });
      nodes.push(
        el('label', { className: 'row', style: { fontSize: '13px', cursor: 'pointer' } },
          chk,
          `检测到课表包含第 ${plan.maxPeriodNeeded} 节，自动将作息表从 ${state.data.periods.length} 节扩展至 ${plan.maxPeriodNeeded} 节`
        )
      );
    }

    const canCommit = Boolean(plan.canCommit) && !plan.periodExpansionError;

    const confirmBtn = el('button', {
      type: 'button',
      className: 'btn btn-primary',
      disabled: !canCommit,
      onClick: async () => {
        if (!canCommit) {
          showToast(plan.commitBlockedReason || '当前导入条件未满足', 4000);
          return;
        }
        const snapshotLabel = mode === 'replace'
          ? `覆盖导入前自动快照（${options.title || '导入'}）`
          : `合并导入前自动快照（${options.title || '导入'}）`;

        const mergePreservationValidator = mode === 'merge'
          ? (latestData, candidate) => {
            const pCheck = validatePeriodsSchedule(candidate.periods);
            if (!pCheck.ok) {
              return { ok: false, error: `合并后作息表无效（${pCheck.error}），已中止写入以保护原课表。` };
            }
            if (candidate.periods.length < latestData.periods.length) {
              return { ok: false, error: '合并后作息节数少于当前已存课表，已中止写入以保护原课表。' };
            }
            const nextKeys = new Set();
            for (const c of candidate.courses || []) {
              for (const r of c.schedules || []) nextKeys.add(`${c.id}::${r.ruleId}`);
            }
            for (const c of latestData.courses || []) {
              for (const r of c.schedules || []) {
                if (!nextKeys.has(`${c.id}::${r.ruleId}`)) {
                  return {
                    ok: false,
                    error: `合并前校验失败：原有课程「${c.name}」的排课时段未被完整保留，已中止此次合并。`
                  };
                }
              }
            }
            return { ok: true };
          }
          : null;

        const ok = await persistData(
          plan.candidateData,
          `导入完成：当前共 ${plan.candidateData.courses.length} 门课程`,
          {
            snapshotBeforeOverwrite: { label: snapshotLabel },
            beforeWriteValidate: mergePreservationValidator,
            onResolvedSuccess: () => {
              closeModal();
              setTab('week');
            }
          }
        );
        if (ok) {
          closeModal();
          setTab('week');
        }
      }
    }, '确认导入并保存');

    openModal(options.title || '导入预览', nodes, [
      el('button', { type: 'button', className: 'btn', onClick: closeModal }, '取消'),
      confirmBtn
    ]);
  };

  renderPreviewModalContent();
}

// ── 视图 4：设置视图 ──
function renderSettingsView() {
  const root = el('div', { className: 'stack' });
  const s = state.offlineStatus;

  const privacyNotice = el(
    'div',
    { className: 'notice-box notice-success', style: { fontSize: '13.5px', fontWeight: '600', lineHeight: '1.6' } },
    '本软件不收集用户任何私人信息，可放心使用。如果不放心可以以断网状态打开'
  );
  root.appendChild(privacyNotice);

  const offlineCard = el(
    'section',
    { className: 'card stack' },
    el('div', { className: 'row-between' },
      el('div', {},
        el('h3', { className: 'section-title' }, '离线运行与安装状态'),
        el('div', { className: 'muted', style: { fontSize: '13px' } }, s.detail)
      ),
      el('span', { className: `status-pill ${s.ready ? 'status-ready' : 'status-online'}` },
        s.ready ? `已可离线使用 ${s.version}` : '未就绪')
    ),
    el('div', { className: 'notice-box', style: { fontSize: '12px' } },
      'iPhone 离线验收步骤：① 用手机信任的 HTTPS 地址在 Safari 打开 → ② 点「分享 → 添加到主屏幕」→ ③ 从主屏幕图标打开并联网等待上方变为「已可离线使用」→ ④ 在主屏幕 App 内导入课表 → ⑤ 开飞行模式杀后台重开验证。'
    ),
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: async () => {
          if (state.swRegistration) {
            await state.swRegistration.update().catch(() => {});
          }
          await refreshOfflineStatus();
          showToast('已刷新离线缓存状态');
        }
      }, '检查更新与缓存状态')
    )
  );
  root.appendChild(offlineCard);

  const grid = el('div', { className: 'two-col' });

  // 学期设置
  const termNameInput = el('input', { type: 'text', value: state.data.term.name });
  const startMonInput = el('input', { type: 'date', value: state.data.term.startMonday });
  const totalWeeksInput = el('input', { type: 'number', min: 1, max: LIMITS.MAX_TOTAL_WEEKS, value: String(state.data.term.totalWeeks) });
  const tzInput = el('input', { type: 'text', value: state.data.term.timezone });
  const nextTermInput = el('input', { type: 'date', value: state.data.term.nextTermStartDate || '' });

  const termCard = el(
    'section',
    { className: 'card stack' },
    el('h3', { className: 'section-title' }, '学期与周次设置'),
    el('div', { className: 'field' }, el('label', {}, '学期名称'), termNameInput),
    el('div', { className: 'form-grid form-grid-date-weeks' },
      el('div', { className: 'field' }, el('label', {}, '第 1 周周一日期（自动对齐至周一）'), startMonInput),
      el('div', { className: 'field' }, el('label', {}, '总周数'), totalWeeksInput)
    ),
    el('div', { className: 'form-grid' },
      el('div', { className: 'field' }, el('label', {}, '学校时区（合法 IANA 标识，如 Asia/Shanghai）'), tzInput),
      el('div', { className: 'field' }, el('label', {}, '下学期开学日（可选，本学期结束后显示倒计时）'), nextTermInput)
    ),
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: async () => {
          if (!isValidDateStr(startMonInput.value)) {
            showToast('请填写合法的开学日期');
            return;
          }
          const tzVal = tzInput.value.trim();
          if (!isValidIanaTimezone(tzVal)) {
            showToast('学校时区无效，请填写标准 IANA 时区（例如 Asia/Shanghai、America/New_York）', 4000);
            return;
          }
          if (nextTermInput.value && !isValidDateStr(nextTermInput.value)) {
            showToast('下学期开学日期格式无效');
            return;
          }
          const aligned = getMondayOfDate(startMonInput.value);
          const nextTerm = {
            name: termNameInput.value.trim() || state.data.term.name,
            startMonday: aligned,
            totalWeeks: Math.max(1, Math.min(LIMITS.MAX_TOTAL_WEEKS, Number(totalWeeksInput.value) || 20)),
            timezone: tzVal,
            nextTermStartDate: nextTermInput.value || ''
          };
          const next = structuredClone(state.data);
          next.term = nextTerm;
          const ok = await persistData(
            next,
            aligned !== startMonInput.value ? `已保存（起始日自动对齐至周一 ${aligned}）` : '学期设置已保存',
            {
              mergeLabel: '仅把学期设置合并到最新版',
              mergeWithLatest: (latest) => ({ ...latest, term: nextTerm })
            }
          );
          if (ok) {
            state.selectedWeek = getTermStatus(state.data, getTodayInTimezone(state.data.term.timezone)).currentWeek;
            render();
          }
        }
      }, '保存学期设置')
    )
  );
  grid.appendChild(termCard);

  // 界面偏好与数据安全
  const themeSelect = el('select', { onChange: (e) => persistPrefs({ theme: e.target.value }) },
    el('option', { value: 'system', selected: state.prefs.theme === 'system' }, '跟随系统'),
    el('option', { value: 'light', selected: state.prefs.theme === 'light' }, '浅色模式'),
    el('option', { value: 'dark', selected: state.prefs.theme === 'dark' }, '深色模式')
  );
  const defaultTabSelect = el('select', { onChange: (e) => persistPrefs({ defaultTab: e.target.value }) },
    el('option', { value: 'today', selected: state.prefs.defaultTab === 'today' }, '今日视图（推荐）'),
    el('option', { value: 'week', selected: state.prefs.defaultTab === 'week' }, '周课表视图')
  );
  const weekendSelect = el('select', { onChange: (e) => persistPrefs({ showWeekend: e.target.value }) },
    el('option', { value: 'auto', selected: state.prefs.showWeekend === 'auto' }, '自动（周末有课时显示）'),
    el('option', { value: 'always', selected: state.prefs.showWeekend === 'always' }, '始终显示 7 天'),
    el('option', { value: 'never', selected: state.prefs.showWeekend === 'never' }, '仅显示周一至周五')
  );

  const manualLegacyCand = detectLegacyMigrationCandidate({ includeDismissed: true });

  const userNameInput = el('input', {
    type: 'text',
    value: state.prefs.userName || '',
    placeholder: '例如：小明（留空则不显示问候语）',
    maxLength: 24,
    'aria-label': '我的称呼'
  });
  const saveUserName = () => {
    const trimmed = userNameInput.value.trim();
    persistPrefs({ userName: trimmed, namePromptDone: true });
    showToast(trimmed ? `已保存称呼：${trimmed}` : '已清空称呼');
  };
  userNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveUserName();
    }
  });

  const prefCard = el(
    'section',
    { className: 'card stack' },
    el('h3', { className: 'section-title' }, '显示偏好与数据管理'),
    el('div', { className: 'field' },
      el('label', {}, '我的称呼（显示在「今日」界面最上方）'),
      el('div', { className: 'row' },
        userNameInput,
        el('button', {
          type: 'button',
          className: 'btn btn-primary btn-sm',
          onClick: saveUserName
        }, '保存称呼')
      )
    ),
    el('div', { className: 'field' }, el('label', {}, '主题外观'), themeSelect),
    el('div', { className: 'field' }, el('label', {}, '默认首页'), defaultTabSelect),
    el('div', { className: 'field' }, el('label', {}, '周课表周末列'), weekendSelect),
    manualLegacyCand
      ? el('div', { className: 'notice-box notice-info stack', style: { gap: '8px', fontSize: '12.5px' } },
        el('div', {}, `检测到可从旧版路径恢复的未迁移项：${describeLegacyCandidateItems(manualLegacyCand)}（旧原件不会被删除）。`),
        el('div', { className: 'row' },
          el('button', {
            type: 'button',
            className: 'btn btn-soft btn-xs',
            onClick: () => runLegacyMigrationAction()
          }, '手动恢复旧版数据 / 快照'),
          manualLegacyCand.data
            ? el('button', {
              type: 'button',
              className: 'btn btn-xs',
              onClick: () => {
                const parsed = parseJsonBackup(manualLegacyCand.data);
                if (parsed.ok) openImportPreviewModal(parsed, { title: '预览：旧版存储中的课表' });
              }
            }, '预览旧版主课表')
            : null
        )
      )
      : null,
    el('div', { className: 'row', style: { marginTop: '6px' } },
      el('button', {
        type: 'button',
        className: 'btn btn-danger btn-sm',
        onClick: () => {
          openModal('确认清空全部课程？', [
            el('p', { style: { margin: 0, fontSize: '14px' } }, '清空前会自动为您保存一份完整快照，可在「导入与传输」页一键恢复。')
          ], [
            el('button', { type: 'button', className: 'btn', onClick: closeModal }, '取消'),
            el('button', {
              type: 'button',
              className: 'btn btn-danger',
              onClick: async () => {
                const next = createDefaultData();
                next.term = { ...state.data.term };
                next.periods = structuredClone(state.data.periods);
                const ok = await persistData(next, '已清空全部课程（已自动保留快照）', {
                  snapshotBeforeOverwrite: { label: '清空课程前自动快照' },
                  onResolvedSuccess: closeModal
                });
                if (ok) closeModal();
              }
            }, '确认清空')
          ]);
        }
      }, '清空全部课程')
    )
  );
  grid.appendChild(prefCard);
  root.appendChild(grid);

  // 可增减作息时间表编辑器
  const draftPeriods = state.data.periods.map((p) => ({ ...p }));
  const periodListEl = el('div', { className: 'period-editor-list' });

  const renderPeriodRows = () => {
    periodListEl.replaceChildren();
    draftPeriods.forEach((p, idx) => {
      const startInput = el('input', {
        type: 'time',
        value: p.start,
        onChange: (e) => { draftPeriods[idx].start = e.target.value; }
      });
      const endInput = el('input', {
        type: 'time',
        value: p.end,
        onChange: (e) => { draftPeriods[idx].end = e.target.value; }
      });
      periodListEl.appendChild(
        el('div', { className: 'period-editor-row tabular' },
          el('strong', {}, `第 ${idx + 1} 节`),
          startInput,
          el('span', { className: 'muted', style: { textAlign: 'center' } }, '–'),
          endInput
        )
      );
    });
  };
  renderPeriodRows();

  const periodsCard = el(
    'section',
    { className: 'card stack' },
    el('div', { className: 'row-between' },
      el('div', {},
        el('h3', { className: 'section-title' }, `作息时间表（当前 ${state.data.periods.length} 节，可自由增减）`),
        el('p', { className: 'muted', style: { margin: 0, fontSize: '12px' } }, '每节结束时间须晚于开始时间，且相邻节次不可交叉或倒序。')
      ),
      el('div', { className: 'row' },
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          onClick: () => {
            const affected = findAffectedByPeriodLimit(state.data, 13);
            if (affected.length > 0) {
              openPeriodAffectedDialog(affected, 13, state.data);
              return;
            }
            const tpl = clonePeriodsTemplate('zjiet-13');
            draftPeriods.splice(0, draftPeriods.length, ...tpl);
            renderPeriodRows();
            showToast('已载入 13 节参考模板（点击保存生效）');
          }
        }, '13节模板'),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          onClick: () => {
            const affected = findAffectedByPeriodLimit(state.data, 12);
            if (affected.length > 0) {
              openPeriodAffectedDialog(affected, 12, state.data);
              return;
            }
            const tpl = clonePeriodsTemplate('standard-12');
            draftPeriods.splice(0, draftPeriods.length, ...tpl);
            renderPeriodRows();
            showToast('已载入通用 12 节参考模板（点击保存生效）');
          }
        }, '12节模板')
      )
    ),
    el('div', { className: 'notice-box notice-info row-between tabular', style: { padding: '8px 12px', fontSize: '12.5px' } },
      el('strong', {}, '早自习（第 1 节有课时）'),
      el('span', { className: 'muted' }, '08:00 – 08:15（不占用正课编号）')
    ),
    periodListEl,
    el('div', { className: 'row-between' },
      el('div', { className: 'row' },
        el('button', {
          type: 'button',
          className: 'btn btn-xs btn-soft',
          onClick: () => {
            if (draftPeriods.length >= LIMITS.MAX_PERIODS) return showToast(`最多支持 ${LIMITS.MAX_PERIODS} 节课`);
            const last = draftPeriods[draftPeriods.length - 1];
            const prevEnd = last ? timeToMinutes(last.end) : 7 * 60 + 50;
            const startMin = prevEnd + 5;
            if (startMin >= 23 * 60 + 55) {
              return showToast('当前末节结束时间已接近 23:59，请先调早前面节次后再新增末节', 3600);
            }
            const endMin = Math.min(23 * 60 + 59, startMin + 45);
            draftPeriods.push({
              index: draftPeriods.length + 1,
              start: minutesToTime(startMin),
              end: minutesToTime(endMin)
            });
            renderPeriodRows();
          }
        }, '+ 新增末节'),
        el('button', {
          type: 'button',
          className: 'btn btn-xs',
          onClick: () => {
            if (draftPeriods.length <= LIMITS.MIN_PERIODS) return showToast(`至少保留 ${LIMITS.MIN_PERIODS} 节作息`);
            const removingIndex = draftPeriods.length;
            const refs = findReferencesToPeriod(state.data, removingIndex);
            if (refs.length > 0) {
              showToast(`第 ${removingIndex} 节正被「${refs[0]}」引用，请先调整该课节次`, 3600);
              return;
            }
            draftPeriods.pop();
            renderPeriodRows();
          }
        }, '- 删除末节')
      ),
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: async () => {
          const check = validatePeriodsSchedule(draftPeriods);
          if (!check.ok) {
            showToast(check.error, 4000);
            return;
          }
          const nextPeriods = draftPeriods.map((p, idx) => ({ index: idx + 1, start: p.start, end: p.end }));
          const next = structuredClone(state.data);
          next.periods = nextPeriods;

          // 所有作息最终保存入口（含多标签页合并）统一在锁内针对最新课表校验是否会删掉超界排课
          const validatePeriodsAgainstLatest = (latestData, candidateData) => {
            const targetLen = candidateData.periods.length;
            const affected = findAffectedByPeriodLimit(latestData, targetLen);
            if (affected.length > 0) {
              return {
                ok: false,
                error: `当前有 ${affected.length} 项课程或例外超过第 ${targetLen} 节，无法缩短作息表`,
                details: { affectedPeriods: affected, targetPeriodCount: targetLen }
              };
            }
            return { ok: true };
          };

          await persistData(next, '作息时间表已保存', {
            beforeWriteValidate: validatePeriodsAgainstLatest,
            mergeLabel: '仅把作息时间表合并到最新版',
            mergeWithLatest: (latest) => ({ ...latest, periods: nextPeriods })
          });
        }
      }, '保存作息表')
    )
  );
  root.appendChild(periodsCard);

  const extraGrid = el('div', { className: 'two-col' });

  // 意见栏
  const feedbackEmail = '326745834@qq.com';
  const feedbackTextarea = el('textarea', {
    rows: 3,
    placeholder: '欢迎写下你的使用建议、问题反馈或功能许愿…',
    'aria-label': '意见反馈内容'
  });

  const feedbackCard = el(
    'section',
    { className: 'card stack' },
    el('h3', { className: 'section-title' }, '意见栏'),
    el('p', { className: 'muted', style: { margin: 0, fontSize: '13px', lineHeight: '1.6' } },
      '如果你在使用过程中遇到问题或有任何建议，欢迎通过邮件联系作者：'),
    el('div', { className: 'notice-box notice-info row-between', style: { padding: '8px 12px', fontSize: '13px' } },
      el('strong', { className: 'tabular' }, feedbackEmail),
      el('button', {
        type: 'button',
        className: 'btn btn-xs btn-soft',
        onClick: () => copyTextToClipboard(feedbackEmail, `已复制邮箱：${feedbackEmail}`)
      }, '复制邮箱')
    ),
    el('div', { className: 'field' },
      el('label', {}, '意见或建议内容'),
      feedbackTextarea
    ),
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: () => {
          const content = feedbackTextarea.value.trim();
          const subject = encodeURIComponent('简课表查看 - 意见反馈');
          const body = encodeURIComponent(content || '你好，我想反馈以下意见或建议：\n\n');
          window.location.href = `mailto:${feedbackEmail}?subject=${subject}&body=${body}`;
        }
      }, '发送邮件反馈'),
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: () => {
          const content = feedbackTextarea.value.trim();
          if (!content) {
            copyTextToClipboard(feedbackEmail, `已复制邮箱：${feedbackEmail}`);
            return;
          }
          copyTextToClipboard(`收件邮箱：${feedbackEmail}\n反馈内容：\n${content}`, '已复制邮箱与反馈内容');
        }
      }, '复制反馈内容')
    )
  );
  extraGrid.appendChild(feedbackCard);

  // 致谢与使用人数统计（不蒜子国内直连匿名统计）
  const cachedCount = state.prefs.cachedTotalUsers;
  let statsMainText = '';
  if (typeof cachedCount === 'number') {
    statsMainText = `累计使用人数：${cachedCount} 人`;
  } else if (statsRuntime.loading) {
    statsMainText = '正在同步使用人数…';
  } else {
    statsMainText = '暂未获取到统计数据（联网后自动更新，断网时展示本地缓存）';
  }

  const aboutCard = el(
    'section',
    { className: 'card stack' },
    el('h3', { className: 'section-title' }, '致谢与使用人数统计'),
    el('div', { className: 'stack', style: { gap: '8px', fontSize: '13px', lineHeight: '1.6' } },
      el('div', { className: 'notice-box', style: { padding: '10px 12px' } },
        el('strong', { style: { display: 'block', marginBottom: '4px' } }, '致谢'),
        el('span', { className: 'muted' }, '感谢 Antigravity、GPT 与 DeepSeek 在本项目构思、开发与优化过程中提供的协助，也感谢每一位使用与支持「简课表查看」的同学与朋友。')
      ),
      el('div', { className: 'notice-box stack', style: { padding: '10px 12px', gap: '6px' } },
        el('div', { className: 'row-between' },
          el('strong', {}, '使用人数统计'),
          el('button', {
            type: 'button',
            className: 'btn btn-xs btn-soft',
            disabled: statsRuntime.loading,
            onClick: () => syncUsageStats({ manual: true })
          }, statsRuntime.loading ? '同步中…' : '刷新统计')
        ),
        el('div', { className: typeof cachedCount === 'number' ? 'tabular' : 'muted', style: typeof cachedCount === 'number' ? { fontSize: '16px', fontWeight: '700' } : {} }, statsMainText),
        el('div', { className: 'muted', style: { fontSize: '12px' } },
          '隐私保护：仅匿名统计累计访客数，不上传姓名、课表或任何私人信息；断网模式下不发任何网络请求。')
      )
    )
  );
  extraGrid.appendChild(aboutCard);
  root.appendChild(extraGrid);

  return root;
}

// ── 课程详情与「仅此一次 / 整组课程」编辑弹窗 ──
function openOccurrenceDetailModal(occ) {
  const course = state.data.courses.find((c) => c.id === occ.courseId) || null;
  const infoLines = [
    ['日期与周次', `${occ.date}（${DAY_NAMES_FULL[occ.dayOfWeek]}）· ${occ.week > 0 ? `第 ${occ.week} 周` : '学期外'}`],
    ['节次与时间', `第 ${occ.startPeriod}-${occ.endPeriod} 节 · ${occ.startTime} - ${occ.endTime}`],
    ['上课地点', occ.location || '未填写'],
    ['任课教师', occ.teacher || '未填写'],
    ['周次规则', occ.weeksText || '—']
  ];
  if (occ.courseType) infoLines.push(['课程类型', occ.courseType]);
  if (occ.meta?.examType) infoLines.push(['考核与学分', `${occ.meta.examType}${occ.meta.credits ? ` · ${occ.meta.credits} 学分` : ''}`]);
  if (occ.note) infoLines.push(['备注', occ.note]);

  const detailList = el('div', { className: 'stack', style: { gap: '8px' } },
    ...infoLines.map(([k, v]) =>
      el('div', { className: 'row-between', style: { fontSize: '14px', borderBottom: '1px solid var(--border)', paddingBottom: '7px' } },
        el('span', { className: 'muted' }, k),
        el('strong', { style: { textAlign: 'right' } }, v)
      )
    )
  );

  const singleBtnRow = [
    el('button', {
      type: 'button',
      className: 'btn btn-sm btn-soft',
      onClick: () => openSingleEditModal(occ)
    }, '临时改教室 / 调时间')
  ];

  if (occ.source === 'added' && occ.transferGroupId) {
    singleBtnRow.push(
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: async () => {
          const next = applySingleOccurrenceEdit(state.data, occ, 'restore');
          const ok = await persistData(next, '已撤回调课并恢复原日期排课', { onResolvedSuccess: closeModal });
          if (ok) closeModal();
        }
      }, '撤回调课（恢复原日期）')
    );
  }

  singleBtnRow.push(
    el('button', {
      type: 'button',
      className: 'btn btn-sm btn-danger',
      onClick: async () => {
        const next = applySingleOccurrenceEdit(state.data, occ, 'cancel', { reason: '手动停课' });
        const msg = occ.source === 'added' ? '已删除该次课程' : `已停掉 ${occ.date} 的 ${occ.name}`;
        const ok = await persistData(next, msg, { onResolvedSuccess: closeModal });
        if (ok) closeModal();
      }
    }, occ.source === 'added' ? '仅删除本次课' : '仅本次停课')
  );

  if (occ.source === 'modified') {
    singleBtnRow.push(
      el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: async () => {
          const next = applySingleOccurrenceEdit(state.data, occ, 'restore');
          const ok = await persistData(next, '已恢复为原排课', { onResolvedSuccess: closeModal });
          if (ok) closeModal();
        }
      }, '恢复原排课')
    );
  }

  const singleActions = el('div', { className: 'rule-box' },
    el('strong', { style: { fontSize: '13px' } }, `仅此一次（只影响 ${occ.date} 这一天）`),
    el('div', { className: 'row' }, ...singleBtnRow)
  );

  const groupActions = course
    ? el('div', { className: 'rule-box' },
      el('strong', { style: { fontSize: '13px' } }, `整组课程（共 ${course.schedules.length} 个固定时段，影响所有周）`),
      el('div', { className: 'row' },
        el('button', {
          type: 'button',
          className: 'btn btn-sm',
          onClick: () => openCourseGroupModal(course)
        }, '编辑整组课程'),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-danger',
          onClick: async () => {
            const next = deleteCourseGroup(state.data, course.id);
            const ok = await persistData(next, `已删除整门课程：${course.name}`, { onResolvedSuccess: closeModal });
            if (ok) closeModal();
          }
        }, '删除整门课程')
      )
    )
    : null;

  const footer = [
    occ.location
      ? el('button', {
        type: 'button',
        className: 'btn btn-sm',
        onClick: () => copyTextToClipboard(occ.location, `已复制教室：${occ.location}`)
      }, '复制教室')
      : null,
    el('button', { type: 'button', className: 'btn btn-primary btn-sm', onClick: closeModal }, '知道了')
  ].filter(Boolean);

  openModal(occ.name, [detailList, singleActions, groupActions].filter(Boolean), footer);
}

function openSingleEditModal(occ) {
  const maxP = state.data.periods.length;
  const dateInput = el('input', { type: 'date', value: occ.date });
  const startInput = el('input', { type: 'number', min: 1, max: maxP, value: String(occ.startPeriod) });
  const endInput = el('input', { type: 'number', min: 1, max: maxP, value: String(occ.endPeriod) });
  const locInput = el('input', { type: 'text', value: occ.location || '', placeholder: '例如 博雅楼201' });
  const teacherInput = el('input', { type: 'text', value: occ.teacher || '' });
  const noteInput = el('input', { type: 'text', value: occ.note || '', placeholder: '例如 临时换教室 / 调休补课' });

  openModal(`仅此一次调整 · ${occ.name}`, [
    el('div', { className: 'notice-box', style: { fontSize: '12px' } },
      '本次修改仅作用于当前日期；若改到另一天，原日期与目标日期会通过调课标识成对关联，后续恢复原日期时会自动成对清理。'
    ),
    el('div', { className: 'field' }, el('label', {}, '上课日期'), dateInput),
    el('div', { className: 'row' },
      el('div', { className: 'field' }, el('label', {}, '开始节次'), startInput),
      el('div', { className: 'field' }, el('label', {}, '结束节次'), endInput)
    ),
    el('div', { className: 'field' }, el('label', {}, '上课地点'), locInput),
    el('div', { className: 'field' }, el('label', {}, '任课教师'), teacherInput),
    el('div', { className: 'field' }, el('label', {}, '单次备注'), noteInput)
  ], [
    el('button', { type: 'button', className: 'btn', onClick: closeModal }, '取消'),
    el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: async () => {
        if (!isValidDateStr(dateInput.value)) return showToast('请选择合法日期');
        const sp = Math.max(1, Math.min(maxP, Number(startInput.value) || occ.startPeriod));
        const ep = Math.max(sp, Math.min(maxP, Number(endInput.value) || sp));
        const next = applySingleOccurrenceEdit(state.data, occ, 'modify', {
          date: dateInput.value,
          startPeriod: sp,
          endPeriod: ep,
          location: locInput.value,
          teacher: teacherInput.value,
          note: noteInput.value
        });
        const ok = await persistData(next, '已保存本次课程调整', { onResolvedSuccess: closeModal });
        if (ok) closeModal();
      }
    }, '保存本次调整')
  ]);
}

function openCourseGroupModal(existingCourse = null) {
  const isEdit = Boolean(existingCourse);
  const maxP = state.data.periods.length;
  const maxW = state.data.term.totalWeeks;

  const nameInput = el('input', { type: 'text', value: existingCourse?.name || '', placeholder: '例如 高等数学' });
  const teacherInput = el('input', { type: 'text', value: existingCourse?.teacher || '', placeholder: '默认教师（可按时段覆盖）' });
  const locInput = el('input', { type: 'text', value: existingCourse?.location || '', placeholder: '默认教室（可按时段覆盖）' });
  const noteInput = el('input', { type: 'text', value: existingCourse?.note || '', placeholder: '课程备注（可选）' });

  const draftRules = existingCourse?.schedules?.length
    ? existingCourse.schedules.map((r) => ({
      ...r,
      weeksExpr: formatWeeksExpression(r.weeks)
    }))
    : [{
      ruleId: generateUniqueRuleId([]),
      dayOfWeek: 1,
      startPeriod: 1,
      endPeriod: 2,
      weeksExpr: `1-${Math.min(16, maxW)}周`,
      location: '',
      teacher: '',
      note: '',
      adjusted: false,
      courseType: ''
    }];

  const rulesContainer = el('div', { className: 'stack' });

  const renderRules = () => {
    rulesContainer.replaceChildren();
    draftRules.forEach((rule, idx) => {
      const daySel = el('select', { onChange: (e) => { draftRules[idx].dayOfWeek = Number(e.target.value); } },
        ...[1, 2, 3, 4, 5, 6, 7].map((d) =>
          el('option', { value: String(d), selected: rule.dayOfWeek === d }, DAY_NAMES_FULL[d])
        )
      );
      const spInput = el('input', {
        type: 'number', min: 1, max: maxP, value: String(rule.startPeriod),
        onChange: (e) => { draftRules[idx].startPeriod = Number(e.target.value); }
      });
      const epInput = el('input', {
        type: 'number', min: 1, max: maxP, value: String(rule.endPeriod),
        onChange: (e) => { draftRules[idx].endPeriod = Number(e.target.value); }
      });
      const weeksInput = el('input', {
        type: 'text', value: rule.weeksExpr, placeholder: '如 5-16周 / 5-17周(单) / 1-8,10-16周',
        onChange: (e) => { draftRules[idx].weeksExpr = e.target.value; }
      });
      const rLocInput = el('input', {
        type: 'text', value: rule.location || '', placeholder: '本时段教室（留空沿用默认）',
        onChange: (e) => { draftRules[idx].location = e.target.value; }
      });
      const rTeacherInput = el('input', {
        type: 'text', value: rule.teacher || '', placeholder: '本时段教师（留空沿用默认）',
        onChange: (e) => { draftRules[idx].teacher = e.target.value; }
      });

      rulesContainer.appendChild(
        el('div', { className: 'rule-box' },
          el('div', { className: 'row-between' },
            el('strong', { style: { fontSize: '13px' } }, `排课时段 #${idx + 1}`),
            draftRules.length > 1
              ? el('button', {
                type: 'button',
                className: 'btn btn-xs btn-danger',
                onClick: () => { draftRules.splice(idx, 1); renderRules(); }
              }, '移除')
              : null
          ),
          el('div', { className: 'row' },
            el('div', { className: 'field' }, el('label', {}, '星期'), daySel),
            el('div', { className: 'field', style: { maxWidth: '90px' } }, el('label', {}, '开始节'), spInput),
            el('div', { className: 'field', style: { maxWidth: '90px' } }, el('label', {}, '结束节'), epInput)
          ),
          el('div', { className: 'field' }, el('label', {}, '周次（支持单双周与逗号组合）'), weeksInput),
          el('div', { className: 'row' },
            el('div', { className: 'field' }, el('label', {}, '时段教室'), rLocInput),
            el('div', { className: 'field' }, el('label', {}, '时段教师'), rTeacherInput)
          )
        )
      );
    });
  };
  renderRules();

  openModal(isEdit ? `编辑整组课程 · ${existingCourse.name}` : '新增周期课程', [
    el('div', { className: 'field' }, el('label', {}, '课程名称 *'), nameInput),
    el('div', { className: 'row' },
      el('div', { className: 'field' }, el('label', {}, '默认教师'), teacherInput),
      el('div', { className: 'field' }, el('label', {}, '默认教室'), locInput)
    ),
    el('div', { className: 'field' }, el('label', {}, '课程备注'), noteInput),
    rulesContainer,
    el('button', {
      type: 'button',
      className: 'btn btn-soft btn-sm',
      onClick: () => {
        const usedIds = [
          ...draftRules.map((r) => r.ruleId),
          ...(existingCourse?.schedules || []).map((r) => r.ruleId)
        ];
        draftRules.push({
          ruleId: generateUniqueRuleId(usedIds),
          dayOfWeek: 3,
          startPeriod: 1,
          endPeriod: 2,
          weeksExpr: `1-${Math.min(16, maxW)}周`,
          location: '',
          teacher: '',
          note: '',
          adjusted: false,
          courseType: ''
        });
        renderRules();
      }
    }, '+ 再添加一个上课时间段')
  ], [
    el('button', { type: 'button', className: 'btn', onClick: closeModal }, '取消'),
    el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: async () => {
        const name = nameInput.value.trim();
        if (!name) return showToast('请输入课程名称');

        const parsedRules = [];
        for (let i = 0; i < draftRules.length; i += 1) {
          const r = draftRules[i];
          const weeks = parseWeeksExpression(r.weeksExpr, Math.max(maxW, LIMITS.MAX_TOTAL_WEEKS));
          if (weeks.length === 0) {
            return showToast(`时段 #${i + 1} 的周次表达式无法解析（示例：5-16周 或 5-17周(单)）`);
          }
          const sp = Math.max(1, Math.min(maxP, Number(r.startPeriod) || 1));
          const ep = Math.max(sp, Math.min(maxP, Number(r.endPeriod) || sp));
          parsedRules.push({
            ruleId: r.ruleId || generateUniqueRuleId(parsedRules.map((x) => x.ruleId)),
            dayOfWeek: r.dayOfWeek,
            startPeriod: sp,
            endPeriod: ep,
            weeks,
            location: r.location,
            teacher: r.teacher,
            note: r.note || '',
            adjusted: Boolean(r.adjusted),
            courseType: r.courseType || ''
          });
        }

        const next = upsertCourseGroup(state.data, {
          id: existingCourse?.id,
          name,
          teacher: teacherInput.value,
          location: locInput.value,
          note: noteInput.value,
          meta: existingCourse?.meta || {},
          schedules: parsedRules
        });
        const ok = await persistData(next, isEdit ? '整组课程已更新' : `已添加课程：${name}`, {
          onResolvedSuccess: closeModal
        });
        if (ok) closeModal();
      }
    }, isEdit ? '保存整组修改' : '保存课程')
  ]);
}

function openAddCourseModal(initialMode = 'group', defaultDate = '') {
  if (initialMode === 'group') {
    const switchBtn = el('button', {
      type: 'button',
      className: 'btn btn-soft btn-xs',
      onClick: () => openAddCourseModal('once', defaultDate)
    }, '切换到「单次补课 / 临时课」→');

    openCourseGroupModal(null);
    const modalBody = modalOverlay.querySelector('.modal-body');
    if (modalBody) modalBody.prepend(el('div', { className: 'row-between' }, el('span', { className: 'muted', style: { fontSize: '12px' } }, '按周循环排课'), switchBtn));
    return;
  }

  const maxP = state.data.periods.length;
  const dateStr = isValidDateStr(defaultDate) ? defaultDate : getTodayInTimezone(state.data.term.timezone);
  const nameInput = el('input', { type: 'text', placeholder: '输入课程名（若与已有课同名将自动沿用同色卡）' });
  const dateInput = el('input', { type: 'date', value: dateStr });
  const spInput = el('input', { type: 'number', min: 1, max: maxP, value: '1' });
  const epInput = el('input', { type: 'number', min: 1, max: maxP, value: '2' });
  const locInput = el('input', { type: 'text', placeholder: '例如 明理楼201' });
  const teacherInput = el('input', { type: 'text', placeholder: '任课教师（可选）' });
  const noteInput = el('input', { type: 'text', placeholder: '例如 调休补周一课' });

  openModal('添加单次补课 / 临时课程', [
    el('div', { className: 'row-between' },
      el('span', { className: 'muted', style: { fontSize: '12px' } }, '仅写入指定日期，不影响其他周'),
      el('button', {
        type: 'button',
        className: 'btn btn-soft btn-xs',
        onClick: () => openAddCourseModal('group', dateStr)
      }, '← 切换到「新增周期课程」')
    ),
    el('div', { className: 'field' }, el('label', {}, '课程名称 *'), nameInput),
    el('div', { className: 'field' }, el('label', {}, '补课日期 *'), dateInput),
    el('div', { className: 'row' },
      el('div', { className: 'field' }, el('label', {}, '开始节次'), spInput),
      el('div', { className: 'field' }, el('label', {}, '结束节次'), epInput)
    ),
    el('div', { className: 'row' },
      el('div', { className: 'field' }, el('label', {}, '上课地点'), locInput),
      el('div', { className: 'field' }, el('label', {}, '任课教师'), teacherInput)
    ),
    el('div', { className: 'field' }, el('label', {}, '备注'), noteInput)
  ], [
    el('button', { type: 'button', className: 'btn', onClick: closeModal }, '取消'),
    el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: async () => {
        if (!nameInput.value.trim()) return showToast('请输入课程名称');
        if (!isValidDateStr(dateInput.value)) return showToast('请选择有效日期');
        const next = addSingleOccurrence(state.data, {
          name: nameInput.value,
          date: dateInput.value,
          startPeriod: Math.max(1, Math.min(maxP, Number(spInput.value) || 1)),
          endPeriod: Math.max(1, Math.min(maxP, Number(epInput.value) || 1)),
          location: locInput.value,
          teacher: teacherInput.value,
          note: noteInput.value
        });
        const ok = await persistData(next, `已添加 ${dateInput.value} 单次补课`, { onResolvedSuccess: closeModal });
        if (ok) closeModal();
      }
    }, '保存本次补课')
  ]);
}

function openTransferLimitFallbackModal(errorMsg) {
  openModal('课表体积超出导入码上限', [
    el('div', { className: 'notice-box notice-warn' }, errorMsg),
    el('p', { className: 'muted', style: { margin: 0, fontSize: '13px' } },
      '为确保接收端 100% 正常解码，已阻止生成超限导入码。请改用「导出完整 JSON 备份」发给另一台设备，在导入页直接选择 JSON 文件恢复。')
  ], [
    el('button', { type: 'button', className: 'btn', onClick: closeModal }, '关闭'),
    el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: () => {
        const filename = `简课表备份_${state.data.term.startMonday}.json`;
        downloadTextFile(filename, JSON.stringify(state.data), 'application/json;charset=utf-8');
        closeModal();
        showToast(`已导出 ${filename}`);
      }
    }, '立即导出完整 JSON 备份')
  ]);
}

function openAmbiguousLegacyRestoreModal(occ, resolution) {
  const selectedIds = new Set();
  const listNodes = resolution.candidates.map((cand) => {
    const chk = el('input', {
      type: 'checkbox',
      checked: false,
      onChange: (e) => {
        if (e.target.checked) selectedIds.add(cand.id);
        else selectedIds.delete(cand.id);
      }
    });
    return el('label', { className: 'preview-item row', style: { cursor: 'pointer' } },
      chk,
      el('span', {}, `${cand.date} 第${cand.startPeriod}-${cand.endPeriod}节 · ${cand.name}${cand.location ? ` @ ${cand.location}` : ''}${cand.note ? `（${cand.note}）` : ''}`)
    );
  });

  openModal('确认旧版跨天调课关联记录', [
    el('div', { className: 'notice-box notice-info' },
      `恢复 ${occ.date} 的「${occ.name}」时，检测到目标日期（${resolution.targetDate}）存在多条或无法唯一确定的同课程补课。请勾选需要随同撤回的记录，未勾选的将保留为独立补课。`
    ),
    el('div', { className: 'preview-list' }, ...listNodes)
  ], [
    el('button', { type: 'button', className: 'btn', onClick: closeModal }, '取消'),
    el('button', {
      type: 'button',
      className: 'btn btn-primary',
      onClick: async () => {
        const next = applySingleOccurrenceEdit(state.data, occ, 'restore', {
          skipAutoLegacyPair: true,
          alsoRemoveOverrideIds: [...selectedIds]
        });
        const msg = selectedIds.size > 0
          ? `已恢复 ${occ.name} 并撤回 ${selectedIds.size} 条已选调课记录`
          : `已恢复 ${occ.name}（保留目标日补课）`;
        const ok = await persistData(next, msg, { onResolvedSuccess: closeModal });
        if (ok) closeModal();
      }
    }, '确认恢复')
  ]);
}

function describeLegacyCandidateItems(cand) {
  if (!cand) return '';
  const parts = [];
  if (cand.missing?.data && cand.data) {
    parts.push(`主课表与设置（${cand.data.term.name} · ${cand.data.courses.length} 门课 · ${cand.data.periods.length} 节作息）`);
  }
  if (cand.missing?.snapshot && cand.legacySnapshot) {
    parts.push(`旧版快照（${cand.legacySnapshot.data.courses.length} 门课）`);
  }
  if (cand.missing?.prefs) {
    parts.push('旧版界面偏好');
  }
  return parts.join(' + ') || '旧版数据';
}

async function runLegacyMigrationAction() {
  const res = await migrateLegacyDataToScoped();
  if (!res.ok) {
    if (res.partial) {
      if (res.data) {
        state.data = upgradeLegacyTransferPairs(res.data).data;
        state.selectedWeek = getTermStatus(state.data, getTodayInTimezone(state.data.term.timezone)).currentWeek;
      }
      state.prefs = loadPrefs();
      state.legacyCandidate = detectLegacyMigrationCandidate();
      applyTheme();
      render();
      showToast(`部分项目已恢复，但仍有未完成项（${res.error}），可点击重试仅补齐缺项`, 5000);
      return;
    }
    showToast(res.error || '旧版迁移失败', 4500);
    return;
  }

  if (res.data) {
    state.data = upgradeLegacyTransferPairs(res.data).data;
  }
  state.prefs = loadPrefs();
  state.legacyCandidate = detectLegacyMigrationCandidate();
  state.selectedWeek = getTermStatus(state.data, getTodayInTimezone(state.data.term.timezone)).currentWeek;
  applyTheme();
  render();

  const migratedParts = [];
  if (res.dataMigrated) migratedParts.push(`课表与设置（${state.data.courses.length} 门课）`);
  if (res.snapshotMigrated) migratedParts.push('旧版快照');
  if (res.prefsMigrated) migratedParts.push('界面偏好');
  showToast(
    migratedParts.length > 0
      ? `已恢复${migratedParts.join('、')}到当前路径`
      : '当前路径已包含全部旧版数据'
  );
}

function renderStorageIssueBanner() {
  const issue = state.storageIssue;
  if (!issue) return null;

  const actions = [];
  if (issue.kind === 'corrupted') {
    actions.push(
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: () => {
          const filename = `简课表损坏原文_${Date.now()}.txt`;
          downloadTextFile(filename, String(issue.rawContent || ''), 'text/plain;charset=utf-8');
          showToast(`已导出损坏原文：${filename}`);
        }
      }, '导出损坏原文 (.txt)'),
      el('button', {
        type: 'button',
        className: 'btn btn-danger btn-sm',
        onClick: () => {
          openModal('确认重置损坏的本地存储？', [
            el('div', { className: 'notice-box notice-warn' },
              '建议先点击「导出损坏原文 (.txt)」备份。重置后将以空白默认课表覆盖损坏的本地键，随后可重新导入或恢复 JSON 备份。'
            )
          ], [
            el('button', { type: 'button', className: 'btn', onClick: closeModal }, '取消'),
            el('button', {
              type: 'button',
              className: 'btn btn-danger',
              onClick: async () => {
                const fresh = createDefaultData();
                const ok = await persistData(fresh, '已重置损坏存储并恢复可用状态', {
                  force: true,
                  allowOverwriteCorrupted: true
                });
                if (ok) closeModal();
              }
            }, '确认覆盖重置')
          ]);
        }
      }, '清空损坏键并重置')
    );
  } else {
    actions.push(
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: () => {
          const reload = loadScheduleData();
          if (!reload.readError && !reload.corrupted) {
            state.data = upgradeLegacyTransferPairs(reload.data).data;
            state.storageIssue = null;
            render();
            showToast('已重新读取本地课表');
          } else {
            showToast(`仍无法读取：${reload.readError || 'JSON 损坏'}`, 4000);
          }
        }
      }, '重新尝试读取')
    );
  }

  return el(
    'section',
    { className: 'card stack', style: { marginBottom: '14px', borderColor: 'var(--danger)' } },
    el('div', {},
      el('strong', { style: { fontSize: '14px', display: 'block', marginBottom: '4px', color: 'var(--danger)' } },
        issue.kind === 'corrupted' ? '本地课表数据损坏 · 已暂停自动覆盖' : '读取本地课表失败 · 已暂停自动覆盖'),
      el('p', { className: 'muted', style: { margin: 0, fontSize: '12.5px', lineHeight: '1.5' } }, issue.error)
    ),
    el('div', { className: 'row' }, ...actions)
  );
}

function renderLegacyMigrationBanner() {
  const cand = state.legacyCandidate;
  if (!cand) return null;
  const previewSource = cand.data || cand.legacySnapshot?.data || null;

  return el(
    'section',
    { className: 'card stack', style: { marginBottom: '14px', borderColor: 'var(--primary)' } },
    el('div', {},
      el('strong', { style: { fontSize: '14px', display: 'block', marginBottom: '4px' } },
        `检测到旧版未迁移数据：${describeLegacyCandidateItems(cand)}`),
      el('p', { className: 'muted', style: { margin: 0, fontSize: '12.5px', lineHeight: '1.5' } },
        `当前子路径（${cand.scopePath}）已启用独立存储隔离。如果你是在该路径从旧版原址升级，请点击下方一键恢复（会保留旧原件，仅补齐缺项）；忽略后也可随时在「设置 → 显示偏好与数据管理」中手动恢复。`)
    ),
    el('div', { className: 'row' },
      el('button', {
        type: 'button',
        className: 'btn btn-primary btn-sm',
        onClick: () => runLegacyMigrationAction()
      }, '恢复旧版数据到当前路径'),
      previewSource
        ? el('button', {
          type: 'button',
          className: 'btn btn-soft btn-sm',
          onClick: () => {
            const parsed = parseJsonBackup(previewSource);
            if (parsed.ok) {
              openImportPreviewModal(parsed, {
                title: cand.data ? '预览：旧版存储中的课表' : '预览：旧版存储中的快照课表'
              });
            }
          }
        }, '预览内容')
        : null,
      el('button', {
        type: 'button',
        className: 'btn btn-ghost btn-sm',
        onClick: () => {
          dismissLegacyMigration();
          state.legacyCandidate = null;
          render();
          showToast('已收起旧版提示（旧原件未删除，可随时在设置中手动恢复）');
        }
      }, '暂不迁移（以后可在设置中恢复）')
    )
  );
}

function renderIOSInstallHintBanner() {
  if (!isIOSDevice() || isRunningStandalone() || state.prefs.iosHintDismissed) return null;
  return el(
    'div',
    { className: 'notice-box notice-info row-between', style: { fontSize: '12.5px' } },
    el('span', {},
      el('strong', {}, '添加到 iPhone 主屏幕：'),
      '点 Safari 底部「分享 → 添加到主屏幕」，从桌面图标打开并显示「已可离线使用」后再导入课表，即可像 App 一样全屏断网秒开。'
    ),
    el('button', {
      type: 'button',
      className: 'btn btn-ghost btn-xs',
      onClick: () => persistPrefs({ iosHintDismissed: true })
    }, '不再提示')
  );
}

// ── 主渲染 ──
function render() {
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
  });

  mainView.replaceChildren();
  const storageIssueBanner = renderStorageIssueBanner();
  if (storageIssueBanner) {
    mainView.appendChild(storageIssueBanner);
  }
  const legacyBanner = renderLegacyMigrationBanner();
  if (legacyBanner && state.activeTab !== 'settings') {
    mainView.appendChild(legacyBanner);
  }
  if (state.activeTab === 'today' || state.activeTab === 'week') {
    const iosHint = renderIOSInstallHintBanner();
    if (iosHint) {
      iosHint.style.marginBottom = '12px';
      mainView.appendChild(iosHint);
    }
  }
  if (state.activeTab === 'today') mainView.appendChild(renderTodayView());
  else if (state.activeTab === 'week') mainView.appendChild(renderWeekView());
  else if (state.activeTab === 'import') mainView.appendChild(renderImportView());
  else mainView.appendChild(renderSettingsView());
}

// ── 检测 #schedule=... 片段链接（先做长度拦截，再流式受限解码） ──
async function checkIncomingHashSchedule() {
  const hash = window.location.hash || '';
  if (!hash.includes('#schedule=')) return;

  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    // ignore
  }

  if (hash.length > LIMITS.MAX_TRANSFER_CODE_CHARS + 1024) {
    showToast(`分享链接过长（超过 ${LIMITS.MAX_TRANSFER_CODE_CHARS} 字符安全上限），已中止自动解码，请改用 JSON 备份文件。`, 5000);
    return;
  }

  const extracted = extractScheduleCode(hash);
  if (!extracted || (typeof extracted === 'object' && extracted.tooLong)) {
    showToast('分享链接格式无效或超过长度上限，已跳过。', 4000);
    return;
  }

  const res = await decodeTransferCode(extracted);
  if (!res.ok) {
    showToast(res.error, 4500);
    return;
  }
  const parsed = parseJsonBackup(res.raw);
  if (!parsed.ok) {
    showToast(parsed.error, 4500);
    return;
  }
  openImportPreviewModal(parsed, {
    title: '检测到课表副本链接 · 核对预览',
    iosSafariWarning: isIOSDevice() && !isRunningStandalone()
  });
}

// ── 事件绑定与启动 ──
document.querySelectorAll('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

quickAddBtn.addEventListener('click', () => openAddCourseModal('group', state.selectedDate));
window.addEventListener('hashchange', checkIncomingHashSchedule);

setInterval(() => {
  if (state.activeTab === 'today' || state.activeTab === 'week') {
    render();
  }
}, 60000);

applyTheme();
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
render();
initServiceWorker();
syncUsageStats();
(async () => {
  await checkIncomingHashSchedule();
  if (!state.prefs.namePromptDone && modalOverlay.classList.contains('hidden')) {
    openWelcomeNameModal({ isFirstUse: true });
  }
})();
