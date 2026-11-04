/**
 * @fileoverview 左欄 20% 衝刺切換側邊欄 (Sprint Sidebar) 渲染元件
 * 區分未結束衝刺與已結束歷史衝刺、提供 Story Points 與工作項目徽章、即時收合/展開側邊欄。
 * @module components/sidebar
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 渲染左欄 20% 的衝刺選單內容 (區分「未結束衝刺」與「已結束歷史衝刺」，並提供收合/展開 SVG 圖示按鈕與歷史衝刺按鈕)
   *
   * @param {HTMLElement} sidebar - 側邊欄 <aside> 元素
   * @param {Array<Object>} sprintBranches - 衝刺 branch 結構陣列
   * @param {number} selectedIndex - 目前選取的衝刺索引
   * @param {Object} nativeFilter - Jira 原生篩選器狀態物件
   * @param {Object} [actions={}] - 回呼函式集合
   * @param {Function} [actions.onSelectSprint] - 選擇衝刺回呼 (idx, item)
   * @param {Function} [actions.onToggleCollapse] - 切換側邊欄收合回呼 (collapsed: boolean)
   * @param {Function} [actions.onOpenHistory] - 開啟歷史衝刺選擇器回呼
   * @param {Function} [actions.onRemoveHistory] - 移除歷史衝刺回呼 (key: string)
   */
  function renderSidebarContents(sidebar, sprintBranches, selectedIndex, nativeFilter, actions = {}) {
    const { TextUtils, RuntimeStyles, LayoutManager, SprintDomParser, HistoryPickerModalComponent, IssueStore } = BetterJira;
    const { escapeHtml } = TextUtils;

    RuntimeStyles.ensureRuntimeCriticalStyles();

    const isCollapsed = LayoutManager ? LayoutManager.isSidebarCollapsed() : false;
    const currentTheme = LayoutManager ? LayoutManager.getCurrentTheme() : 'Default';

    const signature = JSON.stringify({
      v: 5,
      selectedIndex,
      collapsed: isCollapsed,
      theme: currentTheme,
      filterSig: nativeFilter ? nativeFilter.sig : '',
      items: sprintBranches.map((b) => ({
        key: b.meta.key,
        title: b.meta.title,
        count: b.meta.cardCount,
        points: b.meta.storyPoints,
        isHistorical: Boolean(b.meta.isHistorical)
      }))
    });

    if (sidebar.getAttribute('data-bjwt-sig') === signature) {
      return;
    }
    sidebar.setAttribute('data-bjwt-sig', signature);

    const prevList = sidebar.querySelector('.bjwt-sprint-list');
    const prevScrollTop = prevList ? prevList.scrollTop : 0;

    const liveItems = sprintBranches
      .map((item, idx) => ({ item, idx }))
      .filter((x) => !x.item.meta.isHistorical);
    const historyItems = sprintBranches
      .map((item, idx) => ({ item, idx }))
      .filter((x) => Boolean(x.item.meta.isHistorical));

    sidebar.innerHTML = `
      <button
        type="button"
        class="bjwt-sidebar-expand-btn"
        title="展開左欄衝刺清單"
        aria-label="展開左欄衝刺清單"
        aria-expanded="false"
      >
        <svg class="bjwt-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" ry="3"></rect>
          <line x1="9" y1="3" x2="9" y2="21"></line>
          <polyline points="13 9 16 12 13 15"></polyline>
        </svg>
        <span class="bjwt-sidebar-expand-text">展開衝刺清單</span>
      </button>
      <div class="bjwt-sidebar-header">
        <div class="bjwt-sidebar-title-wrap">
          <span class="bjwt-sidebar-title">衝刺清單</span>
          <span class="bjwt-sidebar-count">${sprintBranches.length}</span>
        </div>
        <div class="bjwt-sidebar-header-actions">
          <button
            type="button"
            class="bjwt-history-trigger-btn"
            title="載入已結束的歷史 Sprint"
            aria-label="載入已結束的歷史 Sprint"
          >
            <svg class="bjwt-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 15"></polyline>
            </svg>
          </button>
          <button
            type="button"
            class="bjwt-sidebar-collapse-btn"
            title="收合左欄衝刺清單，專注於右側當前衝刺"
            aria-label="收合左欄衝刺清單"
            aria-expanded="true"
          >
            <svg class="bjwt-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="3" ry="3"></rect>
              <line x1="9" y1="3" x2="9" y2="21"></line>
              <polyline points="16 15 13 12 16 9"></polyline>
            </svg>
            <span class="bjwt-collapse-btn-label">收合</span>
          </button>
        </div>
      </div>
      <div class="bjwt-sprint-list" role="tablist" aria-label="衝刺切換清單"></div>
    `;

    const collapseBtn = sidebar.querySelector('.bjwt-sidebar-collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (actions.onToggleCollapse) {
          actions.onToggleCollapse(true);
        } else if (LayoutManager) {
          LayoutManager.setSidebarCollapsed(true);
          LayoutManager.applyTwoColumnBacklogLayout();
        }
      });
    }

    const expandBtn = sidebar.querySelector('.bjwt-sidebar-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (actions.onToggleCollapse) {
          actions.onToggleCollapse(false);
        } else if (LayoutManager) {
          LayoutManager.setSidebarCollapsed(false);
          LayoutManager.applyTwoColumnBacklogLayout();
        }
      });
    }

    const historyTriggerBtn = sidebar.querySelector('.bjwt-history-trigger-btn');
    if (historyTriggerBtn) {
      historyTriggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (actions.onOpenHistory) {
          actions.onOpenHistory();
        } else if (HistoryPickerModalComponent) {
          HistoryPickerModalComponent.openHistorySprintPickerModal();
        }
      });
    }

    const listEl = sidebar.querySelector('.bjwt-sprint-list');

    // 分區 1：進行中 / 未結束的衝刺
    const liveHeader = document.createElement('div');
    liveHeader.className = 'bjwt-sprint-section-header live-section';
    liveHeader.innerHTML = `
      <span class="bjwt-status-dot live-dot" aria-hidden="true"></span>
      <span>未結束衝刺 (${liveItems.length})</span>
    `;
    listEl.appendChild(liveHeader);

    liveItems.forEach(({ item, idx }) => {
      const pts = item.meta.storyPoints || 0;
      const count = item.meta.cardCount || 0;
      const badgeText = pts > 0 ? `${pts} 點` : `${count}`;
      const badgeTitle =
        pts > 0
          ? `${item.meta.title}：共 ${pts} 點 Story Points (${count} 個工作項目)`
          : `${item.meta.title}：共 ${count} 個工作項目`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `bjwt-sprint-tab bjwt-sprint-tab-live ${idx === selectedIndex ? 'active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
      btn.innerHTML = `
        <span class="bjwt-sprint-tab-left">
          <span class="bjwt-status-dot live-item-dot" aria-hidden="true"></span>
          <span class="bjwt-sprint-tab-name" title="${escapeHtml(item.meta.title)}">
            ${escapeHtml(item.meta.title)}
          </span>
        </span>
        <span class="bjwt-sprint-tab-badge" data-bjwt-tab-key="${escapeHtml(item.meta.key)}" title="${escapeHtml(badgeTitle)}">${escapeHtml(badgeText)}</span>
      `;

      btn.addEventListener('click', () => {
        if (actions.onSelectSprint) {
          actions.onSelectSprint(idx, item);
        } else if (LayoutManager) {
          // 優先觸發原生風琴夾展開，確保收合中的未開始衝刺即時載入原生 DOM 卡片
          if (SprintDomParser) {
            SprintDomParser.expandSprintHeaderOnUserSelect(item.branch, item.sprintEl, item.headerPartner);
          }
          LayoutManager.setActiveSprintIndex(idx);
          LayoutManager.setActiveSprintKey(item.meta.key);
          LayoutManager.applyTwoColumnBacklogLayout();
          if (item.branch) {
            item.branch.scrollTop = 0;
          }
          // 同步發起 API 背景同步以確保資料完整 (特別是尚未開始之 Future Sprint，主動切換時強制同步秒出卡片)
          const { ActiveSprintView, IssueStore } = BetterJira;
          if (ActiveSprintView && typeof ActiveSprintView.syncActiveSprintIssuesFromApi === 'function') {
            const sprintId = item.meta && item.meta.sprintId;
            const cacheKey = sprintId ? `sprint_${sprintId}` : (item.meta && item.meta.key);
            const cached = (IssueStore && typeof IssueStore.getActiveSprintCache === 'function')
              ? (IssueStore.getActiveSprintCache(cacheKey) || (item.meta && IssueStore.getActiveSprintCache(item.meta.key)))
              : null;
            const hasIssues = cached && ((Array.isArray(cached.rawIssues) && cached.rawIssues.length > 0) || (Array.isArray(cached.allApiIssues) && cached.allApiIssues.length > 0));
            const needsForceSync = !cached || !cached.fromApi || !hasIssues;
            ActiveSprintView.syncActiveSprintIssuesFromApi(item, needsForceSync);
          }
        }
      });

      listEl.appendChild(btn);
    });

    // 分區 2：已結束的歷史衝刺 (若已載入則顯示於專屬歷史區塊)
    if (historyItems.length > 0) {
      const histHeader = document.createElement('div');
      histHeader.className = 'bjwt-sprint-section-header history-section';
      histHeader.innerHTML = `
        <svg class="bjwt-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <polyline points="12 7 12 12 15 15"></polyline>
        </svg>
        <span>已結束・歷史衝刺 (${historyItems.length})</span>
      `;
      listEl.appendChild(histHeader);

      historyItems.forEach(({ item, idx }) => {
        const pts = item.meta.storyPoints || 0;
        const count = item.meta.cardCount || 0;
        const badgeText = pts > 0 ? `${pts} 點` : `${count}`;
        const badgeTitle =
          pts > 0
            ? `${item.meta.title}：共 ${pts} 點 Story Points (${count} 個工作項目)`
            : `${item.meta.title}：共 ${count} 個工作項目`;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `bjwt-sprint-tab bjwt-sprint-tab-history ${idx === selectedIndex ? 'active' : ''}`;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
        btn.innerHTML = `
          <span class="bjwt-sprint-tab-left">
            <svg class="bjwt-icon-svg bjwt-history-tab-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 15"></polyline>
            </svg>
            <span class="bjwt-sprint-tab-name" title="${escapeHtml(item.meta.title)} (已結束)">
              ${escapeHtml(item.meta.title)}
            </span>
          </span>
          <span class="bjwt-sprint-tab-right">
            <span class="bjwt-closed-pill">已結束</span>
            <span class="bjwt-sprint-tab-badge" data-bjwt-tab-key="${escapeHtml(item.meta.key)}" title="${escapeHtml(badgeTitle)}">${escapeHtml(badgeText)}</span>
            <span class="bjwt-history-remove-btn" role="button" tabindex="0" title="從清單移除此歷史衝刺" aria-label="移除歷史衝刺">✕</span>
          </span>
        `;

        btn.addEventListener('click', (e) => {
          const target = e.target;
          if (target && target instanceof Element && target.closest('.bjwt-history-remove-btn')) {
            e.stopPropagation();
            if (actions.onRemoveHistory) {
              actions.onRemoveHistory(item.meta.key);
            } else if (IssueStore && LayoutManager) {
              IssueStore.removeHistoricalSprint(item.meta.key);
              if (LayoutManager.getActiveSprintKey() === item.meta.key) {
                LayoutManager.setActiveSprintKey(null);
                LayoutManager.setActiveSprintIndex(0);
              }
              LayoutManager.applyTwoColumnBacklogLayout();
            }
            return;
          }
          if (actions.onSelectSprint) {
            actions.onSelectSprint(idx, item);
          } else if (LayoutManager) {
            LayoutManager.setActiveSprintIndex(idx);
            LayoutManager.setActiveSprintKey(item.meta.key);
            LayoutManager.applyTwoColumnBacklogLayout();
            if (item.branch) {
              item.branch.scrollTop = 0;
            }
          }
        });

        listEl.appendChild(btn);
      });
    }

    if (prevScrollTop > 0) {
      listEl.scrollTop = prevScrollTop;
    }
  }

  BetterJira.SidebarComponent = {
    renderSidebarContents
  };
})();
