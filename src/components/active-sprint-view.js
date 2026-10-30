/**
 * @fileoverview 右欄 80% 未結束衝刺自定義卡片檢視 (Active Sprint View) 元件
 * 提供衝刺標題橫幅、狀態計數徽章、卡片即時關鍵字過濾、非同步 API 同步與完成衝刺觸發。
 * @module components/active-sprint-view
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 非同步同步未結束衝刺的卡片資料，並寫入 issueMetadataMap 與 allApiIssues，
   * 完成後透過 scheduleLayoutRefresh() 結合當前原生篩選器重新計算左右兩欄，絕不以未篩選清單覆蓋畫面
   *
   * @param {Object} item - 衝刺結構物件
   */
  async function syncActiveSprintIssuesFromApi(item) {
    const { IssueStore, JiraApiService, LayoutManager } = BetterJira;
    const key = item.meta.key;
    try {
      const apiIssues = await JiraApiService.fetchSprintIssuesForActive(item);
      let cached = IssueStore.getActiveSprintCache(key);
      if (!cached) {
        cached = {
          key,
          title: item.meta.title,
          issues: [],
          allApiIssues: null,
          filterKeyword: '',
          fromApi: false,
          apiSyncing: false
        };
        IssueStore.setActiveSprintCache(key, cached);
      }
      cached.apiSyncing = false;

      if (apiIssues && apiIssues.length > 0) {
        const mergedList = apiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss));
        cached.allApiIssues = mergedList;
        cached.fromApi = true;
        IssueStore.setActiveSprintCache(key, cached);
        if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
          LayoutManager.scheduleLayoutRefresh();
        }
      }
    } catch {
      const cached = IssueStore.getActiveSprintCache(key);
      if (cached) cached.apiSyncing = false;
    }
  }

  /**
   * 渲染未結束衝刺的自定義卡片檢視 (與歷史衝刺一體呈現，並即時連動 Jira 原生篩選搜尋區)
   *
   * @param {Object} item - 衝刺結構物件
   * @param {Object|null} [nativeFilter=null] - 原生篩選狀態物件
   */
  function renderActiveSprintBranch(item, nativeFilter = null) {
    const { TextUtils, SprintStatsService, FilterService, IssueStore, IssueCardComponent, IssueModalComponent, LayoutManager } = BetterJira;
    const { cleanSprintTitle, cleanSummaryText, escapeHtml } = TextUtils;
    const { calculateSprintStatistics } = SprintStatsService;
    const { getNativeBacklogFilterState } = FilterService;
    const { renderIssueCardHtml } = IssueCardComponent;
    const { openHistoricalIssueDetailModal } = IssueModalComponent;

    const branchEl = item.branch;
    if (!branchEl) return;

    const key = item.meta.key;
    const activeNativeFilter = nativeFilter || getNativeBacklogFilterState();

    // 每次渲染前皆確保與最新原生 DOM 及篩選狀態同步
    if (LayoutManager && typeof LayoutManager.resolveSprintIssuesForLayout === 'function') {
      LayoutManager.resolveSprintIssuesForLayout(item, activeNativeFilter);
    }
    const sprintData = IssueStore.getActiveSprintCache(key);
    if (!sprintData) return;

    // 確保快取中的所有卡片標題皆經過深度去重清理
    if (Array.isArray(sprintData.issues)) {
      sprintData.issues.forEach((iss) => {
        if (iss && iss.summary) {
          iss.summary = cleanSummaryText(iss.summary);
        }
      });
    }

    // 從原生標頭提取日期區間 (例如 "22 10月 - 4 11月")
    let dateRange = sprintData.dateRange || '';
    const headerNodes = [
      item.headerPartner,
      branchEl.querySelector('[data-testid*="header"], .ghx-backlog-header, header')
    ].filter(Boolean);

    if (!dateRange) {
      for (const hdr of headerNodes) {
        const text = (hdr.innerText || hdr.textContent || '').replace(/\s+/g, ' ');
        const dateMatch =
          text.match(/(\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?\s*[-~至到–—]\s*\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?)/i) ||
          text.match(/(\d{1,2}\s*[^\d\s\(\)]+\s*[-~至到–—]\s*\d{1,2}\s*[^\d\s\(\)]+)/i);
        if (dateMatch) {
          dateRange = dateMatch[1].trim();
          break;
        }
      }
      sprintData.dateRange = dateRange;
    }

    // 尋找原生「完成衝刺」按鈕以利在自定義 Banner 中支援轉發點擊
    let nativeCompleteBtn = null;
    for (const hdr of headerNodes) {
      const btns = Array.from(hdr.querySelectorAll('button'));
      const found = btns.find((b) => /完成衝刺|complete sprint/i.test((b.textContent || '').trim()));
      if (found) {
        nativeCompleteBtn = found;
        break;
      }
    }

    // 建立或取得自定義容器
    let customView = branchEl.querySelector('.bjwt-active-sprint-custom-view');
    if (!customView) {
      customView = document.createElement('div');
      customView.className = 'bjwt-active-sprint-custom-view';
      customView.setAttribute('data-bjwt-custom-view', 'true');
      branchEl.appendChild(customView);
    }

    // 根據自定義卡片搜尋框關鍵字二次篩選卡片 (sprintData.issues 已由原生篩選器過濾)
    const filterKw = (sprintData.filterKeyword || '').trim().toLowerCase();
    const visibleIssues = filterKw
      ? sprintData.issues.filter(
          (iss) =>
            iss.key.toLowerCase().includes(filterKw) ||
            iss.summary.toLowerCase().includes(filterKw) ||
            iss.assigneeName.toLowerCase().includes(filterKw) ||
            (iss.assigneeInitials && iss.assigneeInitials.toLowerCase().includes(filterKw)) ||
            iss.statusName.toLowerCase().includes(filterKw) ||
            (iss.parentSummary && iss.parentSummary.toLowerCase().includes(filterKw))
        )
      : sprintData.issues;

    // 點數與數量統計完全依據目前篩選後可見的卡片計算
    const stats = calculateSprintStatistics(visibleIssues);
    const displayTitle = cleanSprintTitle(sprintData.title);

    const issuesSig = visibleIssues
      .map(
        (i) =>
          `${i.key}:${i.summary}:${i.statusName}:${i.storyPoints ?? ''}:${i.assigneeName || ''}:${i.assigneeInitials || ''}`
      )
      .join('|');

    const currentTheme = LayoutManager ? LayoutManager.getCurrentTheme() : 'Default';

    const sig = JSON.stringify({
      key,
      count: visibleIssues.length,
      points: stats.totalPoints,
      fromApi: Boolean(sprintData.fromApi),
      nativeFilterSig: activeNativeFilter.sig,
      issuesSig,
      filterKw,
      dateRange,
      theme: currentTheme
    });

    if (customView.getAttribute('data-bjwt-render-sig') === sig) {
      return;
    }
    customView.setAttribute('data-bjwt-render-sig', sig);

    const isBacklogPool = /backlog/i.test(sprintData.title);
    const badgeText = isBacklogPool ? '待辦池' : '進行中';
    const badgeClass = isBacklogPool ? 'badge-future' : 'badge-active';

    customView.innerHTML = `
      <div class="bjwt-history-sprint-container sprint-container">
        <!-- 全新設計的 Sprint 標題 Banner (與歷史衝刺一體呈現) -->
        <div class="bjwt-history-sprint-banner">
          <div class="bjwt-history-banner-main">
            <span class="bjwt-history-banner-badge ${badgeClass}">
              <svg class="bjwt-icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              ${badgeText}
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
              value="${escapeHtml(sprintData.filterKeyword || '')}"
            />
            <button type="button" class="bjwt-history-refresh-btn" title="從 Jira 重新同步此衝刺">
              ↻ 重新整理
            </button>
            ${
              nativeCompleteBtn
                ? `<button type="button" class="bjwt-active-complete-btn" title="完成此衝刺">完成衝刺</button>`
                : ''
            }
          </div>
        </div>
        ${
          sprintData.goal
            ? `<div class="bjwt-history-sprint-goal"><strong>衝刺目標：</strong>${escapeHtml(sprintData.goal)}</div>`
            : ''
        }
        <div class="bjwt-history-card-list">
          ${
            visibleIssues.length === 0
              ? `<div class="bjwt-history-empty-cards">目前沒有符合篩選條件的待辦事項卡片。</div>`
              : visibleIssues.map(renderIssueCardHtml).join('')
          }
        </div>
      </div>
    `;

    // 綁定篩選搜尋事件
    const filterInput = customView.querySelector('.bjwt-history-card-filter');
    if (filterInput) {
      filterInput.addEventListener('input', (e) => {
        const cursorPos = e.target.selectionStart;
        sprintData.filterKeyword = e.target.value;
        renderActiveSprintBranch(item);
        const newInput = customView.querySelector('.bjwt-history-card-filter');
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

    // 綁定重新整理按鈕
    const refreshBtn = customView.querySelector('.bjwt-history-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '同步中...';
        customView.removeAttribute('data-bjwt-render-sig');
        await syncActiveSprintIssuesFromApi(item);
        if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
          LayoutManager.scheduleLayoutRefresh();
        }
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ 重新整理';
      });
    }

    // 綁定完成衝刺按鈕
    const completeBtn = customView.querySelector('.bjwt-active-complete-btn');
    if (completeBtn && nativeCompleteBtn) {
      completeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        nativeCompleteBtn.click();
      });
    }

    // 綁定卡片點擊事件以置中 Modal 預覽
    customView.querySelectorAll('.bjwt-history-card').forEach((cardEl) => {
      const issueKey = cardEl.getAttribute('data-bjwt-history-issue-key');
      const issueObj =
        visibleIssues.find((i) => i.key === issueKey) ||
        sprintData.issues.find((i) => i.key === issueKey);
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

  BetterJira.ActiveSprintView = {
    syncActiveSprintIssuesFromApi,
    renderActiveSprintBranch
  };
})();
