/**
 * @fileoverview 全域卡片與衝刺資料狀態管理庫 (Issue & Sprint Store)
 * 集中管理卡片欄位快取、DOM 與 API 欄位融合、API 原始卡片正規化與歷史衝刺清單。
 * @module state/issue-store
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 全域卡片欄位快取 (key -> Issue 物件)
   * 用於將 REST API 取得的完整欄位與原生 DOM 解析出的即時欄位 (如頭像縮寫 RAY、背景色、最新狀態) 融合，
   * 同時不覆蓋原生篩選器篩選後的卡片集合。
   * @type {Map<string, Object>}
   */
  const issueMetadataMap = new Map();

  /**
   * 未結束衝刺自定義卡片快取
   * key: string -> {
   *   key: string,
   *   sprintId?: string | number,
   *   title: string,
   *   issues: Array<Object>,
   *   allApiIssues: Array<Object> | null,
   *   filterKeyword: string,
   *   dateRange?: string,
   *   fromApi: boolean,
   *   apiSyncing: boolean
   * }
   * @type {Map<string, Object>}
   */
  const activeSprintCache = new Map();

  /**
   * 僅在「當前頁面瀏覽期間」保留的已結束歷史衝刺清單 (重新整理頁面後自動清空)
   * @type {Array<Object>}
   */
  const loadedHistoricalSprints = [];

  let cachedClosedSprints = null;
  let cachedBoardId = null;
  let cachedStoryPointsFieldId = null;
  let cachedBoardSprints = null;
  let cachedProjectIssueTypes = [];

  /**
   * 記錄使用者透過 UI (QuickEditPopover / IssueModal) 主動修改過的欄位覆寫值 (key -> overrides)
   * 確保修改後在背景原生 DOM 尚未刷新前，不會被 CardDomParser 的舊 DOM 快照逆向覆蓋。
   * @type {Map<string, Object>}
   */
  const userOverridesMap = new Map();

  /**
   * 將更新後的完整卡片物件同步至所有衝刺快取池 (activeSprintCache 與 loadedHistoricalSprints)
   *
   * @param {string} key - 大寫卡片編號
   * @param {Object} merged - 最新融合後的卡片物件
   */
  function syncMergedIssueToSprintCaches(key, merged) {
    if (!key || !merged) return;

    // 1. 同步至未結束衝刺快取 (activeSprintCache)
    activeSprintCache.forEach((cached) => {
      if (!cached) return;
      if (cached.masterIssuesMap instanceof Map && cached.masterIssuesMap.has(key)) {
        cached.masterIssuesMap.set(key, merged);
      }
      const replaceInArray = (arr) => {
        if (!Array.isArray(arr)) return;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] && String(arr[i].key || '').toUpperCase() === key) {
            arr[i] = merged;
          }
        }
      };
      replaceInArray(cached.allApiIssues);
      replaceInArray(cached.rawIssues);
      replaceInArray(cached.issues);
    });

    // 2. 同步至已載入之歷史衝刺快取 (loadedHistoricalSprints)
    loadedHistoricalSprints.forEach((hist) => {
      if (hist && Array.isArray(hist.issues)) {
        for (let i = 0; i < hist.issues.length; i++) {
          if (hist.issues[i] && String(hist.issues[i].key || '').toUpperCase() === key) {
            hist.issues[i] = merged;
          }
        }
      }
    });
  }

  /**
   * 清除指定卡片或全部卡片的使用者手動覆寫鎖定 (例如點擊「重新整理」強制從伺服器同步時呼叫)
   *
   * @param {string} [issueKey] - 若指定則僅清除該張卡片，未指定則清除全部
   */
  function clearUserOverrides(issueKey = null) {
    if (issueKey) {
      userOverridesMap.delete(String(issueKey).toUpperCase());
    } else {
      userOverridesMap.clear();
    }
  }

  /**
   * 將原生 DOM 卡片與 API 卡片資料融合並存入 issueMetadataMap
   *
   * @param {Object} primaryIss - 主要卡片物件 (最新解析或傳入者)
   * @param {Object|null} [secondaryIss=null] - 次要卡片物件 (備用或既有快取)
   * @returns {Object} 融合後的完整卡片物件
   */
  function mergeAndCacheIssue(primaryIss, secondaryIss = null) {
    if (!primaryIss || !primaryIss.key) return primaryIss;
    const { cleanSummaryText, isTruncatedDuplicateOf } = BetterJira.TextUtils;
    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants, getDisplayInitialsForIssue } = BetterJira.AssigneeUtils;

    const key = primaryIss.key.toUpperCase();
    const existing = secondaryIss || issueMetadataMap.get(key) || null;

    // 判斷是否為使用者主動編輯或顯式局部欄位更新 (非原生 DOM 掃描亦非批次 API 初始化)
    const isExplicitUserUpdate = Boolean(
      primaryIss.isUserEdit ||
      (!primaryIss.fromDom && !primaryIss._isFromDom && !primaryIss._isFromApi && existing && !primaryIss.id)
    );

    if (isExplicitUserUpdate) {
      const prevOverrides = userOverridesMap.get(key) || {};
      const nextOverrides = { ...prevOverrides };

      if ('statusName' in primaryIss && primaryIss.statusName !== undefined) {
        nextOverrides.statusName = primaryIss.statusName;
      }
      if ('statusCategory' in primaryIss && primaryIss.statusCategory !== undefined && primaryIss.statusCategory !== '') {
        nextOverrides.statusCategory = primaryIss.statusCategory;
      }
      if ('storyPoints' in primaryIss && primaryIss.storyPoints !== undefined) {
        nextOverrides.storyPoints = primaryIss.storyPoints;
      }
      if ('priorityName' in primaryIss && primaryIss.priorityName !== undefined) {
        nextOverrides.priorityName = primaryIss.priorityName;
        nextOverrides.priorityIcon = primaryIss.priorityIcon !== undefined ? primaryIss.priorityIcon : '';
        nextOverrides.prioritySvg = primaryIss.prioritySvg !== undefined ? primaryIss.prioritySvg : '';
      }
      if ('issueTypeName' in primaryIss && primaryIss.issueTypeName !== undefined) {
        nextOverrides.issueTypeName = primaryIss.issueTypeName;
        if ('issueTypeIcon' in primaryIss && primaryIss.issueTypeIcon !== undefined) {
          nextOverrides.issueTypeIcon = primaryIss.issueTypeIcon;
        }
      }
      if ('assigneeName' in primaryIss || 'isUnassigned' in primaryIss) {
        const unass =
          primaryIss.isUnassigned !== undefined
            ? Boolean(primaryIss.isUnassigned)
            : isUnassignedText(primaryIss.assigneeName);
        nextOverrides.isUnassigned = unass;
        nextOverrides.assigneeName = unass ? '未指派' : (primaryIss.assigneeName || '未指派');
        nextOverrides.assigneeAvatar = unass ? '' : (primaryIss.assigneeAvatar || '');
        nextOverrides.assigneeInitials = unass
          ? ''
          : (primaryIss.assigneeInitials || getDisplayInitialsForIssue({ assigneeName: nextOverrides.assigneeName, isUnassigned: false }));
        nextOverrides.assigneeBgColor = unass
          ? ''
          : (primaryIss.assigneeBgColor !== undefined ? primaryIss.assigneeBgColor : '');
        if ('assigneeEmail' in primaryIss) {
          nextOverrides.assigneeEmail = unass ? '' : (primaryIss.assigneeEmail || '');
        }
        if ('assigneeAccountId' in primaryIss) {
          nextOverrides.assigneeAccountId = unass ? '' : (primaryIss.assigneeAccountId || '');
        }
        if ('assigneeUsername' in primaryIss) {
          nextOverrides.assigneeUsername = unass ? '' : (primaryIss.assigneeUsername || '');
        }
      }
      if ('summary' in primaryIss && primaryIss.summary !== undefined) {
        nextOverrides.summary = primaryIss.summary;
      }
      if ('dueDate' in primaryIss && primaryIss.dueDate !== undefined) {
        nextOverrides.dueDate = primaryIss.dueDate;
      }

      userOverridesMap.set(key, nextOverrides);
    }

    if (!existing) {
      const copy = {
        ...primaryIss,
        key,
        assigneeTokens: Array.from(new Set(primaryIss.assigneeTokens || []))
      };
      delete copy.isUserEdit;
      issueMetadataMap.set(key, copy);
      syncMergedIssueToSprintCaches(key, copy);
      return copy;
    }

    const domSide = primaryIss.fromDom ? primaryIss : existing.fromDom ? existing : primaryIss;
    const apiSide = !primaryIss.fromDom ? primaryIss : !existing.fromDom ? existing : null;

    // 若 primaryIss 是非 DOM 的更新 (API 或使用者編輯) 且明確帶有 isUnassigned 或 assigneeName，優先以 primaryIss 為準
    let isUnassigned;
    if (!primaryIss.fromDom && (primaryIss.isUnassigned !== undefined || primaryIss.assigneeName !== undefined)) {
      isUnassigned =
        primaryIss.isUnassigned !== undefined
          ? Boolean(primaryIss.isUnassigned)
          : isUnassignedText(primaryIss.assigneeName);
    } else {
      isUnassigned =
        domSide.isUnassigned !== undefined
          ? domSide.isUnassigned
          : apiSide && apiSide.isUnassigned !== undefined
          ? apiSide.isUnassigned
          : isUnassignedText(primaryIss.assigneeName);
    }

    let assigneeName = '未指派';
    if (!isUnassigned) {
      const apiName =
        apiSide && !isUnassignedText(apiSide.assigneeName) && apiSide.assigneeName !== '已指派'
          ? apiSide.assigneeName
          : '';
      const domName =
        domSide && !isUnassignedText(domSide.assigneeName) && domSide.assigneeName !== '已指派'
          ? domSide.assigneeName
          : '';
      if (!primaryIss.fromDom && apiName) {
        assigneeName = apiName;
      } else {
        assigneeName =
          apiName && apiName.length >= domName.length
            ? apiName
            : domName || apiName;
      }

      if (!assigneeName) {
        const av =
          (domSide && domSide.assigneeAvatar) ||
          (apiSide && apiSide.assigneeAvatar) ||
          primaryIss.assigneeAvatar;
        const resolved =
          av &&
          BetterJira.AssigneeUtils &&
          typeof BetterJira.AssigneeUtils.resolveUserByAvatar === 'function'
            ? BetterJira.AssigneeUtils.resolveUserByAvatar(av)
            : null;
        assigneeName = (resolved && resolved.name) || (domSide && domSide.assigneeName) || '已指派';
      }
    }

    const isAssigneeChangedByPrimary =
      !primaryIss.fromDom &&
      primaryIss.assigneeName &&
      existing.assigneeName &&
      primaryIss.assigneeName.toLowerCase() !== existing.assigneeName.toLowerCase();

    const assigneeInitials = isUnassigned
      ? ''
      : isAssigneeChangedByPrimary
      ? primaryIss.assigneeInitials || deriveInitialsVariants(assigneeName)[0] || ''
      : (domSide && domSide.assigneeInitials) ||
        (existing && existing.assigneeInitials) ||
        (primaryIss && primaryIss.assigneeInitials) ||
        deriveInitialsVariants(assigneeName)[0] ||
        '';

    const assigneeBgColor = isUnassigned
      ? ''
      : isAssigneeChangedByPrimary
      ? primaryIss.assigneeBgColor || ''
      : (domSide && domSide.assigneeBgColor) ||
        (existing && existing.assigneeBgColor) ||
        (primaryIss && primaryIss.assigneeBgColor) ||
        '';

    const assigneeAvatar = isUnassigned
      ? ''
      : isAssigneeChangedByPrimary
      ? (primaryIss.assigneeAvatar && !/issuetype|\/type\//i.test(primaryIss.assigneeAvatar) ? primaryIss.assigneeAvatar : '')
      : (primaryIss.assigneeAvatar && !/issuetype|\/type\//i.test(primaryIss.assigneeAvatar)
          ? primaryIss.assigneeAvatar
          : '') ||
        (existing.assigneeAvatar && !/issuetype|\/type\//i.test(existing.assigneeAvatar)
          ? existing.assigneeAvatar
          : '');

    const assigneeAccountId = isUnassigned
      ? ''
      : isAssigneeChangedByPrimary
      ? primaryIss.assigneeAccountId || ''
      : primaryIss.assigneeAccountId || existing.assigneeAccountId || '';

    const assigneeUsername = isUnassigned
      ? ''
      : isAssigneeChangedByPrimary
      ? primaryIss.assigneeUsername || ''
      : primaryIss.assigneeUsername || existing.assigneeUsername || '';

    const assigneeEmail = isUnassigned
      ? ''
      : isAssigneeChangedByPrimary
      ? primaryIss.assigneeEmail || ''
      : primaryIss.assigneeEmail || existing.assigneeEmail || '';

    if (
      assigneeName &&
      assigneeName !== '未指派' &&
      assigneeName !== '已指派' &&
      BetterJira.AssigneeUtils &&
      typeof BetterJira.AssigneeUtils.registerAssignee === 'function'
    ) {
      BetterJira.AssigneeUtils.registerAssignee({
        name: assigneeName,
        avatar: assigneeAvatar,
        initials: assigneeInitials,
        accountId: assigneeAccountId,
        username: assigneeUsername,
        email: assigneeEmail
      });
    }

    const tokenSet = new Set([
      ...(isAssigneeChangedByPrimary ? [] : (existing.assigneeTokens || [])),
      ...(primaryIss.assigneeTokens || [])
    ]);
    if (!isUnassigned) {
      if (assigneeName) tokenSet.add(assigneeName.toLowerCase());
      if (assigneeInitials) tokenSet.add(assigneeInitials.toLowerCase());
      deriveInitialsVariants(assigneeName, assigneeInitials).forEach((v) =>
        tokenSet.add(v.toLowerCase())
      );
    }

    // 狀態欄位：若 primaryIss 為非 DOM 之明確更新，優先採用 primaryIss 的最新狀態
    const resolvedStatusName =
      (!primaryIss.fromDom && primaryIss.statusName && primaryIss.statusName !== '未知狀態')
        ? primaryIss.statusName
        : (domSide && domSide.statusName) || primaryIss.statusName || existing.statusName;

    const resolvedStatusCategory =
      (!primaryIss.fromDom && primaryIss.statusCategory)
        ? primaryIss.statusCategory
        : (domSide && domSide.statusCategory) || primaryIss.statusCategory || existing.statusCategory;

    // 優先度欄位：若優先度名稱已變更，避免殘留舊優先度的 SVG
    const isPriorityChanged =
      primaryIss.priorityName &&
      existing.priorityName &&
      primaryIss.priorityName.toLowerCase() !== existing.priorityName.toLowerCase();

    const resolvedPriorityName = primaryIss.priorityName || existing.priorityName;
    const resolvedPriorityIcon = isPriorityChanged
      ? (primaryIss.priorityIcon || '')
      : (primaryIss.priorityIcon || existing.priorityIcon);
    const resolvedPrioritySvg = isPriorityChanged
      ? (primaryIss.prioritySvg || '')
      : (primaryIss.prioritySvg !== undefined ? primaryIss.prioritySvg : existing.prioritySvg);

    // Story Points 欄位：支援非 DOM 明確傳入 null 清空點數
    let resolvedStoryPoints;
    if (!primaryIss.fromDom && 'storyPoints' in primaryIss && primaryIss.storyPoints !== undefined) {
      resolvedStoryPoints = primaryIss.storyPoints;
    } else if (primaryIss.storyPoints !== null && primaryIss.storyPoints !== undefined) {
      resolvedStoryPoints = primaryIss.storyPoints;
    } else if (existing.storyPoints !== null && existing.storyPoints !== undefined) {
      resolvedStoryPoints = existing.storyPoints;
    } else {
      resolvedStoryPoints = null;
    }

    const merged = {
      ...existing,
      ...primaryIss,
      key,
      summary:
        apiSide && apiSide.summary && isTruncatedDuplicateOf(primaryIss.summary, apiSide.summary)
          ? apiSide.summary
          : primaryIss.summary || existing.summary,
      statusName: resolvedStatusName,
      statusCategory: resolvedStatusCategory,
      issueTypeIcon: primaryIss.issueTypeIcon || existing.issueTypeIcon,
      issueTypeName:
        (apiSide && apiSide.issueTypeName) ||
        primaryIss.issueTypeName ||
        existing.issueTypeName ||
        '',
      isSubtask: Boolean(
        primaryIss.isSubtask !== undefined
          ? primaryIss.isSubtask
          : existing.isSubtask !== undefined
          ? existing.isSubtask
          : (primaryIss.subtask ?? existing.subtask ?? (BetterJira.TextUtils && typeof BetterJira.TextUtils.isSubtaskTypeName === 'function' ? BetterJira.TextUtils.isSubtaskTypeName(primaryIss.issueTypeName || existing.issueTypeName) : false))
      ),
      priorityIcon: resolvedPriorityIcon,
      prioritySvg: resolvedPrioritySvg,
      priorityName: resolvedPriorityName,
      parentKey: primaryIss.parentKey || existing.parentKey,
      parentSummary: primaryIss.parentSummary || existing.parentSummary,
      dueDate: primaryIss.dueDate || existing.dueDate,
      storyPoints: resolvedStoryPoints,
      isUnassigned,
      assigneeName,
      assigneeInitials,
      assigneeBgColor,
      assigneeAvatar,
      assigneeAccountId,
      assigneeUsername,
      assigneeEmail,
      assigneeTokens: Array.from(tokenSet),
      fromDom: Boolean(primaryIss.fromDom || existing.fromDom),
      _isFromDom: Boolean(primaryIss._isFromDom || existing._isFromDom),
      issueId: primaryIss.issueId || existing.issueId || '',
      id: primaryIss.id || existing.id || primaryIss.key
    };
    delete merged.isUserEdit;

    // 若使用者曾透過 UI 明確編輯過此卡片的欄位，套用 userOverridesMap 防止被背景未刷新的原生 DOM 覆蓋
    const userOverrides = userOverridesMap.get(key);
    if (userOverrides) {
      Object.assign(merged, userOverrides);
      if (userOverrides.isUnassigned) {
        merged.assigneeTokens = [];
      } else if (userOverrides.assigneeName && userOverrides.assigneeName !== '未指派') {
        const overrideTokens = new Set(merged.assigneeTokens || []);
        overrideTokens.add(userOverrides.assigneeName.toLowerCase());
        if (userOverrides.assigneeInitials) {
          overrideTokens.add(userOverrides.assigneeInitials.toLowerCase());
        }
        deriveInitialsVariants(userOverrides.assigneeName, userOverrides.assigneeInitials).forEach((v) =>
          overrideTokens.add(v.toLowerCase())
        );
        merged.assigneeTokens = Array.from(overrideTokens);
      }
    }

    issueMetadataMap.set(key, merged);
    syncMergedIssueToSprintCaches(key, merged);
    return merged;
  }

  /**
   * 將 Jira API 回傳的原始 Issue 物件正規化為渲染卡片所需的欄位結構
   *
   * @param {Object} raw - Jira REST API 回傳之 issue 原始物件
   * @returns {Object} 正規化後的卡片物件
   */
  function normalizeJiraIssue(raw) {
    const { cleanSummaryText, cleanStatusText, cleanDueDateText } = BetterJira.TextUtils;
    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants, getDisplayInitialsForIssue } = BetterJira.AssigneeUtils;

    const fields = raw.fields || {};
    const statusObj = fields.status || {};
    const statusCatKey =
      (statusObj.statusCategory && statusObj.statusCategory.key) || '';
    const issueTypeObj = fields.issuetype || {};
    const priorityObj = fields.priority || {};
    const assigneeObj = fields.assignee || null;
    const parentObj = fields.parent || null;

    const { isSubtaskTypeName } = BetterJira.TextUtils || {};
    const isSubtask = Boolean(
      issueTypeObj.subtask === true ||
      (issueTypeObj.name && (typeof isSubtaskTypeName === 'function' ? isSubtaskTypeName(issueTypeObj.name) : /sub[\s_-]?task|子任務|子工作/i.test(issueTypeObj.name)))
    );

    // 常見 Story Points 欄位與動態探測之欄位
    let rawStoryPoints = null;
    if (cachedStoryPointsFieldId && fields[cachedStoryPointsFieldId] !== undefined) {
      rawStoryPoints = fields[cachedStoryPointsFieldId];
    } else if (
      raw.estimateStatistic &&
      raw.estimateStatistic.statFieldValue &&
      raw.estimateStatistic.statFieldValue.value !== undefined
    ) {
      rawStoryPoints = raw.estimateStatistic.statFieldValue.value;
    } else {
      rawStoryPoints =
        fields.customfield_10016 ??
        fields.customfield_10026 ??
        fields.customfield_10004 ??
        fields.customfield_10008 ??
        fields.customfield_10028 ??
        fields.customfield_10024 ??
        fields.story_points ??
        fields.storyPoints ??
        null;
    }

    if (rawStoryPoints === null || rawStoryPoints === undefined) {
      for (const [k, v] of Object.entries(fields)) {
        if (k.startsWith('customfield_') && typeof v === 'number' && v > 0 && v < 500) {
          rawStoryPoints = v;
          break;
        }
      }
    }

    let storyPoints = null;
    if (rawStoryPoints !== null && rawStoryPoints !== undefined && rawStoryPoints !== '') {
      const parsedNum = parseFloat(rawStoryPoints);
      if (!isNaN(parsedNum)) {
        storyPoints = Math.round(parsedNum * 10) / 10;
      }
    }

    let cleanStatus = cleanStatusText(statusObj.name || '未知狀態');

    const rawAssigneeName = assigneeObj
      ? cleanAssigneeLabel(assigneeObj.displayName || assigneeObj.name || assigneeObj.emailAddress || '')
      : '';
    const isUnassigned = !assigneeObj || !rawAssigneeName || isUnassignedText(rawAssigneeName);
    const assigneeName = isUnassigned ? '未指派' : rawAssigneeName;
    const assigneeAccountId = assigneeObj ? String(assigneeObj.accountId || '').trim() : '';
    const assigneeUsername = assigneeObj ? String(assigneeObj.name || '').trim() : '';
    const assigneeEmail = assigneeObj ? String(assigneeObj.emailAddress || '').trim() : '';

    const tokenList = [];
    if (!isUnassigned) {
      tokenList.push(...deriveInitialsVariants(assigneeName));
      if (assigneeObj && assigneeObj.name) {
        tokenList.push(...deriveInitialsVariants(assigneeObj.name));
      }
      if (assigneeObj && assigneeObj.emailAddress) {
        const localPart = String(assigneeObj.emailAddress).split('@')[0];
        if (localPart) tokenList.push(...deriveInitialsVariants(localPart));
      }
    }

    const issueObj = {
      id: raw.id,
      key: (raw.key || '').toUpperCase(),
      summary: cleanSummaryText((fields.summary || '(無標題)').replace(/\s+/g, ' ').trim()),
      statusName: cleanStatus || '未知狀態',
      statusCategory: statusCatKey, // 'done' | 'indeterminate' | 'new'
      issueTypeName: issueTypeObj.name || '任務',
      issueTypeIcon: issueTypeObj.iconUrl || '',
      priorityName: priorityObj.name || '',
      priorityIcon: priorityObj.iconUrl || '',
      assigneeName,
      assigneeAccountId,
      assigneeUsername,
      assigneeEmail,
      isUnassigned,
      assigneeInitials: isUnassigned ? '' : getDisplayInitialsForIssue({ assigneeName, isUnassigned }),
      assigneeTokens: Array.from(new Set(tokenList)),
      assigneeAvatar:
        assigneeObj && assigneeObj.avatarUrls
          ? assigneeObj.avatarUrls['48x48'] || assigneeObj.avatarUrls['24x24'] || ''
          : '',
      parentKey: parentObj ? parentObj.key : '',
      parentSummary:
        parentObj && parentObj.fields ? parentObj.fields.summary || '' : '',
      dueDate: cleanDueDateText(fields.duedate || ''),
      storyPoints,
      isSubtask,
      _isFromApi: true
    };

    return mergeAndCacheIssue(issueObj);
  }

  /**
   * 將載入的歷史 Sprint 加入當前狀態清單 (若已存在則覆蓋更新)
   *
   * @param {Object} sprintData - 歷史衝刺資料物件
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
  }

  /**
   * 從目前狀態清單移除指定的歷史 Sprint
   *
   * @param {string} historyKey - 欲移除之歷史衝刺鍵值
   * @returns {boolean} 是否成功找到並移除
   */
  function removeHistoricalSprint(historyKey) {
    const idx = loadedHistoricalSprints.findIndex((item) => item.key === historyKey);
    if (idx === -1) return false;
    loadedHistoricalSprints.splice(idx, 1);
    return true;
  }

  /**
   * 檢查指定卡片物件是否為子任務 (SubTask)
   *
   * @param {Object} iss - 卡片資料物件
   * @returns {boolean} 是否為子任務
   */
  function isSubtaskIssue(iss) {
    if (!iss || typeof iss !== 'object') return false;
    if (iss.isSubtask === true || iss.subtask === true) return true;
    if (iss.isSubtask === false) return false;
    const typeName = iss.issueTypeName || (iss.fields && iss.fields.issuetype && iss.fields.issuetype.name);
    if (typeName && BetterJira.TextUtils && typeof BetterJira.TextUtils.isSubtaskTypeName === 'function') {
      return BetterJira.TextUtils.isSubtaskTypeName(typeName);
    }
    return false;
  }

  /**
   * 當卡片被移動至其他衝刺時，更新記憶體中各衝刺快取池
   *
   * @param {string} issueKey - 卡片編號
   * @param {string|number} targetSprintId - 目標衝刺 ID
   */
  function moveIssueInSprintStore(issueKey, targetSprintId) {
    if (!issueKey || !targetSprintId) return;
    const key = String(issueKey).toUpperCase();
    const targetSprintIdStr = String(targetSprintId);

    let issueObj = issueMetadataMap.get(key);
    if (!issueObj) {
      activeSprintCache.forEach((cached) => {
        if (!issueObj && cached && Array.isArray(cached.issues)) {
          const found = cached.issues.find((i) => i && String(i.key || '').toUpperCase() === key);
          if (found) issueObj = found;
        }
      });
    }

    activeSprintCache.forEach((cached) => {
      if (!cached) return;
      const isTarget = cached.sprintId && String(cached.sprintId) === targetSprintIdStr;
      if (!isTarget) {
        if (cached.masterIssuesMap instanceof Map) {
          cached.masterIssuesMap.delete(key);
        }
        if (Array.isArray(cached.issues)) {
          cached.issues = cached.issues.filter((i) => i && String(i.key).toUpperCase() !== key);
        }
        if (Array.isArray(cached.rawIssues)) {
          cached.rawIssues = cached.rawIssues.filter((i) => i && String(i.key).toUpperCase() !== key);
        }
        if (Array.isArray(cached.allApiIssues)) {
          cached.allApiIssues = cached.allApiIssues.filter((i) => i && String(i.key).toUpperCase() !== key);
        }
      } else if (issueObj) {
        if (cached.masterIssuesMap instanceof Map) {
          cached.masterIssuesMap.set(key, issueObj);
        }
        if (Array.isArray(cached.issues) && !cached.issues.some((i) => i && String(i.key).toUpperCase() === key)) {
          cached.issues.push(issueObj);
        }
        if (Array.isArray(cached.rawIssues) && !cached.rawIssues.some((i) => i && String(i.key).toUpperCase() === key)) {
          cached.rawIssues.push(issueObj);
        }
        if (Array.isArray(cached.allApiIssues) && !cached.allApiIssues.some((i) => i && String(i.key).toUpperCase() === key)) {
          cached.allApiIssues.push(issueObj);
        }
      }
    });

    loadedHistoricalSprints.forEach((hist) => {
      if (hist && Array.isArray(hist.issues)) {
        hist.issues = hist.issues.filter((i) => i && String(i.key).toUpperCase() !== key);
      }
    });
  }

  BetterJira.IssueStore = {
    issueMetadataMap,
    activeSprintCache,
    loadedHistoricalSprints,
    userOverridesMap,
    getCachedIssue: (key) => issueMetadataMap.get(String(key || '').toUpperCase()),
    getAllIssues: () => Array.from(issueMetadataMap.values()),
    clearUserOverrides,
    mergeAndCacheIssue,
    normalizeJiraIssue,
    isSubtaskIssue,
    moveIssueInSprintStore,
    appendHistoricalSprintToState,
    removeHistoricalSprint,
    getLoadedHistoricalSprints: () => loadedHistoricalSprints,
    getActiveSprintCache: (key) => activeSprintCache.get(key),
    getSprintIssueCache: (key) => activeSprintCache.get(key),
    setActiveSprintCache: (key, val) => activeSprintCache.set(key, val),
    getBoardId: () => cachedBoardId,
    setBoardId: (id) => { cachedBoardId = id; },
    getClosedSprints: () => cachedClosedSprints,
    setClosedSprints: (list) => { cachedClosedSprints = list; },
    getStoryPointsFieldId: () => cachedStoryPointsFieldId,
    setStoryPointsFieldId: (id) => { cachedStoryPointsFieldId = id; },
    getBoardSprints: () => cachedBoardSprints,
    setBoardSprints: (list) => { cachedBoardSprints = list; },
    getProjectIssueTypes: () => cachedProjectIssueTypes,
    setProjectIssueTypes: (types) => {
      if (Array.isArray(types)) cachedProjectIssueTypes = types;
    }
  };
})();
