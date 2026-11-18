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
        const standardIssues = normalizedIssues.filter((iss) => !iss.isSubtask);
        boardBacklogPrefetchCache.set(cacheKey, { data: standardIssues, timestamp: Date.now() });

        // 依據每張卡片的 sprint 資訊（id 或 name）分組並注入快取
        const sprintBuckets = new Map();
        normalizedIssues.forEach((iss, index) => {
          const rawItem = rawIssues[index];
          IssueStore.mergeAndCacheIssue(iss);

          // 排除子任務，衝刺與 Backlog 卡片清單只納入標準頂層工作項目卡片
          if (iss.isSubtask) return;

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
          if (!cached) {
            cached = {
              key: bucketKey,
              title: '',
              issues: issuesList,
              allApiIssues: issuesList,
              rawIssues: issuesList,
              masterIssuesMap: new Map(issuesList.map((i) => [i.key, i])),
              filterKeyword: '',
              dateRange: '',
              fromApi: true,
              apiSyncing: false,
              lastSyncTime: Date.now()
            };
            IssueStore.setActiveSprintCache(bucketKey, cached);
          } else {
            cached.allApiIssues = issuesList;
            if (!cached.masterIssuesMap) cached.masterIssuesMap = new Map();
            issuesList.forEach((i) => cached.masterIssuesMap.set(i.key, i));
            cached.rawIssues = Array.from(cached.masterIssuesMap.values());
            cached.fromApi = true;
            cached.apiSyncing = false;
            cached.lastSyncTime = Date.now();
          }
        });

        return standardIssues;
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
          const issues = (data.issues || []).map(IssueStore.normalizeJiraIssue).filter((iss) => !iss.isSubtask);
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
            const issues = data.issues.map(IssueStore.normalizeJiraIssue).filter((iss) => !iss.isSubtask);
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
   * 取得指定快取鍵值內部暫存的 Agile API 卡片清單 (若已由 prefetchBoardBacklogIssues 快取)
   *
   * @param {string} cacheKey - 快取鍵值
   * @returns {Array<Object>|null}
   */
  function getSprintActiveApiCache(cacheKey) {
    if (!cacheKey) return null;
    const entry = sprintActiveApiCache.get(cacheKey);
    return entry && Array.isArray(entry.data) ? entry.data : null;
  }

  /**
   * 解析衝刺物件的數值 ID (若 meta 中為空，自動從已快取的看板衝刺比對或非同步抓取)
   *
   * @param {Object} itemOrMeta - 衝刺結構或 meta 物件
   * @returns {Promise<string|null>} 衝刺 ID 字串 (若無則回傳 null)
   */
  async function resolveSprintId(itemOrMeta) {
    if (!itemOrMeta) return null;
    const meta = itemOrMeta.meta || itemOrMeta;
    if (meta.sprintId && !isNaN(parseInt(meta.sprintId, 10))) {
      return String(meta.sprintId);
    }
    const cleanTitle = (BetterJira.TextUtils && typeof BetterJira.TextUtils.cleanSprintTitle === 'function')
      ? BetterJira.TextUtils.cleanSprintTitle(meta.title || meta.name || '')
      : (meta.title || meta.name || '');

    // 1. 從已快取的 boardSprints 查找
    const { IssueStore } = BetterJira;
    const boardSprints = IssueStore && typeof IssueStore.getBoardSprints === 'function' ? IssueStore.getBoardSprints() : null;
    if (Array.isArray(boardSprints)) {
      const found = boardSprints.find((s) => {
        if (!s) return false;
        if (meta.sprintId && String(s.id) === String(meta.sprintId)) return true;
        const sName = (BetterJira.TextUtils && typeof BetterJira.TextUtils.cleanSprintTitle === 'function')
          ? BetterJira.TextUtils.cleanSprintTitle(s.name || '')
          : (s.name || '');
        return sName && sName.toLowerCase() === cleanTitle.toLowerCase();
      });
      if (found && found.id) {
        if (meta) meta.sprintId = String(found.id);
        return String(found.id);
      }
    }

    // 2. 從 boardId 呼叫 fetchActiveAndFutureSprintsForBoard 查找
    let boardId = IssueStore && typeof IssueStore.getBoardId === 'function' ? IssueStore.getBoardId() : null;
    if (!boardId && typeof window !== 'undefined' && window.location) {
      const href = window.location.href || '';
      const m = href.match(/\/boards\/(\d+)/i) || href.match(/[?&]rapidView=(\d+)/i);
      if (m && m[1]) boardId = m[1];
    }
    if (boardId) {
      try {
        const fetchedList = await fetchActiveAndFutureSprintsForBoard(boardId);
        if (Array.isArray(fetchedList)) {
          const found = fetchedList.find((s) => {
            if (!s) return false;
            const sName = (BetterJira.TextUtils && typeof BetterJira.TextUtils.cleanSprintTitle === 'function')
              ? BetterJira.TextUtils.cleanSprintTitle(s.name || '')
              : (s.name || '');
            return sName && sName.toLowerCase() === cleanTitle.toLowerCase();
          });
          if (found && found.id) {
            if (meta) meta.sprintId = String(found.id);
            return String(found.id);
          }
        }
      } catch {
        // ignore
      }
    }

    return meta.sprintId ? String(meta.sprintId) : null;
  }

  /**
   * 將指定的一或多張卡片移動 / 指派至指定的衝刺 (Sprint)
   * 呼叫 Jira 官方 Agile REST API: POST /rest/agile/1.0/sprint/{sprintId}/issue
   *
   * @param {string|number} sprintId - 目標衝刺 ID
   * @param {string[]|string} issueKeys - 卡片編號陣列或單一卡片編號
   * @returns {Promise<boolean>} 是否成功移動
   */
  async function moveIssuesToSprint(sprintId, issueKeys) {
    if (!sprintId) return false;
    const keys = Array.isArray(issueKeys)
      ? issueKeys.filter(Boolean)
      : typeof issueKeys === 'string' && issueKeys
      ? [issueKeys]
      : [];
    if (keys.length === 0) return false;

    try {
      const res = await fetch(
        `${window.location.origin}/rest/agile/1.0/sprint/${encodeURIComponent(String(sprintId))}/issue`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({ issues: keys })
        }
      );
      if (res.ok || res.status === 204) {
        return true;
      }
    } catch (err) {
      console.warn('[BetterJiraWT] moveIssuesToSprint error:', err);
    }
    return false;
  }

  /**
   * 透過 Jira REST API 快速建立卡片並自動指派至指定衝刺 (Sprint)
   *
   * @param {Object} options - 建立參數
   * @param {string} options.summary - 卡片標題
   * @param {string|number} options.sprintId - 目標衝刺 ID
   * @param {string} [options.projectKey] - 專案 Key (若無則自動偵測)
   * @param {string} [options.issueTypeName='Task'] - 問題類型名稱
   * @returns {Promise<{success: boolean, key?: string, id?: string, error?: string}>}
   */
  async function createIssueInSprint({ summary, sprintId, projectKey = '', issueTypeName = 'Task' }) {
    if (!summary || !summary.trim()) {
      return { success: false, error: '卡片標題不可為空' };
    }
    const cleanSummary = summary.trim();

    try {
      let effectiveProjectKey = projectKey;
      if (!effectiveProjectKey) {
        const ctx = await detectJiraContext();
        effectiveProjectKey = ctx.projectKey;
      }
      if (!effectiveProjectKey) {
        return { success: false, error: '無法偵測當前專案 Key' };
      }

      // 1. 呼叫 Jira Issue 建立 API (嘗試 v3 與 v2)
      const endpoints = [
        `${window.location.origin}/rest/api/3/issue`,
        `${window.location.origin}/rest/api/2/issue`
      ];

      let createdData = null;
      let lastErrMsg = '';

      for (const ep of endpoints) {
        try {
          const bodyPayload = {
            fields: {
              project: { key: effectiveProjectKey },
              summary: cleanSummary,
              issuetype: { name: issueTypeName }
            }
          };

          const res = await fetch(ep, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify(bodyPayload)
          });

          if (res.ok) {
            createdData = await res.json();
            break;
          } else {
            const errData = await res.json().catch(() => ({}));
            lastErrMsg =
              (errData.errors && Object.values(errData.errors).join(', ')) ||
              (errData.errorMessages && errData.errorMessages.join(', ')) ||
              `HTTP ${res.status}`;
          }
        } catch (e) {
          lastErrMsg = e.message;
        }
      }

      if (!createdData || !createdData.key) {
        return { success: false, error: lastErrMsg || '建立卡片失敗' };
      }

      // 2. 將新建立的卡片移動到指定衝刺中
      if (sprintId) {
        await moveIssuesToSprint(sprintId, [createdData.key]);
      }

      return {
        success: true,
        key: createdData.key,
        id: createdData.id
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
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
                const issues = Array.isArray(data.issues) ? data.issues.map(IssueStore.normalizeJiraIssue).filter((iss) => !iss.isSubtask) : [];
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
                  const issues = data.issues.map(IssueStore.normalizeJiraIssue).filter((iss) => !iss.isSubtask);
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
                return fromBucket.data.filter((iss) => !iss.isSubtask);
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
   * 發送訊息通知 Background Service Worker 依目前分頁網址與啟用狀態更新 Chrome Extension 擴充圖示與標題
   *
   * @param {boolean} [enabled=true] - 擴充功能是否啟用
   * @param {string} [backlogUrl] - 設定之待辦事項網址
   */
  function syncExtensionIcon(enabled = true, backlogUrl) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const payload = {
        type: 'BETTER_JIRA_WT_UPDATE_ICON',
        enabled: enabled !== false
      };
      if (backlogUrl !== undefined) {
        payload.backlogUrl = typeof backlogUrl === 'string' ? backlogUrl : '';
      }
      chrome.runtime.sendMessage(
        payload,
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
   * 快取專案/卡片可指派使用者清單 (projectOrIssueKey -> Array<Object>)
   */
  const assignableUsersCache = new Map();

  /**
   * 透過 Jira REST API 查詢指定 Issue 或條件下的可指派人員清單 (Assignable Users / User Search)
   * 自動將查詢到的 Account ID、Username、Email、頭像註冊至 AssigneeUtils
   *
   * @param {string} issueKey - 卡片編號 (例如 "WMC-123")
   * @param {string} [query=''] - 選填之搜尋關鍵字 (姓名或 Email)
   * @returns {Promise<Array<Object>>} 正規化後的使用者陣列
   */
  async function fetchAssignableUsers(issueKey, query = '') {
    if (!issueKey || typeof window === 'undefined' || typeof fetch !== 'function') return [];
    const { AssigneeUtils } = BetterJira;
    const projectPrefix = String(issueKey).split('-')[0].toUpperCase() || issueKey;
    const trimmedQuery = (query || '').trim();
    const cacheKey = trimmedQuery ? `${projectPrefix}::q::${trimmedQuery.toLowerCase()}` : `${projectPrefix}::all`;

    if (assignableUsersCache.has(cacheKey)) {
      return assignableUsersCache.get(cacheKey);
    }

    const qParam = trimmedQuery ? `&query=${encodeURIComponent(trimmedQuery)}` : '&maxResults=200';
    const uParam = trimmedQuery ? `&username=${encodeURIComponent(trimmedQuery)}` : '&maxResults=200';

    const endpoints = [
      `/rest/api/3/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}${qParam}`,
      `/rest/api/2/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}${qParam}`
    ];

    if (trimmedQuery) {
      endpoints.push(
        `/rest/api/2/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}${uParam}`,
        `/rest/api/3/user/search?query=${encodeURIComponent(trimmedQuery)}&maxResults=50`,
        `/rest/api/2/user/search?query=${encodeURIComponent(trimmedQuery)}&maxResults=50`,
        `/rest/api/2/user/search?username=${encodeURIComponent(trimmedQuery)}&maxResults=50`
      );
    }

    for (const ep of endpoints) {
      try {
        const res = await fetch(`${window.location.origin}${ep}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const normalized = data
              .map((u) => {
                if (!u) return null;
                const displayName = String(u.displayName || u.name || u.emailAddress || '').trim();
                const accountId = String(u.accountId || '').trim();
                const username = String(u.name || u.key || '').trim();
                const email = String(u.emailAddress || '').trim();
                const avatar =
                  (u.avatarUrls && (u.avatarUrls['48x48'] || u.avatarUrls['32x32'] || u.avatarUrls['24x24'])) || '';
                if (!displayName && !accountId && !username) return null;
                const userItem = {
                  name: displayName || username,
                  accountId,
                  username,
                  email,
                  avatar
                };
                if (AssigneeUtils && typeof AssigneeUtils.registerAssignee === 'function') {
                  AssigneeUtils.registerAssignee(userItem);
                }
                return userItem;
              })
              .filter(Boolean);

            if (normalized.length > 0) {
              assignableUsersCache.set(cacheKey, normalized);
              return normalized;
            }
          }
        }
      } catch {
        // try next endpoint
      }
    }

    return [];
  }

  /**
   * 根據名稱、Email 或既有線索，解析目標成員在 Jira 中的 Account ID (Cloud) 或 Username (Server/DC)
   *
   * @param {string} issueKey - 卡片編號
   * @param {Object|string} userHint - 使用者線索 ({ name, email, accountId, username } 或名稱字串)
   * @returns {Promise<Object|null>} 解析後的使用者資訊 { name, accountId, username, email, avatar }
   */
  async function resolveJiraUser(issueKey, userHint) {
    if (!userHint) return null;
    const { AssigneeUtils, IssueStore } = BetterJira;

    const hintObj =
      typeof userHint === 'string'
        ? { name: userHint.trim(), email: '', accountId: '', username: '' }
        : {
            name: String(userHint.name || '').trim(),
            email: String(userHint.email || '').trim(),
            accountId: String(userHint.accountId || '').trim(),
            username: String(userHint.username || '').trim(),
            avatar: String(userHint.avatar || '').trim()
          };

    if (hintObj.accountId) {
      return hintObj;
    }

    // 1. 先從 AssigneeUtils 已註冊人員目錄查找是否已有 accountId 或 username
    if (AssigneeUtils && typeof AssigneeUtils.findRegisteredUser === 'function') {
      const reg = AssigneeUtils.findRegisteredUser(hintObj);
      if (reg && (reg.accountId || reg.username)) {
        return {
          name: reg.name || hintObj.name,
          accountId: reg.accountId || '',
          username: reg.username || '',
          email: reg.email || hintObj.email,
          avatar: reg.avatar || hintObj.avatar
        };
      }
    }

    // 2. 從 IssueStore.getAllIssues() 中查找是否有相同人員已帶有 assigneeAccountId 或 assigneeUsername
    if (IssueStore && typeof IssueStore.getAllIssues === 'function') {
      const allIssues = IssueStore.getAllIssues() || [];
      for (const iss of allIssues) {
        if (!iss || iss.isUnassigned || (!iss.assigneeAccountId && !iss.assigneeUsername)) continue;
        const matched =
          (hintObj.email && iss.assigneeEmail && iss.assigneeEmail.toLowerCase() === hintObj.email.toLowerCase()) ||
          (hintObj.name && iss.assigneeName && iss.assigneeName.toLowerCase() === hintObj.name.toLowerCase()) ||
          (AssigneeUtils &&
            typeof AssigneeUtils.matchCustomAssignee === 'function' &&
            AssigneeUtils.matchCustomAssignee(iss, { name: hintObj.name || hintObj.email.split('@')[0], email: hintObj.email }));
        if (matched) {
          return {
            name: iss.assigneeName || hintObj.name,
            accountId: iss.assigneeAccountId || '',
            username: iss.assigneeUsername || '',
            email: iss.assigneeEmail || hintObj.email,
            avatar: iss.assigneeAvatar || hintObj.avatar
          };
        }
      }
    }

    // 3. 向 Jira API 查詢可指派人員清單並比對 Email / 姓名 / 帳號前綴
    const matchFromList = (list) => {
      if (!Array.isArray(list) || list.length === 0) return null;
      const targetEmail = (hintObj.email || '').toLowerCase();
      const targetName = (hintObj.name || '').toLowerCase();
      const emailPrefix = targetEmail ? targetEmail.split('@')[0] : '';

      // 3-1. Email 精確吻合
      if (targetEmail) {
        const byEmail = list.find((u) => u.email && u.email.toLowerCase() === targetEmail);
        if (byEmail) return byEmail;
      }
      // 3-2. 姓名或 username 精確吻合
      if (targetName) {
        const byExactName = list.find(
          (u) =>
            (u.name && u.name.toLowerCase() === targetName) ||
            (u.username && u.username.toLowerCase() === targetName)
        );
        if (byExactName) return byExactName;
      }
      // 3-3. 透過 matchCustomAssignee 比對姓名包含、Email 前綴或縮寫
      if (AssigneeUtils && typeof AssigneeUtils.matchCustomAssignee === 'function') {
        const memberTarget = { name: hintObj.name || emailPrefix, email: hintObj.email };
        const byCustomMatch = list.find((u) =>
          AssigneeUtils.matchCustomAssignee(
            {
              assigneeName: u.name,
              assigneeEmail: u.email,
              assigneeAvatar: u.avatar
            },
            memberTarget
          )
        );
        if (byCustomMatch) return byCustomMatch;
      }
      // 3-4. 若為針對特定關鍵字查詢且僅回傳唯一 1 筆結果，直接採用
      if (list.length === 1) {
        return list[0];
      }
      return null;
    };

    // 優先以 Email 精準搜尋，其次查全專案可指派清單，最後以名稱搜尋
    const searchQueries = [];
    if (hintObj.email) {
      searchQueries.push(hintObj.email);
      const prefix = hintObj.email.split('@')[0];
      if (prefix && prefix !== hintObj.email) searchQueries.push(prefix);
    }
    searchQueries.push(''); // 查此卡片全部可指派成員
    if (hintObj.name && !searchQueries.includes(hintObj.name)) {
      searchQueries.push(hintObj.name);
    }

    for (const q of searchQueries) {
      const candidates = await fetchAssignableUsers(issueKey, q);
      const found = matchFromList(candidates);
      if (found && (found.accountId || found.username)) {
        return found;
      }
    }

    return null;
  }

  /**
   * 透過 Jira REST API 更新指定 Issue 的經辦人
   * 支援 Jira Cloud (accountId) 與 Jira Server/Data Center (name) 雙規格，並支援設為未指派 (Unassigned)
   *
   * @param {string} issueKey - 卡片編號
   * @param {string|null} assigneeName - 經辦人名稱 (傳入 null, 空字串, '未指派' 或 '__UNASSIGNED__' 代表未指派)
   * @param {string|null} [accountId=null] - Jira Cloud 帳號 ID (若有)
   * @param {Object|null} [memberHint=null] - 額外成員線索 ({ name, email, accountId, username, avatar })
   * @returns {Promise<{success: boolean, resolvedUser?: Object|null, error?: string}>} 更新結果
   */
  async function updateIssueAssignee(issueKey, assigneeName, accountId = null, memberHint = null) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };

    const { AssigneeUtils } = BetterJira;
    const isUnassigned =
      !assigneeName ||
      assigneeName === '__UNASSIGNED__' ||
      assigneeName === '未指派' ||
      (AssigneeUtils && typeof AssigneeUtils.isUnassignedText === 'function' && AssigneeUtils.isUnassignedText(assigneeName));

    let resolvedUser = null;
    let finalAccountId = accountId ? String(accountId).trim() : '';
    let finalUsername = assigneeName ? String(assigneeName).trim() : '';

    if (!isUnassigned) {
      resolvedUser = await resolveJiraUser(issueKey, {
        ...(memberHint || {}),
        name: assigneeName,
        accountId: finalAccountId || (memberHint && memberHint.accountId) || ''
      });
      if (resolvedUser) {
        if (resolvedUser.accountId) finalAccountId = resolvedUser.accountId;
        if (resolvedUser.username) finalUsername = resolvedUser.username;
      }
    }

    // 建構候選請求 Payload：
    // 在 Jira Cloud (GDPR 模式) 中必須傳遞 { accountId } (未指派為 { accountId: null })；
    // 在 Jira Server/DC 中則傳遞 { name } (未指派為 { name: null })。
    const assigneePayloads = [];
    if (isUnassigned) {
      assigneePayloads.push({ accountId: null });
      assigneePayloads.push({ name: null });
    } else if (finalAccountId) {
      assigneePayloads.push({ accountId: finalAccountId });
      if (finalUsername) {
        assigneePayloads.push({ name: finalUsername });
      }
    } else {
      assigneePayloads.push({ name: finalUsername });
      if (memberHint && memberHint.email && memberHint.email !== finalUsername) {
        assigneePayloads.push({ name: memberHint.email });
      }
    }

    let lastErrMsg = '經辦人更新失敗';

    try {
      // 1. 優先呼叫 Jira 標準專用 /assignee 端點
      for (const bodyPayload of assigneePayloads) {
        const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}/assignee`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Atlassian-Token': 'no-check'
          },
          body: JSON.stringify(bodyPayload)
        });

        if (res.ok || res.status === 204) {
          return { success: true, resolvedUser };
        }

        const errJson = await res.json().catch(() => null);
        if (errJson) {
          if (Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
            lastErrMsg = errJson.errorMessages.join(', ');
          } else if (errJson.errors && typeof errJson.errors === 'object') {
            lastErrMsg = Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
          }
        }
      }

      // 2. 若專用端點受限，備用標準 issue 根端點 fields 更新
      for (const bodyPayload of assigneePayloads) {
        const fallbackPayload = {
          fields: {
            assignee: isUnassigned ? null : bodyPayload
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
          return { success: true, resolvedUser };
        }

        const errJson = await fallbackRes.json().catch(() => null);
        if (errJson) {
          if (Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
            lastErrMsg = errJson.errorMessages.join(', ');
          } else if (errJson.errors && typeof errJson.errors === 'object') {
            lastErrMsg = Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`).join(', ');
          }
        }
      }

      return { success: false, error: lastErrMsg };
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

  /**
   * 將純文字或 Markdown 轉換為 Jira v3 API 所需的 Atlassian Document Format (ADF) 結構
   *
   * @param {string} text - 純文字或 Markdown 內容
   * @returns {Object} ADF document 物件
   */
  function plainTextToAdf(text) {
    if (BetterJira.AdfParser && typeof BetterJira.AdfParser.markdownToAdf === 'function') {
      return BetterJira.AdfParser.markdownToAdf(text);
    }
    const lines = String(text || '').split('\n');
    const content = lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }));
    return {
      type: 'doc',
      version: 1,
      content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }]
    };
  }

  /**
   * 解析 Jira API 錯誤回應文字
   *
   * @param {Response} res - Fetch Response 物件
   * @param {string} fallbackMsg - 預設錯誤訊息
   * @returns {Promise<string>}
   */
  async function parseJiraErrorMessage(res, fallbackMsg) {
    const errJson = await res.json().catch(() => null);
    if (errJson) {
      if (Array.isArray(errJson.errorMessages) && errJson.errorMessages.length > 0) {
        return errJson.errorMessages.join(', ');
      }
      if (errJson.errors && typeof errJson.errors === 'object') {
        const entries = Object.entries(errJson.errors).map(([k, v]) => `${k}: ${v}`);
        if (entries.length > 0) return entries.join(', ');
      }
    }
    return fallbackMsg || `HTTP ${res.status}`;
  }

  /**
   * 共用留言 API 請求輔助函式：優先嘗試 REST API v2 (支援純文字/Wiki 語法)，若遇到格式不相容則自動回退至 v3 ADF 格式
   *
   * @param {string} method - HTTP 方法 ('POST' | 'PUT' | 'DELETE')
   * @param {string} issuePath - 留言端點相對路徑 (例如 'issue/WMC-1/comment')
   * @param {string|null} [bodyText=null] - 留言文字內容 (DELETE 時可為 null)
   * @returns {Promise<{success: boolean, comment?: Object|null, error?: string}>}
   */
  async function sendCommentRequest(method, issuePath, bodyText = null) {
    const isDelete = method === 'DELETE';
    const attempts = isDelete
      ? [
          { url: `${window.location.origin}/rest/api/2/${issuePath}`, payload: null },
          { url: `${window.location.origin}/rest/api/3/${issuePath}`, payload: null }
        ]
      : [
          { url: `${window.location.origin}/rest/api/2/${issuePath}`, payload: { body: bodyText } },
          { url: `${window.location.origin}/rest/api/3/${issuePath}`, payload: { body: plainTextToAdf(bodyText) } }
        ];

    let lastError = isDelete ? '留言刪除失敗' : '留言送出失敗';
    for (let i = 0; i < attempts.length; i += 1) {
      const { url, payload } = attempts[i];
      try {
        const fetchOpts = {
          method,
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'X-Atlassian-Token': 'no-check'
          }
        };
        if (payload !== null) {
          fetchOpts.headers['Content-Type'] = 'application/json';
          fetchOpts.body = JSON.stringify(payload);
        }

        const res = await fetch(url, fetchOpts);

        if (res.ok || res.status === 204) {
          const comment = res.status === 204 ? null : await res.json().catch(() => null);
          return { success: true, comment };
        }

        lastError = await parseJiraErrorMessage(res, `HTTP ${res.status}`);

        // 僅在格式/端點不支援時回退至下一個版本，權限或驗證錯誤不重試
        if (res.status !== 400 && res.status !== 404 && res.status !== 415) {
          return { success: false, error: lastError };
        }
      } catch (e) {
        lastError = e && e.message ? e.message : '網路請求失敗';
      }
    }

    return { success: false, error: lastError };
  }

  /**
   * 新增卡片留言
   *
   * @param {string} issueKey - 卡片編號
   * @param {string} bodyText - 留言內容
   * @returns {Promise<{success: boolean, comment?: Object|null, error?: string}>}
   */
  async function addIssueComment(issueKey, bodyText) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    const trimmed = String(bodyText || '').trim();
    if (!trimmed) return { success: false, error: '留言內容不能為空' };
    return sendCommentRequest('POST', `issue/${encodeURIComponent(issueKey)}/comment`, trimmed);
  }

  /**
   * 編輯既有卡片留言
   *
   * @param {string} issueKey - 卡片編號
   * @param {string|number} commentId - 留言 ID
   * @param {string} bodyText - 更新後留言內容
   * @returns {Promise<{success: boolean, comment?: Object|null, error?: string}>}
   */
  async function updateIssueComment(issueKey, commentId, bodyText) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    if (!commentId) return { success: false, error: '缺少 commentId' };
    const trimmed = String(bodyText || '').trim();
    if (!trimmed) return { success: false, error: '留言內容不能為空' };
    return sendCommentRequest(
      'PUT',
      `issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      trimmed
    );
  }

  /**
   * 刪除指定卡片留言
   *
   * @param {string} issueKey - 卡片編號
   * @param {string|number} commentId - 留言 ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function deleteIssueComment(issueKey, commentId) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    if (!commentId) return { success: false, error: '缺少 commentId' };
    return sendCommentRequest(
      'DELETE',
      `issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`,
      null
    );
  }

  /**
   * 上傳附件至指定 Jira 卡片
   *
   * @param {string} issueKey - 卡片編號
   * @param {File} file - 欲上傳之檔案物件
   * @returns {Promise<{success: boolean, attachments?: Array<Object>, error?: string}>}
   */
  async function addIssueAttachment(issueKey, file) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    if (!file) return { success: false, error: '缺少檔案' };

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(
        `${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Atlassian-Token': 'no-check'
          },
          body: formData
        }
      );

      if (res.ok) {
        const attachments = await res.json().catch(() => []);
        return { success: true, attachments: Array.isArray(attachments) ? attachments : [] };
      }
      const errMsg = await parseJiraErrorMessage(res, `HTTP ${res.status}`);
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : '附件上傳網路錯誤' };
    }
  }

  /**
   * 透過 Jira REST API PUT /rest/api/2/issue/{issueKey} 更新指定 fields 欄位
   *
   * @param {string} issueKey - 卡片編號
   * @param {Object} fieldsPayload - 要更新的 fields 物件
   * @param {string} [defaultErrMsg='欄位更新失敗'] - 預設錯誤訊息
   * @returns {Promise<{success: boolean, error?: string}>} 更新結果
   */
  async function putIssueFields(issueKey, fieldsPayload, defaultErrMsg = '欄位更新失敗') {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    try {
      const res = await fetch(`${window.location.origin}/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check'
        },
        body: JSON.stringify({ fields: fieldsPayload })
      });
      if (res.ok || res.status === 204) {
        return { success: true };
      }
      const errMsg = await parseJiraErrorMessage(res, defaultErrMsg);
      return { success: false, error: errMsg };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : '網路請求失敗' };
    }
  }

  /**
   * 更新 Jira Issue 報告者 (Reporter)
   *
   * @param {string} issueKey - 卡片編號
   * @param {string} reporterName - 報告者名稱
   * @param {string|null} [accountId=null] - Jira Cloud 帳號 ID
   * @param {Object|null} [memberHint=null] - 成員資訊線索
   * @returns {Promise<{success: boolean, resolvedUser?: Object|null, error?: string}>}
   */
  async function updateIssueReporter(issueKey, reporterName, accountId = null, memberHint = null) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    if (!reporterName) return { success: false, error: '請選擇報告者' };

    let finalAccountId = accountId ? String(accountId).trim() : '';
    let finalUsername = reporterName ? String(reporterName).trim() : '';

    const resolvedUser = await resolveJiraUser(issueKey, {
      ...(memberHint || {}),
      name: reporterName,
      accountId: finalAccountId || (memberHint && memberHint.accountId) || ''
    });
    if (resolvedUser) {
      if (resolvedUser.accountId) finalAccountId = resolvedUser.accountId;
      if (resolvedUser.username) finalUsername = resolvedUser.username;
    }

    const payloads = [];
    if (finalAccountId) {
      payloads.push({ accountId: finalAccountId });
      if (finalUsername) payloads.push({ name: finalUsername });
    } else {
      payloads.push({ name: finalUsername });
      if (memberHint && memberHint.email && memberHint.email !== finalUsername) {
        payloads.push({ name: memberHint.email });
      }
    }

    let lastErr = '報告者更新失敗';
    for (const bodyPayload of payloads) {
      const res = await putIssueFields(issueKey, { reporter: bodyPayload }, lastErr);
      if (res.success) {
        return { success: true, resolvedUser };
      }
      if (res.error) lastErr = res.error;
    }

    return { success: false, error: lastErr };
  }

  /**
   * 更新 Jira Issue 到期日 (Due Date)
   *
   * @param {string} issueKey - 卡片編號
   * @param {string|null} dueDate - YYYY-MM-DD 格式字串，或 null/空字串代表清空
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function updateIssueDueDate(issueKey, dueDate) {
    const cleanVal = dueDate ? String(dueDate).trim() : '';
    return putIssueFields(issueKey, { duedate: cleanVal || null }, '到期日更新失敗');
  }

  /**
   * 更新 Jira Issue 標籤 (Labels)
   *
   * @param {string} issueKey - 卡片編號
   * @param {Array<string>} labels - 標籤陣列
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async function updateIssueLabels(issueKey, labels = []) {
    const normalized = Array.isArray(labels)
      ? Array.from(new Set(labels.map((l) => String(l || '').trim()).filter(Boolean)))
      : [];
    return putIssueFields(issueKey, { labels: normalized }, '標籤更新失敗');
  }

  /**
   * 向 Jira 查詢標籤建議清單
   *
   * @param {string} [query=''] - 搜尋關鍵字
   * @returns {Promise<Array<string>>} 建議標籤陣列
   */
  async function fetchLabelSuggestions(query = '') {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return [];
    try {
      const res = await fetch(
        `${window.location.origin}/rest/api/1.0/labels/suggest?query=${encodeURIComponent(query || '')}`,
        {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        }
      );
      if (!res.ok) return [];
      const data = await res.json();
      if (data && Array.isArray(data.suggestions)) {
        return data.suggestions
          .map((s) => (typeof s === 'string' ? s : (s && (s.label || s.text)) || ''))
          .filter(Boolean);
      }
    } catch {
      // ignore
    }
    return [];
  }

  /**
   * 搜尋可作為上層項目 (Parent / Epic) 的候選卡片
   *
   * @param {string} issueKey - 目前卡片編號
   * @param {string} [query=''] - 搜尋關鍵字
   * @returns {Promise<Array<{key: string, summary: string, issueTypeName?: string}>>}
   */
  async function searchParentCandidates(issueKey, query = '') {
    const candidates = [];
    const seen = new Set();
    const { IssueStore } = BetterJira;
    const kw = String(query || '').trim().toLowerCase();

    const addCandidate = (key, summary, issueTypeName = '') => {
      const k = String(key || '').trim().toUpperCase();
      if (!k || k === String(issueKey || '').toUpperCase() || seen.has(k)) return;
      seen.add(k);
      candidates.push({
        key: k,
        summary: String(summary || '').trim(),
        issueTypeName: String(issueTypeName || '').trim()
      });
    };

    // 1. 優先從 Jira issue picker API 搜尋
    if (typeof window !== 'undefined' && typeof fetch === 'function') {
      try {
        const res = await fetch(
          `${window.location.origin}/rest/api/2/issue/picker?currentIssueKey=${encodeURIComponent(issueKey || '')}&query=${encodeURIComponent(query || '')}`,
          {
            credentials: 'include',
            headers: { Accept: 'application/json' }
          }
        );
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.sections)) {
            data.sections.forEach((sec) => {
              if (sec && Array.isArray(sec.issues)) {
                sec.issues.forEach((item) => {
                  if (item && item.key) {
                    addCandidate(item.key, item.summaryText || item.summary || '');
                  }
                });
              }
            });
          }
        }
      } catch {
        // ignore
      }
    }

    // 2. 補充本地 IssueStore 快取中的 Epic 與既有上層項目
    if (IssueStore && typeof IssueStore.getAllIssues === 'function') {
      const all = IssueStore.getAllIssues() || [];
      all.forEach((iss) => {
        if (!iss) return;
        if (iss.issueTypeName && iss.issueTypeName.toLowerCase() === 'epic') {
          if (!kw || iss.key.toLowerCase().includes(kw) || (iss.summary || '').toLowerCase().includes(kw)) {
            addCandidate(iss.key, iss.summary, 'Epic');
          }
        }
        if (iss.parentKey) {
          if (!kw || iss.parentKey.toLowerCase().includes(kw) || (iss.parentSummary || '').toLowerCase().includes(kw)) {
            addCandidate(iss.parentKey, iss.parentSummary || '');
          }
        }
      });
    }

    return candidates.slice(0, 25);
  }

  /**
   * 更新 Jira Issue 上層項目 (Parent / Epic)
   * 優先使用標準 fields.parent，若專案使用傳統 Epic Link 自訂欄位則自動偵測並回退更新
   *
   * @param {string} issueKey - 卡片編號
   * @param {string|null} parentKey - 上層項目編號 (空字串或 null 代表清除)
   * @returns {Promise<{success: boolean, parentKey?: string, parentSummary?: string, error?: string}>}
   */
  async function updateIssueParent(issueKey, parentKey) {
    if (!issueKey) return { success: false, error: '缺少 issueKey' };
    const cleanParent = parentKey ? String(parentKey).trim().toUpperCase() : '';

    // 1. 嘗試標準 fields.parent
    const directRes = await putIssueFields(
      issueKey,
      { parent: cleanParent ? { key: cleanParent } : null },
      '上層項目更新失敗'
    );

    let succeeded = directRes.success;
    let lastErr = directRes.error || '上層項目更新失敗';

    // 2. 若標準 parent 失敗，嘗試透過 editmeta 尋找 Epic Link 自訂欄位
    if (!succeeded) {
      const editMeta = await fetchIssueEditMeta(issueKey);
      if (editMeta && typeof editMeta === 'object') {
        const epicFieldEntry = Object.entries(editMeta).find(([, meta]) => {
          if (!meta) return false;
          const name = String(meta.name || '').toLowerCase();
          const custom = String((meta.schema && meta.schema.custom) || '').toLowerCase();
          return (
            custom.includes('gh-epic-link') ||
            name === 'epic link' ||
            name === '史詩連結' ||
            name === 'parent link'
          );
        });
        if (epicFieldEntry) {
          const [epicFieldId] = epicFieldEntry;
          const epicRes = await putIssueFields(
            issueKey,
            { [epicFieldId]: cleanParent || null },
            lastErr
          );
          if (epicRes.success) {
            succeeded = true;
          } else if (epicRes.error) {
            lastErr = epicRes.error;
          }
        }
      }
    }

    if (!succeeded) {
      return { success: false, error: lastErr };
    }

    // 3. 若有設定上層項目，嘗試解析其 Summary 以便即時顯示
    let parentSummary = '';
    if (cleanParent) {
      const { IssueStore } = BetterJira;
      const cached = IssueStore && typeof IssueStore.getIssue === 'function' ? IssueStore.getIssue(cleanParent) : null;
      if (cached && cached.summary) {
        parentSummary = cached.summary;
      } else if (typeof window !== 'undefined' && typeof fetch === 'function') {
        try {
          const pRes = await fetch(
            `${window.location.origin}/rest/api/2/issue/${encodeURIComponent(cleanParent)}?fields=summary`,
            {
              credentials: 'include',
              headers: { Accept: 'application/json' }
            }
          );
          if (pRes.ok) {
            const pData = await pRes.json();
            if (pData && pData.fields && pData.fields.summary) {
              parentSummary = pData.fields.summary;
            }
          }
        } catch {
          // ignore
        }
      }
    }

    return {
      success: true,
      parentKey: cleanParent,
      parentSummary
    };
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
    getSprintActiveApiCache,
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
    fetchAssignableUsers,
    resolveJiraUser,
    updateIssueAssignee,
    updateIssueReporter,
    updateIssueDueDate,
    updateIssueLabels,
    fetchLabelSuggestions,
    searchParentCandidates,
    updateIssueParent,
    resolveSprintId,
    moveIssuesToSprint,
    createIssueInSprint,
    addIssueComment,
    updateIssueComment,
    deleteIssueComment,
    addIssueAttachment,
    syncExtensionIcon
  };
})();
