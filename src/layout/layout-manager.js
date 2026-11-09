/**
 * @fileoverview 雙欄版面管理控制器 (Layout Manager)
 * 負責將 Jira 待辦事項頁面轉變為「左欄 20% 衝刺清單 + 右欄 80% 選取衝刺卡片」版面、視窗高度計算與復原還原。
 * @module layout/layout-manager
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  let activeSprintKey = null;
  let activeSprintIndex = 0;
  let isSidebarCollapsed = false;
  let currentSettings = {
    backlogUrl: '',
    defaultSprint: '',
    themeStyle: 'Default',
    enabled: true
  };
  let layoutRafId = null;
  let lastPrefetchedBoardId = null;

  /**
   * 動態計算左右兩欄各自獨立捲動區域的可用視窗高度，
   * 確保左欄與右欄各自擁有獨立卷軸、互不連帶捲動。
   *
   * @param {Element|null} sprintsHost - 衝刺宿主節點
   * @param {Element|null} sidebar - 側邊欄節點
   */
  function updateColumnsViewportHeight(sprintsHost, sidebar) {
    const targetEl = sidebar || sprintsHost;
    if (!targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    const topOffset = rect.top > 0 ? rect.top : 140;
    const paneH = Math.max(240, Math.floor(window.innerHeight - topOffset - 16));
    if (sprintsHost) {
      sprintsHost.style.setProperty('--bjwt-pane-h', `${paneH}px`);
    }
    if (sidebar) {
      sidebar.style.setProperty('--bjwt-pane-h', `${paneH}px`);
    }
  }

  /**
   * 整合並計算單一未結束衝刺在目前原生篩選狀態下應顯示的卡片清單與點數統計
   *
   * @param {Object} item - 衝刺分支結構物件
   * @param {Object} nativeFilter - Jira 原生篩選狀態物件
   * @param {boolean} [triggerApiSync=true] - 是否允許觸發背景 API 同步
   */
  function resolveSprintIssuesForLayout(item, nativeFilter, triggerApiSync = true) {
    const { CardDomParser, IssueStore, ActiveSprintView, FilterService, SprintStatsService } = BetterJira;
    const { branch, sprintEl, meta } = item;
    const key = meta.key;
    const sprintId = meta.sprintId;
    const cacheKey = sprintId ? `sprint_${sprintId}` : key;

    // 每次都從原生 DOM 讀取目前實際存在的卡片 (因為 CSS 保留了離屏尺寸，Jira 篩選後 DOM 卡片會即時增減)
    const rawDomIssues = CardDomParser.parseIssuesFromBranch(branch, sprintEl);
    const domIssues = rawDomIssues
      .map((iss) => IssueStore.mergeAndCacheIssue(iss))
      .filter((iss) => !iss.isSubtask);

    let cached = IssueStore.getActiveSprintCache(cacheKey) || IssueStore.getActiveSprintCache(key);
    // 若 IssueStore 尚未同步，但 JiraApiService 內部快取已有該衝刺卡片資料，自動取用
    if (
      (!cached || !Array.isArray(cached.allApiIssues) || cached.allApiIssues.length === 0) &&
      BetterJira.JiraApiService &&
      typeof BetterJira.JiraApiService.getSprintActiveApiCache === 'function'
    ) {
      const rawApiIssues =
        BetterJira.JiraApiService.getSprintActiveApiCache(cacheKey) ||
        BetterJira.JiraApiService.getSprintActiveApiCache(key) ||
        BetterJira.JiraApiService.getSprintActiveApiCache(`title_${(meta.title || '').toLowerCase()}`);
      const apiIssues = Array.isArray(rawApiIssues) ? rawApiIssues.filter((iss) => !iss.isSubtask) : null;
      if (Array.isArray(apiIssues) && apiIssues.length > 0) {
        if (!cached) {
          cached = {
            key: cacheKey,
            title: meta.title,
            issues: apiIssues,
            allApiIssues: apiIssues,
            rawIssues: apiIssues,
            masterIssuesMap: new Map(apiIssues.map((i) => [i.key, i])),
            filterKeyword: '',
            dateRange: '',
            fromApi: true,
            apiSyncing: false,
            lastSyncTime: Date.now()
          };
          IssueStore.setActiveSprintCache(cacheKey, cached);
          IssueStore.setActiveSprintCache(key, cached);
        } else {
          cached.allApiIssues = apiIssues;
          if (!cached.masterIssuesMap) cached.masterIssuesMap = new Map();
          apiIssues.forEach((i) => cached.masterIssuesMap.set(i.key, i));
          cached.rawIssues = Array.from(cached.masterIssuesMap.values()).filter((i) => !i.isSubtask);
          cached.fromApi = true;
        }
      }
    }

    if (!cached) {
      cached = {
        key: cacheKey,
        title: meta.title,
        issues: [],
        allApiIssues: null,
        filterKeyword: '',
        dateRange: '',
        fromApi: false,
        apiSyncing: false,
        lastSyncTime: 0
      };
      IssueStore.setActiveSprintCache(cacheKey, cached);
      IssueStore.setActiveSprintCache(key, cached);
    }

    cached.title = meta.title;

    // 檢查是否處於失敗冷卻退避時間 (60 秒)
    const now = Date.now();
    const COOLDOWN_MS = 60 * 1000;
    const isCoolingDown = cached.lastSyncTime && (now - cached.lastSyncTime < COOLDOWN_MS);

    // 若尚未向 Jira API 同步完整欄位，且不在冷卻退避期內，在背景發起一次 API 同步
    if (triggerApiSync && !cached.fromApi && !cached.apiSyncing && !isCoolingDown) {
      cached.lastSyncTime = now;
      ActiveSprintView.syncActiveSprintIssuesFromApi(item);
    }

    const isFiltered = Boolean(nativeFilter && (nativeFilter.isFiltered || nativeFilter.hasDirectFilter));

    let resolvedIssues = [];
    if (domIssues.length > 0) {
      // 原生 DOM 已有展開的卡片：先以原生 DOM 卡片為基底
      resolvedIssues = FilterService.filterIssuesByNativeFilter(domIssues, nativeFilter);
    } else if (!meta.isCollapsed) {
      // 衝刺處於展開狀態，但原生 DOM 內有 0 張卡片
      if (
        !isFiltered &&
        meta.headerTotalCount > 0 &&
        Array.isArray(cached.allApiIssues) &&
        cached.allApiIssues.length > 0
      ) {
        resolvedIssues = cached.allApiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss)).filter((iss) => !iss.isSubtask);
      } else {
        resolvedIssues = [];
      }
    } else {
      // 衝刺處於收合狀態
      if (Array.isArray(cached.allApiIssues) && cached.allApiIssues.length > 0) {
        const apiMerged = cached.allApiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss)).filter((iss) => !iss.isSubtask);
        resolvedIssues = FilterService.filterIssuesByNativeFilter(apiMerged, nativeFilter);
      } else {
        resolvedIssues = [];
      }
    }

    // 維護此衝刺永不縮水的母體卡片池 (Master Issues Pool)，確保篩選選單人員與類型永遠完整
    if (!cached.masterIssuesMap) {
      cached.masterIssuesMap = new Map();
    }
    const incomingSources = [
      ...(Array.isArray(cached.allApiIssues) ? cached.allApiIssues : []),
      ...domIssues
    ].filter((iss) => iss && !iss.isSubtask);
    incomingSources.forEach((iss) => {
      if (iss && iss.key) {
        const existing = cached.masterIssuesMap.get(iss.key);
        cached.masterIssuesMap.set(iss.key, existing ? IssueStore.mergeAndCacheIssue(iss) : iss);
      }
    });

    const masterIssues = Array.from(cached.masterIssuesMap.values()).filter((iss) => !iss.isSubtask);
    const rawAllIssues = (masterIssues.length > 0 ? masterIssues : resolvedIssues).filter((iss) => !iss.isSubtask);
    cached.rawIssues = rawAllIssues;

    // 若自製純前端篩選器有任何條件生效，以純前端過濾結果為準
    const { FrontendFilterService } = BetterJira;
    const isFrontendFiltered = FrontendFilterService && FrontendFilterService.getState().isActive;
    if (isFrontendFiltered) {
      resolvedIssues = FrontendFilterService.filterIssues(rawAllIssues);
    }

    resolvedIssues = resolvedIssues.filter((iss) => !iss.isSubtask);
    cached.issues = resolvedIssues;
    cached.nativeFilterSig = nativeFilter ? nativeFilter.sig : '';

    const stats = SprintStatsService.calculateSprintStatistics(resolvedIssues);
    if (isFrontendFiltered) {
      meta.cardCount = stats.totalIssues;
      meta.storyPoints = stats.totalPoints;
    } else if (isFiltered && meta.headerFilteredCount !== null) {
      meta.cardCount = meta.headerFilteredCount;
      meta.storyPoints = stats.totalPoints;
    } else if (domIssues.length > 0 || !meta.isCollapsed || Array.isArray(cached.allApiIssues)) {
      meta.cardCount = stats.totalIssues;
      meta.storyPoints = stats.totalPoints;
    } else if (isFiltered) {
      meta.cardCount = 0;
      meta.storyPoints = 0;
    } else {
      meta.cardCount = meta.headerTotalCount !== null ? meta.headerTotalCount : meta.cardCount;
      meta.storyPoints = meta.headerStoryPoints || 0;
    }

    // 若統計出的點數為 0 但標頭明確有 Story Points，則採標頭點數；反之若標頭為 0 但卡片有點數，則採卡片點數
    if ((!meta.storyPoints || meta.storyPoints === 0) && meta.headerStoryPoints > 0) {
      meta.storyPoints = meta.headerStoryPoints;
    } else if (meta.storyPoints === 0 && stats.totalPoints > 0) {
      meta.storyPoints = stats.totalPoints;
    }
  }

  /**
   * 掛載並渲染待辦事項頁面頂部的跨 Sprint 純前端搜尋篩選工具列
   *
   * @param {Element} sprintsHost - 衝刺宿主容器
   * @param {Object[]} allBoardIssues - 看板上所有已載入衝刺的卡片集合
   * @param {Object[]} filteredBoardIssues - 篩選後全板符合條件的卡片
   */
  function renderGlobalFilterToolbar(sprintsHost, allBoardIssues, filteredBoardIssues) {
    const { Constants, FilterToolbarComponent } = BetterJira;
    if (!FilterToolbarComponent || typeof FilterToolbarComponent.renderToolbarHtml !== 'function') {
      return;
    }
    const toolbarId = (Constants && Constants.GLOBAL_FILTER_TOOLBAR_ID) || 'bjwt-global-filter-toolbar';

    // 尋找 Jira 原生頁面標頭位置或 sprintsHost 前方
    const nativePageHeader =
      (typeof document !== 'undefined' && typeof document.querySelector === 'function')
        ? (document.querySelector('[data-testid="software-backlog.page-header"]') ||
           document.querySelector('[data-testid="software-backlog.header"]'))
        : null;

    let globalToolbar = typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById(toolbarId)
      : null;

    if (!globalToolbar && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      globalToolbar = document.createElement('div');
      globalToolbar.id = toolbarId;
      globalToolbar.className = 'bjwt-global-toolbar-container';
    }

    if (!globalToolbar) return;

    // 將全域工具列掛載於待辦事項最上方 (sprintsHost 內部最開頭，在側邊欄之前，橫跨 100% 寬度)
    // 這正好位於原生標頭位置，完全取代原生標頭，且絕不受外部高度塌陷或 overflow 影響
    const sidebar = document.getElementById((Constants && Constants.SIDEBAR_ID) || 'bjwt-sprint-sidebar');
    const insertBeforeTarget = sidebar || sprintsHost.firstChild;
    if (globalToolbar.parentElement !== sprintsHost || globalToolbar.nextElementSibling !== insertBeforeTarget) {
      sprintsHost.insertBefore(globalToolbar, insertBeforeTarget);
    }
    globalToolbar.setAttribute('data-bjwt-non-sprint-child', 'true');

    // 檢查工具列渲染簽名 (Signature)，若資料與篩選條件未改變，絕不銷毀並重建 DOM，杜絕點擊被重繪打斷
    const filterState = (BetterJira.FrontendFilterService && typeof BetterJira.FrontendFilterService.getState === 'function')
      ? BetterJira.FrontendFilterService.getState()
      : {};
    const customAssigneesCount =
      (BetterJira.AssigneeUtils && typeof BetterJira.AssigneeUtils.getCustomAssignees === 'function')
        ? (BetterJira.AssigneeUtils.getCustomAssignees() || []).length
        : 0;
    const projectTypesCount =
      (BetterJira.IssueStore && typeof BetterJira.IssueStore.getProjectIssueTypes === 'function')
        ? (BetterJira.IssueStore.getProjectIssueTypes() || []).length
        : 0;
    const toolbarSig = JSON.stringify({
      total: allBoardIssues.length,
      filtered: filteredBoardIssues.length,
      customAssigneesCount,
      projectTypesCount,
      kw: filterState.keyword || '',
      ass: filterState.selectedAssignees || [],
      st: filterState.selectedStatuses || [],
      tp: filterState.selectedTypes || []
    });

    if (globalToolbar.getAttribute('data-bjwt-toolbar-sig') === toolbarSig && globalToolbar.firstElementChild) {
      return;
    }
    globalToolbar.setAttribute('data-bjwt-toolbar-sig', toolbarSig);

    // 偵測打字中的搜尋輸入框焦點與游標位置，在重新渲染後無縫恢復
    const currentActive = typeof document !== 'undefined' ? document.activeElement : null;
    const isSearchFocused =
      currentActive &&
      typeof globalToolbar.contains === 'function' &&
      globalToolbar.contains(currentActive) &&
      currentActive.classList &&
      currentActive.classList.contains('bjwt-filter-search-input');
    const prevCursorPos = isSearchFocused ? currentActive.selectionStart : null;

    globalToolbar.innerHTML = FilterToolbarComponent.renderToolbarHtml(
      allBoardIssues,
      filteredBoardIssues,
      'global'
    );

    if (typeof FilterToolbarComponent.bindToolbarEvents === 'function') {
      FilterToolbarComponent.bindToolbarEvents(globalToolbar, () => {
        scheduleLayoutRefresh();
      });
    }

    if (isSearchFocused && prevCursorPos !== null) {
      const nextInput = globalToolbar.querySelector('.bjwt-filter-search-input');
      if (nextInput && typeof nextInput.focus === 'function') {
        nextInput.focus();
        try {
          if (typeof nextInput.setSelectionRange === 'function') {
            nextInput.setSelectionRange(prevCursorPos, prevCursorPos);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * 建立或更新「左欄 20% 衝刺清單 + 右欄 80% 選取衝刺卡片」的雙欄排版
   *
   * @returns {Element|null} 衝刺宿主節點 sprintsHost
   */
  function applyTwoColumnBacklogLayout() {
    const {
      Constants,
      DomUtils,
      SprintDomParser,
      FilterService,
      IssueStore,
      HistorySprintView,
      ActiveSprintView,
      SidebarComponent,
      TextUtils,
      FrontendFilterService,
      FilterToolbarComponent
    } = BetterJira;
    const { SIDEBAR_ID } = Constants;
    const { findLowestCommonAncestor, lockBacklogAncestorWidths } = DomUtils;
    const { findSprintContainers, extractSprintMeta } = SprintDomParser;
    const { getNativeBacklogFilterState, filterIssuesByNativeFilter } = FilterService;
    const { loadedHistoricalSprints } = IssueStore;
    const { cleanSprintTitle } = TextUtils;

    const sprintContainers = findSprintContainers();
    if (sprintContainers.length === 0) {
      return null;
    }

    const sprintsHost = findLowestCommonAncestor(sprintContainers);
    if (!sprintsHost) return null;

    sprintsHost.setAttribute('data-bjwt-layout-host', 'true');
    lockBacklogAncestorWidths(sprintsHost);
    if (DomUtils.hideNativeFilterBars) {
      DomUtils.hideNativeFilterBars(document);
    }

    // 偵測目前 Jira 原生篩選搜尋區的狀態 (人員頭像、未指派、搜尋關鍵字)
    const nativeFilter = getNativeBacklogFilterState();

    // 找出每個衝刺在 sprintsHost 下的直接子節點 (branch)
    const branchSet = new Set();
    const rawSprintItems = sprintContainers.map((sprintEl) => {
      let branch = sprintEl;
      while (branch.parentElement && branch.parentElement !== sprintsHost) {
        branch = branch.parentElement;
      }
      branchSet.add(branch);
      return { sprintEl, branch };
    });

    // 若某個衝刺的標頭是 branch 的前一個兄弟節點 (headerPartner)，將其配對關聯
    const sprintBranches = rawSprintItems.map((item, idx) => {
      const { sprintEl, branch } = item;
      let headerPartner = null;
      const prev = branch.previousElementSibling;
      if (
        prev &&
        prev.id !== SIDEBAR_ID &&
        !branchSet.has(prev) &&
        (prev.matches('[data-testid*="header"], header, .ghx-backlog-header') ||
          prev.querySelector('[data-testid*="header"], h2, h3, [role="heading"], [aria-expanded]'))
      ) {
        headerPartner = prev;
        headerPartner.setAttribute('data-bjwt-sprint-header-partner', 'true');
      }

      sprintEl.setAttribute('data-bjwt-sprint-container', 'true');
      branch.setAttribute('data-bjwt-sprint-branch', 'true');
      branch.setAttribute('data-bjwt-sprint-index', String(idx));

      const meta = extractSprintMeta(branch, sprintEl, headerPartner, idx);
      meta.isHistorical = false;
      const branchObj = { sprintEl, branch, headerPartner, meta };
      const isSelectedSprint = (activeSprintKey !== null && meta.key === activeSprintKey) || idx === activeSprintIndex;
      resolveSprintIssuesForLayout(branchObj, nativeFilter, isSelectedSprint);
      return branchObj;
    });

    // 將目前已載入的「歷史 Sprint (已結束)」動態同步 / Append 至 sprintsHost 與 sprintBranches
    const validHistoryKeys = new Set(loadedHistoricalSprints.map((h) => h.key));
    Array.from(sprintsHost.querySelectorAll('[data-bjwt-history-branch="true"]')).forEach((el) => {
      const k = el.getAttribute('data-bjwt-history-key');
      if (!validHistoryKeys.has(k)) {
        el.remove();
      }
    });

    loadedHistoricalSprints.forEach((histItem) => {
      const idx = sprintBranches.length;
      let histBranch = sprintsHost.querySelector(
        `[data-bjwt-history-branch="true"][data-bjwt-history-key="${CSS.escape(histItem.key)}"]`
      );
      if (!histBranch) {
        histBranch = document.createElement('div');
        histBranch.className = 'bjwt-history-sprint-branch';
        histBranch.setAttribute('data-bjwt-history-branch', 'true');
        histBranch.setAttribute('data-bjwt-history-key', histItem.key);
        sprintsHost.appendChild(histBranch);
      }

      histBranch.setAttribute('data-bjwt-sprint-branch', 'true');
      histBranch.setAttribute('data-bjwt-sprint-container', 'true');
      histBranch.setAttribute('data-bjwt-sprint-index', String(idx));

      HistorySprintView.renderHistoricalSprintBranch(histBranch, histItem, nativeFilter);

      const { FrontendFilterService } = BetterJira;
      const isFrontendFiltered = FrontendFilterService && FrontendFilterService.getState().isActive;
      const filteredHistIssues = isFrontendFiltered
        ? FrontendFilterService.filterIssues(histItem.issues || [])
        : filterIssuesByNativeFilter(histItem.issues || [], nativeFilter);
      const histStats = BetterJira.SprintStatsService.calculateSprintStatistics(filteredHistIssues);

      sprintBranches.push({
        sprintEl: histBranch,
        branch: histBranch,
        headerPartner: null,
        meta: {
          key: histItem.key,
          index: idx,
          title: cleanSprintTitle(histItem.title),
          rawTitle: histItem.title,
          cardCount: filteredHistIssues.length,
          storyPoints: histStats.totalPoints,
          isHistorical: true,
          sprintState: 'closed',
          sprintId: histItem.sprintId,
          startDate: histItem.startDate,
          endDate: histItem.endDate,
          completeDate: histItem.completeDate
        }
      });
    });

    // 依據全局看板衝刺清單 (API 或 DOM 狀態) 精確校正各衝刺之 sprintState ('active' vs 'future')
    const boardSprints = IssueStore && typeof IssueStore.getBoardSprints === 'function' ? IssueStore.getBoardSprints() : null;
    sprintBranches.forEach((b) => {
      if (b.meta && !b.meta.isHistorical) {
        if (Array.isArray(boardSprints) && boardSprints.length > 0) {
          const matched = boardSprints.find((s) => {
            if (b.meta.sprintId && String(s.id) === String(b.meta.sprintId)) return true;
            const sTitle = cleanSprintTitle(s.name || '');
            return sTitle && sTitle.toLowerCase() === (b.meta.title || '').toLowerCase();
          });
          if (matched && (matched.state === 'active' || matched.state === 'future')) {
            b.meta.sprintState = matched.state;
          }
        }
      }
    });

    // 若依然沒有任何衝刺判定為進行中衝刺，且第一個衝刺無「開始衝刺」標記，則將第一個衝刺設為進行中
    if (!sprintBranches.some((b) => b.meta && b.meta.sprintState === 'active')) {
      const firstLive = sprintBranches.find((b) => b.meta && !b.meta.isHistorical);
      if (firstLive && firstLive.meta) {
        firstLive.meta.sprintState = 'active';
      }
    }

    // 標記 sprintsHost 下非衝刺、也非側邊欄的其他直接子元素
    Array.from(sprintsHost.children).forEach((child) => {
      if (
        child.id !== SIDEBAR_ID &&
        !child.hasAttribute('data-bjwt-sprint-branch') &&
        !child.hasAttribute('data-bjwt-sprint-header-partner') &&
        !child.hasAttribute('data-bjwt-history-branch')
      ) {
        child.setAttribute('data-bjwt-non-sprint-child', 'true');
      } else {
        child.removeAttribute('data-bjwt-non-sprint-child');
      }
    });

    // 決定目前選取的衝刺索引 (每次只能切換一個衝刺，支援預設 Sprint 自動切換)
    let resolvedIndex = 0;
    let hasMatchedDefaultSprint = false;
    const defaultSprintTarget = (currentSettings && currentSettings.defaultSprint)
      ? String(currentSettings.defaultSprint).trim()
      : '';

    if (activeSprintKey !== null) {
      const foundByKey = sprintBranches.findIndex((item) => item.meta.key === activeSprintKey);
      if (foundByKey !== -1) {
        resolvedIndex = foundByKey;
      } else if (activeSprintIndex < sprintBranches.length) {
        resolvedIndex = activeSprintIndex;
      }
    } else if (defaultSprintTarget) {
      const targetLower = defaultSprintTarget.toLowerCase();
      let matchIdx = sprintBranches.findIndex((item) => {
        const title = (item.meta.title || '').trim().toLowerCase();
        const rawTitle = (item.meta.rawTitle || '').trim().toLowerCase();
        const sprintId = String(item.meta.sprintId || '').trim().toLowerCase();
        const key = String(item.meta.key || '').trim().toLowerCase();
        return title === targetLower || rawTitle === targetLower || sprintId === targetLower || key === targetLower;
      });
      if (matchIdx === -1) {
        matchIdx = sprintBranches.findIndex((item) => {
          const title = (item.meta.title || '').toLowerCase();
          const rawTitle = (item.meta.rawTitle || '').toLowerCase();
          return title.includes(targetLower) || rawTitle.includes(targetLower);
        });
      }
      if (matchIdx !== -1) {
        resolvedIndex = matchIdx;
        hasMatchedDefaultSprint = true;
      } else if (activeSprintIndex < sprintBranches.length) {
        resolvedIndex = activeSprintIndex;
      }
    } else if (activeSprintIndex < sprintBranches.length) {
      resolvedIndex = activeSprintIndex;
    }

    activeSprintIndex = resolvedIndex;
    if (!defaultSprintTarget || hasMatchedDefaultSprint || activeSprintKey !== null) {
      activeSprintKey = sprintBranches[resolvedIndex].meta.key;
    }

    if (hasMatchedDefaultSprint && SprintDomParser && typeof SprintDomParser.expandSprintHeaderOnUserSelect === 'function') {
      const selectedBranch = sprintBranches[resolvedIndex];
      if (selectedBranch && selectedBranch.meta && selectedBranch.meta.isCollapsed) {
        SprintDomParser.expandSprintHeaderOnUserSelect(selectedBranch.branch, selectedBranch.sprintEl, selectedBranch.headerPartner);
      }
    }

    // 切換右欄 80%：只顯示目前選取的衝刺，其餘衝刺隱藏
    sprintBranches.forEach((item, idx) => {
      const isSelected = idx === resolvedIndex;
      const activeVal = isSelected ? 'true' : 'false';
      item.branch.setAttribute('data-bjwt-sprint-active', activeVal);
      item.sprintEl.setAttribute('data-bjwt-sprint-active', activeVal);
      if (item.headerPartner) {
        item.headerPartner.setAttribute('data-bjwt-sprint-active', activeVal);
      }

      // 未結束衝刺：改用自定義卡片檢視 (與歷史衝刺一體呈現)
      if (isSelected && !item.meta.isHistorical) {
        ActiveSprintView.renderActiveSprintBranch(item, nativeFilter);
      }
    });

    // 建立或更新左欄 20% 衝刺切換側邊欄
    let sidebar = document.getElementById(SIDEBAR_ID);
    if (!sidebar) {
      sidebar = document.createElement('aside');
      sidebar.id = SIDEBAR_ID;
    }

    sprintsHost.setAttribute(
      'data-bjwt-sidebar-collapsed',
      isSidebarCollapsed ? 'true' : 'false'
    );
    sidebar.setAttribute('data-bjwt-collapsed', isSidebarCollapsed ? 'true' : 'false');

    const firstTarget = sprintBranches[0].headerPartner || sprintBranches[0].branch;
    if (sidebar.parentElement !== sprintsHost || sidebar.nextElementSibling !== firstTarget) {
      sprintsHost.insertBefore(sidebar, firstTarget);
    }

    // 主動從原生頁面標頭與按鈕列預熱並探索全量人員目錄
    if (BetterJira.AssigneeUtils && typeof BetterJira.AssigneeUtils.discoverAssigneesFromPage === 'function') {
      try {
        BetterJira.AssigneeUtils.discoverAssigneesFromPage();
      } catch {
        // ignore
      }
    }

    // 匯總全看板所有已載入衝刺的卡片母體 (支援跨 Sprint 搜尋)
    const allBoardIssuesMap = new Map();
    sprintBranches.forEach((item) => {
      let issues = [];
      if (item.meta && item.meta.isHistorical) {
        const h = loadedHistoricalSprints.find((x) => x.key === item.meta.key);
        issues = h && Array.isArray(h.issues) ? h.issues : [];
      } else {
        const sprintId = item.meta && item.meta.sprintId;
        const cacheKey = sprintId ? `sprint_${sprintId}` : (item.meta && item.meta.key);
        const cache = (IssueStore && typeof IssueStore.getActiveSprintCache === 'function')
          ? (IssueStore.getActiveSprintCache(cacheKey) || (item.meta && IssueStore.getActiveSprintCache(item.meta.key)))
          : null;
        issues = cache && Array.isArray(cache.rawIssues)
          ? cache.rawIssues
          : (cache && Array.isArray(cache.issues) ? cache.issues : []);
      }
      issues.forEach((iss) => {
        if (iss && iss.key && !iss.isSubtask) {
          allBoardIssuesMap.set(iss.key, iss);
        }
      });
    });

    // 額外匯總全域已快取卡片池 (確保收合衝刺或 API 快取中已知的卡片類型與成員全數納入)
    if (IssueStore && IssueStore.issueMetadataMap) {
      IssueStore.issueMetadataMap.forEach((iss, k) => {
        if (iss && k && !allBoardIssuesMap.has(k) && !iss.isSubtask) {
          allBoardIssuesMap.set(k, iss);
        }
      });
    }

    // 在背景非同步預載專案所有定義之問題類型 (包含自訂類型)，取得後自動刷新工具列選單
    if (BetterJira.JiraApiService && typeof BetterJira.JiraApiService.fetchProjectIssueTypes === 'function') {
      const pTypes = IssueStore.getProjectIssueTypes && IssueStore.getProjectIssueTypes();
      if (!Array.isArray(pTypes) || pTypes.length === 0) {
        BetterJira.JiraApiService.fetchProjectIssueTypes()
          .then((types) => {
            if (Array.isArray(types) && types.length > 0 && typeof scheduleLayoutRefresh === 'function') {
              scheduleLayoutRefresh();
            }
          })
          .catch(() => {});
      }
    }

    // 在背景非同步預熱看板 Backlog 全部未結束卡片 (包含 Future Sprints 與待辦池)，秒開未開始衝刺並充實跨衝刺搜尋
    // 嚴格限制每個 Board ID 僅預熱一次，絕不在每次排版重繪時重複觸發造成無限刷新循環
    if (BetterJira.JiraApiService && typeof BetterJira.JiraApiService.prefetchBoardBacklogIssues === 'function') {
      let currentBoardId = IssueStore.getBoardId && IssueStore.getBoardId();
      if (!currentBoardId && typeof window !== 'undefined' && window.location) {
        const href = window.location.href || '';
        const m = href.match(/\/boards\/(\d+)/i) || href.match(/[?&]rapidView=(\d+)/i);
        if (m && m[1]) {
          currentBoardId = m[1];
          if (IssueStore.setBoardId) IssueStore.setBoardId(currentBoardId);
        }
      }
      if (currentBoardId && lastPrefetchedBoardId !== String(currentBoardId)) {
        lastPrefetchedBoardId = String(currentBoardId);
        BetterJira.JiraApiService.prefetchBoardBacklogIssues(currentBoardId)
          .then((bIssues) => {
            if (Array.isArray(bIssues) && bIssues.length > 0 && typeof scheduleLayoutRefresh === 'function') {
              scheduleLayoutRefresh();
            }
          })
          .catch(() => {});

        if (typeof BetterJira.JiraApiService.fetchActiveAndFutureSprintsForBoard === 'function') {
          BetterJira.JiraApiService.fetchActiveAndFutureSprintsForBoard(currentBoardId)
            .then((list) => {
              if (Array.isArray(list) && list.length > 0 && typeof scheduleLayoutRefresh === 'function') {
                scheduleLayoutRefresh();
              }
            })
            .catch(() => {});
        }
      }
    }

    const allBoardIssues = Array.from(allBoardIssuesMap.values());
    const isFrontendFilterActive = FrontendFilterService && FrontendFilterService.getState().isActive;
    const allBoardFilteredIssues = isFrontendFilterActive && typeof FrontendFilterService.filterIssues === 'function'
      ? FrontendFilterService.filterIssues(allBoardIssues)
      : allBoardIssues;

    // 掛載與渲染頂部跨 Sprint 純前端搜尋篩選工具列 (位於待辦事項頂端原生標頭位置)
    renderGlobalFilterToolbar(sprintsHost, allBoardIssues, allBoardFilteredIssues);

    updateColumnsViewportHeight(sprintsHost, sidebar);
    SidebarComponent.renderSidebarContents(sidebar, sprintBranches, resolvedIndex, nativeFilter);

    return sprintsHost;
  }

  /**
   * 當離開「待辦事項」網址時，還原原本 Jira DOM 屬性與側邊欄
   */
  function teardownTwoColumnBacklogLayout() {
    lastPrefetchedBoardId = null;
    const { Constants, IssueModalComponent } = BetterJira;
    const { SIDEBAR_ID, HISTORY_PICKER_MODAL_ID, HISTORY_ISSUE_MODAL_ID, GLOBAL_FILTER_TOOLBAR_ID } = Constants;

    const globalToolbar = document.getElementById(GLOBAL_FILTER_TOOLBAR_ID || 'bjwt-global-filter-toolbar');
    if (globalToolbar) {
      globalToolbar.remove();
    }

    const sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) {
      sidebar.remove();
    }

    const pickerModal = document.getElementById(HISTORY_PICKER_MODAL_ID);
    if (pickerModal) {
      pickerModal.remove();
    }

    const historyIssueModal = document.getElementById(HISTORY_ISSUE_MODAL_ID);
    if (historyIssueModal) {
      historyIssueModal.remove();
    }

    document.querySelectorAll('[data-bjwt-history-branch="true"]').forEach((el) => {
      el.remove();
    });

    document.querySelectorAll('.bjwt-active-sprint-custom-view').forEach((el) => {
      el.remove();
    });

    if (IssueModalComponent) {
      IssueModalComponent.cleanupIssueModalAttributes();
    }

    document.querySelectorAll('[data-bjwt-backlog-pane]').forEach((el) => {
      el.removeAttribute('data-bjwt-backlog-pane');
    });

    document.querySelectorAll('[data-bjwt-layout-host]').forEach((el) => {
      el.removeAttribute('data-bjwt-layout-host');
      el.removeAttribute('data-bjwt-sidebar-collapsed');
    });

    document.querySelectorAll('[data-bjwt-sprint-branch]').forEach((el) => {
      el.removeAttribute('data-bjwt-sprint-branch');
      el.removeAttribute('data-bjwt-sprint-index');
      el.removeAttribute('data-bjwt-sprint-active');
    });

    document.querySelectorAll('[data-bjwt-sprint-header-partner]').forEach((el) => {
      el.removeAttribute('data-bjwt-sprint-header-partner');
      el.removeAttribute('data-bjwt-sprint-active');
    });

    document.querySelectorAll('[data-bjwt-sprint-container]').forEach((el) => {
      el.removeAttribute('data-bjwt-sprint-container');
      el.removeAttribute('data-bjwt-sprint-active');
    });

    document.querySelectorAll('[data-bjwt-non-sprint-child]').forEach((el) => {
      el.removeAttribute('data-bjwt-non-sprint-child');
    });
  }

  /**
   * 套用選定主題樣式屬性，並建構或拆除雙欄排版
   *
   * @param {boolean} matched - 當前網址是否匹配設定網址
   * @param {string} themeStyle - 主題樣式名稱
   */
  function applyThemeAndLayout(matched, themeStyle) {
    const { Constants, IssueModalComponent } = BetterJira;
    const { THEME_ATTR, LAYOUT_ACTIVE_ATTR } = Constants;
    const root = document.documentElement;

    if (!matched) {
      root.removeAttribute(THEME_ATTR);
      root.removeAttribute(LAYOUT_ACTIVE_ATTR);
      if (document.body) {
        document.body.removeAttribute(THEME_ATTR);
        document.body.removeAttribute(LAYOUT_ACTIVE_ATTR);
      }
      teardownTwoColumnBacklogLayout();
      return;
    }

    const activeStyle = 'Default';
    root.setAttribute(THEME_ATTR, activeStyle);
    root.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    if (document.body) {
      document.body.setAttribute(THEME_ATTR, activeStyle);
      document.body.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    }

    const sprintsHost = applyTwoColumnBacklogLayout();
    if (IssueModalComponent) {
      IssueModalComponent.applyIssueDetailModalTransform(sprintsHost);
    }
  }

  /**
   * 排程在下一個 requestAnimationFrame 刷新排版與狀態
   *
   * @param {Function} [onRefresh] - 刷新時要執行的評估函式
   */
  function scheduleLayoutRefresh(onRefresh) {
    if (layoutRafId) {
      cancelAnimationFrame(layoutRafId);
    }
    layoutRafId = requestAnimationFrame(() => {
      layoutRafId = null;
      if (onRefresh) {
        onRefresh();
      } else if (BetterJira.App && typeof BetterJira.App.evaluateAndApply === 'function') {
        BetterJira.App.evaluateAndApply();
      }
    });
  }

  BetterJira.LayoutManager = {
    getActiveSprintKey: () => activeSprintKey,
    setActiveSprintKey: (key) => { activeSprintKey = key; },
    getActiveSprintIndex: () => activeSprintIndex,
    setActiveSprintIndex: (idx) => { activeSprintIndex = idx; },
    isSidebarCollapsed: () => isSidebarCollapsed,
    setSidebarCollapsed: (collapsed) => { isSidebarCollapsed = collapsed; },
    getCurrentSettings: () => currentSettings,
    setCurrentSettings: (settings) => { currentSettings = settings; },
    getCurrentTheme: () => 'Default',
    updateColumnsViewportHeight,
    resolveSprintIssuesForLayout,
    applyTwoColumnBacklogLayout,
    teardownTwoColumnBacklogLayout,
    applyThemeAndLayout,
    scheduleLayoutRefresh
  };
})();
