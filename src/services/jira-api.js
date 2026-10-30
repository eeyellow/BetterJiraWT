/**
 * @fileoverview Jira Agile & REST API 服務整合模組
 * 負責看板 Context 偵測、Story Points 欄位探測、衝刺卡片抓取與單一卡片詳細資料請求。
 * @module services/jira-api
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

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
          url: `${window.location.origin}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          method: 'GET'
        },
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
   *
   * @param {Object} item - 衝刺項目物件包含 DOM branch 與 meta
   * @returns {Promise<Array<Object>>} 正規化後的卡片物件陣列
   */
  async function fetchSprintIssuesForActive(item) {
    const { IssueStore, TextUtils } = BetterJira;
    const { boardId, projectKey } = await detectJiraContext();
    let sprintId = item.meta.sprintId || (item.sprintEl && item.sprintEl.getAttribute('data-sprint-id'));
    const cleanTitle = TextUtils.cleanSprintTitle(item.meta.title);

    await detectStoryPointsCustomField();
    const cachedFieldId = IssueStore.getStoryPointsFieldId();

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

    // 1. 若無明確 sprintId，從當前看板的 active/future sprints 清單比對
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

    // 2. 若找到 sprintId，優先呼叫 Agile Sprint Issues API
    if (sprintId) {
      try {
        const res = await fetch(
          `${window.location.origin}/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue?maxResults=200&fields=${fieldsParam}`,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.issues)) {
            return data.issues.map(IssueStore.normalizeJiraIssue);
          }
        }
      } catch {
        // ignore
      }
    }

    // 3. JQL 搜尋備援
    if (cleanTitle) {
      const escaped = cleanTitle.replace(/"/g, '\\"');
      const jqlCandidates = [];
      if (projectKey) {
        jqlCandidates.push(`project = "${projectKey}" AND sprint = "${escaped}" ORDER BY key ASC`);
      }
      jqlCandidates.push(`sprint = "${escaped}" ORDER BY key ASC`);

      for (const jql of jqlCandidates) {
        const searchEndpoints = [
          `${window.location.origin}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          `${window.location.origin}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`,
          `${window.location.origin}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=200&fields=${fieldsParam}`
        ];

        for (const ep of searchEndpoints) {
          try {
            const res = await fetch(ep, {
              credentials: 'include',
              headers: { Accept: 'application/json' }
            });
            if (res.ok) {
              const data = await res.json();
              if (data && Array.isArray(data.issues) && data.issues.length > 0) {
                return data.issues.map(IssueStore.normalizeJiraIssue);
              }
            }
          } catch {
            // ignore
          }
        }
      }
    }

    // 4. Backlog 待辦池備援
    if (/backlog/i.test(cleanTitle) && boardId) {
      try {
        const res = await fetch(
          `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/backlog?maxResults=200&fields=${fieldsParam}`,
          { credentials: 'include', headers: { Accept: 'application/json' } }
        );
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.issues)) {
            return data.issues.map(IssueStore.normalizeJiraIssue);
          }
        }
      } catch {
        // ignore
      }
    }

    return [];
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
   * 發送訊息通知 Background Service Worker 切換 Chrome Extension 擴充圖示與標題
   *
   * @param {string} themeStyle - 當前樣式名稱 (Default / Bootstrap / MaterialDesign)
   */
  function syncExtensionIcon(themeStyle) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'BETTER_JIRA_WT_UPDATE_ICON',
          themeStyle: themeStyle || 'Default'
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  }

  BetterJira.JiraApiService = {
    detectJiraContext,
    detectStoryPointsCustomField,
    fetchActiveAndFutureSprintsForBoard,
    fetchClosedSprintsForBoard,
    fetchHistoricalSprintData,
    fetchSprintIssuesForActive,
    fetchIssueDetails,
    syncExtensionIcon
  };
})();
