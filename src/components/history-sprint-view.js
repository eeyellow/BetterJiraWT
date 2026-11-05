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
    const { TextUtils, SprintStatsService, FilterService, FrontendFilterService, FilterToolbarComponent, IssueStore, JiraApiService, IssueCardComponent, IssueModalComponent, QuickEditPopoverComponent, CardContextMenuComponent, LayoutManager } = BetterJira;
    const { cleanSprintTitle, cleanSummaryText, formatShortDate, escapeHtml } = TextUtils;
    const { calculateSprintStatistics } = SprintStatsService;
    const { getNativeBacklogFilterState, filterIssuesByNativeFilter } = FilterService;
    const { fetchHistoricalSprintData } = JiraApiService;
    const { renderIssueCardHtml } = IssueCardComponent;
    const { openHistoricalIssueDetailModal } = IssueModalComponent;

    const allIssues = histItem.issues || [];
    const activeNativeFilter = nativeFilter || getNativeBacklogFilterState();

    // 透過純前端篩選服務過濾卡片
    const visibleIssues =
      FrontendFilterService && typeof FrontendFilterService.filterIssues === 'function'
        ? FrontendFilterService.filterIssues(allIssues)
        : filterIssuesByNativeFilter(allIssues, activeNativeFilter);

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
    const frontendFilterSig = FrontendFilterService ? JSON.stringify(FrontendFilterService.getState()) : '';

    const sig = JSON.stringify({
      key: histItem.key,
      count: visibleIssues.length,
      points: stats.totalPoints,
      nativeFilterSig: activeNativeFilter.sig,
      frontendFilterSig,
      histIssuesSig,
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
              ? `<div class="bjwt-history-empty-cards">目前沒有符合搜尋與篩選條件的卡片。您可以點選左側其他衝刺查看結果，或點擊上方「清除篩選」。</div>`
              : visibleIssues.map(renderIssueCardHtml).join('')
          }
        </div>
      </div>
    `;

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
        // 檢查是否點擊了四個快速編輯欄位 (狀態、StoryPoint、優先度、指派人員)
        const quickEditTarget = e.target && e.target.closest ? e.target.closest('[data-bjwt-quick-edit]') : null;
        if (quickEditTarget) {
          e.preventDefault();
          e.stopPropagation();
          const editType = quickEditTarget.getAttribute('data-bjwt-quick-edit');
          if (QuickEditPopoverComponent && typeof QuickEditPopoverComponent.open === 'function') {
            QuickEditPopoverComponent.open(quickEditTarget, issueKey, editType, issueObj);
          }
          return;
        }

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
      cardEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const summaryText =
          (issueObj && (issueObj.summary || issueObj.cleanSummary)) ||
          cardEl.getAttribute('data-bjwt-issue-summary') ||
          (cardEl.querySelector('.bjwt-history-card-summary') && cardEl.querySelector('.bjwt-history-card-summary').textContent.trim()) ||
          '';
        if (CardContextMenuComponent && typeof CardContextMenuComponent.open === 'function') {
          CardContextMenuComponent.open(e.clientX, e.clientY, {
            key: issueKey,
            summary: summaryText
          });
        }
      });
    });
  }

  BetterJira.HistorySprintView = {
    renderHistoricalSprintBranch
  };
})();
