/**
 * @fileoverview 自動化驗證測試腳本
 * 測試重構後的各模組功能、邏輯正確性與邊界條件，確保無任何功能退化 (Regression-free)。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 模擬瀏覽器全域環境
global.window = {
  location: {
    origin: 'https://swpc.atlassian.net',
    href: 'https://swpc.atlassian.net/jira/software/projects/WMC/boards/391/backlog'
  }
};
global.document = {
  head: { appendChild: () => {} },
  documentElement: { appendChild: () => {} }
};

// 依載入順序逐一載入各模組
const filesToLoad = [
  'src/constants.js',
  'src/utils/text-utils.js',
  'src/utils/dom-utils.js',
  'src/utils/assignee-utils.js',
  'src/services/sprint-stats.js',
  'src/state/issue-store.js',
  'src/services/jira-api.js',
  'src/services/filter-service.js',
  'src/parser/adf-parser.js',
  'src/parser/sprint-dom-parser.js',
  'src/parser/card-dom-parser.js',
  'src/components/runtime-styles.js',
  'src/components/issue-card.js',
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
assert(runtimeStylesJs.includes('width: 88px !important;'), 'runtime-styles.js 狀態徽章應設定固定寬度 88px');
assert(runtimeStylesJs.includes('justify-content: flex-start !important;'), 'runtime-styles.js 狀態徽章應設定靠左對齊');
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
    if (this._textContent !== undefined) return this._textContent;
    if (this.children.length === 0) return '';
    return this.children.map((c) => c.textContent).join(' ');
  }
  set textContent(val) {
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
  get className() {
    return Array.from(this.classList._classes).join(' ');
  }
  set className(val) {
    this.classList._classes = new Set((val || '').split(/\s+/).filter(Boolean));
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
        const m = part.match(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/);
        if (m) {
          const attr = m[1];
          const op = m[2];
          const val = m[3] || m[4] || m[5] || '';
          const actual = this.getAttribute(attr);
          if (actual === null) return false;
          if (!op) return true;
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
}
global.Element = MockElement;

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

  console.log('--- 測試 16: 方案 B：Bootstrap 5 與 Material Design 3 完整元件級樣式檢查 ---');
  const updatedStylesCss = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');

  // Bootstrap 5 元件檢查
  assert(updatedStylesCss.includes('html[data-betterjira-theme="Bootstrap"] .bjwt-sprint-tab'), '應包含 Bootstrap 側邊欄清單樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="Bootstrap"] .bjwt-active-create-btn'), '應包含 Bootstrap 新增按鈕樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="Bootstrap"] .bjwt-history-card-filter'), '應包含 Bootstrap 搜尋輸入框樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="Bootstrap"] .bjwt-history-status-badge'), '應包含 Bootstrap 狀態徽章樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="Bootstrap"] .bjwt-history-card'), '應包含 Bootstrap 卡片樣式');

  // Material Design 3 元件檢查
  assert(updatedStylesCss.includes('html[data-betterjira-theme="MaterialDesign"] .bjwt-sprint-tab'), '應包含 M3 側邊欄清單膠囊樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="MaterialDesign"] .bjwt-active-create-btn'), '應包含 M3 Filled 按鈕樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="MaterialDesign"] .bjwt-history-card-filter'), '應包含 M3 Search Bar 樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="MaterialDesign"] .bjwt-history-status-badge'), '應包含 M3 狀態膠囊 Chip 樣式');
  assert(updatedStylesCss.includes('html[data-betterjira-theme="MaterialDesign"] .bjwt-history-card'), '應包含 M3 Elevated 卡片樣式');

  console.log('✓ 方案 B 元件級樣式檢查通過！');

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

  console.log('============================================');
  console.log('🎉 所有單元與整合測試全部通過！功能完全一致且無退化！');
  console.log('============================================');
})();
