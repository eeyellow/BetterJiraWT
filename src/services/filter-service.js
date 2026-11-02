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
   * 檢查元素是否處於「已選取 (Pressed / Selected / Checked / Active)」狀態
   *
   * @param {Element} btn - 目標 DOM 元素
   * @returns {boolean} 是否選取
   */
  function isElementSelected(btn) {
    if (!btn || !(btn instanceof Element)) return false;

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

    // d. 檢查自身 class (is-selected, ghx-active 等)
    const ownCls = typeof btn.className === 'string' ? btn.className : '';
    if (
      /(?:^|[\s_-])(?:is-selected|is-checked|isSelected|isChecked|ghx-active)(?:$|[\s_-])/.test(ownCls) &&
      !/(?:not-selected|unselected)/i.test(ownCls)
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
      selectedQuickFilters: [],
      selectedTypes: [],
      selectedEpics: [],
      selectedLabels: [],
      selectedStatuses: [],
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
        '[data-testid*="assignee-filter"], [data-testid*="ak-avatar"], [data-testid*="avatar-group"], [data-testid*="backlog-filter"], [data-testid*="filters"], [data-testid*="filter-bar"], [data-testid*="quickfilter"], [data-testid*="quick-filters"], [data-testid*="board-filter"], .ghx-controls-filters, #ghx-quick-filters, [data-testid*="epic-panel"], #ghx-epic-column'
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

        // 檢查是否為選取中的快速篩選或下拉篩選按鈕
        const isSelected = isElementSelected(el);
        const lowerTxt = txt.toLowerCase();
        const testId = (el.getAttribute('data-testid') || '').toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

        if (isSelected) {
          // 判斷是否為工作項目類型 (Type)
          if (/類型|type|issuetype/.test(testId) || /類型|type|issuetype/.test(ariaLabel)) {
            const m = txt.match(/(?:類型|Type|Issue\s*type)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedTypes.includes(val)) state.selectedTypes.push(val);
          }
          // 判斷是否為史詩 (Epic)
          else if (/史詩|epic/.test(testId) || /史詩|epic/.test(ariaLabel)) {
            const m = txt.match(/(?:史詩|Epic)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedEpics.includes(val)) state.selectedEpics.push(val);
          }
          // 判斷是否為標籤 (Label)
          else if (/標籤|label/.test(testId) || /標籤|label/.test(ariaLabel)) {
            const m = txt.match(/(?:標籤|Label)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedLabels.includes(val)) state.selectedLabels.push(val);
          }
          // 判斷是否為狀態 (Status)
          else if (/狀態|status/.test(testId) || /狀態|status/.test(ariaLabel)) {
            const m = txt.match(/(?:狀態|Status)\s*[:：]\s*(.+)/i);
            const val = m ? m[1].trim().toLowerCase() : lowerTxt;
            if (val && !state.selectedStatuses.includes(val)) state.selectedStatuses.push(val);
          }
          // 否則視為快速篩選按鈕 (Quick Filter)
          else if (txt && !/^(?:篩選條件|自訂篩選條件|快速篩選|更多|filters?|custom\s+filters?|quick\s+filters?|more)$/i.test(txt)) {
            if (!state.selectedQuickFilters.includes(txt)) {
              state.selectedQuickFilters.push(txt);
            }
          }
        } else {
          // 檢查按鈕是否含有選取計數徽章 (例如 Type: 1 或含有 badge)
          const badge = el.querySelector('[data-testid*="badge"], [class*="Badge"]');
          if (badge || /:\s*\d+/.test(txt)) {
            if (/類型|type|issuetype/.test(testId) || /類型|type|issuetype/.test(ariaLabel) || /類型|type/i.test(txt)) {
              if (!state.selectedTypes.includes('__has_type_filter__')) state.selectedTypes.push('__has_type_filter__');
            } else if (/史詩|epic/.test(testId) || /史詩|epic/.test(ariaLabel) || /史詩|epic/i.test(txt)) {
              if (!state.selectedEpics.includes('__has_epic_filter__')) state.selectedEpics.push('__has_epic_filter__');
            } else if (/標籤|label/.test(testId) || /標籤|label/.test(ariaLabel) || /標籤|label/i.test(txt)) {
              if (!state.selectedLabels.includes('__has_label_filter__')) state.selectedLabels.push('__has_label_filter__');
            } else if (/狀態|status/.test(testId) || /狀態|status/.test(ariaLabel) || /狀態|status/i.test(txt)) {
              if (!state.selectedStatuses.includes('__has_status_filter__')) state.selectedStatuses.push('__has_status_filter__');
            }
          }
        }
      });
    });

    // 檢查已開啟之下拉清單中勾選的選項 (Type, Epic, Label, Status)
    document
      .querySelectorAll(
        '[role="dialog"], [role="menu"], [role="listbox"], [data-testid*="popup"], [data-testid*="dropdown"]'
      )
      .forEach((popup) => {
        if (
          popup.id === HISTORY_PICKER_MODAL_ID ||
          popup.id === HISTORY_ISSUE_MODAL_ID ||
          popup.hasAttribute('data-bjwt-issue-modal') ||
          popup.closest(`#${SIDEBAR_ID}`) ||
          popup.closest('[data-bjwt-sprint-branch]')
        ) {
          return;
        }

        const popupText = (popup.textContent || '').toLowerCase();
        const popupAria = (popup.getAttribute('aria-label') || '').toLowerCase();
        const popupHeader = popupText.slice(0, 100) + ' ' + popupAria;

        let category = '';
        if (/類型|type|issuetype/.test(popupHeader)) category = 'type';
        else if (/史詩|epic/.test(popupHeader)) category = 'epic';
        else if (/標籤|label/.test(popupHeader)) category = 'label';
        else if (/狀態|status/.test(popupHeader)) category = 'status';

        if (!category) return;

        const checkedOptions = popup.querySelectorAll(
          '[role="menuitemcheckbox"][aria-checked="true"], [role="checkbox"][aria-checked="true"], input[type="checkbox"]:checked, [aria-selected="true"]'
        );
        checkedOptions.forEach((opt) => {
          const optText = (opt.textContent || opt.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (!optText) return;
          if (category === 'type' && !state.selectedTypes.includes(optText)) state.selectedTypes.push(optText);
          if (category === 'epic' && !state.selectedEpics.includes(optText)) state.selectedEpics.push(optText);
          if (category === 'label' && !state.selectedLabels.includes(optText)) state.selectedLabels.push(optText);
          if (category === 'status' && !state.selectedStatuses.includes(optText)) state.selectedStatuses.push(optText);
        });
      });

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
      clearBtn: state.hasClearFilterBtn,
      hdrFiltered: state.hasHeaderFilteredCount
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
   * 支援經辦人、搜尋關鍵字、工作項目類型 (Type)、史詩/父項 (Epic)、狀態 (Status)、標籤 (Label) 與快速篩選 (Quick Filters)。
   *
   * @param {Array<Object>} issues - 待過濾卡片清單
   * @param {NativeBacklogFilterState} filterState - 篩選狀態物件
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

      // 3. 工作項目類型篩選 (Type)
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

      // 7. 快速篩選 (Quick Filters: 類型與優先級等特徵吻合)
      if (quickFilters.length > 0) {
        for (const qf of quickFilters) {
          if (/^(?:bug|缺陷|問題)$/i.test(qf)) {
            const issType = (iss.issueTypeName || '').toLowerCase();
            if (issType && !/bug|缺陷|問題/i.test(issType)) return false;
          } else if (/^(?:story|故事)$/i.test(qf)) {
            const issType = (iss.issueTypeName || '').toLowerCase();
            if (issType && !/story|故事/i.test(issType)) return false;
          } else if (/^(?:task|任務)$/i.test(qf)) {
            const issType = (iss.issueTypeName || '').toLowerCase();
            if (issType && !/task|任務/i.test(issType)) return false;
          }
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
