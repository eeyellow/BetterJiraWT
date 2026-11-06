/**
 * @fileoverview 加大高度之雙列卡片 (Two-row Issue Card) 渲染元件
 * 負責生成 Jira 工作項目卡片的 HTML 結構，第一列呈現圖示、編號與標題，第二列整齊對齊各項屬性徽章。
 * @module components/issue-card
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 當 Jira API 未回傳優先度圖示 URL 時，依據優先度名稱產生對應的標準彩色 SVG 圖示
   *
   * @param {string} priorityName - 優先度名稱 (如 Highest, High, Medium, Low, Lowest)
   * @returns {string} SVG HTML 字串或空字串
   */
  function getDefaultPrioritySvg(priorityName) {
    if (!priorityName || typeof priorityName !== 'string') return '';
    const p = priorityName.trim().toLowerCase();
    if (p.includes('highest') || p.includes('最高') || p === 'p0' || p === 'p1') {
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="${priorityName}"><path d="M3.5 9.5L8 5L12.5 9.5" stroke="#FF5630" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 13L8 8.5L12.5 13" stroke="#FF5630" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (p.includes('high') || p.includes('高')) {
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="${priorityName}"><path d="M3.5 10.5L8 6L12.5 10.5" stroke="#FF5630" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (p.includes('medium') || p.includes('中') || p.includes('normal')) {
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="${priorityName}"><path d="M3 6H13" stroke="#FFAB00" stroke-width="2" stroke-linecap="round"/><path d="M3 10H13" stroke="#FFAB00" stroke-width="2" stroke-linecap="round"/></svg>`;
    }
    if (p.includes('lowest') || p.includes('最低')) {
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="${priorityName}"><path d="M3.5 6.5L8 11L12.5 6.5" stroke="#0065FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.5 3L8 7.5L12.5 3" stroke="#0065FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (p.includes('low') || p.includes('低')) {
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="${priorityName}"><path d="M3.5 5.5L8 10L12.5 5.5" stroke="#0065FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    return '';
  }

  /**
   * 產出加大高度的雙列卡片 HTML
   * 第一列：只放卡片類型Icon，卡片編號，卡片標題 (佔滿整列寬度)
   * 第二列：放其他的欄位 (靠右一欄一欄整齊對齊)
   *
   * @param {Object} iss - 正規化後的卡片資料物件
   * @returns {string} 雙列卡片 HTML 字串
   */
  function renderIssueCardHtml(iss) {
    const { TextUtils, AssigneeUtils } = BetterJira;
    const {
      cleanSummaryText,
      isTruncatedDuplicateOf,
      cleanStatusText,
      cleanDueDateText,
      escapeHtml
    } = TextUtils;
    const { getDisplayInitialsForIssue, isUnassignedText } = AssigneeUtils;

    const rawKey = String(iss.key || '').trim();
    const keyMatch = rawKey.match(/([A-Z][A-Z0-9_]*-\d+)/i);
    const cleanKey = keyMatch ? keyMatch[1].toUpperCase() : rawKey;

    let cleanSummary = cleanSummaryText(iss.summary || '');
    if (cleanKey && rawKey.length > cleanKey.length) {
      const escapedK = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const keyRemainder = cleanSummaryText(
        rawKey.replace(new RegExp(`^${escapedK}\\s*[-:]?\\s*`, 'i'), '').trim()
      );
      if (
        keyRemainder &&
        (!cleanSummary || isTruncatedDuplicateOf(cleanSummary, keyRemainder))
      ) {
        cleanSummary = keyRemainder;
      }
    }
    if (cleanKey && cleanSummary) {
      const escapedK = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleanSummary = cleanSummaryText(
        cleanSummary.replace(new RegExp(`^${escapedK}\\s*[-:]?\\s*`, 'i'), '').trim()
      );
    }

    const isDone = iss.statusCategory === 'done';
    const statusClass = isDone
      ? 'status-done'
      : iss.statusCategory === 'indeterminate'
      ? 'status-inprogress'
      : 'status-todo';
    const isUnassigned = Boolean(iss.isUnassigned) || isUnassignedText(iss.assigneeName);
    const displayAssigneeName = isUnassigned ? '未指派' : iss.assigneeName || '未指派';
    const initials = getDisplayInitialsForIssue(iss);
    const hasValidAvatarImg =
      !isUnassigned &&
      Boolean(iss.assigneeAvatar) &&
      !/issuetype|avatar\/type|universal_avatar\/view\/type\/issuetype/i.test(iss.assigneeAvatar);
    const fallbackBgStyle =
      iss.assigneeBgColor && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/i.test(iss.assigneeBgColor)
        ? ` style="background: ${escapeHtml(iss.assigneeBgColor)} !important;"`
        : '';

    const parentLabel = iss.parentSummary || iss.parentKey || '';
    const cleanStatusName = cleanStatusText(iss.statusName) || '未知狀態';
    const cleanDueDate = cleanDueDateText(iss.dueDate || '');
    const pointsDisplay =
      iss.storyPoints !== null && iss.storyPoints !== undefined && iss.storyPoints !== ''
        ? String(iss.storyPoints)
        : '-';

    return `
      <div
        class="bjwt-history-card sprint-card bjwt-two-row-card"
        data-bjwt-history-issue-key="${escapeHtml(cleanKey)}"
        data-bjwt-issue-summary="${escapeHtml(cleanSummary)}"
        role="button"
        tabindex="0"
        title="點擊以置中 Modal 預覽 ${escapeHtml(cleanKey)} 詳細內容 (右鍵可複製編號或標題)"
      >
        <!-- 第一列：卡片類型Icon (支援就地快速編輯)，卡片編號，卡片標題 -->
        <div class="bjwt-card-row-top bjwt-history-card-left">
          <span
            class="bjwt-card-issuetype-slot bjwt-quick-editable"
            data-bjwt-quick-edit="type"
            role="button"
            tabindex="0"
            title="點擊編輯問題類型 (目前：${escapeHtml(iss.issueTypeName || '未指定')})"
          >
            ${
              iss.issueTypeIcon
                ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(iss.issueTypeIcon)}" alt="${escapeHtml(iss.issueTypeName)}" />`
                : `<span class="bjwt-history-issuetype-dot"></span>`
            }
          </span>
          <span class="bjwt-history-card-key ${isDone ? 'is-done' : ''}">${escapeHtml(cleanKey)}</span>
          <span class="bjwt-history-card-summary" title="${escapeHtml(cleanSummary)}">${escapeHtml(cleanSummary)}</span>
        </div>

        <!-- 第二列：用 flex 切成 n 欄，除最後一欄靠右，其他都靠左對齊 -->
        <div class="bjwt-card-row-bottom">
          <!-- 欄 1：標籤 (Epic / Parent)，靠左對齊 -->
          <div class="bjwt-card-col bjwt-card-col-epic">
            ${
              parentLabel
                ? `<span class="bjwt-history-parent-badge" title="${escapeHtml(iss.parentKey ? `${iss.parentKey}: ${iss.parentSummary}` : parentLabel)}"><span class="bjwt-parent-dot"></span><span class="bjwt-badge-text">${escapeHtml(parentLabel)}</span></span>`
                : ''
            }
          </div>

          <!-- 欄 2：截止日期，靠左對齊 -->
          <div class="bjwt-card-col bjwt-card-col-duedate">
            ${
              cleanDueDate
                ? `<span class="bjwt-history-duedate-badge" title="到期日：${escapeHtml(cleanDueDate)}">
                    <svg class="bjwt-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                      <line x1="16" y1="2" x2="16" y2="6"></line>
                      <line x1="8" y1="2" x2="8" y2="6"></line>
                      <line x1="3" y1="10" x2="21" y2="10"></line>
                    </svg>
                    <span>${escapeHtml(cleanDueDate)}</span>
                  </span>`
                : ''
            }
          </div>

          <!-- 最後一欄：狀態（最前方等寬靠左）、StoryPoint、優先度、指派人員，靠右對齊 (支援就地快速編輯) -->
          <div class="bjwt-card-col bjwt-card-col-right bjwt-card-row-bottom-right bjwt-history-card-right">
            <span
              class="bjwt-history-status-badge ${statusClass} bjwt-quick-editable"
              data-bjwt-quick-edit="status"
              role="button"
              tabindex="0"
              title="點擊編輯狀態 (目前：${escapeHtml(cleanStatusName)})"
            >
              <span class="bjwt-badge-text">${escapeHtml(cleanStatusName)}</span>
            </span>
            <!-- 欄位 1: StoryPoint (等寬 28px slot) -->
            <span
              class="bjwt-card-action-slot bjwt-card-slot-points bjwt-quick-editable"
              data-bjwt-quick-edit="points"
              role="button"
              tabindex="0"
              title="點擊編輯 Story Points (目前：${escapeHtml(pointsDisplay)})"
            >
              <span class="bjwt-history-points-badge">${escapeHtml(pointsDisplay)}</span>
            </span>

            <!-- 欄位 2: 優先度 (等寬 28px slot，無設定時仍占位) -->
            <span
              class="bjwt-card-action-slot bjwt-card-slot-priority bjwt-quick-editable"
              data-bjwt-quick-edit="priority"
              role="button"
              tabindex="0"
              title="點擊編輯優先順序 (目前：${escapeHtml(iss.priorityName || '未指定')})"
            >
              ${
                iss.priorityIcon
                  ? `<img class="bjwt-history-priority-icon" src="${escapeHtml(iss.priorityIcon)}" alt="${escapeHtml(iss.priorityName)}" />`
                  : (iss.prioritySvg || getDefaultPrioritySvg(iss.priorityName))
                  ? `<span class="bjwt-history-priority-icon bjwt-svg-wrap">${iss.prioritySvg || getDefaultPrioritySvg(iss.priorityName)}</span>`
                  : `<span class="bjwt-history-priority-placeholder" aria-hidden="true"></span>`
              }
            </span>
            <!-- 欄位 3: 指派人員 (等寬 28px slot) -->
            <span
              class="bjwt-card-action-slot bjwt-card-slot-assignee bjwt-quick-editable"
              data-bjwt-quick-edit="assignee"
              role="button"
              tabindex="0"
              title="點擊編輯經辦人 (目前：${escapeHtml(displayAssigneeName)})"
            >
              <span class="bjwt-history-assignee">
                ${
                  isUnassigned
                    ? `<span class="bjwt-history-avatar-unassigned" aria-label="未指派">
                        <svg class="bjwt-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                          <circle cx="12" cy="7" r="4"></circle>
                        </svg>
                      </span>`
                    : hasValidAvatarImg
                    ? `<img class="bjwt-history-avatar" src="${escapeHtml(iss.assigneeAvatar)}" alt="${escapeHtml(displayAssigneeName)}" />`
                    : `<span class="bjwt-history-avatar-fallback"${fallbackBgStyle}>${escapeHtml(initials || '?')}</span>`
                }
              </span>
            </span>
          </div>
        </div>
      </div>
    `;
  }

  BetterJira.IssueCardComponent = {
    renderIssueCardHtml
  };
})();
