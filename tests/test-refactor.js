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

// 測試完整欄位卡片的第二列結構排版 (flex 切成 n 欄，除最後一欄靠右，其他都靠左)
const fullFeaturedIssue = {
  ...normalized,
  parentSummary: 'Authentication Epic',
  dueDate: '2026年11月4日'
};
const fullCardHtml = IssueCardComponent.renderIssueCardHtml(fullFeaturedIssue);
assert(fullCardHtml.includes('bjwt-card-col-epic'), '卡片第二列應包含第 1 欄：標籤/Epic');
assert(fullCardHtml.includes('bjwt-card-col-status'), '卡片第二列應包含第 2 欄：狀態');
assert(fullCardHtml.includes('bjwt-card-col-duedate'), '卡片第二列應包含第 3 欄：截止日期');
assert(fullCardHtml.includes('bjwt-card-col-right'), '卡片第二列應包含最後一欄：右側操作');
assert(fullCardHtml.includes('bjwt-history-parent-badge'), '第 1 欄應渲染標籤/Epic');
assert(fullCardHtml.includes('bjwt-history-status-badge'), '第 2 欄應渲染狀態徽章');
assert(fullCardHtml.includes('bjwt-history-duedate-badge'), '第 3 欄應渲染截止日期');
assert(fullCardHtml.includes('bjwt-history-points-badge'), '最後一欄應渲染 StoryPoint');
assert(fullCardHtml.includes('bjwt-history-priority-icon'), '最後一欄應渲染優先度圖示');
assert(fullCardHtml.includes('bjwt-history-assignee'), '最後一欄應渲染經辦人');

// 驗證四欄左右結構與出現順序（標籤 -> 狀態 -> 截止日期 -> 最後一欄靠右）
const epicColIdx = fullCardHtml.indexOf('bjwt-card-col-epic');
const statusColIdx = fullCardHtml.indexOf('bjwt-card-col-status');
const duedateColIdx = fullCardHtml.indexOf('bjwt-card-col-duedate');
const rightColIdx = fullCardHtml.indexOf('bjwt-card-col-right');

assert(
  epicColIdx < statusColIdx && statusColIdx < duedateColIdx && duedateColIdx < rightColIdx,
  '欄位順序應為：標籤 (第1欄) -> 狀態 (第2欄) -> 截止日期 (第3欄) -> 最後一欄靠右'
);

// 驗證無標籤/無截止日期的卡片，仍保留欄位結構 (Slot) 以確保不會跑版
const minimalCardHtml = IssueCardComponent.renderIssueCardHtml(normalized);
assert(minimalCardHtml.includes('bjwt-card-col-epic'), '無標籤時仍應保留第 1 欄 slot');
assert(minimalCardHtml.includes('bjwt-card-col-status'), '無標籤時第 2 欄狀態仍正確存在');
assert(minimalCardHtml.includes('bjwt-card-col-duedate'), '無截止日期時仍應保留第 3 欄 slot');
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

// 測試 updateIssue 遭遇 Screen 不支援 customfield 時的自我修復容錯機制
(async () => {
  let callCount = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    callCount++;
    if (url.includes('/editmeta')) {
      // 模擬 editmeta 中沒有任何 customfield (不在畫面上)
      return {
        ok: true,
        json: async () => ({ fields: { summary: {}, description: {} } })
      };
    }
    if (url.includes('/rest/api/2/issue/TEST-1')) {
      const body = JSON.parse(opts.body);
      if (body.fields.customfield_10046 !== undefined) {
        // 第一次嘗試帶了 customfield_10046，Jira 回傳不在畫面上的錯誤
        return {
          ok: false,
          json: async () => ({
            errors: {
              customfield_10046: "Field 'customfield_10046' cannot be set. It is not on the appropriate screen, or unknown."
            }
          })
        };
      }
      // 重試後只帶 summary/description，成功
      return { ok: true, status: 204 };
    }
    if (url.includes('/estimation')) {
      return { ok: true, status: 204 };
    }
    return { ok: true, json: async () => ({}) };
  };

  const res = await JiraApiService.updateIssue('TEST-1', {
    summary: 'Updated title',
    storyPoints: 5
  });
  assert.strictEqual(res.success, true, '自訂欄位不在畫面上時應自動修復重試並回傳 success: true');
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

console.log('============================================');
console.log('🎉 所有單元與整合測試全部通過！功能完全一致且無退化！');
console.log('============================================');
