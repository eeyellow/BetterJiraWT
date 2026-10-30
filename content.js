/**
 * BetterJiraWT Content Script
 * 1. 偵測當前網址是否符合設定的「待辦事項網址」
 * 2. 套用選定樣式：預設 (Default) / Bootstrap / MaterialDesign (透過 Extension Icon 呈現狀態)
 * 3. 將「待辦事項」頁面改為左右兩欄排版：
 *    - 左欄約 20%：放置衝刺 (Sprints) 清單，顯示真實衝刺名稱，支援長清單捲動，每次只能切換一個衝刺
 *    - 右欄約 80%：顯示目前選取衝刺中的卡片
 * 4. 點擊右欄卡片時，鎖定右欄不切半，並立即以置中 Modal 彈出視窗顯示卡片詳細內容
 */
(() => {
  const THEME_ATTR = 'data-betterjira-theme';
  const LAYOUT_ACTIVE_ATTR = 'data-betterjira-layout';
  const SIDEBAR_ID = 'bjwt-sprint-sidebar';
  const MODAL_BACKDROP_ID = 'bjwt-issue-modal-backdrop';
  const HISTORY_PICKER_MODAL_ID = 'bjwt-history-picker-modal';
  const HISTORY_ISSUE_MODAL_ID = 'bjwt-history-issue-modal';
  const RUNTIME_STYLE_ID = 'bjwt-runtime-critical-styles';

  const SPRINT_SELECTORS = [
    '[data-testid="software-backlog.card-list.container"]',
    '[data-testid^="software-backlog.card-list.container"]',
    '[data-testid*="software-backlog.card-list"][data-testid*="container"]',
    '.ghx-backlog-container',
    '.js-sprint-container',
    '[data-sprint-id]',
    '.sprint-container'
  ];

  const CARD_SELECTORS = [
    '[data-testid="software-backlog.card-list.card.card-contents.card-container"]',
    '[data-testid^="software-backlog.card-list.card."]',
    '[data-testid*="issue-card"]',
    '.js-issue',
    '.ghx-issue-compact',
    '.sprint-card:not(.bjwt-history-card)'
  ];

  const ISSUE_DETAIL_SELECTORS = [
    '[data-testid="software-backlog.backlog-content.issue-detail-wrapper"]',
    '[data-testid*="backlog-content.issue-detail"]',
    '[data-testid="issue.views.issue-details.issue-layout.issue-view"]',
    '[data-testid*="issue.views.issue-details.issue-layout"]',
    '[data-testid*="issue.views.issue-base.foundation.summary"]',
    '[data-testid*="issue-view-layout-templates"]',
    '[data-testid*="issue-detail"]',
    '#jira-issue-header',
    '#ghx-detail-view',
    '.ghx-detail-view'
  ];

  const IGNORED_BUTTON_TEXTS = new Set([
    '完成衝刺',
    '開始衝刺',
    '建立衝刺',
    '編輯衝刺',
    '刪除衝刺',
    '建立問題',
    '更多動作',
    'complete sprint',
    'start sprint',
    'create sprint',
    'edit sprint',
    'delete sprint',
    'create issue',
    'more actions'
  ]);

  let currentSettings = {
    backlogUrl: '',
    themeStyle: 'Default'
  };

  let activeSprintKey = null;
  let activeSprintIndex = 0;
  let isSidebarCollapsed = false;
  let layoutRafId = null;

  /**
   * 僅在「當前頁面瀏覽期間」保留的已結束歷史衝刺清單 (重新整理頁面後自動清空)
   * 結構: Array<{
   *   key: string,
   *   sprintId: number | string | null,
   *   title: string,
   *   state: 'closed',
   *   startDate?: string,
   *   endDate?: string,
   *   completeDate?: string,
   *   goal?: string,
   *   issues: Array<Object>,
   *   filterKeyword?: string
   * }>
   */
  const loadedHistoricalSprints = [];
  let cachedClosedSprints = null;
  let cachedBoardId = null;

  /**
   * 未結束衝刺自定義卡片快取
   * key: string -> {
   *   key: string,
   *   sprintId?: string | number,
   *   title: string,
   *   issues: Array<Object>,
   *   filterKeyword: string
   * }
   */
  const activeSprintCache = new Map();

  /**
   * 全域卡片欄位快取 (key -> Issue 物件)
   * 用於將 REST API 取得的完整欄位與原生 DOM 解析出的即時欄位 (如頭像縮寫 RAY、背景色、最新狀態) 融合，
   * 同時不覆蓋原生篩選器篩選後的卡片集合。
   */
  const issueMetadataMap = new Map();

  let cachedStoryPointsFieldId = null;
  let cachedBoardSprints = null;

  /**
   * 判斷 shortStr 是否為 fullStr 的截斷重複合併版 (以 "..." 或 "…" 結尾，且前半段與完整標題一致)
   */
  function isTruncatedDuplicateOf(shortStr, fullStr) {
    if (!shortStr || !fullStr) return false;
    const s = shortStr.trim();
    const f = fullStr.trim();
    if (!s || !f) return false;
    if (s === f) return true;

    // 含有省略號 (... 或 …) 之截斷版
    const hasEllipsis = /(\.{2,}|…)\s*$/.test(s);
    const stripped = s.replace(/\s*(\.{2,}|…)+\s*$/, '').trim();
    if (hasEllipsis && stripped.length >= 4 && f.length > stripped.length && f.startsWith(stripped)) {
      return true;
    }

    return false;
  }

  /**
   * 清理卡片標題字串，徹底去除各種重複兩次或多次的內容
   * (處理：完全重複、空白分隔重複、截斷版+完整版重複、前後夾雜額外徽章之重複)
   */
  function cleanSummaryText(rawText, depth = 0) {
    if (!rawText) return '';
    let txt = String(rawText)
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!txt || depth > 3) return txt;

    // 1. 檢查整個字串是否由同一個片段連續重複 2 次以上組成 (有無空白皆可)
    const exactRepeatMatch = txt.match(/^(.{2,}?)\s*\1(?:\s*\1)*$/u);
    if (exactRepeatMatch && exactRepeatMatch[1]) {
      return cleanSummaryText(exactRepeatMatch[1].trim(), depth + 1);
    }

    // 2. 若字串前半段與後半段完全相同 (無空格切分，如 "TitleTitle")
    const len = txt.length;
    if (len >= 4 && len % 2 === 0) {
      const half = len / 2;
      if (txt.slice(0, half) === txt.slice(half)) {
        return cleanSummaryText(txt.slice(0, half).trim(), depth + 1);
      }
    }

    // 3. 若字串長度為奇數且正中間為空格，兩側文字相同 (如 "Title Title")
    if (len >= 5 && len % 2 === 1) {
      const half = Math.floor(len / 2);
      if (txt[half] === ' ' && txt.slice(0, half) === txt.slice(half + 1)) {
        return cleanSummaryText(txt.slice(0, half).trim(), depth + 1);
      }
    }

    // 4. 依單字數量切半檢查重複 (如 "Fix bug in login Fix bug in login")
    const words = txt.split(' ').filter(Boolean);
    if (words.length >= 2 && words.length % 2 === 0) {
      const halfW = words.length / 2;
      const firstW = words.slice(0, halfW).join(' ');
      const secondW = words.slice(halfW).join(' ');
      if (firstW === secondW) {
        return cleanSummaryText(firstW.trim(), depth + 1);
      }
    }

    // 5. 檢查前綴第二次出現的位置 (解決「截斷版... + 完整版」、「完整版 + 截斷版...」或尾部夾帶點數/狀態殘留)
    if (len >= 8) {
      const candidatePrefixLens = Array.from(
        new Set([Math.min(8, Math.floor(len / 2)), Math.min(5, Math.floor(len / 2)), 4])
      ).filter((n) => n >= 3 && n < len);

      for (const pLen of candidatePrefixLens) {
        const prefix = txt.slice(0, pLen);
        let searchFrom = pLen;
        while (searchFrom < len) {
          const idx = txt.indexOf(prefix, searchFrom);
          if (idx === -1) break;

          const firstPart = txt.slice(0, idx).trim();
          const secondPart = txt.slice(idx).trim();

          if (firstPart && secondPart) {
            if (firstPart === secondPart) {
              return cleanSummaryText(firstPart, depth + 1);
            }
            // 前半段為截斷版 (如 "【eMDM】CleanSheet... ")，後半段為完整版
            if (isTruncatedDuplicateOf(firstPart, secondPart)) {
              return cleanSummaryText(secondPart, depth + 1);
            }
            // 前半段為完整版，後半段為截斷版
            if (isTruncatedDuplicateOf(secondPart, firstPart)) {
              return cleanSummaryText(firstPart, depth + 1);
            }
            // 前半段為完整標題 (非省略號結尾)，後半段以完整標題開頭但尾部多出殘留徽章文字 (如 "Title Title 5 RAY")
            if (
              firstPart.length >= 6 &&
              !/(\.{2,}|…)\s*$/.test(firstPart) &&
              secondPart.startsWith(firstPart)
            ) {
              const tail = secondPart.slice(firstPart.length).trim();
              if (tail.length > 0 && tail.length <= 20) {
                return cleanSummaryText(firstPart, depth + 1);
              }
            }
          }

          searchFrom = idx + 1;
        }
      }
    }

    // 6. 檢查字串內部是否包含連續重複兩次的長子字串 (要求含中英數字元，避免誤傷純符號如 "======")
    if (len >= 12) {
      const innerRepeat = txt.match(/(.{6,}?)\s*\1/u);
      if (
        innerRepeat &&
        innerRepeat[1] &&
        /[A-Za-z0-9\u4e00-\u9fa5]/.test(innerRepeat[1]) &&
        !/^[=\-*_~#\s]+$/.test(innerRepeat[1]) &&
        innerRepeat[1].length >= Math.floor(len * 0.35)
      ) {
        return cleanSummaryText(innerRepeat[1].trim(), depth + 1);
      }
    }

    return txt;
  }

  /**
   * 將多段從 DOM 節點取得的文字片段去重 (自動過濾相同文字與截斷重複版，保留最完整的一份)
   */
  function deduplicateSummaryChunks(chunks, issueKey = '') {
    const deduped = [];
    for (const rawChunk of chunks) {
      let chunk = cleanSummaryText(rawChunk);
      if (!chunk) continue;
      if (issueKey && chunk === issueKey) continue;

      let handled = false;
      for (let i = 0; i < deduped.length; i++) {
        const existing = deduped[i];
        if (chunk === existing || isTruncatedDuplicateOf(chunk, existing)) {
          // 目前片段與既有片段相同，或是既有片段的截斷版 -> 略過目前片段
          handled = true;
          break;
        }
        if (isTruncatedDuplicateOf(existing, chunk)) {
          // 既有片段是目前片段的截斷版 -> 以更完整的目前片段取代既有片段
          deduped[i] = chunk;
          handled = true;
          break;
        }
        if (chunk.length >= 6 && existing.includes(chunk)) {
          handled = true;
          break;
        }
        if (existing.length >= 6 && chunk.includes(existing)) {
          deduped[i] = chunk;
          handled = true;
          break;
        }
      }

      if (!handled) {
        deduped.push(chunk);
      }
    }
    return deduped;
  }

  /**
   * 判斷 DOM 元素是否為螢幕報讀專用 (VisuallyHidden) 或隱藏節點
   */
  function isVisuallyHiddenOrIgnoredNode(el) {
    if (!el || !(el instanceof Element)) return false;
    if (
      el.matches(
        '[aria-hidden="true"], [class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], [hidden], svg, img, style, script, noscript'
      )
    ) {
      return true;
    }
    if (el.isConnected) {
      try {
        const style = window.getComputedStyle(el);
        if (style) {
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return true;
          }
          if (
            (style.width === '1px' && style.height === '1px') ||
            (style.clip && style.clip.includes('rect(1px')) ||
            (style.clipPath && style.clipPath.includes('inset(50%)'))
          ) {
            return true;
          }
        }
      } catch {}
    }
    return false;
  }

  /**
   * 從原生卡片 DOM 中提取乾淨且無重複的標題
   */
  function extractCleanSummaryFromDom(cardEl, issueKey = '') {
    if (!cardEl) return '';

    const summarySelectors = [
      '[data-testid="software-backlog.card-list.card.card-contents.summary"]',
      '[data-testid*="card-contents.summary"]',
      '[data-testid*="summary"]',
      '[data-testid*="card-title"]',
      '.ghx-summary .ghx-inner',
      '.ghx-summary'
    ];

    let summaryEl = null;
    for (const sel of summarySelectors) {
      const found = cardEl.querySelector(sel);
      if (found) {
        summaryEl = found;
        break;
      }
    }

    // 若無明確 summary data-testid，嘗試尋找卡片編號連結 (a[href*="/browse/"]) 後方的同層標題節點
    if (!summaryEl) {
      const keyAnchor =
        cardEl.querySelector('a[href*="/browse/"]') ||
        cardEl.querySelector('[data-testid*="accessible-card-key"]') ||
        cardEl.querySelector('[data-testid*="key"]');
      if (keyAnchor) {
        let sib = keyAnchor.nextElementSibling;
        while (sib) {
          if (
            !sib.matches(
              '[data-testid*="status"], [data-testid*="estimate"], [data-testid*="priority"], [data-testid*="assignee"], [data-testid*="epic"], [data-testid*="parent"], [data-testid*="due"]'
            )
          ) {
            const txt = (sib.textContent || '').trim();
            if (txt && txt !== issueKey) {
              summaryEl = sib;
              break;
            }
          }
          sib = sib.nextElementSibling;
        }
      }
    }

    if (!summaryEl) return '';

    const nonSummaryFieldSelector =
      'svg, img, style, script, button, [data-testid*="key"], [data-testid*="epic"], [data-testid*="parent"], [data-testid*="lozenge"], [data-testid*="status"], [data-testid*="estimate"], [data-testid*="story-point"], [data-testid*="points"], [data-testid*="statistic"], [data-testid*="priority"], [data-testid*="assignee"], [data-testid*="avatar"], [data-testid*="due-date"], [data-testid*="duedate"], [data-testid*="subtask"], .ghx-key, .ghx-end, .ghx-stat-fields';

    // 步驟 1：走訪活體 summaryEl 的文字節點，先在節點層級將重複或截斷的 span 去重，避免被 textContent 直接串接
    const collectTextChunks = (ignoreHidden) => {
      const chunks = [];
      const walker = document.createTreeWalker(summaryEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(nonSummaryFieldSelector)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (ignoreHidden) {
            let curr = parent;
            while (curr && curr !== summaryEl) {
              if (isVisuallyHiddenOrIgnoredNode(curr)) {
                return NodeFilter.FILTER_REJECT;
              }
              curr = curr.parentElement;
            }
          }
          const val = (node.nodeValue || '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          return val ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
      });

      let currentNode = walker.nextNode();
      while (currentNode) {
        const val = (currentNode.nodeValue || '')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (val && val !== issueKey) {
          chunks.push(val);
        }
        currentNode = walker.nextNode();
      }
      return chunks;
    };

    let rawChunks = collectTextChunks(true);
    if (rawChunks.length === 0) {
      rawChunks = collectTextChunks(false);
    }

    if (rawChunks.length > 0) {
      const deduped = deduplicateSummaryChunks(rawChunks, issueKey);
      if (deduped.length === 1) {
        return cleanSummaryText(deduped[0]);
      }
      if (deduped.length > 1) {
        return cleanSummaryText(deduped.join(' '));
      }
    }

    // 步驟 2：備援直接取 summaryEl 文字並交由 cleanSummaryText 深度去重
    const fallbackRaw = (summaryEl.textContent || '').replace(/\s+/g, ' ').trim();
    return cleanSummaryText(fallbackRaw);
  }

  /**
   * 清理 Sprint 標題，移除尾部殘留的卡片數量與日期區間
   */
  function cleanSprintTitle(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let t = raw.replace(/\s+/g, ' ').trim();
    // 移除尾部括號中的卡片/工作項目數量，例如 (29 個工作項目), (29 個工作項目中的 5 個), (5 / 29 個工作項目), (5 of 29 issues)
    t = t.replace(
      /\s*\(\s*\d+\s*(?:(?:\/|of)\s*\d+\s*)?(?:個工作項目|個問題|工作項目|issues?|cards?|items?|張卡片)(?:\s*中的\s*\d+\s*個?)?\s*\)\s*$/i,
      ''
    );
    // 移除尾部日期區間，例如 22 10月 – 4 11月, 2026/10/22 - 2026/11/04
    t = t.replace(/\s+\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?\s*[-~至到–—]\s*\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?\s*$/i, '');
    t = t.replace(/\s+\d{1,2}\s*[^\d\s\(\)]+\s*[-~至到–—]\s*\d{1,2}\s*[^\d\s\(\)]+\s*$/i, '');
    return t.trim() || raw.trim();
  }

  /**
   * 計算一個衝刺中各狀態的卡片數與 Story Points 總和
   */
  function calculateSprintStatistics(issues) {
    if (!Array.isArray(issues) || issues.length === 0) {
      return {
        totalIssues: 0,
        todoCount: 0,
        inProgressCount: 0,
        doneCount: 0,
        totalPoints: 0,
        todoPoints: 0,
        inProgressPoints: 0,
        donePoints: 0
      };
    }

    let doneCount = 0;
    let inProgressCount = 0;
    let todoCount = 0;

    let donePoints = 0;
    let inProgressPoints = 0;
    let todoPoints = 0;

    issues.forEach((iss) => {
      const pt = parseFloat(iss.storyPoints);
      const points = !isNaN(pt) && pt > 0 ? pt : 0;

      if (iss.statusCategory === 'done') {
        doneCount++;
        donePoints += points;
      } else if (iss.statusCategory === 'indeterminate') {
        inProgressCount++;
        inProgressPoints += points;
      } else {
        todoCount++;
        todoPoints += points;
      }
    });

    const roundPt = (val) => Math.round(val * 10) / 10;

    return {
      totalIssues: issues.length,
      todoCount,
      inProgressCount,
      doneCount,
      totalPoints: roundPt(donePoints + inProgressPoints + todoPoints),
      todoPoints: roundPt(todoPoints),
      inProgressPoints: roundPt(inProgressPoints),
      donePoints: roundPt(donePoints)
    };
  }

  /**
   * 動態向 Jira API 探測當前環境 Story Points 專用的 Custom Field ID (如 customfield_10016 等)
   */
  async function detectStoryPointsCustomField() {
    if (cachedStoryPointsFieldId) return cachedStoryPointsFieldId;
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
              cachedStoryPointsFieldId = sp.id;
              return sp.id;
            }
          }
        }
      } catch {}
    }
    return null;
  }

  /**
   * 透過 Agile API 取得指定看板的 active 與 future sprints 清單
   */
  async function fetchActiveAndFutureSprintsForBoard(boardId) {
    if (!boardId) return [];
    if (cachedBoardSprints) return cachedBoardSprints;
    try {
      const res = await fetch(
        `${window.location.origin}/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?state=active,future&maxResults=100`,
        { credentials: 'include', headers: { Accept: 'application/json' } }
      );
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.values)) {
          cachedBoardSprints = data.values;
          return data.values;
        }
      }
    } catch {}
    return [];
  }

  /**
   * 更新左側欄指定衝刺的 StoryPoint / 卡片總計徽章
   */
  function updateSidebarBadgeForSprint(key, points, count) {
    const badge = document.querySelector(`.bjwt-sprint-tab-badge[data-bjwt-tab-key="${CSS.escape(key)}"]`);
    if (badge) {
      const badgeText = points > 0 ? `${points} 點` : `${count}`;
      badge.textContent = badgeText;
      badge.title = `共 ${points > 0 ? `${points} 點 Story Points · ` : ''}${count} 個工作項目`;
    }
  }

  /**
   * 清理負責人標籤字串 (去除 Jira 前綴與篩選後綴)
   */
  function cleanAssigneeLabel(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return '';
    s = s
      .replace(
        /^(?:負責人|經辦人|指派給|指派對象|篩選依據|依|使用者|頭像|Assignee|Assigned\s+to|Filter\s+by(?:\s+assignee)?|User|Avatar(?:\s+for)?)\s*[:：]?\s*/i,
        ''
      )
      .trim();
    s = s
      .replace(/\s*[,，(（]?\s*(?:已選取|未選取|selected|not\s+selected|unselected)\s*[)）]?$/i, '')
      .trim();
    s = s.replace(/\s*(?:篩選|的頭像|filter|avatar)$/i, '').trim();
    return s;
  }

  /**
   * 檢查字串是否代表「未指派 (Unassigned)」
   */
  function isUnassignedText(str) {
    if (!str) return false;
    const t = cleanAssigneeLabel(str).toLowerCase();
    return /^(?:未指派|未分配|無負責人|無經辦人|無|unassigned|no\s+assignee|none)$/i.test(t);
  }

  /**
   * 從負責人姓名推導各種可能的縮寫形式 (例如 "Ray Huang" -> ["RAY", "RH", "R"], "Bruce Peng" -> ["BP", "BRUCE", "B"])
   */
  function deriveInitialsVariants(name, explicitInitials = '') {
    const variants = new Set();
    if (explicitInitials) {
      const cleanInit = explicitInitials.trim().toUpperCase();
      if (cleanInit && !isUnassignedText(cleanInit)) {
        variants.add(cleanInit);
      }
    }
    if (!name || isUnassignedText(name)) {
      return Array.from(variants);
    }

    const cleaned = cleanAssigneeLabel(name);
    if (!cleaned || isUnassignedText(cleaned)) {
      return Array.from(variants);
    }

    if (cleaned.length <= 5 && !/\s/.test(cleaned)) {
      variants.add(cleaned.toUpperCase());
    }

    const parts = cleaned
      .split(/[\s_.\-@()（），,\/]+/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length > 0) {
      const firstWord = parts[0].toUpperCase();
      if (firstWord.length <= 6) {
        variants.add(firstWord);
      }
      variants.add(firstWord.slice(0, 1));
      if (firstWord.length >= 2) {
        variants.add(firstWord.slice(0, 2));
      }
      if (firstWord.length >= 3) {
        variants.add(firstWord.slice(0, 3));
      }
    }

    if (parts.length >= 2) {
      const wordInitials = parts
        .slice(0, 3)
        .map((p) => p[0].toUpperCase())
        .join('');
      if (wordInitials) {
        variants.add(wordInitials);
      }
      const firstTwoInitials = (parts[0][0] + parts[1][0]).toUpperCase();
      variants.add(firstTwoInitials);
    }

    return Array.from(variants);
  }

  /**
   * 決定卡片上顯示的縮寫文字 (優先採用原生 DOM 的縮寫如 "RAY"、"BP"、"B")
   */
  function getDisplayInitialsForIssue(iss) {
    if (!iss || iss.isUnassigned || isUnassignedText(iss.assigneeName)) {
      return '';
    }
    if (iss.assigneeInitials && !isUnassignedText(iss.assigneeInitials)) {
      return iss.assigneeInitials.trim().slice(0, 4).toUpperCase();
    }
    const name = cleanAssigneeLabel(iss.assigneeName || '');
    if (!name || isUnassignedText(name)) return '?';
    if (name.length <= 4 && !/\s/.test(name)) {
      return name.toUpperCase();
    }
    const parts = name
      .split(/[\s_.\-@()]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2 && /^[A-Za-z]/.test(parts[0]) && /^[A-Za-z]/.test(parts[1])) {
      if (parts[0].length <= 3) {
        return parts[0].toUpperCase();
      }
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 3).toUpperCase();
  }

  /**
   * 正規化頭像圖片網址以便比對 (去除 size 等查詢參數)
   */
  function normalizeAvatarUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (/issuetype|\/type\/|priority|status/i.test(url)) return '';
    try {
      const u = new URL(url, window.location.origin);
      return `${u.origin}${u.pathname}`.replace(/\/(?:small|medium|large|xsmall|xxlarge)$/i, '');
    } catch {
      return url.split('?')[0];
    }
  }

  /**
   * 將原生 DOM 卡片與 API 卡片資料融合並存入 issueMetadataMap
   */
  function mergeAndCacheIssue(primaryIss, secondaryIss = null) {
    if (!primaryIss || !primaryIss.key) return primaryIss;
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
   * 偵測 Jira 原生篩選搜尋區 (搜尋框、人員頭像篩選、未指派篩選、快速篩選等) 的目前狀態
   */
  function getNativeBacklogFilterState() {
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
    } catch {}

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
   */
  function doesIssueMatchAssigneeFilter(iss, filterState) {
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

  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${cleanPath}`;
    } catch {
      return rawUrl.trim().replace(/\/+$/, '');
    }
  }

  function isUrlMatched(currentHref, targetBacklogUrl) {
    if (!targetBacklogUrl || !targetBacklogUrl.trim()) return false;
    const normCurrent = normalizeUrl(currentHref);
    const normTarget = normalizeUrl(targetBacklogUrl);
    if (!normCurrent || !normTarget) return false;

    return (
      normCurrent === normTarget ||
      currentHref.startsWith(targetBacklogUrl.trim()) ||
      normCurrent.startsWith(normTarget)
    );
  }

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

  /**
   * 尋找頁面上所有原生的衝刺 (Sprint / Backlog) 容器 (排除歷史衝刺自訂容器)
   */
  function findSprintContainers() {
    for (const selector of SPRINT_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector)).filter(
        (el) => !el.closest('[data-bjwt-history-branch="true"]')
      );
      if (nodes.length > 0) {
        const topLevel = nodes.filter(
          (el) => !nodes.some((other) => other !== el && other.contains(el))
        );
        if (topLevel.length > 0) {
          return topLevel;
        }
      }
    }
    return [];
  }

  /**
   * 找出所有衝刺容器的最低共同父節點 (Lowest Common Ancestor)
   */
  function findLowestCommonAncestor(elements) {
    if (!elements || elements.length === 0) return null;
    if (elements.length === 1) return elements[0].parentElement;

    let candidate = elements[0].parentElement;
    while (candidate && candidate !== document.body && candidate !== document.documentElement) {
      const containsAll = elements.every((el) => candidate.contains(el));
      if (containsAll) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    return elements[0].parentElement;
  }

  /**
   * 檢查元素是否位於某張卡片內部
   */
  function isInsideCard(el) {
    if (!el || !(el instanceof Element)) return false;
    for (const sel of CARD_SELECTORS) {
      if (el.closest(sel)) return true;
    }
    return false;
  }

  /**
   * 檢查文字是否為有意義的衝刺名稱 (過濾純數字、純問題數量、按鈕文字等)
   */
  function isValidSprintTitleCandidate(text) {
    if (!text) return false;
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (!cleaned || cleaned.length < 2) return false;
    if (IGNORED_BUTTON_TEXTS.has(cleaned.toLowerCase())) return false;
    if (/^\(?(\d+)\s*(個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?|點|points?)\)?$/i.test(cleaned)) {
      return false;
    }
    if (/^[\d\s.,()\-+/]+$/.test(cleaned)) {
      return false;
    }
    return true;
  }

  /**
   * 僅在使用者於左欄手動點擊切換衝刺時，檢查該衝刺標頭是否處於收合狀態；
   * 絕不在 MutationObserver 中自動觸發任何 click，避免誤觸「+ 建立問題」按鈕。
   */
  function expandSprintHeaderOnUserSelect(branchEl, sprintEl, headerPartner) {
    // 若該衝刺內已經有可見的卡片，代表已經是展開狀態，不需點擊任何按鈕
    for (const sel of CARD_SELECTORS) {
      const existingCard = (branchEl || sprintEl).querySelector(sel);
      if (existingCard && existingCard.offsetParent !== null) {
        return;
      }
    }

    // 僅尋找衝刺標頭列 (Header) 內的風琴夾展開按鈕，嚴格排除底部新增卡片區域
    const headerCandidates = [
      headerPartner,
      branchEl && branchEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header'),
      sprintEl && sprintEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header')
    ].filter(Boolean);

    for (const hdr of headerCandidates) {
      const toggleBtn = hdr.querySelector('[aria-expanded="false"]');
      if (
        toggleBtn &&
        !toggleBtn.hasAttribute('aria-haspopup') &&
        !isInsideCard(toggleBtn)
      ) {
        toggleBtn.click();
        return;
      }
    }

    if (sprintEl && sprintEl.classList && sprintEl.classList.contains('ghx-closed')) {
      const expander = sprintEl.querySelector('.ghx-expander, .js-expander');
      if (expander) expander.click();
    }
  }

  /**
   * 檢查某個原生 Sprint 容器是否處於風琴夾收合狀態
   */
  function isNativeSprintCollapsed(branchEl, sprintEl, headerPartner) {
    const headerCandidates = [
      headerPartner,
      branchEl && branchEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header'),
      sprintEl && sprintEl.querySelector('[data-testid*="card-list.header"], [data-testid*="sprint-header"], .ghx-backlog-header, header')
    ].filter(Boolean);

    for (const hdr of headerCandidates) {
      const toggleBtn = hdr.querySelector('[aria-expanded="false"]');
      if (toggleBtn && !toggleBtn.hasAttribute('aria-haspopup') && !isInsideCard(toggleBtn)) {
        return true;
      }
    }
    if (sprintEl && sprintEl.classList && sprintEl.classList.contains('ghx-closed')) {
      return true;
    }
    return false;
  }

  /**
   * 擷取衝刺的真實名稱與卡片數量 (支援讀取原生篩選後的數量，如「29 個工作項目中的 5 個」)
   */
  function extractSprintMeta(branchEl, sprintEl, headerPartner, index) {
    const searchRoots = [headerPartner, branchEl, sprintEl, sprintEl.parentElement].filter(Boolean);

    let title = '';

    // 1. 優先從明確的標題 Selector 尋找 (排除卡片內部元素)
    const explicitSelectors = [
      '[data-testid*="sprint-name"]',
      '[data-testid*="header.title"]',
      '[data-testid*="backlog-header"]',
      '[data-testid*="card-list.header"] h2',
      '[data-testid*="card-list.header"] h3',
      '[data-testid*="card-list.header"] [role="heading"]',
      '[data-testid*="header"] h2',
      '[data-testid*="header"] h3',
      '[data-testid*="header"] [role="heading"]',
      '.ghx-name',
      'h2',
      'h3',
      'h4',
      '[role="heading"]'
    ];

    for (const root of searchRoots) {
      if (title) break;
      for (const sel of explicitSelectors) {
        const matches = root.querySelectorAll(sel);
        for (const el of matches) {
          if (isInsideCard(el)) continue;
          const candidate = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (isValidSprintTitleCandidate(candidate)) {
            title = candidate;
            break;
          }
        }
        if (title) break;
      }
    }

    // 2. 檢查是否有 inline-edit 的 <input> 儲存衝刺名稱
    if (!title) {
      for (const root of searchRoots) {
        const inputs = root.querySelectorAll('input[type="text"], input:not([type])');
        for (const inp of inputs) {
          if (isInsideCard(inp)) continue;
          const val = (inp.value || '').trim();
          if (isValidSprintTitleCandidate(val)) {
            title = val;
            break;
          }
        }
        if (title) break;
      }
    }

    // 3. 檢查容器或風琴夾按鈕上的 aria-label
    if (!title) {
      for (const root of searchRoots) {
        const ariaNodes = [
          root,
          ...Array.from(root.querySelectorAll('[aria-expanded], [role="region"], [data-testid*="header"]'))
        ];
        for (const node of ariaNodes) {
          if (!node || !(node instanceof Element) || isInsideCard(node)) continue;
          const label = (node.getAttribute('aria-label') || '').trim();
          if (isValidSprintTitleCandidate(label)) {
            title = label;
            break;
          }
        }
        if (title) break;
      }
    }

    // 4. 走訪非卡片區域的文字節點，取第一個有意義的標頭文字 (即衝刺名稱)
    if (!title) {
      for (const root of searchRoots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (isInsideCard(parent)) return NodeFilter.FILTER_REJECT;
            if (parent.closest('button') && !parent.closest('[aria-expanded]')) {
              return NodeFilter.FILTER_REJECT;
            }
            const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
            return isValidSprintTitleCandidate(txt)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP;
          }
        });
        const firstTextNode = walker.nextNode();
        if (firstTextNode) {
          title = firstTextNode.nodeValue.replace(/\s+/g, ' ').trim();
          break;
        }
      }
    }

    if (!title) {
      title = `衝刺 ${index + 1}`;
    }

    // 計算原生 DOM 中的真實卡片數量 (嚴格排除自定義檢視卡片與容器節點)
    let cardNodes = [];
    for (const root of [branchEl, sprintEl]) {
      if (!root) continue;
      for (const cardSel of CARD_SELECTORS) {
        const foundCards = Array.from(root.querySelectorAll(cardSel)).filter(
          (c) =>
            !c.classList.contains('bjwt-history-card') &&
            !c.closest('[data-bjwt-custom-view]')
        );
        if (foundCards.length > 0) {
          cardNodes = foundCards.filter(
            (c) => !foundCards.some((other) => other !== c && other.contains(c))
          );
          break;
        }
      }
      if (cardNodes.length > 0) break;
    }

    // 從標頭擷取文字顯示的工作項目數量 (包含篩選後「29 個工作項目中的 5 個」或「5 of 29 issues」)
    let headerFilteredCount = null;
    let headerTotalCount = null;
    for (const root of searchRoots) {
      const headerEl =
        root.querySelector('[data-testid*="header"], .ghx-backlog-header, header') || root;
      const headerText = (headerEl.innerText || headerEl.textContent || '').replace(/\s+/g, ' ');
      const zhSubsetMatch = headerText.match(
        /(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)\s*中的\s*(\d+)\s*個?/i
      );
      if (zhSubsetMatch) {
        headerTotalCount = parseInt(zhSubsetMatch[1], 10);
        headerFilteredCount = parseInt(zhSubsetMatch[2], 10);
        break;
      }
      const enSubsetMatch = headerText.match(
        /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)/i
      );
      if (enSubsetMatch) {
        headerFilteredCount = parseInt(enSubsetMatch[1], 10);
        headerTotalCount = parseInt(enSubsetMatch[2], 10);
        break;
      }
      const countMatch = headerText.match(
        /(\d+)\s*(?:個問題|個工作項目|工作項目|issues?|張卡片|cards?|items?)/i
      );
      if (countMatch) {
        headerTotalCount = parseInt(countMatch[1], 10);
        break;
      }
    }

    const isCollapsed = isNativeSprintCollapsed(branchEl, sprintEl, headerPartner);
    let cardCount = cardNodes.length;
    if (cardCount === 0 && isCollapsed) {
      if (headerFilteredCount !== null) {
        cardCount = headerFilteredCount;
      } else if (headerTotalCount !== null) {
        cardCount = headerTotalCount;
      }
    }

    // 擷取 sprintId (若 DOM 節點上有)
    let sprintId =
      sprintEl.getAttribute('data-sprint-id') ||
      branchEl.getAttribute('data-sprint-id') ||
      '';
    if (!sprintId) {
      for (const root of searchRoots) {
        const foundEl = root.querySelector(
          '[data-sprint-id], [data-testid*="container-"], [data-testid*="header-"]'
        );
        if (foundEl) {
          sprintId = foundEl.getAttribute('data-sprint-id') || '';
          if (!sprintId) {
            const m = (foundEl.getAttribute('data-testid') || '').match(/(\d{2,})/);
            if (m) sprintId = m[1];
          }
          if (sprintId) break;
        }
      }
    }

    // 擷取原生標頭上的 Story Points (例如三個數字徽章 [26] [38] [17])
    let headerStoryPoints = 0;
    for (const root of searchRoots) {
      const headerEl =
        root.querySelector('[data-testid*="header"], .ghx-backlog-header, header') || root;
      const badges = Array.from(
        headerEl.querySelectorAll(
          '[data-testid*="badge"], [data-testid*="estimate"], [class*="badge"], [class*="estimate"]'
        )
      );
      let sum = 0;
      let count = 0;
      badges.forEach((b) => {
        if (isInsideCard(b)) return;
        const txt = (b.textContent || '').trim();
        if (/^\d{1,3}(\.\d)?$/.test(txt)) {
          sum += parseFloat(txt);
          count++;
        }
      });
      if (count >= 1 && sum > 0) {
        headerStoryPoints = Math.round(sum * 10) / 10;
        break;
      }
    }

    const cleanedTitle = cleanSprintTitle(title);
    const key =
      sprintId ||
      sprintEl.getAttribute('data-sprint-id') ||
      branchEl.getAttribute('data-sprint-id') ||
      sprintEl.getAttribute('id') ||
      `${index}__${cleanedTitle}`;

    return {
      key,
      sprintId,
      index,
      title: cleanedTitle,
      rawTitle: title,
      domCardCount: cardNodes.length,
      headerFilteredCount,
      headerTotalCount,
      isCollapsed,
      cardCount,
      headerStoryPoints,
      storyPoints: headerStoryPoints
    };
  }

  /**
   * 預先將從 sprintsHost 往上到 <main> 之間的祖先鏈鎖定為 100% 寬度，
   * 確保點擊卡片的瞬間，右欄絕對不會被 Jira 的分割面板切成兩半。
   */
  function lockBacklogAncestorWidths(sprintsHost) {
    if (!sprintsHost) return;
    const mainBoundary =
      sprintsHost.closest('main, [role="main"]') || document.body;
    let curr = sprintsHost;
    while (curr && curr !== mainBoundary && curr !== document.body) {
      curr.setAttribute('data-bjwt-backlog-pane', 'true');
      curr = curr.parentElement;
    }
  }

  /**
   * 整合並計算單一未結束衝刺在目前原生篩選狀態下應顯示的卡片清單與點數統計
   */
  function resolveSprintIssuesForLayout(item, nativeFilter) {
    const { branch, sprintEl, meta } = item;
    const key = meta.key;

    // 每次都從原生 DOM 讀取目前實際存在的卡片 (因為 CSS 保留了離屏尺寸，Jira 篩選後 DOM 卡片會即時增減)
    const rawDomIssues = parseIssuesFromBranch(branch, sprintEl);
    const domIssues = rawDomIssues.map((iss) => mergeAndCacheIssue(iss));

    let cached = activeSprintCache.get(key);
    if (!cached) {
      cached = {
        key,
        title: meta.title,
        issues: [],
        allApiIssues: null,
        filterKeyword: '',
        dateRange: '',
        fromApi: false,
        apiSyncing: false
      };
      activeSprintCache.set(key, cached);
    }

    cached.title = meta.title;

    // 若尚未向 Jira API 同步完整欄位 (Story Points / Epic / 精確經辦人)，在背景發起一次 API 同步
    if (!cached.fromApi && !cached.apiSyncing) {
      cached.apiSyncing = true;
      syncActiveSprintIssuesFromApi(item);
    }

    let resolvedIssues = [];
    if (domIssues.length > 0) {
      // 原生 DOM 已有展開的卡片：先以原生 DOM 卡片為基底 (已受 Jira 所有原生篩選器過濾)，再套用本地雙重確認篩選
      resolvedIssues = filterIssuesByNativeFilter(domIssues, nativeFilter);
    } else if (!meta.isCollapsed) {
      // 衝刺處於展開狀態，但原生 DOM 內有 0 張卡片 (代表目前篩選條件下此衝刺為 0 張卡片，或原本即為空衝刺)
      if (
        !nativeFilter.isFiltered &&
        meta.headerTotalCount > 0 &&
        Array.isArray(cached.allApiIssues) &&
        cached.allApiIssues.length > 0
      ) {
        resolvedIssues = cached.allApiIssues.map((iss) => mergeAndCacheIssue(iss));
      } else {
        resolvedIssues = [];
      }
    } else {
      // 衝刺處於收合狀態 (Jira 收合時不渲染 DOM 卡片)：若有 API 快取卡片，使用 API 卡片套用原生篩選器計算該人員點數
      if (Array.isArray(cached.allApiIssues) && cached.allApiIssues.length > 0) {
        const apiMerged = cached.allApiIssues.map((iss) => mergeAndCacheIssue(iss));
        resolvedIssues = filterIssuesByNativeFilter(apiMerged, nativeFilter);
      } else {
        resolvedIssues = [];
      }
    }

    cached.issues = resolvedIssues;
    cached.nativeFilterSig = nativeFilter.sig;

    const stats = calculateSprintStatistics(resolvedIssues);
    if (domIssues.length > 0 || !meta.isCollapsed || Array.isArray(cached.allApiIssues)) {
      meta.cardCount = stats.totalIssues;
      meta.storyPoints = stats.totalPoints;
    } else if (nativeFilter.isFiltered) {
      meta.cardCount = meta.headerFilteredCount !== null ? meta.headerFilteredCount : 0;
      meta.storyPoints = 0;
    } else {
      meta.cardCount = meta.headerTotalCount !== null ? meta.headerTotalCount : meta.cardCount;
      meta.storyPoints = meta.headerStoryPoints || 0;
    }
  }

  /**
   * 建立或更新「左欄 20% 衝刺清單 + 右欄 80% 選取衝刺卡片」的雙欄排版
   */
  function applyTwoColumnBacklogLayout() {
    const sprintContainers = findSprintContainers();
    if (sprintContainers.length === 0) {
      return null;
    }

    const sprintsHost = findLowestCommonAncestor(sprintContainers);
    if (!sprintsHost) return null;

    sprintsHost.setAttribute('data-bjwt-layout-host', 'true');
    lockBacklogAncestorWidths(sprintsHost);

    // 偵測目前 Jira 原生篩選搜尋區的狀態 (人員頭像、未指派、搜尋關鍵字)
    const nativeFilter = getNativeBacklogFilterState();

    // 找出每個衝刺在 sprintsHost 下的直接子節點 (branch)
    const branchSet = new Set();
    const rawSprintItems = sprintContainers.map((sprintEl) => {
      let branch = sprintEl;
      while (branch.parentElement && branch.parentElement !== sprintsHost) {
        branch = branch.parentElement;
      }
      branchSet.add(branch);
      return { sprintEl, branch };
    });

    // 若某個衝刺的標頭是 branch 的前一個兄弟節點 (headerPartner)，將其配對關聯
    const sprintBranches = rawSprintItems.map((item, idx) => {
      const { sprintEl, branch } = item;
      let headerPartner = null;
      const prev = branch.previousElementSibling;
      if (
        prev &&
        prev.id !== SIDEBAR_ID &&
        !branchSet.has(prev) &&
        (prev.matches('[data-testid*="header"], header, .ghx-backlog-header') ||
          prev.querySelector('[data-testid*="header"], h2, h3, [role="heading"], [aria-expanded]'))
      ) {
        headerPartner = prev;
        headerPartner.setAttribute('data-bjwt-sprint-header-partner', 'true');
      }

      sprintEl.setAttribute('data-bjwt-sprint-container', 'true');
      branch.setAttribute('data-bjwt-sprint-branch', 'true');
      branch.setAttribute('data-bjwt-sprint-index', String(idx));

      const meta = extractSprintMeta(branch, sprintEl, headerPartner, idx);
      meta.isHistorical = false;
      const branchObj = { sprintEl, branch, headerPartner, meta };
      resolveSprintIssuesForLayout(branchObj, nativeFilter);
      return branchObj;
    });

    // 將目前已載入的「歷史 Sprint (已結束)」動態同步 / Append 至 sprintsHost 與 sprintBranches
    const validHistoryKeys = new Set(loadedHistoricalSprints.map((h) => h.key));
    Array.from(sprintsHost.querySelectorAll('[data-bjwt-history-branch="true"]')).forEach((el) => {
      const k = el.getAttribute('data-bjwt-history-key');
      if (!validHistoryKeys.has(k)) {
        el.remove();
      }
    });

    loadedHistoricalSprints.forEach((histItem) => {
      const idx = sprintBranches.length;
      let histBranch = sprintsHost.querySelector(
        `[data-bjwt-history-branch="true"][data-bjwt-history-key="${CSS.escape(histItem.key)}"]`
      );
      if (!histBranch) {
        histBranch = document.createElement('div');
        histBranch.className = 'bjwt-history-sprint-branch';
        histBranch.setAttribute('data-bjwt-history-branch', 'true');
        histBranch.setAttribute('data-bjwt-history-key', histItem.key);
        sprintsHost.appendChild(histBranch);
      }

      histBranch.setAttribute('data-bjwt-sprint-branch', 'true');
      histBranch.setAttribute('data-bjwt-sprint-container', 'true');
      histBranch.setAttribute('data-bjwt-sprint-index', String(idx));

      renderHistoricalSprintBranch(histBranch, histItem, nativeFilter);

      const filteredHistIssues = filterIssuesByNativeFilter(histItem.issues || [], nativeFilter);
      const histStats = calculateSprintStatistics(filteredHistIssues);

      sprintBranches.push({
        sprintEl: histBranch,
        branch: histBranch,
        headerPartner: null,
        meta: {
          key: histItem.key,
          index: idx,
          title: cleanSprintTitle(histItem.title),
          rawTitle: histItem.title,
          cardCount: filteredHistIssues.length,
          storyPoints: histStats.totalPoints,
          isHistorical: true,
          sprintId: histItem.sprintId,
          startDate: histItem.startDate,
          endDate: histItem.endDate,
          completeDate: histItem.completeDate
        }
      });
    });

    // 標記 sprintsHost 下非衝刺、也非側邊欄的其他直接子元素
    Array.from(sprintsHost.children).forEach((child) => {
      if (
        child.id !== SIDEBAR_ID &&
        !child.hasAttribute('data-bjwt-sprint-branch') &&
        !child.hasAttribute('data-bjwt-sprint-header-partner') &&
        !child.hasAttribute('data-bjwt-history-branch')
      ) {
        child.setAttribute('data-bjwt-non-sprint-child', 'true');
      } else {
        child.removeAttribute('data-bjwt-non-sprint-child');
      }
    });

    // 決定目前選取的衝刺索引 (每次只能切換一個衝刺)
    let resolvedIndex = 0;
    if (activeSprintKey !== null) {
      const foundByKey = sprintBranches.findIndex((item) => item.meta.key === activeSprintKey);
      if (foundByKey !== -1) {
        resolvedIndex = foundByKey;
      } else if (activeSprintIndex < sprintBranches.length) {
        resolvedIndex = activeSprintIndex;
      }
    } else if (activeSprintIndex < sprintBranches.length) {
      resolvedIndex = activeSprintIndex;
    }

    activeSprintIndex = resolvedIndex;
    activeSprintKey = sprintBranches[resolvedIndex].meta.key;

    // 切換右欄 80%：只顯示目前選取的衝刺，其餘衝刺隱藏
    sprintBranches.forEach((item, idx) => {
      const isSelected = idx === resolvedIndex;
      const activeVal = isSelected ? 'true' : 'false';
      item.branch.setAttribute('data-bjwt-sprint-active', activeVal);
      item.sprintEl.setAttribute('data-bjwt-sprint-active', activeVal);
      if (item.headerPartner) {
        item.headerPartner.setAttribute('data-bjwt-sprint-active', activeVal);
      }

      // 未結束衝刺：改用自定義卡片檢視 (與歷史衝刺一體呈現)
      if (isSelected && !item.meta.isHistorical) {
        renderActiveSprintBranch(item, nativeFilter);
      }
    });

    // 建立或更新左欄 20% 衝刺切換側邊欄
    let sidebar = document.getElementById(SIDEBAR_ID);
    if (!sidebar) {
      sidebar = document.createElement('aside');
      sidebar.id = SIDEBAR_ID;
    }

    sprintsHost.setAttribute(
      'data-bjwt-sidebar-collapsed',
      isSidebarCollapsed ? 'true' : 'false'
    );
    sidebar.setAttribute('data-bjwt-collapsed', isSidebarCollapsed ? 'true' : 'false');

    const firstTarget = sprintBranches[0].headerPartner || sprintBranches[0].branch;
    if (sidebar.parentElement !== sprintsHost || sidebar.nextElementSibling !== firstTarget) {
      sprintsHost.insertBefore(sidebar, firstTarget);
    }

    updateColumnsViewportHeight(sprintsHost, sidebar);
    renderSidebarContents(sidebar, sprintBranches, resolvedIndex, nativeFilter);

    return sprintsHost;
  }

  /**
   * 動態計算左右兩欄各自獨立捲動區域的可用視窗高度，
   * 確保左欄與右欄各自擁有獨立卷軸、互不連帶捲動。
   */
  function updateColumnsViewportHeight(sprintsHost, sidebar) {
    const targetEl = sidebar || sprintsHost;
    if (!targetEl) return;
    const rect = targetEl.getBoundingClientRect();
    const topOffset = rect.top > 0 ? rect.top : 140;
    const paneH = Math.max(240, Math.floor(window.innerHeight - topOffset - 16));
    if (sprintsHost) {
      sprintsHost.style.setProperty('--bjwt-pane-h', `${paneH}px`);
    }
    if (sidebar) {
      sidebar.style.setProperty('--bjwt-pane-h', `${paneH}px`);
    }
  }

  /**
   * 渲染左欄 20% 的衝刺選單內容 (區分「未結束衝刺」與「已結束歷史衝刺」，並提供收合/展開 SVG 圖示按鈕與歷史衝刺按鈕)
   */
  function renderSidebarContents(sidebar, sprintBranches, selectedIndex, nativeFilter) {
    ensureRuntimeCriticalStyles();

    const signature = JSON.stringify({
      v: 5,
      selectedIndex,
      collapsed: isSidebarCollapsed,
      theme: currentSettings.themeStyle,
      filterSig: nativeFilter ? nativeFilter.sig : '',
      items: sprintBranches.map((b) => ({
        key: b.meta.key,
        title: b.meta.title,
        count: b.meta.cardCount,
        points: b.meta.storyPoints,
        isHistorical: Boolean(b.meta.isHistorical)
      }))
    });

    if (sidebar.getAttribute('data-bjwt-sig') === signature) {
      return;
    }
    sidebar.setAttribute('data-bjwt-sig', signature);

    const prevList = sidebar.querySelector('.bjwt-sprint-list');
    const prevScrollTop = prevList ? prevList.scrollTop : 0;

    const liveItems = sprintBranches
      .map((item, idx) => ({ item, idx }))
      .filter((x) => !x.item.meta.isHistorical);
    const historyItems = sprintBranches
      .map((item, idx) => ({ item, idx }))
      .filter((x) => Boolean(x.item.meta.isHistorical));

    sidebar.innerHTML = `
      <button
        type="button"
        class="bjwt-sidebar-expand-btn"
        title="展開左欄衝刺清單"
        aria-label="展開左欄衝刺清單"
        aria-expanded="false"
      >
        <svg class="bjwt-icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" ry="3"></rect>
          <line x1="9" y1="3" x2="9" y2="21"></line>
          <polyline points="13 9 16 12 13 15"></polyline>
        </svg>
        <span class="bjwt-sidebar-expand-text">展開衝刺清單</span>
      </button>
      <div class="bjwt-sidebar-header">
        <div class="bjwt-sidebar-title-wrap">
          <span class="bjwt-sidebar-title">衝刺清單</span>
          <span class="bjwt-sidebar-count">${sprintBranches.length}</span>
        </div>
        <div class="bjwt-sidebar-header-actions">
          <button
            type="button"
            class="bjwt-history-trigger-btn"
            title="載入已結束的歷史 Sprint"
            aria-label="載入已結束的歷史 Sprint"
          >
            <svg class="bjwt-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 15"></polyline>
            </svg>
          </button>
          <button
            type="button"
            class="bjwt-sidebar-collapse-btn"
            title="收合左欄衝刺清單，專注於右側當前衝刺"
            aria-label="收合左欄衝刺清單"
            aria-expanded="true"
          >
            <svg class="bjwt-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="3" ry="3"></rect>
              <line x1="9" y1="3" x2="9" y2="21"></line>
              <polyline points="16 15 13 12 16 9"></polyline>
            </svg>
            <span class="bjwt-collapse-btn-label">收合</span>
          </button>
        </div>
      </div>
      <div class="bjwt-sprint-list" role="tablist" aria-label="衝刺切換清單"></div>
    `;

    const collapseBtn = sidebar.querySelector('.bjwt-sidebar-collapse-btn');
    if (collapseBtn) {
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isSidebarCollapsed = true;
        applyTwoColumnBacklogLayout();
      });
    }

    const expandBtn = sidebar.querySelector('.bjwt-sidebar-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isSidebarCollapsed = false;
        applyTwoColumnBacklogLayout();
      });
    }

    const historyTriggerBtn = sidebar.querySelector('.bjwt-history-trigger-btn');
    if (historyTriggerBtn) {
      historyTriggerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openHistorySprintPickerModal();
      });
    }

    const listEl = sidebar.querySelector('.bjwt-sprint-list');

    // 分區 1：進行中 / 未結束的衝刺
    const liveHeader = document.createElement('div');
    liveHeader.className = 'bjwt-sprint-section-header live-section';
    liveHeader.innerHTML = `
      <span class="bjwt-status-dot live-dot" aria-hidden="true"></span>
      <span>未結束衝刺 (${liveItems.length})</span>
    `;
    listEl.appendChild(liveHeader);

    liveItems.forEach(({ item, idx }) => {
      const pts = item.meta.storyPoints || 0;
      const count = item.meta.cardCount || 0;
      const badgeText = pts > 0 ? `${pts} 點` : `${count}`;
      const badgeTitle =
        pts > 0
          ? `${item.meta.title}：共 ${pts} 點 Story Points (${count} 個工作項目)`
          : `${item.meta.title}：共 ${count} 個工作項目`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `bjwt-sprint-tab bjwt-sprint-tab-live ${idx === selectedIndex ? 'active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
      btn.innerHTML = `
        <span class="bjwt-sprint-tab-left">
          <span class="bjwt-status-dot live-item-dot" aria-hidden="true"></span>
          <span class="bjwt-sprint-tab-name" title="${escapeHtml(item.meta.title)}">
            ${escapeHtml(item.meta.title)}
          </span>
        </span>
        <span class="bjwt-sprint-tab-badge" data-bjwt-tab-key="${escapeHtml(item.meta.key)}" title="${escapeHtml(badgeTitle)}">${escapeHtml(badgeText)}</span>
      `;

      btn.addEventListener('click', () => {
        activeSprintIndex = idx;
        activeSprintKey = item.meta.key;
        applyTwoColumnBacklogLayout();
        if (item.branch) {
          item.branch.scrollTop = 0;
        }
        expandSprintHeaderOnUserSelect(item.branch, item.sprintEl, item.headerPartner);
      });

      listEl.appendChild(btn);
    });

    // 分區 2：已結束的歷史衝刺 (若已載入則顯示於專屬歷史區塊)
    if (historyItems.length > 0) {
      const histHeader = document.createElement('div');
      histHeader.className = 'bjwt-sprint-section-header history-section';
      histHeader.innerHTML = `
        <svg class="bjwt-icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"></circle>
          <polyline points="12 7 12 12 15 15"></polyline>
        </svg>
        <span>已結束・歷史衝刺 (${historyItems.length})</span>
      `;
      listEl.appendChild(histHeader);

      historyItems.forEach(({ item, idx }) => {
        const pts = item.meta.storyPoints || 0;
        const count = item.meta.cardCount || 0;
        const badgeText = pts > 0 ? `${pts} 點` : `${count}`;
        const badgeTitle =
          pts > 0
            ? `${item.meta.title}：共 ${pts} 點 Story Points (${count} 個工作項目)`
            : `${item.meta.title}：共 ${count} 個工作項目`;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `bjwt-sprint-tab bjwt-sprint-tab-history ${idx === selectedIndex ? 'active' : ''}`;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', idx === selectedIndex ? 'true' : 'false');
        btn.innerHTML = `
          <span class="bjwt-sprint-tab-left">
            <svg class="bjwt-icon-svg bjwt-history-tab-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 15"></polyline>
            </svg>
            <span class="bjwt-sprint-tab-name" title="${escapeHtml(item.meta.title)} (已結束)">
              ${escapeHtml(item.meta.title)}
            </span>
          </span>
          <span class="bjwt-sprint-tab-right">
            <span class="bjwt-closed-pill">已結束</span>
            <span class="bjwt-sprint-tab-badge" data-bjwt-tab-key="${escapeHtml(item.meta.key)}" title="${escapeHtml(badgeTitle)}">${escapeHtml(badgeText)}</span>
            <span class="bjwt-history-remove-btn" role="button" tabindex="0" title="從清單移除此歷史衝刺" aria-label="移除歷史衝刺">✕</span>
          </span>
        `;

        btn.addEventListener('click', (e) => {
          const target = e.target;
          if (target && target instanceof Element && target.closest('.bjwt-history-remove-btn')) {
            e.stopPropagation();
            removeHistoricalSprint(item.meta.key);
            return;
          }
          activeSprintIndex = idx;
          activeSprintKey = item.meta.key;
          applyTwoColumnBacklogLayout();
          if (item.branch) {
            item.branch.scrollTop = 0;
          }
        });

        listEl.appendChild(btn);
      });
    }

    if (prevScrollTop > 0) {
      listEl.scrollTop = prevScrollTop;
    }
  }

  /**
   * 確保關鍵圖示與歷史衝刺樣式即時注入頁面 (即使瀏覽器快取舊版 styles.css 也能立即呈現收合圖示與歷史 Sprint 介面)
   */
  function ensureRuntimeCriticalStyles() {
    if (document.getElementById(RUNTIME_STYLE_ID)) return;
    const styleEl = document.createElement('style');
    styleEl.id = RUNTIME_STYLE_ID;
    styleEl.textContent = `
      .bjwt-icon-svg {
        display: inline-block !important;
        vertical-align: middle !important;
        flex-shrink: 0 !important;
        overflow: visible !important;
      }
      .bjwt-sidebar-collapse-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 4px !important;
        height: 26px !important;
        padding: 0 8px !important;
        border: 1px solid var(--ds-border-bold, #738496) !important;
        border-radius: 5px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        color: var(--ds-text, #dee4ea) !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        cursor: pointer !important;
        visibility: visible !important;
        opacity: 1 !important;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16) !important;
      }
      .bjwt-sidebar-collapse-btn:hover {
        background: var(--ds-background-selected, rgba(12, 102, 228, 0.2)) !important;
        color: var(--ds-text-selected, #579dff) !important;
        border-color: var(--ds-border-selected, #579dff) !important;
      }
      .bjwt-sidebar-expand-btn {
        display: none !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 8px !important;
        width: 38px !important;
        padding: 12px 4px !important;
        border: 1px solid var(--ds-border-selected, #579dff) !important;
        border-radius: 8px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        color: var(--ds-text-selected, #579dff) !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        box-shadow: 0 2px 8px rgba(12, 102, 228, 0.25) !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] {
        flex: 0 0 38px !important;
        width: 38px !important;
        max-width: 38px !important;
        min-width: 38px !important;
        height: auto !important;
        max-height: none !important;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
        padding: 0 !important;
        overflow: visible !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sidebar-header,
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sprint-list {
        display: none !important;
      }
      html[data-betterjira-layout="two-column"] #bjwt-sprint-sidebar[data-bjwt-collapsed="true"] .bjwt-sidebar-expand-btn {
        display: flex !important;
      }
      html[data-betterjira-layout="two-column"] [data-bjwt-layout-host="true"][data-bjwt-sidebar-collapsed="true"] [data-bjwt-sprint-branch="true"][data-bjwt-sprint-active="true"],
      html[data-betterjira-layout="two-column"] [data-bjwt-layout-host="true"][data-bjwt-sidebar-collapsed="true"] [data-bjwt-sprint-header-partner="true"][data-bjwt-sprint-active="true"] {
        flex: 1 1 calc(100% - 54px) !important;
        width: calc(100% - 54px) !important;
        max-width: calc(100% - 54px) !important;
      }
      .bjwt-sidebar-header-actions {
        display: inline-flex !important;
        align-items: center !important;
        gap: 6px !important;
        flex: 0 0 auto !important;
      }
      .bjwt-history-trigger-btn {
        flex: 0 0 auto !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 26px !important;
        height: 26px !important;
        padding: 0 !important;
        border: 1px solid var(--ds-border-warning, #f59e0b) !important;
        border-radius: 5px !important;
        background: var(--ds-background-warning-subtle, rgba(245, 158, 11, 0.12)) !important;
        color: var(--ds-text-warning, #f59e0b) !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        cursor: pointer !important;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16) !important;
        transition: all 0.15s ease !important;
      }
      .bjwt-history-trigger-btn:hover {
        background: var(--ds-background-warning-hovered, rgba(245, 158, 11, 0.25)) !important;
        border-color: var(--ds-border-warning-hovered, #fbbf24) !important;
        color: var(--ds-text-warning-hovered, #fbbf24) !important;
      }
      .bjwt-history-sprint-container {
        border: 1px solid var(--ds-border, #dfe1e6) !important;
        border-top: 1px solid var(--ds-border, #dfe1e6) !important;
        border-radius: 6px !important;
      }
      .bjwt-history-sprint-banner {
        border: 1px solid var(--ds-border, #dfe1e6) !important;
        border-radius: 6px !important;
      }
      .bjwt-sprint-section-header {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        padding: 7px 12px 5px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        letter-spacing: 0.3px !important;
        border-bottom: 1px solid var(--ds-border, #dfe1e6) !important;
      }
      .bjwt-sprint-section-header.live-section {
        background: var(--ds-surface-sunken, rgba(9, 30, 66, 0.04)) !important;
        color: var(--ds-text-subtle, #64748b) !important;
      }
      .bjwt-sprint-section-header.history-section {
        background: rgba(245, 158, 11, 0.14) !important;
        color: #f59e0b !important;
        border-top: 2px solid rgba(245, 158, 11, 0.35) !important;
        border-bottom: 1px solid rgba(245, 158, 11, 0.35) !important;
      }
      .bjwt-status-dot {
        width: 7px !important;
        height: 7px !important;
        border-radius: 50% !important;
        flex-shrink: 0 !important;
        display: inline-block !important;
      }
      .bjwt-status-dot.live-dot,
      .bjwt-status-dot.live-item-dot {
        background: #22c55e !important;
        box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.22) !important;
      }
      .bjwt-sprint-tab-left {
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        min-width: 0 !important;
        flex: 1 1 auto !important;
      }
      .bjwt-sprint-tab-right {
        display: inline-flex !important;
        align-items: center !important;
        gap: 5px !important;
        flex-shrink: 0 !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history {
        background: rgba(245, 158, 11, 0.07) !important;
        border-left: 3px dashed #f59e0b !important;
        border-bottom: 1px solid var(--ds-border, rgba(245, 158, 11, 0.2)) !important;
        color: var(--ds-text, #f59e0b) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history:hover {
        background: rgba(245, 158, 11, 0.16) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history.active {
        background: rgba(245, 158, 11, 0.24) !important;
        color: #f59e0b !important;
        border-left: 4px solid #f59e0b !important;
        font-weight: 700 !important;
      }
      .bjwt-closed-pill {
        padding: 1px 6px !important;
        border-radius: 4px !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        background: rgba(245, 158, 11, 0.2) !important;
        color: #f59e0b !important;
        border: 1px solid rgba(245, 158, 11, 0.45) !important;
      }
      .bjwt-sprint-tab.bjwt-sprint-tab-history.active .bjwt-closed-pill {
        background: #d97706 !important;
        color: #ffffff !important;
        border-color: #d97706 !important;
      }
      .bjwt-history-remove-btn {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 18px !important;
        height: 18px !important;
        border-radius: 50% !important;
        font-size: 11px !important;
        color: var(--ds-text-subtle, #f59e0b) !important;
        opacity: 0.75 !important;
      }
      .bjwt-history-remove-btn:hover {
        opacity: 1 !important;
        background: rgba(245, 158, 11, 0.28) !important;
      }
      .bjwt-history-priority-icon.bjwt-svg-wrap {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 16px !important;
        height: 16px !important;
        line-height: 1 !important;
      }
      .bjwt-history-priority-icon.bjwt-svg-wrap svg {
        width: 16px !important;
        height: 16px !important;
        max-width: 16px !important;
        max-height: 16px !important;
      }
      #bjwt-history-issue-modal {
        display: flex !important;
        flex-direction: column !important;
        overflow: hidden !important;
        background: var(--ds-surface-overlay, #1d2125) !important;
        border: 1px solid var(--ds-border, #38414a) !important;
      }
      .bjwt-history-issue-modal-header {
        flex: 0 0 auto !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 12px !important;
        padding: 10px 16px !important;
        background: var(--ds-surface-raised, #22272b) !important;
        border-bottom: 1px solid var(--ds-border, #38414a) !important;
      }
      .bjwt-history-issue-modal-title {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        min-width: 0 !important;
      }
      .bjwt-history-modal-key-badge {
        padding: 3px 8px !important;
        border-radius: 4px !important;
        background: rgba(12, 102, 228, 0.2) !important;
        color: #579dff !important;
        font-size: 12px !important;
        font-weight: 700 !important;
        flex-shrink: 0 !important;
      }
      .bjwt-history-modal-summary-text {
        font-size: 14px !important;
        font-weight: 600 !important;
        color: var(--ds-text, #dee4ea) !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      .bjwt-history-issue-modal-actions {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        flex-shrink: 0 !important;
      }
      .bjwt-history-modal-open-tab {
        padding: 4px 10px !important;
        border-radius: 4px !important;
        background: rgba(12, 102, 228, 0.2) !important;
        color: #579dff !important;
        font-size: 12px !important;
        font-weight: 600 !important;
        text-decoration: none !important;
      }
      .bjwt-history-modal-open-tab:hover {
        background: rgba(12, 102, 228, 0.35) !important;
      }
      .bjwt-history-modal-close-btn {
        width: 28px !important;
        height: 28px !important;
        border-radius: 4px !important;
        border: none !important;
        background: transparent !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
        font-size: 15px !important;
        cursor: pointer !important;
      }
      .bjwt-history-modal-close-btn:hover {
        background: rgba(255, 255, 255, 0.1) !important;
      }
      .bjwt-rich-detail-body {
        display: flex !important;
        flex-direction: row !important;
        width: 100% !important;
        height: calc(100% - 50px) !important;
        overflow: hidden !important;
        background: var(--ds-surface, #1d2125) !important;
        color: var(--ds-text, #dee4ea) !important;
      }
      .bjwt-detail-main-col {
        flex: 1 1 68% !important;
        min-width: 0 !important;
        height: 100% !important;
        overflow-y: auto !important;
        padding: 24px 28px !important;
        box-sizing: border-box !important;
      }
      .bjwt-detail-side-col {
        flex: 0 0 320px !important;
        width: 320px !important;
        height: 100% !important;
        overflow-y: auto !important;
        padding: 24px 20px !important;
        background: var(--ds-surface-sunken, rgba(0, 0, 0, 0.2)) !important;
        border-left: 1px solid var(--ds-border, #2c333a) !important;
        box-sizing: border-box !important;
      }
      .bjwt-detail-summary {
        font-size: 20px !important;
        font-weight: 700 !important;
        line-height: 1.35 !important;
        margin: 0 0 20px 0 !important;
        color: var(--ds-text, #ffffff) !important;
        word-break: break-word !important;
      }
      .bjwt-detail-section {
        margin-bottom: 24px !important;
      }
      .bjwt-detail-section-title {
        font-size: 13px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        letter-spacing: 0.5px !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
        margin: 0 0 10px 0 !important;
        border-bottom: 1px solid var(--ds-border, rgba(255, 255, 255, 0.1)) !important;
        padding-bottom: 6px !important;
      }
      .bjwt-detail-description-content {
        font-size: 14px !important;
        line-height: 1.6 !important;
        color: var(--ds-text, #dee4ea) !important;
        word-break: break-word !important;
      }
      .bjwt-detail-description-content p {
        margin: 0 0 10px 0 !important;
      }
      .bjwt-detail-description-content pre {
        background: rgba(0, 0, 0, 0.3) !important;
        padding: 10px 14px !important;
        border-radius: 6px !important;
        overflow-x: auto !important;
        font-family: monospace !important;
      }
      .bjwt-detail-description-content a {
        color: #579dff !important;
        text-decoration: underline !important;
      }
      .bjwt-detail-empty-desc {
        font-size: 13px !important;
        color: var(--ds-text-subtle, #8c9bab) !important;
        font-style: italic !important;
        padding: 8px 0 !important;
      }
      .bjwt-detail-loading-spinner {
        display: inline-block !important;
        width: 14px !important;
        height: 14px !important;
        border: 2px solid rgba(255, 255, 255, 0.2) !important;
        border-top-color: #579dff !important;
        border-radius: 50% !important;
        animation: bjwt-spin 0.8s linear infinite !important;
        vertical-align: middle !important;
        margin-right: 6px !important;
      }
      @keyframes bjwt-spin {
        to { transform: rotate(360deg); }
      }
      .bjwt-detail-field-group {
        display: flex !important;
        flex-direction: column !important;
        gap: 16px !important;
      }
      .bjwt-detail-field {
        display: flex !important;
        flex-direction: column !important;
        gap: 5px !important;
      }
      .bjwt-detail-field-label {
        font-size: 11px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
      }
      .bjwt-detail-field-value {
        font-size: 13px !important;
        color: var(--ds-text, #dee4ea) !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
      }
      .bjwt-user-cell {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
      }
      .bjwt-user-cell img {
        width: 22px !important;
        height: 22px !important;
        border-radius: 50% !important;
      }
      .bjwt-user-avatar-placeholder {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 22px !important;
        height: 22px !important;
        border-radius: 50% !important;
        background: rgba(255, 255, 255, 0.1) !important;
        font-size: 12px !important;
      }
      .bjwt-detail-label-tag {
        display: inline-block !important;
        padding: 2px 7px !important;
        border-radius: 4px !important;
        background: var(--ds-surface-sunken, rgba(255, 255, 255, 0.08)) !important;
        border: 1px solid var(--ds-border, #38414a) !important;
        font-size: 11px !important;
        color: var(--ds-text, #dee4ea) !important;
        margin: 2px 4px 2px 0 !important;
      }
      .bjwt-detail-labels-container {
        display: flex !important;
        flex-wrap: wrap !important;
        gap: 4px !important;
      }
      .bjwt-mention {
        padding: 1px 5px !important;
        border-radius: 3px !important;
        background: rgba(87, 157, 255, 0.18) !important;
        color: #579dff !important;
        font-weight: 600 !important;
      }
      .bjwt-table-wrap {
        max-width: 100% !important;
        overflow-x: auto !important;
        margin: 12px 0 !important;
      }
      .bjwt-table-wrap table {
        width: 100% !important;
        border-collapse: collapse !important;
      }
      .bjwt-table-wrap th,
      .bjwt-table-wrap td {
        border: 1px solid var(--ds-border, #38414a) !important;
        padding: 6px 10px !important;
        font-size: 13px !important;
      }
      .bjwt-table-wrap th {
        background: var(--ds-surface-raised, rgba(255, 255, 255, 0.06)) !important;
        font-weight: 600 !important;
      }
      .bjwt-comment-list {
        display: flex !important;
        flex-direction: column !important;
        gap: 14px !important;
      }
      .bjwt-comment-item {
        padding: 12px 14px !important;
        border-radius: 8px !important;
        background: var(--ds-surface-raised, rgba(255, 255, 255, 0.04)) !important;
        border: 1px solid var(--ds-border, #2c333a) !important;
      }
      .bjwt-comment-header {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        margin-bottom: 8px !important;
      }
      .bjwt-comment-author {
        font-size: 13px !important;
        font-weight: 600 !important;
        color: var(--ds-text, #dee4ea) !important;
      }
      .bjwt-comment-date {
        font-size: 11px !important;
        color: var(--ds-text-subtle, #8c9bab) !important;
      }
      .bjwt-comment-body {
        font-size: 13px !important;
        line-height: 1.5 !important;
        color: var(--ds-text, #cbd5e1) !important;
      }
      .bjwt-subtask-list {
        display: flex !important;
        flex-direction: column !important;
        gap: 6px !important;
      }
      .bjwt-subtask-item {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        padding: 8px 12px !important;
        border-radius: 6px !important;
        background: var(--ds-surface-raised, rgba(255, 255, 255, 0.03)) !important;
        border: 1px solid var(--ds-border, #2c333a) !important;
        font-size: 13px !important;
        cursor: pointer !important;
        transition: background 0.15s ease !important;
      }
      .bjwt-subtask-item:hover {
        background: var(--ds-surface-hovered, rgba(255, 255, 255, 0.08)) !important;
      }
      .bjwt-subtask-key {
        font-weight: 600 !important;
        color: #579dff !important;
        text-decoration: none !important;
      }
      .bjwt-subtask-summary {
        flex: 1 1 auto !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
      }
      .bjwt-history-avatar-unassigned {
        width: 24px !important;
        height: 24px !important;
        border-radius: 50% !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        background: var(--ds-surface-sunken, rgba(255, 255, 255, 0.08)) !important;
        color: var(--ds-text-subtle, #9fadbc) !important;
        border: 1px dashed var(--ds-border, rgba(255, 255, 255, 0.25)) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  /**
   * 從目前網址或頁面偵測 Jira Board ID 與 Project Key
   */
  async function detectJiraContext() {
    const href = window.location.href;
    const boardMatch = href.match(/\/boards\/(\d+)/i) || href.match(/[?&]rapidView=(\d+)/i);
    const projectMatch =
      href.match(/\/projects\/([^/?#]+)/i) || href.match(/[?&]projectKey=([^&#]+)/i);

    let boardId = boardMatch ? boardMatch[1] : cachedBoardId;
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
      cachedBoardId = boardId;
    }

    return { boardId, projectKey };
  }

  /**
   * 透過 Jira Agile API 取得看板最近已結束 (state=closed) 的 Sprint 清單 (由新到舊排序)
   */
  async function fetchClosedSprintsForBoard(forceRefresh = false) {
    if (cachedClosedSprints && !forceRefresh) {
      return cachedClosedSprints;
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

      cachedClosedSprints = allClosed;
      return allClosed;
    } catch {
      return [];
    }
  }

  /**
   * 將 Jira API 回傳的原始 Issue 物件正規化為渲染卡片所需的欄位
   */
  function normalizeJiraIssue(raw) {
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

    let cleanStatus = (statusObj.name || '未知狀態').replace(/\s+/g, ' ').trim();
    cleanStatus = cleanStatus.replace(/(▾|▼|⌵|v|\^)+$/i, '').trim();

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
      dueDate: fields.duedate || '',
      storyPoints
    };

    return mergeAndCacheIssue(issueObj);
  }

  /**
   * 根據使用者輸入的 Sprint 名稱或選定的 Sprint 物件，透過 Jira API 取得已結束 Sprint 的資料與卡片
   */
  async function fetchHistoricalSprintData(sprintNameInput, explicitSprintObj = null) {
    const trimmedName = (sprintNameInput || '').trim();
    const { boardId, projectKey } = await detectJiraContext();

    await detectStoryPointsCustomField();

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
      cachedStoryPointsFieldId
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
          const issues = (data.issues || []).map(normalizeJiraIssue);
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
            const issues = data.issues.map(normalizeJiraIssue);
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
   * 將取得的歷史 Sprint 加入當前頁面狀態並切換顯示
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

    activeSprintKey = sprintData.key;
    applyTwoColumnBacklogLayout();
  }

  /**
   * 從目前頁面移除某個已載入的歷史 Sprint
   */
  function removeHistoricalSprint(historyKey) {
    const idx = loadedHistoricalSprints.findIndex((item) => item.key === historyKey);
    if (idx === -1) return;
    loadedHistoricalSprints.splice(idx, 1);
    if (activeSprintKey === historyKey) {
      activeSprintKey = null;
      activeSprintIndex = 0;
    }
    applyTwoColumnBacklogLayout();
  }

  function formatShortDate(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return '';
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}/${m}/${day}`;
    } catch {
      return '';
    }
  }

  /**
   * 開啟「載入歷史 Sprint」對話框：支援直接輸入 Sprint 名稱查詢，並自動列出最近已結束的 Sprint 供點選
   */
  function openHistorySprintPickerModal() {
    ensureRuntimeCriticalStyles();
    const existing = document.getElementById(HISTORY_PICKER_MODAL_ID);
    if (existing) {
      existing.remove();
    }

    const modalOverlay = document.createElement('div');
    modalOverlay.id = HISTORY_PICKER_MODAL_ID;
    modalOverlay.className = 'bjwt-history-picker-overlay';
    modalOverlay.innerHTML = `
      <div class="bjwt-history-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="bjwt-history-picker-title">
        <div class="bjwt-history-picker-header">
          <div class="bjwt-history-picker-title-group">
            <svg class="bjwt-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 15"></polyline>
            </svg>
            <h3 id="bjwt-history-picker-title">載入已結束的歷史 Sprint</h3>
          </div>
          <button type="button" class="bjwt-history-picker-close" title="關閉" aria-label="關閉">✕</button>
        </div>
        <div class="bjwt-history-picker-body">
          <label class="bjwt-history-picker-label" for="bjwt-history-sprint-input">
            輸入已結束的 Sprint 名稱（可透過 API 抓取卡片並 Append 至左右兩欄）：
          </label>
          <div class="bjwt-history-picker-input-row">
            <input
              id="bjwt-history-sprint-input"
              type="text"
              class="bjwt-history-picker-input"
              placeholder="例如：Sprint 24 或輸入關鍵字篩選下方清單..."
              autocomplete="off"
            />
            <button type="button" class="bjwt-history-picker-submit">查詢並加入</button>
          </div>
          <div class="bjwt-history-picker-status" aria-live="polite"></div>
          <div class="bjwt-history-suggestions-wrap">
            <div class="bjwt-history-suggestions-title">看板最近已結束的 Sprint（點擊可直接載入）：</div>
            <div class="bjwt-history-suggestions-list">
              <div class="bjwt-history-suggestions-loading">正在從 Jira API 讀取已結束的 Sprint 清單...</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalOverlay);

    const inputEl = modalOverlay.querySelector('#bjwt-history-sprint-input');
    const submitBtn = modalOverlay.querySelector('.bjwt-history-picker-submit');
    const closeBtn = modalOverlay.querySelector('.bjwt-history-picker-close');
    const statusEl = modalOverlay.querySelector('.bjwt-history-picker-status');
    const suggestionsListEl = modalOverlay.querySelector('.bjwt-history-suggestions-list');

    function closePicker() {
      modalOverlay.remove();
    }

    closeBtn.addEventListener('click', closePicker);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closePicker();
    });

    async function handleLoadSprint(nameStr, explicitSprint = null) {
      const targetName = (explicitSprint && explicitSprint.name) || (nameStr || '').trim();
      if (!targetName) {
        statusEl.textContent = '請先輸入或選擇一個已結束的 Sprint 名稱';
        statusEl.className = 'bjwt-history-picker-status error';
        inputEl.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '載入中...';
      statusEl.textContent = `正在透過 Jira API 載入「${targetName}」的卡片資料...`;
      statusEl.className = 'bjwt-history-picker-status loading';

      try {
        const sprintData = await fetchHistoricalSprintData(targetName, explicitSprint);
        appendHistoricalSprintToState(sprintData);
        closePicker();
      } catch (err) {
        statusEl.textContent = err && err.message ? err.message : '載入失敗，請確認 Sprint 名稱是否正確';
        statusEl.className = 'bjwt-history-picker-status error';
        submitBtn.disabled = false;
        submitBtn.textContent = '查詢並加入';
      }
    }

    submitBtn.addEventListener('click', () => {
      handleLoadSprint(inputEl.value);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLoadSprint(inputEl.value);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closePicker();
      }
    });

    let allClosedSprints = [];

    function renderSuggestions(filterText = '') {
      const kw = (filterText || '').trim().toLowerCase();
      const filtered = kw
        ? allClosedSprints.filter((s) => (s.name || '').toLowerCase().includes(kw))
        : allClosedSprints;

      if (filtered.length === 0) {
        suggestionsListEl.innerHTML = `
          <div class="bjwt-history-suggestions-empty">
            ${
              allClosedSprints.length === 0
                ? '未能自動列出看板歷史清單，請直接在上方輸入框輸入 Sprint 名稱並點擊「查詢並加入」。'
                : '沒有符合關鍵字的已結束 Sprint，您仍可直接點擊「查詢並加入」以 JQL 搜尋。'
            }
          </div>
        `;
        return;
      }

      suggestionsListEl.innerHTML = '';
      filtered.slice(0, 30).forEach((sp) => {
        const alreadyLoaded = loadedHistoricalSprints.some(
          (h) => String(h.sprintId) === String(sp.id) || h.title === sp.name
        );
        const dateRange = [formatShortDate(sp.startDate), formatShortDate(sp.completeDate || sp.endDate)]
          .filter(Boolean)
          .join(' ~ ');

        const row = document.createElement('button');
        row.type = 'button';
        row.className = `bjwt-history-suggestion-item ${alreadyLoaded ? 'loaded' : ''}`;
        row.innerHTML = `
          <div class="bjwt-history-suggestion-info">
            <span class="bjwt-history-suggestion-name">${escapeHtml(sp.name || `Sprint ${sp.id}`)}</span>
            ${dateRange ? `<span class="bjwt-history-suggestion-date">${escapeHtml(dateRange)}</span>` : ''}
          </div>
          <span class="bjwt-history-suggestion-action">${alreadyLoaded ? '重新載入' : '＋ 加入'}</span>
        `;
        row.addEventListener('click', () => {
          inputEl.value = sp.name || '';
          handleLoadSprint(sp.name, sp);
        });
        suggestionsListEl.appendChild(row);
      });
    }

    inputEl.addEventListener('input', () => {
      renderSuggestions(inputEl.value);
    });

    inputEl.focus();

    fetchClosedSprintsForBoard().then((list) => {
      allClosedSprints = list;
      renderSuggestions(inputEl.value);
    });
  }

  /**
   * 產出加大高度的雙列卡片 HTML
   * 第一列：只放卡片類型Icon，卡片編號，卡片標題 (佔滿整列寬度)
   * 第二列：放其他的欄位 (靠右一欄一欄整齊對齊)
   */
  function renderIssueCardHtml(iss) {
    const rawKey = String(iss.key || '').trim();
    const keyMatch = rawKey.match(/([A-Z][A-Z0-9_]*-\d+)/i);
    const cleanKey = keyMatch ? keyMatch[1].toUpperCase() : rawKey;

    let cleanSummary = cleanSummaryText(iss.summary || '');
    if (cleanKey && rawKey.length > cleanKey.length) {
      const escapedK = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const keyRemainder = cleanSummaryText(
        rawKey.replace(new RegExp(`^${escapedK}\\s*[-:]?\\s*`, 'i'), '').trim()
      );
      if (
        keyRemainder &&
        (!cleanSummary || isTruncatedDuplicateOf(cleanSummary, keyRemainder))
      ) {
        cleanSummary = keyRemainder;
      }
    }
    if (cleanKey && cleanSummary) {
      const escapedK = cleanKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      cleanSummary = cleanSummaryText(
        cleanSummary.replace(new RegExp(`^${escapedK}\\s*[-:]?\\s*`, 'i'), '').trim()
      );
    }

    const isDone = iss.statusCategory === 'done';
    const statusClass = isDone
      ? 'status-done'
      : iss.statusCategory === 'indeterminate'
      ? 'status-inprogress'
      : 'status-todo';
    const isUnassigned = Boolean(iss.isUnassigned) || isUnassignedText(iss.assigneeName);
    const displayAssigneeName = isUnassigned ? '未指派' : iss.assigneeName || '未指派';
    const initials = getDisplayInitialsForIssue(iss);
    const hasValidAvatarImg =
      !isUnassigned &&
      Boolean(iss.assigneeAvatar) &&
      !/issuetype|avatar\/type|universal_avatar\/view\/type\/issuetype/i.test(iss.assigneeAvatar);
    const fallbackBgStyle =
      iss.assigneeBgColor && !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent/i.test(iss.assigneeBgColor)
        ? ` style="background: ${escapeHtml(iss.assigneeBgColor)} !important;"`
        : '';

    const parentLabel = iss.parentSummary || iss.parentKey || '';
    const pointsDisplay =
      iss.storyPoints !== null && iss.storyPoints !== undefined && iss.storyPoints !== ''
        ? String(iss.storyPoints)
        : '-';

    return `
      <div
        class="bjwt-history-card sprint-card bjwt-two-row-card"
        data-bjwt-history-issue-key="${escapeHtml(cleanKey)}"
        role="button"
        tabindex="0"
        title="點擊以置中 Modal 預覽 ${escapeHtml(cleanKey)} 詳細內容"
      >
        <!-- 第一列：卡片類型Icon，卡片編號，卡片標題 -->
        <div class="bjwt-card-row-top bjwt-history-card-left">
          ${
            iss.issueTypeIcon
              ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(iss.issueTypeIcon)}" alt="${escapeHtml(iss.issueTypeName)}" title="${escapeHtml(iss.issueTypeName)}" />`
              : `<span class="bjwt-history-issuetype-dot"></span>`
          }
          <span class="bjwt-history-card-key ${isDone ? 'is-done' : ''}">${escapeHtml(cleanKey)}</span>
          <span class="bjwt-history-card-summary" title="${escapeHtml(cleanSummary)}">${escapeHtml(cleanSummary)}</span>
        </div>

        <!-- 第二列：放其他的欄位 (Epic 標籤、狀態 Badge、到期日、Story Points、優先順序 Icon、負責人頭像) -->
        <div class="bjwt-card-row-bottom bjwt-history-card-right">
          ${
            parentLabel
              ? `<span class="bjwt-history-parent-badge" title="${escapeHtml(iss.parentKey ? `${iss.parentKey}: ${iss.parentSummary}` : parentLabel)}"><span class="bjwt-parent-dot"></span>${escapeHtml(parentLabel)}</span>`
              : ''
          }
          <span class="bjwt-history-status-badge ${statusClass}">
            ${escapeHtml(iss.statusName)}
          </span>
          ${
            iss.dueDate
              ? `<span class="bjwt-history-duedate-badge" title="到期日：${escapeHtml(iss.dueDate)}">${escapeHtml(iss.dueDate)}</span>`
              : ''
          }
          <span class="bjwt-history-points-badge" title="Story Points">${escapeHtml(pointsDisplay)}</span>
          ${
            iss.priorityIcon
              ? `<img class="bjwt-history-priority-icon" src="${escapeHtml(iss.priorityIcon)}" alt="${escapeHtml(iss.priorityName)}" title="優先順序：${escapeHtml(iss.priorityName)}" />`
              : iss.prioritySvg
              ? `<span class="bjwt-history-priority-icon bjwt-svg-wrap" title="優先順序：${escapeHtml(iss.priorityName)}">${iss.prioritySvg}</span>`
              : ''
          }
          <span class="bjwt-history-assignee" title="負責人：${escapeHtml(displayAssigneeName)}">
            ${
              isUnassigned
                ? `<span class="bjwt-history-avatar-unassigned" aria-label="未指派">
                    <svg class="bjwt-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                      <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                  </span>`
                : hasValidAvatarImg
                ? `<img class="bjwt-history-avatar" src="${escapeHtml(iss.assigneeAvatar)}" alt="${escapeHtml(displayAssigneeName)}" />`
                : `<span class="bjwt-history-avatar-fallback"${fallbackBgStyle}>${escapeHtml(initials || '?')}</span>`
            }
          </span>
        </div>
      </div>
    `;
  }

  /**
   * 從原生 Jira DOM 卡片節點解析卡片欄位資料
   */
  function parseIssueFromDomCard(cardEl) {
    if (!cardEl || !(cardEl instanceof Element)) return null;

    let key = '';
    let accessibleSummaryFromKey = '';
    let isDone = false;
    const keyLink =
      cardEl.querySelector('a[href*="/browse/"]') ||
      cardEl.querySelector('[data-testid*="accessible-card-key"]') ||
      cardEl.querySelector('[data-testid*="key"]');

    if (keyLink) {
      const rawKeyText = (keyLink.textContent || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const hrefVal =
        keyLink.getAttribute('href') ||
        (keyLink.closest('a[href*="/browse/"]') &&
          keyLink.closest('a[href*="/browse/"]').getAttribute('href')) ||
        '';
      const hrefKeyMatch = hrefVal.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i);
      const textKeyMatch = rawKeyText.match(/([A-Z][A-Z0-9_]*-\d+)/i);

      if (hrefKeyMatch) {
        key = hrefKeyMatch[1].toUpperCase();
      } else if (textKeyMatch) {
        key = textKeyMatch[1].toUpperCase();
      }

      if (key && rawKeyText.length > key.length) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const remainder = rawKeyText.replace(new RegExp(`^${escapedKey}\\s*[-:]?\\s*`, 'i'), '').trim();
        if (remainder && remainder.toUpperCase() !== key) {
          accessibleSummaryFromKey = cleanSummaryText(remainder);
        }
      }

      const style = window.getComputedStyle(keyLink);
      if (
        (style && style.textDecorationLine && style.textDecorationLine.includes('line-through')) ||
        keyLink.closest('del, s, strike') ||
        keyLink.classList.contains('is-done')
      ) {
        isDone = true;
      }
    }

    if (!key) {
      const match = (cardEl.textContent || '').match(/([A-Z][A-Z0-9_]*-\d+)/);
      if (match) {
        key = match[1].toUpperCase();
      }
    }

    if (!key) return null;

    let issueTypeIcon = '';
    let issueTypeName = '任務';
    const typeImg =
      cardEl.querySelector(
        'img[src*="issuetype"], img[src*="avatar/type"], [data-testid*="issue-type"] img, [data-testid*="type-icon"] img, img:first-of-type'
      );
    if (typeImg && typeImg.src) {
      issueTypeIcon = typeImg.src;
      issueTypeName = typeImg.alt || typeImg.title || '任務';
    }

    let statusName = '';
    let statusCategory = isDone ? 'done' : 'new';
    const statusEl =
      cardEl.querySelector('[data-testid*="status"], [data-testid*="lozenge"]') ||
      cardEl.querySelector('button[id*="status"], [role="button"]:has(svg)');

    if (statusEl) {
      const clone = statusEl.cloneNode(true);
      clone.querySelectorAll('svg, [class*="icon"], [aria-hidden="true"]').forEach((e) => e.remove());
      statusName = (clone.innerText || clone.textContent || '').trim().replace(/\s+/g, ' ');
    }

    if (!statusName) {
      const candidates = Array.from(cardEl.querySelectorAll('button, [role="button"], span'));
      for (const c of candidates) {
        const txt = (c.textContent || '').trim();
        if (/^(待辦事項|進行中|完成|local testing|DEV Verify|To Do|In Progress|Done|Closed|Resolved)/i.test(txt)) {
          statusName = txt;
          break;
        }
      }
    }

    // 清理狀態文字 (去除按鈕 chevron 與 trailing arrow)
    statusName = statusName.replace(/(▾|▼|⌵|v|\^|expand|dropdown)+$/i, '').trim();

    if (!statusName) {
      statusName = isDone ? '完成' : '待辦事項';
    }

    const lowerStatus = statusName.toLowerCase();
    if (isDone || /完成|done|closed|resolved/i.test(lowerStatus)) {
      statusCategory = 'done';
    } else if (/進行中|in progress|testing|verify|wait|開發|進行/i.test(lowerStatus)) {
      statusCategory = 'indeterminate';
    } else {
      statusCategory = 'new';
    }

    let storyPoints = null;
    const pointEl =
      cardEl.querySelector(
        '[data-testid*="estimate"], [data-testid*="story-point"], [data-testid*="points"], [data-testid*="statistic"], .ghx-estimate'
      );
    if (pointEl) {
      const pt = (pointEl.textContent || '').trim();
      if (pt && pt !== '-' && !isNaN(parseFloat(pt))) {
        storyPoints = parseFloat(pt);
      }
    }

    if (storyPoints === null) {
      const candidates = Array.from(cardEl.querySelectorAll('button, span, div'));
      for (const el of candidates) {
        if (el.children.length === 0) {
          const txt = (el.textContent || '').trim();
          if (/^\d{1,3}(\.\d)?$/.test(txt)) {
            const isBadge = Boolean(
              el.closest(
                '[data-testid*="badge"], [data-testid*="estimate"], [class*="badge"], [class*="estimate"], [class*="statistic"]'
              )
            );
            if (isBadge) {
              storyPoints = parseFloat(txt);
              break;
            }
          }
        }
      }
    }

    let priorityName = '';
    let priorityIcon = '';
    let prioritySvg = '';
    const prioEl = cardEl.querySelector(
      '[data-testid*="priority"], img[src*="priority"], svg[data-testid*="priority"], .ghx-priority'
    );
    if (prioEl) {
      const img = prioEl.tagName === 'IMG' ? prioEl : prioEl.querySelector('img');
      const svg = prioEl.tagName === 'SVG' ? prioEl : prioEl.querySelector('svg');
      if (img && img.src) {
        priorityIcon = img.src;
        priorityName = img.alt || img.title || '';
      } else if (svg) {
        prioritySvg = svg.outerHTML;
        priorityName =
          prioEl.getAttribute('aria-label') ||
          svg.getAttribute('aria-label') ||
          prioEl.getAttribute('title') ||
          svg.getAttribute('title') ||
          '';
      }
    }

    // 擷取負責人資訊：嚴格排除左側的 issueTypeIcon，避免將問題類型圖示誤判為負責人頭像
    let assigneeName = '未指派';
    let assigneeInitials = '';
    let assigneeAvatar = '';
    let assigneeBgColor = '';
    let isUnassigned = true;
    const assigneeTokens = new Set();

    const isIssueTypeElement = (el) => {
      if (!el || !(el instanceof Element)) return true;
      if (typeImg && (el === typeImg || el.contains(typeImg) || typeImg.contains(el))) return true;
      if (el.closest('[data-testid*="issue-type"], [data-testid*="issuetype"], [data-testid*="type-icon"], [data-testid*="priority"]')) {
        return true;
      }
      const tid = (el.getAttribute('data-testid') || '').toLowerCase();
      if (tid.includes('issue-type') || tid.includes('issuetype') || tid.includes('priority')) {
        return true;
      }
      return false;
    };

    const assigneeCandidates = Array.from(
      cardEl.querySelectorAll(
        '[data-testid*="assignee"], [data-testid*="card-End"] [data-testid*="avatar"], .ghx-avatar, [data-testid*="avatar"]'
      )
    ).filter((el) => !isIssueTypeElement(el));

    const avatarRoot =
      assigneeCandidates.find((el) => (el.getAttribute('data-testid') || '').toLowerCase().includes('assignee')) ||
      assigneeCandidates[assigneeCandidates.length - 1] ||
      null;

    if (avatarRoot) {
      const rawAriaPieces = [
        avatarRoot.getAttribute('aria-label'),
        avatarRoot.getAttribute('title'),
        ...Array.from(avatarRoot.querySelectorAll('[aria-label], [title], img[alt]')).map(
          (n) => n.getAttribute('aria-label') || n.getAttribute('title') || n.getAttribute('alt')
        )
      ].filter(Boolean);

      const avatarImg =
        avatarRoot.tagName === 'IMG'
          ? avatarRoot
          : avatarRoot.querySelector(
              'img:not([src*="issuetype"]):not([src*="avatar/type"]):not([src*="priority"])'
            );

      if (
        avatarImg &&
        avatarImg.src &&
        avatarImg !== typeImg &&
        (!issueTypeIcon || avatarImg.src !== issueTypeIcon) &&
        !/issuetype|avatar\/type|universal_avatar\/view\/type\/issuetype/i.test(avatarImg.src)
      ) {
        assigneeAvatar = avatarImg.src;
      } else {
        const bgImg = window.getComputedStyle(avatarRoot).backgroundImage;
        const bgMatch = bgImg && bgImg.match(/url\(["']?([^"']+)["']?\)/);
        if (
          bgMatch &&
          !bgMatch[1].includes('none') &&
          !/issuetype|avatar\/type/i.test(bgMatch[1])
        ) {
          assigneeAvatar = bgMatch[1];
        }
      }

      // 擷取頭像圓圈內的縮寫文字 (例如 "RAY", "B", "BP")，排除 aria-hidden 以外的螢幕報讀長字串
      const cloneForInitials = avatarRoot.cloneNode(true);
      cloneForInitials
        .querySelectorAll('[class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], svg, img, style, script')
        .forEach((n) => n.remove());
      const visibleShortText = (cloneForInitials.textContent || '').replace(/\s+/g, '').trim();
      if (
        visibleShortText &&
        visibleShortText.length <= 6 &&
        !isUnassignedText(visibleShortText)
      ) {
        assigneeInitials = visibleShortText.toUpperCase();
        assigneeTokens.add(visibleShortText.toLowerCase());
      }

      // 擷取圓形頭像背景色 (供自定義卡片呈現一致的色塊)
      const bgNodes = [avatarRoot, ...Array.from(avatarRoot.querySelectorAll('span, div'))];
      for (const n of bgNodes) {
        const bgc = window.getComputedStyle(n).backgroundColor;
        if (
          bgc &&
          !/rgba?\(0,\s*0,\s*0,\s*0\)|transparent|rgb\(255,\s*255,\s*255\)/i.test(bgc)
        ) {
          assigneeBgColor = bgc;
          break;
        }
      }

      // 解析負責人完整名稱或未指派狀態
      let foundExplicitUnassigned = false;
      const cleanedLabels = [];
      rawAriaPieces.forEach((rawPiece) => {
        if (isUnassignedText(rawPiece)) {
          foundExplicitUnassigned = true;
        }
        const cleaned = cleanAssigneeLabel(rawPiece);
        if (cleaned) {
          if (isUnassignedText(cleaned)) {
            foundExplicitUnassigned = true;
          } else if (cleaned.toLowerCase() !== issueTypeName.toLowerCase()) {
            cleanedLabels.push(cleaned);
            deriveInitialsVariants(cleaned).forEach((t) => assigneeTokens.add(t));
          }
        }
      });

      if (foundExplicitUnassigned && cleanedLabels.length === 0 && !assigneeInitials && !assigneeAvatar) {
        isUnassigned = true;
        assigneeName = '未指派';
      } else if (cleanedLabels.length > 0) {
        isUnassigned = false;
        assigneeName = cleanedLabels[0];
        if (!assigneeInitials) {
          assigneeInitials = getDisplayInitialsForIssue({ assigneeName, isUnassigned: false });
        }
      } else if (assigneeInitials) {
        isUnassigned = false;
        assigneeName = assigneeInitials;
      } else if (assigneeAvatar) {
        isUnassigned = false;
        assigneeName = '已指派';
      } else {
        isUnassigned = true;
        assigneeName = '未指派';
      }
    }

    let parentKey = '';
    let parentSummary = '';
    const epicEl = cardEl.querySelector(
      '[data-testid*="epic"], [data-testid*="parent"], [data-testid*="lozenge-epic"], [class*="lozenge-epic"], [class*="EpicLabel"]'
    );
    if (epicEl && epicEl !== statusEl) {
      const epicText = (epicEl.innerText || epicEl.textContent || '').trim().replace(/\s+/g, ' ');
      if (epicText && epicText !== statusName && !epicText.includes(key)) {
        parentSummary = epicText;
      }
    }

    let dueDate = '';
    const dueEl = cardEl.querySelector('[data-testid*="due-date"], [data-testid*="duedate"]');
    if (dueEl) {
      dueDate = (dueEl.innerText || dueEl.textContent || '').trim().replace(/\s+/g, ' ');
      dueDate = dueDate.replace(/^[📅\s]+/, '').trim();
    } else {
      const dateMatch = (cardEl.textContent || '').match(/(\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        dueDate = dateMatch[1];
      }
    }

    let summary = extractCleanSummaryFromDom(cardEl, key);

    // 若 keyLink 內帶有完整無截斷的螢幕報讀標題，且目前提取到的標題為空或為截斷版 (...)，優先採用完整標題
    if (accessibleSummaryFromKey) {
      if (!summary || summary === key || isTruncatedDuplicateOf(summary, accessibleSummaryFromKey)) {
        summary = accessibleSummaryFromKey;
      }
    }

    if (!summary || summary === key) {
      const cloneCard = cardEl.cloneNode(true);
      cloneCard
        .querySelectorAll(
          'a[href*="/browse/"], svg, img, style, script, button, [aria-hidden="true"], [class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], [hidden], [data-testid*="key"], [data-testid*="status"], [data-testid*="lozenge"], [data-testid*="estimate"], [data-testid*="story-point"], [data-testid*="points"], [data-testid*="statistic"], [data-testid*="priority"], [data-testid*="assignee"], [data-testid*="avatar"], [data-testid*="epic"], [data-testid*="parent"], [data-testid*="due"], .ghx-key, .ghx-end, .ghx-stat-fields'
        )
        .forEach((el) => el.remove());

      const fallbackChunks = [];
      const walker = document.createTreeWalker(cloneCard, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        const val = (node.nodeValue || '')
          .replace(/[\u200B-\u200D\uFEFF]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (
          val &&
          val !== key &&
          val !== statusName &&
          val !== parentSummary &&
          val !== dueDate &&
          val !== assigneeName &&
          val !== assigneeInitials &&
          val !== '-' &&
          !/^\d{1,3}(\.\d)?$/.test(val)
        ) {
          fallbackChunks.push(val);
        }
        node = walker.nextNode();
      }

      const dedupedFallback = deduplicateSummaryChunks(fallbackChunks, key);
      if (dedupedFallback.length > 0) {
        summary = cleanSummaryText(dedupedFallback.join(' '));
      }

      if (!summary || summary === key) {
        const allText = (cardEl.innerText || cardEl.textContent || '').replace(/\s+/g, ' ');
        let stripped = allText.split(key).join('').trim();
        if (statusName) stripped = stripped.split(statusName).join('').trim();
        if (assigneeName && assigneeName !== '未指派') {
          stripped = stripped.split(assigneeName).join('').trim();
        }
        if (parentSummary) stripped = stripped.split(parentSummary).join('').trim();
        if (dueDate) stripped = stripped.split(dueDate).join('').trim();
        summary = cleanSummaryText(stripped) || '(無標題)';
      }
    }

    if (summary && key) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      summary = summary.replace(new RegExp(`^${escapedKey}\\s*[-:]?\\s*`, 'i'), '').trim();
    }

    summary = cleanSummaryText(summary) || '(無標題)';

    const parsedIssue = {
      id: key,
      key,
      summary,
      statusName,
      statusCategory,
      issueTypeName,
      issueTypeIcon,
      priorityName,
      priorityIcon,
      prioritySvg,
      assigneeName,
      assigneeInitials,
      assigneeBgColor,
      isUnassigned,
      assigneeTokens: Array.from(assigneeTokens),
      assigneeAvatar,
      parentKey,
      parentSummary,
      dueDate,
      storyPoints
    };

    return mergeAndCacheIssue(parsedIssue);
  }

  /**
   * 從未結束衝刺的原生 DOM 中提取所有卡片
   */
  function parseIssuesFromBranch(branchEl, sprintEl) {
    const root = branchEl || sprintEl;
    if (!root) return [];

    const foundCards = [];
    for (const sel of CARD_SELECTORS) {
      const nodes = Array.from(root.querySelectorAll(sel));
      const filtered = nodes.filter(
        (c) =>
          !c.classList.contains('bjwt-history-card') &&
          !c.closest('[data-bjwt-custom-view]') &&
          !nodes.some((other) => other !== c && other.contains(c))
      );
      if (filtered.length > 0) {
        foundCards.push(...filtered);
        break;
      }
    }

    const issues = [];
    const seenKeys = new Set();
    foundCards.forEach((cardEl) => {
      const iss = parseIssueFromDomCard(cardEl);
      if (iss && iss.key && !seenKeys.has(iss.key)) {
        seenKeys.add(iss.key);
        issues.push(iss);
      }
    });

    return issues;
  }

  /**
   * 透過 Jira Agile REST API 抓取未結束衝刺的完整卡片資料
   */
  async function fetchSprintIssuesForActive(item) {
    const { boardId, projectKey } = await detectJiraContext();
    let sprintId = item.meta.sprintId || (item.sprintEl && item.sprintEl.getAttribute('data-sprint-id'));
    const cleanTitle = cleanSprintTitle(item.meta.title);

    await detectStoryPointsCustomField();

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
      cachedStoryPointsFieldId
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
      } catch {}
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
            return data.issues.map(normalizeJiraIssue);
          }
        }
      } catch {}
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
                return data.issues.map(normalizeJiraIssue);
              }
            }
          } catch {}
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
            return data.issues.map(normalizeJiraIssue);
          }
        }
      } catch {}
    }

    return [];
  }

  /**
   * 非同步同步未結束衝刺的卡片資料，並寫入 issueMetadataMap 與 allApiIssues，
   * 完成後透過 scheduleLayoutRefresh() 結合當前原生篩選器重新計算左右兩欄，絕不以未篩選清單覆蓋畫面
   */
  async function syncActiveSprintIssuesFromApi(item) {
    const key = item.meta.key;
    try {
      const apiIssues = await fetchSprintIssuesForActive(item);
      let cached = activeSprintCache.get(key);
      if (!cached) {
        cached = {
          key,
          title: item.meta.title,
          issues: [],
          allApiIssues: null,
          filterKeyword: '',
          fromApi: false,
          apiSyncing: false
        };
        activeSprintCache.set(key, cached);
      }
      cached.apiSyncing = false;

      if (apiIssues && apiIssues.length > 0) {
        const mergedList = apiIssues.map((iss) => mergeAndCacheIssue(iss));
        cached.allApiIssues = mergedList;
        cached.fromApi = true;
        activeSprintCache.set(key, cached);
        scheduleLayoutRefresh();
      }
    } catch {
      const cached = activeSprintCache.get(key);
      if (cached) cached.apiSyncing = false;
    }
  }

  /**
   * 渲染未結束衝刺的自定義卡片檢視 (與歷史衝刺一體呈現，並即時連動 Jira 原生篩選搜尋區)
   */
  function renderActiveSprintBranch(item, nativeFilter = null) {
    const branchEl = item.branch;
    if (!branchEl) return;

    const key = item.meta.key;
    const activeNativeFilter = nativeFilter || getNativeBacklogFilterState();

    // 每次渲染前皆確保與最新原生 DOM 及篩選狀態同步
    resolveSprintIssuesForLayout(item, activeNativeFilter);
    const sprintData = activeSprintCache.get(key);
    if (!sprintData) return;

    // 確保快取中的所有卡片標題皆經過深度去重清理
    if (Array.isArray(sprintData.issues)) {
      sprintData.issues.forEach((iss) => {
        if (iss && iss.summary) {
          iss.summary = cleanSummaryText(iss.summary);
        }
      });
    }

    // 從原生標頭提取日期區間 (例如 "22 10月 - 4 11月")
    let dateRange = sprintData.dateRange || '';
    const headerNodes = [
      item.headerPartner,
      branchEl.querySelector('[data-testid*="header"], .ghx-backlog-header, header')
    ].filter(Boolean);

    if (!dateRange) {
      for (const hdr of headerNodes) {
        const text = (hdr.innerText || hdr.textContent || '').replace(/\s+/g, ' ');
        const dateMatch =
          text.match(/(\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?\s*[-~至到–—]\s*\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?)/i) ||
          text.match(/(\d{1,2}\s*[^\d\s\(\)]+\s*[-~至到–—]\s*\d{1,2}\s*[^\d\s\(\)]+)/i);
        if (dateMatch) {
          dateRange = dateMatch[1].trim();
          break;
        }
      }
      sprintData.dateRange = dateRange;
    }

    // 尋找原生「完成衝刺」按鈕以利在自定義 Banner 中支援轉發點擊
    let nativeCompleteBtn = null;
    for (const hdr of headerNodes) {
      const btns = Array.from(hdr.querySelectorAll('button'));
      const found = btns.find((b) => /完成衝刺|complete sprint/i.test((b.textContent || '').trim()));
      if (found) {
        nativeCompleteBtn = found;
        break;
      }
    }

    // 2. 建立或取得自定義容器
    let customView = branchEl.querySelector('.bjwt-active-sprint-custom-view');
    if (!customView) {
      customView = document.createElement('div');
      customView.className = 'bjwt-active-sprint-custom-view';
      customView.setAttribute('data-bjwt-custom-view', 'true');
      branchEl.appendChild(customView);
    }

    // 3. 根據自定義卡片搜尋框關鍵字二次篩選卡片 (sprintData.issues 已由原生篩選器過濾)
    const filterKw = (sprintData.filterKeyword || '').trim().toLowerCase();
    const visibleIssues = filterKw
      ? sprintData.issues.filter(
          (iss) =>
            iss.key.toLowerCase().includes(filterKw) ||
            iss.summary.toLowerCase().includes(filterKw) ||
            iss.assigneeName.toLowerCase().includes(filterKw) ||
            (iss.assigneeInitials && iss.assigneeInitials.toLowerCase().includes(filterKw)) ||
            iss.statusName.toLowerCase().includes(filterKw) ||
            (iss.parentSummary && iss.parentSummary.toLowerCase().includes(filterKw))
        )
      : sprintData.issues;

    // 點數與數量統計完全依據目前篩選後可見的卡片計算
    const stats = calculateSprintStatistics(visibleIssues);
    const displayTitle = cleanSprintTitle(sprintData.title);

    const issuesSig = visibleIssues
      .map(
        (i) =>
          `${i.key}:${i.summary}:${i.statusName}:${i.storyPoints ?? ''}:${i.assigneeName || ''}:${i.assigneeInitials || ''}`
      )
      .join('|');

    const sig = JSON.stringify({
      key,
      count: visibleIssues.length,
      points: stats.totalPoints,
      fromApi: Boolean(sprintData.fromApi),
      nativeFilterSig: activeNativeFilter.sig,
      issuesSig,
      filterKw,
      dateRange,
      theme: currentSettings.themeStyle
    });

    if (customView.getAttribute('data-bjwt-render-sig') === sig) {
      return;
    }
    customView.setAttribute('data-bjwt-render-sig', sig);

    const isBacklogPool = /backlog/i.test(sprintData.title);
    const badgeText = isBacklogPool ? '待辦池' : '進行中';
    const badgeClass = isBacklogPool ? 'badge-future' : 'badge-active';

    customView.innerHTML = `
      <div class="bjwt-history-sprint-container sprint-container">
        <!-- 全新設計的 Sprint 標題 Banner (與歷史衝刺一體呈現) -->
        <div class="bjwt-history-sprint-banner">
          <div class="bjwt-history-banner-main">
            <span class="bjwt-history-banner-badge ${badgeClass}">
              <svg class="bjwt-icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              ${badgeText}
            </span>
            <h2 class="bjwt-history-banner-title">${escapeHtml(displayTitle)}</h2>
            ${dateRange ? `<span class="bjwt-history-banner-dates">${escapeHtml(dateRange)}</span>` : ''}
            <span class="bjwt-history-banner-stats">
              (${stats.totalIssues} 個工作項目 · 共 ${stats.totalPoints} 點)
            </span>
          </div>
          <div class="bjwt-history-banner-controls">
            <span class="bjwt-history-status-counters" title="Story Points (待辦 / 進行中 / 完成)">
              <span class="bjwt-counter-pill counter-todo" title="待辦: ${stats.todoPoints} 點 (${stats.todoCount} 個工作項目)">${stats.todoPoints}</span>
              <span class="bjwt-counter-pill counter-inprogress" title="進行中: ${stats.inProgressPoints} 點 (${stats.inProgressCount} 個工作項目)">${stats.inProgressPoints}</span>
              <span class="bjwt-counter-pill counter-done" title="完成: ${stats.donePoints} 點 (${stats.doneCount} 個工作項目)">${stats.donePoints}</span>
            </span>
            <input
              type="search"
              class="bjwt-history-card-filter"
              placeholder="篩選卡片 (Key / 標題 / 負責人)..."
              value="${escapeHtml(sprintData.filterKeyword || '')}"
            />
            <button type="button" class="bjwt-history-refresh-btn" title="從 Jira 重新同步此衝刺">
              ↻ 重新整理
            </button>
            ${
              nativeCompleteBtn
                ? `<button type="button" class="bjwt-active-complete-btn" title="完成此衝刺">完成衝刺</button>`
                : ''
            }
          </div>
        </div>
        ${
          sprintData.goal
            ? `<div class="bjwt-history-sprint-goal"><strong>衝刺目標：</strong>${escapeHtml(sprintData.goal)}</div>`
            : ''
        }
        <div class="bjwt-history-card-list">
          ${
            visibleIssues.length === 0
              ? `<div class="bjwt-history-empty-cards">目前沒有符合篩選條件的待辦事項卡片。</div>`
              : visibleIssues.map(renderIssueCardHtml).join('')
          }
        </div>
      </div>
    `;

    // 綁定篩選搜尋事件
    const filterInput = customView.querySelector('.bjwt-history-card-filter');
    if (filterInput) {
      filterInput.addEventListener('input', (e) => {
        const cursorPos = e.target.selectionStart;
        sprintData.filterKeyword = e.target.value;
        renderActiveSprintBranch(item);
        const newInput = customView.querySelector('.bjwt-history-card-filter');
        if (newInput) {
          newInput.focus();
          try {
            newInput.setSelectionRange(cursorPos, cursorPos);
          } catch {}
        }
      });
    }

    // 綁定重新整理按鈕
    const refreshBtn = customView.querySelector('.bjwt-history-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '同步中...';
        customView.removeAttribute('data-bjwt-render-sig');
        await syncActiveSprintIssuesFromApi(item);
        scheduleLayoutRefresh();
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ 重新整理';
      });
    }

    // 綁定完成衝刺按鈕
    const completeBtn = customView.querySelector('.bjwt-active-complete-btn');
    if (completeBtn && nativeCompleteBtn) {
      completeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        nativeCompleteBtn.click();
      });
    }

    // 綁定卡片點擊事件以置中 Modal 預覽
    customView.querySelectorAll('.bjwt-history-card').forEach((cardEl) => {
      const issueKey = cardEl.getAttribute('data-bjwt-history-issue-key');
      const issueObj =
        visibleIssues.find((i) => i.key === issueKey) ||
        sprintData.issues.find((i) => i.key === issueKey);
      const handleActivate = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (issueKey) {
          openHistoricalIssueDetailModal(issueKey, issueObj);
        }
      };
      cardEl.addEventListener('click', handleActivate);
      cardEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleActivate(e);
        }
      });
    });
  }

  /**
   * 渲染右欄 80% 中的「歷史 Sprint (已結束)」卡片區塊 (同樣支援原生篩選搜尋連動)
   */
  function renderHistoricalSprintBranch(branchEl, histItem, nativeFilter = null) {
    const activeNativeFilter = nativeFilter || getNativeBacklogFilterState();
    const baseFilteredIssues = filterIssuesByNativeFilter(histItem.issues || [], activeNativeFilter);

    const filterKw = (histItem.filterKeyword || '').trim().toLowerCase();
    const visibleIssues = filterKw
      ? baseFilteredIssues.filter(
          (iss) =>
            iss.key.toLowerCase().includes(filterKw) ||
            iss.summary.toLowerCase().includes(filterKw) ||
            iss.assigneeName.toLowerCase().includes(filterKw) ||
            (iss.assigneeInitials && iss.assigneeInitials.toLowerCase().includes(filterKw)) ||
            iss.statusName.toLowerCase().includes(filterKw) ||
            (iss.parentSummary && iss.parentSummary.toLowerCase().includes(filterKw))
        )
      : baseFilteredIssues;

    if (Array.isArray(histItem.issues)) {
      histItem.issues.forEach((iss) => {
        if (iss && iss.summary) {
          iss.summary = cleanSummaryText(iss.summary);
        }
      });
    }

    const stats = calculateSprintStatistics(visibleIssues);
    const displayTitle = cleanSprintTitle(histItem.title);
    const histIssuesSig = visibleIssues
      .map((i) => `${i.key}:${i.summary}:${i.statusName}:${i.storyPoints ?? ''}:${i.assigneeName || ''}`)
      .join('|');

    const sig = JSON.stringify({
      key: histItem.key,
      count: visibleIssues.length,
      points: stats.totalPoints,
      nativeFilterSig: activeNativeFilter.sig,
      histIssuesSig,
      filterKw,
      theme: currentSettings.themeStyle
    });

    if (branchEl.getAttribute('data-bjwt-render-sig') === sig) {
      return;
    }
    branchEl.setAttribute('data-bjwt-render-sig', sig);

    const dateRange = [
      formatShortDate(histItem.startDate),
      formatShortDate(histItem.completeDate || histItem.endDate)
    ]
      .filter(Boolean)
      .join(' ~ ');

    branchEl.innerHTML = `
      <div class="bjwt-history-sprint-container sprint-container">
        <div class="bjwt-history-sprint-banner">
          <div class="bjwt-history-banner-main">
            <span class="bjwt-history-banner-badge">
              <svg class="bjwt-icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9"></circle>
                <polyline points="12 7 12 12 15 15"></polyline>
              </svg>
              已結束
            </span>
            <h2 class="bjwt-history-banner-title">${escapeHtml(displayTitle)}</h2>
            ${dateRange ? `<span class="bjwt-history-banner-dates">${escapeHtml(dateRange)}</span>` : ''}
            <span class="bjwt-history-banner-stats">
              (${stats.totalIssues} 個工作項目 · 共 ${stats.totalPoints} 點)
            </span>
          </div>
          <div class="bjwt-history-banner-controls">
            <span class="bjwt-history-status-counters" title="Story Points (待辦 / 進行中 / 完成)">
              <span class="bjwt-counter-pill counter-todo" title="待辦: ${stats.todoPoints} 點 (${stats.todoCount} 個工作項目)">${stats.todoPoints}</span>
              <span class="bjwt-counter-pill counter-inprogress" title="進行中: ${stats.inProgressPoints} 點 (${stats.inProgressCount} 個工作項目)">${stats.inProgressPoints}</span>
              <span class="bjwt-counter-pill counter-done" title="完成: ${stats.donePoints} 點 (${stats.doneCount} 個工作項目)">${stats.donePoints}</span>
            </span>
            <input
              type="search"
              class="bjwt-history-card-filter"
              placeholder="篩選卡片 (Key / 標題 / 負責人)..."
              value="${escapeHtml(histItem.filterKeyword || '')}"
            />
            <button type="button" class="bjwt-history-refresh-btn" title="從 Jira API 重新同步此歷史衝刺">
              ↻ 重新整理
            </button>
            <button type="button" class="bjwt-history-close-sprint-btn" title="從目前頁面移除此歷史衝刺">
              ✕ 移除
            </button>
          </div>
        </div>
        ${
          histItem.goal
            ? `<div class="bjwt-history-sprint-goal"><strong>衝刺目標：</strong>${escapeHtml(histItem.goal)}</div>`
            : ''
        }
        <div class="bjwt-history-card-list">
          ${
            visibleIssues.length === 0
              ? `<div class="bjwt-history-empty-cards">此歷史衝刺中沒有符合條件的卡片。</div>`
              : visibleIssues.map(renderIssueCardHtml).join('')
          }
        </div>
      </div>
    `;

    const filterInput = branchEl.querySelector('.bjwt-history-card-filter');
    if (filterInput) {
      filterInput.addEventListener('input', (e) => {
        const cursorPos = e.target.selectionStart;
        histItem.filterKeyword = e.target.value;
        renderHistoricalSprintBranch(branchEl, histItem);
        const newInput = branchEl.querySelector('.bjwt-history-card-filter');
        if (newInput) {
          newInput.focus();
          try {
            newInput.setSelectionRange(cursorPos, cursorPos);
          } catch {
            // ignore
          }
        }
      });
    }

    const refreshBtn = branchEl.querySelector('.bjwt-history-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '同步中...';
        try {
          const updated = await fetchHistoricalSprintData(
            histItem.title,
            histItem.sprintId ? { id: histItem.sprintId, name: histItem.title } : null
          );
          updated.filterKeyword = histItem.filterKeyword || '';
          appendHistoricalSprintToState(updated);
        } catch {
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ 重新整理';
        }
      });
    }

    const removeBtn = branchEl.querySelector('.bjwt-history-close-sprint-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        removeHistoricalSprint(histItem.key);
      });
    }

    branchEl.querySelectorAll('.bjwt-history-card').forEach((cardEl) => {
      const issueKey = cardEl.getAttribute('data-bjwt-history-issue-key');
      const issueObj =
        visibleIssues.find((i) => i.key === issueKey) ||
        histItem.issues.find((i) => i.key === issueKey);
      const handleActivate = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (issueKey) {
          openHistoricalIssueDetailModal(issueKey, issueObj);
        }
      };
      cardEl.addEventListener('click', handleActivate);
      cardEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleActivate(e);
        }
      });
    });
  }

  /**
   * 透過 Jira REST API 取得單一工作項目的完整欄位與渲染後內容 (說明、留言、子任務等)
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

  function formatShortDateTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${y}-${m}-${day} ${hh}:${mm}`;
    } catch {
      return isoStr;
    }
  }

  function adfToHtml(node) {
    if (!node) return '';
    if (typeof node === 'string') return escapeHtml(node);
    if (Array.isArray(node)) {
      return node.map(adfToHtml).join('');
    }

    const { type, text, marks, content, attrs } = node;

    if (type === 'text') {
      let result = escapeHtml(text || '');
      if (Array.isArray(marks)) {
        for (const mark of marks) {
          if (mark.type === 'strong') result = `<strong>${result}</strong>`;
          else if (mark.type === 'em') result = `<em>${result}</em>`;
          else if (mark.type === 'code') result = `<code>${result}</code>`;
          else if (mark.type === 'strike') result = `<s>${result}</s>`;
          else if (mark.type === 'underline') result = `<u>${result}</u>`;
          else if (mark.type === 'link' && mark.attrs && mark.attrs.href) {
            const href = escapeHtml(mark.attrs.href);
            result = `<a href="${href}" target="_blank" rel="noopener noreferrer">${result}</a>`;
          }
        }
      }
      return result;
    }

    const innerHtml = Array.isArray(content) ? content.map(adfToHtml).join('') : '';

    switch (type) {
      case 'doc':
        return innerHtml;
      case 'paragraph':
        return innerHtml ? `<p>${innerHtml}</p>` : '<p><br /></p>';
      case 'heading': {
        const level = (attrs && attrs.level) || 3;
        const validLevel = Math.min(Math.max(level, 1), 6);
        return `<h${validLevel}>${innerHtml}</h${validLevel}>`;
      }
      case 'bulletList':
        return `<ul>${innerHtml}</ul>`;
      case 'orderedList':
        return `<ol>${innerHtml}</ol>`;
      case 'listItem':
        return `<li>${innerHtml}</li>`;
      case 'codeBlock': {
        const lang = attrs && attrs.language ? ` class="language-${escapeHtml(attrs.language)}"` : '';
        return `<pre><code${lang}>${innerHtml}</code></pre>`;
      }
      case 'blockquote':
        return `<blockquote>${innerHtml}</blockquote>`;
      case 'rule':
        return '<hr />';
      case 'hardBreak':
        return '<br />';
      case 'mention': {
        const name = (attrs && (attrs.text || attrs.id)) || '';
        return `<span class="bjwt-mention">@${escapeHtml(name)}</span>`;
      }
      case 'inlineCard': {
        const url = (attrs && attrs.url) || '#';
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
      }
      case 'table':
        return `<div class="bjwt-table-wrap"><table>${innerHtml}</table></div>`;
      case 'tableRow':
        return `<tr>${innerHtml}</tr>`;
      case 'tableHeader':
        return `<th>${innerHtml}</th>`;
      case 'tableCell':
        return `<td>${innerHtml}</td>`;
      default:
        return innerHtml;
    }
  }

  function formatDescriptionHtml(rawDesc, renderedDesc) {
    if (renderedDesc && typeof renderedDesc === 'string' && renderedDesc.trim()) {
      return renderedDesc;
    }
    if (!rawDesc) {
      return '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
    }
    if (typeof rawDesc === 'object' && rawDesc.type === 'doc') {
      const html = adfToHtml(rawDesc);
      return html || '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
    }
    if (typeof rawDesc === 'string') {
      const trimmed = rawDesc.trim();
      if (!trimmed) {
        return '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
      }
      return trimmed
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
        .join('');
    }
    return '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
  }

  function formatCommentBody(comment) {
    if (comment.renderedBody && typeof comment.renderedBody === 'string') {
      return comment.renderedBody;
    }
    const body = comment.body;
    if (!body) return '';
    if (typeof body === 'object' && body.type === 'doc') {
      return adfToHtml(body);
    }
    if (typeof body === 'string') {
      return escapeHtml(body).replace(/\n/g, '<br />');
    }
    return '';
  }

  /**
   * 點擊卡片時，以置中豐富 Modal 彈窗預覽完整卡片詳情
   * 先即時呈現 fallback 既有欄位 (0ms)，隨後透過 Jira REST API 非同步載入詳細說明、留言、子任務
   */
  function openHistoricalIssueDetailModal(issueKey, fallbackIssue = null) {
    ensureRuntimeCriticalStyles();

    const existingModal = document.getElementById(HISTORY_ISSUE_MODAL_ID);
    if (existingModal) {
      existingModal.remove();
    }

    const modalEl = document.createElement('div');
    modalEl.id = HISTORY_ISSUE_MODAL_ID;
    modalEl.setAttribute('data-bjwt-issue-modal', 'true');
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');

    const browseUrl = `${window.location.origin}/browse/${encodeURIComponent(issueKey)}`;
    const displaySummary = fallbackIssue ? fallbackIssue.summary : issueKey;

    const isDone = fallbackIssue && fallbackIssue.statusCategory === 'done';
    const initialStatusClass = isDone
      ? 'status-done'
      : fallbackIssue && fallbackIssue.statusCategory === 'indeterminate'
      ? 'status-inprogress'
      : '';
    const initialStatusName = (fallbackIssue && fallbackIssue.statusName) || '載入中...';
    const initialAssigneeName = (fallbackIssue && fallbackIssue.assigneeName) || '未指派';
    const initialAssigneeAvatar = (fallbackIssue && fallbackIssue.assigneeAvatar) || '';
    const initialPriorityName = (fallbackIssue && fallbackIssue.priorityName) || '';
    const initialPriorityIcon = (fallbackIssue && fallbackIssue.priorityIcon) || '';
    const initialPrioritySvg = (fallbackIssue && fallbackIssue.prioritySvg) || '';
    const initialPoints =
      fallbackIssue && fallbackIssue.storyPoints !== null && fallbackIssue.storyPoints !== undefined
        ? fallbackIssue.storyPoints
        : '-';
    const initialDueDate = (fallbackIssue && fallbackIssue.dueDate) || '';
    const initialParentText =
      fallbackIssue && (fallbackIssue.parentSummary || fallbackIssue.parentKey)
        ? fallbackIssue.parentSummary || fallbackIssue.parentKey
        : '';
    const initialTypeIcon = (fallbackIssue && fallbackIssue.issueTypeIcon) || '';
    const initialTypeName = (fallbackIssue && fallbackIssue.issueTypeName) || '工作項目';

    modalEl.innerHTML = `
      <div class="bjwt-history-issue-modal-header">
        <div class="bjwt-history-issue-modal-title">
          ${
            initialTypeIcon
              ? `<img class="bjwt-history-issuetype-icon" src="${escapeHtml(initialTypeIcon)}" alt="${escapeHtml(initialTypeName)}" title="${escapeHtml(initialTypeName)}" style="width: 16px; height: 16px;" />`
              : ''
          }
          <span class="bjwt-history-modal-key-badge">${escapeHtml(issueKey)}</span>
          <span class="bjwt-history-modal-summary-text" id="bjwt-history-modal-header-summary" title="${escapeHtml(displaySummary)}">${escapeHtml(displaySummary)}</span>
        </div>
        <div class="bjwt-history-issue-modal-actions">
          <a
            href="${escapeHtml(browseUrl)}"
            target="_blank"
            rel="noopener noreferrer"
            class="bjwt-history-modal-open-tab"
            title="在新分頁開啟完整 Jira 卡片頁面"
          >
            在新分頁開啟 ↗
          </a>
          <button
            type="button"
            class="bjwt-history-modal-close-btn"
            aria-label="關閉卡片視窗"
            title="關閉 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>
      <div class="bjwt-rich-detail-body">
        <!-- 左欄 68%：主要內容 (標題、詳細說明、子任務、活動留言) -->
        <div class="bjwt-detail-main-col">
          <h1 class="bjwt-detail-summary" id="bjwt-detail-main-title">${escapeHtml(displaySummary)}</h1>

          <div class="bjwt-detail-section">
            <div class="bjwt-detail-section-title">說明</div>
            <div class="bjwt-detail-description-content" id="bjwt-detail-description-body">
              <span class="bjwt-detail-loading-spinner"></span> 正在載入詳細說明...
            </div>
          </div>

          <div class="bjwt-detail-section" id="bjwt-detail-subtasks-container" style="display: none;">
            <div class="bjwt-detail-section-title">子任務 (<span id="bjwt-detail-subtasks-count">0</span>)</div>
            <div class="bjwt-subtask-list" id="bjwt-detail-subtasks-list"></div>
          </div>

          <div class="bjwt-detail-section" id="bjwt-detail-comments-container" style="display: none;">
            <div class="bjwt-detail-section-title">活動與留言 (<span id="bjwt-detail-comments-count">0</span>)</div>
            <div class="bjwt-comment-list" id="bjwt-detail-comments-list"></div>
          </div>
        </div>

        <!-- 右欄 320px：卡片欄位屬性 (狀態、經辦人、報告者、優先順序、Story Points、Epic、到期日、標籤、日期) -->
        <div class="bjwt-detail-side-col">
          <div class="bjwt-detail-section-title">詳細資訊</div>
          <div class="bjwt-detail-field-group">
            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">狀態</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-status">
                <span class="bjwt-history-status-badge ${initialStatusClass}">${escapeHtml(initialStatusName)}</span>
              </div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">經辦人</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-assignee">
                <div class="bjwt-user-cell">
                  ${
                    initialAssigneeAvatar
                      ? `<img src="${escapeHtml(initialAssigneeAvatar)}" alt="" />`
                      : `<span class="bjwt-user-avatar-placeholder">👤</span>`
                  }
                  <span>${escapeHtml(initialAssigneeName)}</span>
                </div>
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-reporter" style="display: none;">
              <div class="bjwt-detail-field-label">報告者</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-reporter">-</div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">優先順序</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-priority">
                ${
                  initialPriorityIcon
                    ? `<img src="${escapeHtml(initialPriorityIcon)}" width="16" height="16" alt="" />`
                    : initialPrioritySvg || ''
                }
                <span>${escapeHtml(initialPriorityName || '未指定')}</span>
              </div>
            </div>

            <div class="bjwt-detail-field">
              <div class="bjwt-detail-field-label">Story Points</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-points">
                <span class="bjwt-history-points-badge">${escapeHtml(String(initialPoints))}</span>
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-parent" style="${initialParentText ? '' : 'display: none;'}">
              <div class="bjwt-detail-field-label">上層項目</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-parent">
                ${
                  initialParentText
                    ? `<span class="bjwt-history-parent-badge"><span class="bjwt-parent-dot"></span>${escapeHtml(initialParentText)}</span>`
                    : '-'
                }
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-due" style="${initialDueDate ? '' : 'display: none;'}">
              <div class="bjwt-detail-field-label">到期日</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-due">
                <span class="bjwt-history-duedate-badge">${escapeHtml(initialDueDate)}</span>
              </div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-labels" style="display: none;">
              <div class="bjwt-detail-field-label">標籤</div>
              <div class="bjwt-detail-field-value bjwt-detail-labels-container" id="bjwt-detail-val-labels"></div>
            </div>

            <div class="bjwt-detail-field" id="bjwt-detail-row-dates" style="display: none;">
              <div class="bjwt-detail-field-label">日期</div>
              <div class="bjwt-detail-field-value" id="bjwt-detail-val-dates" style="font-size: 11px; color: var(--ds-text-subtle, #9fadbc); line-height: 1.5;"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalEl);
    ensureModalBackdrop(modalEl);

    const closeBtn = modalEl.querySelector('.bjwt-history-modal-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        closeIssueDetailModal(modalEl);
      });
    }

    // 非同步從 Jira API 取得完整卡片資訊並平滑補齊內容
    (async () => {
      try {
        const issueData = await fetchIssueDetails(issueKey);
        if (!modalEl.isConnected) return; // 使用者已關閉 Modal

        if (!issueData || !issueData.fields) {
          const descEl = modalEl.querySelector('#bjwt-detail-description-body');
          if (descEl) {
            descEl.innerHTML = '<div class="bjwt-detail-empty-desc">無法從 Jira API 取得卡片完整說明。您可以點擊右上角「在新分頁開啟 ↗」直接檢視。</div>';
          }
          return;
        }

        const fields = issueData.fields;
        const renderedFields = issueData.renderedFields || {};

        // 1. 更新標題
        if (fields.summary) {
          const cleanSummary = cleanSummaryText(fields.summary.trim());
          const headerSummary = modalEl.querySelector('#bjwt-history-modal-header-summary');
          if (headerSummary) {
            headerSummary.textContent = cleanSummary;
            headerSummary.title = cleanSummary;
          }
          const mainTitle = modalEl.querySelector('#bjwt-detail-main-title');
          if (mainTitle) mainTitle.textContent = cleanSummary;
        }

        // 2. 說明欄位
        const descEl = modalEl.querySelector('#bjwt-detail-description-body');
        if (descEl) {
          descEl.innerHTML = formatDescriptionHtml(fields.description, renderedFields.description);
        }

        // 3. 子任務清單
        const subtasks = Array.isArray(fields.subtasks) ? fields.subtasks : [];
        const subtasksContainer = modalEl.querySelector('#bjwt-detail-subtasks-container');
        const subtasksList = modalEl.querySelector('#bjwt-detail-subtasks-list');
        const subtasksCount = modalEl.querySelector('#bjwt-detail-subtasks-count');
        if (subtasksContainer && subtasksList && subtasks.length > 0) {
          subtasksContainer.style.display = 'block';
          if (subtasksCount) subtasksCount.textContent = String(subtasks.length);
          subtasksList.innerHTML = subtasks
            .map((sub) => {
              const subFields = sub.fields || {};
              const subStatus = subFields.status || {};
              const subType = subFields.issuetype || {};
              const isSubDone = subStatus.statusCategory && subStatus.statusCategory.key === 'done';
              const subStatusClass = isSubDone
                ? 'status-done'
                : subStatus.statusCategory && subStatus.statusCategory.key === 'indeterminate'
                ? 'status-inprogress'
                : '';
              return `
                <div class="bjwt-subtask-item" data-bjwt-subtask-key="${escapeHtml(sub.key)}">
                  ${
                    subType.iconUrl
                      ? `<img src="${escapeHtml(subType.iconUrl)}" alt="" width="14" height="14" />`
                      : ''
                  }
                  <a href="${escapeHtml(`${window.location.origin}/browse/${sub.key}`)}" class="bjwt-subtask-key">${escapeHtml(sub.key)}</a>
                  <span class="bjwt-subtask-summary" title="${escapeHtml(subFields.summary || '')}">${escapeHtml(subFields.summary || '')}</span>
                  <span class="bjwt-history-status-badge ${subStatusClass}">${escapeHtml(subStatus.name || '')}</span>
                </div>
              `;
            })
            .join('');

          subtasksList.querySelectorAll('.bjwt-subtask-item').forEach((itemEl) => {
            const subKey = itemEl.getAttribute('data-bjwt-subtask-key');
            const subRaw = subtasks.find((s) => s.key === subKey);
            if (subKey && subRaw) {
              itemEl.addEventListener('click', (e) => {
                e.preventDefault();
                openHistoricalIssueDetailModal(subKey, normalizeJiraIssue(subRaw));
              });
            }
          });
        }

        // 4. 留言清單
        const rawComments =
          (renderedFields.comment && renderedFields.comment.comments) ||
          (fields.comment && fields.comment.comments) ||
          [];
        const commentsContainer = modalEl.querySelector('#bjwt-detail-comments-container');
        const commentsList = modalEl.querySelector('#bjwt-detail-comments-list');
        const commentsCount = modalEl.querySelector('#bjwt-detail-comments-count');
        if (commentsContainer && commentsList && rawComments.length > 0) {
          commentsContainer.style.display = 'block';
          if (commentsCount) commentsCount.textContent = String(rawComments.length);
          commentsList.innerHTML = rawComments
            .map((comm) => {
              const author = comm.author || {};
              const authorName = author.displayName || author.name || '未知使用者';
              const avatar =
                author.avatarUrls && (author.avatarUrls['24x24'] || author.avatarUrls['48x48']);
              const dateStr = formatShortDateTime(comm.created);
              const bodyHtml = formatCommentBody(comm);
              return `
                <div class="bjwt-comment-item">
                  <div class="bjwt-comment-header">
                    <div class="bjwt-user-cell">
                      ${
                        avatar
                          ? `<img src="${escapeHtml(avatar)}" alt="" />`
                          : `<span class="bjwt-user-avatar-placeholder">👤</span>`
                      }
                      <span class="bjwt-comment-author">${escapeHtml(authorName)}</span>
                    </div>
                    <span class="bjwt-comment-date">${escapeHtml(dateStr)}</span>
                  </div>
                  <div class="bjwt-comment-body">${bodyHtml}</div>
                </div>
              `;
            })
            .join('');
        }

        // 5. 報告者
        if (fields.reporter) {
          const rep = fields.reporter;
          const repRow = modalEl.querySelector('#bjwt-detail-row-reporter');
          const repVal = modalEl.querySelector('#bjwt-detail-val-reporter');
          if (repRow && repVal) {
            repRow.style.display = 'flex';
            const repAvatar =
              rep.avatarUrls && (rep.avatarUrls['24x24'] || rep.avatarUrls['48x48']);
            repVal.innerHTML = `
              <div class="bjwt-user-cell">
                ${
                  repAvatar
                    ? `<img src="${escapeHtml(repAvatar)}" alt="" />`
                    : `<span class="bjwt-user-avatar-placeholder">👤</span>`
                }
                <span>${escapeHtml(rep.displayName || rep.name || '未指定')}</span>
              </div>
            `;
          }
        }

        // 6. 標籤
        if (Array.isArray(fields.labels) && fields.labels.length > 0) {
          const labelsRow = modalEl.querySelector('#bjwt-detail-row-labels');
          const labelsVal = modalEl.querySelector('#bjwt-detail-val-labels');
          if (labelsRow && labelsVal) {
            labelsRow.style.display = 'flex';
            labelsVal.innerHTML = fields.labels
              .map((lbl) => `<span class="bjwt-detail-label-tag">${escapeHtml(lbl)}</span>`)
              .join('');
          }
        }

        // 7. 建立與更新日期
        if (fields.created || fields.updated) {
          const datesRow = modalEl.querySelector('#bjwt-detail-row-dates');
          const datesVal = modalEl.querySelector('#bjwt-detail-val-dates');
          if (datesRow && datesVal) {
            datesRow.style.display = 'flex';
            const createdStr = formatShortDateTime(fields.created);
            const updatedStr = formatShortDateTime(fields.updated);
            datesVal.innerHTML = `
              ${createdStr ? `<div>建立：${escapeHtml(createdStr)}</div>` : ''}
              ${updatedStr ? `<div>更新：${escapeHtml(updatedStr)}</div>` : ''}
            `;
          }
        }

        // 8. 重新校準精確狀態與 Story Points (透過 normalizeJiraIssue)
        const normalized = normalizeJiraIssue(issueData);
        if (normalized) {
          const statusVal = modalEl.querySelector('#bjwt-detail-val-status');
          if (statusVal && normalized.statusName) {
            const isNormDone = normalized.statusCategory === 'done';
            const normStatusClass = isNormDone
              ? 'status-done'
              : normalized.statusCategory === 'indeterminate'
              ? 'status-inprogress'
              : '';
            statusVal.innerHTML = `<span class="bjwt-history-status-badge ${normStatusClass}">${escapeHtml(normalized.statusName)}</span>`;
          }
          if (normalized.storyPoints !== null && normalized.storyPoints !== undefined) {
            const pointsVal = modalEl.querySelector('#bjwt-detail-val-points');
            if (pointsVal) {
              pointsVal.innerHTML = `<span class="bjwt-history-points-badge">${normalized.storyPoints}</span>`;
            }
          }
        }
      } catch {
        if (!modalEl.isConnected) return;
        const descEl = modalEl.querySelector('#bjwt-detail-description-body');
        if (descEl) {
          descEl.innerHTML = '<div class="bjwt-detail-empty-desc">無法從 Jira API 取得卡片完整說明。您可以點擊右上角「在新分頁開啟 ↗」直接檢視。</div>';
        }
      }
    })();
  }

  /**
   * 偵測右側卡片詳細面板 (支援載入骨架階段與完整載入階段)，立即轉為置中 Modal
   */
  function findIssueModalPane(host) {
    // 方法 1：從 sprintsHost 往上檢查至 <main>，看是否有出現在右側的分割面板兄弟節點 (0ms 骨架階段即可命中)
    const mainBoundary = host.closest('main, [role="main"]') || document.body;
    let curr = host;
    while (curr && curr !== mainBoundary && curr !== document.body) {
      const parent = curr.parentElement;
      if (parent) {
        let sib = curr.nextElementSibling;
        while (sib) {
          if (
            sib.id !== SIDEBAR_ID &&
            sib.id !== MODAL_BACKDROP_ID &&
            !sib.hasAttribute('data-bjwt-sprint-branch') &&
            !sib.hasAttribute('data-bjwt-sprint-header-partner') &&
            !sib.hasAttribute('data-bjwt-non-sprint-child')
          ) {
            const rect = sib.getBoundingClientRect();
            const isResizer =
              sib.getAttribute('role') === 'separator' ||
              (sib.getAttribute('data-testid') || '').includes('resizer') ||
              (rect.width > 0 && rect.width <= 24);

            if (!isResizer && rect.width > 120 && rect.height > 120) {
              return { modalPane: sib, splitContainer: parent };
            }
          }
          sib = sib.nextElementSibling;
        }
      }
      curr = curr.parentElement;
    }

    // 方法 2：透過明確的 ISSUE_DETAIL_SELECTORS 尋找
    for (const sel of ISSUE_DETAIL_SELECTORS) {
      const candidates = Array.from(document.querySelectorAll(sel));
      const found = candidates.find(
        (el) =>
          !host.contains(el) &&
          !el.closest('[role="dialog"]') &&
          el.getBoundingClientRect().width > 50
      );
      if (found) {
        let modalPane = found;
        while (
          modalPane.parentElement &&
          modalPane.parentElement !== document.body &&
          !modalPane.parentElement.contains(host)
        ) {
          modalPane = modalPane.parentElement;
        }
        const splitContainer = modalPane.parentElement;
        if (splitContainer && splitContainer.contains(host)) {
          return { modalPane, splitContainer };
        }
      }
    }

    return null;
  }

  /**
   * 將 Jira 點擊卡片後右側的詳細面板，立即轉換為置中彈出的 Modal 視窗
   */
  function applyIssueDetailModalTransform(sprintsHost) {
    if (document.getElementById(HISTORY_ISSUE_MODAL_ID)) {
      return;
    }

    const host = sprintsHost || document.querySelector('[data-bjwt-layout-host="true"]');
    if (!host) {
      cleanupIssueModalAttributes();
      return;
    }

    const detected = findIssueModalPane(host);
    if (!detected) {
      cleanupIssueModalAttributes();
      return;
    }

    const { modalPane, splitContainer } = detected;

    document.querySelectorAll('[data-bjwt-issue-modal]').forEach((el) => {
      if (el !== modalPane && el.id !== HISTORY_ISSUE_MODAL_ID) {
        el.removeAttribute('data-bjwt-issue-modal');
      }
    });

    splitContainer.setAttribute('data-bjwt-split-container', 'true');
    modalPane.setAttribute('data-bjwt-issue-modal', 'true');

    // 隱藏分割線 (resizer / separator)
    Array.from(splitContainer.children).forEach((child) => {
      if (
        child !== modalPane &&
        !child.contains(host) &&
        child.id !== MODAL_BACKDROP_ID
      ) {
        child.setAttribute('data-bjwt-resizer-hide', 'true');
      }
    });

    ensureModalBackdrop(modalPane);
  }

  function ensureModalBackdrop(modalPane) {
    let backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = MODAL_BACKDROP_ID;
      backdrop.setAttribute('title', '點擊背景關閉卡片視窗');
      document.body.appendChild(backdrop);
    }
    backdrop.onclick = () => {
      closeIssueDetailModal(modalPane);
    };
  }

  function closeIssueDetailModal(modalPane) {
    const historyModal = document.getElementById(HISTORY_ISSUE_MODAL_ID);
    if (historyModal && (!modalPane || modalPane === historyModal)) {
      historyModal.remove();
      const backdrop = document.getElementById(MODAL_BACKDROP_ID);
      if (backdrop) backdrop.remove();
      return;
    }

    const pane = modalPane || document.querySelector('[data-bjwt-issue-modal="true"]');
    if (pane) {
      const closeSelectors = [
        '[data-testid*="close-button"] button',
        '[data-testid*="close-button"]',
        '[data-testid*="dismiss"]',
        'button[aria-label*="關閉"]',
        'button[aria-label*="Close"]',
        'button[aria-label*="close"]',
        '.js-detail-close',
        '.ghx-Controls button'
      ];
      for (const sel of closeSelectors) {
        const closeBtn = pane.querySelector(sel);
        if (closeBtn && typeof closeBtn.click === 'function') {
          closeBtn.click();
          return;
        }
      }
    }

    // 若找不到關閉按鈕，嘗試移除網址中的 selectedIssue 參數並觸發返回
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('selectedIssue')) {
        url.searchParams.delete('selectedIssue');
        window.history.pushState({}, '', url.toString());
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    } catch {
      // ignore
    }
  }

  function cleanupIssueModalAttributes() {
    if (document.getElementById(HISTORY_ISSUE_MODAL_ID)) {
      return;
    }
    const backdrop = document.getElementById(MODAL_BACKDROP_ID);
    if (backdrop) {
      backdrop.remove();
    }
    document.querySelectorAll('[data-bjwt-issue-modal]').forEach((el) => {
      el.removeAttribute('data-bjwt-issue-modal');
    });
    document.querySelectorAll('[data-bjwt-split-container]').forEach((el) => {
      el.removeAttribute('data-bjwt-split-container');
    });
    document.querySelectorAll('[data-bjwt-resizer-hide]').forEach((el) => {
      el.removeAttribute('data-bjwt-resizer-hide');
    });
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 當離開「待辦事項」網址時，還原原本 Jira DOM 屬性與側邊欄
   */
  function teardownTwoColumnBacklogLayout() {
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) {
      sidebar.remove();
    }

    const pickerModal = document.getElementById(HISTORY_PICKER_MODAL_ID);
    if (pickerModal) {
      pickerModal.remove();
    }

    const historyIssueModal = document.getElementById(HISTORY_ISSUE_MODAL_ID);
    if (historyIssueModal) {
      historyIssueModal.remove();
    }

    document.querySelectorAll('[data-bjwt-history-branch="true"]').forEach((el) => {
      el.remove();
    });

    document.querySelectorAll('.bjwt-active-sprint-custom-view').forEach((el) => {
      el.remove();
    });

    cleanupIssueModalAttributes();

    document.querySelectorAll('[data-bjwt-backlog-pane]').forEach((el) => {
      el.removeAttribute('data-bjwt-backlog-pane');
    });

    document.querySelectorAll('[data-bjwt-layout-host]').forEach((el) => {
      el.removeAttribute('data-bjwt-layout-host');
      el.removeAttribute('data-bjwt-sidebar-collapsed');
    });

    document.querySelectorAll('[data-bjwt-sprint-branch]').forEach((el) => {
      el.removeAttribute('data-bjwt-sprint-branch');
      el.removeAttribute('data-bjwt-sprint-index');
      el.removeAttribute('data-bjwt-sprint-active');
    });

    document.querySelectorAll('[data-bjwt-sprint-header-partner]').forEach((el) => {
      el.removeAttribute('data-bjwt-sprint-header-partner');
      el.removeAttribute('data-bjwt-sprint-active');
    });

    document.querySelectorAll('[data-bjwt-sprint-container]').forEach((el) => {
      el.removeAttribute('data-bjwt-sprint-container');
      el.removeAttribute('data-bjwt-sprint-active');
    });

    document.querySelectorAll('[data-bjwt-non-sprint-child]').forEach((el) => {
      el.removeAttribute('data-bjwt-non-sprint-child');
    });
  }

  function applyThemeAndLayout(matched, themeStyle) {
    const root = document.documentElement;
    if (!matched) {
      root.removeAttribute(THEME_ATTR);
      root.removeAttribute(LAYOUT_ACTIVE_ATTR);
      if (document.body) {
        document.body.removeAttribute(THEME_ATTR);
        document.body.removeAttribute(LAYOUT_ACTIVE_ATTR);
      }
      teardownTwoColumnBacklogLayout();
      return;
    }

    const activeStyle = themeStyle || 'Default';
    root.setAttribute(THEME_ATTR, activeStyle);
    root.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    if (document.body) {
      document.body.setAttribute(THEME_ATTR, activeStyle);
      document.body.setAttribute(LAYOUT_ACTIVE_ATTR, 'two-column');
    }

    const sprintsHost = applyTwoColumnBacklogLayout();
    applyIssueDetailModalTransform(sprintsHost);
  }

  function evaluateAndApply() {
    const matched = isUrlMatched(window.location.href, currentSettings.backlogUrl);
    applyThemeAndLayout(matched, currentSettings.themeStyle);
  }

  function scheduleLayoutRefresh() {
    if (layoutRafId) {
      cancelAnimationFrame(layoutRafId);
    }
    layoutRafId = requestAnimationFrame(() => {
      layoutRafId = null;
      evaluateAndApply();
    });
  }

  /**
   * 判斷某個點擊或輸入目標是否位於我們自定義的側邊欄、自定義卡片檢視或 Modal 內
   */
  function isInsideExtensionUi(el) {
    if (!el || !(el instanceof Element)) return false;
    return Boolean(
      el.closest(`#${SIDEBAR_ID}`) ||
        el.closest(`#${MODAL_BACKDROP_ID}`) ||
        el.closest(`#${HISTORY_PICKER_MODAL_ID}`) ||
        el.closest(`#${HISTORY_ISSUE_MODAL_ID}`) ||
        el.closest('[data-bjwt-history-branch="true"]') ||
        el.closest('[data-bjwt-custom-view]')
    );
  }

  /**
   * 當使用者在 Jira 原生篩選搜尋區 (人員頭像、搜尋框、下拉選單、清除篩選按鈕) 操作時，
   * 立即排程多次微延遲刷新，確保 React 完成狀態更新與虛擬列表重繪後，左右兩欄 100% 即時同步。
   */
  function triggerNativeFilterSyncBurst() {
    scheduleLayoutRefresh();
    setTimeout(() => scheduleLayoutRefresh(), 32);
    setTimeout(() => scheduleLayoutRefresh(), 120);
    setTimeout(() => scheduleLayoutRefresh(), 280);
  }

  // 當點擊卡片時，立即在同一個 frame 及後續微任務偵測右側面板並轉為 Modal (0 延遲)；
  // 當點擊 Jira 原生篩選搜尋區 (如人員頭像、篩選條件、清除篩選) 時，立即同步左右側欄
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!target || !(target instanceof Element)) return;

      if (isInsideCard(target)) {
        requestAnimationFrame(() => applyIssueDetailModalTransform());
        setTimeout(() => applyIssueDetailModalTransform(), 16);
        setTimeout(() => applyIssueDetailModalTransform(), 60);
        return;
      }

      if (!isInsideExtensionUi(target)) {
        triggerNativeFilterSyncBurst();
      }
    },
    true
  );

  // 監聽原生搜尋框輸入與變更事件，即時連動左右側欄
  document.addEventListener(
    'input',
    (e) => {
      const target = e.target;
      if (target && target instanceof Element && !isInsideExtensionUi(target)) {
        triggerNativeFilterSyncBurst();
      }
    },
    true
  );

  document.addEventListener(
    'change',
    (e) => {
      const target = e.target;
      if (target && target instanceof Element && !isInsideExtensionUi(target)) {
        triggerNativeFilterSyncBurst();
      }
    },
    true
  );

  document.addEventListener(
    'keyup',
    (e) => {
      const target = e.target;
      if (target && target instanceof Element && !isInsideExtensionUi(target)) {
        scheduleLayoutRefresh();
      }
    },
    true
  );

  // 按下 ESC 鍵時可關閉卡片 Modal 或歷史 Sprint 選擇視窗
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const pickerModal = document.getElementById(HISTORY_PICKER_MODAL_ID);
      if (pickerModal) {
        pickerModal.remove();
        return;
      }
      const openModal = document.querySelector('[data-bjwt-issue-modal="true"]');
      if (openModal) {
        closeIssueDetailModal(openModal);
      }
    }
  });

  window.addEventListener('resize', () => {
    const sidebar = document.getElementById(SIDEBAR_ID);
    const host = document.querySelector('[data-bjwt-layout-host="true"]');
    if (sidebar || host) {
      updateColumnsViewportHeight(host, sidebar);
    }
  });

  async function init() {
    try {
      const oldStyle = document.getElementById(RUNTIME_STYLE_ID);
      if (oldStyle) {
        oldStyle.remove();
      }
      const existingSidebar = document.getElementById(SIDEBAR_ID);
      if (existingSidebar) {
        existingSidebar.removeAttribute('data-bjwt-sig');
      }
      const settings = await BetterJiraDB.getSettings();
      currentSettings = settings;
      await BetterJiraDB.syncFromObject(settings);
      syncExtensionIcon(currentSettings.themeStyle);
      evaluateAndApply();
    } catch (err) {
      console.warn('[BetterJiraWT] Initialization error:', err);
    }
  }

  // 接收來自 Popup 選單的即時更新訊息
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'BETTER_JIRA_WT_SETTINGS_UPDATED' && message.payload) {
        currentSettings = message.payload;
        syncExtensionIcon(currentSettings.themeStyle);
        BetterJiraDB.syncFromObject(currentSettings).then(() => {
          evaluateAndApply();
          sendResponse({ ok: true });
        });
        return true;
      }
    });
  }

  // 監聽 storage 變更 (多視窗同步)
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        if (changes.backlogUrl) {
          currentSettings.backlogUrl = changes.backlogUrl.newValue;
        }
        if (changes.themeStyle) {
          currentSettings.themeStyle = changes.themeStyle.newValue;
          syncExtensionIcon(currentSettings.themeStyle);
        }
        BetterJiraDB.syncFromObject(currentSettings).then(() => {
          evaluateAndApply();
        });
      }
    });
  }

  // 監聽 Jira SPA 路由切換、原生篩選器屬性變更、非同步衝刺載入與點擊卡片開啟詳細區 (無 50ms 盲區)
  const observer = new MutationObserver((mutations) => {
    const isExternalChange = mutations.some((m) => {
      const rawTarget = m.target;
      const target =
        rawTarget instanceof Element ? rawTarget : rawTarget ? rawTarget.parentElement : null;
      if (!target) return true;
      return !isInsideExtensionUi(target);
    });

    if (isExternalChange) {
      scheduleLayoutRefresh();
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'aria-checked',
        'aria-pressed',
        'aria-selected',
        'aria-expanded',
        'data-selected',
        'class',
        'value'
      ]
    });
  }

  init();
})();
