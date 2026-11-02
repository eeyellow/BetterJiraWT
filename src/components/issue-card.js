/**
 * @fileoverview 加大高度之雙列卡片 (Two-row Issue Card) 渲染元件
 * 負責生成 Jira 工作項目卡片的 HTML 結構，第一列呈現圖示、編號與標題，第二列整齊對齊各項屬性徽章。
 * @module components/issue-card
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

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
        role="button"
        tabindex="0"
        title="點擊以置中 Modal 預覽 ${escapeHtml(cleanKey)} 詳細內容"
      >
        <!-- 第一列：卡片類型Icon，卡片編號，卡片標題 -->
        <div class="bjwt-card-row-top bjwt-history-card-left">
          ${
            iss.issueTypeIcon
              ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(iss.issueTypeIcon)}" alt="${escapeHtml(iss.issueTypeName)}" title="${escapeHtml(iss.issueTypeName)}" />`
              : `<span class="bjwt-history-issuetype-dot"></span>`
          }
          <span class="bjwt-history-card-key ${isDone ? 'is-done' : ''}">${escapeHtml(cleanKey)}</span>
          <span class="bjwt-history-card-summary" title="${escapeHtml(cleanSummary)}">${escapeHtml(cleanSummary)}</span>
        </div>

        <!-- 第二列：左側放狀態 Badge、Epic 標籤、到期日；右側固定放 StoryPoint、優先順序、指派人員 -->
        <div class="bjwt-card-row-bottom">
          <!-- 第二列左側：狀態 Badge、Epic 標籤、到期日 (靠左對齊，整齊有序) -->
          <div class="bjwt-card-row-bottom-left">
            <span class="bjwt-history-status-badge ${statusClass}" title="狀態：${escapeHtml(cleanStatusName)}">
              ${escapeHtml(cleanStatusName)}
            </span>
            ${
              parentLabel
                ? `<span class="bjwt-history-parent-badge" title="${escapeHtml(iss.parentKey ? `${iss.parentKey}: ${iss.parentSummary}` : parentLabel)}"><span class="bjwt-parent-dot"></span>${escapeHtml(parentLabel)}</span>`
                : ''
            }
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

          <!-- 第二列右側：StoryPoint、優先度、指派人員 (維持靠右一欄一欄整齊對齊) -->
          <div class="bjwt-card-row-bottom-right bjwt-history-card-right">
            <span class="bjwt-history-points-badge" title="Story Points">${escapeHtml(pointsDisplay)}</span>
            ${
              iss.priorityIcon
                ? `<img class="bjwt-history-priority-icon" src="${escapeHtml(iss.priorityIcon)}" alt="${escapeHtml(iss.priorityName)}" title="優先順序：${escapeHtml(iss.priorityName)}" />`
                : iss.prioritySvg
                ? `<span class="bjwt-history-priority-icon bjwt-svg-wrap" title="優先順序：${escapeHtml(iss.priorityName)}">${iss.prioritySvg}</span>`
                : ''
            }
            <span class="bjwt-history-assignee" title="負責人：${escapeHtml(displayAssigneeName)}">
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
          </div>
        </div>
      </div>
    `;
  }

  BetterJira.IssueCardComponent = {
    renderIssueCardHtml
  };
})();
