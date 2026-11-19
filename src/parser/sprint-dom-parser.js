/**
 * @fileoverview Jira 衝刺 (Sprint) 原生 DOM 結構解析模組
 * 負責從原生 Backlog 樹狀結構中辨識衝刺容器、擷取標題、計算可見與標頭卡片數、解析收合狀態。
 * @module parser/sprint-dom-parser
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 檢查元素是否位於本擴充功能自建之 UI 容器內部 (如自定義檢視、側邊欄、篩選列等)，
   * 防止解析原生 Jira 衝刺標頭時誤將自定義 UI 內的統計徽章或文字重複計入。
   *
   * @param {Element|*} el - 欲檢查之 DOM 元素
   * @returns {boolean} 是否位於擴充功能 UI 內部
   */
  function isInsideExtensionUi(el) {
    if (!el || !(el instanceof Element)) return false;
    return Boolean(
      el.closest(
        '[data-bjwt-custom-view], .bjwt-active-sprint-custom-view, #bjwt-sprint-sidebar, #bjwt-global-filter-toolbar, [data-bjwt-history-branch], [data-bjwt-non-sprint-child]'
      )
    );
  }

  /**
   * 檢查元素是否位於某張卡片內部
   *
   * @param {Element|*} el - 欲檢查之 DOM 元素
   * @returns {boolean} 是否在卡片內部
   */
  function isInsideCard(el) {
    if (!el || !(el instanceof Element)) return false;
    const { CARD_SELECTORS } = BetterJira.Constants;
    for (const sel of CARD_SELECTORS) {
      if (el.closest(sel)) return true;
    }
    return false;
  }

  /**
   * 尋找頁面上所有原生的衝刺 (Sprint / Backlog) 容器 (排除歷史衝刺自訂容器)
   *
   * @returns {Element[]} 頂層衝刺容器元素陣列
   */
  function findSprintContainers() {
    const { SPRINT_SELECTORS } = BetterJira.Constants;
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
   * 檢查文字是否為有意義的衝刺名稱 (過濾純數字、純問題數量、按鈕文字等)
   *
   * @param {string} text - 候選字串
   * @returns {boolean} 是否為有效衝刺名稱
   */
  function isValidSprintTitleCandidate(text) {
    if (!text) return false;
    const { IGNORED_BUTTON_TEXTS } = BetterJira.Constants;
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
   * 檢查某個原生 Sprint 容器是否處於風琴夾收合狀態
   *
   * @param {Element|null} branchEl - 衝刺 branch 節點
   * @param {Element} sprintEl - 衝刺容器節點
   * @param {Element|null} headerPartner - 獨立配對標頭節點
   * @returns {boolean} 是否處於收合狀態
   */
  function isNativeSprintCollapsed(branchEl, sprintEl, headerPartner) {
    const headerCandidates = [
      headerPartner,
      branchEl && branchEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header'),
      sprintEl && sprintEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header'),
      branchEl,
      sprintEl
    ].filter(Boolean);

    for (const hdr of headerCandidates) {
      if (hdr.getAttribute('aria-expanded') === 'false') {
        return true;
      }
      const toggleBtn = hdr.querySelector(
        '[aria-expanded="false"], button[data-testid*="toggle"], button[data-testid*="expand"], [role="button"][aria-expanded="false"], button[aria-label*="展開"], button[aria-label*="Expand"]'
      );
      if (toggleBtn && !toggleBtn.hasAttribute('aria-haspopup') && !isInsideCard(toggleBtn) && !isInsideExtensionUi(toggleBtn)) {
        return true;
      }
    }
    if (sprintEl && sprintEl.classList && (sprintEl.classList.contains('ghx-closed') || sprintEl.querySelector('.ghx-closed'))) {
      return true;
    }
    if (branchEl && branchEl.classList && (branchEl.classList.contains('ghx-closed') || branchEl.querySelector('.ghx-closed'))) {
      return true;
    }
    return false;
  }

  /**
   * 僅在使用者切換衝刺時，檢查該衝刺標頭是否處於收合狀態並自動觸發展開；
   * 絕不在 MutationObserver 中自動觸發任何 click，避免誤觸「+ 建立問題」按鈕。
   *
   * @param {Element|null} branchEl - 衝刺 branch 節點
   * @param {Element} sprintEl - 衝刺容器節點
   * @param {Element|null} headerPartner - 獨立配對標頭節點
   */
  function expandSprintHeaderOnUserSelect(branchEl, sprintEl, headerPartner) {
    const { CARD_SELECTORS } = BetterJira.Constants;
    const root = branchEl || sprintEl;

    // 若該衝刺原生 DOM 內已經有可見的卡片 (排除自定義檢視內的卡片)，代表已經是展開狀態，不需點擊任何按鈕
    if (root) {
      for (const sel of CARD_SELECTORS) {
        const matched = Array.from(root.querySelectorAll(sel)).filter(
          (c) => !c.closest('[data-bjwt-custom-view]') && !c.classList.contains('bjwt-history-card')
        );
        if (matched.length > 0 && matched.some((c) => c.offsetParent !== null)) {
          return;
        }
      }
    }

    // 僅尋找衝刺標頭列 (Header) 內的風琴夾展開按鈕，嚴格排除底部新增卡片區域
    const headerCandidates = [
      headerPartner,
      branchEl && branchEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header'),
      sprintEl && sprintEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header')
    ].filter(Boolean);

    for (const hdr of headerCandidates) {
      const isCandidateBtn =
        hdr.tagName === 'BUTTON' ||
        hdr.getAttribute('role') === 'button' ||
        hdr.getAttribute('aria-expanded') === 'false';

      if (isCandidateBtn && hdr.getAttribute('aria-expanded') === 'false' && !isInsideCard(hdr)) {
        try {
          hdr.click();
        } catch {
          // ignore
        }
        return;
      }

      const toggleBtn = hdr.querySelector(
        '[aria-expanded="false"], button[data-testid*="toggle"], button[data-testid*="expand"], [role="button"][aria-expanded="false"], button[aria-label*="展開"], button[aria-label*="Expand"], .ghx-expander, .js-expander'
      );
      if (
        toggleBtn &&
        !toggleBtn.hasAttribute('aria-haspopup') &&
        !isInsideCard(toggleBtn)
      ) {
        try {
          toggleBtn.click();
        } catch {
          // ignore
        }
        return;
      }
    }

    if (sprintEl && sprintEl.classList && sprintEl.classList.contains('ghx-closed')) {
      const expander = sprintEl.querySelector('.ghx-expander, .js-expander');
      if (expander) expander.click();
    }
  }

  /**
   * 擷取衝刺的真實名稱與卡片數量 (支援讀取原生篩選後的數量，如「29 個工作項目中的 5 個」)
   *
   * @param {Element} branchEl - 衝刺在 sprintsHost 下的直接子節點
   * @param {Element} sprintEl - 衝刺容器節點
   * @param {Element|null} headerPartner - 兄弟標頭節點
   * @param {number} index - 衝刺流水序號
   * @returns {Object} 衝刺 Meta 詮釋資料結構
   */
  function extractSprintMeta(branchEl, sprintEl, headerPartner, index) {
    const { CARD_SELECTORS } = BetterJira.Constants;
    const { cleanSprintTitle } = BetterJira.TextUtils;
    const isSharedHost = (el) =>
      !el ||
      (el.getAttribute && el.getAttribute('data-bjwt-layout-host') === 'true') ||
      (el.querySelectorAll && el.querySelectorAll('[data-bjwt-sprint-branch="true"], [data-bjwt-sprint-container="true"]').length > 1);
    const parentCandidate =
      sprintEl && sprintEl.parentElement && !isSharedHost(sprintEl.parentElement)
        ? sprintEl.parentElement
        : null;
    const searchRoots = [headerPartner, branchEl, sprintEl, parentCandidate].filter(
      (r) => r && !isInsideExtensionUi(r)
    );

    let title = '';

    // 1. 優先從明確的標題 Selector 尋找 (排除卡片與擴充功能 UI 內部元素)
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
          if (isInsideCard(el) || isInsideExtensionUi(el)) continue;
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
          if (isInsideCard(inp) || isInsideExtensionUi(inp)) continue;
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
          if (!node || !(node instanceof Element) || isInsideCard(node) || isInsideExtensionUi(node)) continue;
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
            if (isInsideCard(parent) || isInsideExtensionUi(parent)) return NodeFilter.FILTER_REJECT;
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

    // 計算原生 DOM 中的真實卡片數量 (嚴格排除自定義檢視卡片、容器節點與被 Jira 篩選隱藏的卡片)
    let cardNodes = [];
    const isFilteredCard = (c, r) => {
      const { CardDomParser } = BetterJira;
      return CardDomParser && typeof CardDomParser.isDomCardFilteredOrHidden === 'function'
        ? CardDomParser.isDomCardFilteredOrHidden(c, r)
        : false;
    };

    for (const root of [branchEl, sprintEl]) {
      if (!root) continue;
      for (const cardSel of CARD_SELECTORS) {
        const foundCards = Array.from(root.querySelectorAll(cardSel)).filter(
          (c) =>
            !c.classList.contains('bjwt-history-card') &&
            !c.closest('[data-bjwt-custom-view]') &&
            !isFilteredCard(c, root)
        );
        if (foundCards.length > 0) {
          cardNodes = foundCards.filter(
            (c) => !foundCards.some((other) => other !== c && other.contains(c))
          );
          break;
        }
      }
      if (cardNodes.length > 0) break;
    }

    // 從標頭擷取文字顯示的工作項目數量 (包含篩選後「29 個工作項目中的 5 個」或「5 of 29 issues」)
    let headerFilteredCount = null;
    let headerTotalCount = null;
    for (const root of searchRoots) {
      const headerCandidates = Array.from(
        root.querySelectorAll(
          '[data-testid*="header.container"], [data-testid*="header-container"], [data-testid="software-backlog.card-list.header"], .ghx-backlog-header, header'
        )
      ).filter((el) => !isInsideCard(el) && !isInsideExtensionUi(el));
      const candidateEls = [...headerCandidates, root];
      let matchedInRoot = false;
      for (const headerEl of candidateEls) {
        if (!headerEl || isInsideExtensionUi(headerEl)) continue;
        let headerText = '';
        if (
          headerEl.querySelector &&
          headerEl.querySelector('[data-bjwt-custom-view], .bjwt-active-sprint-custom-view, #bjwt-sprint-sidebar, [data-bjwt-non-sprint-child]')
        ) {
          headerText = Array.from(headerEl.children || [])
            .filter((c) => !isInsideExtensionUi(c) && !isInsideCard(c))
            .map((c) => c.innerText || c.textContent || '')
            .join(' ')
            .replace(/\s+/g, ' ');
        } else {
          headerText = (headerEl.innerText || headerEl.textContent || '').replace(/\s+/g, ' ');
        }
        const zhSubsetMatch = headerText.match(
          /(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)\s*中的\s*(\d+)\s*個?/i
        );
        if (zhSubsetMatch) {
          headerTotalCount = parseInt(zhSubsetMatch[1], 10);
          headerFilteredCount = parseInt(zhSubsetMatch[2], 10);
          matchedInRoot = true;
          break;
        }
        const enSubsetMatch = headerText.match(
          /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)/i
        );
        if (enSubsetMatch) {
          headerFilteredCount = parseInt(enSubsetMatch[1], 10);
          headerTotalCount = parseInt(enSubsetMatch[2], 10);
          matchedInRoot = true;
          break;
        }
        const countMatch = headerText.match(
          /(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)/i
        );
        if (countMatch) {
          headerTotalCount = parseInt(countMatch[1], 10);
          matchedInRoot = true;
          break;
        }
      }
      if (matchedInRoot) break;
    }

    const isCollapsed = isNativeSprintCollapsed(branchEl, sprintEl, headerPartner);
    let cardCount = cardNodes.length;
    if (headerFilteredCount !== null) {
      cardCount = headerFilteredCount;
    } else if (cardCount === 0 && isCollapsed) {
      if (headerTotalCount !== null) {
        cardCount = headerTotalCount;
      }
    }

    // 擷取 sprintId (若 DOM 節點上有)
    let sprintId =
      sprintEl.getAttribute('data-sprint-id') ||
      branchEl.getAttribute('data-sprint-id') ||
      '';
    if (!sprintId) {
      for (const root of searchRoots) {
        const foundEls = Array.from(
          root.querySelectorAll('[data-sprint-id], [data-testid*="container-"], [data-testid*="header-"]')
        ).filter((el) => !isInsideExtensionUi(el));
        for (const foundEl of foundEls) {
          sprintId = foundEl.getAttribute('data-sprint-id') || '';
          if (!sprintId) {
            const m = (foundEl.getAttribute('data-testid') || '').match(/(\d{2,})/);
            if (m) sprintId = m[1];
          }
          if (sprintId) break;
        }
        if (sprintId) break;
      }
    }

    // 擷取原生標頭上的 Story Points (例如三個數字徽章 [26] [38] [17]，或未開始衝刺單一徽章 [33 點])
    // 嚴格排除擴充功能自建檢視 (data-bjwt-custom-view) 與側邊欄徽章，避免切換衝刺後重複加總為兩倍
    let headerStoryPoints = 0;
    const badgeSelector =
      '[data-testid*="badge"], [data-testid*="estimate"], [data-testid*="story-point"], [data-testid*="storypoint"], [data-testid*="statistic"], [class*="badge"], [class*="estimate"], [class*="statistic"], [aria-label*="estimate" i], [aria-label*="point" i], [aria-label*="點" i], [title*="estimate" i], [title*="point" i], [title*="點" i]';
    for (const root of searchRoots) {
      const headerCandidates = Array.from(
        root.querySelectorAll(
          '[data-testid*="header.container"], [data-testid*="header-container"], [data-testid="software-backlog.card-list.header"], [data-testid*="card-list.header"], .ghx-backlog-header, header'
        )
      ).filter((el) => !isInsideCard(el) && !isInsideExtensionUi(el));
      const headerContainer = headerCandidates[0] || root;
      let allBadgeNodes = Array.from(headerContainer.querySelectorAll(badgeSelector)).filter(
        (b) => !isInsideCard(b) && !isInsideExtensionUi(b)
      );
      if (allBadgeNodes.length === 0 && headerContainer !== root) {
        allBadgeNodes = Array.from(root.querySelectorAll(badgeSelector)).filter(
          (b) => !isInsideCard(b) && !isInsideExtensionUi(b)
        );
      }
      // 避免重複計算父子嵌套節點 (若節點 A 包含節點 B，僅保留內層葉節點)
      const leafBadges = allBadgeNodes.filter(
        (b) => !allBadgeNodes.some((other) => other !== b && b.contains(other))
      );

      let sum = 0;
      let count = 0;
      leafBadges.forEach((b) => {
        const rawTxt = (b.textContent || '').trim();
        const ariaTxt = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();

        // 排除純卡片數量標籤 (例如 "12 個問題" 或 "12 issues")
        if (
          /個問題|個工作項目|工作項目|issues?|cards?|items?/i.test(rawTxt) ||
          /個問題|個工作項目|工作項目|issues?|cards?|items?/i.test(ariaTxt)
        ) {
          return;
        }

        let val = null;
        const mTxt = rawTxt.match(/^(\d{1,4}(?:\.\d+)?)\s*(?:點|pts?|points?)?$/i);
        if (mTxt) {
          val = parseFloat(mTxt[1]);
        } else if (ariaTxt) {
          const mAria =
            ariaTxt.match(/(?:預估|估算|story\s*points?|estimate|points?)\s*[:：]?\s*(\d{1,4}(?:\.\d+)?)/i) ||
            ariaTxt.match(/^(\d{1,4}(?:\.\d+)?)\s*(?:點|pts?|points?)?$/i);
          if (mAria) {
            val = parseFloat(mAria[1]);
          }
        }

        if (val !== null && !isNaN(val) && val > 0) {
          sum += val;
          count++;
        }
      });

      if (count >= 1 && sum > 0) {
        headerStoryPoints = Math.round(sum * 10) / 10;
        break;
      }
    }

    const cleanedTitle = cleanSprintTitle(title);
    const key =
      sprintId ||
      sprintEl.getAttribute('data-sprint-id') ||
      branchEl.getAttribute('data-sprint-id') ||
      sprintEl.getAttribute('id') ||
      `${index}__${cleanedTitle}`;

    // 判斷此衝刺狀態 ('active' | 'future')
    let sprintState = null;
    for (const root of searchRoots) {
      if (!root) continue;
      const btns = Array.from(
        root.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')
      ).filter((b) => !isInsideCard(b) && !isInsideExtensionUi(b));
      const hasComplete = btns.some((b) => {
        const txt = (b.textContent || b.value || '').trim();
        const testid = b.getAttribute('data-testid') || '';
        const aria = b.getAttribute('aria-label') || '';
        return (
          /完成衝刺|complete sprint/i.test(txt) ||
          /complete-sprint/i.test(testid) ||
          /完成衝刺|complete sprint/i.test(aria)
        );
      });
      if (hasComplete) {
        sprintState = 'active';
        break;
      }
      const hasStart = btns.some((b) => {
        const txt = (b.textContent || b.value || '').trim();
        const testid = b.getAttribute('data-testid') || '';
        const aria = b.getAttribute('aria-label') || '';
        return (
          /開始衝刺|start sprint/i.test(txt) ||
          /start-sprint/i.test(testid) ||
          /開始衝刺|start sprint/i.test(aria)
        );
      });
      if (hasStart) {
        sprintState = 'future';
        break;
      }
    }

    if (!sprintState) {
      for (const root of searchRoots) {
        if (!root) continue;
        if (
          root.matches && (
            root.matches('.ghx-sprint-active, [data-testid*="active-sprint"]') ||
            root.querySelector('.ghx-sprint-active, [data-testid*="active-sprint"]')
          )
        ) {
          sprintState = 'active';
          break;
        }
        if (
          root.matches && (
            root.matches('.ghx-sprint-planned, .ghx-sprint-future, [data-testid*="future-sprint"], [data-testid*="planned-sprint"]') ||
            root.querySelector('.ghx-sprint-planned, .ghx-sprint-future, [data-testid*="future-sprint"], [data-testid*="planned-sprint"]')
          )
        ) {
          sprintState = 'future';
          break;
        }
      }
    }

    if (!sprintState) {
      const { IssueStore } = BetterJira;
      const boardSprints = IssueStore && typeof IssueStore.getBoardSprints === 'function' ? IssueStore.getBoardSprints() : null;
      if (Array.isArray(boardSprints) && boardSprints.length > 0) {
        const found = boardSprints.find((s) => {
          if (sprintId && String(s.id) === String(sprintId)) return true;
          const sTitle = cleanSprintTitle(s.name || '');
          return sTitle && sTitle.toLowerCase() === cleanedTitle.toLowerCase();
        });
        if (found && (found.state === 'active' || found.state === 'future')) {
          sprintState = found.state;
        }
      }
    }

    if (!sprintState && /backlog|待辦池|待辦事項/i.test(cleanedTitle)) {
      sprintState = 'future';
    }

    if (!sprintState) {
      sprintState = index === 0 ? 'active' : 'future';
    }

    return {
      key,
      sprintId,
      index,
      title: cleanedTitle,
      rawTitle: title,
      sprintState,
      domCardCount: cardNodes.length,
      headerFilteredCount,
      headerTotalCount,
      isCollapsed,
      cardCount,
      headerStoryPoints,
      storyPoints: headerStoryPoints
    };
  }

  BetterJira.SprintDomParser = {
    isInsideExtensionUi,
    isInsideCard,
    findSprintContainers,
    isValidSprintTitleCandidate,
    isNativeSprintCollapsed,
    expandSprintHeaderOnUserSelect,
    extractSprintMeta
  };
})();
