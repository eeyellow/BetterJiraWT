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
   * 具備狀態防重、TTL 快取保護與防振盪更新，絕不無窮重複發起請求。
   *
   * @param {Object} item - 衝刺結構物件
   * @param {boolean} [forceRefresh=false] - 是否強制重新發起網路請求
   */
  async function syncActiveSprintIssuesFromApi(item, forceRefresh = false) {
    const { IssueStore, JiraApiService, LayoutManager } = BetterJira;
    const key = item.meta.key;
    const sprintId = item.meta.sprintId;
    const cacheKey = sprintId ? `sprint_${sprintId}` : key;

    let cached = IssueStore.getActiveSprintCache(cacheKey) || IssueStore.getActiveSprintCache(key);
    if (!cached) {
      cached = {
        key: cacheKey,
        title: item.meta.title,
        issues: [],
        allApiIssues: null,
        filterKeyword: '',
        fromApi: false,
        apiSyncing: false,
        lastSyncTime: 0
      };
      IssueStore.setActiveSprintCache(cacheKey, cached);
      IssueStore.setActiveSprintCache(key, cached);
    }

    if (cached.apiSyncing && !forceRefresh) {
      return;
    }
    cached.apiSyncing = true;

    try {
      const apiIssues = await JiraApiService.fetchSprintIssuesForActive(item, forceRefresh);

      if (Array.isArray(apiIssues) && apiIssues.length > 0) {
        const mergedList = apiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss));
        cached.allApiIssues = mergedList;
        if (!cached.masterIssuesMap) cached.masterIssuesMap = new Map();
        mergedList.forEach((iss) => cached.masterIssuesMap.set(iss.key, iss));
        cached.rawIssues = Array.from(cached.masterIssuesMap.values());
      } else if (!cached.allApiIssues) {
        cached.allApiIssues = [];
      }
    } catch {
      // ignore network errors, fallback to cooldown
    } finally {
      cached.apiSyncing = false;
      cached.fromApi = true;
      cached.lastSyncTime = Date.now();
      IssueStore.setActiveSprintCache(cacheKey, cached);
      IssueStore.setActiveSprintCache(key, cached);

      // 同步完成後清除自定義檢視的舊渲染簽名，確保卡片即時重繪出現在畫面上
      if (item.branch) {
        const cv = item.branch.querySelector('.bjwt-active-sprint-custom-view');
        if (cv) cv.removeAttribute('data-bjwt-render-sig');
      }

      if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
        LayoutManager.scheduleLayoutRefresh();
      }
    }
  }

  /**
   * 觸發 Jira 原生「建立問題 (Create Issue)」操作
   * 依序嘗試 Jira 頂部導航列之全域「建立 / Create」按鈕、導航列文字按鈕或原生快捷鍵 'c'，
   * 喚起官方彈窗以確保包含完整必填欄位驗證、檔案上傳與衝刺指派。
   *
   * @param {Object|null} [item=null] - 衝刺結構物件
   * @returns {boolean} 是否成功觸發按鈕或分發快捷鍵
   */
  function triggerCreateIssue(item = null) {
    // 1. 優先尋找 Jira 頂部導航列之全域「建立 / Create」按鈕
    const globalCreateSelectors = [
      '#createGlobalItem',
      '[data-testid="atlassian-navigation--create"]',
      '[data-testid="atlassian-navigation--primary-actions--create"]',
      '#create-menu',
      '#quick-create-button',
      'button[aria-label="Create"]',
      'button[aria-label="建立"]',
      'button[aria-label*="Create issue"]',
      'button[aria-label*="建立問題"]'
    ];

    for (const selector of globalCreateSelectors) {
      const btn = document.querySelector(selector);
      if (btn && typeof btn.click === 'function') {
        btn.click();
        return true;
      }
    }

    // 2. 尋找頂部導航列包含「建立」或「Create」文字的按鈕
    const navButtons = Array.from(
      document.querySelectorAll('header button, nav button, [role="banner"] button, [data-testid*="navigation"] button')
    );
    const matchedNavBtn = navButtons.find((btn) => {
      const text = (btn.textContent || '').trim();
      const aria = btn.getAttribute('aria-label') || '';
      return /^(建立|create)$/i.test(text) || /^(建立|create)/i.test(aria);
    });
    if (matchedNavBtn && typeof matchedNavBtn.click === 'function') {
      matchedNavBtn.click();
      return true;
    }

    // 3. 嘗試衝刺容器或 partner 內部的原生建立按鈕（若存在且非自定義檢視內的按鈕）
    if (item) {
      const containers = [item.branch, item.headerPartner].filter(Boolean);
      for (const container of containers) {
        const nativeBtn = container.querySelector(
          'button[data-testid*="create-issue"], button[data-testid*="inline-issue-create"], .ghx-create-issue, button[aria-label*="建立"], button[aria-label*="Create"]'
        );
        if (nativeBtn && !nativeBtn.classList.contains('bjwt-active-create-btn') && !nativeBtn.classList.contains('bjwt-active-inline-create-btn')) {
          nativeBtn.click();
          return true;
        }
      }
    }

    // 4. 退回方案：分發 Jira 原生快捷鍵 'c' 觸發建立對話框
    try {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        activeEl.blur();
      }
      const keyboardEvent = new KeyboardEvent('keydown', {
        key: 'c',
        code: 'KeyC',
        keyCode: 67,
        which: 67,
        bubbles: true,
        cancelable: true
      });
      document.dispatchEvent(keyboardEvent);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 渲染未結束衝刺的自定義卡片檢視 (與歷史衝刺一體呈現，並即時連動 Jira 原生篩選搜尋區)
   *
   * @param {Object} item - 衝刺結構物件
   * @param {Object|null} [nativeFilter=null] - 原生篩選狀態物件
   */
  function renderActiveSprintBranch(item, nativeFilter = null) {
    const { TextUtils, SprintStatsService, FilterService, FrontendFilterService, FilterToolbarComponent, IssueStore, IssueCardComponent, IssueModalComponent, LayoutManager } = BetterJira;
    const { cleanSprintTitle, cleanSummaryText, escapeHtml } = TextUtils;
    const { calculateSprintStatistics } = SprintStatsService;
    const { getNativeBacklogFilterState } = FilterService;
    const { renderIssueCardHtml } = IssueCardComponent;
    const { openHistoricalIssueDetailModal } = IssueModalComponent;

    const branchEl = item.branch;
    if (!branchEl) return;

    const key = item.meta.key;
    const activeNativeFilter = nativeFilter || getNativeBacklogFilterState();

    // 每次渲染前皆確保與最新原生 DOM 及篩選狀態同步 (純畫面計算，不重複觸發 API 請求)
    if (LayoutManager && typeof LayoutManager.resolveSprintIssuesForLayout === 'function') {
      LayoutManager.resolveSprintIssuesForLayout(item, activeNativeFilter, false);
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

    // 取得衝刺完整未篩選卡片清單 (母體卡片池優先，確保選單中人員與類型 100% 完整列出)
    const allIssues =
      Array.isArray(sprintData.rawIssues) && sprintData.rawIssues.length > 0
        ? sprintData.rawIssues
        : Array.isArray(sprintData.allApiIssues) && sprintData.allApiIssues.length > 0
        ? sprintData.allApiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss))
        : sprintData.issues || [];

    // 透過純前端篩選服務多維度過濾卡片
    const visibleIssues =
      FrontendFilterService && typeof FrontendFilterService.filterIssues === 'function'
        ? FrontendFilterService.filterIssues(allIssues)
        : allIssues;

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
    const frontendFilterSig = FrontendFilterService ? JSON.stringify(FrontendFilterService.getState()) : '';
    const filterOptions = FrontendFilterService ? FrontendFilterService.extractFilterOptions(allIssues) : null;
    const optionsSig = filterOptions
      ? `${filterOptions.assignees.length}:${filterOptions.types.length}:${allIssues.length}`
      : '';

    const sig = JSON.stringify({
      key,
      count: visibleIssues.length,
      points: stats.totalPoints,
      fromApi: Boolean(sprintData.fromApi),
      apiSyncing: Boolean(sprintData.apiSyncing),
      nativeFilterSig: activeNativeFilter.sig,
      frontendFilterSig,
      optionsSig,
      issuesSig,
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
            <button type="button" class="bjwt-active-create-btn" title="在此衝刺新增卡片">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              新增卡片
            </button>
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
              ? (sprintData.apiSyncing
                  ? `<div class="bjwt-history-empty-cards"><span class="bjwt-spinner-inline">⏳</span> 正在從 Jira 同步此衝刺卡片資料...</div>`
                  : `<div class="bjwt-history-empty-cards">目前沒有符合搜尋與篩選條件的卡片。您可以點選左側其他衝刺查看結果，或點擊上方「清除篩選」。</div>`)
              : visibleIssues.map(renderIssueCardHtml).join('')
          }
        </div>
        <div class="bjwt-active-create-card-row">
          <button type="button" class="bjwt-active-inline-create-btn" title="在此衝刺建立卡片">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            建立問題 (Create Issue)
          </button>
        </div>
      </div>
    `;

    // 綁定重新整理按鈕
    const refreshBtn = customView.querySelector('.bjwt-history-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '同步中...';
        customView.removeAttribute('data-bjwt-render-sig');
        await syncActiveSprintIssuesFromApi(item, true);
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

    // 綁定新增卡片按鈕 (頂部 Banner 控制列按鈕與卡片清單底部行內按鈕)
    const createBtn = customView.querySelector('.bjwt-active-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerCreateIssue(item);
      });
    }

    const inlineCreateBtn = customView.querySelector('.bjwt-active-inline-create-btn');
    if (inlineCreateBtn) {
      inlineCreateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerCreateIssue(item);
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
    renderActiveSprintBranch,
    triggerCreateIssue
  };
})();
