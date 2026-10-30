/**
 * BetterJiraWT Content Script
 * 1. 偵測當前網址是否符合設定的「待辦事項網址」
 * 2. 套用選定樣式：預設 (Default) / Bootstrap / MaterialDesign (透過 Extension Icon 呈現狀態)
 * 3. 將「待辦事項」頁面改為左右兩欄排版：
 *    - 左欄約 20%：放置衝刺 (Sprints) 清單，顯示真實衝刺名稱，支援長清單捲動，每次只能切換一個衝刺
 *    - 右欄約 80%：顯示目前選取衝刺中的卡片
 * 4. 點擊右欄卡片時，鎖定右欄不切半，並立即以置中 Modal 彈出視窗顯示卡片詳細內容
 */
(() => {
  const THEME_ATTR = 'data-betterjira-theme';
  const LAYOUT_ACTIVE_ATTR = 'data-betterjira-layout';
  const SIDEBAR_ID = 'bjwt-sprint-sidebar';
  const MODAL_BACKDROP_ID = 'bjwt-issue-modal-backdrop';
  const HISTORY_PICKER_MODAL_ID = 'bjwt-history-picker-modal';
  const HISTORY_ISSUE_MODAL_ID = 'bjwt-history-issue-modal';
  const RUNTIME_STYLE_ID = 'bjwt-runtime-critical-styles';

  const SPRINT_SELECTORS = [
    '[data-testid="software-backlog.card-list.container"]',
    '[data-testid^="software-backlog.card-list.container"]',
    '[data-testid*="software-backlog.card-list"][data-testid*="container"]',
    '.ghx-backlog-container',
    '.js-sprint-container',
    '[data-sprint-id]',
    '.sprint-container'
  ];

  const CARD_SELECTORS = [
    '[data-testid="software-backlog.card-list.card.card-contents.card-container"]',
    '[data-testid^="software-backlog.card-list.card"]',
    '[data-testid*="issue-card"]',
    '.js-issue',
    '.ghx-issue-compact',
    '.sprint-card'
  ];

  const ISSUE_DETAIL_SELECTORS = [
    '[data-testid="software-backlog.backlog-content.issue-detail-wrapper"]',
    '[data-testid*="backlog-content.issue-detail"]',
    '[data-testid="issue.views.issue-details.issue-layout.issue-view"]',
    '[data-testid*="issue.views.issue-details.issue-layout"]',
    '[data-testid*="issue.views.issue-base.foundation.summary"]',
    '[data-testid*="issue-view-layout-templates"]',
    '[data-testid*="issue-detail"]',
    '#jira-issue-header',
    '#ghx-detail-view',
    '.ghx-detail-view'
  ];

  const IGNORED_BUTTON_TEXTS = new Set([
    '完成衝刺',
    '開始衝刺',
    '建立衝刺',
    '編輯衝刺',
    '刪除衝刺',
    '建立問題',
    '更多動作',
    'complete sprint',
    'start sprint',
    'create sprint',
    'edit sprint',
    'delete sprint',
    'create issue',
    'more actions'
  ]);

  let currentSettings = {
    backlogUrl: '',
    themeStyle: 'Default'
  };

  let activeSprintKey = null;
  let activeSprintIndex = 0;
  let isSidebarCollapsed = false;
  let layoutRafId = null;

  /**
   * 僅在「當前頁面瀏覽期間」保留的已結束歷史衝刺清單 (重新整理頁面後自動清空)
   * 結構: Array<{
   *   key: string,
   *   sprintId: number | string | null,
   *   title: string,
   *   state: 'closed',
   *   startDate?: string,
   *   endDate?: string,
   *   completeDate?: string,
   *   goal?: string,
   *   issues: Array<Object>,
   *   filterKeyword?: string
   * }>
   */
  const loadedHistoricalSprints = [];
  let cachedClosedSprints = null;
  let cachedBoardId = null;

  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${cleanPath}`;
    } catch {
      return rawUrl.trim().replace(/\/+$/, '');
    }
  }

  function isUrlMatched(currentHref, targetBacklogUrl) {
    if (!targetBacklogUrl || !targetBacklogUrl.trim()) return false;
    const normCurrent = normalizeUrl(currentHref);
    const normTarget = normalizeUrl(targetBacklogUrl);
    if (!normCurrent || !normTarget) return false;

    return (
      normCurrent === normTarget ||
      currentHref.startsWith(targetBacklogUrl.trim()) ||
      normCurrent.startsWith(normTarget)
    );
  }

  function syncExtensionIcon(themeStyle) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'BETTER_JIRA_WT_UPDATE_ICON',
          themeStyle: themeStyle || 'Default'
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  }

  /**
   * 尋找頁面上所有原生的衝刺 (Sprint / Backlog) 容器 (排除歷史衝刺自訂容器)
   */
  function findSprintContainers() {
    for (const selector of SPRINT_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector)).filter(
        (el) => !el.closest('[data-bjwt-history-branch="true"]')
      );
      if (nodes.length > 0) {
        const topLevel = nodes.filter(
          (el) => !nodes.some((other) => other !== el && other.contains(el))
        );
        if (topLevel.length > 0) {
          return topLevel;
        }
      }
    }
    return [];
  }

  /**
   * 找出所有衝刺容器的最低共同父節點 (Lowest Common Ancestor)
   */
  function findLowestCommonAncestor(elements) {
    if (!elements || elements.length === 0) return null;
    if (elements.length === 1) return elements[0].parentElement;

    let candidate = elements[0].parentElement;
    while (candidate && candidate !== document.body && candidate !== document.documentElement) {
      const containsAll = elements.every((el) => candidate.contains(el));
      if (containsAll) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    return elements[0].parentElement;
  }

  /**
   * 檢查元素是否位於某張卡片內部
   */
  function isInsideCard(el) {
    if (!el || !(el instanceof Element)) return false;
    for (const sel of CARD_SELECTORS) {
      if (el.closest(sel)) return true;
    }
    return false;
  }

  /**
   * 檢查文字是否為有意義的衝刺名稱 (過濾純數字、純問題數量、按鈕文字等)
   */
  function isValidSprintTitleCandidate(text) {
    if (!text) return false;
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length < 2) return false;
    if (IGNORED_BUTTON_TEXTS.has(cleaned.toLowerCase())) return false;
    if (/^\(?(\d+)\s*(個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?|點|points?)\)?$/i.test(cleaned)) {
      return false;
    }
    if (/^[\d\s.,()\-+/]+$/.test(cleaned)) {
      return false;
    }
    return true;
  }

  /**
   * 僅在使用者於左欄手動點擊切換衝刺時，檢查該衝刺標頭是否處於收合狀態；
   * 絕不在 MutationObserver 中自動觸發任何 click，避免誤觸「+ 建立問題」按鈕。
   */
  function expandSprintHeaderOnUserSelect(branchEl, sprintEl, headerPartner) {
    // 若該衝刺內已經有可見的卡片，代表已經是展開狀態，不需點擊任何按鈕
    for (const sel of CARD_SELECTORS) {
      const existingCard = (branchEl || sprintEl).querySelector(sel);
      if (existingCard && existingCard.offsetParent !== null) {
        return;
      }
    }

    // 僅尋找衝刺標頭列 (Header) 內的風琴夾展開按鈕，嚴格排除底部新增卡片區域
    const headerCandidates = [
      headerPartner,
      branchEl && branchEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header'),
      sprintEl && sprintEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header')
    ].filter(Boolean);

    for (const hdr of headerCandidates) {
      const toggleBtn = hdr.querySelector('[aria-expanded="false"]');
      if (
        toggleBtn &&
        !toggleBtn.hasAttribute('aria-haspopup') &&
        !isInsideCard(toggleBtn)
      ) {
        toggleBtn.click();
        return;
      }
    }

    if (sprintEl && sprintEl.classList && sprintEl.classList.contains('ghx-closed')) {
      const expander = sprintEl.querySelector('.ghx-expander, .js-expander');
      if (expander) expander.click();
    }
  }

  /**
   * 擷取衝刺的真實名稱與卡片數量
   */
  function extractSprintMeta(branchEl, sprintEl, headerPartner, index) {
    const searchRoots = [headerPartner, branchEl, sprintEl, sprintEl.parentElement].filter(Boolean);

    let title = '';

    // 1. 優先從明確的標題 Selector 尋找 (排除卡片內部元素)
    const explicitSelectors = [
      '[data-testid*="sprint-name"]',
      '[data-testid*="header.title"]',
      '[data-testid*="backlog-header"]',
      '[data-testid*="card-list.header"] h2',
      '[data-testid*="card-list.header"] h3',
      '[data-testid*="card-list.header"] [role="heading"]',
      '[data-testid*="header"] h2',
      '[data-testid*="header"] h3',
      '[data-testid*="header"] [role="heading"]',
      '.ghx-name',
      'h2',
      'h3',
      'h4',
      '[role="heading"]'
    ];

    for (const root of searchRoots) {
      if (title) break;
      for (const sel of explicitSelectors) {
        const matches = root.querySelectorAll(sel);
        for (const el of matches) {
          if (isInsideCard(el)) continue;
          const candidate = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (isValidSprintTitleCandidate(candidate)) {
            title = candidate;
            break;
          }
        }
        if (title) break;
      }
    }

    // 2. 檢查是否有 inline-edit 的 <input> 儲存衝刺名稱
    if (!title) {
      for (const root of searchRoots) {
        const inputs = root.querySelectorAll('input[type="text"], input:not([type])');
        for (const inp of inputs) {
          if (isInsideCard(inp)) continue;
          const val = (inp.value || '').trim();
          if (isValidSprintTitleCandidate(val)) {
            title = val;
            break;
          }
        }
        if (title) break;
      }
    }

    // 3. 檢查容器或風琴夾按鈕上的 aria-label
    if (!title) {
      for (const root of searchRoots) {
        const ariaNodes = [
          root,
          ...Array.from(root.querySelectorAll('[aria-expanded], [role="region"], [data-testid*="header"]'))
        ];
        for (const node of ariaNodes) {
          if (!node || !(node instanceof Element) || isInsideCard(node)) continue;
          const label = (node.getAttribute('aria-label') || '').trim();
          if (isValidSprintTitleCandidate(label)) {
            title = label;
            break;
          }
        }
        if (title) break;
      }
    }

    // 4. 走訪非卡片區域的文字節點，取第一個有意義的標頭文字 (即衝刺名稱)
    if (!title) {
      for (const root of searchRoots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (isInsideCard(parent)) return NodeFilter.FILTER_REJECT;
            if (parent.closest('button') && !parent.closest('[aria-expanded]')) {
              return NodeFilter.FILTER_REJECT;
            }
            const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
            return isValidSprintTitleCandidate(txt)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP;
          }
        });
        const firstTextNode = walker.nextNode();
        if (firstTextNode) {
          title = firstTextNode.nodeValue.replace(/\s+/g, ' ').trim();
          break;
        }
      }
    }

    if (!title) {
      title = `衝刺 ${index + 1}`;
    }

    // 計算卡片數量
    let cardNodes = [];
    for (const root of [branchEl, sprintEl]) {
      if (!root) continue;
      for (const cardSel of CARD_SELECTORS) {
        const foundCards = Array.from(root.querySelectorAll(cardSel));
        if (foundCards.length > 0) {
          cardNodes = foundCards.filter(
            (c) => !foundCards.some((other) => other !== c && other.contains(c))
          );
          break;
        }
      }
      if (cardNodes.length > 0) break;
    }

    let cardCount = cardNodes.length;
    if (cardCount === 0) {
      for (const root of searchRoots) {
        const headerEl =
          root.querySelector('[data-testid*="header"], .ghx-backlog-header, header') || root;
        const headerText = (headerEl.innerText || headerEl.textContent || '').replace(/\s+/g, ' ');
        const countMatch = headerText.match(/(\d+)\s*(個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)/i);
        if (countMatch) {
          cardCount = parseInt(countMatch[1], 10);
          break;
        }
      }
    }

    const key =
      sprintEl.getAttribute('data-sprint-id') ||
      branchEl.getAttribute('data-sprint-id') ||
      sprintEl.getAttribute('id') ||
      `${index}__${title}`;

    return {
      key,
      index,
      title,
      cardCount
    };
  }

  /**
   * 預先將從 sprintsHost 往上到 <main> 之間的祖先鏈鎖定為 100% 寬度，
   * 確保點擊卡片的瞬間，右欄絕對不會被 Jira 的分割面板切成兩半。
   */
  function lockBacklogAncestorWidths(sprintsHost) {
    if (!sprintsHost) return;
    const mainBoundary =
      sprintsHost.closest('main, [role="main"]') || document.body;
    let curr = sprintsHost;
    while (curr && curr !== mainBoundary && curr !== document.body) {
      curr.setAttribute('data-bjwt-backlog-pane', 'true');
      curr = curr.parentElement;
    }
  }

  /**
   * 建立或更新「左欄 20% 衝刺清單 + 右欄 80% 選取衝刺卡片」的雙欄排版
   */
  function applyTwoColumnBacklogLayout() {
    const sprintContainers = findSprintContainers();
    if (sprintContainers.length === 0) {
      return null;
    }

    const sprintsHost = findLowestCommonAncestor(sprintContainers);
    if (!sprintsHost) return null;

    sprintsHost.setAttribute('data-bjwt-layout-host', 'true');
    lockBacklogAncestorWidths(sprintsHost);

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
      return { sprintEl, branch, headerPartner, meta };
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

      renderHistoricalSprintBranch(histBranch, histItem);

      sprintBranches.push({
        sprintEl: histBranch,
        branch: histBranch,
        headerPartner: null,
        meta: {
          key: histItem.key,
          index: idx,
          title: histItem.title,
          cardCount: histItem.issues.length,
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

    // 決定目前選取的衝刺索引 (每次只能切換一個衝刺)
    let resolvedIndex = 0;
    if (activeSprintKey !== null) {
      const foundByKey = sprintBranches.findIndex((item) => item.meta.key === activeSprintKey);
      if (foundByKey !== -1) {
        resolvedIndex = foundByKey;
      } else if (activeSprintIndex < sprintBranches.length) {
        resolvedIndex = activeSprintIndex;
      }
    } else if (activeSprintIndex < sprintBranches.length) {
      resolvedIndex = activeSprintIndex;
    }

    activeSprintIndex = resolvedIndex;
    activeSprintKey = sprintBranches[resolvedIndex].meta.key;

    // 切換右欄 80%：只顯示目前選取的衝刺，其餘衝刺隱藏
    sprintBranches.forEach((item, idx) => {
      const isSelected = idx === resolvedIndex;
      const activeVal = isSelected ? 'true' : 'false';
      item.branch.setAttribute('data-bjwt-sprint-active', activeVal);
      item.sprintEl.setAttribute('data-bjwt-sprint-active', activeVal);
      if (item.headerPartner) {
        item.headerPartner.setAttribute('data-bjwt-sprint-active', activeVal);
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
    renderSidebarContents(sidebar, sprintBranches, resolvedIndex);

    return sprintsHost;
  }

  /**
   * 動態計算左右兩欄各自獨立捲動區域的可用視窗高度，
   * 確保左欄與右欄各自擁有獨立卷軸、互不連帶捲動。
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
   * 渲染左欄 20% 的衝刺選單內容 (區分「未結束衝刺」與「已結束歷史衝刺」，並提供收合/展開 SVG 圖示按鈕與歷史衝刺按鈕)
   */
  function renderSidebarContents(sidebar, sprintBranches, selectedIndex) {
    ensureRuntimeCriticalStyles();

    const signature = JSON.stringify({
      v: 3,
      selectedIndex,
      collapsed: isSidebarCollapsed,
      theme: currentSettings.themeStyle,
      items: sprintBranches.map((b) => ({
        key: b.meta.key,
        title: b.meta.title,
        count: b.meta.cardCount,
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
      <div class="bjwt-sidebar-actions">
        <button
          type="button"
          class="bjwt-history-trigger-btn"
          title="透過 Jira API 載入已結束的歷史 Sprint"
        >
          <svg class="bjwt-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <polyline points="12 7 12 12 15 15"></polyline>
          </svg>
          <span>＋ 歷史 Sprint</span>
        </button>
      </div>
      <div class="bjwt-sprint-list" role="tablist" aria-label="衝刺切換清單"></div>
    `;

    const collapseBtn = sidebar.querySelector('.bjwt-sidebar-collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isSidebarCollapsed = true;
        applyTwoColumnBacklogLayout();
      });
    }

    const expandBtn = sidebar.querySelector('.bjwt-sidebar-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isSidebarCollapsed = false;
        applyTwoColumnBacklogLayout();
      });
    }

    const historyTriggerBtn = sidebar.querySelector('.bjwt-history-trigger-btn');
    if (historyTriggerBtn) {
      historyTriggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openHistorySprintPickerModal();
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
        <span class="bjwt-sprint-tab-badge">${item.meta.cardCount}</span>
      `;

      btn.addEventListener('click', () => {
        activeSprintIndex = idx;
        activeSprintKey = item.meta.key;
        applyTwoColumnBacklogLayout();
        if (item.branch) {
          item.branch.scrollTop = 0;
        }
        expandSprintHeaderOnUserSelect(item.branch, item.sprintEl, item.headerPartner);
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
            <span class="bjwt-sprint-tab-badge">${item.meta.cardCount}</span>
            <span class="bjwt-history-remove-btn" role="button" tabindex="0" title="從清單移除此歷史衝刺" aria-label="移除歷史衝刺">✕</span>
          </span>
        `;

        btn.addEventListener('click', (e) => {
          const target = e.target;
          if (target && target instanceof Element && target.closest('.bjwt-history-remove-btn')) {
            e.stopPropagation();
            removeHistoricalSprint(item.meta.key);
            return;
          }
          activeSprintIndex = idx;
          activeSprintKey = item.meta.key;
          applyTwoColumnBacklogLayout();
          if (item.branch) {
            item.branch.scrollTop = 0;
          }
        });

        listEl.appendChild(btn);
      });
    }

    if (prevScrollTop > 0) {
      listEl.scrollTop = prevScrollTop;
    }
  }

  /**
   * 確保關鍵圖示與歷史衝刺樣式即時注入頁面 (即使瀏覽器快取舊版 styles.css 也能立即呈現收合圖示與歷史 Sprint 介面)
   */
  function ensureRuntimeCriticalStyles() {
    if (document.getElementById(RUNTIME_STYLE_ID)) return;
    const styleEl = document.createElement('style');
    styleEl.id = RUNTIME_STYLE_ID;
    styleEl.textContent = `
      .bjwt-icon-svg {
        display: inline-block !important;
        vertical-align: middle !important;
        flex-shrink: 0 !important;
        overflow: visible !important;
      }
      .bjwt-sidebar-collapse-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        height: 26px !important;
        padding: 0 8px !important;
        border: 1px solid var(--ds-border-bold, #738496) !important;
        border-radius: 5px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        color: var(--ds-text, #dee4ea) !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        visibility: visible !important;
        opacity: 1 !important;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16) !important;
      }
      .bjwt-sidebar-collapse-btn:hover {
        background: var(--ds-background-selected, rgba(12, 102, 228, 0.2)) !important;
        color: var(--ds-text-selected, #579dff) !important;
        border-color: var(--ds-border-selected, #579dff) !important;
      }
      .bjwt-sidebar-expand-btn {
        display: none !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 8px !important;
        width: 38px !important;
        padding: 12px 4px !important;
        border: 1px solid var(--ds-border-selected, #579dff) !important;
        border-radius: 8px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        color: var(--ds-text-selected, #579dff) !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        box-shadow: 0 2px 8px rgba(12, 102, 228, 0.25) !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] {
        flex: 0 0 38px !important;
        width: 38px !important;
        max-width: 38px !important;
        min-width: 38px !important;
        height: auto !important;
        max-height: none !important;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        overflow: visible !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sidebar-header,
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sidebar-actions,
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sprint-list {
        display: none !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sidebar-expand-btn {
        display: flex !important;
      }
      html[data-betterjira-layout="two-column"] [data-bjwt-layout-host="true"][data-bjwt-sidebar-collapsed="true"] [data-bjwt-sprint-branch="true"][data-bjwt-sprint-active="true"],
      html[data-betterjira-layout="two-column"] [data-bjwt-layout-host="true"][data-bjwt-sidebar-collapsed="true"] [data-bjwt-sprint-header-partner="true"][data-bjwt-sprint-active="true"] {
        flex: 1 1 calc(100% - 54px) !important;
        width: calc(100% - 54px) !important;
        max-width: calc(100% - 54px) !important;
      }
      .bjwt-sidebar-actions {
        padding: 8px 10px !important;
        border-bottom: 1px solid var(--ds-border, #dfe1e6) !important;
        background: var(--ds-surface-raised, #ffffff) !important;
      }
      .bjwt-history-trigger-btn {
        width: 100% !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        padding: 7px 10px !important;
        border: 1px dashed #f59e0b !important;
        border-radius: 6px !important;
        background: rgba(245, 158, 11, 0.12) !important;
        color: #f59e0b !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        transition: all 0.15s ease !important;
      }
      .bjwt-history-trigger-btn:hover {
        background: rgba(245, 158, 11, 0.22) !important;
        border-style: solid !important;
        border-color: #f59e0b !important;
      }
      .bjwt-sprint-section-header {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 7px 12px 5px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        letter-spacing: 0.3px !important;
        border-bottom: 1px solid var(--ds-border, #dfe1e6) !important;
      }
      .bjwt-sprint-section-header.live-section {
        background: var(--ds-surface-sunken, rgba(9, 30, 66, 0.04)) !important;
        color: var(--ds-text-subtle, #64748b) !important;
      }
      .bjwt-sprint-section-header.history-section {
        background: rgba(245, 158, 11, 0.14) !important;
        color: #f59e0b !important;
        border-top: 2px solid rgba(245, 158, 11, 0.35) !important;
        border-bottom: 1px solid rgba(245, 158, 11, 0.35) !important;
      }
      .bjwt-status-dot {
        width: 7px !important;
        height: 7px !important;
        border-radius: 50% !important;
        flex-shrink: 0 !important;
        display: inline-block !important;
      }
      .bjwt-status-dot.live-dot,
      .bjwt-status-dot.live-item-dot {
        background: #22c55e !important;
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.22) !important;
      }
      .bjwt-sprint-tab-left {
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
      }
      .bjwt-sprint-tab-right {
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        flex-shrink: 0 !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history {
        background: rgba(245, 158, 11, 0.07) !important;
        border-left: 3px dashed #f59e0b !important;
        border-bottom: 1px solid var(--ds-border, rgba(245, 158, 11, 0.2)) !important;
        color: var(--ds-text, #f59e0b) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history:hover {
        background: rgba(245, 158, 11, 0.16) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history.active {
        background: rgba(245, 158, 11, 0.24) !important;
        color: #f59e0b !important;
        border-left: 4px solid #f59e0b !important;
        font-weight: 700 !important;
      }
      .bjwt-closed-pill {
        padding: 1px 6px !important;
        border-radius: 4px !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        background: rgba(245, 158, 11, 0.2) !important;
        color: #f59e0b !important;
        border: 1px solid rgba(245, 158, 11, 0.45) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history.active .bjwt-closed-pill {
        background: #d97706 !important;
        color: #ffffff !important;
        border-color: #d97706 !important;
      }
      .bjwt-history-remove-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 18px !important;
        height: 18px !important;
        border-radius: 50% !important;
        font-size: 11px !important;
        color: var(--ds-text-subtle, #f59e0b) !important;
        opacity: 0.75 !important;
      }
      .bjwt-history-remove-btn:hover {
        opacity: 1 !important;
        background: rgba(245, 158, 11, 0.28) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  /**
   * 從目前網址或頁面偵測 Jira Board ID 與 Project Key
   */
  async function detectJiraContext() {
    const href = window.location.href;
    const boardMatch = href.match(/\/boards\/(\d+)/i) || href.match(/[?&]rapidView=(\d+)/i);
    const projectMatch =
      href.match(/\/projects\/([^/?#]+)/i) || href.match(/[?&]projectKey=([^&#]+)/i);

    let boardId = boardMatch ? boardMatch[1] : cachedBoardId;
    const projectKey = projectMatch ? decodeURIComponent(projectMatch[1]) : '';

    if (!boardId && projectKey) {
      try {
        const res = await fetch(
          `${window.location.origin}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.values) && data.values.length > 0) {
            const scrumBoard = data.values.find((b) => b.type === 'scrum') || data.values[0];
            boardId = String(scrumBoard.id);
          }
        }
      } catch {
        // ignore
      }
    }

    if (boardId) {
      cachedBoardId = boardId;
    }

    return { boardId, projectKey };
  }

  /**
   * 透過 Jira Agile API 取得看板最近已結束 (state=closed) 的 Sprint 清單 (由新到舊排序)
   */
  async function fetchClosedSprintsForBoard(forceRefresh = false) {
    if (cachedClosedSprints && !forceRefresh) {
      return cachedClosedSprints;
    }

    const { boardId } = await detectJiraContext();
    if (!boardId) {
      return [];
    }

    try {
      const allClosed = [];
      let startAt = 0;
      const maxResults = 50;
      let pageCount = 0;

      while (pageCount < 6) {
        pageCount += 1;
        const url = `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?state=closed&startAt=${startAt}&maxResults=${maxResults}`;
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (!res.ok) break;
        const data = await res.json();
        const values = Array.isArray(data.values) ? data.values : [];
        allClosed.push(...values);

        if (data.isLast || values.length < maxResults) {
          break;
        }
        startAt += values.length;
      }

      // 依結束時間或 ID 由新到舊排序
      allClosed.sort((a, b) => {
        const dateA = new Date(a.completeDate || a.endDate || 0).getTime();
        const dateB = new Date(b.completeDate || b.endDate || 0).getTime();
        if (dateB !== dateA) return dateB - dateA;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });

      cachedClosedSprints = allClosed;
      return allClosed;
    } catch {
      return [];
    }
  }

  /**
   * 將 Jira API 回傳的原始 Issue 物件正規化為渲染卡片所需的欄位
   */
  function normalizeJiraIssue(raw) {
    const fields = raw.fields || {};
    const statusObj = fields.status || {};
    const statusCatKey =
      (statusObj.statusCategory && statusObj.statusCategory.key) || '';
    const issueTypeObj = fields.issuetype || {};
    const priorityObj = fields.priority || {};
    const assigneeObj = fields.assignee || null;
    const parentObj = fields.parent || null;

    // 常見 Story Points 欄位
    const storyPoints =
      fields.customfield_10016 ??
      fields.customfield_10026 ??
      fields.story_points ??
      (raw.estimateStatistic &&
        raw.estimateStatistic.statFieldValue &&
        raw.estimateStatistic.statFieldValue.value) ??
      null;

    return {
      id: raw.id,
      key: raw.key || '',
      summary: fields.summary || '(無標題)',
      statusName: statusObj.name || '未知狀態',
      statusCategory: statusCatKey, // 'done' | 'indeterminate' | 'new'
      issueTypeName: issueTypeObj.name || '任務',
      issueTypeIcon: issueTypeObj.iconUrl || '',
      priorityName: priorityObj.name || '',
      priorityIcon: priorityObj.iconUrl || '',
      assigneeName: assigneeObj ? assigneeObj.displayName || assigneeObj.name || '' : '未指派',
      assigneeAvatar:
        assigneeObj && assigneeObj.avatarUrls
          ? assigneeObj.avatarUrls['24x24'] || assigneeObj.avatarUrls['48x48'] || ''
          : '',
      parentKey: parentObj ? parentObj.key : '',
      parentSummary:
        parentObj && parentObj.fields ? parentObj.fields.summary || '' : '',
      dueDate: fields.duedate || '',
      storyPoints: typeof storyPoints === 'number' || typeof storyPoints === 'string' ? storyPoints : null
    };
  }

  /**
   * 根據使用者輸入的 Sprint 名稱或選定的 Sprint 物件，透過 Jira API 取得已結束 Sprint 的資料與卡片
   */
  async function fetchHistoricalSprintData(sprintNameInput, explicitSprintObj = null) {
    const trimmedName = (sprintNameInput || '').trim();
    const { boardId, projectKey } = await detectJiraContext();

    let matchedSprint = explicitSprintObj;

    // 1. 若未直接指定 Sprint 物件，先從看板已結束 Sprint 清單尋找匹配名稱
    if (!matchedSprint && trimmedName) {
      const closedList = await fetchClosedSprintsForBoard();
      const lowerQuery = trimmedName.toLowerCase();
      matchedSprint =
        closedList.find((s) => (s.name || '').trim().toLowerCase() === lowerQuery) ||
        closedList.find((s) => (s.name || '').toLowerCase().includes(lowerQuery)) ||
        null;
    }

    const fieldsParam =
      'summary,status,issuetype,priority,assignee,parent,duedate,customfield_10016,customfield_10026';

    // 2. 若找到對應的 Agile Sprint ID，優先呼叫 Agile Sprint Issues API
    if (matchedSprint && matchedSprint.id) {
      try {
        const res = await fetch(
          `${window.location.origin}/rest/agile/1.0/sprint/${encodeURIComponent(matchedSprint.id)}/issue?maxResults=200&fields=${fieldsParam}`,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = await res.json();
          const issues = (data.issues || []).map(normalizeJiraIssue);
          return {
            key: `history_sprint_${matchedSprint.id}`,
            sprintId: matchedSprint.id,
            title: matchedSprint.name || trimmedName,
            state: 'closed',
            startDate: matchedSprint.startDate || '',
            endDate: matchedSprint.endDate || '',
            completeDate: matchedSprint.completeDate || '',
            goal: matchedSprint.goal || '',
            issues,
            filterKeyword: ''
          };
        }
      } catch {
        // 繼續嘗試 JQL 備援
      }
    }

    // 3. 備援機制：透過 JQL 搜尋該 Sprint 名稱下的所有卡片
    const targetName = (matchedSprint && matchedSprint.name) || trimmedName;
    const escapedJqlName = targetName.replace(/"/g, '\\"');
    const jqlCandidates = [];
    if (projectKey) {
      jqlCandidates.push(`project = "${projectKey}" AND sprint = "${escapedJqlName}" ORDER BY key ASC`);
    }
    jqlCandidates.push(`sprint = "${escapedJqlName}" ORDER BY key ASC`);

    for (const jql of jqlCandidates) {
      const endpoints = [];
      if (boardId) {
        endpoints.push({
          url: `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        });
      }
      endpoints.push(
        {
          url: `${window.location.origin}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        },
        {
          url: `${window.location.origin}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        },
        {
          url: `${window.location.origin}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        }
      );

      for (const ep of endpoints) {
        try {
          const res = await fetch(ep.url, {
            method: ep.method,
            credentials: 'include',
            headers: { Accept: 'application/json' }
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (data && Array.isArray(data.issues)) {
            const issues = data.issues.map(normalizeJiraIssue);
            const resolvedKey =
              matchedSprint && matchedSprint.id
                ? `history_sprint_${matchedSprint.id}`
                : `history_sprint_${targetName.toLowerCase().replace(/\s+/g, '_')}`;
            return {
              key: resolvedKey,
              sprintId: matchedSprint ? matchedSprint.id : null,
              title: matchedSprint ? matchedSprint.name : targetName,
              state: 'closed',
              startDate: matchedSprint ? matchedSprint.startDate || '' : '',
              endDate: matchedSprint ? matchedSprint.endDate || '' : '',
              completeDate: matchedSprint ? matchedSprint.completeDate || '' : '',
              goal: matchedSprint ? matchedSprint.goal || '' : '',
              issues,
              filterKeyword: ''
            };
          }
        } catch {
          // try next endpoint
        }
      }
    }

    throw new Error(`找不到名稱為「${targetName}」的已結束 Sprint 或無權限存取`);
  }

  /**
   * 將取得的歷史 Sprint 加入當前頁面狀態並切換顯示
   */
  function appendHistoricalSprintToState(sprintData) {
    const existingIdx = loadedHistoricalSprints.findIndex(
      (item) =>
        item.key === sprintData.key ||
        item.title.trim().toLowerCase() === sprintData.title.trim().toLowerCase()
    );

    if (existingIdx !== -1) {
      loadedHistoricalSprints[existingIdx] = sprintData;
    } else {
      loadedHistoricalSprints.push(sprintData);
    }

    activeSprintKey = sprintData.key;
    applyTwoColumnBacklogLayout();
  }

  /**
   * 從目前頁面移除某個已載入的歷史 Sprint
   */
  function removeHistoricalSprint(historyKey) {
    const idx = loadedHistoricalSprints.findIndex((item) => item.key === historyKey);
    if (idx === -1) return;
    loadedHistoricalSprints.splice(idx, 1);
    if (activeSprintKey === historyKey) {
      activeSprintKey = null;
      activeSprintIndex = 0;
    }
    applyTwoColumnBacklogLayout();
  }

  function formatShortDate(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return '';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}/${m}/${day}`;
    } catch {
      return '';
    }
  }

  /**
   * 開啟「載入歷史 Sprint」對話框：支援直接輸入 Sprint 名稱查詢，並自動列出最近已結束的 Sprint 供點選
   */
  function openHistorySprintPickerModal() {
    ensureRuntimeCriticalStyles();
    const existing = document.getElementById(HISTORY_PICKER_MODAL_ID);
    if (existing) {
      existing.remove();
    }

    const modalOverlay = document.createElement('div');
    modalOverlay.id = HISTORY_PICKER_MODAL_ID;
    modalOverlay.className = 'bjwt-history-picker-overlay';
    modalOverlay.innerHTML = `
      <div class="bjwt-history-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="bjwt-history-picker-title">
        <div class="bjwt-history-picker-header">
          <div class="bjwt-history-picker-title-group">
            <svg class="bjwt-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 15"></polyline>
            </svg>
            <h3 id="bjwt-history-picker-title">載入已結束的歷史 Sprint</h3>
          </div>
          <button type="button" class="bjwt-history-picker-close" title="關閉" aria-label="關閉">✕</button>
        </div>
        <div class="bjwt-history-picker-body">
          <label class="bjwt-history-picker-label" for="bjwt-history-sprint-input">
            輸入已結束的 Sprint 名稱（可透過 API 抓取卡片並 Append 至左右兩欄）：
          </label>
          <div class="bjwt-history-picker-input-row">
            <input
              id="bjwt-history-sprint-input"
              type="text"
              class="bjwt-history-picker-input"
              placeholder="例如：Sprint 24 或輸入關鍵字篩選下方清單..."
              autocomplete="off"
            />
            <button type="button" class="bjwt-history-picker-submit">查詢並加入</button>
          </div>
          <div class="bjwt-history-picker-status" aria-live="polite"></div>
          <div class="bjwt-history-suggestions-wrap">
            <div class="bjwt-history-suggestions-title">看板最近已結束的 Sprint（點擊可直接載入）：</div>
            <div class="bjwt-history-suggestions-list">
              <div class="bjwt-history-suggestions-loading">正在從 Jira API 讀取已結束的 Sprint 清單...</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalOverlay);

    const inputEl = modalOverlay.querySelector('#bjwt-history-sprint-input');
    const submitBtn = modalOverlay.querySelector('.bjwt-history-picker-submit');
    const closeBtn = modalOverlay.querySelector('.bjwt-history-picker-close');
    const statusEl = modalOverlay.querySelector('.bjwt-history-picker-status');
    const suggestionsListEl = modalOverlay.querySelector('.bjwt-history-suggestions-list');

    function closePicker() {
      modalOverlay.remove();
    }

    closeBtn.addEventListener('click', closePicker);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closePicker();
    });

    async function handleLoadSprint(nameStr, explicitSprint = null) {
      const targetName = (explicitSprint && explicitSprint.name) || (nameStr || '').trim();
      if (!targetName) {
        statusEl.textContent = '請先輸入或選擇一個已結束的 Sprint 名稱';
        statusEl.className = 'bjwt-history-picker-status error';
        inputEl.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '載入中...';
      statusEl.textContent = `正在透過 Jira API 載入「${targetName}」的卡片資料...`;
      statusEl.className = 'bjwt-history-picker-status loading';

      try {
        const sprintData = await fetchHistoricalSprintData(targetName, explicitSprint);
        appendHistoricalSprintToState(sprintData);
        closePicker();
      } catch (err) {
        statusEl.textContent = err && err.message ? err.message : '載入失敗，請確認 Sprint 名稱是否正確';
        statusEl.className = 'bjwt-history-picker-status error';
        submitBtn.disabled = false;
        submitBtn.textContent = '查詢並加入';
      }
    }

    submitBtn.addEventListener('click', () => {
      handleLoadSprint(inputEl.value);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLoadSprint(inputEl.value);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closePicker();
      }
    });

    let allClosedSprints = [];

    function renderSuggestions(filterText = '') {
      const kw = (filterText || '').trim().toLowerCase();
      const filtered = kw
        ? allClosedSprints.filter((s) => (s.name || '').toLowerCase().includes(kw))
        : allClosedSprints;

      if (filtered.length === 0) {
        suggestionsListEl.innerHTML = `
          <div class="bjwt-history-suggestions-empty">
            ${
              allClosedSprints.length === 0
                ? '未能自動列出看板歷史清單，請直接在上方輸入框輸入 Sprint 名稱並點擊「查詢並加入」。'
                : '沒有符合關鍵字的已結束 Sprint，您仍可直接點擊「查詢並加入」以 JQL 搜尋。'
            }
          </div>
        `;
        return;
      }

      suggestionsListEl.innerHTML = '';
      filtered.slice(0, 30).forEach((sp) => {
        const alreadyLoaded = loadedHistoricalSprints.some(
          (h) => String(h.sprintId) === String(sp.id) || h.title === sp.name
        );
        const dateRange = [formatShortDate(sp.startDate), formatShortDate(sp.completeDate || sp.endDate)]
          .filter(Boolean)
          .join(' ~ ');

        const row = document.createElement('button');
        row.type = 'button';
        row.className = `bjwt-history-suggestion-item ${alreadyLoaded ? 'loaded' : ''}`;
        row.innerHTML = `
          <div class="bjwt-history-suggestion-info">
            <span class="bjwt-history-suggestion-name">${escapeHtml(sp.name || `Sprint ${sp.id}`)}</span>
            ${dateRange ? `<span class="bjwt-history-suggestion-date">${escapeHtml(dateRange)}</span>` : ''}
          </div>
          <span class="bjwt-history-suggestion-action">${alreadyLoaded ? '重新載入' : '＋ 加入'}</span>
        `;
        row.addEventListener('click', () => {
          inputEl.value = sp.name || '';
          handleLoadSprint(sp.name, sp);
        });
        suggestionsListEl.appendChild(row);
      });
    }

    inputEl.addEventListener('input', () => {
      renderSuggestions(inputEl.value);
    });

    inputEl.focus();

    fetchClosedSprintsForBoard().then((list) => {
      allClosedSprints = list;
      renderSuggestions(inputEl.value);
    });
  }

  /**
   * 渲染右欄 80% 中的「歷史 Sprint (已結束)」卡片區塊
   */
  function renderHistoricalSprintBranch(branchEl, histItem) {
    const filterKw = (histItem.filterKeyword || '').trim().toLowerCase();
    const visibleIssues = filterKw
      ? histItem.issues.filter(
          (iss) =>
            iss.key.toLowerCase().includes(filterKw) ||
            iss.summary.toLowerCase().includes(filterKw) ||
            iss.assigneeName.toLowerCase().includes(filterKw) ||
            iss.statusName.toLowerCase().includes(filterKw)
        )
      : histItem.issues;

    const sig = JSON.stringify({
      key: histItem.key,
      count: histItem.issues.length,
      filterKw,
      theme: currentSettings.themeStyle
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

    const doneCount = histItem.issues.filter((i) => i.statusCategory === 'done').length;
    const inProgressCount = histItem.issues.filter(
      (i) => i.statusCategory === 'indeterminate'
    ).length;
    const todoCount = Math.max(0, histItem.issues.length - doneCount - inProgressCount);

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
            <h2 class="bjwt-history-banner-title">${escapeHtml(histItem.title)}</h2>
            ${dateRange ? `<span class="bjwt-history-banner-dates">${escapeHtml(dateRange)}</span>` : ''}
            <span class="bjwt-history-banner-stats">
              (${histItem.issues.length} 個工作項目)
            </span>
          </div>
          <div class="bjwt-history-banner-controls">
            <span class="bjwt-history-status-counters" title="待辦 / 進行中 / 完成">
              <span class="bjwt-counter-pill counter-todo">${todoCount}</span>
              <span class="bjwt-counter-pill counter-inprogress">${inProgressCount}</span>
              <span class="bjwt-counter-pill counter-done">${doneCount}</span>
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
              : visibleIssues
                  .map((iss) => {
                    const isDone = iss.statusCategory === 'done';
                    const statusClass = isDone
                      ? 'status-done'
                      : iss.statusCategory === 'indeterminate'
                      ? 'status-inprogress'
                      : 'status-todo';
                    const initials = (iss.assigneeName || '?').slice(0, 2).toUpperCase();
                    const parentLabel = iss.parentSummary || iss.parentKey || '';
                    const pointsDisplay =
                      iss.storyPoints !== null && iss.storyPoints !== ''
                        ? String(iss.storyPoints)
                        : '-';
                    return `
                      <div
                        class="bjwt-history-card sprint-card"
                        data-bjwt-history-issue-key="${escapeHtml(iss.key)}"
                        role="button"
                        tabindex="0"
                        title="點擊以置中 Modal 預覽 ${escapeHtml(iss.key)} 詳細內容"
                      >
                        <div class="bjwt-history-card-left">
                          ${
                            iss.issueTypeIcon
                              ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(iss.issueTypeIcon)}" alt="${escapeHtml(iss.issueTypeName)}" />`
                              : `<span class="bjwt-history-issuetype-dot"></span>`
                          }
                          <span class="bjwt-history-card-key ${isDone ? 'is-done' : ''}">${escapeHtml(iss.key)}</span>
                          <span class="bjwt-history-card-summary">${escapeHtml(iss.summary)}</span>
                        </div>
                        <div class="bjwt-history-card-right">
                          ${
                            parentLabel
                              ? `<span class="bjwt-history-parent-badge" title="${escapeHtml(iss.parentKey ? `${iss.parentKey}: ${iss.parentSummary}` : parentLabel)}"><span class="bjwt-parent-dot"></span>${escapeHtml(parentLabel)}</span>`
                              : ''
                          }
                          <span class="bjwt-history-status-badge ${statusClass}">
                            ${escapeHtml(iss.statusName)}
                          </span>
                          ${
                            iss.dueDate
                              ? `<span class="bjwt-history-duedate-badge" title="到期日：${escapeHtml(iss.dueDate)}">${escapeHtml(iss.dueDate)}</span>`
                              : ''
                          }
                          <span class="bjwt-history-points-badge" title="Story Points">${escapeHtml(pointsDisplay)}</span>
                          ${
                            iss.priorityIcon
                              ? `<img class="bjwt-history-priority-icon" src="${escapeHtml(iss.priorityIcon)}" alt="${escapeHtml(iss.priorityName)}" title="優先順序：${escapeHtml(iss.priorityName)}" />`
                              : ''
                          }
                          <span class="bjwt-history-assignee" title="負責人：${escapeHtml(iss.assigneeName)}">
                            ${
                              iss.assigneeAvatar
                                ? `<img class="bjwt-history-avatar" src="${escapeHtml(iss.assigneeAvatar)}" alt="${escapeHtml(iss.assigneeName)}" />`
                                : `<span class="bjwt-history-avatar-fallback">${escapeHtml(initials)}</span>`
                            }
                          </span>
                        </div>
                      </div>
                    `;
                  })
                  .join('')
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
          appendHistoricalSprintToState(updated);
        } catch {
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ 重新整理';
        }
      });
    }

    const removeBtn = branchEl.querySelector('.bjwt-history-close-sprint-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        removeHistoricalSprint(histItem.key);
      });
    }

    branchEl.querySelectorAll('.bjwt-history-card').forEach((cardEl) => {
      const issueKey = cardEl.getAttribute('data-bjwt-history-issue-key');
      const issueObj = histItem.issues.find((i) => i.key === issueKey);
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

  /**
   * 點擊歷史 Sprint 的卡片時，以置中 Modal 彈窗預覽完整卡片詳情 (與現有卡片點擊行為一致)
   */
  function openHistoricalIssueDetailModal(issueKey, fallbackIssue = null) {
    ensureRuntimeCriticalStyles();

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
    const initialTitle = fallbackIssue ? `${issueKey} — ${fallbackIssue.summary}` : issueKey;

    modalEl.innerHTML = `
      <div class="bjwt-history-issue-modal-header">
        <div class="bjwt-history-issue-modal-title">
          <span class="bjwt-history-modal-key-badge">${escapeHtml(issueKey)}</span>
          <span class="bjwt-history-modal-summary-text">${escapeHtml(
            fallbackIssue ? fallbackIssue.summary : '載入卡片詳情中...'
          )}</span>
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
      <div class="bjwt-history-issue-modal-body">
        <div class="bjwt-history-iframe-loading">正在載入 ${escapeHtml(initialTitle)} 完整內容...</div>
        <iframe
          class="bjwt-history-issue-iframe"
          src="${escapeHtml(browseUrl)}"
          title="${escapeHtml(initialTitle)}"
        ></iframe>
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

    const iframeEl = modalEl.querySelector('.bjwt-history-issue-iframe');
    const loadingEl = modalEl.querySelector('.bjwt-history-iframe-loading');

    if (iframeEl) {
      iframeEl.addEventListener('load', () => {
        if (loadingEl) {
          loadingEl.style.display = 'none';
        }
        try {
          const iframeDoc = iframeEl.contentDocument;
          if (iframeDoc && iframeDoc.head) {
            const cleanStyle = iframeDoc.createElement('style');
            cleanStyle.textContent = `
              [data-testid="atlassian-navigation"],
              header[role="banner"],
              [data-testid="page-layout.sidebar"],
              [data-testid="software-SideNav"],
              #ak-side-navigation {
                display: none !important;
              }
              [data-testid="page-layout.main"],
              main {
                margin: 0 !important;
                padding: 0 !important;
                width: 100% !important;
                max-width: 100% !important;
              }
            `;
            iframeDoc.head.appendChild(cleanStyle);
          }
        } catch {
          // ignore cross-frame style error if any
        }
      });
    }
  }

  /**
   * 偵測右側卡片詳細面板 (支援載入骨架階段與完整載入階段)，立即轉為置中 Modal
   */
  function findIssueModalPane(host) {
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
   * 將 Jira 點擊卡片後右側的詳細面板，立即轉換為置中彈出的 Modal 視窗
   */
  function applyIssueDetailModalTransform(sprintsHost) {
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

  function ensureModalBackdrop(modalPane) {
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

  function closeIssueDetailModal(modalPane) {
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

  function cleanupIssueModalAttributes() {
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 當離開「待辦事項」網址時，還原原本 Jira DOM 屬性與側邊欄
   */
  function teardownTwoColumnBacklogLayout() {
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

    cleanupIssueModalAttributes();

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

  function applyThemeAndLayout(matched, themeStyle) {
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

    const activeStyle = themeStyle || 'Default';
    root.setAttribute(THEME_ATTR, activeStyle);
    root.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    if (document.body) {
      document.body.setAttribute(THEME_ATTR, activeStyle);
      document.body.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    }

    const sprintsHost = applyTwoColumnBacklogLayout();
    applyIssueDetailModalTransform(sprintsHost);
  }

  function evaluateAndApply() {
    const matched = isUrlMatched(window.location.href, currentSettings.backlogUrl);
    applyThemeAndLayout(matched, currentSettings.themeStyle);
  }

  function scheduleLayoutRefresh() {
    if (layoutRafId) {
      cancelAnimationFrame(layoutRafId);
    }
    layoutRafId = requestAnimationFrame(() => {
      layoutRafId = null;
      evaluateAndApply();
    });
  }

  // 當點擊卡片時，立即在同一個 frame 及後續微任務偵測右側面板並轉為 Modal (0 延遲)
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (target && target instanceof Element && isInsideCard(target)) {
        requestAnimationFrame(() => applyIssueDetailModalTransform());
        setTimeout(() => applyIssueDetailModalTransform(), 16);
        setTimeout(() => applyIssueDetailModalTransform(), 60);
      }
    },
    true
  );

  // 按下 ESC 鍵時可關閉卡片 Modal 或歷史 Sprint 選擇視窗
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const pickerModal = document.getElementById(HISTORY_PICKER_MODAL_ID);
      if (pickerModal) {
        pickerModal.remove();
        return;
      }
      const openModal = document.querySelector('[data-bjwt-issue-modal="true"]');
      if (openModal) {
        closeIssueDetailModal(openModal);
      }
    }
  });

  window.addEventListener('resize', () => {
    const sidebar = document.getElementById(SIDEBAR_ID);
    const host = document.querySelector('[data-bjwt-layout-host="true"]');
    if (sidebar || host) {
      updateColumnsViewportHeight(host, sidebar);
    }
  });

  async function init() {
    try {
      const oldStyle = document.getElementById(RUNTIME_STYLE_ID);
      if (oldStyle) {
        oldStyle.remove();
      }
      const existingSidebar = document.getElementById(SIDEBAR_ID);
      if (existingSidebar) {
        existingSidebar.removeAttribute('data-bjwt-sig');
      }
      const settings = await BetterJiraDB.getSettings();
      currentSettings = settings;
      await BetterJiraDB.syncFromObject(settings);
      syncExtensionIcon(currentSettings.themeStyle);
      evaluateAndApply();
    } catch (err) {
      console.warn('[BetterJiraWT] Initialization error:', err);
    }
  }

  // 接收來自 Popup 選單的即時更新訊息
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'BETTER_JIRA_WT_SETTINGS_UPDATED' && message.payload) {
        currentSettings = message.payload;
        syncExtensionIcon(currentSettings.themeStyle);
        BetterJiraDB.syncFromObject(currentSettings).then(() => {
          evaluateAndApply();
          sendResponse({ ok: true });
        });
        return true;
      }
    });
  }

  // 監聽 storage 變更 (多視窗同步)
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.backlogUrl) {
          currentSettings.backlogUrl = changes.backlogUrl.newValue;
        }
        if (changes.themeStyle) {
          currentSettings.themeStyle = changes.themeStyle.newValue;
          syncExtensionIcon(currentSettings.themeStyle);
        }
        BetterJiraDB.syncFromObject(currentSettings).then(() => {
          evaluateAndApply();
        });
      }
    });
  }

  // 監聽 Jira SPA 路由切換、非同步衝刺載入與點擊卡片開啟詳細區 (無 50ms 盲區)
  const observer = new MutationObserver((mutations) => {
    const isExternalChange = mutations.some((m) => {
      const target = m.target;
      if (!target || !(target instanceof Element)) return true;
      return (
        !target.closest(`#${SIDEBAR_ID}`) &&
        !target.closest(`#${MODAL_BACKDROP_ID}`) &&
        !target.closest(`#${HISTORY_PICKER_MODAL_ID}`) &&
        !target.closest(`#${HISTORY_ISSUE_MODAL_ID}`) &&
        !target.closest('[data-bjwt-history-branch="true"]')
      );
    });

    if (isExternalChange) {
      scheduleLayoutRefresh();
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  init();
})();
