/**
 * @fileoverview 右欄 80% 已結束歷史衝刺 (Historical Sprint View) 渲染元件
 * 負責渲染已結束歷史衝刺的專屬橫幅、卡片清單、即時過濾、重新同步與移除功能。
 * @module components/history-sprint-view
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 渲染右欄 80% 中的「歷史 Sprint (已結束)」卡片區塊 (同樣支援原生篩選搜尋連動)
   *
   * @param {HTMLElement} branchEl - 歷史衝刺在 DOM 中的宿主節點
   * @param {Object} histItem - 歷史衝刺資料物件
   * @param {Object|null} [nativeFilter=null] - 原生篩選器狀態物件
   */
  function renderHistoricalSprintBranch(branchEl, histItem, nativeFilter = null) {
    const { TextUtils, SprintStatsService, FilterService, IssueStore, JiraApiService, IssueCardComponent, IssueModalComponent, LayoutManager } = BetterJira;
    const { cleanSprintTitle, cleanSummaryText, formatShortDate, escapeHtml } = TextUtils;
    const { calculateSprintStatistics } = SprintStatsService;
    const { getNativeBacklogFilterState, filterIssuesByNativeFilter } = FilterService;
    const { fetchHistoricalSprintData } = JiraApiService;
    const { renderIssueCardHtml } = IssueCardComponent;
    const { openHistoricalIssueDetailModal } = IssueModalComponent;

    const activeNativeFilter = nativeFilter || getNativeBacklogFilterState();
    const baseFilteredIssues = filterIssuesByNativeFilter(histItem.issues || [], activeNativeFilter);

    const filterKw = (histItem.filterKeyword || '').trim().toLowerCase();
    const visibleIssues = filterKw
      ? baseFilteredIssues.filter(
          (iss) =>
            iss.key.toLowerCase().includes(filterKw) ||
            iss.summary.toLowerCase().includes(filterKw) ||
            iss.assigneeName.toLowerCase().includes(filterKw) ||
            (iss.assigneeInitials && iss.assigneeInitials.toLowerCase().includes(filterKw)) ||
            iss.statusName.toLowerCase().includes(filterKw) ||
            (iss.parentSummary && iss.parentSummary.toLowerCase().includes(filterKw))
        )
      : baseFilteredIssues;

    if (Array.isArray(histItem.issues)) {
      histItem.issues.forEach((iss) => {
        if (iss && iss.summary) {
          iss.summary = cleanSummaryText(iss.summary);
        }
      });
    }

    const stats = calculateSprintStatistics(visibleIssues);
    const displayTitle = cleanSprintTitle(histItem.title);
    const histIssuesSig = visibleIssues
      .map((i) => `${i.key}:${i.summary}:${i.statusName}:${i.storyPoints ?? ''}:${i.assigneeName || ''}`)
      .join('|');

    const currentTheme = LayoutManager ? LayoutManager.getCurrentTheme() : 'Default';

    const sig = JSON.stringify({
      key: histItem.key,
      count: visibleIssues.length,
      points: stats.totalPoints,
      nativeFilterSig: activeNativeFilter.sig,
      histIssuesSig,
      filterKw,
      theme: currentTheme
    });

    if (branchEl.getAttribute('data-bjwt-render-sig') === sig) {
      return;
    }
    branchEl.setAttribute('data-bjwt-render-sig', sig);

    const dateRange = [
      formatShortDate(histItem.startDate),
      formatShortDate(histItem.completeDate || histItem.endDate)
    ]
      .filter(Boolean)
      .join(' ~ ');

    branchEl.innerHTML = `
      <div class="bjwt-history-sprint-container sprint-container">
        <div class="bjwt-history-sprint-banner">
          <div class="bjwt-history-banner-main">
            <span class="bjwt-history-banner-badge">
              <svg class="bjwt-icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9"></circle>
                <polyline points="12 7 12 12 15 15"></polyline>
              </svg>
              已結束
            </span>
            <h2 class="bjwt-history-banner-title">${escapeHtml(displayTitle)}</h2>
            ${dateRange ? `<span class="bjwt-history-banner-dates">${escapeHtml(dateRange)}</span>` : ''}
            <span class="bjwt-history-banner-stats">
              (${stats.totalIssues} 個工作項目 · 共 ${stats.totalPoints} 點)
            </span>
          </div>
          <div class="bjwt-history-banner-controls">
            <span class="bjwt-history-status-counters" title="Story Points (待辦 / 進行中 / 完成)">
              <span class="bjwt-counter-pill counter-todo" title="待辦: ${stats.todoPoints} 點 (${stats.todoCount} 個工作項目)">${stats.todoPoints}</span>
              <span class="bjwt-counter-pill counter-inprogress" title="進行中: ${stats.inProgressPoints} 點 (${stats.inProgressCount} 個工作項目)">${stats.inProgressPoints}</span>
              <span class="bjwt-counter-pill counter-done" title="完成: ${stats.donePoints} 點 (${stats.doneCount} 個工作項目)">${stats.donePoints}</span>
            </span>
            <input
              type="search"
              class="bjwt-history-card-filter"
              placeholder="篩選卡片 (Key / 標題 / 負責人)..."
              value="${escapeHtml(histItem.filterKeyword || '')}"
            />
            <button type="button" class="bjwt-history-refresh-btn" title="從 Jira API 重新同步此歷史衝刺">
              ↻ 重新整理
            </button>
            <button type="button" class="bjwt-history-close-sprint-btn" title="從目前頁面移除此歷史衝刺">
              ✕ 移除
            </button>
          </div>
        </div>
        ${
          histItem.goal
            ? `<div class="bjwt-history-sprint-goal"><strong>衝刺目標：</strong>${escapeHtml(histItem.goal)}</div>`
            : ''
        }
        <div class="bjwt-history-card-list">
          ${
            visibleIssues.length === 0
              ? `<div class="bjwt-history-empty-cards">此歷史衝刺中沒有符合條件的卡片。</div>`
              : visibleIssues.map(renderIssueCardHtml).join('')
          }
        </div>
      </div>
    `;

    const filterInput = branchEl.querySelector('.bjwt-history-card-filter');
    if (filterInput) {
      filterInput.addEventListener('input', (e) => {
        const cursorPos = e.target.selectionStart;
        histItem.filterKeyword = e.target.value;
        renderHistoricalSprintBranch(branchEl, histItem);
        const newInput = branchEl.querySelector('.bjwt-history-card-filter');
        if (newInput) {
          newInput.focus();
          try {
            newInput.setSelectionRange(cursorPos, cursorPos);
          } catch {
            // ignore
          }
        }
      });
    }

    const refreshBtn = branchEl.querySelector('.bjwt-history-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '同步中...';
        try {
          const updated = await fetchHistoricalSprintData(
            histItem.title,
            histItem.sprintId ? { id: histItem.sprintId, name: histItem.title } : null
          );
          updated.filterKeyword = histItem.filterKeyword || '';
          IssueStore.appendHistoricalSprintToState(updated);
          if (LayoutManager) {
            LayoutManager.applyTwoColumnBacklogLayout();
          }
        } catch {
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ 重新整理';
        }
      });
    }

    const removeBtn = branchEl.querySelector('.bjwt-history-close-sprint-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        IssueStore.removeHistoricalSprint(histItem.key);
        if (LayoutManager) {
          if (LayoutManager.getActiveSprintKey() === histItem.key) {
            LayoutManager.setActiveSprintKey(null);
            LayoutManager.setActiveSprintIndex(0);
          }
          LayoutManager.applyTwoColumnBacklogLayout();
        }
      });
    }

    branchEl.querySelectorAll('.bjwt-history-card').forEach((cardEl) => {
      const issueKey = cardEl.getAttribute('data-bjwt-history-issue-key');
      const issueObj =
        visibleIssues.find((i) => i.key === issueKey) ||
        histItem.issues.find((i) => i.key === issueKey);
      const handleActivate = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (issueKey) {
          openHistoricalIssueDetailModal(issueKey, issueObj);
        }
      };
      cardEl.addEventListener('click', handleActivate);
      cardEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleActivate(e);
        }
      });
    });
  }

  BetterJira.HistorySprintView = {
    renderHistoricalSprintBranch
  };
})();
