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
  let layoutRafId = null;

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
   * 尋找頁面上所有的衝刺 (Sprint / Backlog) 容器
   */
  function findSprintContainers() {
    for (const selector of SPRINT_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector));
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
    if (/^\(?(\d+)\s*(個問題|issues?|張卡片|cards?|items?|點|points?)\)?$/i.test(cleaned)) {
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
        const countMatch = headerText.match(/(\d+)\s*(個問題|issues?|張卡片|cards?|items?)/i);
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
      return { sprintEl, branch, headerPartner, meta };
    });

    // 標記 sprintsHost 下非衝刺、也非側邊欄的其他直接子元素
    Array.from(sprintsHost.children).forEach((child) => {
      if (
        child.id !== SIDEBAR_ID &&
        !child.hasAttribute('data-bjwt-sprint-branch') &&
        !child.hasAttribute('data-bjwt-sprint-header-partner')
      ) {
        child.setAttribute('data-bjwt-non-sprint-child', 'true');
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
   * 渲染左欄 20% 的衝刺選單內容
   */
  function renderSidebarContents(sidebar, sprintBranches, selectedIndex) {
    const signature = JSON.stringify({
      selectedIndex,
      theme: currentSettings.themeStyle,
      items: sprintBranches.map((b) => ({
        title: b.meta.title,
        count: b.meta.cardCount
      }))
    });

    if (sidebar.getAttribute('data-bjwt-sig') === signature) {
      return;
    }
    sidebar.setAttribute('data-bjwt-sig', signature);

    const prevList = sidebar.querySelector('.bjwt-sprint-list');
    const prevScrollTop = prevList ? prevList.scrollTop : 0;

    sidebar.innerHTML = `
      <div class="bjwt-sidebar-header">
        <span class="bjwt-sidebar-title">衝刺清單</span>
        <span class="bjwt-sidebar-count">${sprintBranches.length}</span>
      </div>
      <div class="bjwt-sprint-list" role="tablist" aria-label="衝刺切換清單"></div>
    `;

    const listEl = sidebar.querySelector('.bjwt-sprint-list');

    sprintBranches.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `bjwt-sprint-tab ${idx === selectedIndex ? 'active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
      btn.innerHTML = `
        <span class="bjwt-sprint-tab-name" title="${escapeHtml(item.meta.title)}">
          ${escapeHtml(item.meta.title)}
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
        // 僅在使用者主動點擊左欄衝刺時，若該衝刺原本是收合的，才展開其標頭
        expandSprintHeaderOnUserSelect(item.branch, item.sprintEl, item.headerPartner);
      });

      listEl.appendChild(btn);
    });

    if (prevScrollTop > 0) {
      listEl.scrollTop = prevScrollTop;
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
      if (el !== modalPane) el.removeAttribute('data-bjwt-issue-modal');
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
      backdrop.addEventListener('click', () => {
        closeIssueDetailModal(modalPane);
      });
      document.body.appendChild(backdrop);
    }
  }

  function closeIssueDetailModal(modalPane) {
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

    cleanupIssueModalAttributes();

    document.querySelectorAll('[data-bjwt-backlog-pane]').forEach((el) => {
      el.removeAttribute('data-bjwt-backlog-pane');
    });

    document.querySelectorAll('[data-bjwt-layout-host]').forEach((el) => {
      el.removeAttribute('data-bjwt-layout-host');
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

  // 按下 ESC 鍵時可關閉卡片 Modal
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
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
      return !target.closest(`#${SIDEBAR_ID}`) && !target.closest(`#${MODAL_BACKDROP_ID}`);
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
