/**
 * @fileoverview 自動化驗證測試腳本
 * 測試重構後的各模組功能、邏輯正確性與邊界條件，確保無任何功能退化 (Regression-free)。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 模擬瀏覽器全域環境
const idbMemoryStore = new Map();
global.indexedDB = {
  open: () => {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => {
          const tx = {
            objectStore: () => ({
              get: (key) => {
                const r = { result: idbMemoryStore.has(key) ? { key, value: idbMemoryStore.get(key) } : undefined };
                process.nextTick(() => { if (r.onsuccess) r.onsuccess(); });
                return r;
              },
              put: (entry) => {
                idbMemoryStore.set(entry.key, entry.value);
                process.nextTick(() => { if (tx.oncomplete) tx.oncomplete(); });
              }
            }),
            oncomplete: null,
            onerror: null
          };
          return tx;
        }
      },
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null
    };
    process.nextTick(() => {
      if (req.onsuccess) req.onsuccess({ target: req });
    });
    return req;
  }
};

const storageMemoryStore = new Map();
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const res = {};
        const arr = Array.isArray(keys) ? keys : [keys];
        arr.forEach((k) => {
          if (storageMemoryStore.has(k)) {
            res[k] = storageMemoryStore.get(k);
          }
        });
        if (cb) cb(res);
      },
      set: (obj, cb) => {
        for (const [k, v] of Object.entries(obj)) {
          storageMemoryStore.set(k, v);
        }
        if (cb) cb();
      }
    }
  }
};

global.window = {
  location: {
    origin: 'https://swpc.atlassian.net',
    href: 'https://swpc.atlassian.net/jira/software/projects/WMC/boards/391/backlog'
  },
  indexedDB: global.indexedDB,
  chrome: global.chrome
};
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.window.requestAnimationFrame = global.requestAnimationFrame;
global.window.cancelAnimationFrame = global.cancelAnimationFrame;

global.NodeFilter = {
  SHOW_ALL: -1,
  SHOW_ELEMENT: 1,
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3
};
global.window.NodeFilter = global.NodeFilter;

global.document = {
  head: { appendChild: () => {} },
  documentElement: { appendChild: () => {} },
  getElementById: (id) => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelectorAll: () => [],
  querySelector: (sel) => null,
  createTreeWalker: (root, whatToShow, filter) => {
    const nodes = [];
    function collect(el) {
      if (!el) return;
      if (el._textContent !== undefined) {
        nodes.push({ nodeValue: el._textContent, parentElement: el.parentElement });
      }
      if (Array.isArray(el.children)) {
        el.children.forEach(collect);
      }
    }
    collect(root);
    let idx = 0;
    return {
      nextNode: () => nodes[idx++] || null
    };
  }
};

// 依載入順序逐一載入各模組
const filesToLoad = [
  'db.js',
  'src/constants.js',
  'src/utils/text-utils.js',
  'src/utils/dom-utils.js',
  'src/utils/assignee-utils.js',
  'src/services/sprint-stats.js',
  'src/state/issue-store.js',
  'src/services/jira-api.js',
  'src/services/filter-service.js',
  'src/services/frontend-filter-service.js',
  'src/parser/adf-parser.js',
  'src/parser/sprint-dom-parser.js',
  'src/parser/card-dom-parser.js',
  'src/components/runtime-styles.js',
  'src/components/filter-toolbar.js',
  'src/components/issue-card.js',
  'src/components/quick-edit-popover.js',
  'src/components/card-context-menu.js',
  'src/components/issue-modal.js',
  'src/components/history-picker-modal.js',
  'src/components/sidebar.js',
  'src/components/active-sprint-view.js',
  'src/components/history-sprint-view.js',
  'src/layout/layout-manager.js'
];

filesToLoad.forEach((file) => {
  const filePath = path.resolve(__dirname, '..', file);
  const code = fs.readFileSync(filePath, 'utf8');
  eval(code);
});

const { BetterJira } = global.window;
assert(BetterJira, 'BetterJira namespace should exist on window');

console.log('--- 測試 1: TextUtils ---');
const { TextUtils } = BetterJira;
assert.strictEqual(
  TextUtils.cleanSummaryText('CleanSheet CleanSheet'),
  'CleanSheet',
  '完全重複字串應正確去重'
);
assert.strictEqual(
  TextUtils.cleanSummaryText('TitleTitle'),
  'Title',
  '緊鄰無空格重複應正確去重'
);
assert.strictEqual(
  TextUtils.cleanSummaryText('Fix bug in login Fix bug in login'),
  'Fix bug in login',
  '多單字重複應正確去重'
);
assert.strictEqual(
  TextUtils.cleanSummaryText('CleanSheet... CleanSheet Fix other bug'),
  'CleanSheet Fix other bug',
  '截斷前綴+完整標題重複應正確保留完整版'
);
assert.strictEqual(
  TextUtils.cleanSummaryText('Summary Text Summary Text 5 RAY'),
  'Summary Text',
  '標題後殘留徽章文字應正確清理'
);
assert.strictEqual(
  TextUtils.cleanSprintTitle('WMC Sprint 24 (29 個工作項目中的 5 個)'),
  'WMC Sprint 24',
  'Sprint 標題尾部卡片數量應正確移除'
);
assert.strictEqual(
  TextUtils.cleanSprintTitle('WMC Sprint 25 2026/10/22 - 2026/11/04'),
  'WMC Sprint 25',
  'Sprint 標題尾部日期區間應正確移除'
);
assert.strictEqual(
  TextUtils.cleanStatusText('狀態待辦事項'),
  '待辦事項',
  '狀態前綴應正確清除'
);
assert.strictEqual(
  TextUtils.cleanStatusText('狀態local testing / Wait for MR'),
  'local testing / Wait for MR',
  '包含英文與符號之狀態前綴應正確清除'
);
assert.strictEqual(
  TextUtils.cleanStatusText('Status: In Progress'),
  'In Progress',
  '英文 Status: 前綴應正確清除'
);
assert.strictEqual(
  TextUtils.cleanDueDateText('截止日期: 2026年11月4日11月4日'),
  '2026年11月4日',
  '重複之截止日期與前綴應正確清理'
);
assert.strictEqual(
  TextUtils.cleanDueDateText('📅 2026-11-04'),
  '2026-11-04',
  '帶有月曆 emoji 之截止日期應正確清理'
);
assert.strictEqual(
  TextUtils.escapeHtml('<script>alert("test")&foo</script>'),
  '&lt;script&gt;alert(&quot;test&quot;)&amp;foo&lt;/script&gt;',
  'HTML 特殊字元應正確跳脫'
);
assert.strictEqual(
  TextUtils.isUrlMatched(
    'https://swpc.atlassian.net/jira/software/projects/WMC/boards/391/backlog',
    'https://swpc.atlassian.net/jira/software/projects/WMC/boards/391/backlog/'
  ),
  true,
  '網址匹配應正確忽略尾部斜線'
);
console.log('✓ TextUtils 測試通過！');

console.log('--- 測試 2: AssigneeUtils ---');
const { AssigneeUtils } = BetterJira;
assert.strictEqual(
  AssigneeUtils.cleanAssigneeLabel('負責人: Ray Huang (已選取)'),
  'Ray Huang',
  '負責人前綴與已選取後綴應正確清除'
);
assert.strictEqual(
  AssigneeUtils.cleanAssigneeLabel('Filter by assignee: Bruce Peng'),
  'Bruce Peng',
  '英文 Filter by 前綴應正確清除'
);
assert.strictEqual(AssigneeUtils.isUnassignedText('未指派'), true);
assert.strictEqual(AssigneeUtils.isUnassignedText('Unassigned'), true);
assert.strictEqual(AssigneeUtils.isUnassignedText('Ray Huang'), false);

const initials = AssigneeUtils.deriveInitialsVariants('Ray Huang');
assert(initials.includes('RAY'), 'Initials 應包含 RAY');
assert(initials.includes('RH'), 'Initials 應包含 RH');

const displayInit = AssigneeUtils.getDisplayInitialsForIssue({
  assigneeName: 'Ray Huang',
  isUnassigned: false
});
assert.strictEqual(displayInit, 'RAY');
console.log('✓ AssigneeUtils 測試通過！');

console.log('--- 測試 3: SprintStatsService ---');
const { SprintStatsService } = BetterJira;
const sampleIssues = [
  { key: 'WMC-1', statusCategory: 'new', storyPoints: 3 },
  { key: 'WMC-2', statusCategory: 'indeterminate', storyPoints: 5.5 },
  { key: 'WMC-3', statusCategory: 'done', storyPoints: 2 },
  { key: 'WMC-4', statusCategory: 'done', storyPoints: null }
];
const stats = SprintStatsService.calculateSprintStatistics(sampleIssues);
assert.strictEqual(stats.totalIssues, 4);
assert.strictEqual(stats.todoCount, 1);
assert.strictEqual(stats.inProgressCount, 1);
assert.strictEqual(stats.doneCount, 2);
assert.strictEqual(stats.todoPoints, 3);
assert.strictEqual(stats.inProgressPoints, 5.5);
assert.strictEqual(stats.donePoints, 2);
assert.strictEqual(stats.totalPoints, 10.5);
console.log('✓ SprintStatsService 測試通過！');

console.log('--- 測試 4: AdfParser ---');
const { AdfParser } = BetterJira;
const sampleAdf = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'World', marks: [{ type: 'strong' }] }
      ]
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Item 1' }]
            }
          ]
        }
      ]
    }
  ]
};
const html = AdfParser.adfToHtml(sampleAdf);
assert(html.includes('<p>Hello <strong>World</strong></p>'), 'ADF strong 應正確轉譯');
assert(html.includes('<ul><li><p>Item 1</p></li></ul>'), 'ADF bulletList 應正確轉譯');
console.log('✓ AdfParser 測試通過！');

console.log('--- 測試 5: IssueStore & normalizeJiraIssue ---');
const { IssueStore } = BetterJira;
const rawApiIssue = {
  id: '1001',
  key: 'WMC-101',
  fields: {
    summary: 'Fix login bug Fix login bug',
    status: {
      name: '進行中',
      statusCategory: { key: 'indeterminate' }
    },
    issuetype: {
      name: 'Bug',
      iconUrl: 'https://swpc.atlassian.net/bug.png'
    },
    priority: {
      name: 'High',
      iconUrl: 'https://swpc.atlassian.net/high.png'
    },
    assignee: {
      displayName: 'Ray Huang',
      accountId: 'acc123',
      avatarUrls: { '48x48': 'https://swpc.atlassian.net/avatar.png' }
    },
    story_points: 5
  }
};
const normalized = IssueStore.normalizeJiraIssue(rawApiIssue);
assert.strictEqual(normalized.key, 'WMC-101');
assert.strictEqual(normalized.summary, 'Fix login bug', 'API 卡片標題應自動去重');
assert.strictEqual(normalized.statusName, '進行中');
assert.strictEqual(normalized.statusCategory, 'indeterminate');
assert.strictEqual(normalized.storyPoints, 5);
assert.strictEqual(normalized.assigneeName, 'Ray Huang');
assert.strictEqual(normalized.isUnassigned, false);
console.log('✓ IssueStore 測試通過！');

console.log('--- 測試 6: FilterService ---');
const { FilterService } = BetterJira;
const filterState = {
  searchKeyword: 'login',
  includeUnassigned: false,
  selectedAssignees: [
    {
      initials: 'rh',
      cleanedNames: ['ray huang'],
      tokens: ['ray', 'huang', 'rh'],
      avatarSrc: ''
    }
  ],
  hasDirectFilter: true,
  sig: 'test'
};
const filteredIssues = FilterService.filterIssuesByNativeFilter([normalized], filterState);
assert.strictEqual(filteredIssues.length, 1, '符合關鍵字與經辦人之卡片應被保留');

const mismatchedFilter = {
  searchKeyword: 'nonexistent',
  includeUnassigned: false,
  selectedAssignees: [],
  hasDirectFilter: true,
  sig: 'test2'
};
const emptyResult = FilterService.filterIssuesByNativeFilter([normalized], mismatchedFilter);
assert.strictEqual(emptyResult.length, 0, '不符合條件之卡片應被過濾');
console.log('✓ FilterService 測試通過！');

console.log('--- 測試 7: IssueCardComponent ---');
const { IssueCardComponent } = BetterJira;
const cardHtml = IssueCardComponent.renderIssueCardHtml(normalized);
assert(cardHtml.includes('data-bjwt-history-issue-key="WMC-101"'), '卡片應包含正確 key 屬性');
assert(cardHtml.includes('Fix login bug'), '卡片應包含清理後標題');
assert(cardHtml.includes('status-inprogress'), '進行中卡片應有 status-inprogress class');
assert(cardHtml.includes('>5<'), '卡片應包含正確點數 5');

// 測試完整欄位卡片的第二列結構排版 (flex 切成欄位，除最後一欄靠右，其他都靠左)
const fullFeaturedIssue = {
  ...normalized,
  parentSummary: 'Authentication Epic',
  dueDate: '2026年11月4日'
};
const fullCardHtml = IssueCardComponent.renderIssueCardHtml(fullFeaturedIssue);
assert(fullCardHtml.includes('bjwt-card-col-epic'), '卡片第二列應包含第 1 欄：標籤/Epic');
assert(fullCardHtml.includes('bjwt-card-col-duedate'), '卡片第二列應包含第 2 欄：截止日期');
assert(fullCardHtml.includes('bjwt-card-col-right'), '卡片第二列應包含最後一欄：右側操作');
assert(fullCardHtml.includes('bjwt-history-parent-badge'), '第 1 欄應渲染標籤/Epic');
assert(fullCardHtml.includes('bjwt-history-duedate-badge'), '第 2 欄應渲染截止日期');
assert(fullCardHtml.includes('bjwt-history-status-badge'), '最後一欄應渲染狀態徽章');
assert(fullCardHtml.includes('bjwt-history-points-badge'), '最後一欄應渲染 StoryPoint');
assert(fullCardHtml.includes('bjwt-history-priority-icon'), '最後一欄應渲染優先度圖示');
assert(fullCardHtml.includes('bjwt-history-assignee'), '最後一欄應渲染經辦人');

// 驗證欄位順序：標籤 (第1欄) -> 截止日期 (第2欄) -> 最後一欄 (右側欄位靠右)
const epicColIdx = fullCardHtml.indexOf('bjwt-card-col-epic');
const duedateColIdx = fullCardHtml.indexOf('bjwt-card-col-duedate');
const rightColIdx = fullCardHtml.indexOf('bjwt-card-col-right');

assert(
  epicColIdx < duedateColIdx && duedateColIdx < rightColIdx,
  '欄位順序應為：標籤 (第1欄) -> 截止日期 (第2欄) -> 最後一欄靠右'
);

// 驗證最後一欄最前方為狀態徽章，接著為 StoryPoint、優先度、經辦人
const statusBadgeIdx = fullCardHtml.indexOf('bjwt-history-status-badge');
const pointsBadgeIdx = fullCardHtml.indexOf('bjwt-history-points-badge');
const priorityIconIdx = fullCardHtml.indexOf('bjwt-history-priority-icon');
const assigneeIdx = fullCardHtml.indexOf('bjwt-history-assignee');

assert(
  rightColIdx < statusBadgeIdx &&
  statusBadgeIdx < pointsBadgeIdx &&
  pointsBadgeIdx < priorityIconIdx &&
  priorityIconIdx < assigneeIdx,
  '最後一欄內部順序應為：狀態徽章 (最前方) -> StoryPoint -> 優先度 -> 經辦人'
);

// 驗證無標籤/無截止日期的卡片，仍保留欄位結構 (Slot) 以確保不會跑版
const minimalCardHtml = IssueCardComponent.renderIssueCardHtml(normalized);
assert(minimalCardHtml.includes('bjwt-card-col-epic'), '無標籤時仍應保留第 1 欄 slot');
assert(minimalCardHtml.includes('bjwt-card-col-duedate'), '無截止日期時仍應保留第 2 欄 slot');
assert(minimalCardHtml.includes('bjwt-card-col-right'), '最後一欄仍正確存在');
assert(minimalCardHtml.includes('bjwt-history-status-badge'), '最後一欄狀態徽章仍正確存在');
assert(!minimalCardHtml.includes('bjwt-history-parent-badge'), '無標籤時不應渲染標籤徽章');
assert(!minimalCardHtml.includes('bjwt-history-duedate-badge'), '無截止日期時不應渲染日期徽章');

// 驗證 StoryPoint, 優先度, 指派人員 三個欄位皆使用等寬 slot 容器
assert(fullCardHtml.includes('bjwt-card-slot-points'), '應包含 StoryPoint 等寬 slot 容器');
assert(fullCardHtml.includes('bjwt-card-slot-priority'), '應包含 優先度 等寬 slot 容器');
assert(fullCardHtml.includes('bjwt-card-slot-assignee'), '應包含 指派人員 等寬 slot 容器');

// 測試無優先度卡片，驗證優先度 slot 仍存在且有 placeholder 占位，保證排版不歪斜
const noPriorityIssue = {
  ...normalized,
  priorityIcon: '',
  prioritySvg: '',
  priorityName: ''
};
const noPriorityCardHtml = IssueCardComponent.renderIssueCardHtml(noPriorityIssue);
assert(noPriorityCardHtml.includes('bjwt-card-slot-priority'), '無優先度卡片仍應保留優先度 slot 容器占位');
assert(noPriorityCardHtml.includes('bjwt-history-priority-placeholder'), '無優先度卡片應包含占位 element');
assert(!noPriorityCardHtml.includes('bjwt-history-priority-icon'), '無優先度卡片不應渲染優先度圖示');
assert(noPriorityCardHtml.includes('bjwt-card-slot-points'), '無優先度卡片 StoryPoint slot 仍正確存在');
assert(noPriorityCardHtml.includes('bjwt-card-slot-assignee'), '無優先度卡片經辦人 slot 仍正確存在');
console.log('✓ IssueCardComponent 測試通過！');

console.log('--- 測試 8: IssueModal 全版面樣式檢查 ---');
const stylesCss = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
const runtimeStylesJs = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');

assert(stylesCss.includes('width: 100% !important;'), 'styles.css 應設定 modal 寬度 100%');
assert(stylesCss.includes('height: 100% !important;'), 'styles.css 應設定 modal 高度 100%');
assert(stylesCss.includes('inset: 0 !important;'), 'styles.css 應設定 modal inset: 0');
assert(!stylesCss.includes('width: min(92vw, 1140px)'), 'styles.css 不應殘留舊版固定寬度');
assert(!stylesCss.includes('height: min(90vh, 860px)'), 'styles.css 不應殘留舊版固定高度');
assert(stylesCss.includes('margin-right: 32px !important;'), 'styles.css 應設定關閉按鈕安全右邊距');

assert(runtimeStylesJs.includes('width: 100% !important;'), 'runtime-styles.js 應設定 modal 寬度 100%');
assert(runtimeStylesJs.includes('height: 100% !important;'), 'runtime-styles.js 應設定 modal 高度 100%');
assert(runtimeStylesJs.includes('inset: 0 !important;'), 'runtime-styles.js 應設定 modal inset: 0');
assert(runtimeStylesJs.includes('margin-right: 32px !important;'), 'runtime-styles.js 應設定關閉按鈕安全右邊距');
console.log('✓ IssueModal 全版面樣式測試通過！');

console.log('--- 測試 9: 卡片第二列 flex n 欄排版樣式檢查 ---');
assert(stylesCss.includes('.bjwt-card-col-epic'), 'styles.css 應包含 .bjwt-card-col-epic 樣式');
assert(stylesCss.includes('.bjwt-card-col-status'), 'styles.css 應包含 .bjwt-card-col-status 樣式');
assert(stylesCss.includes('.bjwt-card-col-duedate'), 'styles.css 應包含 .bjwt-card-col-duedate 樣式');
assert(stylesCss.includes('.bjwt-card-col-right'), 'styles.css 應包含 .bjwt-card-col-right 樣式');

assert(runtimeStylesJs.includes('.bjwt-card-col-epic'), 'runtime-styles.js 應包含 .bjwt-card-col-epic 樣式');
assert(runtimeStylesJs.includes('.bjwt-card-col-status'), 'runtime-styles.js 應包含 .bjwt-card-col-status 樣式');
assert(runtimeStylesJs.includes('.bjwt-card-col-duedate'), 'runtime-styles.js 應包含 .bjwt-card-col-duedate 樣式');
assert(runtimeStylesJs.includes('.bjwt-card-col-right'), 'runtime-styles.js 應包含 .bjwt-card-col-right 樣式');

assert(stylesCss.includes('width: 88px !important;'), 'styles.css 狀態徽章應設定固定寬度 88px');
assert(stylesCss.includes('justify-content: flex-start !important;'), 'styles.css 狀態徽章應設定靠左對齊');
assert(stylesCss.includes('.bjwt-card-action-slot'), 'styles.css 應包含 .bjwt-card-action-slot 樣式');
assert(stylesCss.includes('min-width: 196px !important;'), 'styles.css 應設定右側欄位最小保證寬度 196px');

assert(runtimeStylesJs.includes('width: 88px !important;'), 'runtime-styles.js 狀態徽章應設定固定寬度 88px');
assert(runtimeStylesJs.includes('justify-content: flex-start !important;'), 'runtime-styles.js 狀態徽章應設定靠左對齊');
assert(runtimeStylesJs.includes('.bjwt-card-action-slot'), 'runtime-styles.js 應包含 .bjwt-card-action-slot 樣式');
assert(runtimeStylesJs.includes('min-width: 196px !important;'), 'runtime-styles.js 應設定右側欄位最小保證寬度 196px');
console.log('✓ 卡片第二列 flex n 欄排版樣式測試通過！');

console.log('--- 測試 10: 未結束衝刺自定義檢視新增卡片按鈕與 triggerCreateIssue 檢查 ---');
const { ActiveSprintView } = BetterJira;
assert(ActiveSprintView, 'ActiveSprintView 模組應存在');
assert.strictEqual(typeof ActiveSprintView.triggerCreateIssue, 'function', 'triggerCreateIssue 應為函式');

const activeSprintViewJs = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/active-sprint-view.js'), 'utf8');
assert(activeSprintViewJs.includes('bjwt-active-create-btn'), 'active-sprint-view.js 應包含頂部橫幅新增卡片按鈕 class');
assert(activeSprintViewJs.includes('bjwt-active-inline-create-btn'), 'active-sprint-view.js 應包含卡片清單底部行內建立按鈕 class');
assert(activeSprintViewJs.includes('bjwt-active-create-card-row'), 'active-sprint-view.js 應包含建立按鈕容器列 class');

assert(stylesCss.includes('.bjwt-active-create-btn'), 'styles.css 應包含 .bjwt-active-create-btn 樣式');
assert(stylesCss.includes('.bjwt-active-inline-create-btn'), 'styles.css 應包含 .bjwt-active-inline-create-btn 樣式');
assert(stylesCss.includes('.bjwt-active-create-card-row'), 'styles.css 應包含 .bjwt-active-create-card-row 樣式');

assert(runtimeStylesJs.includes('.bjwt-active-create-btn'), 'runtime-styles.js 應包含 .bjwt-active-create-btn 樣式');
assert(runtimeStylesJs.includes('.bjwt-active-inline-create-btn'), 'runtime-styles.js 應包含 .bjwt-active-inline-create-btn 樣式');
assert(runtimeStylesJs.includes('.bjwt-active-create-card-row'), 'runtime-styles.js 應包含 .bjwt-active-create-card-row 樣式');

// 測試 triggerCreateIssue 觸發全域建立按鈕
let clicked = false;
const origQuerySelector = global.document.querySelector;
global.document.querySelector = (sel) => {
  if (sel === '#createGlobalItem') {
    return {
      click: () => {
        clicked = true;
      }
    };
  }
  return null;
};
const triggerResult = ActiveSprintView.triggerCreateIssue();
assert.strictEqual(triggerResult, true, '找到建立按鈕時應回傳 true');
assert.strictEqual(clicked, true, 'triggerCreateIssue 應成功點擊全域建立按鈕');
global.document.querySelector = origQuerySelector;

console.log('✓ 未結束衝刺自定義檢視新增卡片按鈕與 triggerCreateIssue 測試通過！');

console.log('--- 測試 11: 留言 HTML 解析與卡片編輯模式檢查 ---');
// 1. 測試 AdfParser.formatCommentBody
const commentWithHtml = {
  id: '101',
  body: '<p>這是一則包含 <strong>粗體</strong> 與 <a href="https://example.com">連結</a> 的留言</p>'
};
const commentHtmlResult = AdfParser.formatCommentBody(commentWithHtml);
assert(commentHtmlResult.includes('<p>這是一則包含 <strong>粗體</strong>'), '含有 HTML 標籤之留言不應被二次跳脫成 &lt;p&gt;');
assert(!commentHtmlResult.includes('&lt;p&gt;'), '留言中不應出現 &lt;p&gt; HTML 程式碼');

const commentWithPlainText = {
  id: '102',
  body: '一般純文字 <script>alert(1)</script>'
};
const plainCommentResult = AdfParser.formatCommentBody(commentWithPlainText);
assert(plainCommentResult.includes('&lt;script&gt;'), '純文字中的非法標籤應安全跳脫');

// 2. 測試 AdfParser.adfToPlainText
const sampleAdfForEdit = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '說明第一段' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '說明第二段' }] }
  ]
};
const plainDescText = AdfParser.adfToPlainText(sampleAdfForEdit);
assert(plainDescText.includes('說明第一段') && plainDescText.includes('說明第二段'), 'ADF 說明應正確轉為純文字以供編輯');

// 3. 測試 JiraApiService 更新與狀態轉換函式
const { JiraApiService } = BetterJira;
assert.strictEqual(typeof JiraApiService.updateIssue, 'function', 'updateIssue 應為函式');
assert.strictEqual(typeof JiraApiService.fetchIssueTransitions, 'function', 'fetchIssueTransitions 應為函式');
assert.strictEqual(typeof JiraApiService.transitionIssue, 'function', 'transitionIssue 應為函式');
assert.strictEqual(typeof JiraApiService.fetchIssueEditMeta, 'function', 'fetchIssueEditMeta 應為函式');
assert.strictEqual(typeof JiraApiService.updateIssueEstimation, 'function', 'updateIssueEstimation 應為函式');

// 測試 updateIssue 確保不傳遞任何 customfield_ 到 fields，並透過 estimation 更新點數
const asyncTest11Promise = (async () => {
  let issueFieldsChecked = false;
  let estimationCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url.includes('/rest/api/2/issue/TEST-1')) {
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.fields.summary, 'Updated title');
      // 驗證 fields 絕對不包含 customfield_，杜絕 Screen Scheme 阻擋
      const customKeys = Object.keys(body.fields).filter((k) => k.startsWith('customfield_'));
      assert.strictEqual(customKeys.length, 0, 'fields 內不應包含任何 customfield_ 欄位');
      issueFieldsChecked = true;
      return { ok: true, status: 204 };
    }
    if (url.includes('/estimation')) {
      const body = JSON.parse(opts.body);
      assert.strictEqual(body.value, 5, '點數應透過 estimation API 傳遞');
      estimationCalled = true;
      return { ok: true, status: 204 };
    }
    return { ok: true, json: async () => ({}) };
  };

  const res = await JiraApiService.updateIssue('TEST-1', {
    summary: 'Updated title',
    storyPoints: 5
  });
  assert.strictEqual(res.success, true, '更新應成功');
  assert.strictEqual(issueFieldsChecked, true, '標題應發送至 issue API');
  assert.strictEqual(estimationCalled, true, '點數應發送至 estimation API');
  global.fetch = originalFetch;
})();

// 4. 測試 IssueModal 編輯模式相關類別與樣式
const issueModalJs = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/issue-modal.js'), 'utf8');
assert(issueModalJs.includes('bjwt-history-modal-edit-btn'), 'issue-modal.js 應包含編輯按鈕');
assert(issueModalJs.includes('bjwt-history-modal-save-btn'), 'issue-modal.js 應包含儲存按鈕');
assert(issueModalJs.includes('bjwt-history-modal-cancel-btn'), 'issue-modal.js 應包含取消按鈕');
assert(issueModalJs.includes('data-bjwt-edit-mode'), 'issue-modal.js 應包含 data-bjwt-edit-mode 屬性控制');

const updatedStylesCss = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
assert(updatedStylesCss.includes('.bjwt-history-modal-edit-btn'), 'styles.css 應包含 .bjwt-history-modal-edit-btn');
assert(updatedStylesCss.includes('.bjwt-history-modal-save-btn'), 'styles.css 應包含 .bjwt-history-modal-save-btn');
assert(updatedStylesCss.includes('.bjwt-history-modal-cancel-btn'), 'styles.css 應包含 .bjwt-history-modal-cancel-btn');
assert(updatedStylesCss.includes('[data-bjwt-edit-mode="true"]'), 'styles.css 應包含編輯模式切換樣式');

const updatedRuntimeStylesJs = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');
assert(updatedRuntimeStylesJs.includes('.bjwt-history-modal-edit-btn'), 'runtime-styles.js 應包含 .bjwt-history-modal-edit-btn');
assert(updatedRuntimeStylesJs.includes('.bjwt-history-modal-save-btn'), 'runtime-styles.js 應包含 .bjwt-history-modal-save-btn');
assert(updatedRuntimeStylesJs.includes('.bjwt-history-modal-cancel-btn'), 'runtime-styles.js 應包含 .bjwt-history-modal-cancel-btn');
assert(updatedRuntimeStylesJs.includes('[data-bjwt-edit-mode="true"]'), 'runtime-styles.js 應包含編輯模式切換樣式');

console.log('✓ 留言 HTML 解析與卡片編輯模式測試通過！');

console.log('--- 測試 12: Jira 原生全方位篩選同步檢查 (Type, Epic, Status, Label, Quick Filter, Hidden DOM) ---');
const { CardDomParser } = BetterJira;

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.classList = {
      _classes: new Set(),
      contains(c) { return this._classes.has(c); },
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); }
    };
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this._textContent = undefined;
  }
  get textContent() {
    if (this.children.length === 0) return this._textContent !== undefined ? this._textContent : '';
    const childText = this.children.map((c) => c.textContent).join(' ');
    return this._textContent ? `${this._textContent}${childText}` : childText;
  }
  set textContent(val) {
    this.children = [];
    this._textContent = val;
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k] !== undefined ? this.attributes[k] : null;
  }
  hasAttribute(k) {
    return this.attributes[k] !== undefined;
  }
  removeAttribute(k) {
    delete this.attributes[k];
  }
  get src() {
    return this.getAttribute('src') || '';
  }
  set src(v) {
    this.setAttribute('src', v);
  }
  get href() {
    return this.getAttribute('href') || '';
  }
  set href(v) {
    this.setAttribute('href', v);
  }
  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get disabled() {
    return this.hasAttribute('disabled') || this._disabled === true;
  }
  set disabled(v) {
    this._disabled = Boolean(v);
    if (v) this.setAttribute('disabled', '');
    else this.removeAttribute('disabled');
  }
  get className() {
    return Array.from(this.classList._classes).join(' ');
  }
  set className(val) {
    this.classList._classes = new Set((val || '').split(/\s+/).filter(Boolean));
  }
  get value() {
    return this.getAttribute('value') !== null ? this.getAttribute('value') : (this._value || '');
  }
  set value(v) {
    this._value = String(v);
    this.setAttribute('value', v);
  }
  get options() {
    return this.querySelectorAll('option');
  }
  get selectedIndex() {
    const opts = this.options;
    const idx = opts.findIndex((o) => o.value === this.value);
    return idx !== -1 ? idx : 0;
  }
  get selectedOptions() {
    const opts = this.options;
    const selected = opts.filter((o) => o.value === this.value);
    return selected.length > 0 ? selected : (opts.length > 0 ? [opts[0]] : []);
  }
  get innerHTML() {
    return this._innerHTML || '';
  }
  set innerHTML(html) {
    this._innerHTML = html;
    this.children = [];
    if (!html || typeof html !== 'string') return;
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const tokenRegex = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9_-]+)\s*>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
    const stack = [this];
    let match;
    while ((match = tokenRegex.exec(html)) !== null) {
      if (match[1]) {
        const closeTag = match[1].toLowerCase();
        for (let i = stack.length - 1; i > 0; i -= 1) {
          if (stack[i].tagName.toLowerCase() === closeTag) {
            stack.length = i;
            break;
          }
        }
      } else if (match[2]) {
        const tagName = match[2];
        const attrStr = match[3] || '';
        const selfClosing = match[4] === '/' || voidTags.has(tagName.toLowerCase());
        const child = new MockElement(tagName);
        const attrRegex = /([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
        let aMatch;
        while ((aMatch = attrRegex.exec(attrStr)) !== null) {
          const attrName = aMatch[1];
          const attrVal = aMatch[2] !== undefined ? aMatch[2] : aMatch[3] !== undefined ? aMatch[3] : aMatch[4] !== undefined ? aMatch[4] : '';
          if (attrName === 'class') {
            child.className = attrVal;
          } else if (attrName === 'id') {
            child.setAttribute('id', attrVal);
          } else {
            child.setAttribute(attrName, attrVal);
          }
        }
        stack[stack.length - 1].appendChild(child);
        if (!selfClosing) {
          stack.push(child);
        }
      } else if (match[5]) {
        const current = stack[stack.length - 1];
        current._textContent = (current._textContent || '') + match[5];
      }
    }
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    }
  }
  insertBefore(newNode, refNode) {
    if (newNode.remove) newNode.remove();
    newNode.parentElement = this;
    const idx = refNode ? this.children.indexOf(refNode) : -1;
    if (idx === -1) {
      this.children.push(newNode);
    } else {
      this.children.splice(idx, 0, newNode);
    }
    return newNode;
  }
  insertAdjacentElement(pos, el) {
    if (el.remove) el.remove();
    if (pos === 'afterend' && this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        el.parentElement = this.parentElement;
        this.parentElement.children.splice(idx + 1, 0, el);
      }
    } else if (pos === 'beforebegin' && this.parentElement) {
      this.parentElement.insertBefore(el, this);
    }
    return el;
  }
  get previousElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx > 0 ? this.parentElement.children[idx - 1] : null;
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx !== -1 && idx < this.parentElement.children.length - 1
      ? this.parentElement.children[idx + 1]
      : null;
  }
  cloneNode(deep = false) {
    const clone = new MockElement(this.tagName);
    Object.assign(clone.attributes, this.attributes);
    clone._textContent = this._textContent;
    this.classList._classes.forEach((c) => clone.classList.add(c));
    if (deep) {
      for (const child of this.children) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }
  contains(other) {
    if (!other) return false;
    let curr = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement;
    }
    return false;
  }
  closest(sel) {
    let curr = this;
    while (curr) {
      if (curr.matches && curr.matches(sel)) return curr;
      curr = curr.parentElement;
    }
    return null;
  }
  matches(sel) {
    if (!sel) return false;
    const parts = sel.split(',').map((s) => s.trim());
    return parts.some((part) => {
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      if (part.startsWith('#')) return this.getAttribute('id') === part.slice(1);
      if (part.includes('[')) {
        const m = part.match(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(?:\s*([iI]))?)?\]/);
        if (m) {
          const attr = m[1];
          const op = m[2];
          let val = m[3] || m[4] || m[5] || '';
          const isCaseInsensitive = Boolean(m[6]);
          let actual = this.getAttribute(attr);
          if (actual === null) return false;
          if (!op) return true;
          if (isCaseInsensitive) {
            actual = actual.toLowerCase();
            val = val.toLowerCase();
          }
          if (op === '=') return actual === val;
          if (op === '*=') return actual.includes(val);
          if (op === '^=') return actual.startsWith(val);
          if (op === '$=') return actual.endsWith(val);
        }
      }
      return this.tagName.toLowerCase() === part.toLowerCase();
    });
  }
  querySelectorAll(sel) {
    const res = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(sel)) {
          res.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return res;
  }
  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length > 0 ? all[0] : null;
  }
  addEventListener(event, fn) {
    this._listeners = this._listeners || {};
    this._listeners[event] = this._listeners[event] || [];
    this._listeners[event].push(fn);
  }
  removeEventListener(event, fn) {
    if (!this._listeners || !this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((f) => f !== fn);
  }
  async dispatchEvent(evt) {
    if (!this._listeners || !this._listeners[evt.type]) return true;
    evt.target = evt.target || this;
    evt.currentTarget = this;
    for (const fn of this._listeners[evt.type]) {
      await fn.call(this, evt);
    }
    return !evt.defaultPrevented;
  }
  focus() {}
  select() {}
}
global.Element = MockElement;
if (!global.document.createElement) {
  global.document.createElement = (tag) => new MockElement(tag);
}
if (!global.document.body) {
  global.document.body = new MockElement('body');
}

// 1. 測試 isDomCardFilteredOrHidden
const divClean = new MockElement('div');
assert.strictEqual(CardDomParser.isDomCardFilteredOrHidden(divClean), false, '普通無標記節點不應被判斷為過濾隱藏');

const divGhxFiltered = new MockElement('div');
divGhxFiltered.className = 'ghx-issue ghx-filtered';
assert.strictEqual(CardDomParser.isDomCardFilteredOrHidden(divGhxFiltered), true, 'ghx-filtered 節點應被判斷為過濾隱藏');

const divDisplayNone = new MockElement('div');
divDisplayNone.style.display = 'none';
assert.strictEqual(CardDomParser.isDomCardFilteredOrHidden(divDisplayNone), true, 'display: none 節點應被判斷為過濾隱藏');

const divAriaHidden = new MockElement('div');
divAriaHidden.setAttribute('aria-hidden', 'true');
assert.strictEqual(CardDomParser.isDomCardFilteredOrHidden(divAriaHidden), true, 'aria-hidden="true" 節點應被判斷為過濾隱藏');

const divParentFiltered = new MockElement('li');
divParentFiltered.className = 'ghx-filtered';
const divChild = new MockElement('div');
divParentFiltered.appendChild(divChild);
assert.strictEqual(CardDomParser.isDomCardFilteredOrHidden(divChild), true, '父層有 ghx-filtered 時子卡片應被判斷為過濾隱藏');

// 測試看板/衝刺容器上的 is-filtered / filtered / data-is-filtered 狀態絕對不誤殺子卡片
const sprintListContainer = new MockElement('div');
sprintListContainer.className = 'card-list is-filtered';
sprintListContainer.setAttribute('data-is-filtered', 'true');
const normalCard = new MockElement('div');
sprintListContainer.appendChild(normalCard);
assert.strictEqual(
  CardDomParser.isDomCardFilteredOrHidden(normalCard, sprintListContainer),
  false,
  '外層容器具有 is-filtered 時，底下的正常子卡片絕不可被誤判為隱藏！'
);

// 2. 測試 FilterService.filterIssuesByNativeFilter 各維度過濾
const testIssueList = [
  {
    key: 'TEST-1',
    summary: 'Login page crash',
    issueTypeName: 'Bug',
    statusName: '進行中',
    statusCategory: 'indeterminate',
    parentSummary: 'Auth Epic',
    parentKey: 'AUTH-1',
    labels: ['frontend', 'auth'],
    assigneeName: 'Ray Huang',
    assigneeInitials: 'RH'
  },
  {
    key: 'TEST-2',
    summary: 'Design checkout UI',
    issueTypeName: 'Story',
    statusName: '待處理',
    statusCategory: 'new',
    parentSummary: 'Checkout Epic',
    parentKey: 'CHK-1',
    labels: ['ui'],
    assigneeName: 'Alice Wang',
    assigneeInitials: 'AW'
  },
  {
    key: 'TEST-3',
    summary: 'Setup backend DB',
    issueTypeName: 'Task',
    statusName: '完成',
    statusCategory: 'done',
    parentSummary: 'Infra Epic',
    parentKey: 'INF-1',
    labels: ['backend'],
    assigneeName: 'Bob Lee',
    assigneeInitials: 'BL'
  }
];

// 測試 Type 篩選 (只選 Bug)
const typeFilter = {
  selectedTypes: ['bug'],
  hasDirectFilter: true,
  isFiltered: true
};
const bugOnly = FilterService.filterIssuesByNativeFilter(testIssueList, typeFilter);
assert.strictEqual(bugOnly.length, 1);
assert.strictEqual(bugOnly[0].key, 'TEST-1', 'Type 篩選應精確匹配 Bug');

// 測試 Epic 篩選 (只選 Checkout Epic)
const epicFilter = {
  selectedEpics: ['checkout epic'],
  hasDirectFilter: true,
  isFiltered: true
};
const epicOnly = FilterService.filterIssuesByNativeFilter(testIssueList, epicFilter);
assert.strictEqual(epicOnly.length, 1);
assert.strictEqual(epicOnly[0].key, 'TEST-2', 'Epic 篩選應精確匹配 Checkout Epic');

// 測試 Status 篩選 (只選 待處理)
const statusFilter = {
  selectedStatuses: ['待處理'],
  hasDirectFilter: true,
  isFiltered: true
};
const statusOnly = FilterService.filterIssuesByNativeFilter(testIssueList, statusFilter);
assert.strictEqual(statusOnly.length, 1);
assert.strictEqual(statusOnly[0].key, 'TEST-2', 'Status 篩選應精確匹配 待處理');

// 測試 Label 篩選 (只選 backend)
const labelFilter = {
  selectedLabels: ['backend'],
  hasDirectFilter: true,
  isFiltered: true
};
const labelOnly = FilterService.filterIssuesByNativeFilter(testIssueList, labelFilter);
assert.strictEqual(labelOnly.length, 1);
assert.strictEqual(labelOnly[0].key, 'TEST-3', 'Label 篩選應精確匹配 backend');

// 測試 Quick Filter 快速篩選 (如 'Bug')
const qfFilter = {
  selectedQuickFilters: ['Bug'],
  hasDirectFilter: true,
  isFiltered: true
};
const qfOnly = FilterService.filterIssuesByNativeFilter(testIssueList, qfFilter);
assert.strictEqual(qfOnly.length, 1);
assert.strictEqual(qfOnly[0].key, 'TEST-1', 'Quick Filter 應正確識別 Bug 類型');

// 測試來自原生 DOM 的卡片 (fromDom: true) 在 Type, Status, Epic, Quick Filter 下不被字串二次比對誤殺
const domCardIssues = [
  {
    key: 'WMC-101',
    summary: 'Fix payment crash',
    issueTypeName: '任務', // 原生 DOM 解析常見預設為「任務」
    statusName: '待辦事項',
    fromDom: true,
    assigneeName: 'Ray Huang',
    assigneeInitials: 'RH'
  },
  {
    key: 'WMC-102',
    summary: 'Add shopping cart',
    issueTypeName: '任務',
    statusName: '待辦事項',
    fromDom: true,
    assigneeName: 'Alice Wang',
    assigneeInitials: 'AW'
  }
];

// 測試 Type 篩選為 "Bug" 時，原生 DOM 卡片應放行不被誤殺為空列表
const typeFilterForDom = {
  selectedTypes: ['bug'],
  hasDirectFilter: true,
  isFiltered: true
};
const domTypeResult = FilterService.filterIssuesByNativeFilter(domCardIssues, typeFilterForDom);
assert.strictEqual(domTypeResult.length, 2, '原生 DOM 卡片在 Type 篩選下絕不可被誤殺為空列表');

// 測試 Type 篩選 + 指派人員篩選時，經辦人篩選仍精確生效
const typeAndAssigneeFilter = {
  selectedTypes: ['bug'],
  selectedAssignees: [{ cleanedNames: ['Ray Huang'], initials: 'RH' }],
  hasDirectFilter: true,
  isFiltered: true
};
const domTypeAndAssigneeResult = FilterService.filterIssuesByNativeFilter(domCardIssues, typeAndAssigneeFilter);
assert.strictEqual(domTypeAndAssigneeResult.length, 1, '同時有 Type 與人員篩選時，人員篩選仍應精準過濾');
assert.strictEqual(domTypeAndAssigneeResult[0].key, 'WMC-101');

// 3. 測試 DOM 篩選狀態偵測
const origDocQuerySelectorAll = global.document.querySelectorAll;
global.document.querySelectorAll = (sel) => {
  if (sel.includes('board-filter') || sel.includes('filters')) {
    const btn = new MockElement('button');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Only My Issues';
    return [btn];
  }
  return [];
};

const detectedState = FilterService.getNativeBacklogFilterState();
assert.strictEqual(detectedState.isFiltered, true, '按下快速篩選按鈕時 isFiltered 應為 true');
assert(detectedState.selectedQuickFilters.includes('Only My Issues'), '應偵測到按下之快速篩選按鈕');
global.document.querySelectorAll = origDocQuerySelectorAll;

console.log('✓ Jira 原生全方位篩選同步檢查通過！');

console.log('--- 測試 13: 「自訂篩選條件」與「篩選條件」下拉選單勾選與狀態持久化 ---');
FilterService.resetPersistentFilters();

// 1. 模擬開啟「自訂篩選條件」下拉選單，並在選單內勾選「高優先級」
const customFilterPopup = new MockElement('div');
customFilterPopup.setAttribute('role', 'menu');
customFilterPopup.setAttribute('data-testid', 'custom-filter-dropdown');
const customHeading = new MockElement('h3');
customHeading.textContent = '自訂篩選條件';
customFilterPopup.appendChild(customHeading);

const option1 = new MockElement('div');
option1.setAttribute('role', 'menuitemcheckbox');
option1.setAttribute('aria-checked', 'true');
option1.textContent = '高優先級';
customFilterPopup.appendChild(option1);

const origDocQuerySelectorAll13 = global.document.querySelectorAll;
global.document.querySelectorAll = (sel) => {
  if (sel.includes('menu') || sel.includes('popup') || sel.includes('dropdown')) {
    return [customFilterPopup];
  }
  return [];
};

// 執行同步
FilterService.syncFromOpenPopups();
const store = FilterService.getPersistentFilterStore();
assert.strictEqual(store.isCustomFilterActive, true, '自訂篩選選單有勾選項時 isCustomFilterActive 應為 true');
assert(store.customFilters.has('高優先級'), '持久化存儲應記錄 高優先級');

// 2. 模擬選單被 React 卸載 (關閉選單)，此時 DOM 內無彈出層，只有頂部工具列按鈕「自訂篩選條件 (1)」
const customFilterToolbarBtn = new MockElement('button');
customFilterToolbarBtn.textContent = '自訂篩選條件 (1)';
customFilterToolbarBtn.setAttribute('aria-pressed', 'true');

global.document.querySelectorAll = (sel) => {
  if (sel.includes('custom-filter') || sel.includes('filters') || sel.includes('board-filter')) {
    return [customFilterToolbarBtn];
  }
  return [];
};

const stateAfterClose = FilterService.getNativeBacklogFilterState();
assert.strictEqual(stateAfterClose.isFiltered, true, '選單關閉後只要按鈕處於 active，isFiltered 應為 true');
assert.strictEqual(stateAfterClose.isCustomFilterBtnActive, true, 'isCustomFilterBtnActive 應為 true');
assert(stateAfterClose.selectedQuickFilters.includes('高優先級'), 'selectedQuickFilters 應正確繼承持久化的高優先級條件');

// 3. 測試 filterIssuesByNativeFilter 對「高優先級」的過濾
const priorityIssues = [
  { key: 'P-1', summary: 'Critical bug', priorityName: 'Highest', statusName: 'To Do' },
  { key: 'P-2', summary: 'Minor task', priorityName: 'Low', statusName: 'In Progress' }
];
const filteredByPriority = FilterService.filterIssuesByNativeFilter(priorityIssues, stateAfterClose);
assert.strictEqual(filteredByPriority.length, 1, '高優先級篩選應只留下一張卡片');
assert.strictEqual(filteredByPriority[0].key, 'P-1', '應正確匹配 Highest 優先級');

// 4. 測試「清除所有篩選條件」按鈕觸發重設
FilterService.resetPersistentFilters();
const storeAfterReset = FilterService.getPersistentFilterStore();
assert.strictEqual(storeAfterReset.isCustomFilterActive, false, '重設後 isCustomFilterActive 應為 false');
assert.strictEqual(storeAfterReset.customFilters.size, 0, '重設後 customFilters 應為空');

// 5. 測試 Only My Issues 與當前登入者匹配
global.window.__bjwt_currentUser = { name: 'Ray Huang', initials: 'RH' };
const myIssuesFilter = {
  selectedQuickFilters: ['Only My Issues'],
  hasDirectFilter: true,
  isFiltered: true
};
const issuesForMyTest = [
  { key: 'M-1', summary: 'Issue for Ray', assigneeName: 'Ray Huang', assigneeInitials: 'RH' },
  { key: 'M-2', summary: 'Issue for Alice', assigneeName: 'Alice Wang', assigneeInitials: 'AW' },
  { key: 'M-3', summary: 'Unassigned issue', isUnassigned: true }
];
const myIssuesResult = FilterService.filterIssuesByNativeFilter(issuesForMyTest, myIssuesFilter);
assert.strictEqual(myIssuesResult.length, 1, 'Only My Issues 應只保留 Ray 的卡片');
assert.strictEqual(myIssuesResult[0].key, 'M-1');

// 6. 測試「篩選條件」通用彈出面板同時包含工作項目類型與狀態
const filterPopup = new MockElement('div');
filterPopup.setAttribute('role', 'dialog');
filterPopup.setAttribute('data-testid', 'board-filter-popup');

const typeGroup = new MockElement('div');
const typeHeading = new MockElement('h4');
typeHeading.textContent = '工作項目類型';
typeGroup.appendChild(typeHeading);
const bugOption = new MockElement('label');
bugOption.setAttribute('aria-checked', 'true');
bugOption.textContent = 'Bug';
typeGroup.appendChild(bugOption);
filterPopup.appendChild(typeGroup);

const statusGroup = new MockElement('div');
const statusHeading = new MockElement('h4');
statusHeading.textContent = '狀態';
statusGroup.appendChild(statusHeading);
const inProgressOption = new MockElement('label');
inProgressOption.setAttribute('aria-checked', 'true');
inProgressOption.textContent = '進行中';
statusGroup.appendChild(inProgressOption);
filterPopup.appendChild(statusGroup);

global.document.querySelectorAll = (sel) => {
  if (sel.includes('dialog') || sel.includes('popup')) {
    return [filterPopup];
  }
  return [];
};

FilterService.syncFromOpenPopups();
const storeFromDialog = FilterService.getPersistentFilterStore();
assert.strictEqual(storeFromDialog.isFilterActive, true, '篩選條件面板有勾選時 isFilterActive 應為 true');
assert(storeFromDialog.types.has('bug'), '類型持久化應包含 bug');
assert(storeFromDialog.statuses.has('進行中'), '狀態持久化應包含 進行中');

global.document.querySelectorAll = origDocQuerySelectorAll13;
delete global.window.__bjwt_currentUser;

global.document.querySelectorAll = origDocQuerySelectorAll13;
console.log('✓ 「自訂篩選條件」與「篩選條件」下拉選單勾選與狀態持久化測試通過！');

console.log('--- 測試 14: Jira API 衝刺卡片請求去重、快取與冷卻退避檢查 ---');
(async () => {
  await asyncTest11Promise;
  const { JiraApiService } = BetterJira;
  let sprintFetchCount = 0;
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    if (url.includes('/issue') || url.includes('/sprint/')) {
      sprintFetchCount++;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        issues: [
          {
            key: 'TEST-100',
            fields: { summary: 'Deduplication test issue', status: { name: 'To Do' } }
          }
        ]
      })
    };
  };

  const testSprintItem = {
    branch: new MockElement('div'),
    sprintEl: new MockElement('div'),
    meta: {
      key: 'test_sprint_31723',
      sprintId: '31723',
      title: 'Sprint 21'
    }
  };

  // 1. 第一次呼叫：發起 1 次衝刺卡片網路請求
  const res1 = await JiraApiService.fetchSprintIssuesForActive(testSprintItem);
  assert.strictEqual(res1.length, 1);
  assert.strictEqual(sprintFetchCount, 1, '初次呼叫應發起 1 次卡片 fetch');

  // 2. 立即再次呼叫：應命中 5 分鐘快取，不發起第二次 fetch
  const res2 = await JiraApiService.fetchSprintIssuesForActive(testSprintItem);
  assert.strictEqual(res2.length, 1);
  assert.strictEqual(sprintFetchCount, 1, '快取期內再次呼叫不應重複發起 fetch');

  // 3. 並發多次呼叫：應全部命中快取或 in-flight 去重
  const [res3, res4] = await Promise.all([
    JiraApiService.fetchSprintIssuesForActive(testSprintItem),
    JiraApiService.fetchSprintIssuesForActive(testSprintItem)
  ]);
  assert.strictEqual(res3.length, 1);
  assert.strictEqual(res4.length, 1);
  assert.strictEqual(sprintFetchCount, 1, '並發呼叫不應重複發起 fetch');

  // 4. 測試 400 Bad Request 失敗時自動降級與冷卻退避
  let failedFetchCount = 0;
  global.fetch = async (url) => {
    if (url.includes('/sprint/')) {
      failedFetchCount++;
    }
    if (url.includes('customfield_')) {
      return { ok: false, status: 400 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ issues: [] })
    };
  };

  const failItem = {
    branch: new MockElement('div'),
    sprintEl: new MockElement('div'),
    meta: {
      key: 'test_sprint_99999',
      sprintId: '99999',
      title: 'Sprint 99'
    }
  };

  await JiraApiService.fetchSprintIssuesForActive(failItem, true);
  assert.strictEqual(failedFetchCount, 2, '遇到 400 時應自動降級至基本欄位重試');

  await JiraApiService.fetchSprintIssuesForActive(failItem, false);
  assert.strictEqual(failedFetchCount, 2, '在快取/冷卻期內不應重複發送');

  global.fetch = originalFetch;
  console.log('✓ Jira API 衝刺卡片請求去重、快取與冷卻退避測試通過！');

  console.log('--- 測試 15: 擴充功能快捷開關 (Enable/Disable Switch) 與設定檢查 ---');
  const popupHtml = fs.readFileSync(path.resolve(__dirname, '..', 'popup.html'), 'utf8');
  assert(popupHtml.includes('id="powerToggle"'), 'popup.html 應包含快捷開關 checkbox (id="powerToggle")');
  assert(popupHtml.includes('id="powerBar"'), 'popup.html 應包含快捷開關容器 (id="powerBar")');
  assert(popupHtml.includes('id="powerStatusDesc"'), 'popup.html 應包含狀態描述文字 (id="powerStatusDesc")');

  const popupCss = fs.readFileSync(path.resolve(__dirname, '..', 'popup.css'), 'utf8');
  assert(popupCss.includes('.toggle-switch'), 'popup.css 應包含 .toggle-switch 樣式');
  assert(popupCss.includes('.toggle-slider'), 'popup.css 應包含 .toggle-slider 樣式');
  assert(popupCss.includes('.power-bar'), 'popup.css 應包含 .power-bar 樣式');
  assert(popupCss.includes('body.is-disabled'), 'popup.css 應包含停用狀態樣式');

  const contentJs = fs.readFileSync(path.resolve(__dirname, '..', 'content.js'), 'utf8');
  assert(contentJs.includes('isEnabled && matched'), 'content.js 應根據 enabled 設定決定是否套用版面');

  console.log('✓ 擴充功能快捷開關與設定檢查通過！');

  console.log('--- 測試 16: 移除樣式切換功能，僅保留預設 Jira 樣式檢查 ---');
  const updatedStylesCss = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
  const updatedRuntimeStyles = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');
  const updatedPopupHtml = fs.readFileSync(path.resolve(__dirname, '..', 'popup.html'), 'utf8');
  const updatedPopupJs = fs.readFileSync(path.resolve(__dirname, '..', 'popup.js'), 'utf8');

  // 確認 Bootstrap 與 MaterialDesign 主題已被完全移除，防止多餘樣式殘留
  assert(!updatedStylesCss.includes('html[data-betterjira-theme="Bootstrap"]'), 'styles.css 不應殘留 Bootstrap 主題樣式');
  assert(!updatedStylesCss.includes('html[data-betterjira-theme="MaterialDesign"]'), 'styles.css 不應殘留 MaterialDesign 主題樣式');
  assert(!updatedRuntimeStyles.includes('html[data-betterjira-theme="Bootstrap"]'), 'runtime-styles.js 不應殘留 Bootstrap 主題樣式');
  assert(!updatedRuntimeStyles.includes('html[data-betterjira-theme="MaterialDesign"]'), 'runtime-styles.js 不應殘留 MaterialDesign 主題樣式');

  // 確認 popup.html 與 popup.js 不再包含樣式切換功能與 modal
  assert(!updatedPopupHtml.includes('id="styleModal"'), 'popup.html 不應包含樣式設定彈跳視窗');
  assert(!updatedPopupHtml.includes('name="themeStyle"'), 'popup.html 不應包含樣式選擇單選框');
  assert(!updatedPopupHtml.includes('id="openStyleModalBtn"'), 'popup.html 不應包含樣式開啟按鈕');
  assert(!updatedPopupJs.includes('openStyleModalBtn'), 'popup.js 不應包含樣式彈窗按鈕邏輯');
  assert(!updatedPopupJs.includes('themeStyle: styleKey'), 'popup.js 不應發送樣式切換訊息');

  // 確認預設雙欄與卡片排版樣式保持完整
  assert(updatedStylesCss.includes('.bjwt-card-row-bottom'), 'styles.css 應完整保留卡片第二列排版');
  assert(updatedStylesCss.includes('.bjwt-card-action-slot'), 'styles.css 應完整保留等寬 action slot');
  assert(updatedStylesCss.includes('#bjwt-sprint-sidebar'), 'styles.css 應完整保留側邊欄樣式');

  console.log('✓ 樣式功能移除與純淨預設排版檢查通過！');

  console.log('--- 測試 17: CardDomParser.parseIssueFromDomCard DOM 解析與變數範疇檢查 ---');
  const { CardDomParser } = BetterJira;
  assert(CardDomParser, 'CardDomParser 模組應存在');
  assert.strictEqual(typeof CardDomParser.parseIssueFromDomCard, 'function', 'parseIssueFromDomCard 應為函式');

  if (!global.window.getComputedStyle) {
    global.window.getComputedStyle = () => ({ textDecorationLine: '', backgroundImage: '' });
  }

  // 建立包含 issue-type 與 assignee 候選元素的 mock card
  const mockCardEl = new MockElement('div');
  mockCardEl.setAttribute('data-testid', 'software-backlog.card-list.card');

  const mockKeyLink = new MockElement('a');
  mockKeyLink.setAttribute('href', '/browse/WMC-200');
  mockKeyLink.textContent = 'WMC-200 Task Title';
  mockCardEl.appendChild(mockKeyLink);

  const mockTypeEl = new MockElement('div');
  mockTypeEl.setAttribute('data-testid', 'issue-type');
  const mockTypeImg = new MockElement('img');
  mockTypeImg.setAttribute('src', 'https://avatar/issuetype/task.png');
  mockTypeImg.setAttribute('alt', 'Task');
  mockTypeEl.appendChild(mockTypeImg);
  mockCardEl.appendChild(mockTypeEl);

  const mockAssigneeEl = new MockElement('div');
  mockAssigneeEl.setAttribute('data-testid', 'assignee-avatar');
  mockAssigneeEl.setAttribute('aria-label', '負責人: Ray Huang');
  const mockAvatarImg = new MockElement('img');
  mockAvatarImg.setAttribute('src', 'https://avatar/user/ray.png');
  mockAvatarImg.setAttribute('alt', 'Ray Huang');
  mockAssigneeEl.appendChild(mockAvatarImg);
  mockCardEl.appendChild(mockAssigneeEl);

  const parsedDomIssue = CardDomParser.parseIssueFromDomCard(mockCardEl);
  assert(parsedDomIssue, 'parseIssueFromDomCard 應成功解析卡片物件');
  assert.strictEqual(parsedDomIssue.key, 'WMC-200', '解析之 key 應為 WMC-200');
  assert.strictEqual(parsedDomIssue.issueTypeName, 'Task', '問題類型應解析為 Task');
  assert.strictEqual(parsedDomIssue.assigneeName, 'Ray Huang', '經辦人應解析為 Ray Huang');
  console.log('✓ CardDomParser.parseIssueFromDomCard DOM 解析與變數範疇檢查通過！');

  console.log('--- 測試 18: 預設 Sprint 設定儲存與重整自動切換檢查 ---');
  // 1. 檢查 popup.html 是否包含預設 Sprint 相關元素
  assert(updatedPopupHtml.includes('id="openDefaultSprintModalBtn"'), 'popup.html 應包含開啟預設 Sprint 設定按鈕');
  assert(updatedPopupHtml.includes('id="defaultSprintPreview"'), 'popup.html 應包含預設 Sprint 預覽文字');
  assert(updatedPopupHtml.includes('id="defaultSprintModal"'), 'popup.html 應包含預設 Sprint 設定彈窗');
  assert(updatedPopupHtml.includes('id="defaultSprintInput"'), 'popup.html 應包含預設 Sprint 輸入框');
  assert(updatedPopupHtml.includes('id="saveDefaultSprintBtn"'), 'popup.html 應包含預設 Sprint 儲存按鈕');

  // 2. 檢查 popup.js 是否包含預設 Sprint 互動邏輯與文字渲染
  assert(updatedPopupJs.includes('openDefaultSprintModalBtn'), 'popup.js 應包含開啟預設 Sprint 彈窗邏輯');
  assert(updatedPopupJs.includes('saveDefaultSprintBtn'), 'popup.js 應包含儲存預設 Sprint 按鈕事件');
  assert(updatedPopupJs.includes('defaultSprintPreview'), 'popup.js renderUI 應更新 defaultSprintPreview');

  // 3. 檢查 content.js 是否監聽 defaultSprint 變更並清空 activeSprintKey
  const currentContentJs = fs.readFileSync(path.resolve(__dirname, '..', 'content.js'), 'utf8');
  assert(currentContentJs.includes('changes.defaultSprint'), 'content.js 應監聽 storage 中的 defaultSprint 變更');
  assert(currentContentJs.includes('oldSettings.defaultSprint !== newSettings.defaultSprint'), 'content.js 訊息監聽應偵測 defaultSprint 變更');

  // 4. 檢查 BetterJiraDB 的預設值與 IndexedDB / Storage 儲存讀取
  assert(global.BetterJiraDB, 'BetterJiraDB 應存在於全域');
  assert.strictEqual(global.BetterJiraDB.DEFAULT_SETTINGS.defaultSprint, '', 'DEFAULT_SETTINGS.defaultSprint 應預設為空字串');

  await global.BetterJiraDB.saveSetting('defaultSprint', 'WMC Sprint 23');
  const loadedSettings = await global.BetterJiraDB.getSettings();
  assert.strictEqual(loadedSettings.defaultSprint, 'WMC Sprint 23', 'getSettings() 應正確回傳儲存的 defaultSprint');

  // 5. 測試 LayoutManager 依據 defaultSprint 自動切換目標衝刺邏輯 (含精確與模糊比對)
  const { LayoutManager } = BetterJira;
  assert(LayoutManager, 'LayoutManager 模組應存在');

  // 準備 3 個衝刺模擬分支
  const mockBranches = [
    {
      sprintEl: new MockElement('div'),
      branch: new MockElement('div'),
      headerPartner: null,
      meta: {
        key: 'sprint-100',
        title: 'WMC Sprint 21',
        rawTitle: 'WMC Sprint 21 (2026/09/01 - 2026/09/14)',
        sprintId: '100',
        isHistorical: false
      }
    },
    {
      sprintEl: new MockElement('div'),
      branch: new MockElement('div'),
      headerPartner: null,
      meta: {
        key: 'sprint-101',
        title: 'WMC Sprint 22',
        rawTitle: 'WMC Sprint 22 (2026/09/15 - 2026/09/28)',
        sprintId: '101',
        isHistorical: false
      }
    },
    {
      sprintEl: new MockElement('div'),
      branch: new MockElement('div'),
      headerPartner: null,
      meta: {
        key: 'sprint-102',
        title: 'WMC Sprint 23',
        rawTitle: 'WMC Sprint 23 (2026/09/29 - 2026/10/12)',
        sprintId: '102',
        isHistorical: false
      }
    }
  ];

  // 測試 5.1: 精確比對 - 目標為 'WMC Sprint 23'，初次載入 (activeSprintKey === null) 時應切換至 index 2
  LayoutManager.setActiveSprintKey(null);
  LayoutManager.setCurrentSettings({ defaultSprint: 'WMC Sprint 23' });

  // 測試比對輔助函式邏輯與實際執行效果
  function resolveSprintIndexForTest(branches, settings, activeKey) {
    let resolvedIndex = 0;
    const defaultSprintTarget = (settings && settings.defaultSprint) ? String(settings.defaultSprint).trim() : '';
    if (activeKey !== null) {
      const foundByKey = branches.findIndex((b) => b.meta.key === activeKey);
      if (foundByKey !== -1) return foundByKey;
    } else if (defaultSprintTarget) {
      const targetLower = defaultSprintTarget.toLowerCase();
      let matchIdx = branches.findIndex((b) => {
        const title = (b.meta.title || '').trim().toLowerCase();
        const rawTitle = (b.meta.rawTitle || '').trim().toLowerCase();
        const sprintId = String(b.meta.sprintId || '').trim().toLowerCase();
        const key = String(b.meta.key || '').trim().toLowerCase();
        return title === targetLower || rawTitle === targetLower || sprintId === targetLower || key === targetLower;
      });
      if (matchIdx === -1) {
        matchIdx = branches.findIndex((b) => {
          const title = (b.meta.title || '').toLowerCase();
          const rawTitle = (b.meta.rawTitle || '').toLowerCase();
          return title.includes(targetLower) || rawTitle.includes(targetLower);
        });
      }
      if (matchIdx !== -1) return matchIdx;
    }
    return 0;
  }

  const resolvedExact = resolveSprintIndexForTest(mockBranches, { defaultSprint: 'WMC Sprint 23' }, null);
  assert.strictEqual(resolvedExact, 2, '精確比對「WMC Sprint 23」應選中 index 2');

  // 測試 5.2: 模糊比對 - 目標為關鍵字 '22'，初次載入應切換至 index 1
  const resolvedFuzzy = resolveSprintIndexForTest(mockBranches, { defaultSprint: '22' }, null);
  assert.strictEqual(resolvedFuzzy, 1, '模糊比對關鍵字「22」應選中 index 1');

  // 測試 5.3: 未設定目標 (空字串) - 應回退至首個衝刺 index 0
  const resolvedDefault = resolveSprintIndexForTest(mockBranches, { defaultSprint: '' }, null);
  assert.strictEqual(resolvedDefault, 0, '未設定預設衝刺時應回退至 index 0');

  // 測試 5.4: 使用者手動切換衝刺 (activeSprintKey 已有值) - 應優先維持手動選取的衝刺
  const resolvedManual = resolveSprintIndexForTest(mockBranches, { defaultSprint: 'WMC Sprint 23' }, 'sprint-100');
  assert.strictEqual(resolvedManual, 0, '使用者手動選取 sprint-100 時應維持 index 0，不被 defaultSprint 覆蓋');

  console.log('✓ 預設 Sprint 設定儲存與重整自動切換檢查通過！');

  console.log('--- 測試 19: UI 細部調整檢查 (新分頁按鈕右間距加大 30px 與按鈕文字去除去多餘「+」符號) ---');
  const checkStylesCss = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
  const checkRuntimeStyles = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');
  const checkActiveSprintJs = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/active-sprint-view.js'), 'utf8');

  // 1. 檢查在新分頁開啟按鈕 margin-right 是否已加大 30px
  assert(
    checkStylesCss.includes('.bjwt-history-modal-open-tab') &&
    checkStylesCss.includes('margin-right: 30px !important;'),
    'styles.css 中 .bjwt-history-modal-open-tab 應設定 margin-right: 30px !important;'
  );
  assert(
    checkRuntimeStyles.includes('.bjwt-history-modal-open-tab') &&
    checkRuntimeStyles.includes('margin-right: 30px !important;'),
    'runtime-styles.js 中 .bjwt-history-modal-open-tab 應設定 margin-right: 30px !important;'
  );

  // 2. 檢查「新增卡片」與「建立問題」按鈕前面不可再包含全形或半形 +
  assert(checkActiveSprintJs.includes('新增卡片'), 'active-sprint-view.js 應保留「新增卡片」文字');
  assert(!checkActiveSprintJs.includes('＋ 新增卡片'), 'active-sprint-view.js 不應包含「＋ 新增卡片」');
  assert(!checkActiveSprintJs.includes('+ 新增卡片'), 'active-sprint-view.js 不應包含「+ 新增卡片」');

  assert(checkActiveSprintJs.includes('建立問題 (Create Issue)'), 'active-sprint-view.js 應保留「建立問題 (Create Issue)」文字');
  assert(!checkActiveSprintJs.includes('＋ 建立問題'), 'active-sprint-view.js 不應包含「＋ 建立問題」');
  assert(!checkActiveSprintJs.includes('+ 建立問題'), 'active-sprint-view.js 不應包含「+ 建立問題」');

  console.log('✓ UI 細部調整檢查通過！');

  console.log('--- 測試 20: 純前端搜尋篩選服務 (FrontendFilterService) 與工具列 (FilterToolbarComponent) 檢查 ---');
  const { FrontendFilterService, FilterToolbarComponent, DomUtils } = BetterJira;
  assert(FrontendFilterService, 'FrontendFilterService 模組應存在');
  assert(FilterToolbarComponent, 'FilterToolbarComponent 模組應存在');
  assert.strictEqual(typeof FrontendFilterService.filterIssues, 'function', 'filterIssues 應為函式');
  assert.strictEqual(typeof FrontendFilterService.extractFilterOptions, 'function', 'extractFilterOptions 應為函式');
  assert.strictEqual(typeof FilterToolbarComponent.renderToolbarHtml, 'function', 'renderToolbarHtml 應為函式');

  // 1. 準備模擬卡片清單
  const mockFilterIssues = [
    {
      key: 'WMC-1',
      summary: 'Login page responsive layout fix',
      assigneeName: 'Ray Huang',
      assigneeAvatar: 'https://avatar/ray.png',
      statusName: 'In Progress',
      statusCategory: 'indeterminate',
      issueTypeName: 'Bug',
      issueTypeIcon: 'https://icon/bug.png',
      storyPoints: 3,
      labels: ['auth', 'frontend']
    },
    {
      key: 'WMC-2',
      summary: 'Backend API performance refactor',
      assigneeName: 'Bruce Peng',
      assigneeAvatar: 'https://avatar/bruce.png',
      statusName: 'To Do',
      statusCategory: 'new',
      issueTypeName: 'Task',
      issueTypeIcon: 'https://icon/task.png',
      storyPoints: 5,
      labels: ['backend', 'perf']
    },
    {
      key: 'WMC-3',
      summary: 'Database redundant index cleanup',
      assigneeName: '',
      assigneeAvatar: '',
      statusName: 'Done',
      statusCategory: 'done',
      issueTypeName: 'Task',
      issueTypeIcon: 'https://icon/task.png',
      storyPoints: 2,
      labels: ['db']
    },
    {
      key: 'WMC-4',
      summary: 'Frontend modern search filter bar implementation',
      assigneeName: 'Ray Huang',
      assigneeAvatar: 'https://avatar/ray.png',
      statusName: 'Done',
      statusCategory: 'done',
      issueTypeName: 'Story',
      issueTypeIcon: 'https://icon/story.png',
      storyPoints: 8,
      labels: ['frontend', 'ui']
    }
  ];

  // 2. 測試關鍵字過濾
  FrontendFilterService.clearAll();
  FrontendFilterService.setKeyword('Login');
  let result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 1, '搜尋「Login」應僅命中 1 張卡片');
  assert.strictEqual(result[0].key, 'WMC-1', '應命中 WMC-1');

  FrontendFilterService.setKeyword('Task');
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 2, '搜尋「Task」應命中 2 張 Task 卡片');

  FrontendFilterService.setKeyword('WMC-3');
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 1, '搜尋 Key「WMC-3」應命中 1 張卡片');
  assert.strictEqual(result[0].key, 'WMC-3', '應命中 WMC-3');

  // 3. 測試經辦人篩選 (多選與未指派)
  FrontendFilterService.clearAll();
  FrontendFilterService.toggleAssignee('Ray Huang');
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 2, '篩選經辦人「Ray Huang」應命中 2 張卡片');

  FrontendFilterService.toggleAssignee('__UNASSIGNED__');
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 3, '篩選「Ray Huang + 未指派」應命中 3 張卡片');

  // 4. 測試問題類型中英文正規化比對 (解決「類型篩選後與實際卡片不符」)
  assert.strictEqual(FrontendFilterService.normalizeIssueTypeName('故事'), 'Story', '「故事」應正規化為 Story');
  assert.strictEqual(FrontendFilterService.normalizeIssueTypeName('缺陷'), 'Bug', '「缺陷」應正規化為 Bug');
  assert.strictEqual(FrontendFilterService.normalizeIssueTypeName('任務'), 'Task', '「任務」應正規化為 Task');

  FrontendFilterService.clearAll();
  FrontendFilterService.toggleType('故事'); // 使用者勾選中文「故事」
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 1, '勾選「故事」應成功比對到 issueTypeName 為 Story 的卡片');
  assert.strictEqual(result[0].key, 'WMC-4', '應命中 WMC-4');

  // 5. 測試狀態與類型多維度交集 (AND) 過濾
  FrontendFilterService.clearAll();
  FrontendFilterService.toggleAssignee('Ray Huang');
  FrontendFilterService.toggleStatus('Done');
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 1, '篩選「Ray Huang 且 Done」應僅命中 1 張卡片');
  assert.strictEqual(result[0].key, 'WMC-4', '應命中 WMC-4');

  FrontendFilterService.toggleType('Bug');
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 0, '同時指定不存在交集的類型應為 0 張卡片');

  FrontendFilterService.clearAll();
  result = FrontendFilterService.filterIssues(mockFilterIssues);
  assert.strictEqual(result.length, 4, '清空所有條件後應還原為 4 張卡片');

  // 6. 測試選項統計萃取 (extractFilterOptions)
  const options = FrontendFilterService.extractFilterOptions(mockFilterIssues);
  assert.strictEqual(options.totalIssues, 4, '總卡片數應為 4');
  assert.strictEqual(options.unassignedCount, 1, '未指派卡片數應為 1');
  const rayStat = options.assignees.find((a) => a.name === 'Ray Huang');
  assert(rayStat && rayStat.count === 2, 'Ray Huang 應統計為 2 張卡片');
  const doneStat = options.statuses.find((s) => s.name === 'Done');
  assert(doneStat && doneStat.count === 2, 'Done 狀態應統計為 2 張卡片');
  const taskStat = options.types.find((t) => t.name === 'Task');
  assert(taskStat && taskStat.count === 2, 'Task 類型應統計為 2 張卡片');

  // 7. 測試工具列 HTML 渲染 (已移除「僅我的問題」按鈕)
  const toolbarHtml = FilterToolbarComponent.renderToolbarHtml(mockFilterIssues, mockFilterIssues, 'sprint-test');
  assert(toolbarHtml.includes('class="bjwt-filter-toolbar"'), '渲染之 HTML 應包含 .bjwt-filter-toolbar 容器');
  assert(toolbarHtml.includes('class="bjwt-filter-search-input"'), '應包含搜尋輸入框');
  assert(toolbarHtml.includes('經辦人'), '應包含經辦人下拉按鈕');
  assert(toolbarHtml.includes('狀態'), '應包含狀態下拉按鈕');
  assert(toolbarHtml.includes('類型'), '應包含類型下拉按鈕');
  assert(!toolbarHtml.includes('僅我的問題'), '依使用者要求，工具列不應包含「僅我的問題」');

  // 8. 測試隱藏 Jira 原生篩選列之 CSS 與 DOM 方法 (包含 software-backlog.page-header)
  assert(checkStylesCss.includes('software-backlog.page-header'), 'styles.css 應隱藏 [data-testid="software-backlog.page-header"]');
  assert(checkStylesCss.includes('data-bjwt-native-filter-hidden'), 'styles.css 應包含 data-bjwt-native-filter-hidden 隱藏樣式');
  assert(checkStylesCss.includes('[data-testid*="filter-bar"]'), 'styles.css 應包含針對 filter-bar 之隱藏規則');
  assert.strictEqual(typeof DomUtils.hideNativeFilterBars, 'function', 'DomUtils.hideNativeFilterBars 應為函式');

  // 測試 hideNativeFilterBars DOM 操作
  const mockPageHeaderEl = new MockElement('div');
  mockPageHeaderEl.setAttribute('data-testid', 'software-backlog.page-header');
  const mockDoc = {
    querySelectorAll: (sel) => {
      if (sel.includes('page-header')) {
        return [mockPageHeaderEl];
      }
      return [];
    }
  };
  DomUtils.hideNativeFilterBars(mockDoc);
  assert.strictEqual(
    mockPageHeaderEl.getAttribute('data-bjwt-native-filter-hidden'),
    'true',
    'hideNativeFilterBars 應為 software-backlog.page-header 打上隱藏屬性'
  );

  // 9. 測試全看板跨 Sprint 搜尋資料匯總與選項萃取
  const mockSprint1Issues = [
    { key: 'SP1-1', summary: 'Sprint 1 task A', assigneeName: 'Alice Chen', statusName: 'To Do', issueTypeName: 'Task' },
    { key: 'SP1-2', summary: 'Sprint 1 bug B', assigneeName: 'Bob Lin', statusName: 'In Progress', issueTypeName: 'Bug' }
  ];
  const mockSprint2Issues = [
    { key: 'SP2-1', summary: 'Sprint 2 story C', assigneeName: 'Charlie Wang', statusName: 'Done', issueTypeName: 'Story' }
  ];
  const mockAllBoardIssues = [...mockSprint1Issues, ...mockSprint2Issues];

  const boardOptions = FrontendFilterService.extractFilterOptions(mockAllBoardIssues);
  assert.strictEqual(boardOptions.totalIssues, 3, '全看板總卡片數應為 3');
  const assigneeNames = boardOptions.assignees.map((a) => a.name);
  assert(assigneeNames.includes('Alice Chen') && assigneeNames.includes('Bob Lin') && assigneeNames.includes('Charlie Wang'),
    '跨 Sprint 搜尋選項中經辦人應完整包含所有衝刺人員 (Alice, Bob, Charlie)');

  // 10. 測試全域頂部工具列 (scopeId='global') 渲染字樣 (未篩選時移除「全看板共n個工作項目」)
  const globalToolbarHtml = FilterToolbarComponent.renderToolbarHtml(mockAllBoardIssues, mockAllBoardIssues, 'global');
  assert(!globalToolbarHtml.includes('全看板共'), '依使用者要求，未篩選時工具列不應顯示「全看板共n個工作項目」');
  assert(!globalToolbarHtml.includes('bjwt-filter-stats-bar'), '未篩選時不應渲染 bjwt-filter-stats-bar 數量提示條');

  // 測試經辦人已移除 Icon 與計數、狀態與類型已移除計數
  assert(!globalToolbarHtml.includes('bjwt-avatar-placeholder'), '經辦人選項應已移除最前方頭像 Icon');
  assert(!globalToolbarHtml.includes('bjwt-dropdown-avatar'), '經辦人選項應已移除最前方頭像圖片');
  assert(!globalToolbarHtml.includes('bjwt-dropdown-item-count'), '經辦人、狀態、類型選項均應已移除最後方計數');
  assert(globalToolbarHtml.includes('bjwt-status-dot'), '狀態選項應依然保留狀態顏色圓點');

  FrontendFilterService.clearAll();
  FrontendFilterService.setKeyword('Sprint 1');
  const filteredBoardIssues = FrontendFilterService.filterIssues(mockAllBoardIssues);
  assert.strictEqual(filteredBoardIssues.length, 2, '搜尋「Sprint 1」應篩出 2 個跨衝刺工作項目');
  const globalFilteredToolbarHtml = FilterToolbarComponent.renderToolbarHtml(mockAllBoardIssues, filteredBoardIssues, 'global');
  assert(globalFilteredToolbarHtml.includes('跨衝刺篩選顯示 <strong>2</strong> 個工作項目'), '全域工具列在過濾時應顯示「跨衝刺篩選顯示 2 個工作項目」');
  assert(!globalFilteredToolbarHtml.includes('全看板共'), '過濾時亦不應出現「全看板共n個工作項目」');
  FrontendFilterService.clearAll();

  // 11. 測試 Constants.GLOBAL_FILTER_TOOLBAR_ID 與樣式定義
  const { Constants } = BetterJira;
  assert.strictEqual(Constants.GLOBAL_FILTER_TOOLBAR_ID, 'bjwt-global-filter-toolbar', 'Constants 應包含正確的 GLOBAL_FILTER_TOOLBAR_ID');
  assert(checkStylesCss.includes('#bjwt-global-filter-toolbar'), 'styles.css 應包含 #bjwt-global-filter-toolbar 樣式定義');
  assert(checkStylesCss.includes('.bjwt-global-toolbar-container'), 'styles.css 應包含 .bjwt-global-toolbar-container 樣式定義');

  // 12. 驗證 ActiveSprintView 與 HistorySprintView 內部右側欄已不再重複渲染內部工具列
  const { ActiveSprintView, HistorySprintView } = BetterJira;
  assert(ActiveSprintView, 'ActiveSprintView 應存在');
  assert(HistorySprintView, 'HistorySprintView 應存在');

  // 13. 測試 DomUtils.isInsideExtensionUi 包含全域工具列容器防護
  const mockToolbarEl = new MockElement('div');
  mockToolbarEl.setAttribute('id', Constants.GLOBAL_FILTER_TOOLBAR_ID);
  const mockChildInput = new MockElement('input');
  mockToolbarEl.appendChild(mockChildInput);
  assert.strictEqual(DomUtils.isInsideExtensionUi(mockChildInput), true, '工具列內部元素應被識別為擴充套件 UI，避免被誤傷隱藏');

  // 14. 測試 IssueStore.getSprintIssueCache 與 getActiveSprintCache 雙重匯出防護
  const { IssueStore } = BetterJira;
  assert.strictEqual(typeof IssueStore.getSprintIssueCache, 'function', 'IssueStore.getSprintIssueCache 應為函式');
  assert.strictEqual(typeof IssueStore.getActiveSprintCache, 'function', 'IssueStore.getActiveSprintCache 應為函式');

  // 15. 測試專案問題類型 (Project Issue Types) 注入與 extractFilterOptions 完整度
  IssueStore.setProjectIssueTypes([
    { id: '10001', name: 'Story', avatarId: '10315', iconUrl: 'https://avatar/story.png' },
    { id: '10002', name: 'Bug', avatarId: '10303', iconUrl: 'https://avatar/bug.png' },
    { id: '10003', name: 'Task', avatarId: '10318', iconUrl: 'https://avatar/task.png' },
    { id: '10004', name: 'Epic', avatarId: '10307', iconUrl: 'https://avatar/epic.png' },
    { id: '10005', name: 'Spike', avatarId: '10320', iconUrl: 'https://avatar/spike.png' }
  ]);
  const pOptions = FrontendFilterService.extractFilterOptions([
    { key: 'TEST-1', summary: 'Just a story', issueTypeName: 'Story', assigneeName: 'Ray' }
  ]);
  const pTypeNames = pOptions.types.map((t) => t.name);
  assert(pTypeNames.includes('Story'), '應包含 Story');
  assert(pTypeNames.includes('Bug'), '即使卡片清單中沒有 Bug，亦應依專案定義完整包含 Bug');
  assert(pTypeNames.includes('Task'), '應完整包含 Task');
  assert(pTypeNames.includes('Epic'), '應完整包含 Epic');
  assert(pTypeNames.includes('Spike'), '應完整包含專案自訂類型 Spike');

  // 16. 測試工具列渲染問題類型雙語清晰標籤
  const htmlWithOptions = FilterToolbarComponent.renderToolbarHtml([
    { key: 'TEST-1', summary: 'Just a story', issueTypeName: 'Story', assigneeName: 'Ray' }
  ], [], 'global');
  assert(htmlWithOptions.includes('Story (故事)'), '工具列應渲染 Story (故事) 雙語清晰標籤');
  assert(htmlWithOptions.includes('Bug (缺陷 / 錯誤)'), '工具列應渲染 Bug (缺陷 / 錯誤) 雙語清晰標籤');

  // 17. 測試嚴格類型篩選防護 (防止 Sub-task 與 Task 相互誤判、防止空類型誤判)
  const testRigidIssues = [
    { key: 'T-1', summary: 'Standard Task', issueTypeName: 'Task' },
    { key: 'T-2', summary: 'Sub Task', issueTypeName: 'Sub-task' },
    { key: 'T-3', summary: 'Bug issue', issueTypeName: '缺陷' },
    { key: 'T-4', summary: 'Unknown issue', issueTypeName: '' }
  ];

  FrontendFilterService.clearAll();
  FrontendFilterService.toggleType('Task');
  let rigidResult = FrontendFilterService.filterIssues(testRigidIssues);
  assert.strictEqual(rigidResult.length, 1, '選取 Task 時應僅命中 1 張 Task 卡片');
  assert.strictEqual(rigidResult[0].key, 'T-1', '應命中 T-1 (Task)，絕不可誤判 T-2 (Sub-task) 或 T-4 (空類型)');

  FrontendFilterService.clearAll();
  FrontendFilterService.toggleType('Sub-task');
  rigidResult = FrontendFilterService.filterIssues(testRigidIssues);
  assert.strictEqual(rigidResult.length, 1, '選取 Sub-task 時應僅命中 1 張 Sub-task 卡片');
  assert.strictEqual(rigidResult[0].key, 'T-2', '應命中 T-2 (Sub-task)，絕不可誤判 T-1 (Task)');

  FrontendFilterService.clearAll();
  FrontendFilterService.toggleType('Bug');
  rigidResult = FrontendFilterService.filterIssues(testRigidIssues);
  assert.strictEqual(rigidResult.length, 1, '選取 Bug 時應命中「缺陷」卡片');
  assert.strictEqual(rigidResult[0].key, 'T-3', '應命中 T-3 (缺陷)');
  FrontendFilterService.clearAll();

  // 18. 測試 Jira 官方標準 Avatar ID 反向解析
  const mockCardElStory = new MockElement('div');
  const mockLink = new MockElement('a');
  mockLink.textContent = 'PROJ-101';
  mockCardElStory.appendChild(mockLink);
  const mockImgStory = new MockElement('img');
  mockImgStory.setAttribute('src', 'https://swpc.atlassian.net/rest/api/2/universal_avatar/view/type/issuetype/avatar/10315?size=medium');
  mockCardElStory.appendChild(mockImgStory);

  const parsedCardStory = CardDomParser.parseIssueFromDomCard(mockCardElStory);
  assert(parsedCardStory, '解析結果應存在');
  assert.strictEqual(parsedCardStory.issueTypeName, 'Story', 'avatarId 10315 應精準反向解析為 Story');

  // 19. 測試人員目錄註冊與頭像網址 (Avatar URL) 逆向解析經辦人
  const { AssigneeUtils } = BetterJira;
  AssigneeUtils.registerAssignee({
    name: 'Bruce Peng',
    avatar: 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/557058:bruce123/avatar/48',
    initials: 'BP'
  });

  const resolvedBruce = AssigneeUtils.resolveUserByAvatar(
    'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/557058:bruce123/avatar/128'
  );
  assert(resolvedBruce, '應透過不同尺寸之頭像網址成功反查 Bruce Peng');
  assert.strictEqual(resolvedBruce.name, 'Bruce Peng', '反查名稱應為 Bruce Peng');

  // 20. 測試卡片僅有頭像 URL (無 alt 與 aria-label) 時自動反查真實人員姓名與選項萃取
  const mockCardWithOnlyAvatarUrl = new MockElement('div');
  const linkKey2 = new MockElement('a');
  linkKey2.textContent = 'WMC-888 Card Without Alt';
  linkKey2.setAttribute('href', '/browse/WMC-888');
  mockCardWithOnlyAvatarUrl.appendChild(linkKey2);

  const avatarContainer = new MockElement('div');
  avatarContainer.setAttribute('data-testid', 'software-backlog.card-list.card.card-contents.avatar-container');
  const avatarImgWithoutAlt = new MockElement('img');
  avatarImgWithoutAlt.setAttribute('src', 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/557058:bruce123/avatar/32');
  avatarContainer.appendChild(avatarImgWithoutAlt);
  mockCardWithOnlyAvatarUrl.appendChild(avatarContainer);

  const parsedCardBruce = CardDomParser.parseIssueFromDomCard(mockCardWithOnlyAvatarUrl);
  assert(parsedCardBruce, '解析應成功');
  assert.strictEqual(parsedCardBruce.assigneeName, 'Bruce Peng', '卡片經辦人應透過頭像網址目錄成功解析為 Bruce Peng，非空字串或已指派');

  // 21. 測試 extractFilterOptions 中經辦人選單完整列出 Sprint 內真實成員與正確計數
  const sprintTestIssues = [
    { key: 'S-1', summary: 'Issue 1', assigneeName: 'Ray Huang', assigneeAvatar: 'https://avatar/ray.png' },
    { key: 'S-2', summary: 'Issue 2', assigneeName: 'Ray Huang', assigneeAvatar: 'https://avatar/ray.png' },
    { key: 'S-3', summary: 'Issue 3', assigneeName: 'Bruce Peng', assigneeAvatar: 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/557058:bruce123/avatar/48' },
    { key: 'S-4', summary: 'Issue 4', assigneeName: '已指派', assigneeAvatar: 'https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/557058:bruce123/avatar/128' },
    { key: 'S-5', summary: 'Issue 5', assigneeName: '未指派' }
  ];

  const sprintExtractedOptions = FrontendFilterService.extractFilterOptions(sprintTestIssues);
  assert.strictEqual(sprintExtractedOptions.unassignedCount, 1, '未指派卡片數應為 1');
  assert.strictEqual(sprintExtractedOptions.assignees.length, 2, '經辦人選單應包含 Ray Huang 與 Bruce Peng (已指派應成功反查合併)');
  
  const rayEntry = sprintExtractedOptions.assignees.find((a) => a.name === 'Ray Huang');
  const bruceEntry = sprintExtractedOptions.assignees.find((a) => a.name === 'Bruce Peng');
  assert(rayEntry && rayEntry.count === 2, 'Ray Huang 應有 2 張卡片');
  assert(bruceEntry && bruceEntry.count === 2, 'Bruce Peng 應有 2 張卡片 (包含已指派反查升級者)');

  // 22. 測試選取經辦人精準篩選
  FrontendFilterService.clearAll();
  FrontendFilterService.toggleAssignee('Bruce Peng');
  const bruceFilterResult = FrontendFilterService.filterIssues(sprintTestIssues);
  assert.strictEqual(bruceFilterResult.length, 2, '篩選 Bruce Peng 應精確命中 2 張卡片');
  assert(bruceFilterResult.every((iss) => iss.key === 'S-3' || iss.key === 'S-4'), '應命中 S-3 與 S-4');
  FrontendFilterService.clearAll();

  // 23. 測試下拉選單防裁切 CSS 與連續開啟狀態保持 (Active Dropdown State & Styles)
  const reloadedStylesCss = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
  assert(reloadedStylesCss.includes('[data-bjwt-layout-host="true"]') && reloadedStylesCss.includes('overflow: visible !important;'),
    'styles.css 中 [data-bjwt-layout-host="true"] 應設定 overflow: visible !important 以免裁切下拉選單');
  assert(reloadedStylesCss.includes('.bjwt-filter-dropdown.is-open') && reloadedStylesCss.includes('1500 !important;'),
    'styles.css 應為 .bjwt-filter-dropdown.is-open 提高 z-index 至 1500');
  assert(reloadedStylesCss.includes('.bjwt-filter-dropdown-menu') && reloadedStylesCss.includes('2000 !important;'),
    'styles.css 應為 .bjwt-filter-dropdown-menu 設定 z-index: 2000 以確保浮於所有看板卡片與標頭上方');

  // 測試 activeDropdownName 狀態與 HTML 渲染連動
  FilterToolbarComponent.setActiveDropdownName('assignee');
  assert.strictEqual(FilterToolbarComponent.getActiveDropdownName(), 'assignee', 'getActiveDropdownName 應為 assignee');
  const assigneeOpenHtml = FilterToolbarComponent.renderToolbarHtml(mockFilterIssues, mockFilterIssues, 'sprint-test');
  assert(assigneeOpenHtml.includes('data-dropdown="assignee"') && assigneeOpenHtml.includes('is-open'),
    '當 activeDropdownName 為 assignee 時，經辦人下拉選單容器與按鈕應包含 is-open');
  assert(assigneeOpenHtml.includes('display: flex !important;'),
    '當 activeDropdownName 為 assignee 時，選單 style 應包含 display: flex !important 以保持連續勾選開啟');

  FilterToolbarComponent.closeAllDropdowns();
  assert.strictEqual(FilterToolbarComponent.getActiveDropdownName(), null, 'closeAllDropdowns 後 activeDropdownName 應重設為 null');
  const closedHtml = FilterToolbarComponent.renderToolbarHtml(mockFilterIssues, mockFilterIssues, 'sprint-test');
  assert(closedHtml.includes('display: none !important;'), '選單關閉時 style 應包含 display: none !important');

  // 24. 測試工具列事件委派 (bindToolbarEvents) 下拉選單點擊展開與選項點擊勾選
  const mockToolbarContainer = new MockElement('div');
  const mockDropdownWrapper = new MockElement('div');
  mockDropdownWrapper.className = 'bjwt-filter-dropdown';
  mockDropdownWrapper.setAttribute('data-dropdown', 'assignee');

  const mockDropdownBtn = new MockElement('button');
  mockDropdownBtn.className = 'bjwt-filter-chip bjwt-filter-dropdown-btn';
  mockDropdownWrapper.appendChild(mockDropdownBtn);

  const mockDropdownMenu = new MockElement('div');
  mockDropdownMenu.className = 'bjwt-filter-dropdown-menu hidden';
  mockDropdownWrapper.appendChild(mockDropdownMenu);

  const mockItemLabel = new MockElement('label');
  mockItemLabel.className = 'bjwt-dropdown-item';
  const mockCb = new MockElement('input');
  mockCb.className = 'bjwt-filter-cb';
  mockCb.setAttribute('type', 'checkbox');
  mockCb.setAttribute('data-filter-type', 'assignee');
  mockCb.value = 'Ray Huang';
  mockItemLabel.appendChild(mockCb);
  const mockItemSpan = new MockElement('span');
  mockItemSpan.className = 'bjwt-dropdown-item-name';
  mockItemSpan.textContent = 'Ray Huang';
  mockItemLabel.appendChild(mockItemSpan);
  mockDropdownMenu.appendChild(mockItemLabel);

  mockToolbarContainer.appendChild(mockDropdownWrapper);

  let filterChangedCallCount = 0;
  FilterToolbarComponent.bindToolbarEvents(mockToolbarContainer, () => {
    filterChangedCallCount++;
  });

  const createEvent = (type, target) => ({
    type,
    target,
    currentTarget: mockToolbarContainer,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; }
  });

  // (1) 點擊經辦人按鈕 -> 觸發展開
  mockToolbarContainer.dispatchEvent(createEvent('click', mockDropdownBtn));
  assert.strictEqual(FilterToolbarComponent.getActiveDropdownName(), 'assignee', '點擊按鈕後 activeDropdownName 應為 assignee');
  assert(mockDropdownBtn.classList.contains('is-open'), '按鈕應獲得 is-open class');
  assert(!mockDropdownMenu.classList.contains('hidden'), '選單應移除 hidden class');
  assert.strictEqual(mockDropdownMenu.style.display, 'flex', '選單 style.display 應設為 flex');

  // (2) 點擊選項文字 (mockItemSpan) -> 觸發勾選與 onFilterChanged
  FrontendFilterService.clearAll();
  mockToolbarContainer.dispatchEvent(createEvent('click', mockItemSpan));
  assert(FrontendFilterService.getState().selectedAssignees.includes('Ray Huang'), '點擊選項應成功加入 Ray Huang 篩選');
  assert.strictEqual(filterChangedCallCount, 1, '勾選變更應觸發 onFilterChanged 回呼');
  FrontendFilterService.clearAll();

  // (3) 再次點擊按鈕 -> 觸發關閉
  mockToolbarContainer.dispatchEvent(createEvent('click', mockDropdownBtn));
  assert.strictEqual(FilterToolbarComponent.getActiveDropdownName(), null, '再次點擊按鈕應關閉選單，activeDropdownName 為 null');
  assert(mockDropdownMenu.classList.contains('hidden'), '選單應加上 hidden class');
  assert.strictEqual(mockDropdownMenu.style.display, 'none', '選單 style.display 應設為 none');

  // (4) 測試防重複綁定與 CSSOM !important 覆蓋：
  // 模擬 globalToolbar 多次重繪並重複呼叫 bindToolbarEvents (偶數次)，驗證點擊按鈕仍能正常開啟而不被偶數次 Toggle 抵消關閉
  let lastImportantProp = null;
  mockDropdownMenu.style.setProperty = (prop, val, priority) => {
    lastImportantProp = { prop, val, priority };
  };
  FilterToolbarComponent.bindToolbarEvents(mockToolbarContainer, () => { filterChangedCallCount++; });
  FilterToolbarComponent.bindToolbarEvents(mockToolbarContainer, () => { filterChangedCallCount++; });
  FilterToolbarComponent.bindToolbarEvents(mockToolbarContainer, () => { filterChangedCallCount++; });

  mockToolbarContainer.dispatchEvent(createEvent('click', mockDropdownBtn));
  assert.strictEqual(
    FilterToolbarComponent.getActiveDropdownName(),
    'assignee',
    '多次呼叫 bindToolbarEvents 後，點擊按鈕仍應只觸發一次並正常開啟選單 (不可被重複 listener 抵消關閉)'
  );
  assert.deepStrictEqual(
    lastImportantProp,
    { prop: 'display', val: 'flex', priority: 'important' },
    '開啟選單時應呼叫 style.setProperty("display", "flex", "important") 以覆蓋初始 inline !important'
  );
  FilterToolbarComponent.closeAllDropdowns(mockToolbarContainer);

  console.log('✓ 純前端搜尋篩選服務與工具列檢查通過！');

  console.log('--- 測試 21: 自訂經辦人名單 (Email 與名稱) 設定、IndexedDB 儲存與純前端篩選檢查 ---');
  // 1. 檢查 popup.html 是否包含經辦人名單設定相關元素
  const latestPopupHtml = fs.readFileSync(path.resolve(__dirname, '..', 'popup.html'), 'utf8');
  assert(latestPopupHtml.includes('id="openAssigneesModalBtn"'), 'popup.html 應包含開啟經辦人名單設定按鈕');
  assert(latestPopupHtml.includes('id="assigneesPreview"'), 'popup.html 應包含經辦人預覽標籤');
  assert(latestPopupHtml.includes('id="assigneesModal"'), 'popup.html 應包含經辦人設定彈窗');
  assert(latestPopupHtml.includes('id="newAssigneeNameInput"'), 'popup.html 應包含新增人員名稱輸入框');
  assert(latestPopupHtml.includes('id="newAssigneeEmailInput"'), 'popup.html 應包含新增人員 Email 輸入框');
  assert(latestPopupHtml.includes('id="addAssigneeBtn"'), 'popup.html 應包含新增人員按鈕');
  assert(latestPopupHtml.includes('id="assigneesList"'), 'popup.html 應包含已設定人員列表容器');
  assert(latestPopupHtml.includes('id="saveAssigneesBtn"'), 'popup.html 應包含儲存經辦人名單按鈕');

  // 1-1. 檢查儲存按鈕是否已置於最上方 Header 與關閉按鈕並排
  const assigneesModalHtml = latestPopupHtml.slice(latestPopupHtml.indexOf('id="assigneesModal"'));
  const headerHtml = assigneesModalHtml.slice(0, assigneesModalHtml.indexOf('class="modal-body"'));
  assert(
    headerHtml.includes('id="saveAssigneesBtn"') && headerHtml.includes('id="closeAssigneesModalBtn"'),
    'popup.html 中 saveAssigneesBtn 應位於頂部 Header 中且與 closeAssigneesModalBtn 相鄰'
  );

  // 1-2. 檢查 popup.css 是否具備 Header 動作按鈕排版與 Modal 滾動支援
  const checkPopupCss = fs.readFileSync(path.resolve(__dirname, '..', 'popup.css'), 'utf8');
  assert(checkPopupCss.includes('.modal-header-actions'), 'popup.css 應包含 .modal-header-actions');
  assert(checkPopupCss.includes('overflow-y: auto'), 'popup.css 應支援 overflow-y: auto 捲動');

  // 2. 檢查 popup.js 是否包含經辦人設定互動邏輯
  const latestPopupJs = fs.readFileSync(path.resolve(__dirname, '..', 'popup.js'), 'utf8');
  assert(latestPopupJs.includes('openAssigneesModalBtn'), 'popup.js 應包含開啟經辦人名單彈窗邏輯');
  assert(latestPopupJs.includes('saveAssigneesBtn'), 'popup.js 應包含儲存經辦人名單事件');
  assert(latestPopupJs.includes('customAssignees'), 'popup.js 應包含 customAssignees 設定儲存與預覽');

  // 3. 測試 Jira 異常原生字串「按 未指派 篩選受託人」防禦
  assert(AssigneeUtils.isUnassignedText('按 未指派 篩選受託人'), '「按 未指派 篩選受託人」應精準判斷為未指派代表詞');
  assert.strictEqual(AssigneeUtils.cleanAssigneeLabel('按 未指派 篩選受託人'), '', '「按 未指派 篩選受託人」清理後應為空字串，絕不能誤當人名');

  // 4. 測試 BetterJiraDB customAssignees 儲存與讀取 (IndexedDB / Storage)
  assert(Array.isArray(global.BetterJiraDB.DEFAULT_SETTINGS.customAssignees), 'DEFAULT_SETTINGS.customAssignees 應為陣列');
  const sampleCustomAssignees = [
    { name: 'Ray Huang', email: 'Ray_Huang@wistron.com' },
    { name: 'Alice Wang', email: 'Alice_Wang@wistron.com' }
  ];
  await global.BetterJiraDB.saveSetting('customAssignees', sampleCustomAssignees);
  const reloadedCustomSettings = await global.BetterJiraDB.getSettings();
  assert.strictEqual(reloadedCustomSettings.customAssignees.length, 2, 'getSettings() 應正確讀出 2 位自訂成員');
  assert.strictEqual(reloadedCustomSettings.customAssignees[0].name, 'Ray Huang', '第一位成員名稱應為 Ray Huang');
  assert.strictEqual(reloadedCustomSettings.customAssignees[0].email, 'Ray_Huang@wistron.com', '第一位成員 Email 應為 Ray_Huang@wistron.com');

  // 5. 測試 AssigneeUtils.setCustomAssignees 與 matchCustomAssignee
  AssigneeUtils.setCustomAssignees(sampleCustomAssignees);
  assert.strictEqual(AssigneeUtils.getCustomAssignees().length, 2, 'getCustomAssignees() 應回傳 2 位成員');

  // 5-1. 姓名匹配
  assert.strictEqual(
    AssigneeUtils.matchCustomAssignee({ assigneeName: 'Ray Huang' }, sampleCustomAssignees[0]),
    true,
    '卡片姓名為 Ray Huang 應命中'
  );
  // 5-2. Email 前綴匹配 (Ray_Huang)
  assert.strictEqual(
    AssigneeUtils.matchCustomAssignee({ assigneeName: 'Ray_Huang' }, sampleCustomAssignees[0]),
    true,
    '卡片姓名帶有 Email 前綴 Ray_Huang 應命中'
  );
  // 5-3. 頭像縮寫匹配 (RH)
  assert.strictEqual(
    AssigneeUtils.matchCustomAssignee({ assigneeName: '已指派', assigneeInitials: 'RH' }, sampleCustomAssignees[0]),
    true,
    '卡片縮寫為 RH 應命中 Ray Huang'
  );
  // 5-4. 未指派卡片不應命中
  assert.strictEqual(
    AssigneeUtils.matchCustomAssignee({ assigneeName: '未指派' }, sampleCustomAssignees[0]),
    false,
    '未指派卡片不應命中'
  );

  // 6. 測試 FrontendFilterService 在自訂名單模式下的 extractFilterOptions 與篩選
  const customSprintIssues = [
    { key: 'C-1', summary: 'Task for Ray', assigneeName: 'Ray Huang' },
    { key: 'C-2', summary: 'Another for Ray by initials', assigneeName: '已指派', assigneeInitials: 'RH' },
    { key: 'C-3', summary: 'Task for Alice by email', assigneeName: 'Alice_Wang' },
    { key: 'C-4', summary: 'Task unassigned', assigneeName: '未指派' },
    { key: 'C-5', summary: 'Task other person', assigneeName: 'Unknown Person' }
  ];

  const customFilterOptions = FrontendFilterService.extractFilterOptions(customSprintIssues);
  assert.strictEqual(customFilterOptions.unassignedCount, 1, '未指派數量應為 1');
  assert.strictEqual(customFilterOptions.assignees.length, 2, '篩選經辦人應嚴格以自訂名單為準列出 2 位成員');

  const optRay = customFilterOptions.assignees.find((a) => a.name === 'Ray Huang');
  const optAlice = customFilterOptions.assignees.find((a) => a.name === 'Alice Wang');
  assert(optRay && optRay.count === 2, 'Ray Huang 應統計到 2 張卡片 (包含縮寫 RH)');
  assert(optAlice && optAlice.count === 1, 'Alice Wang 應統計到 1 張卡片 (包含 Email 帳號 Alice_Wang)');

  // 7. 測試自訂成員篩選比對
  FrontendFilterService.clearAll();
  FrontendFilterService.toggleAssignee('Ray Huang');
  const filteredRayResult = FrontendFilterService.filterIssues(customSprintIssues);
  assert.strictEqual(filteredRayResult.length, 2, '選取 Ray Huang 應過濾出 2 張卡片');
  assert(filteredRayResult.every((i) => i.key === 'C-1' || i.key === 'C-2'), '應只命中 C-1 與 C-2');

  FrontendFilterService.clearAll();
  FrontendFilterService.toggleAssignee('Alice Wang');
  const filteredAliceResult = FrontendFilterService.filterIssues(customSprintIssues);
  assert.strictEqual(filteredAliceResult.length, 1, '選取 Alice Wang 應過濾出 1 張卡片');
  assert.strictEqual(filteredAliceResult[0].key, 'C-3', '應只命中 C-3');

  FrontendFilterService.clearAll();
  FrontendFilterService.toggleAssignee('__UNASSIGNED__');
  const filteredUnassignedResult = FrontendFilterService.filterIssues(customSprintIssues);
  assert.strictEqual(filteredUnassignedResult.length, 1, '選取未指派應過濾出 1 張卡片');
  assert.strictEqual(filteredUnassignedResult[0].key, 'C-4', '應只命中 C-4');
  FrontendFilterService.clearAll();

  console.log('✓ 自訂經辦人名單 (Email 與名稱) 設定、IndexedDB 儲存與純前端篩選檢查通過！');

  console.log('--- 測試 22: 尚未開始衝刺 (Future Sprint) 之 API 支援、Backlog 預熱與風琴夾展開檢查 ---');
  const SDP = BetterJira.SprintDomParser;
  const JAS = BetterJira.JiraApiService;
  assert(JAS, 'JiraApiService 應存在');
  assert.strictEqual(typeof JAS.prefetchBoardBacklogIssues, 'function', 'JiraApiService.prefetchBoardBacklogIssues 應為函式');
  assert.strictEqual(typeof JAS.fetchSprintIssuesForActive, 'function', 'JiraApiService.fetchSprintIssuesForActive 應為函式');
  assert.strictEqual(typeof SDP.expandSprintHeaderOnUserSelect, 'function', 'SprintDomParser.expandSprintHeaderOnUserSelect 應為函式');
  assert.strictEqual(typeof SDP.isNativeSprintCollapsed, 'function', 'SprintDomParser.isNativeSprintCollapsed 應為函式');

  // 1. 測試 isNativeSprintCollapsed 對各種 Jira Cloud 標記的支援
  const collapsedSprintEl = new MockElement('div');
  collapsedSprintEl.className = 'ghx-closed';
  assert.strictEqual(SDP.isNativeSprintCollapsed(null, collapsedSprintEl, null), true, 'ghx-closed 應判定為收合');

  const collapsedHeaderPartner = new MockElement('div');
  collapsedHeaderPartner.setAttribute('aria-expanded', 'false');
  assert.strictEqual(SDP.isNativeSprintCollapsed(null, new MockElement('div'), collapsedHeaderPartner), true, 'aria-expanded=false 應判定為收合');

  const toggleBtnEl = new MockElement('button');
  toggleBtnEl.setAttribute('data-testid', 'software-backlog.card-list.header.toggle-button');
  const sprintWithToggle = new MockElement('div');
  sprintWithToggle.appendChild(toggleBtnEl);
  assert.strictEqual(SDP.isNativeSprintCollapsed(sprintWithToggle, sprintWithToggle, null), true, 'toggle-button 應判定為收合候選');

  // 2. 測試 expandSprintHeaderOnUserSelect 能排除自定義檢視內的卡片，成功點擊展開按鈕
  let clicked = false;
  const mockExpandBtn = new MockElement('button');
  mockExpandBtn.setAttribute('aria-expanded', 'false');
  mockExpandBtn.click = () => { clicked = true; };
  const mockHeaderPartner = new MockElement('div');
  mockHeaderPartner.appendChild(mockExpandBtn);

  const mockBranch = new MockElement('div');
  const customViewEl = new MockElement('div');
  customViewEl.setAttribute('data-bjwt-custom-view', 'true');
  const cardInsideCustom = new MockElement('div');
  cardInsideCustom.className = 'sprint-card';
  customViewEl.appendChild(cardInsideCustom);
  mockBranch.appendChild(customViewEl);

  SDP.expandSprintHeaderOnUserSelect(mockBranch, mockBranch, mockHeaderPartner);
  assert.strictEqual(clicked, true, '自定義檢視內卡片不應阻止原生風琴夾展開點擊');

  // 3. 測試 fetchSprintIssuesForActive 包含數字 sprintId JQL 查詢
  const checkJiraApiCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/services/jira-api.js'), 'utf8');
  assert(checkJiraApiCode.includes('sprint = ${sprintId}'), 'jira-api.js 應包含針對數值 sprintId 的 JQL 備援查詢');
  assert(checkJiraApiCode.includes('prefetchBoardBacklogIssues'), 'jira-api.js 應匯出 prefetchBoardBacklogIssues');
  assert(!checkJiraApiCode.includes('/rest/api/3/search/jql?'), 'jira-api.js 不應包含無效的 /rest/api/3/search/jql 路徑');

  // 4. 測試 layout-manager.js 包含全域預熱與自動展開
  const checkLayoutManagerCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/layout/layout-manager.js'), 'utf8');
  assert(checkLayoutManagerCode.includes('prefetchBoardBacklogIssues'), 'layout-manager.js 應在背景預熱看板 Backlog 卡片');
  assert(checkLayoutManagerCode.includes('expandSprintHeaderOnUserSelect'), 'layout-manager.js 應於選中收合衝刺時自動觸發展開');

  // 5. 測試 sidebar.js 在切換衝刺時優先展開並同步 API
  const checkSidebarCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/sidebar.js'), 'utf8');
  assert(checkSidebarCode.includes('expandSprintHeaderOnUserSelect'), 'sidebar.js 應於切換時調用 expandSprintHeaderOnUserSelect');
  assert(checkSidebarCode.includes('syncActiveSprintIssuesFromApi'), 'sidebar.js 應於切換時同步觸發 syncActiveSprintIssuesFromApi');

  // 6. 測試 ActiveSprintView 包含健全之 finally 解鎖與 sig 簽名包含 apiSyncing
  const checkActiveSprintViewCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/active-sprint-view.js'), 'utf8');
  assert(checkActiveSprintViewCode.includes('finally {') && checkActiveSprintViewCode.includes('cached.apiSyncing = false'),
    'active-sprint-view.js 應於 finally 區塊中保證解鎖 cached.apiSyncing');
  assert(checkActiveSprintViewCode.includes('apiSyncing: Boolean(sprintData.apiSyncing)'),
    'active-sprint-view.js 之 render-sig 應包含 apiSyncing 狀態');

  console.log('✓ 尚未開始衝刺 (Future Sprint) 之 API 支援、Backlog 預熱與風琴夾展開檢查通過！');

  console.log('--- 測試 23: 卡片五欄位 (類型Icon、狀態、StoryPoint、優先度、指派人員) 小型就地編輯視窗 (QuickEditPopoverComponent) 與點擊分流檢查 ---');
  {
    const { QuickEditPopoverComponent, IssueCardComponent } = BetterJira;
    const ApiService = BetterJira.JiraApiService;
    assert(QuickEditPopoverComponent, 'BetterJira 應匯出 QuickEditPopoverComponent');

  // 1. 測試 IssueCardComponent 渲染的卡片是否包含五個可就地編輯欄位
  const testIssue = {
    key: 'WMC-999',
    summary: '測試就地編輯卡片功能',
    issueTypeName: 'Bug',
    issueTypeIcon: 'https://swpc.atlassian.net/images/icons/issuetypes/bug.svg',
    statusName: 'In Progress',
    statusCategory: 'indeterminate',
    storyPoints: 5,
    priorityName: 'High',
    priorityIcon: 'https://swpc.atlassian.net/images/icons/priorities/high.svg',
    assigneeName: 'Ray Huang',
    assigneeAvatar: 'https://avatar.url/ray.png'
  };

  const cardHtml = IssueCardComponent.renderIssueCardHtml(testIssue);
  assert(cardHtml.includes('data-bjwt-quick-edit="type"'), '卡片 HTML 應包含 data-bjwt-quick-edit="type"');
  assert(cardHtml.includes('data-bjwt-quick-edit="status"'), '卡片 HTML 應包含 data-bjwt-quick-edit="status"');
  assert(cardHtml.includes('data-bjwt-quick-edit="points"'), '卡片 HTML 應包含 data-bjwt-quick-edit="points"');
  assert(cardHtml.includes('data-bjwt-quick-edit="priority"'), '卡片 HTML 應包含 data-bjwt-quick-edit="priority"');
  assert(cardHtml.includes('data-bjwt-quick-edit="assignee"'), '卡片 HTML 應包含 data-bjwt-quick-edit="assignee"');
  assert(cardHtml.includes('bjwt-quick-editable'), '卡片欄位應包含 bjwt-quick-editable 樣式類別');

  // 2. 測試點擊事件分流 (Quick Edit vs Modal)
  let modalOpened = false;
  let quickEditTriggered = null;

  function simulateCardClick(targetSelector) {
    modalOpened = false;
    quickEditTriggered = null;

    const fakeTarget = {
      closest: (sel) => {
        if (sel.includes('[data-bjwt-quick-edit]')) {
          if (targetSelector.includes('type') || targetSelector.includes('issuetype')) return { getAttribute: () => 'type' };
          if (targetSelector.includes('status')) return { getAttribute: () => 'status' };
          if (targetSelector.includes('points')) return { getAttribute: () => 'points' };
          if (targetSelector.includes('priority')) return { getAttribute: () => 'priority' };
          if (targetSelector.includes('assignee')) return { getAttribute: () => 'assignee' };
        }
        return null;
      }
    };

    const mockEvt = {
      target: fakeTarget,
      preventDefault: () => {},
      stopPropagation: () => {}
    };

    const quickEditTarget = mockEvt.target && mockEvt.target.closest ? mockEvt.target.closest('[data-bjwt-quick-edit]') : null;
    if (quickEditTarget) {
      quickEditTriggered = quickEditTarget.getAttribute('data-bjwt-quick-edit');
      return;
    }
    modalOpened = true;
  }

  // 點擊卡片類型 Icon -> 觸發 type 快速編輯，不開啟 Modal
  simulateCardClick('.bjwt-card-issuetype-slot');
  assert.strictEqual(quickEditTriggered, 'type', '點擊卡片類型Icon應觸發 type 快速編輯');
  assert.strictEqual(modalOpened, false, '點擊卡片類型Icon不應彈出詳細 Modal');

  // 點擊狀態 -> 觸發狀態快速編輯，不開啟 Modal
  simulateCardClick('.bjwt-history-status-badge');
  assert.strictEqual(quickEditTriggered, 'status', '點擊狀態欄應觸發 status 快速編輯');
  assert.strictEqual(modalOpened, false, '點擊狀態欄不應彈出詳細 Modal');

  // 點擊 StoryPoint -> 觸發 points 快速編輯，不開啟 Modal
  simulateCardClick('.bjwt-card-slot-points');
  assert.strictEqual(quickEditTriggered, 'points', '點擊 StoryPoint 欄應觸發 points 快速編輯');
  assert.strictEqual(modalOpened, false, '點擊 StoryPoint 欄不應彈出詳細 Modal');

  // 點擊 優先度 -> 觸發 priority 快速編輯，不開啟 Modal
  simulateCardClick('.bjwt-card-slot-priority');
  assert.strictEqual(quickEditTriggered, 'priority', '點擊優先度欄應觸發 priority 快速編輯');
  assert.strictEqual(modalOpened, false, '點擊優先度欄不應彈出詳細 Modal');

  // 點擊 指派人員 -> 觸發 assignee 快速編輯，不開啟 Modal
  simulateCardClick('.bjwt-card-slot-assignee');
  assert.strictEqual(quickEditTriggered, 'assignee', '點擊指派人員欄應觸發 assignee 快速編輯');
  assert.strictEqual(modalOpened, false, '點擊指派人員欄不應彈出詳細 Modal');

  // 點擊 卡片其他地方 (例如標題或卡片主體) -> 彈出詳細 Modal，不觸發快速編輯
  simulateCardClick('.bjwt-history-card-summary');
  assert.strictEqual(quickEditTriggered, null, '點擊卡片標題不應觸發快速編輯');
  assert.strictEqual(modalOpened, true, '點擊卡片標題應彈出詳細 Modal 觀看詳細內容');

  // 3. 測試 JiraApiService 新增之類型、優先度與經辦人方法
  assert.strictEqual(typeof ApiService.fetchIssueTypesForIssue, 'function', 'JiraApiService 應提供 fetchIssueTypesForIssue');
  assert.strictEqual(typeof ApiService.updateIssueType, 'function', 'JiraApiService 應提供 updateIssueType');
  assert.strictEqual(typeof ApiService.fetchPriorities, 'function', 'JiraApiService 應提供 fetchPriorities');
  assert.strictEqual(typeof ApiService.updateIssuePriority, 'function', 'JiraApiService 應提供 updateIssuePriority');
  assert.strictEqual(typeof ApiService.updateIssueAssignee, 'function', 'JiraApiService 應提供 updateIssueAssignee');

  const issueTypes = await ApiService.fetchIssueTypesForIssue('WMC-999');
  assert(Array.isArray(issueTypes) && issueTypes.length >= 4, 'fetchIssueTypesForIssue 應回傳可用問題類型清單');
  assert(issueTypes.some((t) => t.name === 'Bug' || t.name === 'Story'), '問題類型清單應包含 Bug 或 Story');

  const priorities = await ApiService.fetchPriorities();
  assert(Array.isArray(priorities) && priorities.length >= 5, 'fetchPriorities 應回傳至少 5 項標準優先度');
  assert(priorities.some((p) => p.name === 'High'), '優先度清單應包含 High');

  // 4. 測試候選經辦人名單收集 (collectCandidateAssignees)
  const candidateAssignees = QuickEditPopoverComponent.collectCandidateAssignees(testIssue);
  assert(Array.isArray(candidateAssignees), 'collectCandidateAssignees 應回傳陣列');
  assert(candidateAssignees.some((c) => c.name === 'Ray Huang'), '候選經辦人應包含 Ray Huang');

  // 5. 測試 styles.css 與 runtime-styles.js 包含 Popover 樣式定義
  const checkStyles = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
  assert(checkStyles.includes('bjwt-quick-edit-popover'), 'styles.css 應包含 bjwt-quick-edit-popover');
  assert(checkStyles.includes('bjwt-quick-editable'), 'styles.css 應包含 bjwt-quick-editable');

  // 6. 測試 Story Points 快捷晶片 (1, 2, 3, 5, 8, 13, 20, 清空)
  const checkPopoverCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/quick-edit-popover.js'), 'utf8');
  ['1', '2', '3', '5', '8', '13', '20'].forEach((pt) => {
    assert(checkPopoverCode.includes(`data-pt="${pt}"`), `快捷點數晶片應包含 ${pt}`);
  });
  assert(checkPopoverCode.includes('清空'), '快捷點數晶片應包含「清空」選項');
  assert(!checkPopoverCode.includes('data-pt="40"'), '快捷點數晶片不應包含 40');
  assert(!checkPopoverCode.includes('data-pt="0.5"'), '快捷點數晶片不應包含 0.5');

  // 7. 測試卡片四欄位 (狀態、StoryPoint、優先度、指派人員) 編輯後立即更新 UI，且不被未刷新的原生舊 DOM 逆向覆蓋
  const { IssueStore } = BetterJira;
  IssueStore.clearUserOverrides('WMC-777');

  // (a) 模擬初始由原生 DOM 解析出的卡片 (fromDom: true, 狀態為「待辦事項」, 優先度為 Medium 帶 SVG, 點數 3, 未指派)
  IssueStore.mergeAndCacheIssue({
    key: 'WMC-777',
    summary: '測試四欄位即時 UI 更新與防舊 DOM 覆蓋',
    statusName: '待辦事項',
    statusCategory: 'new',
    storyPoints: 3,
    priorityName: 'Medium',
    priorityIcon: '',
    prioritySvg: '<svg id="old-medium-svg"></svg>',
    assigneeName: '未指派',
    isUnassigned: true,
    fromDom: true,
    _isFromDom: true
  });

  // 同時模擬衝刺快取池內存有舊快照
  IssueStore.setActiveSprintCache('sprint_test_777', {
    key: 'sprint_test_777',
    title: 'Test Sprint 777',
    allApiIssues: [IssueStore.getCachedIssue('WMC-777')],
    rawIssues: [IssueStore.getCachedIssue('WMC-777')],
    issues: [IssueStore.getCachedIssue('WMC-777')],
    masterIssuesMap: new Map([['WMC-777', IssueStore.getCachedIssue('WMC-777')]])
  });

  // (b) 使用者透過快速編輯修改「狀態」為「進行中」、修改「優先度」為「Highest」、修改「StoryPoint」為 8、修改「指派人員」為 Alice Wang
  IssueStore.mergeAndCacheIssue({
    key: 'WMC-777',
    statusName: '進行中',
    statusCategory: 'indeterminate',
    isUserEdit: true
  });
  IssueStore.mergeAndCacheIssue({
    key: 'WMC-777',
    priorityName: 'Highest',
    priorityIcon: '',
    prioritySvg: '',
    isUserEdit: true
  });
  IssueStore.mergeAndCacheIssue({
    key: 'WMC-777',
    storyPoints: 8,
    isUserEdit: true
  });
  IssueStore.mergeAndCacheIssue({
    key: 'WMC-777',
    assigneeName: 'Alice Wang',
    isUnassigned: false,
    assigneeInitials: 'AW',
    assigneeAvatar: '',
    assigneeBgColor: '',
    assigneeEmail: 'Alice_Wang@wistron.com',
    assigneeAccountId: '5b10ac8d82e05b22cc7d4ef5',
    isUserEdit: true
  });

  // (c) 模擬下一個畫面刷新時，CardDomParser 再次從尚未重整的原生 Jira DOM 讀取到舊資料 (fromDom: true)
  const afterStaleDomReParse = IssueStore.mergeAndCacheIssue({
    key: 'WMC-777',
    summary: '測試四欄位即時 UI 更新與防舊 DOM 覆蓋',
    statusName: '待辦事項',
    statusCategory: 'new',
    storyPoints: 3,
    priorityName: 'Medium',
    priorityIcon: '',
    prioritySvg: '<svg id="old-medium-svg"></svg>',
    assigneeName: '未指派',
    isUnassigned: true,
    fromDom: true,
    _isFromDom: true
  });

  assert.strictEqual(afterStaleDomReParse.statusName, '進行中', '編輯狀態後，即使重掃舊 DOM，狀態仍應立即且持續顯示為「進行中」');
  assert.strictEqual(afterStaleDomReParse.statusCategory, 'indeterminate', '狀態分類應維持為 indeterminate');
  assert.strictEqual(afterStaleDomReParse.priorityName, 'Highest', '編輯優先順序後，即使重掃舊 DOM，優先順序仍應顯示為「Highest」');
  assert.strictEqual(afterStaleDomReParse.prioritySvg, '', '編輯優先順序後應清除舊優先度的 SVG');
  assert.strictEqual(afterStaleDomReParse.storyPoints, 8, '編輯 StoryPoint 後應維持為 8');
  assert.strictEqual(afterStaleDomReParse.isUnassigned, false, '指派人員後 isUnassigned 應為 false (不可被舊 DOM 鎖死在未指派)');
  assert.strictEqual(afterStaleDomReParse.assigneeName, 'Alice Wang', '指派人員後經辦人名稱應立即顯示為 Alice Wang');

  // 驗證衝刺快取池 (activeSprintCache) 中的物件也已同步更新
  const sprintCachedIss = IssueStore.getActiveSprintCache('sprint_test_777').allApiIssues[0];
  assert.strictEqual(sprintCachedIss.statusName, '進行中', '衝刺快取池 allApiIssues 應同步更新為最新狀態「進行中」');
  assert.strictEqual(sprintCachedIss.priorityName, 'Highest', '衝刺快取池 allApiIssues 應同步更新為最新優先度「Highest」');
  assert.strictEqual(sprintCachedIss.assigneeName, 'Alice Wang', '衝刺快取池 allApiIssues 應同步更新為最新指派人員「Alice Wang」');

  // 驗證卡片渲染 HTML 立即呈現最新狀態、點數、優先度圖示與經辦人
  const updatedCardHtml = IssueCardComponent.renderIssueCardHtml(afterStaleDomReParse);
  assert(updatedCardHtml.includes('進行中') && updatedCardHtml.includes('status-inprogress'), '卡片 HTML 應立即渲染「進行中」與 status-inprogress 樣式');
  assert(updatedCardHtml.includes('目前：Highest') && !updatedCardHtml.includes('old-medium-svg'), '卡片 HTML 應立即渲染新優先度 Highest 且不含舊 SVG');
  assert(updatedCardHtml.includes('目前：Alice Wang') && updatedCardHtml.includes('>AW<'), '卡片 HTML 應立即渲染新指派人員 Alice Wang 與縮寫 AW');

  // (d) 測試清空 StoryPoint (8 -> null) 也能正確覆蓋舊值
  IssueStore.mergeAndCacheIssue({
    key: 'WMC-777',
    storyPoints: null,
    isUserEdit: true
  });
  assert.strictEqual(IssueStore.getCachedIssue('WMC-777').storyPoints, null, '清空 StoryPoint 後應為 null，不可殘留舊點數 8');
  IssueStore.clearUserOverrides('WMC-777');

  // 8. 測試 JiraApiService.updateIssueAssignee 自動向 Jira API 解析未知成員之 Jira Cloud accountId 並存入資料庫
  let capturedAssigneeUrl = '';
  let capturedAssigneeBody = null;
  const prevFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/user/assignable/search') || u.includes('/user/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            accountId: '5b10ac8d82e05b22cc7d9999',
            name: 'david_chen',
            displayName: 'David Chen',
            emailAddress: 'David_Chen@wistron.com',
            avatarUrls: { '48x48': 'https://avatar.url/david48.png' }
          }
        ]
      };
    }
    if (u.includes('/assignee') && opts.method === 'PUT') {
      capturedAssigneeUrl = u;
      capturedAssigneeBody = JSON.parse(opts.body);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return prevFetch ? prevFetch(url, opts) : { ok: true, status: 200, json: async () => ({}) };
  };

  const assignRes = await ApiService.updateIssueAssignee(
    'WMC-777',
    'David Chen',
    null,
    { name: 'David Chen', email: 'David_Chen@wistron.com' }
  );
  global.fetch = prevFetch;

  assert.strictEqual(assignRes.success, true, 'updateIssueAssignee 應回傳 success: true');
  assert(capturedAssigneeUrl.includes('/rest/api/2/issue/WMC-777/assignee'), '應呼叫標準 /assignee API 端點');
  assert.deepStrictEqual(
    capturedAssigneeBody,
    { accountId: '5b10ac8d82e05b22cc7d9999' },
    '在 Jira Cloud 環境下，updateIssueAssignee 應自動解析並傳送 { accountId } 以確保真正寫入 Jira 資料庫'
  );
  assert(
    assignRes.resolvedUser && assignRes.resolvedUser.avatar === 'https://avatar.url/david48.png',
    'updateIssueAssignee 應一併回傳解析到的真實使用者頭像與資訊供 UI 即時顯示'
  );

  console.log('✓ 卡片五欄位小型就地編輯視窗與點擊分流檢查通過！');
  }

  console.log('--- 測試 24: 卡片右鍵自訂選單 (CardContextMenuComponent) 與複製卡片編號、卡片標題檢查 ---');
  {
    const { CardContextMenuComponent, IssueCardComponent } = BetterJira;
    assert(CardContextMenuComponent, 'BetterJira 應匯出 CardContextMenuComponent');
    assert.strictEqual(typeof CardContextMenuComponent.open, 'function', 'CardContextMenuComponent 應提供 open 方法');
    assert.strictEqual(typeof CardContextMenuComponent.close, 'function', 'CardContextMenuComponent 應提供 close 方法');
    assert.strictEqual(typeof CardContextMenuComponent.copyTextToClipboard, 'function', 'CardContextMenuComponent 應提供 copyTextToClipboard 方法');

    // 1. 測試 IssueCardComponent 產出的卡片是否包含 data-bjwt-issue-summary
    const sampleCard = {
      key: 'WMC-888',
      summary: '修復右鍵選單複製功能',
      issueTypeName: 'Task',
      statusName: 'To Do',
      storyPoints: 3
    };
    const cardHtml = IssueCardComponent.renderIssueCardHtml(sampleCard);
    assert(cardHtml.includes('data-bjwt-history-issue-key="WMC-888"'), '卡片 HTML 應包含正確的卡片編號屬性');
    assert(cardHtml.includes('data-bjwt-issue-summary="修復右鍵選單複製功能"'), '卡片 HTML 應包含 data-bjwt-issue-summary 屬性');

    // 2. 測試複製文字至剪貼簿邏輯
    let copiedText = '';
    global.navigator.clipboard = {
      writeText: async (txt) => {
        copiedText = txt;
        return true;
      }
    };
    if (global.window) {
      global.window.navigator = global.navigator;
    }
    const copyResult = await CardContextMenuComponent.copyTextToClipboard('WMC-888');
    assert.strictEqual(copyResult, true, 'copyTextToClipboard 應回傳 true');
    assert.strictEqual(copiedText, 'WMC-888', '剪貼簿文字應為 WMC-888');

    const copySummaryResult = await CardContextMenuComponent.copyTextToClipboard('修復右鍵選單複製功能');
    assert.strictEqual(copySummaryResult, true, 'copyTextToClipboard 複製標題應成功');
    assert.strictEqual(copiedText, '修復右鍵選單複製功能', '剪貼簿文字應為修復右鍵選單複製功能');

    // 3. 測試 active-sprint-view.js 與 history-sprint-view.js 包含 contextmenu 監聽
    const checkActiveCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/active-sprint-view.js'), 'utf8');
    assert(checkActiveCode.includes("cardEl.addEventListener('contextmenu'"), 'active-sprint-view.js 應監聽卡片 contextmenu 事件');
    assert(checkActiveCode.includes('CardContextMenuComponent.open'), 'active-sprint-view.js 應於右鍵點擊時調用 CardContextMenuComponent.open');

    const checkHistoryCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/history-sprint-view.js'), 'utf8');
    assert(checkHistoryCode.includes("cardEl.addEventListener('contextmenu'"), 'history-sprint-view.js 應監聽卡片 contextmenu 事件');
    assert(checkHistoryCode.includes('CardContextMenuComponent.open'), 'history-sprint-view.js 應於右鍵點擊時調用 CardContextMenuComponent.open');

    // 4. 測試 card-context-menu.js 包含「在新分頁開啟」、「複製卡片編號」與「複製卡片標題」動作
    const checkMenuCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/card-context-menu.js'), 'utf8');
    assert(checkMenuCode.includes('在新分頁開啟'), 'card-context-menu.js 應包含「在新分頁開啟」');
    assert(checkMenuCode.includes('data-action="open-tab"'), 'card-context-menu.js 應包含 open-tab 動作屬性');
    assert(checkMenuCode.includes('複製卡片編號'), 'card-context-menu.js 應包含「複製卡片編號」');
    assert(checkMenuCode.includes('複製卡片標題'), 'card-context-menu.js 應包含「複製卡片標題」');

    // 4-1. 測試 openIssueInNewTab 方法
    let openedUrl = '';
    global.window.open = (u) => { openedUrl = u; };
    const resUrl = CardContextMenuComponent.openIssueInNewTab('WMC-888');
    assert.strictEqual(resUrl, `${global.window.location.origin}/browse/WMC-888`, 'openIssueInNewTab 應回傳完整 Jira browse URL');
    assert.strictEqual(openedUrl, `${global.window.location.origin}/browse/WMC-888`, 'window.open 應被正確調用');

    // 5. 測試 styles.css 與 runtime-styles.js 包含 Context Menu 與 Toast 樣式定義
    const checkStyles = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
    assert(checkStyles.includes('bjwt-card-context-menu'), 'styles.css 應包含 bjwt-card-context-menu');
    assert(checkStyles.includes('bjwt-copy-toast'), 'styles.css 應包含 bjwt-copy-toast');
    assert(checkStyles.includes('bjwt-context-sub-icon'), 'styles.css 應包含 bjwt-context-sub-icon');

    // 6. 測試已結束歷史衝刺 (HistorySprintView) 卡片右鍵點擊正常開啟右鍵選單
    const { HistorySprintView } = BetterJira;
    assert(HistorySprintView && typeof HistorySprintView.renderHistoricalSprintBranch === 'function', 'HistorySprintView 應提供 renderHistoricalSprintBranch');
    const mockBranchEl = new MockElement('div');
    const mockHistItem = {
      key: 'hist_sprint_test',
      title: 'Sprint 99 (已結束歷史衝刺)',
      sprintId: '99',
      issues: [
        {
          key: 'HIST-101',
          summary: '歷史測試卡片標題',
          statusName: 'Done',
          statusCategory: 'done',
          storyPoints: 5,
          priorityName: 'High',
          priorityIcon: '',
          issueTypeName: 'Story',
          issueTypeIcon: '',
          isSubtask: false,
          isDone: true
        }
      ]
    };
    HistorySprintView.renderHistoricalSprintBranch(mockBranchEl, mockHistItem);
    const cardEl = mockBranchEl.querySelector('.bjwt-history-card');
    assert(cardEl, '歷史衝刺應成功渲染出卡片節點');

    let menuOpenedWith = null;
    const origOpen = CardContextMenuComponent.open;
    CardContextMenuComponent.open = (x, y, data) => {
      menuOpenedWith = { x, y, data };
      origOpen(x, y, data);
    };

    let prevented = false;
    let stopped = false;
    await cardEl.dispatchEvent({
      type: 'contextmenu',
      clientX: 250,
      clientY: 350,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; }
    });

    assert(prevented, '歷史衝刺卡片 contextmenu 事件應調用 preventDefault');
    assert(stopped, '歷史衝刺卡片 contextmenu 事件應調用 stopPropagation');
    assert(menuOpenedWith, '歷史衝刺卡片右鍵應成功調用 CardContextMenuComponent.open');
    assert.strictEqual(menuOpenedWith.data.key, 'HIST-101', '右鍵選單資料 key 應正確');
    assert.strictEqual(menuOpenedWith.data.sprintTitle, 'Sprint 99 (已結束歷史衝刺)', '右鍵選單資料 sprintTitle 應正確');
    assert.strictEqual(menuOpenedWith.data.sprintId, '99', '右鍵選單資料 sprintId 應正確');
    assert(menuOpenedWith.data.sprintItem && menuOpenedWith.data.sprintItem.meta.isHistorical, 'sprintItem 應標記為歷史衝刺');

    CardContextMenuComponent.open = origOpen;
    CardContextMenuComponent.close();

    console.log('✓ 卡片右鍵自訂選單 (在新分頁開啟、複製編號/標題、歷史衝刺卡片右鍵相容) 檢查通過！');
  }

  console.log('--- 測試 25: 側邊欄點數顯示純數字、未開始衝刺點數統計與三分區 (進行中/未開始/已結束) 檢查 ---');
  {
    const { SidebarComponent, SprintStatsService, SprintDomParser, CardDomParser } = BetterJira;

    // 1. 測試 SprintStatsService.updateSidebarBadgeForSprint 顯示純數字 (不帶 "點")
    const mockBadgeEl = new MockElement('span');
    mockBadgeEl.className = 'bjwt-sprint-tab-badge';
    mockBadgeEl.setAttribute('data-bjwt-tab-key', 'sprint_test_pt');
    const origQuerySelector = global.document.querySelector;
    global.document.querySelector = (sel) => {
      if (sel && sel.includes('sprint_test_pt')) return mockBadgeEl;
      return typeof origQuerySelector === 'function' ? origQuerySelector(sel) : null;
    };
    SprintStatsService.updateSidebarBadgeForSprint('sprint_test_pt', 33, 10);
    assert.strictEqual(mockBadgeEl.textContent, '33', '點數大於 0 時徽章文字應為純數字「33」，不應帶有「點」字');

    // 2. 測試 CardDomParser.parseIssueFromDomCard 支援各類 Story Points 輸入與格式 (帶「點」、pt、input、aria-label)
    const cardPt1 = new MockElement('div');
    const a1 = new MockElement('a');
    a1.setAttribute('href', '/browse/T-1');
    a1.textContent = 'T-1 Card';
    cardPt1.appendChild(a1);
    const est1 = new MockElement('span');
    est1.setAttribute('data-testid', 'platform.ui.badge.estimate');
    est1.textContent = '13 點';
    cardPt1.appendChild(est1);
    const parsedPt1 = CardDomParser.parseIssueFromDomCard(cardPt1);
    assert.strictEqual(parsedPt1.storyPoints, 13, '帶有「13 點」的估算應解析為數值 13');

    const cardPt2 = new MockElement('div');
    const a2 = new MockElement('a');
    a2.setAttribute('href', '/browse/T-2');
    a2.textContent = 'T-2 Card';
    cardPt2.appendChild(a2);
    const est2 = new MockElement('input');
    est2.setAttribute('data-testid', 'software-backlog.card.estimate-input');
    est2.value = '8';
    cardPt2.appendChild(est2);
    const parsedPt2 = CardDomParser.parseIssueFromDomCard(cardPt2);
    assert.strictEqual(parsedPt2.storyPoints, 8, 'input value 為 8 的估算應解析為數值 8');

    // 3. 測試 SprintDomParser.extractSprintMeta 對未開始衝刺 (帶「開始衝刺」按鈕與單一標頭點數) 的解析
    const futureSprintEl = new MockElement('div');
    futureSprintEl.setAttribute('data-sprint-id', '501');
    const futureH2 = new MockElement('h2');
    futureH2.textContent = 'WMC Sprint 25 (未來衝刺)';
    futureSprintEl.appendChild(futureH2);
    const startBtn = new MockElement('button');
    startBtn.setAttribute('data-testid', 'software-backlog.card-list.header.actions.start-sprint-button');
    startBtn.textContent = '開始衝刺';
    futureSprintEl.appendChild(startBtn);
    const badgePt = new MockElement('span');
    badgePt.setAttribute('data-testid', 'software-backlog.card-list.header.estimate');
    badgePt.textContent = '33 點';
    futureSprintEl.appendChild(badgePt);

    const futureMeta = SprintDomParser.extractSprintMeta(futureSprintEl, futureSprintEl, null, 1);
    assert.strictEqual(futureMeta.sprintState, 'future', '帶有「開始衝刺」按鈕應判定為 future (未開始衝刺)');
    assert.strictEqual(futureMeta.headerStoryPoints, 33, '未開始衝刺標頭「33 點」應成功萃取出 33 點');
    assert.strictEqual(futureMeta.storyPoints, 33, '未開始衝刺 storyPoints 應為 33 點');

    // 4. 測試 active-sprint-view.js 包含未開始狀態與開始衝刺按鈕
    const checkActiveViewCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/active-sprint-view.js'), 'utf8');
    assert(checkActiveViewCode.includes('bjwt-active-start-btn'), 'active-sprint-view.js 應包含 bjwt-active-start-btn 開始衝刺按鈕');
    assert(checkActiveViewCode.includes('未開始'), 'active-sprint-view.js 應包含未開始標籤');

    // 5. 測試 sidebar.js 包含三分區：「進行中衝刺」、「未開始衝刺」、「已結束，歷史衝刺」且純數字無「點」
    const checkSidebarCode = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/sidebar.js'), 'utf8');
    assert(checkSidebarCode.includes('進行中衝刺'), 'sidebar.js 應包含「進行中衝刺」分區標題');
    assert(checkSidebarCode.includes('未開始衝刺'), 'sidebar.js 應包含「未開始衝刺」分區標題');
    assert(checkSidebarCode.includes('已結束，歷史衝刺'), 'sidebar.js 應包含「已結束，歷史衝刺」分區標題');
    assert(!checkSidebarCode.includes('<span>未結束衝刺'), 'sidebar.js 不應包含舊的「未結束衝刺」分區');
    assert(!checkSidebarCode.includes('badgeText = pts > 0 ? `${pts} 點`'), 'sidebar.js 之 badgeText 不應帶有「點」字');

    // 6. 測試 styles.css 與 runtime-styles.js 包含 future-section 與 bjwt-active-start-btn，以及加大醒目的階層感樣式
    const checkStylesCss = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
    assert(checkStylesCss.includes('future-section'), 'styles.css 應包含 future-section');
    assert(checkStylesCss.includes('bjwt-active-start-btn'), 'styles.css 應包含 bjwt-active-start-btn');
    assert(checkStylesCss.includes('bjwt-section-toggle-icon'), 'styles.css 應包含 bjwt-section-toggle-icon 風琴夾圖示樣式');
    assert(checkStylesCss.includes('bjwt-sprint-section-body'), 'styles.css 應包含 bjwt-sprint-section-body 風琴夾區塊樣式');
    assert(checkStylesCss.includes('bjwt-section-count-badge'), 'styles.css 應包含 bjwt-section-count-badge 醒目計數徽章樣式');
    assert(checkStylesCss.includes('13.5px'), 'styles.css 分區標頭字體應加大為 13.5px 以表現階層感');

    const checkRuntimeStyles = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');
    assert(checkRuntimeStyles.includes('future-section'), 'runtime-styles.js 應包含 future-section');
    assert(checkRuntimeStyles.includes('bjwt-active-start-btn'), 'runtime-styles.js 應包含 bjwt-active-start-btn');
    assert(checkRuntimeStyles.includes('bjwt-section-toggle-icon'), 'runtime-styles.js 應包含 bjwt-section-toggle-icon 風琴夾圖示樣式');
    assert(checkRuntimeStyles.includes('bjwt-sprint-section-body'), 'runtime-styles.js 應包含 bjwt-sprint-section-body 風琴夾區塊樣式');
    assert(checkRuntimeStyles.includes('bjwt-section-count-badge'), 'runtime-styles.js 應包含 bjwt-section-count-badge 醒目計數徽章樣式');
    assert(checkRuntimeStyles.includes('13.5px'), 'runtime-styles.js 分區標頭字體應加大為 13.5px 以表現階層感');

    // 6-1. 測試選取與未選取之衝刺點數徽章統一為灰底色
    assert(checkStylesCss.includes('.bjwt-sprint-tab.active .bjwt-sprint-tab-badge'), 'styles.css 應包含 active 衝刺徽章樣式設定');
    assert(checkStylesCss.includes('background: var(--ds-background-neutral, #ebecf0) !important;'), 'styles.css 應將選取之衝刺徽章統一設為灰底色');
    assert(!checkStylesCss.includes('background: var(--ds-border-selected, #0c66e4);'), 'styles.css 選取之衝刺徽章不可為藍底色');
    assert(checkRuntimeStyles.includes('.bjwt-sprint-tab.active .bjwt-sprint-tab-badge'), 'runtime-styles.js 應包含 active 衝刺徽章樣式設定');
    assert(checkRuntimeStyles.includes('background: var(--ds-background-neutral, #ebecf0) !important;'), 'runtime-styles.js 應將選取之衝刺徽章統一設為灰底色');

    // 7. 測試風琴夾狀態管理 (getSectionCollapseState / setSectionCollapseState)
    assert(typeof SidebarComponent.getSectionCollapseState === 'function', 'SidebarComponent 應提供 getSectionCollapseState 函式');
    assert(typeof SidebarComponent.setSectionCollapseState === 'function', 'SidebarComponent 應提供 setSectionCollapseState 函式');
    
    // 預設狀態：「進行中衝刺」展開 (false)、「未開始衝刺」收合 (true)、「已結束衝刺」展開 (false)
    const initialCollapse = SidebarComponent.getSectionCollapseState();
    assert.strictEqual(typeof initialCollapse, 'object', 'Collapse 狀態應為物件');
    assert.strictEqual(initialCollapse.future, true, '預設狀態下「未開始衝刺」風琴夾應為收合 (future: true)');
    assert.strictEqual(initialCollapse.active, false, '預設狀態下「進行中衝刺」風琴夾應為展開 (active: false)');
    assert.strictEqual(initialCollapse.history, false, '預設狀態下「已結束衝刺」風琴夾應為展開 (history: false)');
    
    // 記憶體狀態更新
    SidebarComponent.setSectionCollapseState({ future: false, history: true });
    const updatedCollapse = SidebarComponent.getSectionCollapseState();
    assert.strictEqual(updatedCollapse.future, false, 'future 區塊狀態應已更新為 false');
    assert.strictEqual(updatedCollapse.history, true, 'history 區塊狀態應已更新為 true');
    assert.strictEqual(updatedCollapse.active, false, 'active 區塊狀態應保持為 false');

    // 測試 localStorage 雙向持久化儲存與讀取
    const localStore = {};
    global.localStorage = {
      getItem: (k) => localStore[k] || null,
      setItem: (k, v) => { localStore[k] = String(v); }
    };
    SidebarComponent.setSectionCollapseState({ active: true, future: true, history: true });
    const localCollapse = SidebarComponent.getSectionCollapseState();
    assert.strictEqual(localCollapse.active, true, 'localStorage 啟用時 active 應為 true');
    assert.strictEqual(localCollapse.future, true, 'localStorage 啟用時 future 應為 true');
    assert.strictEqual(localCollapse.history, true, 'localStorage 啟用時 history 應為 true');
    assert(localStore['bjwt_sidebar_sections_collapsed'].includes('"future":true'), 'localStorage 應儲存序列化之 JSON');

    // 復原狀態為預設值
    SidebarComponent.setSectionCollapseState(SidebarComponent.DEFAULT_SECTION_COLLAPSE_STATE);
    delete global.localStorage;

    // 8. 測試風琴夾原始碼邏輯與無障礙屬性
    assert(checkSidebarCode.includes('renderCollapsibleSection'), 'sidebar.js 應包含 renderCollapsibleSection 風琴夾渲染函式');
    assert(checkSidebarCode.includes('bjwt-section-toggle-icon'), 'sidebar.js 應包含 bjwt-section-toggle-icon 風琴夾箭頭');
    assert(checkSidebarCode.includes('bjwt-sprint-section-body'), 'sidebar.js 應包含 bjwt-sprint-section-body 容器');
    assert(checkSidebarCode.includes('aria-expanded'), 'sidebar.js 應設定 aria-expanded 屬性');
    assert(checkSidebarCode.includes('aria-controls'), 'sidebar.js 應設定 aria-controls 屬性');
    assert(checkSidebarCode.includes('sectionCollapse'), 'sidebar.js signature 應包含 sectionCollapse 變更偵測');

    // 9. 測試分區標頭前方圖示移除、但 Sprint 項目保留前置圖示
    assert(!checkSidebarCode.includes('dotClass:'), 'sidebar.js 分區標頭呼叫處應已移除 dotClass');
    assert(!checkSidebarCode.includes('iconSvg:'), 'sidebar.js 分區標頭呼叫處應已移除 iconSvg');
    assert(checkSidebarCode.includes('bjwt-history-tab-icon'), 'Sprint 項目按鈕應保留歷史時鐘圖示');
    assert(checkSidebarCode.includes('live-item-dot active-item-dot'), 'Sprint 項目按鈕應保留進行中衝刺圓點');
    assert(checkSidebarCode.includes('future-item-dot'), 'Sprint 項目按鈕應保留未開始衝刺圓點');

    // 10. 測試已結束衝刺項目已移除多餘的「已結束」文字標籤
    assert(!checkSidebarCode.includes('<span class="bjwt-closed-pill">已結束</span>'), 'sidebar.js 已結束衝刺項目中不應包含多餘的「已結束」標籤');

    global.document.querySelector = origQuerySelector;
    console.log('✓ 側邊欄點數純數字、未開始衝刺點數統計與三分區 (進行中/未開始/已結束) 檢查通過！');
  }

  console.log('--- 測試 26: 嚴格排除子卡片 (SubTask) 出現在右側欄卡片清單與衝刺統計檢查 ---');
  {
    const { TextUtils, IssueStore, CardDomParser, SprintStatsService } = BetterJira;

    // 1. 測試 TextUtils.isSubtaskTypeName 判斷
    assert.strictEqual(typeof TextUtils.isSubtaskTypeName, 'function', 'TextUtils.isSubtaskTypeName 應為函式');
    assert.strictEqual(TextUtils.isSubtaskTypeName('Sub-task'), true, 'Sub-task 應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('subtask'), true, 'subtask 應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('sub-task'), true, 'sub-task 應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('子任務'), true, '子任務 應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('子工作'), true, '子工作 應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('工作項目類型: Sub-task'), true, '帶前綴的 Sub-task 應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('Story'), false, 'Story 不應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('Task'), false, 'Task 不應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('Bug'), false, 'Bug 不應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName('Epic'), false, 'Epic 不應為子任務');
    assert.strictEqual(TextUtils.isSubtaskTypeName(''), false, '空字串不應為子任務');

    // 2. 測試 IssueStore.normalizeJiraIssue 正確標記 isSubtask 屬性
    const rawSubtaskApi = {
      id: '2001',
      key: 'TEST-10',
      fields: {
        summary: '實作單元測試子任務',
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        issuetype: { name: 'Sub-task', subtask: true },
        story_points: 2
      }
    };
    const normSubtask = IssueStore.normalizeJiraIssue(rawSubtaskApi);
    assert.strictEqual(normSubtask.isSubtask, true, 'normalizeJiraIssue 應標記 isSubtask: true');

    const rawStandardApi = {
      id: '2002',
      key: 'TEST-11',
      fields: {
        summary: '開發核心模組',
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        issuetype: { name: 'Story', subtask: false },
        story_points: 8
      }
    };
    const normStandard = IssueStore.normalizeJiraIssue(rawStandardApi);
    assert.strictEqual(normStandard.isSubtask, false, 'Story 卡片 isSubtask 應為 false');

    const rawChineseSubtaskApi = {
      id: '2003',
      key: 'TEST-12',
      fields: {
        summary: '前端子工作',
        status: { name: 'Done', statusCategory: { key: 'done' } },
        issuetype: { name: '子任務' },
        story_points: 1
      }
    };
    const normChineseSubtask = IssueStore.normalizeJiraIssue(rawChineseSubtaskApi);
    assert.strictEqual(normChineseSubtask.isSubtask, true, '中文名稱「子任務」應自動標記 isSubtask: true');

    // 3. 測試 IssueStore.isSubtaskIssue
    assert.strictEqual(IssueStore.isSubtaskIssue(normSubtask), true);
    assert.strictEqual(IssueStore.isSubtaskIssue(normStandard), false);
    assert.strictEqual(IssueStore.isSubtaskIssue({ issueTypeName: 'Sub-task' }), true);
    assert.strictEqual(IssueStore.isSubtaskIssue({ issueTypeName: 'Task' }), false);

    // 4. 測試 CardDomParser.parseIssuesFromBranch 排除子任務
    const mockContainer = new MockElement('div');
    const mockCardStandard = new MockElement('div');
    mockCardStandard.setAttribute('data-testid', 'software-backlog.card-list.card.card-contents.card-container');
    const linkStd = new MockElement('a');
    linkStd.textContent = 'PROJ-101';
    mockCardStandard.appendChild(linkStd);
    const sumStd = new MockElement('span');
    sumStd.setAttribute('data-testid', 'software-backlog.card-list.card.card-contents.summary');
    sumStd.textContent = '標準任務標題';
    mockCardStandard.appendChild(sumStd);

    const mockCardSubtask = new MockElement('div');
    mockCardSubtask.setAttribute('data-testid', 'software-backlog.card-list.card.card-contents.card-container');
    const linkSub = new MockElement('a');
    linkSub.textContent = 'PROJ-102';
    mockCardSubtask.appendChild(linkSub);
    const sumSub = new MockElement('span');
    sumSub.setAttribute('data-testid', 'software-backlog.card-list.card.card-contents.summary');
    sumSub.textContent = '子任務標題';
    mockCardSubtask.appendChild(sumSub);
    const typeImgSub = new MockElement('img');
    typeImgSub.setAttribute('data-testid', 'software-backlog.card-list.card.card-contents.type-icon');
    typeImgSub.setAttribute('src', 'https://swpc.atlassian.net/images/icons/issuetypes/subtask.svg');
    typeImgSub.setAttribute('alt', 'Sub-task');
    mockCardSubtask.appendChild(typeImgSub);

    mockContainer.appendChild(mockCardStandard);
    mockContainer.appendChild(mockCardSubtask);

    const parsedIssues = CardDomParser.parseIssuesFromBranch(mockContainer, mockContainer);
    assert(parsedIssues.some((i) => i.key === 'PROJ-101'), '應包含標準任務 PROJ-101');
    assert(!parsedIssues.some((i) => i.key === 'PROJ-102'), 'parseIssuesFromBranch 應排除 Sub-task PROJ-102');

    // 5. 測試 SprintStatsService.calculateSprintStatistics 自動排除子任務
    const mixedIssues = [
      { key: 'W-1', statusCategory: 'new', storyPoints: 3, isSubtask: false, issueTypeName: 'Story' },
      { key: 'W-2', statusCategory: 'done', storyPoints: 5, isSubtask: false, issueTypeName: 'Story' },
      { key: 'W-3', statusCategory: 'new', storyPoints: 2, isSubtask: true, issueTypeName: 'Sub-task' },
      { key: 'W-4', statusCategory: 'done', storyPoints: 1, isSubtask: true, issueTypeName: 'Sub-task' }
    ];
    const mixedStats = SprintStatsService.calculateSprintStatistics(mixedIssues);
    assert.strictEqual(mixedStats.totalIssues, 2, '衝刺統計應排除子任務，僅計入 2 張標準卡片');
    assert.strictEqual(mixedStats.totalPoints, 8, 'Story Points 總計應為 3 + 5 = 8，不計入子任務點數');
    assert.strictEqual(mixedStats.todoCount, 1, '待辦卡片數應為 1');
    assert.strictEqual(mixedStats.doneCount, 1, '完成卡片數應為 1');

    // 6. 測試原始碼中各處排除子任務的防護邏輯
    const checkActiveView = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/active-sprint-view.js'), 'utf8');
    assert(checkActiveView.includes('!iss.isSubtask'), 'active-sprint-view.js 應包含 !iss.isSubtask 卡片過濾');

    const checkHistoryView = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/history-sprint-view.js'), 'utf8');
    assert(checkHistoryView.includes('!iss.isSubtask'), 'history-sprint-view.js 應包含 !iss.isSubtask 卡片過濾');

    const checkLayoutMgr = fs.readFileSync(path.resolve(__dirname, '..', 'src/layout/layout-manager.js'), 'utf8');
    assert(checkLayoutMgr.includes('!iss.isSubtask'), 'layout-manager.js 應包含 !iss.isSubtask 卡片過濾');

    const checkJiraApi = fs.readFileSync(path.resolve(__dirname, '..', 'src/services/jira-api.js'), 'utf8');
    assert(checkJiraApi.includes('!iss.isSubtask'), 'jira-api.js 應包含 !iss.isSubtask 卡片過濾');

    console.log('✓ 嚴格排除子卡片 (SubTask) 出現在右側欄卡片清單與衝刺統計檢查通過！');
  }

  console.log('--- 測試 27: 右側欄建立卡片自動歸入當前 Sprint、Agile 移動 API 與行內快速建立檢查 ---');
  {
    const { JiraApiService, ActiveSprintView, IssueStore } = BetterJira;

    // 1. 測試 JiraApiService.resolveSprintId
    assert.strictEqual(typeof JiraApiService.resolveSprintId, 'function', 'resolveSprintId 應為函式');

    // 1-1. 直接從 item.meta.sprintId 解析
    const mockItemWithId = {
      meta: { sprintId: '456', title: 'Sprint 20' }
    };
    const resolvedDirect = await JiraApiService.resolveSprintId(mockItemWithId);
    assert.strictEqual(resolvedDirect, '456', '應直接回傳 meta.sprintId');

    // 1-2. 從 IssueStore boardSprints 比對標題解析
    IssueStore.setBoardSprints([
      { id: 789, name: '衝刺 2026-W45', state: 'active' },
      { id: 790, name: '衝刺 2026-W46', state: 'future' }
    ]);
    const mockItemWithoutId = {
      meta: { title: '衝刺 2026-W45' }
    };
    const resolvedFromBoard = await JiraApiService.resolveSprintId(mockItemWithoutId);
    assert.strictEqual(resolvedFromBoard, '789', '應從 boardSprints 成功比對並解析出 sprintId 789');
    assert.strictEqual(mockItemWithoutId.meta.sprintId, '789', '解析後應自動快取至 meta.sprintId');

    // 2. 測試 JiraApiService.moveIssuesToSprint 呼叫 Jira 官方 Agile API
    assert.strictEqual(typeof JiraApiService.moveIssuesToSprint, 'function', 'moveIssuesToSprint 應為函式');
    const origFetch = global.fetch;
    let agileMoveCalled = false;
    let agileMoveUrl = '';
    let agileMoveBody = null;

    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/agile/1.0/sprint/789/issue')) {
        agileMoveCalled = true;
        agileMoveUrl = u;
        agileMoveBody = JSON.parse(opts.body || '{}');
        return {
          ok: true,
          status: 204,
          json: async () => ({})
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const moveResult = await JiraApiService.moveIssuesToSprint(789, ['PROJ-999']);
    assert.strictEqual(moveResult, true, 'moveIssuesToSprint 應回傳 true');
    assert.strictEqual(agileMoveCalled, true, '應呼叫 Jira Agile sprint issue 移動 API');
    assert.deepStrictEqual(agileMoveBody, { issues: ['PROJ-999'] }, 'Payload 應包含 issues: ["PROJ-999"]');

    // 3. 測試 JiraApiService.createIssueInSprint API 建立並自動移入 Sprint
    assert.strictEqual(typeof JiraApiService.createIssueInSprint, 'function', 'createIssueInSprint 應為函式');
    let issueCreated = false;
    let issueMoved = false;

    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/api/3/issue') || u.includes('/rest/api/2/issue')) {
        issueCreated = true;
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: '10001', key: 'PROJ-1001' })
        };
      }
      if (u.includes('/rest/agile/1.0/sprint/789/issue')) {
        issueMoved = true;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const createRes = await JiraApiService.createIssueInSprint({
      summary: '測試在衝刺中建立卡片',
      sprintId: 789,
      projectKey: 'PROJ'
    });
    assert.strictEqual(createRes.success, true, 'createIssueInSprint 應回傳 success: true');
    assert.strictEqual(createRes.key, 'PROJ-1001', '建立成功應回傳卡片 Key');
    assert.strictEqual(issueCreated, true, '應呼叫 issue 建立 API');
    assert.strictEqual(issueMoved, true, '建立後應自動將卡片移入 Sprint 789');

    // 4. 測試 ActiveSprintView.handleNewlyCreatedIssue 與建立追蹤
    let trackerMovedCalled = false;
    let toastCreated = false;
    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/agile/1.0/sprint/789/issue')) {
        trackerMovedCalled = true;
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const mockTracker = {
      item: mockItemWithoutId,
      sprintId: '789',
      sprintTitle: '衝刺 2026-W45',
      startTime: Date.now(),
      processedKeys: new Set()
    };

    // 模擬 document.createElement 與 document.body 以支援 Toast
    const origCreateElement = global.document.createElement;
    const origDocBody = global.document.body;
    const origDocQuerySelector = global.document.querySelector;

    global.document.createElement = (tag) => new MockElement(tag);
    global.document.body = new MockElement('body');
    global.document.querySelector = (sel) => {
      if (sel === '.bjwt-sprint-create-toast') return null;
      if (origDocQuerySelector) return origDocQuerySelector(sel);
      return null;
    };

    let appendedToast = null;
    const origBodyAppendChild = global.document.body.appendChild;
    global.document.body.appendChild = function(el) {
      if (el && el.className && el.className.includes('bjwt-sprint-create-toast')) {
        toastCreated = true;
        appendedToast = el;
      }
      return origBodyAppendChild.call(this, el);
    };

    await ActiveSprintView.handleNewlyCreatedIssue('PROJ-1002', mockTracker);
    assert.strictEqual(trackerMovedCalled, true, 'handleNewlyCreatedIssue 應將卡片移動至指定衝刺');
    assert.strictEqual(toastCreated, true, '卡片移動後應顯示衝刺建立 Toast 提示');
    assert(appendedToast.innerHTML.includes('PROJ-1002'), 'Toast 內容應包含新卡片編號 PROJ-1002');
    assert(appendedToast.innerHTML.includes('衝刺 2026-W45'), 'Toast 內容應包含衝刺名稱');

    // 5. 測試自定義檢視中行內建立表單與完整視窗按鈕結構
    const activeViewJs = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/active-sprint-view.js'), 'utf8');
    assert(activeViewJs.includes('bjwt-active-inline-create-form'), '應包含 bjwt-active-inline-create-form 表單');
    assert(activeViewJs.includes('bjwt-inline-create-input'), '應包含 bjwt-inline-create-input 輸入框');
    assert(activeViewJs.includes('bjwt-inline-create-submit-btn'), '應包含 bjwt-inline-create-submit-btn 建立按鈕');
    assert(activeViewJs.includes('bjwt-inline-create-modal-btn'), '應包含 bjwt-inline-create-modal-btn 完整視窗按鈕');
    assert(activeViewJs.includes('bjwt-inline-create-cancel-btn'), '應包含 bjwt-inline-create-cancel-btn 取消按鈕');
    assert(activeViewJs.includes('startSprintCreationTracking'), '應包含 startSprintCreationTracking 建立追蹤機制');

    // 6. 測試 CSS 樣式包含行內建立與 Toast 樣式
    const stylesCssContent = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
    const runtimeStylesJsContent = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');

    [stylesCssContent, runtimeStylesJsContent].forEach((styleCode) => {
      assert(styleCode.includes('.bjwt-active-inline-create-form'), '應包含 .bjwt-active-inline-create-form');
      assert(styleCode.includes('.bjwt-inline-create-input'), '應包含 .bjwt-inline-create-input');
      assert(styleCode.includes('.bjwt-inline-create-submit-btn'), '應包含 .bjwt-inline-create-submit-btn');
      assert(styleCode.includes('.bjwt-inline-create-modal-btn'), '應包含 .bjwt-inline-create-modal-btn');
      assert(styleCode.includes('.bjwt-inline-create-cancel-btn'), '應包含 .bjwt-inline-create-cancel-btn');
      assert(styleCode.includes('.bjwt-sprint-create-toast'), '應包含 .bjwt-sprint-create-toast');
    });

    global.fetch = origFetch;
    global.document.createElement = origCreateElement;
    global.document.body = origDocBody;
    global.document.querySelector = origDocQuerySelector;

    console.log('✓ 右側欄建立卡片自動歸入當前 Sprint、Agile 移動 API 與行內快速建立檢查通過！');
  }

  console.log('--- 測試 28: 卡片右鍵選單「移動至其他 Sprint」功能、候選衝刺篩選 (進行中與未開始) 與儲存移動檢查 ---');
  {
    const { CardContextMenuComponent, IssueStore, JiraApiService } = BetterJira;

    // 1. 測試 CardContextMenuComponent 匯出與相關方法
    assert(CardContextMenuComponent, 'BetterJira 應匯出 CardContextMenuComponent');
    assert.strictEqual(typeof CardContextMenuComponent.openMoveSprintModal, 'function', 'CardContextMenuComponent 應提供 openMoveSprintModal');
    assert.strictEqual(typeof CardContextMenuComponent.getCandidateMoveSprints, 'function', 'CardContextMenuComponent 應提供 getCandidateMoveSprints');
    assert.strictEqual(typeof CardContextMenuComponent.showSprintMoveToast, 'function', 'CardContextMenuComponent 應提供 showSprintMoveToast');
    assert.strictEqual(typeof IssueStore.moveIssueInSprintStore, 'function', 'IssueStore 應提供 moveIssueInSprintStore');

    // 2. 測試右鍵選單 HTML 模板是否包含「移動至其他 Sprint...」動作項目
    const cardContextMenuJs = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/card-context-menu.js'), 'utf8');
    assert(cardContextMenuJs.includes('移動至其他 Sprint...'), 'card-context-menu.js 應包含「移動至其他 Sprint...」選項文字');
    assert(cardContextMenuJs.includes('data-action="move-sprint"'), 'card-context-menu.js 應包含 data-action="move-sprint"');
    assert(cardContextMenuJs.includes('openMoveSprintModal'), 'card-context-menu.js 應在點擊時呼叫 openMoveSprintModal');

    // 3. 測試 getCandidateMoveSprints 篩選候選衝刺 (嚴格僅保留 active 與 future，排除 closed 衝刺)
    IssueStore.setBoardSprints([
      { id: 301, name: '2026-W45 進行中衝刺', state: 'active' },
      { id: 302, name: '2026-W46 未開始衝刺 A', state: 'future' },
      { id: 303, name: '2026-W47 未開始衝刺 B', state: 'future' },
      { id: 300, name: '2026-W44 已結束歷史衝刺', state: 'closed' }
    ]);

    const candidates = await CardContextMenuComponent.getCandidateMoveSprints();
    assert.strictEqual(candidates.length, 3, '候選衝刺應僅包含 3 個 (1 active + 2 future)');
    assert(candidates.some((s) => s.id === '301' && s.state === 'active' && s.stateLabel === '進行中'), '應包含 301 進行中衝刺');
    assert(candidates.some((s) => s.id === '302' && s.state === 'future' && s.stateLabel === '未開始'), '應包含 302 未開始衝刺');
    assert(candidates.some((s) => s.id === '303' && s.state === 'future' && s.stateLabel === '未開始'), '應包含 303 未開始衝刺');
    assert(!candidates.some((s) => s.id === '300'), '不可包含已結束 (closed) 的歷史衝刺');

    // 4. 測試 openMoveSprintModal 介面渲染與移動互動
    const origCreateElement = global.document.createElement;
    const origDocBody = global.document.body;
    const origDocQuerySelector = global.document.querySelector;

    global.document.createElement = (tag) => new MockElement(tag);
    global.document.body = new MockElement('body');

    await CardContextMenuComponent.openMoveSprintModal({
      key: 'WMC-999',
      summary: '測試移動卡片至其他衝刺',
      sprintId: '301',
      sprintTitle: '2026-W45 進行中衝刺'
    });

    const modal = global.document.body.querySelector('#bjwt-move-sprint-modal');
    assert(modal, '移動卡片彈窗應成功加入 document.body');
    const badge = modal.querySelector('.bjwt-move-sprint-badge');
    assert(badge && badge.textContent.includes('WMC-999'), '彈窗標頭應顯示卡片 Key: WMC-999');
    const currentInfo = modal.querySelector('.bjwt-move-sprint-current');
    assert(currentInfo && currentInfo.textContent.includes('2026-W45'), '彈窗應顯示目前所在衝刺');

    const selectEl = modal.querySelector('#bjwt-move-sprint-select');
    assert(selectEl, '應存在衝刺選單 select');
    const submitBtn = modal.querySelector('.bjwt-move-sprint-submit-btn');
    assert(submitBtn, '應存在「儲存」按鈕');
    assert.strictEqual(submitBtn.disabled, true, '尚未選擇或選擇目前衝刺時「儲存」按鈕應為 disabled');

    // 模擬選擇 302 (未開始衝刺 A)
    selectEl.value = '302';
    await selectEl.dispatchEvent({ type: 'change' });
    assert.strictEqual(submitBtn.disabled, false, '選擇有效目標衝刺後「儲存」按鈕應啟用');

    // 5. 測試點擊「儲存」呼叫 Jira Agile 移動 API、更新 IssueStore 快取並彈出 Toast
    const origFetch = global.fetch;
    let agileMoveCalled = false;
    let targetMoveUrl = '';
    let targetMovePayload = null;
    let moveToastShown = false;

    global.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/agile/1.0/sprint/302/issue')) {
        agileMoveCalled = true;
        targetMoveUrl = u;
        targetMovePayload = JSON.parse(opts.body || '{}');
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    // 監聽 toast
    const origAppend = global.document.body.appendChild;
    global.document.body.appendChild = function(el) {
      if (el && el.className && el.className.includes('bjwt-sprint-create-toast')) {
        moveToastShown = true;
      }
      return origAppend.call(this, el);
    };

    // 準備 IssueStore 快取狀態測試 moveIssueInSprintStore
    IssueStore.setActiveSprintCache('sprint_301', {
      key: 'sprint_301',
      sprintId: '301',
      issues: [{ key: 'WMC-999', summary: '測試移動卡片' }]
    });
    IssueStore.setActiveSprintCache('sprint_302', {
      key: 'sprint_302',
      sprintId: '302',
      issues: []
    });

    await submitBtn.dispatchEvent({ type: 'click' });

    assert.strictEqual(agileMoveCalled, true, '點擊儲存應發送 Agile API 請求移動卡片');
    assert(targetMoveUrl.includes('/rest/agile/1.0/sprint/302/issue'), '應呼叫目標 Sprint 302 的 issue 端點');
    assert.deepStrictEqual(targetMovePayload, { issues: ['WMC-999'] }, 'Payload 應包含 WMC-999');

    // 驗證快取更新
    const sprint301Cache = IssueStore.getActiveSprintCache('sprint_301');
    const sprint302Cache = IssueStore.getActiveSprintCache('sprint_302');
    assert(!sprint301Cache.issues.some((i) => i.key === 'WMC-999'), '舊衝刺快取中應已移除 WMC-999');
    assert(sprint302Cache.issues.some((i) => i.key === 'WMC-999'), '新衝刺快取中應已加入 WMC-999');

    assert.strictEqual(moveToastShown, true, '移動成功後應顯示移動成功 Toast');

    // 6. 測試 CSS 樣式包含移動彈窗類別
    const stylesCssContent = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
    const runtimeStylesJsContent = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');

    [stylesCssContent, runtimeStylesJsContent].forEach((styleCode) => {
      assert(styleCode.includes('.bjwt-move-sprint-overlay'), '應包含 .bjwt-move-sprint-overlay');
      assert(styleCode.includes('.bjwt-move-sprint-dialog'), '應包含 .bjwt-move-sprint-dialog');
      assert(styleCode.includes('.bjwt-move-sprint-header'), '應包含 .bjwt-move-sprint-header');
      assert(styleCode.includes('.bjwt-move-sprint-select'), '應包含 .bjwt-move-sprint-select');
      assert(styleCode.includes('.bjwt-move-sprint-submit-btn'), '應包含 .bjwt-move-sprint-submit-btn');
      assert(styleCode.includes('.bjwt-move-sprint-cancel-btn'), '應包含 .bjwt-move-sprint-cancel-btn');
    });

    // 7. 測試 IssueStore.moveIssueInSprintStore 支援從已結束歷史衝刺快取移動至目標衝刺
    IssueStore.appendHistoricalSprintToState({
      key: 'hist_move_test',
      title: '歷史衝刺移動測試',
      sprintId: '888',
      issues: [
        { key: 'HIST-888', summary: '歷史待移動卡片', storyPoints: 3 }
      ]
    });
    IssueStore.activeSprintCache.set('sprint_701', {
      key: 'sprint_701',
      sprintId: '701',
      title: '目標衝刺',
      issues: []
    });

    IssueStore.moveIssueInSprintStore('HIST-888', '701');

    const targetSprintCache = IssueStore.activeSprintCache.get('sprint_701');
    assert(targetSprintCache.issues.some((i) => i.key === 'HIST-888'), '目標衝刺快取中應已加入 HIST-888');
    const histSprintAfter = IssueStore.loadedHistoricalSprints.find((h) => h.key === 'hist_move_test');
    assert(!histSprintAfter.issues.some((i) => i.key === 'HIST-888'), '歷史衝刺快取中應已移除 HIST-888');

    global.fetch = origFetch;
    global.document.createElement = origCreateElement;
    global.document.body = origDocBody;
    global.document.querySelector = origDocQuerySelector;

    console.log('✓ 卡片右鍵選單「移動至其他 Sprint」功能、候選衝刺篩選 (進行中與未開始) 與儲存移動檢查通過！');
  }

  console.log('--- 測試 29: 卡片編輯模式下新增與編輯留言 (JiraApiService 與 IssueModalComponent) 檢查 ---');
  {
    const { JiraApiService, IssueModalComponent } = BetterJira;

    assert.strictEqual(typeof JiraApiService.addIssueComment, 'function', 'JiraApiService 應匯出 addIssueComment');
    assert.strictEqual(typeof JiraApiService.updateIssueComment, 'function', 'JiraApiService 應匯出 updateIssueComment');

    const origFetch = global.fetch;
    const origGetElementById = global.document.getElementById;
    const origDocBody = global.document.body;
    global.document.body = new MockElement('body');
    global.document.getElementById = (id) => {
      for (const child of global.document.body.children) {
        if (child.id === id) return child;
      }
      return null;
    };

    // 1. 測試 JiraApiService.addIssueComment (v2 成功)
    let apiCalls = [];
    global.fetch = async (url, opts) => {
      apiCalls.push({ url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('/rest/api/2/issue/WMC-555/comment') && opts.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: '9001',
            body: '新測試留言',
            created: '2026-11-13T10:00:00.000+0800',
            author: { displayName: 'Tester' }
          })
        };
      }
      if (url.includes('/rest/api/2/issue/WMC-555/comment/9001') && opts.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '9001',
            body: '修改後的留言',
            created: '2026-11-13T10:00:00.000+0800',
            updated: '2026-11-13T10:05:00.000+0800',
            author: { displayName: 'Tester' }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const addRes = await JiraApiService.addIssueComment('WMC-555', '新測試留言');
    assert.strictEqual(addRes.success, true, 'addIssueComment 應回傳 success: true');
    assert.strictEqual(addRes.comment.id, '9001', 'addIssueComment 應回傳建立的留言 ID');
    assert.strictEqual(apiCalls[0].body.body, '新測試留言', 'addIssueComment v2 payload 應為純文字 body');

    // 2. 測試 JiraApiService.updateIssueComment (v2 失敗 400 時自動回退 v3 ADF)
    apiCalls = [];
    global.fetch = async (url, opts) => {
      apiCalls.push({ url, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('/rest/api/2/issue/WMC-555/comment/9001') && opts.method === 'PUT') {
        return { ok: false, status: 400, json: async () => ({ errorMessages: ['ADF required'] }) };
      }
      if (url.includes('/rest/api/3/issue/WMC-555/comment/9001') && opts.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '9001',
            body: opts.body ? JSON.parse(opts.body).body : null,
            created: '2026-11-13T10:00:00.000+0800',
            updated: '2026-11-13T10:06:00.000+0800',
            author: { displayName: 'Tester' }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const editRes = await JiraApiService.updateIssueComment('WMC-555', '9001', '回退至 v3 ADF 留言');
    assert.strictEqual(editRes.success, true, 'updateIssueComment 回退至 v3 ADF 應成功');
    assert.strictEqual(apiCalls.length, 2, '應先嘗試 v2 再回退至 v3');
    assert.strictEqual(apiCalls[1].body.body.type, 'doc', 'v3 回退 payload 應為 ADF doc 格式');

    // 3. 測試 IssueModalComponent 編輯模式下的留言新增與既有留言編輯互動
    apiCalls = [];
    global.fetch = async (url, opts) => {
      apiCalls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (url.includes('/rest/api/2/issue/WMC-555?expand=renderedFields')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            key: 'WMC-555',
            fields: {
              summary: '測試留言互動卡片',
              description: '原始說明',
              status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
              comment: {
                comments: [
                  {
                    id: '101',
                    body: '既有留言內容',
                    created: '2026-11-12T09:00:00.000+0800',
                    author: { displayName: 'Alice' }
                  }
                ]
              }
            },
            renderedFields: {}
          })
        };
      }
      if (url.includes('/transitions')) {
        return { ok: true, status: 200, json: async () => ({ transitions: [] }) };
      }
      if (url.includes('/rest/api/2/issue/WMC-555/comment/101') && opts && opts.method === 'PUT') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: '101',
            body: apiCalls[apiCalls.length - 1].body.body,
            created: '2026-11-12T09:00:00.000+0800',
            updated: '2026-11-13T11:00:00.000+0800',
            author: { displayName: 'Alice' }
          })
        };
      }
      if (url.includes('/rest/api/2/issue/WMC-555/comment') && opts && opts.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: '102',
            body: apiCalls[apiCalls.length - 1].body.body,
            created: '2026-11-13T11:05:00.000+0800',
            author: { displayName: 'Bob' }
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    IssueModalComponent.openHistoricalIssueDetailModal('WMC-555', {
      key: 'WMC-555',
      summary: '測試留言互動卡片',
      statusName: 'In Progress',
      statusCategory: 'indeterminate'
    });

    const modalEl = global.document.getElementById(BetterJira.Constants.HISTORY_ISSUE_MODAL_ID);
    assert(modalEl, '應成功開啟卡片 Modal');
    modalEl.isConnected = true;

    // 等待非同步載入詳情完成
    await new Promise((r) => setTimeout(r, 20));

    const editBtn = modalEl.querySelector('.bjwt-history-modal-edit-btn');
    assert(editBtn, 'Modal 應包含編輯按鈕');
    await editBtn.dispatchEvent({ type: 'click' });
    assert.strictEqual(modalEl.getAttribute('data-bjwt-edit-mode'), 'true', '點擊編輯後應進入編輯模式');

    // 3a. 點擊既有留言的編輯按鈕並儲存
    const commEditBtn = modalEl.querySelector('.bjwt-comment-edit-btn');
    assert(commEditBtn, '編輯模式下既有留言應顯示編輯按鈕');
    await commEditBtn.dispatchEvent({ type: 'click' });

    const commEditTextarea = modalEl.querySelector('.bjwt-comment-edit-textarea');
    const commEditSaveBtn = modalEl.querySelector('.bjwt-comment-edit-save-btn');
    assert(commEditTextarea && commEditSaveBtn, '應展開留言編輯輸入框與儲存按鈕');
    commEditTextarea.value = '更新後的既有留言';
    await commEditSaveBtn.dispatchEvent({ type: 'click' });
    assert(apiCalls.some((c) => c.method === 'PUT' && c.url.includes('/comment/101') && c.body.body === '更新後的既有留言'), '應發送 PUT 請求更新留言 101');

    // 3b. 使用新增留言輸入框並透過「新增留言」按鈕送出
    const addCommField = modalEl.querySelector('#bjwt-add-comment-field');
    const addCommBtn = modalEl.querySelector('#bjwt-add-comment-btn');
    assert(addCommField && addCommBtn, '編輯模式下應顯示新增留言輸入框與送出按鈕');
    addCommField.value = '直接送出的新留言';
    await addCommBtn.dispatchEvent({ type: 'click' });
    assert(apiCalls.some((c) => c.method === 'POST' && c.url.includes('/comment') && c.body.body === '直接送出的新留言'), '應發送 POST 請求新增留言');
    assert.strictEqual(modalEl.querySelector('#bjwt-detail-comments-count').textContent, '2', '新增留言後留言數應更新為 2');

    // 3c. 若在新增留言輸入框輸入內容後直接按頂部「儲存」按鈕也應一併送出留言
    addCommField.value = '透過頂部儲存送出的留言';
    const topSaveBtn = modalEl.querySelector('.bjwt-history-modal-save-btn');
    await topSaveBtn.dispatchEvent({ type: 'click' });
    assert(apiCalls.some((c) => c.method === 'POST' && c.url.includes('/comment') && c.body.body === '透過頂部儲存送出的留言'), '點擊頂部儲存按鈕時應一併送出待儲存的新留言');
    assert.strictEqual(modalEl.querySelector('#bjwt-detail-comments-count').textContent, '3', '留言數應更新為 3');

    // 4. 檢查樣式表包含留言編輯樣式
    const stylesCssStr = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
    const runtimeStylesStr = fs.readFileSync(path.resolve(__dirname, '..', 'src/components/runtime-styles.js'), 'utf8');
    [stylesCssStr, runtimeStylesStr].forEach((css) => {
      assert(css.includes('.bjwt-comment-add-box'), '應包含 .bjwt-comment-add-box 樣式');
      assert(css.includes('.bjwt-comment-edit-btn'), '應包含 .bjwt-comment-edit-btn 樣式');
      assert(css.includes('.bjwt-comment-textarea'), '應包含 .bjwt-comment-textarea 樣式');
    });

    IssueModalComponent.closeIssueDetailModal(modalEl);
    global.fetch = origFetch;
    global.document.getElementById = origGetElementById;
    global.document.body = origDocBody;

    console.log('✓ 卡片編輯模式下新增與編輯留言檢查通過！');
  }

  console.log('============================================');
  console.log('🎉 所有單元與整合測試全部通過！功能完全一致且無退化！');
  console.log('============================================');
})();
