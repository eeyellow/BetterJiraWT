/**
 * @fileoverview Jira 原生待辦事項篩選與搜尋狀態同步服務
 * 偵測 Jira 原生搜尋框、經辦人頭像按鈕選取狀態、快速篩選，並套用至卡片清單。
 * @module services/filter-service
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * @typedef {Object} NativeBacklogFilterState
   * @property {string} searchKeyword - 搜尋關鍵字 (小寫)
   * @property {boolean} includeUnassigned - 是否選取了「未指派」篩選
   * @property {Array<{initials: string, cleanedNames: string[], tokens: string[], avatarSrc: string}>} selectedAssignees - 選取之經辦人條件清單
   * @property {boolean} hasDirectFilter - 當前是否有任何生效的篩選條件
   * @property {string} sig - 篩選狀態唯一簽章字串
   */

  /**
   * 偵測 Jira 原生篩選搜尋區 (搜尋框、人員頭像篩選、未指派篩選、快速篩選等) 的目前狀態
   *
   * @returns {NativeBacklogFilterState} 篩選狀態結構
   */
  function getNativeBacklogFilterState() {
    const { Constants, AssigneeUtils } = BetterJira;
    const {
      SIDEBAR_ID,
      HISTORY_PICKER_MODAL_ID,
      HISTORY_ISSUE_MODAL_ID
    } = Constants;
    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants, normalizeAvatarUrl } = AssigneeUtils;

    const state = {
      searchKeyword: '',
      includeUnassigned: false,
      selectedAssignees: [],
      hasDirectFilter: false,
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

    // 檢查網址參數是否有搜尋字或 assignee
    try {
      const url = new URL(window.location.href);
      if (!state.searchKeyword) {
        const urlText = url.searchParams.get('text') || url.searchParams.get('search') || '';
        if (urlText.trim()) {
          state.searchKeyword = urlText.trim().toLowerCase();
        }
      }
    } catch {
      // ignore
    }

    // 2. 尋找原生篩選列中的人員頭像篩選按鈕與下拉選單項目
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
        '[data-testid*="assignee-filter"], [data-testid*="ak-avatar"], [data-testid*="avatar-group"], [data-testid*="backlog-filter"], [data-testid*="filters"]'
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

    // 若使用者點開了「+11」更多人員下拉選單，將該彈出選單也納入檢查
    document
      .querySelectorAll(
        '[role="dialog"], [role="menu"], [role="listbox"], [data-testid*="popup"], [data-testid*="dropdown"]'
      )
      .forEach((popup) => {
        if (
          popup.id !== HISTORY_PICKER_MODAL_ID &&
          popup.id !== HISTORY_ISSUE_MODAL_ID &&
          !popup.hasAttribute('data-bjwt-issue-modal') &&
          !popup.closest(`#${SIDEBAR_ID}`) &&
          !popup.closest('[data-bjwt-sprint-branch]')
        ) {
          if (
            popup.querySelector(
              '[data-testid*="assignee"], [data-testid*="avatar"], [role="checkbox"], [role="menuitemcheckbox"], input[type="checkbox"]'
            )
          ) {
            filterRootCandidates.add(popup);
          }
        }
      });

    const candidateButtons = [];
    const seenEls = new Set();

    filterRootCandidates.forEach((root) => {
      const items = root.querySelectorAll(
        'button, [role="checkbox"], [role="menuitemcheckbox"], [role="option"], label'
      );
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
        // 排除「+11」展開更多按鈕、「篩選條件」、「自訂篩選條件」、「清除篩選」等非單一人員按鈕
        if (/^\+\d+$/.test(txt)) return;
        if (
          /^(?:篩選條件|自訂篩選條件|快速篩選|清除|重設|更多|檢視設定|深入分析|filters?|custom\s+filters?|quick\s+filters?|clear|reset|more|insights?)$/i.test(
            txt
          )
        ) {
          return;
        }
        if (el.getAttribute('aria-haspopup') === 'true' || el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'dialog') {
          return;
        }

        const isAvatarLike = Boolean(
          el.matches('[data-testid*="assignee"], [data-testid*="avatar"], [ role="checkbox" ], [ role="menuitemcheckbox" ]') ||
            el.closest('[data-testid*="assignee"], [data-testid*="avatar-group"]') ||
            el.querySelector('[data-testid*="avatar"], [class*="Avatar"], [class*="avatar"], img[src*="avatar"], [role="img"], svg, input[type="checkbox"]')
        );

        if (isAvatarLike) {
          seenEls.add(el);
          candidateButtons.push(el);
        }
      });
    });

    // 檢查每個候選人員按鈕是否處於「已選取 (Pressed / Selected / Checked)」狀態
    const selectedElements = [];
    candidateButtons.forEach((btn) => {
      // 1. 若元素自身明確宣告為未選取 / 未按下，絕對排除 (絕不落入任何模糊猜測)
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
        return;
      }

      // 若有內部 checkbox/radio 且未打勾，明確排除
      const innerInput = btn.querySelector('input[type="checkbox"], input[type="radio"]');
      if (innerInput && !innerInput.checked && !innerInput.hasAttribute('checked')) {
        return;
      }

      // 2. 檢查明確的肯定選取標記
      let isSelected = false;

      // a. 按鈕本體標準 ARIA 屬性 (Atlassian ADS ToggleButton 規範：選取時必為 aria-pressed="true")
      if (
        ariaPressed === 'true' ||
        ariaChecked === 'true' ||
        ariaSelected === 'true' ||
        dataState === 'selected' ||
        dataState === 'active' ||
        dataSelected === 'true'
      ) {
        isSelected = true;
      }

      // b. 檢查按鈕內部是否包含已勾選的 input
      if (!isSelected && innerInput && (innerInput.checked || innerInput.hasAttribute('checked'))) {
        isSelected = true;
      }

      // c. 檢查按鈕內部帶有 aria-pressed="true" 或 aria-checked="true" 的子節點
      if (!isSelected) {
        const pressedDescendant = btn.querySelector(
          '[aria-pressed="true"], [aria-checked="true"], [data-state="selected"], [data-selected="true"]'
        );
        if (pressedDescendant) {
          isSelected = true;
        }
      }

      // d. 檢查按鈕自身的 class (僅限 btn 自身，嚴禁檢查 parentElement 避免外層群組容器樣式污染)
      if (!isSelected) {
        const ownCls = typeof btn.className === 'string' ? btn.className : '';
        if (
          /(?:^|[\s_-])(?:is-selected|is-checked|isSelected|isChecked)(?:$|[\s_-])/.test(ownCls) &&
          !/(?:not-selected|unselected)/i.test(ownCls)
        ) {
          isSelected = true;
        }
      }

      // e. 檢查按鈕內明確的無歧義「已選取」螢幕報讀文字 (嚴格排除「未選取」)
      if (!isSelected) {
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
          isSelected = true;
        }
      }

      if (isSelected) {
        selectedElements.push(btn);
      }
    });

    // 解析每個已選取人員按鈕的代表名稱、縮寫與頭像
    selectedElements.forEach((btn) => {
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
      state.searchKeyword || state.includeUnassigned || state.selectedAssignees.length > 0
    );

    state.sig = JSON.stringify({
      kw: state.searchKeyword,
      unassigned: state.includeUnassigned,
      assignees: state.selectedAssignees.map((a) => ({
        i: a.initials,
        n: a.cleanedNames,
        av: a.avatarSrc
      }))
    });

    return state;
  }

  /**
   * 判斷單張卡片是否符合選取的負責人篩選條件
   *
   * @param {Object} iss - 卡片資料物件
   * @param {NativeBacklogFilterState} filterState - 篩選狀態物件
   * @returns {boolean} 是否符合負責人條件
   */
  function doesIssueMatchAssigneeFilter(iss, filterState) {
    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants, normalizeAvatarUrl } = BetterJira.AssigneeUtils;

    if (!filterState.includeUnassigned && filterState.selectedAssignees.length === 0) {
      return true;
    }

    const issUnassigned = Boolean(iss.isUnassigned || isUnassignedText(iss.assigneeName));
    if (issUnassigned) {
      return Boolean(filterState.includeUnassigned);
    }

    if (filterState.selectedAssignees.length === 0) {
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

    return filterState.selectedAssignees.some((sel) => {
      // 1. 若雙方皆有真實使用者頭像 URL 且一致
      if (sel.avatarSrc && issAvatar && sel.avatarSrc === issAvatar) {
        return true;
      }

      // 2. 若篩選按鈕與卡片皆有明確的短縮寫 (例如篩選列為 "RAY" 或 "B"，卡片上也有 "RAY" 或 "B")
      if (sel.initials && issInitials) {
        if (sel.initials === issInitials) {
          return true;
        }
        // 若兩者都是從 Jira 頭像圓圈取得的縮寫且不相同，除非完整姓名完全相同，否則視為不同人
        if (sel.cleanedNames.length === 0 || (sel.cleanedNames.length === 1 && sel.cleanedNames[0] === sel.initials)) {
          return false;
        }
      }

      // 3. 比對完整姓名與標籤 (例如 "ray huang")
      for (const selName of sel.cleanedNames) {
        if (!selName) continue;
        if (issName && issName === selName) return true;
        if (issTokens.has(selName)) return true;
        if (selName.length >= 3 && issName && (issName.includes(selName) || selName.includes(issName))) {
          return true;
        }
      }

      // 4. 若篩選按鈕只有縮寫 (如 "ray" 或 "bp")，而卡片來自 API 只有全名 (如 "Ray Huang" 或 "Bruce Peng")
      if (sel.initials) {
        if (issTokens.has(sel.initials)) {
          return true;
        }
        if (sel.initials.length >= 3 && issName && issName.includes(sel.initials)) {
          return true;
        }
      }

      return false;
    });
  }

  /**
   * 根據 Jira 原生篩選搜尋區狀態過濾卡片陣列
   *
   * @param {Array<Object>} issues - 待過濾卡片清單
   * @param {NativeBacklogFilterState} filterState - 篩選狀態物件
   * @returns {Array<Object>} 過濾後的卡片清單
   */
  function filterIssuesByNativeFilter(issues, filterState) {
    if (!Array.isArray(issues) || issues.length === 0) return [];
    if (!filterState || !filterState.hasDirectFilter) return issues;

    const kw = filterState.searchKeyword;
    return issues.filter((iss) => {
      if (!doesIssueMatchAssigneeFilter(iss, filterState)) {
        return false;
      }
      if (kw) {
        const haystacks = [
          iss.key,
          iss.summary,
          iss.assigneeName,
          iss.assigneeInitials,
          iss.statusName,
          iss.parentKey,
          iss.parentSummary
        ]
          .filter(Boolean)
          .map((s) => String(s).toLowerCase());
        if (!haystacks.some((h) => h.includes(kw))) {
          return false;
        }
      }
      return true;
    });
  }

  BetterJira.FilterService = {
    getNativeBacklogFilterState,
    doesIssueMatchAssigneeFilter,
    filterIssuesByNativeFilter
  };
})();
