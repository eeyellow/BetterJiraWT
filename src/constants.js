/**
 * @fileoverview 定義 BetterJiraWT 擴充功能中使用的全域常數、DOM 選擇器與識別碼
 * @module constants
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 套用於 <html> 與 <body> 的外觀主題屬性名稱
   * @type {string}
   */
  const THEME_ATTR = 'data-betterjira-theme';

  /**
   * 標記當前頁面排版啟用狀態的屬性名稱
   * @type {string}
   */
  const LAYOUT_ACTIVE_ATTR = 'data-betterjira-layout';

  /**
   * 左欄衝刺清單側邊欄容器的 DOM ID
   * @type {string}
   */
  const SIDEBAR_ID = 'bjwt-sprint-sidebar';

  /**
   * 卡片置中詳細視窗背景遮罩 (Backdrop) 的 DOM ID
   * @type {string}
   */
  const MODAL_BACKDROP_ID = 'bjwt-issue-modal-backdrop';

  /**
   * 歷史 Sprint 選擇視窗 (Picker Modal) 的 DOM ID
   * @type {string}
   */
  const HISTORY_PICKER_MODAL_ID = 'bjwt-history-picker-modal';

  /**
   * 歷史 Sprint 卡片詳細資訊置中視窗的 DOM ID
   * @type {string}
   */
  const HISTORY_ISSUE_MODAL_ID = 'bjwt-history-issue-modal';

  /**
   * 即時注入之關鍵執行期樣式 <style> 標籤 ID
   * @type {string}
   */
  const RUNTIME_STYLE_ID = 'bjwt-runtime-critical-styles';

  /**
   * 用於在 Jira Backlog 頁面中尋找所有衝刺 (Sprint) 容器的候選 CSS 選擇器清單
   * @type {string[]}
   */
  const SPRINT_SELECTORS = [
    '[data-testid="software-backlog.card-list.container"]',
    '[data-testid^="software-backlog.card-list.container"]',
    '[data-testid*="software-backlog.card-list"][data-testid*="container"]',
    '.ghx-backlog-container',
    '.js-sprint-container',
    '[data-sprint-id]',
    '.sprint-container'
  ];

  /**
   * 用於在衝刺容器中定位單張工作項目卡片的候選 CSS 選擇器清單
   * @type {string[]}
   */
  const CARD_SELECTORS = [
    '[data-testid="software-backlog.card-list.card.card-contents.card-container"]',
    '[data-testid^="software-backlog.card-list.card."]',
    '[data-testid*="issue-card"]',
    '.js-issue',
    '.ghx-issue-compact',
    '.sprint-card:not(.bjwt-history-card)'
  ];

  /**
   * Jira 原生右側詳細面板 (Issue Detail View) 的候選 CSS 選擇器清單
   * @type {string[]}
   */
  const ISSUE_DETAIL_SELECTORS = [
    '[data-testid="software-backlog.backlog-content.issue-detail-wrapper"]',
    '[data-testid*="backlog-content.issue-detail"]',
    '[data-testid="issue.views.issue-details.issue-layout.issue-view"]',
    '[data-testid*="issue.views.issue-details.issue-layout"]',
    '[data-testid*="issue.views.issue-base.foundation.summary"]',
    '[data-testid*="issue-view-layout-templates"]',
    '[data-testid*="issue-detail"]',
    '#jira-issue-header',
    '#ghx-detail-view',
    '.ghx-detail-view'
  ];

  /**
   * 判斷衝刺標題候選文字時應略過的原生功能按鈕文字集合
   * @type {Set<string>}
   */
  const IGNORED_BUTTON_TEXTS = new Set([
    '完成衝刺',
    '開始衝刺',
    '建立衝刺',
    '編輯衝刺',
    '刪除衝刺',
    '建立問題',
    '更多動作',
    'complete sprint',
    'start sprint',
    'create sprint',
    'edit sprint',
    'delete sprint',
    'create issue',
    'more actions'
  ]);

  BetterJira.Constants = {
    THEME_ATTR,
    LAYOUT_ACTIVE_ATTR,
    SIDEBAR_ID,
    MODAL_BACKDROP_ID,
    HISTORY_PICKER_MODAL_ID,
    HISTORY_ISSUE_MODAL_ID,
    RUNTIME_STYLE_ID,
    SPRINT_SELECTORS,
    CARD_SELECTORS,
    ISSUE_DETAIL_SELECTORS,
    IGNORED_BUTTON_TEXTS
  };
})();
