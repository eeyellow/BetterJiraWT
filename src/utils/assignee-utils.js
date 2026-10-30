/**
 * @fileoverview 經辦人與人員頭像、縮寫處理公用函式庫
 * 提供經辦人名稱清理、未指派狀態檢測、頭像縮寫推導與頭像網址正規化等功能。
 * @module utils/assignee-utils
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 清理負責人標籤字串 (去除 Jira 前綴與篩選後綴)
   *
   * @param {string} raw - 原始標籤或名稱字串
   * @returns {string} 清理後的經辦人姓名
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
   *
   * @param {string} str - 待檢查之字串
   * @returns {boolean} 是否為未指派代表詞
   */
  function isUnassignedText(str) {
    if (!str) return false;
    const t = cleanAssigneeLabel(str).toLowerCase();
    return /^(?:未指派|未分配|無負責人|無經辦人|無|unassigned|no\s+assignee|none)$/i.test(t);
  }

  /**
   * 從負責人姓名推導各種可能的縮寫形式 (例如 "Ray Huang" -> ["RAY", "RH", "R"], "Bruce Peng" -> ["BP", "BRUCE", "B"])
   *
   * @param {string} name - 負責人姓名
   * @param {string} [explicitInitials=''] - 原生 DOM 明確呈現的縮寫
   * @returns {string[]} 所有可能的縮寫變體陣列
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
   *
   * @param {Object} iss - 卡片資料物件
   * @param {boolean} [iss.isUnassigned] - 是否未指派
   * @param {string} [iss.assigneeName] - 經辦人名稱
   * @param {string} [iss.assigneeInitials] - 經辦人縮寫
   * @returns {string} 欲顯示的縮寫文字 (至多 4 碼)
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
   * 正規化頭像圖片網址以便比對 (去除 size 等查詢參數與尺寸路徑)
   *
   * @param {string} url - 原始頭像 URL
   * @returns {string} 正規化後的人員頭像 URL
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

  BetterJira.AssigneeUtils = {
    cleanAssigneeLabel,
    isUnassignedText,
    deriveInitialsVariants,
    getDisplayInitialsForIssue,
    normalizeAvatarUrl
  };
})();
