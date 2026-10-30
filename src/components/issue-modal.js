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
    const { Constants } = BetterJira;
    const { HISTORY_ISSUE_MODAL_ID, MODAL_BACKDROP_ID } = Constants;

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
          ${
            initialTypeIcon
              ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(initialTypeIcon)}" alt="${escapeHtml(initialTypeName)}" title="${escapeHtml(initialTypeName)}" style="width: 16px; height: 16px;" />`
              : ''
          }
          <span class="bjwt-history-modal-key-badge">${escapeHtml(issueKey)}</span>
          <span class="bjwt-history-modal-summary-text" id="bjwt-history-modal-header-summary" title="${escapeHtml(displaySummary)}">${escapeHtml(displaySummary)}</span>
        </div>
        <div class="bjwt-history-issue-modal-actions">
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
          <h1 class="bjwt-detail-summary" id="bjwt-detail-main-title">${escapeHtml(displaySummary)}</h1>

          <div class="bjwt-detail-section">
            <div class="bjwt-detail-section-title">說明</div>
            <div class="bjwt-detail-description-content" id="bjwt-detail-description-body">
              <span class="bjwt-detail-loading-spinner"></span> 正在載入詳細說明...
            </div>
          </div>

          <div class="bjwt-detail-section" id="bjwt-detail-subtasks-container" style="display: none;">
            <div class="bjwt-detail-section-title">子任務 (<span id="bjwt-detail-subtasks-count">0</span>)</div>
            <div class="bjwt-subtask-list" id="bjwt-detail-subtasks-list"></div>
          </div>

          <div class="bjwt-detail-section" id="bjwt-detail-comments-container" style="display: none;">
            <div class="bjwt-detail-section-title">活動與留言 (<span id="bjwt-detail-comments-count">0</span>)</div>
            <div class="bjwt-comment-list" id="bjwt-detail-comments-list"></div>
          </div>
        </div>

        <!-- 右欄 320px：卡片欄位屬性 (狀態、經辦人、報告者、優先順序、Story Points、Epic、到期日、標籤、日期) -->
        <div class="bjwt-detail-side-col">
          <div class="bjwt-detail-section-title">詳細資訊</div>
          <div class="bjwt-detail-field-group">
            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">狀態</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-status">
                <span class="bjwt-history-status-badge ${initialStatusClass}">${escapeHtml(initialStatusName)}</span>
              </div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">經辦人</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-assignee">
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

            <div class="bjwt-detail-field" id="bjwt-detail-row-reporter" style="display: none;">
              <div class="bjwt-detail-field-label">報告者</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-reporter">-</div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">優先順序</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-priority">
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
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-points">
                <span class="bjwt-history-points-badge">${escapeHtml(String(initialPoints))}</span>
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-parent" style="${initialParentText ? '' : 'display: none;'}">
              <div class="bjwt-detail-field-label">上層項目</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-parent">
                ${
                  initialParentText
                    ? `<span class="bjwt-history-parent-badge"><span class="bjwt-parent-dot"></span>${escapeHtml(initialParentText)}</span>`
                    : '-'
                }
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-due" style="${initialDueDate ? '' : 'display: none;'}">
              <div class="bjwt-detail-field-label">到期日</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-due">
                <span class="bjwt-history-duedate-badge">${escapeHtml(initialDueDate)}</span>
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-labels" style="display: none;">
              <div class="bjwt-detail-field-label">標籤</div>
              <div class="bjwt-detail-field-value bjwt-detail-labels-container" id="bjwt-detail-val-labels"></div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-dates" style="display: none;">
              <div class="bjwt-detail-field-label">日期</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-dates" style="font-size: 11px; color: var(--ds-text-subtle, #9fadbc); line-height: 1.5;"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalEl);
    ensureModalBackdrop(modalEl);

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
        }

        // 2. 說明欄位
        const descEl = modalEl.querySelector('#bjwt-detail-description-body');
        if (descEl) {
          descEl.innerHTML = formatDescriptionHtml(fields.description, renderedFields.description);
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

        // 4. 留言清單
        const rawComments =
          (renderedFields.comment && renderedFields.comment.comments) ||
          (fields.comment && fields.comment.comments) ||
          [];
        const commentsContainer = modalEl.querySelector('#bjwt-detail-comments-container');
        const commentsList = modalEl.querySelector('#bjwt-detail-comments-list');
        const commentsCount = modalEl.querySelector('#bjwt-detail-comments-count');
        if (commentsContainer && commentsList && rawComments.length > 0) {
          commentsContainer.style.display = 'block';
          if (commentsCount) commentsCount.textContent = String(rawComments.length);
          commentsList.innerHTML = rawComments
            .map((comm) => {
              const author = comm.author || {};
              const authorName = author.displayName || author.name || '未知使用者';
              const avatar =
                author.avatarUrls && (author.avatarUrls['24x24'] || author.avatarUrls['48x48']);
              const dateStr = formatShortDateTime(comm.created);
              const bodyHtml = formatCommentBody(comm);
              return `
                <div class="bjwt-comment-item">
                  <div class="bjwt-comment-header">
                    <div class="bjwt-user-cell">
                      ${
                        avatar
                          ? `<img src="${escapeHtml(avatar)}" alt="" />`
                          : `<span class="bjwt-user-avatar-placeholder">👤</span>`
                      }
                      <span class="bjwt-comment-author">${escapeHtml(authorName)}</span>
                    </div>
                    <span class="bjwt-comment-date">${escapeHtml(dateStr)}</span>
                  </div>
                  <div class="bjwt-comment-body">${bodyHtml}</div>
                </div>
              `;
            })
            .join('');
        }

        // 5. 報告者
        if (fields.reporter) {
          const rep = fields.reporter;
          const repRow = modalEl.querySelector('#bjwt-detail-row-reporter');
          const repVal = modalEl.querySelector('#bjwt-detail-val-reporter');
          if (repRow && repVal) {
            repRow.style.display = 'flex';
            const repAvatar =
              rep.avatarUrls && (rep.avatarUrls['24x24'] || rep.avatarUrls['48x48']);
            repVal.innerHTML = `
              <div class="bjwt-user-cell">
                ${
                  repAvatar
                    ? `<img src="${escapeHtml(repAvatar)}" alt="" />`
                    : `<span class="bjwt-user-avatar-placeholder">👤</span>`
                }
                <span>${escapeHtml(rep.displayName || rep.name || '未指定')}</span>
              </div>
            `;
          }
        }

        // 6. 標籤
        if (Array.isArray(fields.labels) && fields.labels.length > 0) {
          const labelsRow = modalEl.querySelector('#bjwt-detail-row-labels');
          const labelsVal = modalEl.querySelector('#bjwt-detail-val-labels');
          if (labelsRow && labelsVal) {
            labelsRow.style.display = 'flex';
            labelsVal.innerHTML = fields.labels
              .map((lbl) => `<span class="bjwt-detail-label-tag">${escapeHtml(lbl)}</span>`)
              .join('');
          }
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

        // 8. 重新校準精確狀態與 Story Points (透過 normalizeJiraIssue)
        const normalized = normalizeJiraIssue(issueData);
        if (normalized) {
          const statusVal = modalEl.querySelector('#bjwt-detail-val-status');
          if (statusVal && normalized.statusName) {
            const isNormDone = normalized.statusCategory === 'done';
            const normStatusClass = isNormDone
              ? 'status-done'
              : normalized.statusCategory === 'indeterminate'
              ? 'status-inprogress'
              : '';
            statusVal.innerHTML = `<span class="bjwt-history-status-badge ${normStatusClass}">${escapeHtml(normalized.statusName)}</span>`;
          }
          if (normalized.storyPoints !== null && normalized.storyPoints !== undefined) {
            const pointsVal = modalEl.querySelector('#bjwt-detail-val-points');
            if (pointsVal) {
              pointsVal.innerHTML = `<span class="bjwt-history-points-badge">${normalized.storyPoints}</span>`;
            }
          }
        }
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
