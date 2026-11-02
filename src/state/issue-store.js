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
    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants } = BetterJira.AssigneeUtils;

    const key = primaryIss.key.toUpperCase();
    const existing = secondaryIss || issueMetadataMap.get(key) || null;
    if (!existing) {
      const copy = {
        ...primaryIss,
        key,
        assigneeTokens: Array.from(new Set(primaryIss.assigneeTokens || []))
      };
      issueMetadataMap.set(key, copy);
      return copy;
    }

    const domSide = primaryIss.fromDom ? primaryIss : existing.fromDom ? existing : primaryIss;
    const apiSide = !primaryIss.fromDom ? primaryIss : !existing.fromDom ? existing : null;

    const isUnassigned =
      domSide.isUnassigned !== undefined
        ? domSide.isUnassigned
        : apiSide && apiSide.isUnassigned !== undefined
        ? apiSide.isUnassigned
        : isUnassignedText(primaryIss.assigneeName);

    let assigneeName = '未指派';
    if (!isUnassigned) {
      const apiName = apiSide && !isUnassignedText(apiSide.assigneeName) ? apiSide.assigneeName : '';
      const domName = domSide && !isUnassignedText(domSide.assigneeName) ? domSide.assigneeName : '';
      assigneeName =
        apiName && apiName.length >= domName.length
          ? apiName
          : domName || apiName || '已指派';
    }

    const assigneeInitials = isUnassigned
      ? ''
      : (domSide && domSide.assigneeInitials) ||
        (existing && existing.assigneeInitials) ||
        (primaryIss && primaryIss.assigneeInitials) ||
        deriveInitialsVariants(assigneeName)[0] ||
        '';

    const assigneeBgColor = isUnassigned
      ? ''
      : (domSide && domSide.assigneeBgColor) ||
        (existing && existing.assigneeBgColor) ||
        (primaryIss && primaryIss.assigneeBgColor) ||
        '';

    const assigneeAvatar = isUnassigned
      ? ''
      : (primaryIss.assigneeAvatar && !/issuetype|\/type\//i.test(primaryIss.assigneeAvatar)
          ? primaryIss.assigneeAvatar
          : '') ||
        (existing.assigneeAvatar && !/issuetype|\/type\//i.test(existing.assigneeAvatar)
          ? existing.assigneeAvatar
          : '');

    const tokenSet = new Set([
      ...(primaryIss.assigneeTokens || []),
      ...(existing.assigneeTokens || [])
    ]);
    if (!isUnassigned) {
      if (assigneeName) tokenSet.add(assigneeName.toLowerCase());
      if (assigneeInitials) tokenSet.add(assigneeInitials.toLowerCase());
      deriveInitialsVariants(assigneeName, assigneeInitials).forEach((v) =>
        tokenSet.add(v.toLowerCase())
      );
    }

    const merged = {
      ...existing,
      ...primaryIss,
      key,
      summary:
        apiSide && apiSide.summary && isTruncatedDuplicateOf(primaryIss.summary, apiSide.summary)
          ? apiSide.summary
          : primaryIss.summary || existing.summary,
      statusName: (domSide && domSide.statusName) || primaryIss.statusName || existing.statusName,
      statusCategory:
        (domSide && domSide.statusCategory) || primaryIss.statusCategory || existing.statusCategory,
      issueTypeIcon: primaryIss.issueTypeIcon || existing.issueTypeIcon,
      issueTypeName: primaryIss.issueTypeName || existing.issueTypeName,
      priorityIcon: primaryIss.priorityIcon || existing.priorityIcon,
      prioritySvg: primaryIss.prioritySvg || existing.prioritySvg,
      priorityName: primaryIss.priorityName || existing.priorityName,
      parentKey: primaryIss.parentKey || existing.parentKey,
      parentSummary: primaryIss.parentSummary || existing.parentSummary,
      dueDate: primaryIss.dueDate || existing.dueDate,
      storyPoints:
        primaryIss.storyPoints !== null && primaryIss.storyPoints !== undefined
          ? primaryIss.storyPoints
          : existing.storyPoints !== null && existing.storyPoints !== undefined
          ? existing.storyPoints
          : null,
      isUnassigned,
      assigneeName,
      assigneeInitials,
      assigneeBgColor,
      assigneeAvatar,
      assigneeTokens: Array.from(tokenSet)
    };

    issueMetadataMap.set(key, merged);
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
      storyPoints
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

  BetterJira.IssueStore = {
    issueMetadataMap,
    activeSprintCache,
    loadedHistoricalSprints,
    mergeAndCacheIssue,
    normalizeJiraIssue,
    appendHistoricalSprintToState,
    removeHistoricalSprint,
    getLoadedHistoricalSprints: () => loadedHistoricalSprints,
    getActiveSprintCache: (key) => activeSprintCache.get(key),
    setActiveSprintCache: (key, val) => activeSprintCache.set(key, val),
    getBoardId: () => cachedBoardId,
    setBoardId: (id) => { cachedBoardId = id; },
    getClosedSprints: () => cachedClosedSprints,
    setClosedSprints: (list) => { cachedClosedSprints = list; },
    getStoryPointsFieldId: () => cachedStoryPointsFieldId,
    setStoryPointsFieldId: (id) => { cachedStoryPointsFieldId = id; },
    getBoardSprints: () => cachedBoardSprints,
    setBoardSprints: (list) => { cachedBoardSprints = list; }
  };
})();
