/**
 * @fileoverview 純前端待辦事項卡片搜尋與多維度篩選服務 (Frontend Filter Service)
 * 接管並取代 Jira 原生容易跑版與狀態遺失的篩選列，提供完全在記憶體中運行的
 * 即時關鍵字搜尋、經辦人 (Assignee)、狀態 (Status)、問題類型 (Issue Type) 篩選。
 * 同時支援未結束衝刺與歷史衝刺，並自動更新統計數字。
 * @module services/frontend-filter-service
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 全域純前端篩選狀態
   */
  const filterState = {
    keyword: '',
    selectedAssignees: new Set(), // 經辦人名稱集合，可包含 '__UNASSIGNED__' 或 '__ME__'
    selectedStatuses: new Set(),  // 狀態名稱集合 (如 'To Do', 'In Progress', 'Done')
    selectedTypes: new Set(),     // 問題類型集合 (如 'Story', 'Bug', 'Task')
    currentUser: null             // 目前登入使用者名稱
  };

  const listeners = new Set();

  /**
   * 嘗試從目前 DOM 偵測 Jira 登入者身分 (姓名或帳號)
   *
   * @returns {string|null} 當前使用者全名或帳號
   */
  function detectCurrentUserName() {
    if (typeof document === 'undefined') return null;

    try {
      // 1. Atlassian Meta tags
      const metaName = document.querySelector('meta[name="ajs-remote-user-fullname"]');
      if (metaName && metaName.content) {
        return metaName.content.trim();
      }
      const metaUser = document.querySelector('meta[name="ajs-remote-user"]');
      if (metaUser && metaUser.content) {
        return metaUser.content.trim();
      }

      // 2. 導覽列頭像 (Atlassian Global Navigation Profile)
      const profileImg = document.querySelector(
        '[data-testid="atlassian-navigation--profile"] img[alt], [data-testid*="profile-button"] img[alt], button[aria-label*="您的個人檔案"] img[alt], button[aria-label*="Your profile"] img[alt]'
      );
      if (profileImg && profileImg.alt) {
        const clean = BetterJira.AssigneeUtils
          ? BetterJira.AssigneeUtils.cleanAssigneeLabel(profileImg.alt)
          : profileImg.alt.replace(/(?:的個人檔案|'s profile|profile)/i, '').trim();
        if (clean) return clean;
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * 取得目前篩選狀態的唯讀複本
   *
   * @returns {{keyword: string, selectedAssignees: string[], selectedStatuses: string[], selectedTypes: string[], currentUser: string|null, isActive: boolean, activeCount: number}}
   */
  function getState() {
    const isKwActive = Boolean(filterState.keyword.trim());
    const isAssigneeActive = filterState.selectedAssignees.size > 0;
    const isStatusActive = filterState.selectedStatuses.size > 0;
    const isTypeActive = filterState.selectedTypes.size > 0;

    let activeCount = 0;
    if (isKwActive) activeCount++;
    activeCount += filterState.selectedAssignees.size;
    activeCount += filterState.selectedStatuses.size;
    activeCount += filterState.selectedTypes.size;

    return {
      keyword: filterState.keyword,
      selectedAssignees: Array.from(filterState.selectedAssignees),
      selectedStatuses: Array.from(filterState.selectedStatuses),
      selectedTypes: Array.from(filterState.selectedTypes),
      currentUser: filterState.currentUser || detectCurrentUserName(),
      isActive: isKwActive || isAssigneeActive || isStatusActive || isTypeActive,
      activeCount
    };
  }

  /**
   * 通知所有訂閱者狀態已變更
   */
  function notifyListeners() {
    const state = getState();
    listeners.forEach((fn) => {
      try {
        fn(state);
      } catch (err) {
        console.warn('[BetterJiraWT] FrontendFilter listener error:', err);
      }
    });
  }

  /**
   * 註冊篩選狀態變更回呼函式
   *
   * @param {Function} callback - 狀態變更時的回呼
   * @returns {Function} 解除訂閱函式
   */
  function subscribe(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  /**
   * 設定關鍵字搜尋字串
   *
   * @param {string} kw - 搜尋文字
   */
  function setKeyword(kw) {
    const cleanKw = typeof kw === 'string' ? kw : '';
    if (filterState.keyword !== cleanKw) {
      filterState.keyword = cleanKw;
      notifyListeners();
    }
  }

  /**
   * 切換單一經辦人選取狀態
   *
   * @param {string} assignee - 經辦人姓名或特殊代碼 ('__UNASSIGNED__', '__ME__')
   */
  function toggleAssignee(assignee) {
    if (!assignee) return;
    if (filterState.selectedAssignees.has(assignee)) {
      filterState.selectedAssignees.delete(assignee);
    } else {
      filterState.selectedAssignees.add(assignee);
    }
    notifyListeners();
  }

  /**
   * 設定選取的經辦人集合
   *
   * @param {string[]} assignees - 經辦人清單
   */
  function setSelectedAssignees(assignees) {
    filterState.selectedAssignees = new Set(assignees || []);
    notifyListeners();
  }

  /**
   * 切換狀態選取狀態 (如 'To Do', 'In Progress', 'Done')
   *
   * @param {string} status - 狀態名稱
   */
  function toggleStatus(status) {
    if (!status) return;
    if (filterState.selectedStatuses.has(status)) {
      filterState.selectedStatuses.delete(status);
    } else {
      filterState.selectedStatuses.add(status);
    }
    notifyListeners();
  }

  /**
   * 切換問題類型選取狀態 (如 'Story', 'Bug', 'Task')
   *
   * @param {string} typeName - 問題類型名稱
   */
  function toggleType(typeName) {
    if (!typeName) return;
    if (filterState.selectedTypes.has(typeName)) {
      filterState.selectedTypes.delete(typeName);
    } else {
      filterState.selectedTypes.add(typeName);
    }
    notifyListeners();
  }

  /**
   * 清除所有目前的搜尋與篩選條件
   */
  function clearAll() {
    filterState.keyword = '';
    filterState.selectedAssignees.clear();
    filterState.selectedStatuses.clear();
    filterState.selectedTypes.clear();
    notifyListeners();
  }

  /**
   * 檢查指定卡片是否代表目前使用者
   *
   * @param {Object} issue - 卡片資料物件
   * @param {string} currentUserName - 目前登入使用者全名
   * @returns {boolean}
   */
  function isIssueAssignedToMe(issue, currentUserName) {
    if (!issue || !currentUserName) return false;
    const assignee = (issue.assigneeName || '').trim().toLowerCase();
    const myName = currentUserName.trim().toLowerCase();
    if (!assignee) return false;
    return assignee === myName || assignee.includes(myName) || myName.includes(assignee);
  }

  /**
   * 純前端核心過濾函式
   * 對傳入的一組卡片進行多維度 (AND) 條件比對過濾
   *
   * @param {Object[]} issues - 待篩選卡片清單
   * @returns {Object[]} 符合所有條件的卡片清單
   */
  function filterIssues(issues) {
    if (!Array.isArray(issues) || issues.length === 0) return [];

    const kw = filterState.keyword.trim().toLowerCase();
    const hasKw = kw.length > 0;
    const hasAssignee = filterState.selectedAssignees.size > 0;
    const hasStatus = filterState.selectedStatuses.size > 0;
    const hasType = filterState.selectedTypes.size > 0;

    // 若無任何篩選條件生效，直接全數回傳
    if (!hasKw && !hasAssignee && !hasStatus && !hasType) {
      return issues;
    }

    const currentUserName = filterState.currentUser || detectCurrentUserName();
    const isUnassignedSelected = filterState.selectedAssignees.has('__UNASSIGNED__');
    const isMeSelected = filterState.selectedAssignees.has('__ME__');

    return issues.filter((iss) => {
      if (!iss) return false;

      // 1. 關鍵字搜尋比對 (Key, 標題, 負責人, 狀態, 類型, 父項目, 標籤)
      if (hasKw) {
        const keyMatch = (iss.key || '').toLowerCase().includes(kw);
        const summaryMatch = (iss.summary || '').toLowerCase().includes(kw);
        const assigneeMatch = (iss.assigneeName || '').toLowerCase().includes(kw);
        const statusMatch = (iss.statusName || '').toLowerCase().includes(kw);
        const typeMatch = (iss.issueTypeName || '').toLowerCase().includes(kw);
        const parentMatch =
          (iss.parentSummary || '').toLowerCase().includes(kw) ||
          (iss.parentKey || '').toLowerCase().includes(kw) ||
          (iss.epicName || '').toLowerCase().includes(kw);
        const labelsMatch = Array.isArray(iss.labels)
          ? iss.labels.some((l) => (l || '').toLowerCase().includes(kw))
          : false;

        if (!keyMatch && !summaryMatch && !assigneeMatch && !statusMatch && !typeMatch && !parentMatch && !labelsMatch) {
          return false;
        }
      }

      // 2. 經辦人 (Assignee) 比對
      if (hasAssignee) {
        let assigneeMatched = false;
        const assigneeName = (iss.assigneeName || '').trim();
        const isUnassigned = !assigneeName || (BetterJira.AssigneeUtils && BetterJira.AssigneeUtils.isUnassignedText(assigneeName));

        if (isUnassignedSelected && isUnassigned) {
          assigneeMatched = true;
        } else if (isMeSelected && isIssueAssignedToMe(iss, currentUserName)) {
          assigneeMatched = true;
        } else if (!isUnassigned && filterState.selectedAssignees.has(assigneeName)) {
          assigneeMatched = true;
        }

        if (!assigneeMatched) return false;
      }

      // 3. 狀態 (Status) 比對
      if (hasStatus) {
        const statusName = (iss.statusName || '').trim();
        if (!filterState.selectedStatuses.has(statusName)) {
          return false;
        }
      }

      // 4. 問題類型 (Issue Type) 比對
      if (hasType) {
        const typeName = (iss.issueTypeName || '').trim();
        if (!filterState.selectedTypes.has(typeName)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * 從一組原始全量卡片中自動萃取可選的篩選項目與數量統計
   *
   * @param {Object[]} issues - 原始卡片清單
   * @returns {Object} 萃取之選項物件
   */
  function extractFilterOptions(issues) {
    const safeIssues = Array.isArray(issues) ? issues : [];
    const currentUserName = filterState.currentUser || detectCurrentUserName();

    const assigneeMap = new Map();
    let unassignedCount = 0;
    let myIssuesCount = 0;

    const statusMap = new Map();
    const typeMap = new Map();

    safeIssues.forEach((iss) => {
      if (!iss) return;

      // 經辦人統計
      const rawAssignee = (iss.assigneeName || '').trim();
      const isUnassigned = !rawAssignee || (BetterJira.AssigneeUtils && BetterJira.AssigneeUtils.isUnassignedText(rawAssignee));

      if (isUnassigned) {
        unassignedCount++;
      } else {
        const cleanName = BetterJira.AssigneeUtils ? BetterJira.AssigneeUtils.cleanAssigneeLabel(rawAssignee) : rawAssignee;
        if (!assigneeMap.has(cleanName)) {
          assigneeMap.set(cleanName, {
            name: cleanName,
            avatar: iss.assigneeAvatar || '',
            initials: iss.assigneeInitials || '',
            count: 0
          });
        }
        assigneeMap.get(cleanName).count++;
      }

      if (isIssueAssignedToMe(iss, currentUserName)) {
        myIssuesCount++;
      }

      // 狀態統計
      const statusName = (iss.statusName || '').trim();
      if (statusName) {
        if (!statusMap.has(statusName)) {
          statusMap.set(statusName, {
            name: statusName,
            category: iss.statusCategory || 'new',
            count: 0
          });
        }
        statusMap.get(statusName).count++;
      }

      // 類型統計
      const typeName = (iss.issueTypeName || '').trim();
      if (typeName) {
        if (!typeMap.has(typeName)) {
          typeMap.set(typeName, {
            name: typeName,
            icon: iss.issueTypeIcon || '',
            count: 0
          });
        }
        typeMap.get(typeName).count++;
      }
    });

    const assignees = Array.from(assigneeMap.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const statuses = Array.from(statusMap.values()).sort((a, b) => b.count - a.count);
    const types = Array.from(typeMap.values()).sort((a, b) => b.count - a.count);

    return {
      assignees,
      unassignedCount,
      myIssuesCount,
      statuses,
      types,
      currentUserName,
      totalIssues: safeIssues.length
    };
  }

  /**
   * 手動指定或設定目前使用者名稱
   *
   * @param {string|null} user - 使用者全名或帳號
   */
  function setCurrentUser(user) {
    filterState.currentUser = user || null;
    notifyListeners();
  }

  BetterJira.FrontendFilterService = {
    getState,
    subscribe,
    setKeyword,
    toggleAssignee,
    setSelectedAssignees,
    toggleStatus,
    toggleType,
    clearAll,
    setCurrentUser,
    filterIssues,
    extractFilterOptions,
    detectCurrentUserName,
    isIssueAssignedToMe
  };
})();
