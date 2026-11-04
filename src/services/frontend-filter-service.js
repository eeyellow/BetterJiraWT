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
   * 正規化問題類型名稱 (支援繁體中文/簡體中文/英文互通與對齊)
   *
   * @param {string} raw - 原始類型字串
   * @returns {string} 標準化類型名稱
   */
  function normalizeIssueTypeName(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const clean = raw.trim();
    const lower = clean.toLowerCase();

    // 0. 清理常見的前綴或後綴 (如 "工作項目類型: Story" 或 "Bug - 類型")
    const stripped = lower
      .replace(/^(?:issue\s*type|工作項目類型|問題類型|類型)\s*[:：\-]\s*/i, '')
      .replace(/\s*[-:：]\s*(?:issue\s*type|工作項目類型|問題類型|類型)$/i, '')
      .trim();

    // 1. Sub-task 優先於 Task 比對 (嚴格防止 subtask 誤判為 task)
    if (/^(?:sub[\s_-]?task|子任務|子工作)$/i.test(stripped) || stripped.includes('subtask') || stripped.includes('sub-task') || stripped.includes('子任務')) {
      return 'Sub-task';
    }
    // 2. Story (故事)
    if (/^(?:story|故事)$/i.test(stripped) || stripped === 'story' || stripped === '故事') {
      return 'Story';
    }
    // 3. Bug (缺陷 / 錯誤)
    if (/^(?:bug|錯誤|缺陷)$/i.test(stripped) || stripped === 'bug' || stripped === '錯誤' || stripped === '缺陷') {
      return 'Bug';
    }
    // 4. Epic (史詩)
    if (/^(?:epic|史詩)$/i.test(stripped) || stripped === 'epic' || stripped === '史詩') {
      return 'Epic';
    }
    // 5. Task (任務 / 工作)
    if (/^(?:task|任務|工作)$/i.test(stripped) || stripped === 'task' || stripped === '任務' || stripped === '工作') {
      return 'Task';
    }
    // 6. 其他專案自訂類型 (如 Spike, Feature, Improvement 等)，保留原始乾淨名稱
    return clean;
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
        let assigneeName = (iss.assigneeName || '').trim();

        // 若卡片為「已指派」但有頭像，嘗試即時反查真實姓名
        if ((!assigneeName || assigneeName === '已指派') && iss.assigneeAvatar && BetterJira.AssigneeUtils) {
          const resolved = BetterJira.AssigneeUtils.resolveUserByAvatar(iss.assigneeAvatar);
          if (resolved && resolved.name) {
            assigneeName = resolved.name;
          }
        }
        if ((!assigneeName || assigneeName === '已指派') && iss.assigneeInitials && BetterJira.AssigneeUtils) {
          const resolved = BetterJira.AssigneeUtils.resolveUserByInitials(iss.assigneeInitials);
          if (resolved && resolved.name) {
            assigneeName = resolved.name;
          }
        }

        const isUnassigned = !assigneeName || (BetterJira.AssigneeUtils && BetterJira.AssigneeUtils.isUnassignedText(assigneeName));

        if (isUnassignedSelected && isUnassigned) {
          assigneeMatched = true;
        } else if (isMeSelected && isIssueAssignedToMe(iss, currentUserName)) {
          assigneeMatched = true;
        } else if (!isUnassigned) {
          const customList =
            BetterJira.AssigneeUtils && typeof BetterJira.AssigneeUtils.getCustomAssignees === 'function'
              ? BetterJira.AssigneeUtils.getCustomAssignees()
              : [];

          for (const sel of filterState.selectedAssignees) {
            if (sel === '__UNASSIGNED__' || sel === '__ME__') continue;

            // 1. 若該選項屬於自訂人員清單，呼叫 matchCustomAssignee 進行全方位精準比對 (含 Name、Email、縮寫、Token)
            const matchedCustom = customList.find(
              (m) => m && m.name && m.name.toLowerCase() === sel.toLowerCase()
            );
            if (matchedCustom) {
              if (BetterJira.AssigneeUtils && BetterJira.AssigneeUtils.matchCustomAssignee(iss, matchedCustom)) {
                assigneeMatched = true;
                break;
              }
            } else {
              // 2. 備援標準名稱比對
              const cleanName = BetterJira.AssigneeUtils ? BetterJira.AssigneeUtils.cleanAssigneeLabel(assigneeName) : assigneeName;
              if (cleanName.toLowerCase() === sel.toLowerCase()) {
                assigneeMatched = true;
                break;
              }
              const initialsList = BetterJira.AssigneeUtils ? BetterJira.AssigneeUtils.deriveInitialsVariants(sel) : [];
              if (iss.assigneeInitials && initialsList.includes(iss.assigneeInitials.toUpperCase())) {
                assigneeMatched = true;
                break;
              }
              if (iss.assigneeTokens && iss.assigneeTokens.includes(sel.toLowerCase())) {
                assigneeMatched = true;
                break;
              }
            }
          }
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

      // 4. 問題類型 (Issue Type) 精準比對 (支援中英文雙向正規化精準對齊，嚴格排除未定類型與子字串誤傷)
      if (hasType) {
        const rawType = (iss.issueTypeName || '').trim();
        // 卡片若完全未解析出類型，決不盲目命中
        if (!rawType) {
          return false;
        }

        const normCardType = normalizeIssueTypeName(rawType).toLowerCase();
        let typeMatched = false;

        for (const selected of filterState.selectedTypes) {
          const cleanSelected = (selected || '').trim();
          if (!cleanSelected) continue;

          // 1. 原始名稱精確比對 (大小寫不敏感)
          if (cleanSelected.toLowerCase() === rawType.toLowerCase()) {
            typeMatched = true;
            break;
          }

          // 2. 正規化後標準名稱對齊 (如 'Story' === '故事', 'Bug' === '缺陷')
          const normSelected = normalizeIssueTypeName(cleanSelected).toLowerCase();
          if (normSelected && normCardType && normSelected === normCardType) {
            typeMatched = true;
            break;
          }
        }

        if (!typeMatched) return false;
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

    // 先主動探索當前頁面原生標頭與頭像列之全量成員
    if (BetterJira.AssigneeUtils && typeof BetterJira.AssigneeUtils.discoverAssigneesFromPage === 'function') {
      try {
        BetterJira.AssigneeUtils.discoverAssigneesFromPage();
      } catch {
        // ignore
      }
    }

    const customList =
      BetterJira.AssigneeUtils && typeof BetterJira.AssigneeUtils.getCustomAssignees === 'function'
        ? BetterJira.AssigneeUtils.getCustomAssignees()
        : [];
    const hasCustomAssignees = Array.isArray(customList) && customList.length > 0;
    const customCounts = new Map();
    if (hasCustomAssignees) {
      customList.forEach((m) => customCounts.set(m.name, 0));
    }

    const assigneeMap = new Map();
    let unassignedCount = 0;
    let myIssuesCount = 0;

    const statusMap = new Map();
    const typeMap = new Map();

    safeIssues.forEach((iss) => {
      if (!iss) return;

      // 經辦人統計
      let rawAssignee = (iss.assigneeName || '').trim();
      const isUnassigned = !rawAssignee || (BetterJira.AssigneeUtils && BetterJira.AssigneeUtils.isUnassignedText(rawAssignee));

      if (isUnassigned) {
        unassignedCount++;
      } else if (hasCustomAssignees) {
        // 優先依據自訂人員名單 (Email、姓名、縮寫、Token) 精準比對
        for (const member of customList) {
          if (BetterJira.AssigneeUtils.matchCustomAssignee(iss, member)) {
            customCounts.set(member.name, (customCounts.get(member.name) || 0) + 1);
            break;
          }
        }
      } else {
        // 若卡片僅有頭像或為「已指派」，嘗試從全域人員目錄即時反查
        if ((!rawAssignee || rawAssignee === '已指派') && iss.assigneeAvatar && BetterJira.AssigneeUtils) {
          const resolved = BetterJira.AssigneeUtils.resolveUserByAvatar(iss.assigneeAvatar);
          if (resolved && resolved.name) {
            rawAssignee = resolved.name;
            iss.assigneeName = resolved.name;
            if (!iss.assigneeInitials) iss.assigneeInitials = resolved.initials || '';
          }
        }
        if ((!rawAssignee || rawAssignee === '已指派') && iss.assigneeInitials && BetterJira.AssigneeUtils) {
          const resolved = BetterJira.AssigneeUtils.resolveUserByInitials(iss.assigneeInitials);
          if (resolved && resolved.name) {
            rawAssignee = resolved.name;
            iss.assigneeName = resolved.name;
          }
        }

        const cleanName = BetterJira.AssigneeUtils ? BetterJira.AssigneeUtils.cleanAssigneeLabel(rawAssignee) : rawAssignee;
        if (cleanName && cleanName !== '已指派') {
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

      // 類型統計 (依標準化類別聚合，若同義則合併筆數與圖示)
      const rawTypeName = (iss.issueTypeName || '').trim();
      if (rawTypeName) {
        const normKey = normalizeIssueTypeName(rawTypeName);
        if (!typeMap.has(normKey)) {
          typeMap.set(normKey, {
            name: normKey,
            icon: iss.issueTypeIcon || '',
            count: 0
          });
        }
        const entry = typeMap.get(normKey);
        if (!entry.icon && iss.issueTypeIcon) {
          entry.icon = iss.issueTypeIcon;
        }
        entry.count++;
      }
    });

    // 若為自訂成員模式，依自訂名單完整輸出選項 (包含 Email 與計算後的張數)
    if (hasCustomAssignees) {
      customList.forEach((member) => {
        const count = customCounts.get(member.name) || 0;
        const initials = BetterJira.AssigneeUtils
          ? BetterJira.AssigneeUtils.deriveInitialsVariants(member.name)[0] || ''
          : '';
        assigneeMap.set(member.name, {
          name: member.name,
          email: member.email || '',
          avatar: '',
          initials,
          count
        });
      });
    }

    // 補充專案已知的所有類型 (即使當前衝刺或可見卡片中尚未出現該類型，亦完整列出)
    const { IssueStore } = BetterJira;
    if (IssueStore && typeof IssueStore.getProjectIssueTypes === 'function') {
      const pTypes = IssueStore.getProjectIssueTypes();
      if (Array.isArray(pTypes)) {
        pTypes.forEach((pt) => {
          if (!pt || !pt.name) return;
          const normKey = normalizeIssueTypeName(pt.name);
          if (!typeMap.has(normKey)) {
            typeMap.set(normKey, {
              name: normKey,
              icon: pt.iconUrl || '',
              count: 0
            });
          } else {
            const entry = typeMap.get(normKey);
            if (!entry.icon && pt.iconUrl) {
              entry.icon = pt.iconUrl;
            }
          }
        });
      }
    }

    // 若看板卡片偏少或 API 尚未回傳，保證核心常見問題類型 (Story, Bug, Task, Sub-task, Epic) 完整備齊
    const baselineTypes = ['Story', 'Bug', 'Task', 'Sub-task', 'Epic'];
    baselineTypes.forEach((bt) => {
      if (!typeMap.has(bt)) {
        typeMap.set(bt, {
          name: bt,
          icon: '',
          count: 0
        });
      }
    });

    const assignees = Array.from(assigneeMap.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const statuses = Array.from(statusMap.values()).sort((a, b) => b.count - a.count);
    const types = Array.from(typeMap.values()).sort((a, b) => {
      // 有卡片的排前面，計數相同時依常見重要度排序
      if (b.count !== a.count) return b.count - a.count;
      const order = { 'Story': 1, 'Bug': 2, 'Task': 3, 'Sub-task': 4, 'Epic': 5 };
      return (order[a.name] || 99) - (order[b.name] || 99);
    });

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
    isIssueAssignedToMe,
    normalizeIssueTypeName
  };
})();
