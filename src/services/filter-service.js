/**
 * @fileoverview Jira 原生待辦事項篩選與搜尋狀態同步服務
 * 偵測 Jira 原生搜尋框、經辦人頭像按鈕選取狀態、「篩選條件」與「自訂篩選條件」下拉與彈出選單，
 * 並即時同步套用至左右兩欄卡片清單與統計數字。
 * @module services/filter-service
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 持久化篩選狀態存儲 (Persistent Filter Store)
   * 解決 Jira React 動態卸載 (unmount) 下拉選單導致勾選條件遺失的問題。
   * 當使用者在「篩選條件」或「自訂篩選條件」勾選後關閉選單，此存儲保留勾選條件，
   * 直到使用者主動取消、點擊「清除所有篩選條件」或按鈕狀態恢復未選中為止。
   */
  const persistentFilterStore = {
    customFilters: new Set(),
    types: new Set(),
    epics: new Set(),
    statuses: new Set(),
    labels: new Set(),
    isCustomFilterActive: false,
    isFilterActive: false,
    lastKnownCustomBadge: 0,
    lastKnownFilterBadge: 0
  };

  /**
   * 重設所有持久化篩選條件
   */
  function resetPersistentFilters() {
    persistentFilterStore.customFilters.clear();
    persistentFilterStore.types.clear();
    persistentFilterStore.epics.clear();
    persistentFilterStore.statuses.clear();
    persistentFilterStore.labels.clear();
    persistentFilterStore.isCustomFilterActive = false;
    persistentFilterStore.isFilterActive = false;
    persistentFilterStore.lastKnownCustomBadge = 0;
    persistentFilterStore.lastKnownFilterBadge = 0;
  }

  /**
   * 檢查元素是否處於「已選取 (Pressed / Selected / Checked / Active)」狀態
   *
   * @param {Element} btn - 目標 DOM 元素
   * @returns {boolean} 是否選取
   */
  function isElementSelected(btn) {
    if (!btn || typeof btn.getAttribute !== 'function') return false;

    // 1. 若元素自身明確宣告為未選取 / 未按下，絕對排除
    const ariaPressed = btn.getAttribute('aria-pressed');
    const ariaChecked = btn.getAttribute('aria-checked');
    const ariaSelected = btn.getAttribute('aria-selected');
    const dataState = btn.getAttribute('data-state');
    const dataSelected = btn.getAttribute('data-selected');

    if (
      ariaPressed === 'false' ||
      ariaChecked === 'false' ||
      ariaSelected === 'false' ||
      dataState === 'unselected' ||
      dataState === 'inactive' ||
      dataSelected === 'false'
    ) {
      return false;
    }

    // 若有內部 checkbox/radio 且未打勾，明確排除
    const innerInput = btn.querySelector('input[type="checkbox"], input[type="radio"]');
    if (innerInput && !innerInput.checked && !innerInput.hasAttribute('checked')) {
      return false;
    }

    // 2. 檢查明確的肯定選取標記
    // a. 標準 ARIA 屬性
    if (
      ariaPressed === 'true' ||
      ariaChecked === 'true' ||
      ariaSelected === 'true' ||
      dataState === 'selected' ||
      dataState === 'active' ||
      dataSelected === 'true'
    ) {
      return true;
    }

    // b. 檢查按鈕內部是否包含已勾選的 input
    if (innerInput && (innerInput.checked || innerInput.hasAttribute('checked'))) {
      return true;
    }

    // c. 檢查子節點帶有明確選取狀態
    const pressedDescendant = btn.querySelector(
      '[aria-pressed="true"], [aria-checked="true"], [data-state="selected"], [data-selected="true"]'
    );
    if (pressedDescendant) {
      return true;
    }

    // d. 檢查自身 class (is-selected, ghx-active, active, is-active 等)
    const ownCls = typeof btn.className === 'string' ? btn.className : '';
    if (
      /(?:^|[\s_-])(?:is-selected|is-checked|isSelected|isChecked|ghx-active|active|is-active)(?:$|[\s_-])/.test(ownCls) &&
      !/(?:not-selected|unselected|inactive)/i.test(ownCls)
    ) {
      return true;
    }

    // e. 檢查螢幕報讀文字 (ScreenReader)
    const srTexts = Array.from(
      btn.querySelectorAll('[class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], [hidden]')
    )
      .map((e) => e.textContent || '')
      .join(' ')
      .trim();
    if (
      srTexts &&
      /(?:已選取|選取已啟用|已選中|currently\s+selected)/i.test(srTexts) &&
      !/(?:未選取|未選中|not\s+selected|unselected)/i.test(srTexts)
    ) {
      return true;
    }

    return false;
  }

  /**
   * 嘗試取得目前 Jira 登入使用者的姓名或縮寫
   * 用於「Only My Issues」或「我的待辦事項」等自訂篩選條件
   *
   * @returns {Object|null} 使用者物件 { name, initials, avatarSrc }
   */
  function getCurrentJiraUser() {
    if (typeof window !== 'undefined' && window.__bjwt_currentUser) {
      return window.__bjwt_currentUser;
    }
    if (typeof document === 'undefined') return null;

    const profileSelectors = [
      '[data-testid="atlassian-navigation--profile"]',
      '[data-testid*="profile-button"]',
      'button[data-testid*="profile"]',
      '#profile-button',
      'header [role="banner"] [aria-label*="profile" i]',
      'header [role="banner"] [aria-label*="帳戶" i]',
      'header [role="banner"] [aria-label*="個人" i]'
    ];

    for (const sel of profileSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const txt = (el.textContent || '').trim();
        const m = (aria + ' ' + title).match(/(?:profile|account|帳戶|個人資料|使用者)[:：\s]*([^\(,\.]+)/i);
        const name = m ? m[1].trim() : (txt || aria || title);
        const img = el.querySelector('img[src]');
        const avatarSrc = img ? img.src : '';
        if (name) {
          const u = { name, initials: txt && txt.length <= 4 ? txt : '', avatarSrc };
          if (typeof window !== 'undefined') window.__bjwt_currentUser = u;
          return u;
        }
      }
    }
    return null;
  }

  /**
   * 主動掃描畫面上任何開啟中的彈出選單 (Popup / Dialog / Menu / Dropdown)，
   * 即時提取使用者勾選的項目並持久化存入 persistentFilterStore。
   *
   * @returns {boolean} 是否有偵測到開啟且含有勾選項的選單
   */
  function syncFromOpenPopups() {
    if (typeof document === 'undefined') return false;

    const { Constants } = BetterJira;
    const SIDEBAR_ID = Constants ? Constants.SIDEBAR_ID : 'bjwt-sprint-sidebar';
    const HISTORY_PICKER_MODAL_ID = Constants ? Constants.HISTORY_PICKER_MODAL_ID : 'bjwt-history-picker-modal';
    const HISTORY_ISSUE_MODAL_ID = Constants ? Constants.HISTORY_ISSUE_MODAL_ID : 'bjwt-historical-issue-modal';

    const popups = Array.from(
      document.querySelectorAll(
        '[role="dialog"], [role="menu"], [role="listbox"], [data-testid*="popup"], [data-testid*="dropdown"], [data-testid*="quickfilter"], [data-testid*="custom-filter"], [class*="atlaskit-portal"]'
      )
    ).filter((p) => {
      if (!p) return false;
      if (
        p.id === HISTORY_PICKER_MODAL_ID ||
        p.id === HISTORY_ISSUE_MODAL_ID ||
        p.hasAttribute('data-bjwt-issue-modal') ||
        p.closest(`#${SIDEBAR_ID}`) ||
        p.closest('[data-bjwt-sprint-branch]')
      ) {
        return false;
      }
      if (p.closest('header[role="banner"]') || p.querySelector('[data-testid="atlassian-navigation"]')) {
        return false;
      }
      return true;
    });

    if (popups.length === 0) return false;

    let anyUpdated = false;

    for (const popup of popups) {
      const popupText = (popup.textContent || '').replace(/\s+/g, ' ').toLowerCase();
      const popupAria = (popup.getAttribute('aria-label') || '').toLowerCase();
      const popupTestId = (popup.getAttribute('data-testid') || '').toLowerCase();
      const popupHeader = (popupText.slice(0, 150) + ' ' + popupAria + ' ' + popupTestId).toLowerCase();

      // 判斷選單所屬維度：檢查是否為包含多個維度分組的通用「篩選條件」面板
      const hasMultipleSections =
        (/類型|type|issuetype/.test(popupText) ? 1 : 0) +
        (/狀態|status/.test(popupText) ? 1 : 0) +
        (/史詩|epic|parent/.test(popupText) ? 1 : 0) +
        (/標籤|label/.test(popupText) ? 1 : 0) >= 2;

      const isCustomFilterMenu = /自訂篩選|自訂|custom[\s_-]*filter|quick[\s_-]*filter|快速篩選/.test(popupHeader);
      const isGeneralFilterMenu =
        !isCustomFilterMenu &&
        (hasMultipleSections ||
          /^(?:篩選條件|filters?|board[\s_-]*filter)$/i.test(popupAria) ||
          /board[\s_-]*filter|backlog[\s_-]*filter/i.test(popupTestId));

      const isTypeMenu = !isCustomFilterMenu && !isGeneralFilterMenu && /工作項目類型|類型|issuetype|issue[\s_-]*type/.test(popupHeader);
      const isStatusMenu = !isCustomFilterMenu && !isGeneralFilterMenu && /狀態|status/.test(popupHeader);
      const isEpicMenu = !isCustomFilterMenu && !isGeneralFilterMenu && /史詩|epic|parent/.test(popupHeader);
      const isLabelMenu = !isCustomFilterMenu && !isGeneralFilterMenu && /標籤|label/.test(popupHeader);

      // 尋找選單內所有可供勾選的選項
      const allOptions = Array.from(
        popup.querySelectorAll(
          '[role="menuitemcheckbox"], [role="checkbox"], [role="option"], [role="menuitem"], label, button, input[type="checkbox"]'
        )
      );

      const checkedNodes = allOptions.filter((opt) => {
        if (opt.tagName !== 'INPUT' && opt.querySelector('input[type="checkbox"]')) {
          const inp = opt.querySelector('input[type="checkbox"]');
          return inp.checked || inp.hasAttribute('checked') || isElementSelected(inp);
        }
        return isElementSelected(opt);
      });

      if (isCustomFilterMenu) {
        if (allOptions.length > 0) {
          if (checkedNodes.length > 0) {
            persistentFilterStore.customFilters.clear();
            checkedNodes.forEach((node) => {
              const raw = (node.textContent || node.value || node.getAttribute('aria-label') || '').trim();
              const cleaned = raw.replace(/\s+/g, ' ').trim();
              if (cleaned && !/^(?:自訂篩選條件|快速篩選|custom\s+filters?)$/i.test(cleaned)) {
                persistentFilterStore.customFilters.add(cleaned);
                anyUpdated = true;
              }
            });
            persistentFilterStore.isCustomFilterActive = persistentFilterStore.customFilters.size > 0;
          } else {
            // 選單有選項但 0 個被勾選，代表使用者已取消全部自訂篩選
            persistentFilterStore.customFilters.clear();
            persistentFilterStore.isCustomFilterActive = false;
            anyUpdated = true;
          }
        }
      } else if (isTypeMenu) {
        if (allOptions.length > 0) {
          persistentFilterStore.types.clear();
          checkedNodes.forEach((node) => {
            const raw = (node.textContent || node.value || node.getAttribute('aria-label') || '').trim();
            if (raw) {
              persistentFilterStore.types.add(raw.toLowerCase());
              anyUpdated = true;
            }
          });
        }
      } else if (isStatusMenu) {
        if (allOptions.length > 0) {
          persistentFilterStore.statuses.clear();
          checkedNodes.forEach((node) => {
            const raw = (node.textContent || node.value || node.getAttribute('aria-label') || '').trim();
            if (raw) {
              persistentFilterStore.statuses.add(raw.toLowerCase());
              anyUpdated = true;
            }
          });
        }
      } else if (isEpicMenu) {
        if (allOptions.length > 0) {
          persistentFilterStore.epics.clear();
          checkedNodes.forEach((node) => {
            const raw = (node.textContent || node.value || node.getAttribute('aria-label') || '').trim();
            if (raw) {
              persistentFilterStore.epics.add(raw.toLowerCase());
              anyUpdated = true;
            }
          });
        }
      } else if (isLabelMenu) {
        if (allOptions.length > 0) {
          persistentFilterStore.labels.clear();
          checkedNodes.forEach((node) => {
            const raw = (node.textContent || node.value || node.getAttribute('aria-label') || '').trim();
            if (raw) {
              persistentFilterStore.labels.add(raw.toLowerCase());
              anyUpdated = true;
            }
          });
        }
      } else {
        // 通用「篩選條件」彈出面板（內含多個分組）
        if (checkedNodes.length > 0) {
          checkedNodes.forEach((node) => {
            const raw = (node.textContent || node.value || node.getAttribute('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim();
            if (!raw || /^(?:篩選條件|filters?|重設|清除|clear|reset)$/i.test(raw)) return;

            // 尋找其分組標題
            let groupHeading = '';
            let p = node.parentElement;
            for (let i = 0; i < 4 && p && p !== popup; i++) {
              const h = p.querySelector('h1, h2, h3, h4, h5, [role="heading"], [class*="heading"], [class*="title"], [data-testid*="heading"]');
              if (h && h !== node) {
                groupHeading = (h.textContent || '').toLowerCase();
                break;
              }
              p = p.parentElement;
            }

            if (/類型|type|issuetype/.test(groupHeading)) {
              persistentFilterStore.types.add(raw.toLowerCase());
            } else if (/狀態|status/.test(groupHeading)) {
              persistentFilterStore.statuses.add(raw.toLowerCase());
            } else if (/史詩|epic/.test(groupHeading)) {
              persistentFilterStore.epics.add(raw.toLowerCase());
            } else if (/標籤|label/.test(groupHeading)) {
              persistentFilterStore.labels.add(raw.toLowerCase());
            } else {
              if (/^(?:bug|story|task|epic|sub-task|缺陷|故事|任務|子任務)$/i.test(raw)) {
                persistentFilterStore.types.add(raw.toLowerCase());
              } else if (/^(?:待辦事項|進行中|已完成|done|in progress|to do|testing|verify)$/i.test(raw)) {
                persistentFilterStore.statuses.add(raw.toLowerCase());
              } else {
                persistentFilterStore.customFilters.add(raw);
              }
            }
            anyUpdated = true;
          });
          persistentFilterStore.isFilterActive = true;
        }
      }
    }

    return anyUpdated;
  }

  /**
   * 偵測 Jira 原生篩選搜尋區 (搜尋框、人員頭像篩選、未指派篩選、篩選條件、自訂篩選條件等) 的目前狀態
   *
   * @returns {Object} 篩選狀態結構
   */
  function getNativeBacklogFilterState() {
    const { Constants, AssigneeUtils } = BetterJira;
    const SIDEBAR_ID = Constants ? Constants.SIDEBAR_ID : 'bjwt-sprint-sidebar';
    const HISTORY_PICKER_MODAL_ID = Constants ? Constants.HISTORY_PICKER_MODAL_ID : 'bjwt-history-picker-modal';
    const HISTORY_ISSUE_MODAL_ID = Constants ? Constants.HISTORY_ISSUE_MODAL_ID : 'bjwt-historical-issue-modal';

    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants, normalizeAvatarUrl } = AssigneeUtils || {
      cleanAssigneeLabel: (s) => (s || '').trim(),
      isUnassignedText: (s) => /未指派|unassigned/i.test(s || ''),
      deriveInitialsVariants: () => [],
      normalizeAvatarUrl: (s) => s || ''
    };

    // 每次偵測時先主動掃描是否有開啟中的選單並同步至 persistentFilterStore
    syncFromOpenPopups();

    const state = {
      searchKeyword: '',
      includeUnassigned: false,
      selectedAssignees: [],
      selectedQuickFilters: [],
      selectedTypes: [],
      selectedEpics: [],
      selectedLabels: [],
      selectedStatuses: [],
      isCustomFilterBtnActive: false,
      isFilterBtnActive: false,
      hasClearFilterBtn: false,
      hasHeaderFilteredCount: false,
      hasDirectFilter: false,
      isFiltered: false,
      sig: ''
    };

    // 1. 檢查原生「搜尋待辦事項」輸入框
    const searchInputs = Array.from(
      document.querySelectorAll(
        'input[data-testid*="search"], input[placeholder*="搜尋"], input[placeholder*="Search"], input[aria-label*="搜尋"], input[aria-label*="Search"], [role="search"] input, [data-testid*="filter"] input[type="text"], [data-testid*="filter"] input[type="search"]'
      )
    ).filter(
      (inp) =>
        !inp.closest(`#${SIDEBAR_ID}`) &&
        !inp.closest('[data-bjwt-sprint-branch]') &&
        !inp.closest(`#${HISTORY_PICKER_MODAL_ID}`) &&
        !inp.closest(`#${HISTORY_ISSUE_MODAL_ID}`) &&
        !inp.closest('[data-bjwt-issue-modal]') &&
        !inp.closest('header[role="banner"], [data-testid="atlassian-navigation"]') &&
        !inp.classList.contains('bjwt-history-card-filter')
    );

    for (const inp of searchInputs) {
      const val = (inp.value || '').trim();
      if (val) {
        state.searchKeyword = val.toLowerCase();
        break;
      }
    }

    // 檢查網址參數 (text, quickFilter, epics, issueType, labels, status)
    try {
      if (typeof window !== 'undefined' && window.location && window.location.href) {
        const url = new URL(window.location.href);
        if (!state.searchKeyword) {
          const urlText = url.searchParams.get('text') || url.searchParams.get('search') || '';
          if (urlText.trim()) {
            state.searchKeyword = urlText.trim().toLowerCase();
          }
        }
        const qf = url.searchParams.get('quickFilter');
        if (qf) {
          qf.split(',').forEach((q) => {
            const s = q.trim();
            if (s && !state.selectedQuickFilters.includes(s)) state.selectedQuickFilters.push(s);
          });
        }
        const epics = url.searchParams.get('epics') || url.searchParams.get('epic');
        if (epics) {
          epics.split(',').forEach((e) => {
            const s = e.trim().toLowerCase();
            if (s && !state.selectedEpics.includes(s)) state.selectedEpics.push(s);
          });
        }
        const it = url.searchParams.get('issueType') || url.searchParams.get('issuetype') || url.searchParams.get('type');
        if (it) {
          it.split(',').forEach((t) => {
            const s = t.trim().toLowerCase();
            if (s && !state.selectedTypes.includes(s)) state.selectedTypes.push(s);
          });
        }
        const lb = url.searchParams.get('labels') || url.searchParams.get('label');
        if (lb) {
          lb.split(',').forEach((l) => {
            const s = l.trim().toLowerCase();
            if (s && !state.selectedLabels.includes(s)) state.selectedLabels.push(s);
          });
        }
        const st = url.searchParams.get('status') || url.searchParams.get('statuses');
        if (st) {
          st.split(',').forEach((s) => {
            const val = s.trim().toLowerCase();
            if (val && !state.selectedStatuses.includes(val)) state.selectedStatuses.push(val);
          });
        }
      }
    } catch {
      // ignore
    }

    // 2. 尋找原生篩選列候選根容器 (搜尋列、篩選工具列、人員頭像、下拉選單按鈕、快速篩選)
    const filterRootCandidates = new Set();
    searchInputs.forEach((inp) => {
      let curr = inp.parentElement;
      for (let i = 0; i < 5 && curr && curr !== document.body; i++) {
        if (!curr.querySelector('[data-bjwt-layout-host="true"]')) {
          filterRootCandidates.add(curr);
        }
        curr = curr.parentElement;
      }
    });

    document
      .querySelectorAll(
        '[data-testid*="assignee-filter"], [data-testid*="ak-avatar"], [data-testid*="avatar-group"], [data-testid*="backlog-filter"], [data-testid*="filters"], [data-testid*="filter-bar"], [data-testid*="quickfilter"], [data-testid*="quick-filters"], [data-testid*="custom-filter"], [data-testid*="board-filter"], .ghx-controls-filters, #ghx-quick-filters, [data-testid*="epic-panel"], #ghx-epic-column'
      )
      .forEach((el) => {
        if (
          !el.closest(`#${SIDEBAR_ID}`) &&
          !el.closest('[data-bjwt-sprint-branch]') &&
          !el.closest('[data-bjwt-sprint-header-partner]') &&
          !el.closest(`#${HISTORY_PICKER_MODAL_ID}`) &&
          !el.closest(`#${HISTORY_ISSUE_MODAL_ID}`) &&
          !el.closest('[data-bjwt-issue-modal]') &&
          !el.closest('header[role="banner"], [data-testid="atlassian-navigation"]')
        ) {
          filterRootCandidates.add(el);
        }
      });

    const candidateAssigneeButtons = [];
    const seenEls = new Set();

    filterRootCandidates.forEach((root) => {
      const items = [
        root,
        ...Array.from(
          root.querySelectorAll
            ? root.querySelectorAll(
                'button, [role="checkbox"], [role="menuitemcheckbox"], [role="option"], [role="button"], a.ghx-active, label'
              )
            : []
        )
      ];
      items.forEach((el) => {
        if (seenEls.has(el)) return;
        if (
          el.closest(`#${SIDEBAR_ID}`) ||
          el.closest('[data-bjwt-sprint-branch]') ||
          el.closest('[data-bjwt-sprint-header-partner]') ||
          el.closest(`#${HISTORY_PICKER_MODAL_ID}`) ||
          el.closest(`#${HISTORY_ISSUE_MODAL_ID}`) ||
          el.closest('[data-bjwt-issue-modal]') ||
          el.closest('header[role="banner"], [data-testid="atlassian-navigation"]')
        ) {
          return;
        }
        // 排除包含其他 button 的外層大容器
        if (el.tagName !== 'BUTTON' && el.querySelector('button, [role="checkbox"]')) {
          return;
        }

        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        // 排除「+11」展開更多按鈕
        if (/^\+\d+$/.test(txt)) return;

        // 檢查是否為「清除篩選條件」按鈕
        if (
          /^(?:清除所有篩選條件|清除篩選|清除|重設|clear\s+all(?:\s+filters?)?|clear\s+filters?|reset\s+filters?)$/i.test(txt) ||
          /clear-all|reset-filter|clear-filters/i.test(el.getAttribute('data-testid') || '')
        ) {
          seenEls.add(el);
          if (el.offsetParent !== null || (el.style && el.style.display !== 'none')) {
            state.hasClearFilterBtn = true;
          }
          return;
        }

        // 排除非篩選的視圖功能按鈕
        if (/^(?:檢視設定|深入分析|view\s+settings|insights?)$/i.test(txt)) {
          return;
        }

        seenEls.add(el);

        const isAvatarLike = Boolean(
          (el.matches && el.matches('[data-testid*="assignee"], [data-testid*="avatar"], [ role="checkbox" ], [ role="menuitemcheckbox" ]')) ||
            (el.closest && el.closest('[data-testid*="assignee"], [data-testid*="avatar-group"]')) ||
            (el.querySelector && el.querySelector('[data-testid*="avatar"], [class*="Avatar"], [class*="avatar"], img[src*="avatar"], [role="img"], svg, input[type="checkbox"]'))
        );

        if (isAvatarLike) {
          if (isElementSelected(el)) {
            candidateAssigneeButtons.push(el);
          }
          return;
        }

        const testId = (el.getAttribute('data-testid') || '').toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        const isSelected = isElementSelected(el);
        const combinedText = (txt + ' ' + ariaLabel + ' ' + testId).toLowerCase();

        // 檢查是否包含徽章或數量 (例: "自訂篩選條件 (1)", "篩選條件 · 2", "Type: 1")
        const badgeEl = el.querySelector('[data-testid*="badge"], [class*="Badge"], span');
        let badgeCount = 0;
        const countMatch = combinedText.match(/(?:[(·\s]|^)(\d+)[)]?$/) || txt.match(/\b(\d+)\b/);
        if (countMatch) {
          badgeCount = parseInt(countMatch[1], 10);
        } else if (badgeEl) {
          const bTxt = (badgeEl.textContent || '').trim();
          if (/^\d+$/.test(bTxt)) {
            badgeCount = parseInt(bTxt, 10);
          }
        }

        // A. 判斷是否為「自訂篩選條件 (Custom Filters)」按鈕
        const isCustomFilterBtn = /自訂篩選|custom[\s_-]*filter|quick[\s_-]*filter|快速篩選/.test(combinedText);
        if (isCustomFilterBtn) {
          const isActive = isSelected || badgeCount > 0;
          if (isActive) {
            state.isCustomFilterBtnActive = true;
            persistentFilterStore.isCustomFilterActive = true;
            persistentFilterStore.lastKnownCustomBadge = badgeCount || 1;
          } else {
            const ariaPressed = el.getAttribute('aria-pressed');
            if (ariaPressed === 'false' && badgeCount === 0) {
              persistentFilterStore.customFilters.clear();
              persistentFilterStore.isCustomFilterActive = false;
              persistentFilterStore.lastKnownCustomBadge = 0;
            }
          }
          return;
        }

        // B. 判斷是否為「篩選條件 (Filters)」原生主按鈕
        const isGeneralFilterBtn =
          !isCustomFilterBtn &&
          (/^(?:☰\s*)?(?:篩選條件|篩選|filters?)(?:\s*[(·]?\s*\d+\s*[)]?)?$/i.test(txt) ||
            /(?:backlog[\s_-]*filter|board[\s_-]*filter|filter[\s_-]*button)/i.test(testId));
        if (isGeneralFilterBtn) {
          const isActive = isSelected || badgeCount > 0;
          if (isActive) {
            state.isFilterBtnActive = true;
            persistentFilterStore.isFilterActive = true;
            persistentFilterStore.lastKnownFilterBadge = badgeCount || 1;
          } else {
            const ariaPressed = el.getAttribute('aria-pressed');
            if (ariaPressed === 'false' && badgeCount === 0) {
              persistentFilterStore.types.clear();
              persistentFilterStore.statuses.clear();
              persistentFilterStore.epics.clear();
              persistentFilterStore.labels.clear();
              persistentFilterStore.isFilterActive = false;
              persistentFilterStore.lastKnownFilterBadge = 0;
            }
          }
          return;
        }

        // C. 各維度獨立篩選按鈕 (Type, Epic, Label, Status, QuickFilter 按鈕)
        const lowerTxt = txt.toLowerCase();
        if (isSelected || badgeCount > 0) {
          if (/類型|type|issuetype/.test(combinedText)) {
            const m = txt.match(/(?:類型|Type|Issue\s*type)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedTypes.includes(val)) state.selectedTypes.push(val);
          } else if (/史詩|epic/.test(combinedText)) {
            const m = txt.match(/(?:史詩|Epic)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedEpics.includes(val)) state.selectedEpics.push(val);
          } else if (/標籤|label/.test(combinedText)) {
            const m = txt.match(/(?:標籤|Label)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedLabels.includes(val)) state.selectedLabels.push(val);
          } else if (/狀態|status/.test(combinedText)) {
            const m = txt.match(/(?:狀態|Status)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedStatuses.includes(val)) state.selectedStatuses.push(val);
          } else if (txt && !/^(?:更多|more)$/i.test(txt)) {
            if (!state.selectedQuickFilters.includes(txt)) {
              state.selectedQuickFilters.push(txt);
            }
          }
        }
      });
    });

    // 將持久化存儲中的篩選條件合併至當前篩選狀態
    if (state.isCustomFilterBtnActive || persistentFilterStore.isCustomFilterActive) {
      if (persistentFilterStore.customFilters.size > 0) {
        persistentFilterStore.customFilters.forEach((q) => {
          if (!state.selectedQuickFilters.includes(q)) state.selectedQuickFilters.push(q);
        });
      } else {
        // 自訂篩選按鈕被啟動，但選單關閉後未能捕捉具體條件名
        state.selectedQuickFilters.push('__custom_filter_active__');
      }
    }

    if (state.isFilterBtnActive || persistentFilterStore.isFilterActive) {
      persistentFilterStore.types.forEach((t) => {
        if (!state.selectedTypes.includes(t)) state.selectedTypes.push(t);
      });
      persistentFilterStore.statuses.forEach((s) => {
        if (!state.selectedStatuses.includes(s)) state.selectedStatuses.push(s);
      });
      persistentFilterStore.epics.forEach((e) => {
        if (!state.selectedEpics.includes(e)) state.selectedEpics.push(e);
      });
      persistentFilterStore.labels.forEach((l) => {
        if (!state.selectedLabels.includes(l)) state.selectedLabels.push(l);
      });
      persistentFilterStore.customFilters.forEach((q) => {
        if (!state.selectedQuickFilters.includes(q)) state.selectedQuickFilters.push(q);
      });
      if (
        state.selectedTypes.length === 0 &&
        state.selectedStatuses.length === 0 &&
        state.selectedEpics.length === 0 &&
        state.selectedLabels.length === 0 &&
        state.selectedQuickFilters.length === 0
      ) {
        state.selectedTypes.push('__filter_btn_active__');
      }
    }

    // 檢查衝刺標頭是否顯示原生篩選計數 (如「29 個工作項目中的 5 個」或「5 of 29 issues」)
    const headers = Array.from(
      document.querySelectorAll('[data-testid*="header"], .ghx-backlog-header, header')
    );
    for (const hdr of headers) {
      if (hdr.closest(`#${SIDEBAR_ID}`) || hdr.closest('[data-bjwt-custom-view]')) continue;
      const t = hdr.innerText || hdr.textContent || '';
      if (
        /(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)\s*中的\s*(\d+)/i.test(t) ||
        /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)/i.test(t)
      ) {
        state.hasHeaderFilteredCount = true;
        break;
      }
    }

    if (!state.hasClearFilterBtn) {
      const clearBtn = Array.from(document.querySelectorAll('button, a')).find((b) => {
        if (b.closest(`#${SIDEBAR_ID}`) || b.closest('[data-bjwt-sprint-branch]')) return false;
        const txt = (b.textContent || '').trim();
        const testid = b.getAttribute('data-testid') || '';
        const aria = b.getAttribute('aria-label') || '';
        return (
          /^(?:清除所有篩選條件|清除篩選|清除|重設|clear\s+all(?:\s+filters?)?|clear\s+filters?|reset\s+filters?)$/i.test(txt) ||
          /clear-all|reset-filter|clear-filters/i.test(testid) ||
          /clear\s+filters?|清除篩選/i.test(aria)
        );
      });
      if (clearBtn && (clearBtn.offsetParent !== null || (clearBtn.style && clearBtn.style.display !== 'none'))) {
        state.hasClearFilterBtn = true;
      }
    }

    // 解析每個已選取人員按鈕的代表名稱、縮寫與頭像
    candidateAssigneeButtons.forEach((btn) => {
      const rawLabels = [];
      const attrNodes = [
        btn,
        ...Array.from(btn.querySelectorAll('[aria-label], [title], img[alt], img[title], [class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], [hidden]'))
      ].filter(Boolean);

      attrNodes.forEach((n) => {
        if (n.getAttribute) {
          const al = n.getAttribute('aria-label');
          const ti = n.getAttribute('title');
          const alt = n.getAttribute('alt');
          if (al) rawLabels.push(al);
          if (ti) rawLabels.push(ti);
          if (alt) rawLabels.push(alt);
        }
      });

      btn
        .querySelectorAll('[class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], [hidden]')
        .forEach((sr) => {
          const t = (sr.textContent || '').trim();
          if (t) rawLabels.push(t);
        });

      const clone = btn.cloneNode(true);
      clone
        .querySelectorAll(
          'svg, style, script, [aria-hidden="true"], [class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], [hidden]'
        )
        .forEach((e) => e.remove());
      const visibleText = (clone.textContent || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const cleanedNames = Array.from(
        new Set(
          rawLabels
            .map(cleanAssigneeLabel)
            .filter((s) => s && !/^(?:已選取|未選取|selected|unselected)$/i.test(s))
        )
      );

      const img = btn.querySelector('img[src]');
      const avatarSrc = img && img.src ? normalizeAvatarUrl(img.src) : '';

      // 判斷是否為「未指派」按鈕
      const isUnassignedBtn =
        cleanedNames.some(isUnassignedText) ||
        isUnassignedText(visibleText) ||
        (!visibleText && !avatarSrc && cleanedNames.length === 0 && Boolean(btn.querySelector('svg')));

      if (isUnassignedBtn) {
        state.includeUnassigned = true;
        return;
      }

      let initials = '';
      if (visibleText && visibleText.length <= 6 && !/\s/.test(visibleText)) {
        initials = visibleText.toUpperCase();
      } else if (visibleText && !cleanedNames.includes(visibleText)) {
        cleanedNames.push(cleanAssigneeLabel(visibleText));
      }

      const tokens = new Set();
      if (initials) {
        tokens.add(initials.toLowerCase());
      }
      cleanedNames.forEach((name) => {
        const lower = name.toLowerCase();
        tokens.add(lower);
        deriveInitialsVariants(name, initials).forEach((v) => tokens.add(v.toLowerCase()));
      });

      state.selectedAssignees.push({
        initials: initials.toLowerCase(),
        cleanedNames: cleanedNames.map((n) => n.toLowerCase()),
        tokens: Array.from(tokens),
        avatarSrc
      });
    });

    state.hasDirectFilter = Boolean(
      state.searchKeyword ||
      state.includeUnassigned ||
      state.selectedAssignees.length > 0 ||
      state.selectedQuickFilters.length > 0 ||
      state.selectedTypes.length > 0 ||
      state.selectedEpics.length > 0 ||
      state.selectedLabels.length > 0 ||
      state.selectedStatuses.length > 0 ||
      state.isCustomFilterBtnActive ||
      state.isFilterBtnActive ||
      persistentFilterStore.isCustomFilterActive ||
      persistentFilterStore.isFilterActive ||
      state.hasClearFilterBtn ||
      state.hasHeaderFilteredCount
    );
    state.isFiltered = state.hasDirectFilter;

    state.sig = JSON.stringify({
      kw: state.searchKeyword,
      unassigned: state.includeUnassigned,
      assignees: state.selectedAssignees.map((a) => ({
        i: a.initials,
        n: a.cleanedNames,
        av: a.avatarSrc
      })),
      qf: state.selectedQuickFilters,
      types: state.selectedTypes,
      epics: state.selectedEpics,
      labels: state.selectedLabels,
      statuses: state.selectedStatuses,
      customActive: Boolean(state.isCustomFilterBtnActive || persistentFilterStore.isCustomFilterActive),
      filterActive: Boolean(state.isFilterBtnActive || persistentFilterStore.isFilterActive),
      clearBtn: Boolean(state.hasClearFilterBtn),
      hdrFiltered: Boolean(state.hasHeaderFilteredCount)
    });

    return state;
  }

  /**
   * 判斷單張卡片是否符合選取的負責人篩選條件
   *
   * @param {Object} iss - 卡片資料物件
   * @param {Object} filterState - 篩選狀態物件
   * @returns {boolean} 是否符合負責人條件
   */
  function doesIssueMatchAssigneeFilter(iss, filterState) {
    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants, normalizeAvatarUrl } =
      BetterJira.AssigneeUtils || {
        cleanAssigneeLabel: (s) => (s || '').trim(),
        isUnassignedText: (s) => /未指派|unassigned/i.test(s || ''),
        deriveInitialsVariants: () => [],
        normalizeAvatarUrl: (s) => s || ''
      };

    if (!filterState) return true;
    const selectedAssignees = Array.isArray(filterState.selectedAssignees) ? filterState.selectedAssignees : [];

    if (!filterState.includeUnassigned && selectedAssignees.length === 0) {
      return true;
    }

    const issUnassigned = Boolean(iss.isUnassigned || isUnassignedText(iss.assigneeName));
    if (issUnassigned) {
      return Boolean(filterState.includeUnassigned);
    }

    if (selectedAssignees.length === 0) {
      return false;
    }

    const issAvatar = normalizeAvatarUrl(iss.assigneeAvatar || '');
    const issInitials = (iss.assigneeInitials || '').trim().toLowerCase();
    const issName = cleanAssigneeLabel(iss.assigneeName || '').toLowerCase();
    const issDerivedInitials = deriveInitialsVariants(iss.assigneeName, iss.assigneeInitials).map(
      (v) => v.toLowerCase()
    );
    const issTokens = new Set([
      ...(iss.assigneeTokens || []).map((t) => String(t).toLowerCase()),
      ...issDerivedInitials
    ]);
    if (issName) issTokens.add(issName);
    if (issInitials) issTokens.add(issInitials);

    return selectedAssignees.some((sel) => {
      const selInitials = (sel.initials || '').toLowerCase();
      const selCleanedNames = Array.isArray(sel.cleanedNames)
        ? sel.cleanedNames.map((n) => String(n).toLowerCase())
        : [];

      // 1. 若雙方皆有真實使用者頭像 URL 且一致
      if (sel.avatarSrc && issAvatar && sel.avatarSrc === issAvatar) {
        return true;
      }

      // 2. 若篩選按鈕與卡片皆有明確的短縮寫 (例如篩選列為 "RAY" 或 "B"，卡片上也有 "RAY" 或 "B")
      if (selInitials && issInitials) {
        if (selInitials === issInitials) {
          return true;
        }
        if (selCleanedNames.length === 0 || (selCleanedNames.length === 1 && selCleanedNames[0] === selInitials)) {
          return false;
        }
      }

      // 3. 比對完整姓名與標籤
      for (const selName of selCleanedNames) {
        if (!selName) continue;
        if (issName && issName === selName) return true;
        if (issTokens.has(selName)) return true;
        if (selName.length >= 3 && issName && (issName.includes(selName) || selName.includes(issName))) {
          return true;
        }
      }

      // 4. 若篩選按鈕只有縮寫 (如 "ray" 或 "bp")
      if (selInitials) {
        if (issTokens.has(selInitials)) {
          return true;
        }
        if (selInitials.length >= 3 && issName && issName.includes(selInitials)) {
          return true;
        }
      }

      return false;
    });
  }

  /**
   * 根據 Jira 原生篩選搜尋區狀態過濾卡片陣列
   * 支援經辦人、搜尋關鍵字、工作項目類型 (Type)、史詩/父項 (Epic)、狀態 (Status)、標籤 (Label) 與自訂/快速篩選 (Quick Filters)。
   *
   * @param {Array<Object>} issues - 待過濾卡片清單
   * @param {Object} filterState - 篩選狀態物件
   * @returns {Array<Object>} 過濾後的卡片清單
   */
  function filterIssuesByNativeFilter(issues, filterState) {
    if (!Array.isArray(issues) || issues.length === 0) return [];
    if (!filterState || (!filterState.hasDirectFilter && !filterState.isFiltered)) return issues;

    const kw = filterState.searchKeyword;
    const selectedTypes = (filterState.selectedTypes || []).map((t) => t.toLowerCase().trim()).filter((t) => t && !t.startsWith('__'));
    const selectedEpics = (filterState.selectedEpics || []).map((e) => e.toLowerCase().trim()).filter((e) => e && !e.startsWith('__'));
    const selectedStatuses = (filterState.selectedStatuses || []).map((s) => s.toLowerCase().trim()).filter((s) => s && !s.startsWith('__'));
    const selectedLabels = (filterState.selectedLabels || []).map((l) => l.toLowerCase().trim()).filter((l) => l && !l.startsWith('__'));
    const quickFilters = (filterState.selectedQuickFilters || []).map((q) => q.toLowerCase().trim()).filter(Boolean);

    return issues.filter((iss) => {
      // 1. 經辦人篩選
      if (!doesIssueMatchAssigneeFilter(iss, filterState)) {
        return false;
      }

      // 2. 搜尋關鍵字
      if (kw) {
        const haystacks = [
          iss.key,
          iss.summary,
          iss.assigneeName,
          iss.assigneeInitials,
          iss.statusName,
          iss.parentKey,
          iss.parentSummary,
          iss.issueTypeName
        ]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        if (!haystacks.some((h) => h.includes(kw))) {
          return false;
        }
      }

      // 3. 原生 DOM 卡片保護：
      // 若卡片來自原生 DOM (iss.fromDom === true 或 iss._isFromDom === true)，
      // 由於 Jira 原生在使用者操作篩選時已透過 FilteredCardIds GraphQL 查詢在後端精確過濾並更新 DOM，
      // 原生 DOM 樹上保留呈現的卡片均已通過工作項目類型 (Type)、狀態 (Status)、史詩 (Epic)、標籤 (Label)
      // 與自訂篩選 (Quick Filters / JQL) 的官方核准，絕不可在本地以不完整的 DOM 欄位進行二次字串比對而誤殺！
      if (iss.fromDom || iss._isFromDom) {
        return true;
      }

      // 4. 工作項目類型篩選 (Type - 僅對非 DOM 之 API 快取卡片執行)
      if (selectedTypes.length > 0) {
        const issType = (iss.issueTypeName || '').trim().toLowerCase();
        const matches = selectedTypes.some((t) => {
          if (!issType) return iss.summary && iss.summary.toLowerCase().includes(t);
          return issType === t || issType.includes(t) || t.includes(issType);
        });
        if (!matches) return false;
      }

      // 4. 史詩/父項篩選 (Epic / Parent)
      if (selectedEpics.length > 0) {
        const issParentKey = (iss.parentKey || '').trim().toLowerCase();
        const issParentSummary = (iss.parentSummary || '').trim().toLowerCase();
        const issEpic = (iss.epic || iss.epicKey || iss.epicName || '').trim().toLowerCase();
        const matches = selectedEpics.some((e) => {
          if (issParentKey && (issParentKey === e || issParentKey.includes(e))) return true;
          if (issParentSummary && (issParentSummary === e || issParentSummary.includes(e) || e.includes(issParentSummary))) return true;
          if (issEpic && (issEpic === e || issEpic.includes(e) || e.includes(issEpic))) return true;
          return false;
        });
        if (!matches) return false;
      }

      // 5. 狀態篩選 (Status)
      if (selectedStatuses.length > 0) {
        const issStatus = (iss.statusName || '').trim().toLowerCase();
        const issStatusCat = (iss.statusCategory || '').trim().toLowerCase();
        const matches = selectedStatuses.some((s) => {
          if (issStatus && (issStatus === s || issStatus.includes(s) || s.includes(issStatus))) return true;
          if (issStatusCat && (issStatusCat === s || issStatusCat.includes(s))) return true;
          return false;
        });
        if (!matches) return false;
      }

      // 6. 標籤篩選 (Labels)
      if (selectedLabels.length > 0) {
        const issLabels = Array.isArray(iss.labels) ? iss.labels.map((l) => String(l).toLowerCase()) : [];
        const matches = selectedLabels.some((l) => {
          if (issLabels.includes(l)) return true;
          if (iss.summary && iss.summary.toLowerCase().includes(l)) return true;
          return false;
        });
        if (!matches) return false;
      }

      // 7. 自訂篩選條件 / 快速篩選 (Quick Filters: 支援 Only My Issues, 優先級, 狀態, 類型, 標籤等)
      if (quickFilters.length > 0) {
        for (const qf of quickFilters) {
          if (!qf || qf.startsWith('__')) continue;
          const lowerQf = qf.toLowerCase().trim();

          // A. 只有我的問題 (Only My Issues / 我的待辦事項)
          if (/^(?:only\s+my\s+issues?|my\s+issues?|我的待辦事項|我的問題|指派給我|我的)$/i.test(lowerQf)) {
            const currentUser = getCurrentJiraUser();
            const issName = (iss.assigneeName || '').toLowerCase();
            const issInitials = (iss.assigneeInitials || '').toLowerCase();
            if (currentUser) {
              const myName = (currentUser.name || '').toLowerCase();
              const myInitials = (currentUser.initials || '').toLowerCase();
              const matches =
                (myName && issName && (issName.includes(myName) || myName.includes(issName))) ||
                (myInitials && issInitials && issInitials === myInitials);
              if (!matches) return false;
            } else {
              if (iss.isUnassigned || !iss.assigneeName) return false;
            }
            continue;
          }

          // B. 工作項目類型
          if (/^(?:bug|缺陷|問題)$/i.test(lowerQf)) {
            const t = (iss.issueTypeName || '').toLowerCase();
            if (t && !/bug|缺陷|問題/i.test(t)) return false;
            continue;
          }
          if (/^(?:story|故事)$/i.test(lowerQf)) {
            const t = (iss.issueTypeName || '').toLowerCase();
            if (t && !/story|故事/i.test(t)) return false;
            continue;
          }
          if (/^(?:task|任務)$/i.test(lowerQf)) {
            const t = (iss.issueTypeName || '').toLowerCase();
            if (t && !/task|任務/i.test(t)) return false;
            continue;
          }

          // C. 優先順序 (Priority)
          if (/^(?:高優先級|最高|重大|緊急|high|highest)$/i.test(lowerQf)) {
            const pri = (iss.priorityName || '').toLowerCase();
            if (pri && !/high|highest|高|最高|重大|緊急/i.test(pri)) return false;
            continue;
          }
          if (/^(?:低優先級|最低|low|lowest)$/i.test(lowerQf)) {
            const pri = (iss.priorityName || '').toLowerCase();
            if (pri && !/low|lowest|低|最低/i.test(pri)) return false;
            continue;
          }

          // D. 狀態名稱匹配
          const issStatus = (iss.statusName || '').toLowerCase();
          if (issStatus && (issStatus === lowerQf || issStatus.includes(lowerQf) || lowerQf.includes(issStatus))) {
            continue;
          }

          // E. 史詩/父項匹配
          const issEpic = ((iss.parentSummary || '') + ' ' + (iss.parentKey || '') + ' ' + (iss.epic || '')).toLowerCase();
          if (issEpic && issEpic.includes(lowerQf)) {
            continue;
          }

          // F. 標籤匹配
          const issLabels = Array.isArray(iss.labels) ? iss.labels.map((l) => String(l).toLowerCase()) : [];
          if (issLabels.some((l) => l.includes(lowerQf) || lowerQf.includes(l))) {
            continue;
          }

          // G. 標題或編號文字匹配
          const issKey = (iss.key || '').toLowerCase();
          const issSummary = (iss.summary || '').toLowerCase();
          if (issKey.includes(lowerQf) || issSummary.includes(lowerQf)) {
            continue;
          }

          // 若非上述任何特徵，且卡片來自原生 DOM，由原生 DOM 過濾機制決定，不予誤殺
          if (iss.fromDom || iss._isFromDom) {
            continue;
          }
        }
      }

      return true;
    });
  }

  BetterJira.FilterService = {
    getNativeBacklogFilterState,
    doesIssueMatchAssigneeFilter,
    filterIssuesByNativeFilter,
    syncFromOpenPopups,
    resetPersistentFilters,
    getCurrentJiraUser,
    getPersistentFilterStore: () => persistentFilterStore
  };
})();
