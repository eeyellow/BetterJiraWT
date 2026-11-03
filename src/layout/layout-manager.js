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
    const domIssues = rawDomIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss));

    let cached = IssueStore.getActiveSprintCache(cacheKey) || IssueStore.getActiveSprintCache(key);
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
      cached.apiSyncing = true;
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
        resolvedIssues = cached.allApiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss));
      } else {
        resolvedIssues = [];
      }
    } else {
      // 衝刺處於收合狀態
      if (Array.isArray(cached.allApiIssues) && cached.allApiIssues.length > 0) {
        const apiMerged = cached.allApiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss));
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
    ];
    incomingSources.forEach((iss) => {
      if (iss && iss.key) {
        const existing = cached.masterIssuesMap.get(iss.key);
        cached.masterIssuesMap.set(iss.key, existing ? IssueStore.mergeAndCacheIssue(iss) : iss);
      }
    });

    const masterIssues = Array.from(cached.masterIssuesMap.values());
    const rawAllIssues = masterIssues.length > 0 ? masterIssues : resolvedIssues;
    cached.rawIssues = rawAllIssues;

    // 若自製純前端篩選器有任何條件生效，以純前端過濾結果為準
    const { FrontendFilterService } = BetterJira;
    const isFrontendFiltered = FrontendFilterService && FrontendFilterService.getState().isActive;
    if (isFrontendFiltered) {
      resolvedIssues = FrontendFilterService.filterIssues(rawAllIssues);
    }

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
      TextUtils
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

      const filteredHistIssues = filterIssuesByNativeFilter(histItem.issues || [], nativeFilter);
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
          sprintId: histItem.sprintId,
          startDate: histItem.startDate,
          endDate: histItem.endDate,
          completeDate: histItem.completeDate
        }
      });
    });

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

    updateColumnsViewportHeight(sprintsHost, sidebar);
    SidebarComponent.renderSidebarContents(sidebar, sprintBranches, resolvedIndex, nativeFilter);

    return sprintsHost;
  }

  /**
   * 當離開「待辦事項」網址時，還原原本 Jira DOM 屬性與側邊欄
   */
  function teardownTwoColumnBacklogLayout() {
    const { Constants, IssueModalComponent } = BetterJira;
    const { SIDEBAR_ID, HISTORY_PICKER_MODAL_ID, HISTORY_ISSUE_MODAL_ID } = Constants;

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
