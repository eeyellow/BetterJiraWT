/**
 * @fileoverview Jira Agile & REST API 服務整合模組
 * 負責看板 Context 偵測、Story Points 欄位探測、衝刺卡片抓取與單一卡片詳細資料請求。
 * @module services/jira-api
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  const SPRINT_API_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘快取
  const SPRINT_API_FAILURE_COOLDOWN_MS = 60 * 1000; // 失敗退避 1 分鐘
  const sprintActiveApiCache = new Map(); // cacheKey -> { data: Array, timestamp: number }
  const inFlightActiveSprintRequests = new Map(); // cacheKey -> Promise
  const sprintFailedCooldownMap = new Map(); // cacheKey -> timestamp
  const boardBacklogPrefetchCache = new Map(); // boardId -> { data: Array, timestamp: number }
  const inFlightBoardBacklogRequests = new Map(); // boardId -> Promise

  /**
   * 從目前網址或頁面偵測 Jira Board ID 與 Project Key
   *
   * @returns {Promise<{boardId: string|null, projectKey: string}>} 看板識別碼與專案鍵值
   */
  async function detectJiraContext() {
    const { IssueStore } = BetterJira;
    const href = window.location.href;
    const boardMatch = href.match(/\/boards\/(\d+)/i) || href.match(/[?&]rapidView=(\d+)/i);
    const projectMatch =
      href.match(/\/projects\/([^/?#]+)/i) || href.match(/[?&]projectKey=([^&#]+)/i);

    let boardId = boardMatch ? boardMatch[1] : IssueStore.getBoardId();
    const projectKey = projectMatch ? decodeURIComponent(projectMatch[1]) : '';

    if (!boardId && projectKey) {
      try {
        const res = await fetch(
          `${window.location.origin}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.values) && data.values.length > 0) {
            const scrumBoard = data.values.find((b) => b.type === 'scrum') || data.values[0];
            boardId = String(scrumBoard.id);
          }
        }
      } catch {
        // ignore
      }
    }

    if (boardId) {
      IssueStore.setBoardId(boardId);
    }

    return { boardId, projectKey };
  }

  /**
   * 動態向 Jira API 探測當前環境 Story Points 專用的 Custom Field ID (如 customfield_10016 等)
   *
   * @returns {Promise<string|null>} 找到的自訂欄位 ID，未找到則回傳 null
   */
  async function detectStoryPointsCustomField() {
    const { IssueStore } = BetterJira;
    const cached = IssueStore.getStoryPointsFieldId();
    if (cached) return cached;

    const endpoints = ['/rest/api/3/field', '/rest/api/2/field'];
    for (const ep of endpoints) {
      try {
        const res = await fetch(`${window.location.origin}${ep}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (res.ok) {
          const fields = await res.json();
          if (Array.isArray(fields)) {
            const sp = fields.find(
              (f) =>
                f.name &&
                (/story\s*points?/i.test(f.name) ||
                  /故事點數|故事點|估算|點數/i.test(f.name) ||
                  (f.schema && f.schema.custom && f.schema.custom.includes('story-points')))
            );
            if (sp && sp.id) {
              IssueStore.setStoryPointsFieldId(sp.id);
              return sp.id;
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * 透過 Agile API 取得指定看板的 active 與 future sprints 清單
   *
   * @param {string|number} boardId - Jira 看板 ID
   * @returns {Promise<Array<Object>>} active 與 future 衝刺清單
   */
  async function fetchActiveAndFutureSprintsForBoard(boardId) {
    if (!boardId) return [];
    const { IssueStore } = BetterJira;
    const cached = IssueStore.getBoardSprints();
    if (cached) return cached;

    try {
      const res = await fetch(
        `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?state=active,future&maxResults=100`,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.values)) {
          IssueStore.setBoardSprints(data.values);
          return data.values;
        }
      }
    } catch {
      // ignore
    }
    return [];
  }

  /**
   * 預先抓取看板 Backlog 頁面全部未結束問題 (包含 Future Sprints 與待辦池卡片)，
   * 並依據卡片內所屬之 Sprint 自動分類注入快取，徹底防範收合衝刺或未開始衝刺為空的問題。
   *
   * @param {string|number} boardId - Jira 看板 ID
   * @param {boolean} [forceRefresh=false] - 是否強制重新抓取
   * @returns {Promise<Array<Object>>} 正規化後的看板 Backlog 卡片清單
   */
  async function prefetchBoardBacklogIssues(boardId, forceRefresh = false) {
    if (!boardId) return [];
    const { IssueStore } = BetterJira;
    const now = Date.now();
    const cacheKey = String(boardId);

    if (!forceRefresh) {
      const cached = boardBacklogPrefetchCache.get(cacheKey);
      if (cached && (now - cached.timestamp < SPRINT_API_CACHE_TTL_MS)) {
        return cached.data;
      }
    }

    if (inFlightBoardBacklogRequests.has(cacheKey)) {
      return await inFlightBoardBacklogRequests.get(cacheKey);
    }

    const prefetchPromise = (async () => {
      try {
        await detectStoryPointsCustomField();
        const cachedFieldId = IssueStore.getStoryPointsFieldId();
        const baseFields = [
          'summary', 'status', 'issuetype', 'priority', 'assignee', 'parent', 'duedate',
          'sprint', 'customfield_10020', 'customfield_10016', 'customfield_10026',
          cachedFieldId
        ].filter(Boolean);

        const endpoints = [
          `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/backlog?maxResults=500&fields=${baseFields.join(',')}`,
          `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue?maxResults=500&fields=${baseFields.join(',')}`
        ];

        let rawIssues = [];
        for (const ep of endpoints) {
          try {
            const res = await fetch(ep, {
              credentials: 'include',
              headers: { Accept: 'application/json' }
            });
            if (res.ok) {
              const data = await res.json();
              if (data && Array.isArray(data.issues)) {
                rawIssues = data.issues;
                break;
              }
            }
          } catch {
            // ignore
          }
        }

        // 若直接端點未取得，使用 JQL 搜尋看板中所有未完成或 Future 的卡片
        if (rawIssues.length === 0) {
          const { projectKey } = await detectJiraContext();
          const jql = projectKey
            ? `project = "${projectKey}" AND (sprint in openSprints() OR sprint in futureSprints() OR sprint is EMPTY) AND statusCategory != Done ORDER BY rank ASC, key ASC`
            : `(sprint in openSprints() OR sprint in futureSprints() OR sprint is EMPTY) AND statusCategory != Done ORDER BY rank ASC, key ASC`;

          const jqlEndpoints = [
            `${window.location.origin}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=500&fields=${baseFields.join(',')}`,
            `${window.location.origin}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=500&fields=${baseFields.join(',')}`
          ];

          for (const ep of jqlEndpoints) {
            try {
              const res = await fetch(ep, {
                credentials: 'include',
                headers: { Accept: 'application/json' }
              });
              if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.issues)) {
                  rawIssues = data.issues;
                  break;
                }
              }
            } catch {
              // ignore
            }
          }
        }

        if (rawIssues.length === 0) {
          return [];
        }

        const normalizedIssues = rawIssues.map(IssueStore.normalizeJiraIssue);
        boardBacklogPrefetchCache.set(cacheKey, { data: normalizedIssues, timestamp: Date.now() });

        // 依據每張卡片的 sprint 資訊（id 或 name）分組並注入快取
        const sprintBuckets = new Map();
        normalizedIssues.forEach((iss, index) => {
          const rawItem = rawIssues[index];
          IssueStore.mergeAndCacheIssue(iss);

          const sprintObj = (rawItem && rawItem.fields && rawItem.fields.sprint) || null;
          const sprintsArr = (rawItem && rawItem.fields && Array.isArray(rawItem.fields.customfield_10020))
            ? rawItem.fields.customfield_10020
            : null;

          const matchedSprints = [];
          if (sprintObj) matchedSprints.push(sprintObj);
          if (sprintsArr) {
            sprintsArr.forEach((s) => {
              if (s && !matchedSprints.some((m) => String(m.id) === String(s.id))) {
                matchedSprints.push(s);
              }
            });
          }

          if (matchedSprints.length === 0) {
            let bList = sprintBuckets.get('backlog');
            if (!bList) {
              bList = [];
              sprintBuckets.set('backlog', bList);
            }
            bList.push(iss);
          } else {
            matchedSprints.forEach((sp) => {
              if (sp.id) {
                const idKey = `sprint_${sp.id}`;
                let listById = sprintBuckets.get(idKey);
                if (!listById) {
                  listById = [];
                  sprintBuckets.set(idKey, listById);
                }
                listById.push(iss);
              }
              if (sp.name) {
                const cleanSpName = (BetterJira.TextUtils && typeof BetterJira.TextUtils.cleanSprintTitle === 'function')
                  ? BetterJira.TextUtils.cleanSprintTitle(sp.name).toLowerCase()
                  : String(sp.name).toLowerCase();
                const nameKey = `title_${cleanSpName}`;
                let listByName = sprintBuckets.get(nameKey);
                if (!listByName) {
                  listByName = [];
                  sprintBuckets.set(nameKey, listByName);
                }
                listByName.push(iss);
              }
            });
          }
        });

        // 將分組好的卡片寫入對應的 ActiveSprintCache
        sprintBuckets.forEach((issuesList, bucketKey) => {
          sprintActiveApiCache.set(bucketKey, { data: issuesList, timestamp: Date.now() });
          sprintFailedCooldownMap.delete(bucketKey);

          let cached = IssueStore.getActiveSprintCache(bucketKey);
          if (cached) {
            cached.allApiIssues = issuesList;
            if (!cached.masterIssuesMap) cached.masterIssuesMap = new Map();
            issuesList.forEach((i) => cached.masterIssuesMap.set(i.key, i));
            cached.rawIssues = Array.from(cached.masterIssuesMap.values());
            cached.fromApi = true;
            cached.apiSyncing = false;
            cached.lastSyncTime = Date.now();
          }
        });

        return normalizedIssues;
      } catch {
        return [];
      } finally {
        inFlightBoardBacklogRequests.delete(cacheKey);
      }
    })();

    inFlightBoardBacklogRequests.set(cacheKey, prefetchPromise);
    return await prefetchPromise;
  }

  /**
   * 透過 Jira Agile API 取得看板最近已結束 (state=closed) 的 Sprint 清單 (由新到舊排序)
   *
   * @param {boolean} [forceRefresh=false] - 是否強制重新發起網路請求
   * @returns {Promise<Array<Object>>} 已結束歷史衝刺陣列
   */
  async function fetchClosedSprintsForBoard(forceRefresh = false) {
    const { IssueStore } = BetterJira;
    const cached = IssueStore.getClosedSprints();
    if (cached && !forceRefresh) {
      return cached;
    }

    const { boardId } = await detectJiraContext();
    if (!boardId) {
      return [];
    }

    try {
      const allClosed = [];
      let startAt = 0;
      const maxResults = 50;
      let pageCount = 0;

      while (pageCount < 6) {
        pageCount += 1;
        const url = `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?state=closed&startAt=${startAt}&maxResults=${maxResults}`;
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (!res.ok) break;
        const data = await res.json();
        const values = Array.isArray(data.values) ? data.values : [];
        allClosed.push(...values);

        if (data.isLast || values.length < maxResults) {
          break;
        }
        startAt += values.length;
      }

      // 依結束時間或 ID 由新到舊排序
      allClosed.sort((a, b) => {
        const dateA = new Date(a.completeDate || a.endDate || 0).getTime();
        const dateB = new Date(b.completeDate || b.endDate || 0).getTime();
        if (dateB !== dateA) return dateB - dateA;
        return (Number(b.id) || 0) - (Number(a.id) || 0);
      });

      IssueStore.setClosedSprints(allClosed);
      return allClosed;
    } catch {
      return [];
    }
  }

  /**
   * 根據使用者輸入的 Sprint 名稱或選定的 Sprint 物件，透過 Jira API 取得已結束 Sprint 的資料與卡片
   *
   * @param {string} sprintNameInput - 衝刺名稱
   * @param {Object|null} [explicitSprintObj=null] - 已知之 Sprint 物件
   * @returns {Promise<Object>} 完整歷史衝刺資料物件包含卡片陣列
   */
  async function fetchHistoricalSprintData(sprintNameInput, explicitSprintObj = null) {
    const { IssueStore } = BetterJira;
    const trimmedName = (sprintNameInput || '').trim();
    const { boardId, projectKey } = await detectJiraContext();

    await detectStoryPointsCustomField();
    const cachedFieldId = IssueStore.getStoryPointsFieldId();

    let matchedSprint = explicitSprintObj;

    // 1. 若未直接指定 Sprint 物件，先從看板已結束 Sprint 清單尋找匹配名稱
    if (!matchedSprint && trimmedName) {
      const closedList = await fetchClosedSprintsForBoard();
      const lowerQuery = trimmedName.toLowerCase();
      matchedSprint =
        closedList.find((s) => (s.name || '').trim().toLowerCase() === lowerQuery) ||
        closedList.find((s) => (s.name || '').toLowerCase().includes(lowerQuery)) ||
        null;
    }

    const fieldsParam = [
      'summary',
      'status',
      'issuetype',
      'priority',
      'assignee',
      'parent',
      'duedate',
      'customfield_10016',
      'customfield_10026',
      'customfield_10004',
      'customfield_10008',
      'customfield_10028',
      'customfield_10024',
      cachedFieldId
    ]
      .filter(Boolean)
      .join(',');

    // 2. 若找到對應的 Agile Sprint ID，優先呼叫 Agile Sprint Issues API
    if (matchedSprint && matchedSprint.id) {
      try {
        const res = await fetch(
          `${window.location.origin}/rest/agile/1.0/sprint/${encodeURIComponent(matchedSprint.id)}/issue?maxResults=200&fields=${fieldsParam}`,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = await res.json();
          const issues = (data.issues || []).map(IssueStore.normalizeJiraIssue);
          return {
            key: `history_sprint_${matchedSprint.id}`,
            sprintId: matchedSprint.id,
            title: matchedSprint.name || trimmedName,
            state: 'closed',
            startDate: matchedSprint.startDate || '',
            endDate: matchedSprint.endDate || '',
            completeDate: matchedSprint.completeDate || '',
            goal: matchedSprint.goal || '',
            issues,
            filterKeyword: ''
          };
        }
      } catch {
        // 繼續嘗試 JQL 備援
      }
    }

    // 3. 備援機制：透過 JQL 搜尋該 Sprint 名稱下的所有卡片
    const targetName = (matchedSprint && matchedSprint.name) || trimmedName;
    const escapedJqlName = targetName.replace(/"/g, '\\"');
    const jqlCandidates = [];
    if (projectKey) {
      jqlCandidates.push(`project = "${projectKey}" AND sprint = "${escapedJqlName}" ORDER BY key ASC`);
    }
    jqlCandidates.push(`sprint = "${escapedJqlName}" ORDER BY key ASC`);

    for (const jql of jqlCandidates) {
      const endpoints = [];
      if (boardId) {
        endpoints.push({
          url: `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/issue?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        });
      }
      endpoints.push(
        {
          url: `${window.location.origin}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        },
        {
          url: `${window.location.origin}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        }
      );

      for (const ep of endpoints) {
        try {
          const res = await fetch(ep.url, {
            method: ep.method,
            credentials: 'include',
            headers: { Accept: 'application/json' }
          });
          if (!res.ok) continue;
          const data = await res.json();
          if (data && Array.isArray(data.issues)) {
            const issues = data.issues.map(IssueStore.normalizeJiraIssue);
            const resolvedKey =
              matchedSprint && matchedSprint.id
                ? `history_sprint_${matchedSprint.id}`
                : `history_sprint_${targetName.toLowerCase().replace(/\s+/g, '_')}`;
            return {
              key: resolvedKey,
              sprintId: matchedSprint ? matchedSprint.id : null,
              title: matchedSprint ? matchedSprint.name : targetName,
              state: 'closed',
              startDate: matchedSprint ? matchedSprint.startDate || '' : '',
              endDate: matchedSprint ? matchedSprint.endDate || '' : '',
              completeDate: matchedSprint ? matchedSprint.completeDate || '' : '',
              goal: matchedSprint ? matchedSprint.goal || '' : '',
              issues,
              filterKeyword: ''
            };
          }
        } catch {
          // try next endpoint
        }
      }
    }

    throw new Error(`找不到名稱為「${targetName}」的已結束 Sprint 或無權限存取`);
  }

  /**
   * 透過 Jira Agile REST API 抓取未結束衝刺的完整卡片資料
   * 具備 5 分鐘快取、In-Flight 單例去重、失敗退避與自動 400 欄位降級機制，
   * 絕對防範高頻重複發送網路請求。
   *
   * @param {Object} item - 衝刺項目物件包含 DOM branch 與 meta
   * @param {boolean} [forceRefresh=false] - 是否強制重新發起網路請求
   * @returns {Promise<Array<Object>>} 正規化後的卡片物件陣列
   */
  async function fetchSprintIssuesForActive(item, forceRefresh = false) {
    const { IssueStore, TextUtils } = BetterJira;
    let sprintId = item.meta.sprintId || (item.sprintEl && item.sprintEl.getAttribute('data-sprint-id'));
    const cleanTitle = TextUtils.cleanSprintTitle(item.meta.title);
    const itemKey = item.meta.key || `${cleanTitle}`;
    const targetCacheKey = sprintId ? `sprint_${sprintId}` : `title_${cleanTitle}`;

    const now = Date.now();

    // 1. 若非強制重新整理，檢查 5 分鐘記憶體快取
    if (!forceRefresh) {
      const cachedEntry = sprintActiveApiCache.get(targetCacheKey) || sprintActiveApiCache.get(itemKey);
      if (cachedEntry && (now - cachedEntry.timestamp < SPRINT_API_CACHE_TTL_MS)) {
        return cachedEntry.data;
      }
      // 檢查是否處於失敗冷卻退避期間 (60 秒內禁止重複發送請求)
      const failedTime = sprintFailedCooldownMap.get(targetCacheKey) || sprintFailedCooldownMap.get(itemKey);
      if (failedTime && (now - failedTime < SPRINT_API_FAILURE_COOLDOWN_MS)) {
        return cachedEntry ? cachedEntry.data : [];
      }
    }

    // 2. 檢查是否有進行中的相同請求 (In-Flight Promise 去重)
    const activeFlight = inFlightActiveSprintRequests.get(targetCacheKey) || inFlightActiveSprintRequests.get(itemKey);
    if (activeFlight) {
      return await activeFlight;
    }

    // 建立新的 In-Flight Promise
    const requestPromise = (async () => {
      try {
        const { boardId, projectKey } = await detectJiraContext();

        await detectStoryPointsCustomField();
        const cachedFieldId = IssueStore.getStoryPointsFieldId();

        const baseFields = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'parent', 'duedate'];
        const fullFields = [
          ...baseFields,
          'customfield_10016',
          'customfield_10026',
          'customfield_10004',
          'customfield_10008',
          'customfield_10028',
          'customfield_10024',
          cachedFieldId
        ].filter(Boolean);

        // a. 若無明確 sprintId，從當前看板的 active/future sprints 清單比對
        if (!sprintId && boardId && cleanTitle) {
          try {
            const boardSprints = await fetchActiveAndFutureSprintsForBoard(boardId);
            const lowerTarget = cleanTitle.toLowerCase();
            const found =
              boardSprints.find((s) => (s.name || '').trim().toLowerCase() === lowerTarget) ||
              boardSprints.find((s) => (s.name || '').trim().toLowerCase().includes(lowerTarget)) ||
              boardSprints.find((s) => lowerTarget.includes((s.name || '').trim().toLowerCase()));
            if (found && found.id) {
              sprintId = String(found.id);
              item.meta.sprintId = sprintId;
            }
          } catch {
            // ignore
          }
        }

        const effectiveKey = sprintId ? `sprint_${sprintId}` : targetCacheKey;

        // b. 若找到 sprintId，優先呼叫 Agile Sprint Issues API (帶自動 400 欄位降級重試)
        if (sprintId) {
          for (const fields of [fullFields.join(','), baseFields.join(',')]) {
            try {
              const res = await fetch(
                `${window.location.origin}/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue?maxResults=200&fields=${fields}`,
                { credentials: 'include', headers: { Accept: 'application/json' } }
              );
              if (res.ok) {
                const data = await res.json();
                const issues = Array.isArray(data.issues) ? data.issues.map(IssueStore.normalizeJiraIssue) : [];
                sprintActiveApiCache.set(effectiveKey, { data: issues, timestamp: Date.now() });
                sprintActiveApiCache.set(itemKey, { data: issues, timestamp: Date.now() });
                sprintFailedCooldownMap.delete(effectiveKey);
                sprintFailedCooldownMap.delete(itemKey);
                return issues;
              }
              // 若為 400 Bad Request，繼續嘗試下一個基本欄位 fallback
              if (res.status !== 400) {
                break;
              }
            } catch {
              break;
            }
          }
        }

        // c. JQL 搜尋備援 (支援以數值 sprintId 與文字名稱檢索，全面支援未開始之 Future Sprint)
        const jqlCandidates = [];
        if (sprintId) {
          if (projectKey) {
            jqlCandidates.push(`project = "${projectKey}" AND sprint = ${sprintId} ORDER BY key ASC`);
          }
          jqlCandidates.push(`sprint = ${sprintId} ORDER BY key ASC`);
        }
        if (cleanTitle) {
          const escaped = cleanTitle.replace(/"/g, '\\"');
          if (projectKey) {
            jqlCandidates.push(`project = "${projectKey}" AND sprint = "${escaped}" ORDER BY key ASC`);
          }
          jqlCandidates.push(`sprint = "${escaped}" ORDER BY key ASC`);
        }

        for (const jql of jqlCandidates) {
          const searchEndpoints = [
            `${window.location.origin}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${baseFields.join(',')}`,
            `${window.location.origin}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${baseFields.join(',')}`
          ];

          for (const ep of searchEndpoints) {
            try {
              const res = await fetch(ep, {
                credentials: 'include',
                headers: { Accept: 'application/json' }
              });
              if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.issues)) {
                  const issues = data.issues.map(IssueStore.normalizeJiraIssue);
                  sprintActiveApiCache.set(effectiveKey, { data: issues, timestamp: Date.now() });
                  sprintActiveApiCache.set(itemKey, { data: issues, timestamp: Date.now() });
                  sprintFailedCooldownMap.delete(effectiveKey);
                  sprintFailedCooldownMap.delete(itemKey);
                  return issues;
                }
              }
            } catch {
              // ignore
            }
          }
        }

        // d. 看板 Backlog / 待辦池備援 (從 board backlog 提取)
        if (boardId) {
          try {
            const backlogIssues = await prefetchBoardBacklogIssues(boardId);
            if (Array.isArray(backlogIssues) && backlogIssues.length > 0) {
              const fromBucket = sprintActiveApiCache.get(effectiveKey) || sprintActiveApiCache.get(itemKey);
              if (fromBucket && Array.isArray(fromBucket.data) && fromBucket.data.length > 0) {
                return fromBucket.data;
              }
            }
          } catch {
            // ignore
          }
        }

        // 若無資料，記錄失敗冷卻退避 (60 秒內不重試)
        sprintFailedCooldownMap.set(effectiveKey, Date.now());
        sprintFailedCooldownMap.set(itemKey, Date.now());
        return [];
      } catch (err) {
        sprintFailedCooldownMap.set(targetCacheKey, Date.now());
        sprintFailedCooldownMap.set(itemKey, Date.now());
        return [];
      } finally {
        inFlightActiveSprintRequests.delete(targetCacheKey);
        inFlightActiveSprintRequests.delete(itemKey);
      }
    })();

    inFlightActiveSprintRequests.set(targetCacheKey, requestPromise);
    inFlightActiveSprintRequests.set(itemKey, requestPromise);

    return await requestPromise;
  }

  /**
   * 透過 Jira REST API 取得單一工作項目的完整欄位與渲染後內容 (說明、留言、子任務等)
   *
   * @param {string} issueKey - 卡片編號 (例如 "WMC-1234")
   * @returns {Promise<Object|null>} 包含 fields 與 renderedFields 的 Jira API 資料物件
   */
  async function fetchIssueDetails(issueKey) {
    if (!issueKey) return null;
    const endpoints = [
      `/rest/api/2/issue/${encodeURIComponent(issueKey)}?expand=renderedFields,names`,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?expand=renderedFields,names`
    ];

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${window.location.origin}${ep}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (res.ok) {
          const data = await res.json();
          if (data && (data.fields || data.renderedFields)) {
            return data;
          }
        }
      } catch {
        // try next endpoint
      }
    }
    return null;
  }

  /**
   * 透過 Jira REST API 取得指定卡片目前編輯畫面 (Edit Screen) 上允許修改的所有欄位 metadata
   *
   * @param {string} issueKey - 卡片編號
   * @returns {Promise<Object|null>} 包含允許欄位的 editmeta fields 物件
   */
  async function fetchIssueEditMeta(issueKey) {
    if (!issueKey) return null;
    try {
      const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}/editmeta`, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        return (data && data.fields) || {};
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * 透過 Jira Agile API 更新 Story Points 估算值
   * 專為 Story Points 未配置在 Issue Edit Screen 上的 Jira 看板專案設計
   *
   * @param {string} issueKey - 卡片編號
   * @param {number|null} points - 點數 (null 代表清空)
   * @param {string|number|null} [boardId=null] - 看板 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function updateIssueEstimation(issueKey, points, boardId = null) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    const { IssueStore } = BetterJira;
    let bid = boardId || (IssueStore && typeof IssueStore.getBoardId === 'function' ? IssueStore.getBoardId() : null);
    if (!bid && typeof window !== 'undefined' && window.location && window.location.href) {
      const match = window.location.href.match(/\/boards\/(\d+)/i) || window.location.href.match(/[?&]rapidView=(\d+)/i);
      if (match) {
        bid = match[1];
        if (IssueStore && typeof IssueStore.setBoardId === 'function') {
          IssueStore.setBoardId(bid);
        }
      }
    }
    const query = bid ? `?boardId=${encodeURIComponent(bid)}` : '';
    const endpoint = `${window.location.origin}/rest/agile/1.0/issue/${encodeURIComponent(issueKey)}/estimation${query}`;

    const numVal = points !== null && points !== undefined && points !== '' && !isNaN(points) ? Number(points) : null;
    const bodyValue = numVal !== null ? numVal : '';

    try {
      const res = await fetch(endpoint, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify({ value: bodyValue })
      });
      if (res.ok || res.status === 204) {
        return { success: true };
      }
      const err = await res.json().catch(() => null);
      const errMsg = err && err.errorMessages ? err.errorMessages.join(', ') : 'Agile 估算值更新失敗';
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : '估算值請求失敗' };
    }
  }

  /**
   * 透過 Jira REST API 更新指定 Issue 的欄位資料 (例如標題、說明、Story Points)
   * 基本欄位 (summary, description) 與 Agile 估算值 (storyPoints) 分流處理，
   * 避免將自訂欄位帶入 Issue Edit Screen 請求導致 Jira Screen 驗證錯誤。
   *
   * @param {string} issueKey - 卡片編號 (例如 "WMC-1234")
   * @param {Object} updates - 更新欄位
   * @param {string} [updates.summary] - 新標題
   * @param {string} [updates.description] - 新說明
   * @param {number|null} [updates.storyPoints] - 新點數
   * @returns {Promise<{success: boolean, warning?: string, error?: string}>} 更新結果
   */
  async function updateIssue(issueKey, updates = {}) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };

    const payload = { fields: {} };
    if (updates.summary !== undefined && updates.summary !== null) {
      payload.fields.summary = updates.summary.trim();
    }
    if (updates.description !== undefined && updates.description !== null) {
      payload.fields.description = updates.description;
    }

    let coreFieldsSuccess = true;
    let warningMsg = '';

    // 1. 若有 summary 或 description，發送至標準 Jira Issue 更新端點
    // 嚴格保證不包含 customfield_XXXX，徹底杜絕 Screen Scheme 阻擋
    if (Object.keys(payload.fields).length > 0) {
      try {
        const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Atlassian-Token': 'no-check'
          },
          body: JSON.stringify(payload)
        });

        if (res.ok || res.status === 204) {
          coreFieldsSuccess = true;
        } else {
          const errJson = await res.json().catch(() => null);
          let errMsg = 'Jira 欄位更新失敗';
          if (errJson) {
            if (Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
              errMsg = errJson.errorMessages.join(', ');
            } else if (errJson.errors && typeof errJson.errors === 'object') {
              errMsg = Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
            }
          }
          return { success: false, error: errMsg };
        }
      } catch (e) {
        return { success: false, error: e && e.message ? e.message : '網路請求失敗' };
      }
    }

    // 2. 若有 Story Points 需要更新，一律使用不受 Edit Screen 限制的 Jira Agile Estimation API
    if (updates.storyPoints !== undefined) {
      const estRes = await updateIssueEstimation(issueKey, updates.storyPoints);
      if (!estRes.success) {
        if (Object.keys(payload.fields).length > 0) {
          warningMsg = `標題與說明已儲存，但 Story Points 估算值未能同步更新（${estRes.error}）。`;
        } else {
          return { success: false, error: `Story Points 更新失敗：${estRes.error}` };
        }
      }
    }

    return {
      success: coreFieldsSuccess,
      warning: warningMsg || undefined
    };
  }

  /**
   * 取得指定 Issue 可執行的狀態轉換 (Transitions)
   *
   * @param {string} issueKey - 卡片編號
   * @returns {Promise<Array<Object>>} 可用狀態轉換清單
   */
  async function fetchIssueTransitions(issueKey) {
    if (!issueKey) return [];
    try {
      const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        return Array.isArray(data.transitions) ? data.transitions : [];
      }
    } catch {
      // ignore
    }
    return [];
  }

  /**
   * 執行狀態轉換
   *
   * @param {string} issueKey - 卡片編號
   * @param {string} transitionId - 轉換 ID
   * @returns {Promise<{success: boolean, error?: string}>} 轉換結果
   */
  async function transitionIssue(issueKey, transitionId) {
    if (!issueKey || !transitionId) return { success: false };
    try {
      const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}/transitions`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify({ transition: { id: transitionId } })
      });
      if (res.ok || res.status === 204) {
        return { success: true };
      }
      const errJson = await res.json().catch(() => null);
      const errMsg = errJson && errJson.errorMessages ? errJson.errorMessages.join(', ') : '狀態轉換失敗';
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : '狀態轉換網路請求失敗' };
    }
  }

  /**
   * 發送訊息通知 Background Service Worker 切換 Chrome Extension 擴充圖示與標題
   *
   * @param {string} themeStyle - 當前樣式名稱 (Default / Bootstrap / MaterialDesign)
   * @param {boolean} [enabled=true] - 擴充功能是否啟用
   */
  function syncExtensionIcon(enabled = true) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'BETTER_JIRA_WT_UPDATE_ICON',
          enabled: enabled !== false
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  }

  /**
   * 向 Jira REST API 查詢當前專案或站點定義之全部問題類型 (包含 Story, Bug, Task, Epic 及自訂類型)
   *
   * @returns {Promise<Array<Object>>} 問題類型清單
   */
  async function fetchProjectIssueTypes() {
    const { IssueStore } = BetterJira;
    if (typeof window === 'undefined') return [];

    const cachedTypes = IssueStore.getProjectIssueTypes && IssueStore.getProjectIssueTypes();
    if (Array.isArray(cachedTypes) && cachedTypes.length > 0) {
      return cachedTypes;
    }

    try {
      const { projectKey } = await detectJiraContext();
      let types = [];

      // 1. 優先嘗試當前專案的 issueTypes (createmeta)
      if (projectKey) {
        try {
          const res = await fetch(
            `${window.location.origin}/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&maxResults=50`,
            { credentials: 'include', headers: { Accept: 'application/json' } }
          );
          if (res.ok) {
            const data = await res.json();
            const proj = data && Array.isArray(data.projects) ? data.projects[0] : null;
            if (proj && Array.isArray(proj.issuetypes) && proj.issuetypes.length > 0) {
              types = proj.issuetypes;
            }
          }
        } catch {
          // ignore
        }
      }

      // 2. 若 createmeta 未取得，回退向全站 /rest/api/2/issuetype 請求
      if (types.length === 0) {
        try {
          const res = await fetch(
            `${window.location.origin}/rest/api/2/issuetype`,
            { credentials: 'include', headers: { Accept: 'application/json' } }
          );
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) {
              types = data;
            }
          }
        } catch {
          // ignore
        }
      }

      if (Array.isArray(types) && types.length > 0) {
        const normalized = types.map((t) => ({
          id: String(t.id || ''),
          name: String(t.name || '').trim(),
          subtask: Boolean(t.subtask),
          iconUrl: String(t.iconUrl || ''),
          avatarId: t.avatarId ? String(t.avatarId) : ''
        }));
        if (IssueStore.setProjectIssueTypes) {
          IssueStore.setProjectIssueTypes(normalized);
        }
        return normalized;
      }
    } catch {
      // ignore
    }

    return [];
  }

  /**
   * 取得 Jira 系統中定義的可用優先度清單
   * 優先透過 GET /rest/api/2/priority 取得官方清單，若失敗則提供標準備用清單
   *
   * @returns {Promise<Array<{id: string, name: string, iconUrl: string, statusColor?: string}>>}
   */
  let cachedPrioritiesList = null;
  async function fetchPriorities() {
    if (cachedPrioritiesList && cachedPrioritiesList.length > 0) {
      return cachedPrioritiesList;
    }
    try {
      const res = await fetch(`${window.location.origin}/rest/api/2/priority`, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          cachedPrioritiesList = data.map((p) => ({
            id: String(p.id),
            name: p.name,
            iconUrl: p.iconUrl || '',
            statusColor: p.statusColor || ''
          }));
          return cachedPrioritiesList;
        }
      }
    } catch {
      // ignore
    }
    return [
      { id: '1', name: 'Highest', iconUrl: '' },
      { id: '2', name: 'High', iconUrl: '' },
      { id: '3', name: 'Medium', iconUrl: '' },
      { id: '4', name: 'Low', iconUrl: '' },
      { id: '5', name: 'Lowest', iconUrl: '' }
    ];
  }

  /**
   * 透過 Jira REST API 更新指定 Issue 的優先度
   *
   * @param {string} issueKey - 卡片編號
   * @param {Object|string} priorityVal - 優先度物件 ({ id, name }) 或優先度名稱 / ID
   * @returns {Promise<{success: boolean, error?: string}>} 更新結果
   */
  async function updateIssuePriority(issueKey, priorityVal) {
    if (!issueKey || !priorityVal) return { success: false, error: '缺少 issueKey 或優先度資訊' };

    let payloadField = {};
    if (typeof priorityVal === 'object') {
      if (priorityVal.id) {
        payloadField = { id: String(priorityVal.id) };
      } else if (priorityVal.name) {
        payloadField = { name: String(priorityVal.name) };
      }
    } else {
      const strVal = String(priorityVal).trim();
      if (/^\d+$/.test(strVal)) {
        payloadField = { id: strVal };
      } else {
        payloadField = { name: strVal };
      }
    }

    try {
      const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify({ fields: { priority: payloadField } })
      });

      if (res.ok || res.status === 204) {
        return { success: true };
      }

      const errJson = await res.json().catch(() => null);
      let errMsg = '優先度更新失敗';
      if (errJson) {
        if (Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
          errMsg = errJson.errorMessages.join(', ');
        } else if (errJson.errors && typeof errJson.errors === 'object') {
          errMsg = Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
        }
      }
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : '優先度更新網路錯誤' };
    }
  }

  /**
   * 透過 Jira REST API 更新指定 Issue 的經辦人
   * 支援指派特定成員或設為未指派 (Unassigned)
   *
   * @param {string} issueKey - 卡片編號
   * @param {string|null} assigneeName - 經辦人名稱 (傳入 null, 空字串, '未指派' 或 '__UNASSIGNED__' 代表未指派)
   * @param {string|null} [accountId=null] - Jira Cloud 帳號 ID (若有)
   * @returns {Promise<{success: boolean, error?: string}>} 更新結果
   */
  async function updateIssueAssignee(issueKey, assigneeName, accountId = null) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };

    const { AssigneeUtils } = BetterJira;
    const isUnassigned =
      !assigneeName ||
      assigneeName === '__UNASSIGNED__' ||
      assigneeName === '未指派' ||
      (AssigneeUtils && typeof AssigneeUtils.isUnassignedText === 'function' && AssigneeUtils.isUnassignedText(assigneeName));

    const body = isUnassigned
      ? { name: null }
      : accountId
      ? { accountId }
      : { name: assigneeName };

    try {
      // 1. 優先呼叫 Jira 標準專用 /assignee 端點
      const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}/assignee`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify(body)
      });

      if (res.ok || res.status === 204) {
        return { success: true };
      }

      // 2. 若專用端點受限，備用標準 issue 根端點 fields 更新
      const fallbackPayload = {
        fields: {
          assignee: isUnassigned ? null : (accountId ? { accountId } : { name: assigneeName })
        }
      };

      const fallbackRes = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify(fallbackPayload)
      });

      if (fallbackRes.ok || fallbackRes.status === 204) {
        return { success: true };
      }

      const errJson = await fallbackRes.json().catch(() => null);
      let errMsg = '經辦人更新失敗';
      if (errJson) {
        if (Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
          errMsg = errJson.errorMessages.join(', ');
        } else if (errJson.errors && typeof errJson.errors === 'object') {
          errMsg = Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
        }
      }
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : '經辦人更新網路錯誤' };
    }
  }

  /**
   * 取得指定卡片可轉換的問題類型清單
   * 優先從 issue editmeta 的 allowedValues 取得，若無則回退至專案問題類型清單或標準備用清單
   *
   * @param {string} [issueKey] - 卡片編號
   * @returns {Promise<Array<Object>>} 問題類型清單
   */
  async function fetchIssueTypesForIssue(issueKey = null) {
    if (issueKey) {
      try {
        const meta = await fetchIssueEditMeta(issueKey);
        if (meta && meta.issuetype && Array.isArray(meta.issuetype.allowedValues) && meta.issuetype.allowedValues.length > 0) {
          return meta.issuetype.allowedValues.map((t) => ({
            id: String(t.id || ''),
            name: String(t.name || '').trim(),
            subtask: Boolean(t.subtask),
            iconUrl: String(t.iconUrl || '')
          }));
        }
      } catch {
        // ignore
      }
    }

    const projectTypes = await fetchProjectIssueTypes();
    if (Array.isArray(projectTypes) && projectTypes.length > 0) {
      return projectTypes;
    }

    return [
      { id: '10001', name: 'Story', subtask: false, iconUrl: '' },
      { id: '10002', name: 'Task', subtask: false, iconUrl: '' },
      { id: '10003', name: 'Bug', subtask: false, iconUrl: '' },
      { id: '10004', name: 'Sub-task', subtask: true, iconUrl: '' },
      { id: '10005', name: 'Epic', subtask: false, iconUrl: '' }
    ];
  }

  /**
   * 透過 Jira REST API 更新指定 Issue 的問題類型 (Issue Type)
   *
   * @param {string} issueKey - 卡片編號
   * @param {Object|string} typeVal - 問題類型物件 ({ id, name }) 或類型名稱 / ID
   * @returns {Promise<{success: boolean, error?: string}>} 更新結果
   */
  async function updateIssueType(issueKey, typeVal) {
    if (!issueKey || !typeVal) return { success: false, error: '缺少 issueKey 或問題類型資訊' };

    let payloadField = {};
    if (typeof typeVal === 'object') {
      if (typeVal.id) {
        payloadField = { id: String(typeVal.id) };
      } else if (typeVal.name) {
        payloadField = { name: String(typeVal.name) };
      }
    } else {
      const strVal = String(typeVal).trim();
      if (/^\d+$/.test(strVal)) {
        payloadField = { id: strVal };
      } else {
        payloadField = { name: strVal };
      }
    }

    try {
      const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify({ fields: { issuetype: payloadField } })
      });

      if (res.ok || res.status === 204) {
        return { success: true };
      }

      const errJson = await res.json().catch(() => null);
      let errMsg = '問題類型切換失敗';
      if (errJson) {
        if (Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
          errMsg = errJson.errorMessages.join(', ');
        } else if (errJson.errors && typeof errJson.errors === 'object') {
          errMsg = Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
        }
      }
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : '更新問題類型網路錯誤' };
    }
  }

  BetterJira.JiraApiService = {
    detectJiraContext,
    detectStoryPointsCustomField,
    fetchProjectIssueTypes,
    fetchIssueTypesForIssue,
    fetchActiveAndFutureSprintsForBoard,
    fetchClosedSprintsForBoard,
    fetchHistoricalSprintData,
    fetchSprintIssuesForActive,
    prefetchBoardBacklogIssues,
    fetchIssueDetails,
    fetchIssueEditMeta,
    updateIssueEstimation,
    updateIssue,
    updateIssueType,
    fetchIssueTransitions,
    transitionIssue,
    fetchPriorities,
    updateIssuePriority,
    updateIssueAssignee,
    syncExtensionIcon
  };
})();
