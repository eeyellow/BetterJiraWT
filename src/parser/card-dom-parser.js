/**
 * @fileoverview Jira 工作項目卡片 (Issue Card) DOM 解析器
 * 從原生卡片 DOM 節點提取卡片編號、去重標題、狀態、Story Points、優先順序、經辦人頭像與縮寫等欄位。
 * @module parser/card-dom-parser
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 從原生卡片 DOM 中提取乾淨且無重複的標題
   *
   * @param {Element} cardEl - 原生卡片容器節點
   * @param {string} [issueKey=''] - 當前卡片編號
   * @returns {string} 提取並深度去重後的乾淨標題
   */
  function extractCleanSummaryFromDom(cardEl, issueKey = '') {
    if (!cardEl) return '';
    const { TextUtils, DomUtils } = BetterJira;
    const { cleanSummaryText, deduplicateSummaryChunks } = TextUtils;
    const { isVisuallyHiddenOrIgnoredNode } = DomUtils;

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
   * 從原生 Jira DOM 卡片節點解析卡片欄位資料
   *
   * @param {Element} cardEl - 卡片 DOM 節點
   * @returns {Object|null} 解析並快取融合後之卡片物件，若無法提取 key 則回傳 null
   */
  function parseIssueFromDomCard(cardEl) {
    if (!cardEl || !(cardEl instanceof Element)) return null;
    const { TextUtils, AssigneeUtils, IssueStore } = BetterJira;
    const { cleanSummaryText, deduplicateSummaryChunks, isTruncatedDuplicateOf } = TextUtils;
    const { cleanAssigneeLabel, isUnassignedText, deriveInitialsVariants, getDisplayInitialsForIssue } = AssigneeUtils;

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
      storyPoints,
      fromDom: true
    };

    return IssueStore.mergeAndCacheIssue(parsedIssue);
  }

  /**
   * 從未結束衝刺的原生 DOM 中提取所有卡片
   *
   * @param {Element|null} branchEl - 衝刺 branch 節點
   * @param {Element} sprintEl - 衝刺 container 節點
   * @returns {Array<Object>} 解析出的卡片資料陣列
   */
  function parseIssuesFromBranch(branchEl, sprintEl) {
    const { CARD_SELECTORS } = BetterJira.Constants;
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

  BetterJira.CardDomParser = {
    extractCleanSummaryFromDom,
    parseIssueFromDomCard,
    parseIssuesFromBranch
  };
})();
