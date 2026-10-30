/**
 * @fileoverview 執行期關鍵 CSS 樣式動態注入模組
 * 確保擴充功能關鍵圖示、收合按鈕、歷史衝刺與雙欄樣式即時生效，避免瀏覽器 CSS 快取延遲。
 * @module components/runtime-styles
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 確保關鍵圖示與歷史衝刺樣式即時注入頁面 (即使瀏覽器快取舊版 styles.css 也能立即呈現收合圖示與歷史 Sprint 介面)
   */
  function ensureRuntimeCriticalStyles() {
    const { RUNTIME_STYLE_ID } = BetterJira.Constants;
    if (document.getElementById(RUNTIME_STYLE_ID)) return;
    const styleEl = document.createElement('style');
    styleEl.id = RUNTIME_STYLE_ID;
    styleEl.textContent = `
      .bjwt-icon-svg {
        display: inline-block !important;
        vertical-align: middle !important;
        flex-shrink: 0 !important;
        overflow: visible !important;
      }
      .bjwt-sidebar-collapse-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        height: 26px !important;
        padding: 0 8px !important;
        border: 1px solid var(--ds-border-bold, #738496) !important;
        border-radius: 5px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        color: var(--ds-text, #dee4ea) !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        visibility: visible !important;
        opacity: 1 !important;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16) !important;
      }
      .bjwt-sidebar-collapse-btn:hover {
        background: var(--ds-background-selected, rgba(12, 102, 228, 0.2)) !important;
        color: var(--ds-text-selected, #579dff) !important;
        border-color: var(--ds-border-selected, #579dff) !important;
      }
      .bjwt-sidebar-expand-btn {
        display: none !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 8px !important;
        width: 38px !important;
        padding: 12px 4px !important;
        border: 1px solid var(--ds-border-selected, #579dff) !important;
        border-radius: 8px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        color: var(--ds-text-selected, #579dff) !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        box-shadow: 0 2px 8px rgba(12, 102, 228, 0.25) !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] {
        flex: 0 0 38px !important;
        width: 38px !important;
        max-width: 38px !important;
        min-width: 38px !important;
        height: auto !important;
        max-height: none !important;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        overflow: visible !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sidebar-header,
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sprint-list {
        display: none !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sidebar-expand-btn {
        display: flex !important;
      }
      html[data-betterjira-layout="two-column"] [data-bjwt-layout-host="true"][data-bjwt-sidebar-collapsed="true"] [data-bjwt-sprint-branch="true"][data-bjwt-sprint-active="true"],
      html[data-betterjira-layout="two-column"] [data-bjwt-layout-host="true"][data-bjwt-sidebar-collapsed="true"] [data-bjwt-sprint-header-partner="true"][data-bjwt-sprint-active="true"] {
        flex: 1 1 calc(100% - 54px) !important;
        width: calc(100% - 54px) !important;
        max-width: calc(100% - 54px) !important;
      }
      .bjwt-sidebar-header-actions {
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        flex: 0 0 auto !important;
      }
      .bjwt-history-trigger-btn {
        flex: 0 0 auto !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 26px !important;
        height: 26px !important;
        padding: 0 !important;
        border: 1px solid var(--ds-border-warning, #f59e0b) !important;
        border-radius: 5px !important;
        background: var(--ds-background-warning-subtle, rgba(245, 158, 11, 0.12)) !important;
        color: var(--ds-text-warning, #f59e0b) !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16) !important;
        transition: all 0.15s ease !important;
      }
      .bjwt-history-trigger-btn:hover {
        background: var(--ds-background-warning-hovered, rgba(245, 158, 11, 0.25)) !important;
        border-color: var(--ds-border-warning-hovered, #fbbf24) !important;
        color: var(--ds-text-warning-hovered, #fbbf24) !important;
      }
      .bjwt-history-sprint-container {
        border: 1px solid var(--ds-border, #dfe1e6) !important;
        border-top: 1px solid var(--ds-border, #dfe1e6) !important;
        border-radius: 6px !important;
      }
      .bjwt-history-sprint-banner {
        border: 1px solid var(--ds-border, #dfe1e6) !important;
        border-radius: 6px !important;
      }
      .bjwt-sprint-section-header {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 7px 12px 5px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        letter-spacing: 0.3px !important;
        border-bottom: 1px solid var(--ds-border, #dfe1e6) !important;
      }
      .bjwt-sprint-section-header.live-section {
        background: var(--ds-surface-sunken, rgba(9, 30, 66, 0.04)) !important;
        color: var(--ds-text-subtle, #64748b) !important;
      }
      .bjwt-sprint-section-header.history-section {
        background: rgba(245, 158, 11, 0.14) !important;
        color: #f59e0b !important;
        border-top: 2px solid rgba(245, 158, 11, 0.35) !important;
        border-bottom: 1px solid rgba(245, 158, 11, 0.35) !important;
      }
      .bjwt-status-dot {
        width: 7px !important;
        height: 7px !important;
        border-radius: 50% !important;
        flex-shrink: 0 !important;
        display: inline-block !important;
      }
      .bjwt-status-dot.live-dot,
      .bjwt-status-dot.live-item-dot {
        background: #22c55e !important;
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.22) !important;
      }
      .bjwt-sprint-tab-left {
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
      }
      .bjwt-sprint-tab-right {
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        flex-shrink: 0 !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history {
        background: rgba(245, 158, 11, 0.07) !important;
        border-left: 3px dashed #f59e0b !important;
        border-bottom: 1px solid var(--ds-border, rgba(245, 158, 11, 0.2)) !important;
        color: var(--ds-text, #f59e0b) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history:hover {
        background: rgba(245, 158, 11, 0.16) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history.active {
        background: rgba(245, 158, 11, 0.24) !important;
        color: #f59e0b !important;
        border-left: 4px solid #f59e0b !important;
        font-weight: 700 !important;
      }
      .bjwt-closed-pill {
        padding: 1px 6px !important;
        border-radius: 4px !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        background: rgba(245, 158, 11, 0.2) !important;
        color: #f59e0b !important;
        border: 1px solid rgba(245, 158, 11, 0.45) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history.active .bjwt-closed-pill {
        background: #d97706 !important;
        color: #ffffff !important;
        border-color: #d97706 !important;
      }
      .bjwt-history-remove-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 18px !important;
        height: 18px !important;
        border-radius: 50% !important;
        font-size: 11px !important;
        color: var(--ds-text-subtle, #f59e0b) !important;
        opacity: 0.75 !important;
      }
      .bjwt-history-remove-btn:hover {
        opacity: 1 !important;
        background: rgba(245, 158, 11, 0.28) !important;
      }
      .bjwt-history-priority-icon.bjwt-svg-wrap {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 16px !important;
        height: 16px !important;
        line-height: 1 !important;
      }
      .bjwt-history-priority-icon.bjwt-svg-wrap svg {
        width: 16px !important;
        height: 16px !important;
        max-width: 16px !important;
        max-height: 16px !important;
      }
      #bjwt-history-issue-modal {
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
        background: var(--ds-surface-overlay, #1d2125) !important;
        border: 1px solid var(--ds-border, #38414a) !important;
      }
      .bjwt-history-issue-modal-header {
        flex: 0 0 auto !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 12px !important;
        padding: 10px 16px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        border-bottom: 1px solid var(--ds-border, #38414a) !important;
      }
      .bjwt-history-issue-modal-title {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        min-width: 0 !important;
      }
      .bjwt-history-modal-key-badge {
        padding: 3px 8px !important;
        border-radius: 4px !important;
        background: rgba(12, 102, 228, 0.2) !important;
        color: #579dff !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        flex-shrink: 0 !important;
      }
      .bjwt-history-modal-summary-text {
        font-size: 14px !important;
        font-weight: 600 !important;
        color: var(--ds-text, #dee4ea) !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      .bjwt-history-issue-modal-actions {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        flex-shrink: 0 !important;
      }
      .bjwt-history-modal-open-tab {
        padding: 4px 10px !important;
        border-radius: 4px !important;
        background: rgba(12, 102, 228, 0.2) !important;
        color: #579dff !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        text-decoration: none !important;
      }
      .bjwt-history-modal-open-tab:hover {
        background: rgba(12, 102, 228, 0.35) !important;
      }
      .bjwt-history-modal-close-btn {
        width: 28px !important;
        height: 28px !important;
        border-radius: 4px !important;
        border: none !important;
        background: transparent !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
        font-size: 15px !important;
        cursor: pointer !important;
      }
      .bjwt-history-modal-close-btn:hover {
        background: rgba(255, 255, 255, 0.1) !important;
      }
      .bjwt-rich-detail-body {
        display: flex !important;
        flex-direction: row !important;
        width: 100% !important;
        height: calc(100% - 50px) !important;
        overflow: hidden !important;
        background: var(--ds-surface, #1d2125) !important;
        color: var(--ds-text, #dee4ea) !important;
      }
      .bjwt-detail-main-col {
        flex: 1 1 68% !important;
        min-width: 0 !important;
        height: 100% !important;
        overflow-y: auto !important;
        padding: 24px 28px !important;
        box-sizing: border-box !important;
      }
      .bjwt-detail-side-col {
        flex: 0 0 320px !important;
        width: 320px !important;
        height: 100% !important;
        overflow-y: auto !important;
        padding: 24px 20px !important;
        background: var(--ds-surface-sunken, rgba(0, 0, 0, 0.2)) !important;
        border-left: 1px solid var(--ds-border, #2c333a) !important;
        box-sizing: border-box !important;
      }
      .bjwt-detail-summary {
        font-size: 20px !important;
        font-weight: 700 !important;
        line-height: 1.35 !important;
        margin: 0 0 20px 0 !important;
        color: var(--ds-text, #ffffff) !important;
        word-break: break-word !important;
      }
      .bjwt-detail-section {
        margin-bottom: 24px !important;
      }
      .bjwt-detail-section-title {
        font-size: 13px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
        margin: 0 0 10px 0 !important;
        border-bottom: 1px solid var(--ds-border, rgba(255, 255, 255, 0.1)) !important;
        padding-bottom: 6px !important;
      }
      .bjwt-detail-description-content {
        font-size: 14px !important;
        line-height: 1.6 !important;
        color: var(--ds-text, #dee4ea) !important;
        word-break: break-word !important;
      }
      .bjwt-detail-description-content p {
        margin: 0 0 10px 0 !important;
      }
      .bjwt-detail-description-content pre {
        background: rgba(0, 0, 0, 0.3) !important;
        padding: 10px 14px !important;
        border-radius: 6px !important;
        overflow-x: auto !important;
        font-family: monospace !important;
      }
      .bjwt-detail-description-content a {
        color: #579dff !important;
        text-decoration: underline !important;
      }
      .bjwt-detail-empty-desc {
        font-size: 13px !important;
        color: var(--ds-text-subtle, #8c9bab) !important;
        font-style: italic !important;
        padding: 8px 0 !important;
      }
      .bjwt-detail-loading-spinner {
        display: inline-block !important;
        width: 14px !important;
        height: 14px !important;
        border: 2px solid rgba(255, 255, 255, 0.2) !important;
        border-top-color: #579dff !important;
        border-radius: 50% !important;
        animation: bjwt-spin 0.8s linear infinite !important;
        vertical-align: middle !important;
        margin-right: 6px !important;
      }
      @keyframes bjwt-spin {
        to { transform: rotate(360deg); }
      }
      .bjwt-detail-field-group {
        display: flex !important;
        flex-direction: column !important;
        gap: 16px !important;
      }
      .bjwt-detail-field {
        display: flex !important;
        flex-direction: column !important;
        gap: 5px !important;
      }
      .bjwt-detail-field-label {
        font-size: 11px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
      }
      .bjwt-detail-field-value {
        font-size: 13px !important;
        color: var(--ds-text, #dee4ea) !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
      }
      .bjwt-user-cell {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
      }
      .bjwt-user-cell img {
        width: 22px !important;
        height: 22px !important;
        border-radius: 50% !important;
      }
      .bjwt-user-avatar-placeholder {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 22px !important;
        height: 22px !important;
        border-radius: 50% !important;
        background: rgba(255, 255, 255, 0.1) !important;
        font-size: 12px !important;
      }
      .bjwt-detail-label-tag {
        display: inline-block !important;
        padding: 2px 7px !important;
        border-radius: 4px !important;
        background: var(--ds-surface-sunken, rgba(255, 255, 255, 0.08)) !important;
        border: 1px solid var(--ds-border, #38414a) !important;
        font-size: 11px !important;
        color: var(--ds-text, #dee4ea) !important;
        margin: 2px 4px 2px 0 !important;
      }
      .bjwt-detail-labels-container {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 4px !important;
      }
      .bjwt-mention {
        padding: 1px 5px !important;
        border-radius: 3px !important;
        background: rgba(87, 157, 255, 0.18) !important;
        color: #579dff !important;
        font-weight: 600 !important;
      }
      .bjwt-table-wrap {
        max-width: 100% !important;
        overflow-x: auto !important;
        margin: 12px 0 !important;
      }
      .bjwt-table-wrap table {
        width: 100% !important;
        border-collapse: collapse !important;
      }
      .bjwt-table-wrap th,
      .bjwt-table-wrap td {
        border: 1px solid var(--ds-border, #38414a) !important;
        padding: 6px 10px !important;
        font-size: 13px !important;
      }
      .bjwt-table-wrap th {
        background: var(--ds-surface-raised, rgba(255, 255, 255, 0.06)) !important;
        font-weight: 600 !important;
      }
      .bjwt-comment-list {
        display: flex !important;
        flex-direction: column !important;
        gap: 14px !important;
      }
      .bjwt-comment-item {
        padding: 12px 14px !important;
        border-radius: 8px !important;
        background: var(--ds-surface-raised, rgba(255, 255, 255, 0.04)) !important;
        border: 1px solid var(--ds-border, #2c333a) !important;
      }
      .bjwt-comment-header {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        margin-bottom: 8px !important;
      }
      .bjwt-comment-author {
        font-size: 13px !important;
        font-weight: 600 !important;
        color: var(--ds-text, #dee4ea) !important;
      }
      .bjwt-comment-date {
        font-size: 11px !important;
        color: var(--ds-text-subtle, #8c9bab) !important;
      }
      .bjwt-comment-body {
        font-size: 13px !important;
        line-height: 1.5 !important;
        color: var(--ds-text, #cbd5e1) !important;
      }
      .bjwt-subtask-list {
        display: flex !important;
        flex-direction: column !important;
        gap: 6px !important;
      }
      .bjwt-subtask-item {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        padding: 8px 12px !important;
        border-radius: 6px !important;
        background: var(--ds-surface-raised, rgba(255, 255, 255, 0.03)) !important;
        border: 1px solid var(--ds-border, #2c333a) !important;
        font-size: 13px !important;
        cursor: pointer !important;
        transition: background 0.15s ease !important;
      }
      .bjwt-subtask-item:hover {
        background: var(--ds-surface-hovered, rgba(255, 255, 255, 0.08)) !important;
      }
      .bjwt-subtask-key {
        font-weight: 600 !important;
        color: #579dff !important;
        text-decoration: none !important;
      }
      .bjwt-subtask-summary {
        flex: 1 1 auto !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .bjwt-history-avatar-unassigned {
        width: 24px !important;
        height: 24px !important;
        border-radius: 50% !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: var(--ds-surface-sunken, rgba(255, 255, 255, 0.08)) !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
        border: 1px dashed var(--ds-border, rgba(255, 255, 255, 0.25)) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  BetterJira.RuntimeStyles = {
    ensureRuntimeCriticalStyles
  };
})();
