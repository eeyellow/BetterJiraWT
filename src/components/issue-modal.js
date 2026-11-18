/**
 * @fileoverview 卡片詳細內容視窗 (Issue Detail Modal) 元件
 * 負責將原生 Jira 側欄面板轉為佔滿整個版面的 Modal、提供歷史/未結束卡片的豐富資訊彈窗 (支援說明、子任務、留言與屬性)。
 * @module components/issue-modal
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 偵測右側卡片詳細面板 (支援載入骨架階段與完整載入階段)，立即轉為全版面 Modal
   *
   * @param {Element} host - 衝刺清單宿主節點
   * @returns {{modalPane: Element, splitContainer: Element}|null} 找到的面板節點與外層分割容器
   */
  function findIssueModalPane(host) {
    const { Constants } = BetterJira;
    const { SIDEBAR_ID, MODAL_BACKDROP_ID, ISSUE_DETAIL_SELECTORS } = Constants;

    // 方法 1：從 sprintsHost 往上檢查至 <main>，看是否有出現在右側的分割面板兄弟節點 (0ms 骨架階段即可命中)
    const mainBoundary = host.closest('main, [role="main"]') || document.body;
    let curr = host;
    while (curr && curr !== mainBoundary && curr !== document.body) {
      const parent = curr.parentElement;
      if (parent) {
        let sib = curr.nextElementSibling;
        while (sib) {
          if (
            sib.id !== SIDEBAR_ID &&
            sib.id !== MODAL_BACKDROP_ID &&
            !sib.hasAttribute('data-bjwt-sprint-branch') &&
            !sib.hasAttribute('data-bjwt-sprint-header-partner') &&
            !sib.hasAttribute('data-bjwt-non-sprint-child')
          ) {
            const rect = sib.getBoundingClientRect();
            const isResizer =
              sib.getAttribute('role') === 'separator' ||
              (sib.getAttribute('data-testid') || '').includes('resizer') ||
              (rect.width > 0 && rect.width <= 24);

            if (!isResizer && rect.width > 120 && rect.height > 120) {
              return { modalPane: sib, splitContainer: parent };
            }
          }
          sib = sib.nextElementSibling;
        }
      }
      curr = curr.parentElement;
    }

    // 方法 2：透過明確的 ISSUE_DETAIL_SELECTORS 尋找
    for (const sel of ISSUE_DETAIL_SELECTORS) {
      const candidates = Array.from(document.querySelectorAll(sel));
      const found = candidates.find(
        (el) =>
          !host.contains(el) &&
          !el.closest('[role="dialog"]') &&
          el.getBoundingClientRect().width > 50
      );
      if (found) {
        let modalPane = found;
        while (
          modalPane.parentElement &&
          modalPane.parentElement !== document.body &&
          !modalPane.parentElement.contains(host)
        ) {
          modalPane = modalPane.parentElement;
        }
        const splitContainer = modalPane.parentElement;
        if (splitContainer && splitContainer.contains(host)) {
          return { modalPane, splitContainer };
        }
      }
    }

    return null;
  }

  /**
   * 清除頁面上所有與卡片 Modal 相關的屬性與背景遮罩
   */
  function cleanupIssueModalAttributes() {
    const { Constants } = BetterJira;
    const { HISTORY_ISSUE_MODAL_ID, MODAL_BACKDROP_ID } = Constants;

    if (document.getElementById(HISTORY_ISSUE_MODAL_ID)) {
      return;
    }
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (backdrop) {
      backdrop.remove();
    }
    document.querySelectorAll('[data-bjwt-issue-modal]').forEach((el) => {
      el.removeAttribute('data-bjwt-issue-modal');
    });
    document.querySelectorAll('[data-bjwt-split-container]').forEach((el) => {
      el.removeAttribute('data-bjwt-split-container');
    });
    document.querySelectorAll('[data-bjwt-resizer-hide]').forEach((el) => {
      el.removeAttribute('data-bjwt-resizer-hide');
    });
  }

  /**
   * 確保 Modal 背景遮罩 (Backdrop) 存在並綁定點擊關閉事件
   *
   * @param {Element} modalPane - 當前開啟的 Modal 節點
   */
  function ensureModalBackdrop(modalPane) {
    const { Constants } = BetterJira;
    const { MODAL_BACKDROP_ID } = Constants;

    let backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = MODAL_BACKDROP_ID;
      backdrop.setAttribute('title', '點擊背景關閉卡片視窗');
      document.body.appendChild(backdrop);
    }
    backdrop.onclick = () => {
      closeIssueDetailModal(modalPane);
    };
  }

  /**
   * 關閉當前開啟的卡片詳細 Modal
   *
   * @param {Element|null} [modalPane=null] - 欲關閉的 Modal 節點
   */
  function closeIssueDetailModal(modalPane) {
    const { Constants, QuickEditPopoverComponent } = BetterJira;
    const { HISTORY_ISSUE_MODAL_ID, MODAL_BACKDROP_ID } = Constants;

    if (QuickEditPopoverComponent && typeof QuickEditPopoverComponent.close === 'function') {
      QuickEditPopoverComponent.close();
    }

    const historyModal = document.getElementById(HISTORY_ISSUE_MODAL_ID);
    if (historyModal && (!modalPane || modalPane === historyModal)) {
      historyModal.remove();
      const backdrop = document.getElementById(MODAL_BACKDROP_ID);
      if (backdrop) backdrop.remove();
      return;
    }

    const pane = modalPane || document.querySelector('[data-bjwt-issue-modal="true"]');
    if (pane) {
      const closeSelectors = [
        '[data-testid*="close-button"] button',
        '[data-testid*="close-button"]',
        '[data-testid*="dismiss"]',
        'button[aria-label*="關閉"]',
        'button[aria-label*="Close"]',
        'button[aria-label*="close"]',
        '.js-detail-close',
        '.ghx-Controls button'
      ];
      for (const sel of closeSelectors) {
        const closeBtn = pane.querySelector(sel);
        if (closeBtn && typeof closeBtn.click === 'function') {
          closeBtn.click();
          return;
        }
      }
    }

    // 若找不到關閉按鈕，嘗試移除網址中的 selectedIssue 參數並觸發返回
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('selectedIssue')) {
        url.searchParams.delete('selectedIssue');
        window.history.pushState({}, '', url.toString());
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    } catch {
      // ignore
    }
  }

  /**
   * 將 Jira 點擊卡片後右側的詳細面板，立即轉換為佔滿全版面的 Modal 視窗
   *
   * @param {Element|null} [sprintsHost=null] - 衝刺宿主節點
   */
  function applyIssueDetailModalTransform(sprintsHost) {
    const { Constants, RuntimeStyles } = BetterJira;
    const { HISTORY_ISSUE_MODAL_ID, MODAL_BACKDROP_ID } = Constants;

    if (RuntimeStyles && typeof RuntimeStyles.ensureRuntimeCriticalStyles === 'function') {
      RuntimeStyles.ensureRuntimeCriticalStyles();
    }

    if (document.getElementById(HISTORY_ISSUE_MODAL_ID)) {
      return;
    }

    const host = sprintsHost || document.querySelector('[data-bjwt-layout-host="true"]');
    if (!host) {
      cleanupIssueModalAttributes();
      return;
    }

    const detected = findIssueModalPane(host);
    if (!detected) {
      cleanupIssueModalAttributes();
      return;
    }

    const { modalPane, splitContainer } = detected;

    document.querySelectorAll('[data-bjwt-issue-modal]').forEach((el) => {
      if (el !== modalPane && el.id !== HISTORY_ISSUE_MODAL_ID) {
        el.removeAttribute('data-bjwt-issue-modal');
      }
    });

    splitContainer.setAttribute('data-bjwt-split-container', 'true');
    modalPane.setAttribute('data-bjwt-issue-modal', 'true');

    // 隱藏分割線 (resizer / separator)
    Array.from(splitContainer.children).forEach((child) => {
      if (
        child !== modalPane &&
        !child.contains(host) &&
        child.id !== MODAL_BACKDROP_ID
      ) {
        child.setAttribute('data-bjwt-resizer-hide', 'true');
      }
    });

    ensureModalBackdrop(modalPane);
  }

  /**
   * 點擊卡片時，以佔滿全版面的豐富 Modal 彈窗預覽完整卡片詳情
   * 先即時呈現 fallback 既有欄位 (0ms)，隨後透過 Jira REST API 非同步載入詳細說明、留言、子任務
   *
   * @param {string} issueKey - 卡片編號 (例如 "WMC-1234")
   * @param {Object|null} [fallbackIssue=null] - 本地既有卡片資料供 0ms 即時渲染
   */
  function openHistoricalIssueDetailModal(issueKey, fallbackIssue = null) {
    const { Constants, TextUtils, AdfParser, JiraApiService, IssueStore, RuntimeStyles } = BetterJira;
    const { HISTORY_ISSUE_MODAL_ID } = Constants;
    const { escapeHtml, cleanSummaryText, formatShortDateTime } = TextUtils;
    const { formatDescriptionHtml, formatCommentBody } = AdfParser;
    const { fetchIssueDetails } = JiraApiService;
    const { normalizeJiraIssue } = IssueStore;

    RuntimeStyles.ensureRuntimeCriticalStyles();

    const existingModal = document.getElementById(HISTORY_ISSUE_MODAL_ID);
    if (existingModal) {
      existingModal.remove();
    }

    const modalEl = document.createElement('div');
    modalEl.id = HISTORY_ISSUE_MODAL_ID;
    modalEl.setAttribute('data-bjwt-issue-modal', 'true');
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');

    const browseUrl = `${window.location.origin}/browse/${encodeURIComponent(issueKey)}`;
    const displaySummary = fallbackIssue ? fallbackIssue.summary : issueKey;

    const isDone = fallbackIssue && fallbackIssue.statusCategory === 'done';
    const initialStatusClass = isDone
      ? 'status-done'
      : fallbackIssue && fallbackIssue.statusCategory === 'indeterminate'
      ? 'status-inprogress'
      : '';
    const initialStatusName = (fallbackIssue && fallbackIssue.statusName) || '載入中...';
    const initialAssigneeName = (fallbackIssue && fallbackIssue.assigneeName) || '未指派';
    const initialAssigneeAvatar = (fallbackIssue && fallbackIssue.assigneeAvatar) || '';
    const initialPriorityName = (fallbackIssue && fallbackIssue.priorityName) || '';
    const initialPriorityIcon = (fallbackIssue && fallbackIssue.priorityIcon) || '';
    const initialPrioritySvg = (fallbackIssue && fallbackIssue.prioritySvg) || '';
    const initialPoints =
      fallbackIssue && fallbackIssue.storyPoints !== null && fallbackIssue.storyPoints !== undefined
        ? fallbackIssue.storyPoints
        : '-';
    const initialDueDate = (fallbackIssue && fallbackIssue.dueDate) || '';
    const initialParentText =
      fallbackIssue && (fallbackIssue.parentSummary || fallbackIssue.parentKey)
        ? fallbackIssue.parentSummary || fallbackIssue.parentKey
        : '';
    const initialTypeIcon = (fallbackIssue && fallbackIssue.issueTypeIcon) || '';
    const initialTypeName = (fallbackIssue && fallbackIssue.issueTypeName) || '工作項目';

    modalEl.innerHTML = `
      <div class="bjwt-history-issue-modal-header">
        <div class="bjwt-history-issue-modal-title">
          <span class="bjwt-detail-type-trigger" id="bjwt-detail-type-trigger" data-bjwt-detail-edit="type" title="${escapeHtml(initialTypeName)}">
            ${
              initialTypeIcon
                ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(initialTypeIcon)}" alt="${escapeHtml(initialTypeName)}" title="${escapeHtml(initialTypeName)}" style="width: 16px; height: 16px;" />`
                : `<span class="bjwt-detail-type-fallback" title="${escapeHtml(initialTypeName)}">📌</span>`
            }
          </span>
          <span class="bjwt-history-modal-key-badge">${escapeHtml(issueKey)}</span>
          <span class="bjwt-history-modal-summary-text" id="bjwt-history-modal-header-summary" title="${escapeHtml(displaySummary)}">${escapeHtml(displaySummary)}</span>
        </div>
        <div class="bjwt-history-issue-modal-actions">
          <div class="bjwt-view-actions bjwt-view-only">
            <button
              type="button"
              class="bjwt-history-modal-edit-btn"
              title="切換為編輯模式"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
              編輯
            </button>
          </div>
          <div class="bjwt-edit-actions bjwt-edit-only">
            <button
              type="button"
              class="bjwt-history-modal-save-btn"
              title="儲存變更至 Jira"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
              </svg>
              儲存
            </button>
            <button
              type="button"
              class="bjwt-history-modal-cancel-btn"
              title="取消編輯"
            >
              取消
            </button>
          </div>
          <a
            href="${escapeHtml(browseUrl)}"
            target="_blank"
            rel="noopener noreferrer"
            class="bjwt-history-modal-open-tab"
            title="在新分頁開啟完整 Jira 卡片頁面"
          >
            在新分頁開啟 ↗
          </a>
          <button
            type="button"
            class="bjwt-history-modal-close-btn"
            aria-label="關閉卡片視窗"
            title="關閉 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>
      <div class="bjwt-rich-detail-body">
        <!-- 左欄 68%：主要內容 (標題、詳細說明、子任務、活動留言) -->
        <div class="bjwt-detail-main-col">
          <!-- 錯誤/成功訊息提示框 -->
          <div id="bjwt-modal-msg-banner" style="display: none;"></div>

          <!-- 標題區域：檢視 vs 編輯 -->
          <div class="bjwt-view-only">
            <h1 class="bjwt-detail-summary" id="bjwt-detail-main-title">${escapeHtml(displaySummary)}</h1>
          </div>
          <div class="bjwt-edit-only bjwt-edit-field-group">
            <label class="bjwt-edit-label">摘要 / 標題 (Summary)</label>
            <input
              type="text"
              class="bjwt-edit-summary-input"
              id="bjwt-edit-summary-field"
              value="${escapeHtml(displaySummary)}"
              placeholder="請輸入卡片摘要..."
            />
          </div>

          <!-- 說明區域：檢視 vs 編輯 -->
          <div class="bjwt-detail-section">
            <div class="bjwt-detail-section-title">
              說明
              <span class="bjwt-edit-only bjwt-edit-tip">(所見即所得編輯，支援圖片與富文字排版)</span>
            </div>
            <div class="bjwt-view-only">
              <div class="bjwt-detail-description-content" id="bjwt-detail-description-body">
                <span class="bjwt-detail-loading-spinner"></span> 正在載入詳細說明...
              </div>
            </div>
            <div class="bjwt-edit-only">
              <div class="bjwt-md-toolbar" id="bjwt-desc-md-toolbar">
                <button type="button" class="bjwt-md-tool-btn" data-md-action="bold" title="粗體"><strong>B</strong></button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="italic" title="斜體"><em>I</em></button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="underline" title="底線"><u>U</u></button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="code" title="行內程式碼">&lt;/&gt;</button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="list" title="項目清單">• 清單</button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="link" title="超連結">🔗 連結</button>
                <button type="button" class="bjwt-md-source-toggle" data-md-action="source" title="切換原始碼 / 所見即所得">{ } 原始碼</button>
                <button type="button" class="bjwt-md-preview-toggle" data-md-action="preview" title="切換預覽">👁 預覽</button>
              </div>
              <div
                class="bjwt-edit-desc-rich bjwt-detail-description-content"
                id="bjwt-edit-desc-rich"
                contenteditable="true"
                data-placeholder="請輸入工作項目詳細說明..."
              ></div>
              <textarea
                class="bjwt-edit-desc-textarea"
                id="bjwt-edit-desc-field"
                rows="12"
                style="display: none;"
                placeholder="請輸入工作項目詳細說明 (支援 Markdown / Jira Wiki 語法)..."
              ></textarea>
              <div class="bjwt-md-preview-box bjwt-detail-description-content" id="bjwt-edit-desc-preview" style="display: none;"></div>
            </div>
          </div>

          <div class="bjwt-detail-section" id="bjwt-detail-subtasks-container" style="display: none;">
            <div class="bjwt-detail-section-title">子任務 (<span id="bjwt-detail-subtasks-count">0</span>)</div>
            <div class="bjwt-subtask-list" id="bjwt-detail-subtasks-list"></div>
          </div>

          <div class="bjwt-detail-section" id="bjwt-detail-attachments-container" style="display: none;">
            <div class="bjwt-detail-section-title">
              附件 (<span id="bjwt-detail-attachments-count">0</span>)
              <label class="bjwt-attachment-upload-btn bjwt-edit-only" for="bjwt-attachment-file-input" title="上傳新附件至此卡片">
                + 上傳附件
                <input type="file" id="bjwt-attachment-file-input" multiple style="display: none;" />
              </label>
            </div>
            <div class="bjwt-attachment-list" id="bjwt-detail-attachments-list"></div>
          </div>

          <div class="bjwt-detail-section" id="bjwt-detail-comments-container" style="display: none;">
            <div class="bjwt-detail-section-title">
              活動與留言 (<span id="bjwt-detail-comments-count">0</span>)
              <span class="bjwt-edit-only bjwt-edit-tip">(編輯模式下支援 Markdown 新增、編輯與刪除留言)</span>
            </div>
            <div class="bjwt-comment-list" id="bjwt-detail-comments-list"></div>
            <div class="bjwt-comment-add-box bjwt-edit-only" id="bjwt-comment-add-box">
              <div class="bjwt-md-toolbar" id="bjwt-comment-md-toolbar">
                <button type="button" class="bjwt-md-tool-btn" data-md-action="bold" title="粗體 (**文字**)"><strong>B</strong></button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="italic" title="斜體 (*文字*)"><em>I</em></button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="code" title="行內程式碼 (&#96;code&#96;)">&lt;/&gt;</button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="list" title="項目清單 (- 項目)">• 清單</button>
                <button type="button" class="bjwt-md-tool-btn" data-md-action="link" title="超連結 ([標題](網址))">🔗 連結</button>
                <button type="button" class="bjwt-md-preview-toggle" data-md-action="preview" title="切換 Markdown 預覽">👁 預覽</button>
              </div>
              <textarea
                class="bjwt-comment-textarea"
                id="bjwt-add-comment-field"
                rows="3"
                placeholder="輸入新留言 (支援 Markdown 語法)..."
              ></textarea>
              <div class="bjwt-md-preview-box bjwt-comment-body" id="bjwt-add-comment-preview" style="display: none;"></div>
              <div class="bjwt-comment-actions">
                <button type="button" class="bjwt-comment-submit-btn" id="bjwt-add-comment-btn">新增留言</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 右欄 320px：卡片欄位屬性 (狀態、經辦人、報告者、優先順序、Story Points、Epic、到期日、標籤、日期) -->
        <div class="bjwt-detail-side-col">
          <div class="bjwt-detail-section-title">
            詳細資訊
            <span class="bjwt-edit-only bjwt-edit-tip" style="margin-left: 6px;">(點擊欄位即可修改)</span>
          </div>
          <div class="bjwt-detail-field-group">
            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">狀態</div>
              <div class="bjwt-detail-field-value bjwt-detail-editable-trigger" id="bjwt-detail-val-status" data-bjwt-detail-edit="status" title="狀態">
                <span class="bjwt-history-status-badge ${initialStatusClass}" id="bjwt-status-badge-val">${escapeHtml(initialStatusName)}</span>
              </div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">經辦人</div>
              <div class="bjwt-detail-field-value bjwt-detail-editable-trigger" id="bjwt-detail-val-assignee" data-bjwt-detail-edit="assignee" title="經辦人">
                <div class="bjwt-user-cell">
                  ${
                    initialAssigneeAvatar
                      ? `<img src="${escapeHtml(initialAssigneeAvatar)}" alt="" />`
                      : `<span class="bjwt-user-avatar-placeholder">👤</span>`
                  }
                  <span>${escapeHtml(initialAssigneeName)}</span>
                </div>
              </div>
            </div>

            <div class="bjwt-detail-field bjwt-detail-field--editable" id="bjwt-detail-row-reporter" style="display: none;">
              <div class="bjwt-detail-field-label">報告者</div>
              <div class="bjwt-detail-field-value bjwt-detail-editable-trigger" id="bjwt-detail-val-reporter" data-bjwt-detail-edit="reporter" title="報告者">
                <span class="bjwt-detail-placeholder-text">未指定</span>
              </div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">優先順序</div>
              <div class="bjwt-detail-field-value bjwt-detail-editable-trigger" id="bjwt-detail-val-priority" data-bjwt-detail-edit="priority" title="優先順序">
                ${
                  initialPriorityIcon
                    ? `<img src="${escapeHtml(initialPriorityIcon)}" width="16" height="16" alt="" />`
                    : initialPrioritySvg || ''
                }
                <span>${escapeHtml(initialPriorityName || '未指定')}</span>
              </div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">Story Points</div>
              <div class="bjwt-detail-field-value bjwt-detail-editable-trigger" id="bjwt-detail-val-points" data-bjwt-detail-edit="points" title="Story Points">
                <span class="bjwt-history-points-badge" id="bjwt-points-badge-val">${escapeHtml(String(initialPoints))}</span>
              </div>
            </div>

            <div class="bjwt-detail-field bjwt-detail-field--editable" id="bjwt-detail-row-parent" style="${initialParentText ? '' : 'display: none;'}">
              <div class="bjwt-detail-field-label">上層項目</div>
              <div class="bjwt-detail-field-value bjwt-detail-editable-trigger" id="bjwt-detail-val-parent" data-bjwt-detail-edit="parent" title="上層項目">
                ${
                  initialParentText
                    ? `<span class="bjwt-history-parent-badge"><span class="bjwt-parent-dot"></span>${escapeHtml(initialParentText)}</span>`
                    : '<span class="bjwt-detail-placeholder-text">無上層項目</span>'
                }
              </div>
            </div>

            <div class="bjwt-detail-field bjwt-detail-field--editable" id="bjwt-detail-row-due" style="${initialDueDate ? '' : 'display: none;'}">
              <div class="bjwt-detail-field-label">到期日</div>
              <div class="bjwt-detail-field-value bjwt-detail-editable-trigger" id="bjwt-detail-val-due" data-bjwt-detail-edit="duedate" title="到期日">
                ${
                  initialDueDate
                    ? `<span class="bjwt-history-duedate-badge">${escapeHtml(initialDueDate)}</span>`
                    : '<span class="bjwt-detail-placeholder-text">未設定</span>'
                }
              </div>
            </div>

            <div class="bjwt-detail-field bjwt-detail-field--editable" id="bjwt-detail-row-labels" style="display: none;">
              <div class="bjwt-detail-field-label">標籤</div>
              <div class="bjwt-detail-field-value bjwt-detail-labels-container bjwt-detail-editable-trigger" id="bjwt-detail-val-labels" data-bjwt-detail-edit="labels" title="標籤">
                <span class="bjwt-detail-placeholder-text">無標籤</span>
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-dates" style="display: none;">
              <div class="bjwt-detail-field-label">日期</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-dates" style="font-size: 11px; color: var(--ds-text-subtle, #9fadbc); line-height: 1.5;"></div>
            </div>
          </div>

          <div class="bjwt-edit-only bjwt-edit-native-box">
            <div class="bjwt-edit-native-tip">需要調整更多自訂欄位？</div>
            <a href="${escapeHtml(browseUrl)}" target="_blank" rel="noopener noreferrer" class="bjwt-edit-native-link">開啟 Jira 原生卡片頁面 ↗</a>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalEl);
    ensureModalBackdrop(modalEl);

    let currentRawSummary = displaySummary;
    let currentRawDesc = '';
    let currentRenderedDescHtml = '';
    let richDescDirty = false;
    let isDescSourceMode = false;
    let currentIssueTypeName = initialTypeName;
    let currentIssueTypeIcon = initialTypeIcon;
    let currentRawPoints = initialPoints !== '-' ? initialPoints : '';
    let currentStatusName = initialStatusName;
    let currentStatusCategory = (fallbackIssue && fallbackIssue.statusCategory) || 'new';
    let currentIsUnassigned = (fallbackIssue && fallbackIssue.isUnassigned) !== undefined ? Boolean(fallbackIssue.isUnassigned) : initialAssigneeName === '未指派';
    let currentAssigneeName = initialAssigneeName;
    let currentAssigneeAvatar = initialAssigneeAvatar;
    let currentAssigneeAccountId = (fallbackIssue && fallbackIssue.assigneeAccountId) || '';
    let currentAssigneeEmail = (fallbackIssue && fallbackIssue.assigneeEmail) || '';
    let currentAssigneeUsername = (fallbackIssue && fallbackIssue.assigneeUsername) || '';
    let currentAssigneeInitials = (fallbackIssue && fallbackIssue.assigneeInitials) || '';
    let currentReporterName = '';
    let currentReporterAvatar = '';
    let currentReporterAccountId = '';
    let currentReporterEmail = '';
    let currentReporterUsername = '';
    let currentPriorityName = initialPriorityName;
    let currentPriorityIcon = initialPriorityIcon;
    let currentPrioritySvg = initialPrioritySvg;
    let currentParentKey = (fallbackIssue && fallbackIssue.parentKey) || '';
    let currentParentSummary = (fallbackIssue && fallbackIssue.parentSummary) || '';
    let currentDueDate = initialDueDate;
    let currentLabels = Array.isArray(fallbackIssue && fallbackIssue.labels) ? [...fallbackIssue.labels] : [];
    let currentComments = [];
    let currentAttachments = [];
    const renderedCommentsMap = new Map();

    const editBtn = modalEl.querySelector('.bjwt-history-modal-edit-btn');
    const saveBtn = modalEl.querySelector('.bjwt-history-modal-save-btn');
    const cancelBtn = modalEl.querySelector('.bjwt-history-modal-cancel-btn');
    const msgBanner = modalEl.querySelector('#bjwt-modal-msg-banner');
    const addCommentField = modalEl.querySelector('#bjwt-add-comment-field');
    const addCommentBtn = modalEl.querySelector('#bjwt-add-comment-btn');
    const attachmentInput = modalEl.querySelector('#bjwt-attachment-file-input');

    function showModalBanner(type, text, autoHideMs = 0) {
      if (!msgBanner) return;
      msgBanner.className =
        type === 'error'
          ? 'bjwt-edit-error-banner'
          : type === 'warning'
            ? 'bjwt-edit-warning-banner'
            : 'bjwt-edit-success-banner';
      msgBanner.textContent = text;
      msgBanner.style.display = 'block';
      if (autoHideMs > 0) {
        setTimeout(() => {
          if (msgBanner && modalEl.isConnected) {
            msgBanner.style.display = 'none';
          }
        }, autoHideMs);
      }
    }

    function formatFileSize(bytes) {
      const size = Number(bytes);
      if (!size || isNaN(size) || size < 0) return '';
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    }

    function getAttachmentTypeBadge(att) {
      const mime = String((att && att.mimeType) || '').toLowerCase();
      const name = String((att && att.filename) || '').toLowerCase();
      if (mime.includes('pdf') || name.endsWith('.pdf')) return 'PDF';
      if (mime.includes('zip') || mime.includes('compressed') || /\.(zip|rar|7z|tar|gz)$/.test(name)) return 'ZIP';
      if (mime.includes('sheet') || mime.includes('excel') || /\.(xlsx?|csv)$/.test(name)) return 'XLS';
      if (mime.includes('word') || /\.(docx?|rtf)$/.test(name)) return 'DOC';
      if (mime.includes('text') || /\.(txt|md|log|json|xml)$/.test(name)) return 'TXT';
      return 'FILE';
    }

    function renderAttachmentsList() {
      const attContainer = modalEl.querySelector('#bjwt-detail-attachments-container');
      const attList = modalEl.querySelector('#bjwt-detail-attachments-list');
      const attCount = modalEl.querySelector('#bjwt-detail-attachments-count');
      const isEditMode = modalEl.hasAttribute('data-bjwt-edit-mode');

      if (attCount) attCount.textContent = String(currentAttachments.length);
      if (attContainer) {
        attContainer.style.display = currentAttachments.length > 0 || isEditMode ? 'block' : 'none';
      }
      if (!attList) return;

      if (currentAttachments.length === 0) {
        attList.innerHTML = isEditMode
          ? '<div class="bjwt-comment-empty">目前尚無附件，可點擊上方「+ 上傳附件」新增。</div>'
          : '';
        return;
      }

      attList.innerHTML = currentAttachments
        .map((att) => {
          const filename = att.filename || '未命名附件';
          const downloadUrl = att.content || '#';
          const thumbUrl = att.thumbnail || '';
          const mime = String(att.mimeType || '').toLowerCase();
          const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filename);
          const sizeStr = formatFileSize(att.size);
          const dateStr = att.created ? formatShortDateTime(att.created) : '';
          const metaText = [sizeStr, dateStr].filter(Boolean).join(' · ');
          const badgeLabel = getAttachmentTypeBadge(att);

          const previewHtml =
            thumbUrl || (isImage && downloadUrl !== '#')
              ? `<img class="bjwt-attachment-thumb" src="${escapeHtml(thumbUrl || downloadUrl)}" alt="${escapeHtml(filename)}" />`
              : `<span class="bjwt-attachment-badge">${escapeHtml(badgeLabel)}</span>`;

          return `
            <a
              class="bjwt-attachment-item"
              href="${escapeHtml(downloadUrl)}"
              download="${escapeHtml(filename)}"
              target="_blank"
              rel="noopener noreferrer"
              data-bjwt-attachment-id="${escapeHtml(String(att.id || ''))}"
              title="點擊下載 ${escapeHtml(filename)}"
            >
              <div class="bjwt-attachment-preview">${previewHtml}</div>
              <div class="bjwt-attachment-info">
                <div class="bjwt-attachment-name">${escapeHtml(filename)}</div>
                ${metaText ? `<div class="bjwt-attachment-meta">${escapeHtml(metaText)}</div>` : ''}
              </div>
              <span class="bjwt-attachment-download-label">⬇ 下載</span>
            </a>
          `;
        })
        .join('');
    }

    if (attachmentInput) {
      attachmentInput.addEventListener('change', async () => {
        const files = attachmentInput.files ? Array.from(attachmentInput.files) : [];
        if (files.length === 0) return;
        for (const file of files) {
          try {
            const res = await JiraApiService.addIssueAttachment(issueKey, file);
            if (!res || !res.success) {
              throw new Error((res && res.error) || '附件上傳失敗');
            }
            if (Array.isArray(res.attachments) && res.attachments.length > 0) {
              currentAttachments.push(...res.attachments);
            }
            renderAttachmentsList();
            showModalBanner('success', `✓ 附件「${file.name}」上傳成功！`, 3000);
          } catch (err) {
            showModalBanner('error', `附件「${file.name}」上傳失敗：${err && err.message ? err.message : '未知錯誤'}`);
          }
        }
        attachmentInput.value = '';
      });
    }

    function bindMarkdownEditorToolbar(toolbarEl, textareaEl, previewEl) {
      if (!toolbarEl || !textareaEl) return;
      const previewBtn = toolbarEl.querySelector('[data-md-action="preview"]');

      const applySnippet = (action) => {
        const val = textareaEl.value || '';
        const start = typeof textareaEl.selectionStart === 'number' ? textareaEl.selectionStart : val.length;
        const end = typeof textareaEl.selectionEnd === 'number' ? textareaEl.selectionEnd : val.length;
        const selected = val.slice(start, end);
        let replacement = '';

        if (action === 'bold') replacement = `**${selected || '粗體文字'}**`;
        else if (action === 'italic') replacement = `*${selected || '斜體文字'}*`;
        else if (action === 'code') replacement = `\`${selected || '程式碼'}\``;
        else if (action === 'list') replacement = `${start > 0 && val[start - 1] !== '\n' ? '\n' : ''}- ${selected || '清單項目'}`;
        else if (action === 'link') replacement = `[${selected || '連結文字'}](https://)`;

        textareaEl.value = val.slice(0, start) + replacement + val.slice(end);
        textareaEl.focus();
      };

      toolbarEl.querySelectorAll('.bjwt-md-tool-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const action = btn.getAttribute('data-md-action');
          if (previewEl && previewEl.style.display === 'block') {
            previewEl.style.display = 'none';
            textareaEl.style.display = 'block';
            if (previewBtn) previewBtn.textContent = '👁 預覽';
          }
          applySnippet(action);
        });
      });

      if (previewBtn && previewEl) {
        previewBtn.addEventListener('click', () => {
          const showingPreview = previewEl.style.display === 'block';
          if (showingPreview) {
            previewEl.style.display = 'none';
            textareaEl.style.display = 'block';
            previewBtn.textContent = '👁 預覽';
            previewBtn.classList.remove('is-active');
          } else {
            const mdText = textareaEl.value || '';
            previewEl.innerHTML = mdText.trim()
              ? AdfParser.markdownToHtml(mdText)
              : '<div class="bjwt-detail-empty-desc">尚無內容可預覽</div>';
            textareaEl.style.display = 'none';
            previewEl.style.display = 'block';
            previewBtn.textContent = '✎ 繼續編輯';
            previewBtn.classList.add('is-active');
          }
        });
      }
    }

    function bindDescriptionRichEditor(toolbarEl, richEl, textareaEl, previewEl) {
      if (!toolbarEl || !richEl || !textareaEl) return;
      const previewBtn = toolbarEl.querySelector('[data-md-action="preview"]');
      const sourceBtn = toolbarEl.querySelector('[data-md-action="source"]');

      richEl.addEventListener('input', () => {
        richDescDirty = true;
      });
      textareaEl.addEventListener('input', () => {
        richDescDirty = true;
      });

      const applySourceSnippet = (action) => {
        const val = textareaEl.value || '';
        const start = typeof textareaEl.selectionStart === 'number' ? textareaEl.selectionStart : val.length;
        const end = typeof textareaEl.selectionEnd === 'number' ? textareaEl.selectionEnd : val.length;
        const selected = val.slice(start, end);
        let replacement = '';

        if (action === 'bold') replacement = `*${selected || '粗體文字'}*`;
        else if (action === 'italic') replacement = `_${selected || '斜體文字'}_`;
        else if (action === 'underline') replacement = `+${selected || '底線文字'}+`;
        else if (action === 'code') replacement = `{{${selected || '程式碼'}}}`;
        else if (action === 'list') replacement = `${start > 0 && val[start - 1] !== '\n' ? '\n' : ''}* ${selected || '清單項目'}`;
        else if (action === 'link') replacement = `[${selected || '連結文字'}|https://]`;

        textareaEl.value = val.slice(0, start) + replacement + val.slice(end);
        textareaEl.focus();
        richDescDirty = true;
      };

      const applyRichCommand = (action) => {
        richEl.focus();
        if (typeof document.execCommand === 'function') {
          if (action === 'bold') document.execCommand('bold', false, null);
          else if (action === 'italic') document.execCommand('italic', false, null);
          else if (action === 'underline') document.execCommand('underline', false, null);
          else if (action === 'list') document.execCommand('insertUnorderedList', false, null);
          else if (action === 'code') {
            const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
            const selectedText = sel ? sel.toString() : '';
            document.execCommand('insertHTML', false, `<code>${escapeHtml(selectedText || '程式碼')}</code>`);
          } else if (action === 'link') {
            const url = typeof window.prompt === 'function' ? window.prompt('請輸入連結網址:', 'https://') : '';
            if (url && /^https?:\/\//i.test(url.trim())) {
              const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
              const selectedText = sel && sel.toString() ? sel.toString() : url.trim();
              document.execCommand(
                'insertHTML',
                false,
                `<a href="${escapeHtml(url.trim())}" target="_blank" rel="noopener noreferrer">${escapeHtml(selectedText)}</a>`
              );
            }
          }
        }
        richDescDirty = true;
      };

      toolbarEl.querySelectorAll('.bjwt-md-tool-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const action = btn.getAttribute('data-md-action');
          if (previewEl && previewEl.style.display === 'block') {
            previewEl.style.display = 'none';
            if (isDescSourceMode) textareaEl.style.display = 'block';
            else richEl.style.display = 'block';
            if (previewBtn) {
              previewBtn.textContent = '👁 預覽';
              previewBtn.classList.remove('is-active');
            }
          }
          if (isDescSourceMode) {
            applySourceSnippet(action);
          } else {
            applyRichCommand(action);
          }
        });
      });

      if (sourceBtn) {
        sourceBtn.addEventListener('click', () => {
          if (previewEl && previewEl.style.display === 'block') {
            previewEl.style.display = 'none';
            if (previewBtn) {
              previewBtn.textContent = '👁 預覽';
              previewBtn.classList.remove('is-active');
            }
          }
          if (!isDescSourceMode) {
            if (richDescDirty && typeof AdfParser.htmlToJiraWiki === 'function') {
              textareaEl.value = AdfParser.htmlToJiraWiki(richEl, currentAttachments);
            }
            isDescSourceMode = true;
            richEl.style.display = 'none';
            textareaEl.style.display = 'block';
            sourceBtn.classList.add('is-active');
            sourceBtn.textContent = '✎ 所見即所得';
          } else {
            const srcText = textareaEl.value || '';
            richEl.innerHTML = srcText.trim()
              ? formatDescriptionHtml(srcText, null, currentAttachments)
              : '';
            isDescSourceMode = false;
            textareaEl.style.display = 'none';
            richEl.style.display = 'block';
            sourceBtn.classList.remove('is-active');
            sourceBtn.textContent = '{ } 原始碼';
          }
        });
      }

      if (previewBtn && previewEl) {
        previewBtn.addEventListener('click', () => {
          const showingPreview = previewEl.style.display === 'block';
          if (showingPreview) {
            previewEl.style.display = 'none';
            if (isDescSourceMode) textareaEl.style.display = 'block';
            else richEl.style.display = 'block';
            previewBtn.textContent = '👁 預覽';
            previewBtn.classList.remove('is-active');
          } else {
            if (isDescSourceMode || (!richDescDirty && (textareaEl.value || '').trim())) {
              const mdText = textareaEl.value || '';
              previewEl.innerHTML = mdText.trim()
                ? AdfParser.markdownToHtml(mdText, currentAttachments)
                : '<div class="bjwt-detail-empty-desc">尚無內容可預覽</div>';
            } else {
              const richHtml = (richEl.innerHTML || '').trim();
              previewEl.innerHTML = richHtml || '<div class="bjwt-detail-empty-desc">尚無內容可預覽</div>';
            }
            richEl.style.display = 'none';
            textareaEl.style.display = 'none';
            previewEl.style.display = 'block';
            previewBtn.textContent = '✎ 繼續編輯';
            previewBtn.classList.add('is-active');
          }
        });
      }
    }

    bindDescriptionRichEditor(
      modalEl.querySelector('#bjwt-desc-md-toolbar'),
      modalEl.querySelector('#bjwt-edit-desc-rich'),
      modalEl.querySelector('#bjwt-edit-desc-field'),
      modalEl.querySelector('#bjwt-edit-desc-preview')
    );
    bindMarkdownEditorToolbar(
      modalEl.querySelector('#bjwt-comment-md-toolbar'),
      addCommentField,
      modalEl.querySelector('#bjwt-add-comment-preview')
    );

    function getCommentPlainText(comm) {
      if (!comm) return '';
      if (typeof comm.body === 'object' && comm.body !== null) {
        return AdfParser.adfToPlainText(comm.body);
      }
      return String(comm.body || '');
    }

    function renderCommentsList() {
      const commentsContainer = modalEl.querySelector('#bjwt-detail-comments-container');
      const commentsList = modalEl.querySelector('#bjwt-detail-comments-list');
      const commentsCount = modalEl.querySelector('#bjwt-detail-comments-count');
      const isEditMode = modalEl.hasAttribute('data-bjwt-edit-mode');

      if (commentsCount) commentsCount.textContent = String(currentComments.length);
      if (commentsContainer) {
        commentsContainer.style.display = currentComments.length > 0 || isEditMode ? 'block' : 'none';
      }
      if (!commentsList) return;

      if (currentComments.length === 0) {
        commentsList.innerHTML = isEditMode
          ? '<div class="bjwt-comment-empty">目前尚無留言，可於下方輸入框新增。</div>'
          : '';
        return;
      }

      commentsList.innerHTML = currentComments
        .map((comm) => {
          const commId = comm.id ? String(comm.id) : '';
          const author = comm.author || {};
          const authorName = author.displayName || author.name || '未知使用者';
          const avatar =
            author.avatarUrls && (author.avatarUrls['24x24'] || author.avatarUrls['48x48']);
          const dateStr = formatShortDateTime(comm.created);
          const isEdited = comm.updated && comm.created && comm.updated !== comm.created;
          const renderedHtml =
            (commId && renderedCommentsMap.get(commId)) ||
            comm.renderedBody ||
            (comm.isRendered ? comm.body : null);
          const bodyHtml = formatCommentBody(comm, renderedHtml);
          const rawText = getCommentPlainText(comm);

          return `
            <div class="bjwt-comment-item" data-bjwt-comment-id="${escapeHtml(commId)}">
              <div class="bjwt-comment-header">
                <div class="bjwt-user-cell">
                  ${
                    avatar
                      ? `<img src="${escapeHtml(avatar)}" alt="" />`
                      : `<span class="bjwt-user-avatar-placeholder">👤</span>`
                  }
                  <span class="bjwt-comment-author">${escapeHtml(authorName)}</span>
                </div>
                <span class="bjwt-comment-date">${escapeHtml(dateStr)}${isEdited ? ' (已編輯)' : ''}</span>
                ${
                  commId
                    ? `<div class="bjwt-comment-header-actions bjwt-edit-only">
                        <button type="button" class="bjwt-comment-edit-btn" data-bjwt-comment-edit-id="${escapeHtml(commId)}">編輯</button>
                        <button type="button" class="bjwt-comment-delete-btn" data-bjwt-comment-delete-id="${escapeHtml(commId)}">刪除</button>
                      </div>`
                    : ''
                }
              </div>
              <div class="bjwt-comment-body">${bodyHtml}</div>
              <div class="bjwt-comment-edit-box" style="display: none;">
                <textarea class="bjwt-comment-textarea bjwt-comment-edit-textarea" rows="3" placeholder="支援 Markdown 語法...">${escapeHtml(rawText)}</textarea>
                <div class="bjwt-comment-actions">
                  <button type="button" class="bjwt-comment-submit-btn bjwt-comment-edit-save-btn">儲存留言</button>
                  <button type="button" class="bjwt-comment-cancel-btn bjwt-comment-edit-cancel-btn">取消</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');

      commentsList.querySelectorAll('.bjwt-comment-item').forEach((itemEl) => {
        const commId = itemEl.getAttribute('data-bjwt-comment-id');
        const editCommBtn = itemEl.querySelector('.bjwt-comment-edit-btn');
        const deleteCommBtn = itemEl.querySelector('.bjwt-comment-delete-btn');
        const bodyEl = itemEl.querySelector('.bjwt-comment-body');
        const editBoxEl = itemEl.querySelector('.bjwt-comment-edit-box');
        const editTextarea = itemEl.querySelector('.bjwt-comment-edit-textarea');
        const editSaveBtn = itemEl.querySelector('.bjwt-comment-edit-save-btn');
        const editCancelBtn = itemEl.querySelector('.bjwt-comment-edit-cancel-btn');

        if (editCommBtn && bodyEl && editBoxEl) {
          editCommBtn.addEventListener('click', () => {
            const matched = currentComments.find((c) => String(c.id || '') === commId);
            if (editTextarea && matched) {
              editTextarea.value = getCommentPlainText(matched);
            }
            itemEl.setAttribute('data-bjwt-comment-editing', 'true');
            bodyEl.style.display = 'none';
            editBoxEl.style.display = 'block';
            if (editTextarea) editTextarea.focus();
          });
        }

        if (deleteCommBtn) {
          deleteCommBtn.addEventListener('click', async () => {
            const confirmed =
              typeof window !== 'undefined' && typeof window.confirm === 'function'
                ? window.confirm('確定要刪除此則留言嗎？')
                : true;
            if (!confirmed) return;

            deleteCommBtn.disabled = true;
            deleteCommBtn.textContent = '刪除中...';
            try {
              const delRes = await JiraApiService.deleteIssueComment(issueKey, commId);
              if (!delRes || !delRes.success) {
                throw new Error((delRes && delRes.error) || '刪除留言失敗');
              }
              currentComments = currentComments.filter((c) => String(c.id || '') !== commId);
              renderedCommentsMap.delete(String(commId));
              renderCommentsList();
              showModalBanner('success', '✓ 留言已成功刪除！', 3000);
            } catch (err) {
              showModalBanner('error', `刪除留言失敗：${err && err.message ? err.message : '未知錯誤'}`);
              deleteCommBtn.disabled = false;
              deleteCommBtn.textContent = '刪除';
            }
          });
        }

        if (editCancelBtn && bodyEl && editBoxEl) {
          editCancelBtn.addEventListener('click', () => {
            itemEl.removeAttribute('data-bjwt-comment-editing');
            editBoxEl.style.display = 'none';
            bodyEl.style.display = 'block';
          });
        }

        if (editSaveBtn && editTextarea) {
          editSaveBtn.addEventListener('click', async () => {
            const newText = editTextarea.value.trim();
            if (!newText) {
              showModalBanner('error', '留言內容不能為空。');
              return;
            }
            editSaveBtn.disabled = true;
            editSaveBtn.textContent = '儲存中...';
            try {
              await saveEditedComment(commId, newText);
              showModalBanner('success', '✓ 留言已成功更新！', 3000);
            } catch (err) {
              showModalBanner('error', `留言更新失敗：${err && err.message ? err.message : '未知錯誤'}`);
              editSaveBtn.disabled = false;
              editSaveBtn.textContent = '儲存留言';
            }
          });
        }
      });
    }

    async function submitNewComment(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return null;
      const res = await JiraApiService.addIssueComment(issueKey, trimmed);
      if (!res || !res.success) {
        throw new Error((res && res.error) || '新增留言失敗');
      }
      const created = res.comment || {
        id: String(Date.now()),
        body: trimmed,
        created: new Date().toISOString(),
        author: { displayName: '目前使用者' }
      };
      if (created.id && created.renderedBody) {
        renderedCommentsMap.set(String(created.id), created.renderedBody);
      }
      currentComments.push(created);
      if (addCommentField) addCommentField.value = '';
      renderCommentsList();
      return created;
    }

    async function saveEditedComment(commentId, newText) {
      const trimmed = String(newText || '').trim();
      if (!trimmed) throw new Error('留言內容不能為空');
      const res = await JiraApiService.updateIssueComment(issueKey, commentId, trimmed);
      if (!res || !res.success) {
        throw new Error((res && res.error) || '更新留言失敗');
      }
      const idx = currentComments.findIndex((c) => String(c.id || '') === String(commentId));
      if (idx !== -1) {
        const updatedObj = res.comment || {};
        currentComments[idx] = {
          ...currentComments[idx],
          ...updatedObj,
          body: updatedObj.body !== undefined ? updatedObj.body : trimmed,
          renderedBody: updatedObj.renderedBody || null,
          isRendered: false,
          updated: updatedObj.updated || new Date().toISOString()
        };
        if (updatedObj.renderedBody) {
          renderedCommentsMap.set(String(commentId), updatedObj.renderedBody);
        } else {
          renderedCommentsMap.delete(String(commentId));
        }
      }
      renderCommentsList();
    }

    if (addCommentBtn && addCommentField) {
      addCommentBtn.addEventListener('click', async () => {
        const text = addCommentField.value.trim();
        if (!text) {
          showModalBanner('error', '請先輸入留言內容。');
          addCommentField.focus();
          return;
        }
        addCommentBtn.disabled = true;
        addCommentBtn.textContent = '送出中...';
        if (msgBanner) msgBanner.style.display = 'none';
        try {
          await submitNewComment(text);
          showModalBanner('success', '✓ 留言已成功新增！', 3000);
        } catch (err) {
          showModalBanner('error', `新增留言失敗：${err && err.message ? err.message : '未知錯誤'}`);
        } finally {
          addCommentBtn.disabled = false;
          addCommentBtn.textContent = '新增留言';
        }
      });
    }

    function getCurrentIssueSnapshot() {
      return {
        key: issueKey,
        summary: currentRawSummary,
        issueTypeName: currentIssueTypeName,
        issueTypeIcon: currentIssueTypeIcon,
        statusName: currentStatusName,
        statusCategory: currentStatusCategory,
        isUnassigned: currentIsUnassigned,
        assigneeName: currentAssigneeName,
        assigneeAvatar: currentAssigneeAvatar,
        assigneeAccountId: currentAssigneeAccountId,
        assigneeEmail: currentAssigneeEmail,
        assigneeUsername: currentAssigneeUsername,
        assigneeInitials: currentAssigneeInitials,
        reporterName: currentReporterName,
        reporterAvatar: currentReporterAvatar,
        reporterAccountId: currentReporterAccountId,
        reporterEmail: currentReporterEmail,
        reporterUsername: currentReporterUsername,
        priorityName: currentPriorityName,
        priorityIcon: currentPriorityIcon,
        prioritySvg: currentPrioritySvg,
        storyPoints: currentRawPoints !== '' && currentRawPoints !== '-' ? currentRawPoints : null,
        parentKey: currentParentKey,
        parentSummary: currentParentSummary,
        dueDate: currentDueDate,
        labels: [...currentLabels]
      };
    }

    function renderDetailSideFields() {
      const typeTrigger = modalEl.querySelector('#bjwt-detail-type-trigger');
      if (typeTrigger) {
        typeTrigger.title = currentIssueTypeName || '問題類型';
        typeTrigger.innerHTML = currentIssueTypeIcon
          ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(currentIssueTypeIcon)}" alt="${escapeHtml(currentIssueTypeName)}" title="${escapeHtml(currentIssueTypeName)}" style="width: 16px; height: 16px;" />`
          : `<span class="bjwt-detail-type-fallback" title="${escapeHtml(currentIssueTypeName)}">📌</span>`;
      }

      const statusVal = modalEl.querySelector('#bjwt-status-badge-val');
      if (statusVal) {
        const isNormDone = currentStatusCategory === 'done';
        const normStatusClass = isNormDone
          ? 'status-done'
          : currentStatusCategory === 'indeterminate'
          ? 'status-inprogress'
          : '';
        statusVal.className = `bjwt-history-status-badge ${normStatusClass}`;
        statusVal.textContent = currentStatusName || '未指定';
      }

      const assigneeVal = modalEl.querySelector('#bjwt-detail-val-assignee');
      if (assigneeVal) {
        const displayAss = currentIsUnassigned ? '未指派' : currentAssigneeName || '未指派';
        assigneeVal.innerHTML = `
          <div class="bjwt-user-cell">
            ${
              !currentIsUnassigned && currentAssigneeAvatar
                ? `<img src="${escapeHtml(currentAssigneeAvatar)}" alt="" />`
                : `<span class="bjwt-user-avatar-placeholder">👤</span>`
            }
            <span>${escapeHtml(displayAss)}</span>
          </div>
        `;
      }

      const repRow = modalEl.querySelector('#bjwt-detail-row-reporter');
      const repVal = modalEl.querySelector('#bjwt-detail-val-reporter');
      if (repRow && repVal) {
        if (currentReporterName) {
          repRow.style.display = 'flex';
          repVal.innerHTML = `
            <div class="bjwt-user-cell">
              ${
                currentReporterAvatar
                  ? `<img src="${escapeHtml(currentReporterAvatar)}" alt="" />`
                  : `<span class="bjwt-user-avatar-placeholder">👤</span>`
              }
              <span>${escapeHtml(currentReporterName)}</span>
            </div>
          `;
        } else {
          repRow.style.display = 'none';
          repVal.innerHTML = '<span class="bjwt-detail-placeholder-text">未指定</span>';
        }
      }

      const priVal = modalEl.querySelector('#bjwt-detail-val-priority');
      if (priVal) {
        priVal.innerHTML = `
          ${
            currentPriorityIcon
              ? `<img src="${escapeHtml(currentPriorityIcon)}" width="16" height="16" alt="" />`
              : currentPrioritySvg || ''
          }
          <span>${escapeHtml(currentPriorityName || '未指定')}</span>
        `;
      }

      const pointsBadge = modalEl.querySelector('#bjwt-points-badge-val');
      if (pointsBadge) {
        const ptsText =
          currentRawPoints !== null && currentRawPoints !== undefined && currentRawPoints !== ''
            ? String(currentRawPoints)
            : '-';
        pointsBadge.textContent = ptsText;
      }

      const parentRow = modalEl.querySelector('#bjwt-detail-row-parent');
      const parentVal = modalEl.querySelector('#bjwt-detail-val-parent');
      if (parentRow && parentVal) {
        const parentDisplay = currentParentSummary || currentParentKey;
        if (parentDisplay) {
          parentRow.style.display = 'flex';
          parentVal.innerHTML = `<span class="bjwt-history-parent-badge"><span class="bjwt-parent-dot"></span>${escapeHtml(parentDisplay)}</span>`;
        } else {
          parentRow.style.display = 'none';
          parentVal.innerHTML = '<span class="bjwt-detail-placeholder-text">無上層項目</span>';
        }
      }

      const dueRow = modalEl.querySelector('#bjwt-detail-row-due');
      const dueVal = modalEl.querySelector('#bjwt-detail-val-due');
      if (dueRow && dueVal) {
        if (currentDueDate) {
          dueRow.style.display = 'flex';
          dueVal.innerHTML = `<span class="bjwt-history-duedate-badge">${escapeHtml(currentDueDate)}</span>`;
        } else {
          dueRow.style.display = 'none';
          dueVal.innerHTML = '<span class="bjwt-detail-placeholder-text">未設定</span>';
        }
      }

      const labelsRow = modalEl.querySelector('#bjwt-detail-row-labels');
      const labelsVal = modalEl.querySelector('#bjwt-detail-val-labels');
      if (labelsRow && labelsVal) {
        if (Array.isArray(currentLabels) && currentLabels.length > 0) {
          labelsRow.style.display = 'flex';
          labelsVal.innerHTML = currentLabels
            .map((lbl) => `<span class="bjwt-detail-label-tag">${escapeHtml(lbl)}</span>`)
            .join('');
        } else {
          labelsRow.style.display = 'none';
          labelsVal.innerHTML = '<span class="bjwt-detail-placeholder-text">無標籤</span>';
        }
      }
    }

    modalEl.querySelectorAll('[data-bjwt-detail-edit]').forEach((triggerEl) => {
      triggerEl.addEventListener('click', (e) => {
        if (!modalEl.hasAttribute('data-bjwt-edit-mode')) return;
        e.preventDefault();
        e.stopPropagation();
        const editType = triggerEl.getAttribute('data-bjwt-detail-edit');
        const { QuickEditPopoverComponent } = BetterJira;
        if (!editType || !QuickEditPopoverComponent || typeof QuickEditPopoverComponent.open !== 'function') return;

        QuickEditPopoverComponent.open(triggerEl, issueKey, editType, getCurrentIssueSnapshot(), {
          onSuccess: (updated) => {
            if (!updated || !modalEl.isConnected) return;
            if ('issueTypeName' in updated) currentIssueTypeName = updated.issueTypeName || '';
            if ('issueTypeIcon' in updated) currentIssueTypeIcon = updated.issueTypeIcon || '';
            if ('statusName' in updated) currentStatusName = updated.statusName || '';
            if ('statusCategory' in updated) currentStatusCategory = updated.statusCategory || 'new';
            if ('isUnassigned' in updated) currentIsUnassigned = Boolean(updated.isUnassigned);
            if ('assigneeName' in updated) currentAssigneeName = updated.assigneeName || '未指派';
            if ('assigneeAvatar' in updated) currentAssigneeAvatar = updated.assigneeAvatar || '';
            if ('assigneeAccountId' in updated) currentAssigneeAccountId = updated.assigneeAccountId || '';
            if ('assigneeEmail' in updated) currentAssigneeEmail = updated.assigneeEmail || '';
            if ('assigneeUsername' in updated) currentAssigneeUsername = updated.assigneeUsername || '';
            if ('assigneeInitials' in updated) currentAssigneeInitials = updated.assigneeInitials || '';
            if ('reporterName' in updated) currentReporterName = updated.reporterName || '';
            if ('reporterAvatar' in updated) currentReporterAvatar = updated.reporterAvatar || '';
            if ('reporterAccountId' in updated) currentReporterAccountId = updated.reporterAccountId || '';
            if ('reporterEmail' in updated) currentReporterEmail = updated.reporterEmail || '';
            if ('reporterUsername' in updated) currentReporterUsername = updated.reporterUsername || '';
            if ('priorityName' in updated) currentPriorityName = updated.priorityName || '';
            if ('priorityIcon' in updated) currentPriorityIcon = updated.priorityIcon || '';
            if ('prioritySvg' in updated) currentPrioritySvg = updated.prioritySvg || '';
            if ('storyPoints' in updated) {
              currentRawPoints = updated.storyPoints !== null && updated.storyPoints !== undefined ? updated.storyPoints : '';
            }
            if ('parentKey' in updated) currentParentKey = updated.parentKey || '';
            if ('parentSummary' in updated) currentParentSummary = updated.parentSummary || '';
            if ('dueDate' in updated) currentDueDate = updated.dueDate || '';
            if ('labels' in updated && Array.isArray(updated.labels)) currentLabels = [...updated.labels];
            renderDetailSideFields();
          }
        });
      });
    });

    function setEditMode(active) {
      const descPreview = modalEl.querySelector('#bjwt-edit-desc-preview');
      const descRich = modalEl.querySelector('#bjwt-edit-desc-rich');
      const descTextarea = modalEl.querySelector('#bjwt-edit-desc-field');
      const descSourceBtn = modalEl.querySelector('#bjwt-desc-md-toolbar [data-md-action="source"]');
      const commentPreview = modalEl.querySelector('#bjwt-add-comment-preview');
      isDescSourceMode = false;
      if (descSourceBtn) {
        descSourceBtn.classList.remove('is-active');
        descSourceBtn.textContent = '{ } 原始碼';
      }
      if (descPreview && descRich && descTextarea) {
        descPreview.style.display = 'none';
        descTextarea.style.display = 'none';
        descRich.style.display = 'block';
      }
      if (commentPreview && addCommentField) {
        commentPreview.style.display = 'none';
        addCommentField.style.display = 'block';
      }
      modalEl.querySelectorAll('.bjwt-md-preview-toggle').forEach((btn) => {
        btn.textContent = '👁 預覽';
        btn.classList.remove('is-active');
      });

      if (active) {
        modalEl.setAttribute('data-bjwt-edit-mode', 'true');
        const summaryInput = modalEl.querySelector('#bjwt-edit-summary-field');
        if (summaryInput) summaryInput.value = currentRawSummary;
        if (descTextarea) descTextarea.value = currentRawDesc;
        if (descRich) descRich.innerHTML = currentRawDesc ? currentRenderedDescHtml : '';
        richDescDirty = false;
        renderAttachmentsList();
        renderCommentsList();
        if (summaryInput) summaryInput.focus();
      } else {
        modalEl.removeAttribute('data-bjwt-edit-mode');
        const { QuickEditPopoverComponent } = BetterJira;
        if (QuickEditPopoverComponent && typeof QuickEditPopoverComponent.close === 'function') {
          QuickEditPopoverComponent.close();
        }
        richDescDirty = false;
        if (addCommentField) addCommentField.value = '';
        if (msgBanner) msgBanner.style.display = 'none';
        renderAttachmentsList();
        renderCommentsList();
      }
    }

    if (editBtn) {
      editBtn.addEventListener('click', () => setEditMode(true));
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => setEditMode(false));
    }
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const summaryInput = modalEl.querySelector('#bjwt-edit-summary-field');
        const descTextarea = modalEl.querySelector('#bjwt-edit-desc-field');

        const newSummary = summaryInput ? summaryInput.value.trim() : currentRawSummary;
        if (!newSummary) {
          showModalBanner('error', '卡片標題 (Summary) 不能為空。');
          return;
        }

        const descRich = modalEl.querySelector('#bjwt-edit-desc-rich');
        let newDesc = currentRawDesc;
        if (isDescSourceMode) {
          newDesc = descTextarea ? descTextarea.value : currentRawDesc;
        } else if (richDescDirty && descRich && typeof AdfParser.htmlToJiraWiki === 'function') {
          newDesc = AdfParser.htmlToJiraWiki(descRich, currentAttachments);
        }
        const pendingNewComment = addCommentField ? addCommentField.value.trim() : '';
        const editingCommentItems = Array.from(
          modalEl.querySelectorAll('.bjwt-comment-item[data-bjwt-comment-editing="true"]')
        );

        // 檢查是否有實質修改 (Dirty Check)
        const summaryChanged = newSummary !== currentRawSummary;
        const descChanged = newDesc !== currentRawDesc;
        const commentsChanged = Boolean(pendingNewComment) || editingCommentItems.length > 0;

        if (!summaryChanged && !descChanged && !commentsChanged) {
          setEditMode(false);
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '儲存中...';
        if (msgBanner) msgBanner.style.display = 'none';

        try {
          const updates = {};
          if (summaryChanged) updates.summary = newSummary;
          if (descChanged) updates.description = newDesc;

          let updateRes = { success: true };
          if (Object.keys(updates).length > 0) {
            updateRes = await JiraApiService.updateIssue(issueKey, updates);
            if (!updateRes.success) {
              throw new Error(updateRes.error || '儲存失敗');
            }
          }

          for (const itemEl of editingCommentItems) {
            const commId = itemEl.getAttribute('data-bjwt-comment-id');
            const editTextarea = itemEl.querySelector('.bjwt-comment-edit-textarea');
            const editedText = editTextarea ? editTextarea.value.trim() : '';
            if (commId && editedText) {
              await saveEditedComment(commId, editedText);
            }
          }

          if (pendingNewComment) {
            await submitNewComment(pendingNewComment);
          }

          currentRawSummary = newSummary;
          currentRawDesc = newDesc;

          const headerSummary = modalEl.querySelector('#bjwt-history-modal-header-summary');
          if (headerSummary) {
            headerSummary.textContent = newSummary;
            headerSummary.title = newSummary;
          }
          const mainTitle = modalEl.querySelector('#bjwt-detail-main-title');
          if (mainTitle) mainTitle.textContent = newSummary;

          const descBody = modalEl.querySelector('#bjwt-detail-description-body');
          if (descBody && descChanged) {
            if (!isDescSourceMode && descRich && (descRich.innerHTML || '').trim()) {
              currentRenderedDescHtml = descRich.innerHTML;
            } else {
              currentRenderedDescHtml = formatDescriptionHtml(newDesc, null, currentAttachments);
            }
            descBody.innerHTML = currentRenderedDescHtml;
          }

          const cacheUpdate = {
            key: issueKey,
            summary: newSummary,
            isUserEdit: true
          };
          IssueStore.mergeAndCacheIssue(cacheUpdate);

          const { LayoutManager, QuickEditPopoverComponent } = BetterJira;
          if (QuickEditPopoverComponent && typeof QuickEditPopoverComponent.triggerImmediateUiRefresh === 'function') {
            QuickEditPopoverComponent.triggerImmediateUiRefresh();
          } else if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
            LayoutManager.scheduleLayoutRefresh();
          }

          setEditMode(false);

          if (msgBanner) {
            if (updateRes.warning) {
              msgBanner.className = 'bjwt-edit-warning-banner';
              msgBanner.textContent = `✓ 儲存完成：${updateRes.warning}`;
              msgBanner.style.display = 'block';
            } else {
              msgBanner.className = 'bjwt-edit-success-banner';
              msgBanner.textContent = '✓ 卡片已成功儲存！';
              msgBanner.style.display = 'block';
            }
            setTimeout(() => {
              if (msgBanner && modalEl.isConnected) {
                msgBanner.style.display = 'none';
              }
            }, 3500);
          }
        } catch (err) {
          if (msgBanner) {
            msgBanner.className = 'bjwt-edit-error-banner';
            msgBanner.textContent = `儲存失敗：${err && err.message ? err.message : '未知錯誤'}。您可以點擊「在新分頁開啟 ↗」直接在 Jira 原生介面編輯。`;
            msgBanner.style.display = 'block';
          }
        } finally {
          saveBtn.disabled = false;
          saveBtn.innerHTML = `
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
              <polyline points="17 21 17 13 7 13 7 21"></polyline>
              <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
            儲存
          `;
        }
      });
    }

    const closeBtn = modalEl.querySelector('.bjwt-history-modal-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        closeIssueDetailModal(modalEl);
      });
    }

    // 非同步從 Jira API 取得完整卡片資訊並平滑補齊內容
    (async () => {
      try {
        const issueData = await fetchIssueDetails(issueKey);
        if (!modalEl.isConnected) return; // 使用者已關閉 Modal

        if (!issueData || !issueData.fields) {
          const descEl = modalEl.querySelector('#bjwt-detail-description-body');
          if (descEl) {
            descEl.innerHTML = '<div class="bjwt-detail-empty-desc">無法從 Jira API 取得卡片完整說明。您可以點擊右上角「在新分頁開啟 ↗」直接檢視。</div>';
          }
          return;
        }

        const fields = issueData.fields;
        const renderedFields = issueData.renderedFields || {};

        // 1. 更新標題
        if (fields.summary) {
          const cleanSummary = cleanSummaryText(fields.summary.trim());
          const headerSummary = modalEl.querySelector('#bjwt-history-modal-header-summary');
          if (headerSummary) {
            headerSummary.textContent = cleanSummary;
            headerSummary.title = cleanSummary;
          }
          const mainTitle = modalEl.querySelector('#bjwt-detail-main-title');
          if (mainTitle) mainTitle.textContent = cleanSummary;
          currentRawSummary = cleanSummary;
          const summaryInput = modalEl.querySelector('#bjwt-edit-summary-field');
          if (summaryInput && !modalEl.hasAttribute('data-bjwt-edit-mode')) {
            summaryInput.value = cleanSummary;
          }
        }

        // 2. 附件與說明欄位 (先讀取附件清單，以便無 renderedFields 時可解析 Jira Wiki 圖片)
        currentAttachments = Array.isArray(fields.attachment) ? [...fields.attachment] : [];
        if (fields.description) {
          currentRawDesc =
            typeof fields.description === 'object'
              ? AdfParser.adfToPlainText(fields.description)
              : String(fields.description);
        } else {
          currentRawDesc = '';
        }
        currentRenderedDescHtml = formatDescriptionHtml(fields.description, renderedFields.description, currentAttachments);
        const descTextarea = modalEl.querySelector('#bjwt-edit-desc-field');
        const descRich = modalEl.querySelector('#bjwt-edit-desc-rich');
        if (!modalEl.hasAttribute('data-bjwt-edit-mode')) {
          if (descTextarea) descTextarea.value = currentRawDesc;
          if (descRich) descRich.innerHTML = currentRawDesc ? currentRenderedDescHtml : '';
          richDescDirty = false;
        }
        const descEl = modalEl.querySelector('#bjwt-detail-description-body');
        if (descEl) {
          descEl.innerHTML = currentRenderedDescHtml;
        }

        // 3. 子任務清單
        const subtasks = Array.isArray(fields.subtasks) ? fields.subtasks : [];
        const subtasksContainer = modalEl.querySelector('#bjwt-detail-subtasks-container');
        const subtasksList = modalEl.querySelector('#bjwt-detail-subtasks-list');
        const subtasksCount = modalEl.querySelector('#bjwt-detail-subtasks-count');
        if (subtasksContainer && subtasksList && subtasks.length > 0) {
          subtasksContainer.style.display = 'block';
          if (subtasksCount) subtasksCount.textContent = String(subtasks.length);
          subtasksList.innerHTML = subtasks
            .map((sub) => {
              const subFields = sub.fields || {};
              const subStatus = subFields.status || {};
              const subType = subFields.issuetype || {};
              const isSubDone = subStatus.statusCategory && subStatus.statusCategory.key === 'done';
              const subStatusClass = isSubDone
                ? 'status-done'
                : subStatus.statusCategory && subStatus.statusCategory.key === 'indeterminate'
                ? 'status-inprogress'
                : '';
              return `
                <div class="bjwt-subtask-item" data-bjwt-subtask-key="${escapeHtml(sub.key)}">
                  ${
                    subType.iconUrl
                      ? `<img src="${escapeHtml(subType.iconUrl)}" alt="" width="14" height="14" />`
                      : ''
                  }
                  <a href="${escapeHtml(`${window.location.origin}/browse/${sub.key}`)}" class="bjwt-subtask-key">${escapeHtml(sub.key)}</a>
                  <span class="bjwt-subtask-summary" title="${escapeHtml(subFields.summary || '')}">${escapeHtml(subFields.summary || '')}</span>
                  <span class="bjwt-history-status-badge ${subStatusClass}">${escapeHtml(subStatus.name || '')}</span>
                </div>
              `;
            })
            .join('');

          subtasksList.querySelectorAll('.bjwt-subtask-item').forEach((itemEl) => {
            const subKey = itemEl.getAttribute('data-bjwt-subtask-key');
            const subRaw = subtasks.find((s) => s.key === subKey);
            if (subKey && subRaw) {
              itemEl.addEventListener('click', (e) => {
                e.preventDefault();
                openHistoricalIssueDetailModal(subKey, normalizeJiraIssue(subRaw));
              });
            }
          });
        }

        // 3.5 渲染附件清單 (檢視與編輯模式皆顯示並提供點擊下載)
        renderAttachmentsList();

        // 4. 留言清單 (使用 renderedCommentsMap 避免雙重 escapeHtml 造成顯示 HTML 原始碼)
        renderedCommentsMap.clear();
        if (renderedFields.comment && Array.isArray(renderedFields.comment.comments)) {
          renderedFields.comment.comments.forEach((rc) => {
            if (rc && rc.id) {
              renderedCommentsMap.set(String(rc.id), rc.body || rc.renderedBody || '');
            }
          });
        }

        const rawComments =
          (fields.comment && fields.comment.comments) ||
          (renderedFields.comment && renderedFields.comment.comments) ||
          [];
        currentComments = Array.isArray(rawComments) ? [...rawComments] : [];
        renderCommentsList();

        // 5. 報告者
        if (fields.reporter) {
          const rep = fields.reporter;
          currentReporterName = rep.displayName || rep.name || '';
          currentReporterAvatar =
            (rep.avatarUrls && (rep.avatarUrls['24x24'] || rep.avatarUrls['48x48'])) || '';
          currentReporterAccountId = rep.accountId || '';
          currentReporterEmail = rep.emailAddress || '';
          currentReporterUsername = rep.name || rep.key || '';
        }

        // 6. 標籤
        if (Array.isArray(fields.labels)) {
          currentLabels = [...fields.labels];
        }

        // 7. 建立與更新日期
        if (fields.created || fields.updated) {
          const datesRow = modalEl.querySelector('#bjwt-detail-row-dates');
          const datesVal = modalEl.querySelector('#bjwt-detail-val-dates');
          if (datesRow && datesVal) {
            datesRow.style.display = 'flex';
            const createdStr = formatShortDateTime(fields.created);
            const updatedStr = formatShortDateTime(fields.updated);
            datesVal.innerHTML = `
              ${createdStr ? `<div>建立：${escapeHtml(createdStr)}</div>` : ''}
              ${updatedStr ? `<div>更新：${escapeHtml(updatedStr)}</div>` : ''}
            `;
          }
        }

        // 8. 重新校準精確狀態、經辦人、優先順序、Story Points、上層項目、到期日 (透過 normalizeJiraIssue)
        const normalized = normalizeJiraIssue(issueData);
        if (normalized) {
          if (normalized.issueTypeName) currentIssueTypeName = normalized.issueTypeName;
          if (normalized.issueTypeIcon) currentIssueTypeIcon = normalized.issueTypeIcon;
          if (normalized.statusName) currentStatusName = normalized.statusName;
          if (normalized.statusCategory) currentStatusCategory = normalized.statusCategory;
          currentIsUnassigned = Boolean(normalized.isUnassigned);
          currentAssigneeName = normalized.assigneeName || '未指派';
          currentAssigneeAvatar = normalized.assigneeAvatar || '';
          currentAssigneeAccountId = normalized.assigneeAccountId || '';
          currentAssigneeEmail = normalized.assigneeEmail || '';
          currentAssigneeUsername = normalized.assigneeUsername || '';
          currentAssigneeInitials = normalized.assigneeInitials || '';
          if (normalized.priorityName) currentPriorityName = normalized.priorityName;
          if (normalized.priorityIcon) currentPriorityIcon = normalized.priorityIcon;
          if (normalized.prioritySvg) currentPrioritySvg = normalized.prioritySvg;
          if (normalized.storyPoints !== null && normalized.storyPoints !== undefined) {
            currentRawPoints = normalized.storyPoints;
          }
          if (normalized.parentKey !== undefined) currentParentKey = normalized.parentKey || '';
          if (normalized.parentSummary !== undefined) currentParentSummary = normalized.parentSummary || '';
          if (normalized.dueDate !== undefined) currentDueDate = normalized.dueDate || '';
        }
        renderDetailSideFields();
      } catch {
        if (!modalEl.isConnected) return;
        const descEl = modalEl.querySelector('#bjwt-detail-description-body');
        if (descEl) {
          descEl.innerHTML = '<div class="bjwt-detail-empty-desc">無法從 Jira API 取得卡片完整說明。您可以點擊右上角「在新分頁開啟 ↗」直接檢視。</div>';
        }
      }
    })();
  }

  BetterJira.IssueModalComponent = {
    findIssueModalPane,
    applyIssueDetailModalTransform,
    ensureModalBackdrop,
    closeIssueDetailModal,
    cleanupIssueModalAttributes,
    openHistoricalIssueDetailModal
  };
})();
