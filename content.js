/**
 * BetterJiraWT Content Script
 * 1. 偵測當前網址是否符合設定的「待辦事項網址」
 * 2. 套用選定樣式：預設 (Default) / Bootstrap / MaterialDesign
 * 3. 將「待辦事項」頁面改為左右兩欄排版：
 *    - 左欄約 20%：放置衝刺 (Sprints) 清單，每次只能切換選取一個衝刺
 *    - 右欄約 80%：顯示目前選取衝刺中的卡片
 */
(() => {
  const THEME_ATTR = 'data-betterjira-theme';
  const LAYOUT_ACTIVE_ATTR = 'data-betterjira-layout';
  const BADGE_ID = 'betterjira-wt-floating-badge';
  const SIDEBAR_ID = 'bjwt-sprint-sidebar';

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

  let currentSettings = {
    backlogUrl: '',
    themeStyle: 'Default'
  };

  let activeSprintKey = null;
  let activeSprintIndex = 0;
  let isMutatingInternal = false;
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

  /**
   * 尋找頁面上所有的衝刺 (Sprint / Backlog) 風琴夾容器
   */
  function findSprintContainers() {
    for (const selector of SPRINT_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.length > 0) {
        // 過濾掉被其他容器包住的子元素，只保留最外層的各個衝刺容器
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
   * 確保被選取的衝刺若是折疊狀態 (風琴夾收合)，自動將其展開以顯示內部卡片
   */
  function ensureSprintExpanded(sprintEl) {
    if (!sprintEl) return;

    // 1. Jira Cloud 風琴夾按鈕通常帶有 aria-expanded="false"
    const headerArea =
      sprintEl.querySelector(
        '[data-testid*="card-list.header"], [data-testid*="header"], .ghx-backlog-header, header'
      ) || sprintEl;

    const collapsedBtns = headerArea.querySelectorAll('[aria-expanded="false"]');
    collapsedBtns.forEach((btn) => {
      // 避免誤點選單按鈕 (如 aria-haspopup="true")
      if (!btn.hasAttribute('aria-haspopup')) {
        btn.click();
      }
    });

    // 2. Jira Server / Data Center 折疊樣式 (.ghx-closed)
    if (sprintEl.classList.contains('ghx-closed')) {
      const expander = sprintEl.querySelector('.ghx-expander, .js-expander');
      if (expander) {
        expander.click();
      } else {
        sprintEl.classList.remove('ghx-closed');
      }
    }

    // 3. 原生 <details> 風琴夾
    if (sprintEl.tagName === 'DETAILS' && !sprintEl.open) {
      sprintEl.open = true;
    }
  }

  /**
   * 擷取衝刺的標題、卡片數量與狀態資訊，供左欄 20% 衝刺切換器顯示
   */
  function extractSprintMeta(sprintEl, index) {
    const headerEl =
      sprintEl.querySelector(
        '[data-testid*="card-list.header"], [data-testid*="header"], .ghx-backlog-header, header, summary, .sprint-header'
      ) || sprintEl;

    // 嘗試取得衝刺名稱
    const titleSelectors = [
      '[data-testid*="sprint-name"]',
      '[data-testid*="header.title"]',
      '[data-testid*="card-list.header"] h2',
      '[data-testid*="card-list.header"] [role="heading"]',
      '.ghx-name',
      'h2',
      'h3',
      'h4',
      '[role="heading"]',
      'strong'
    ];

    let title = '';
    for (const sel of titleSelectors) {
      const found = headerEl.querySelector(sel);
      if (found && found.textContent && found.textContent.trim()) {
        title = found.textContent.trim();
        break;
      }
    }

    if (!title) {
      const rawText = (headerEl.innerText || headerEl.textContent || '').trim();
      const firstLine = rawText.split('\n').map((s) => s.trim()).find(Boolean);
      title = firstLine || `衝刺 ${index + 1}`;
    }

    // 計算卡片數量 (扣除被巢狀選取的元素)
    let cardNodes = [];
    for (const cardSel of CARD_SELECTORS) {
      const foundCards = Array.from(sprintEl.querySelectorAll(cardSel));
      if (foundCards.length > 0) {
        cardNodes = foundCards.filter(
          (c) => !foundCards.some((other) => other !== c && other.contains(c))
        );
        break;
      }
    }

    let cardCount = cardNodes.length;
    if (cardCount === 0) {
      // 若風琴夾尚未渲染卡片，嘗試從標頭文字解析問題數量，例如 "12 個問題" 或 "12 issues"
      const headerText = (headerEl.innerText || headerEl.textContent || '').replace(/\s+/g, ' ');
      const countMatch = headerText.match(/(\d+)\s*(個問題|issues?|張卡片|cards?|items?)/i);
      if (countMatch) {
        cardCount = parseInt(countMatch[1], 10);
      }
    }

    const key =
      sprintEl.getAttribute('data-sprint-id') ||
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
   * 建立或更新「左欄 20% 衝刺清單 + 右欄 80% 選取衝刺卡片」的雙欄排版
   */
  function applyTwoColumnBacklogLayout() {
    const sprintContainers = findSprintContainers();
    if (sprintContainers.length === 0) {
      return;
    }

    const sprintsHost = findLowestCommonAncestor(sprintContainers);
    if (!sprintsHost) return;

    isMutatingInternal = true;
    try {
      // 標記共同父容器為雙欄 Flex 容器
      sprintsHost.setAttribute('data-bjwt-layout-host', 'true');

      // 找出每個衝刺在 sprintsHost 下的直接子節點 (branch)
      const sprintBranches = sprintContainers.map((sprintEl, idx) => {
        let branch = sprintEl;
        while (branch.parentElement && branch.parentElement !== sprintsHost) {
          branch = branch.parentElement;
        }
        sprintEl.setAttribute('data-bjwt-sprint-container', 'true');
        branch.setAttribute('data-bjwt-sprint-branch', 'true');
        branch.setAttribute('data-bjwt-sprint-index', String(idx));
        return { sprintEl, branch, meta: extractSprintMeta(sprintEl, idx) };
      });

      // 標記 sprintsHost 下非衝刺、也非側邊欄的其他直接子元素 (例如頂部篩選列)
      Array.from(sprintsHost.children).forEach((child) => {
        if (
          child.id !== SIDEBAR_ID &&
          !child.hasAttribute('data-bjwt-sprint-branch')
        ) {
          child.setAttribute('data-bjwt-non-sprint-child', 'true');
        }
      });

      // 決定目前選取的衝刺索引 (每次只能選取一個衝刺)
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

      // 切換右欄 80%：只顯示目前選取的衝刺，其餘衝刺隱藏，並確保選取的衝刺展開卡片
      sprintBranches.forEach((item, idx) => {
        const isSelected = idx === resolvedIndex;
        item.branch.setAttribute('data-bjwt-sprint-active', isSelected ? 'true' : 'false');
        item.sprintEl.setAttribute('data-bjwt-sprint-active', isSelected ? 'true' : 'false');
        if (isSelected) {
          ensureSprintExpanded(item.sprintEl);
        }
      });

      // 建立或更新左欄 20% 衝刺切換側邊欄
      let sidebar = document.getElementById(SIDEBAR_ID);
      if (!sidebar) {
        sidebar = document.createElement('aside');
        sidebar.id = SIDEBAR_ID;
      }

      // 確保 sidebar 位於第一個衝刺 branch 之前
      const firstBranch = sprintBranches[0].branch;
      if (sidebar.parentElement !== sprintsHost || sidebar.nextElementSibling !== firstBranch) {
        sprintsHost.insertBefore(sidebar, firstBranch);
      }

      renderSidebarContents(sidebar, sprintBranches, resolvedIndex);
    } finally {
      setTimeout(() => {
        isMutatingInternal = false;
      }, 50);
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

    // 若內容未變更則不重複重建 DOM
    if (sidebar.getAttribute('data-bjwt-sig') === signature) {
      return;
    }
    sidebar.setAttribute('data-bjwt-sig', signature);

    sidebar.innerHTML = `
      <div class="bjwt-sidebar-header">
        <span class="bjwt-sidebar-title">衝刺清單 (Sprints)</span>
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
      });

      listEl.appendChild(btn);
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

    document.querySelectorAll('[data-bjwt-layout-host]').forEach((el) => {
      el.removeAttribute('data-bjwt-layout-host');
    });

    document.querySelectorAll('[data-bjwt-sprint-branch]').forEach((el) => {
      el.removeAttribute('data-bjwt-sprint-branch');
      el.removeAttribute('data-bjwt-sprint-index');
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
      removeFloatingBadge();
      return;
    }

    const activeStyle = themeStyle || 'Default';
    root.setAttribute(THEME_ATTR, activeStyle);
    root.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    if (document.body) {
      document.body.setAttribute(THEME_ATTR, activeStyle);
      document.body.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    }

    applyTwoColumnBacklogLayout();
    renderFloatingBadge(activeStyle);
  }

  function renderFloatingBadge(activeStyle) {
    if (!document.body) return;

    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = BADGE_ID;
      document.body.appendChild(badge);
    }

    const styleLabel = BetterJiraDB.getStyleLabel(activeStyle);
    badge.setAttribute('data-style', activeStyle);
    badge.innerHTML = `
      <span class="bjwt-dot"></span>
      <span class="bjwt-title">BetterJiraWT</span>
      <span class="bjwt-pill">${styleLabel}</span>
    `;
  }

  function removeFloatingBadge() {
    const badge = document.getElementById(BADGE_ID);
    if (badge) {
      badge.remove();
    }
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

  async function init() {
    try {
      const settings = await BetterJiraDB.getSettings();
      currentSettings = settings;
      await BetterJiraDB.syncFromObject(settings);
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
        }
        BetterJiraDB.syncFromObject(currentSettings).then(() => {
          evaluateAndApply();
        });
      }
    });
  }

  // 監聽 Jira SPA 路由切換與非同步衝刺載入
  const observer = new MutationObserver((mutations) => {
    if (isMutatingInternal) return;

    // 忽略僅發生在浮動徽章或側邊欄內部的變更
    const isExternalChange = mutations.some((m) => {
      const target = m.target;
      if (!target || !(target instanceof Element)) return true;
      return !target.closest(`#${SIDEBAR_ID}`) && !target.closest(`#${BADGE_ID}`);
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
