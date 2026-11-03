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
   * 全域人員目錄與頭像反查快取映射
   */
  const registeredAssigneesMap = new Map(); // key: cleanName.toLowerCase()
  const avatarToUserMap = new Map();        // key: normalizedAvatarUrl
  const initialsToUserMap = new Map();      // key: initials.toUpperCase()

  /**
   * 註冊人員資料至人員目錄與頭像反查表
   *
   * @param {Object} userObj
   * @param {string} userObj.name - 經辦人完整姓名
   * @param {string} [userObj.avatar=''] - 頭像圖片網址
   * @param {string} [userObj.initials=''] - 頭像縮寫
   * @returns {Object|null} 註冊後的使用者物件
   */
  function registerAssignee({ name, avatar = '', initials = '' }) {
    if (!name || typeof name !== 'string') return null;
    const cleanName = cleanAssigneeLabel(name);
    if (!cleanName || isUnassignedText(cleanName) || cleanName === '已指派') {
      return null;
    }

    const normName = cleanName.toLowerCase();
    const normAvatar = avatar ? normalizeAvatarUrl(avatar) : '';
    const cleanInitials = initials ? initials.trim().toUpperCase() : getDisplayInitialsForIssue({ assigneeName: cleanName });

    let existing = registeredAssigneesMap.get(normName);
    if (!existing) {
      existing = {
        name: cleanName,
        avatar: avatar || '',
        initials: cleanInitials
      };
      registeredAssigneesMap.set(normName, existing);
    } else {
      if (!existing.avatar && avatar) existing.avatar = avatar;
      if (!existing.initials && cleanInitials) existing.initials = cleanInitials;
    }

    if (normAvatar) {
      avatarToUserMap.set(normAvatar, existing);
    }
    if (cleanInitials && cleanInitials.length <= 6) {
      initialsToUserMap.set(cleanInitials, existing);
    }

    // 將所有推導出的縮寫變體均連結至該使用者 (若尚未被佔用)
    deriveInitialsVariants(cleanName, cleanInitials).forEach((variant) => {
      if (variant && !initialsToUserMap.has(variant)) {
        initialsToUserMap.set(variant, existing);
      }
    });

    return existing;
  }

  /**
   * 依頭像網址反查人員物件
   *
   * @param {string} avatarUrl - 頭像網址
   * @returns {Object|null} 人員物件
   */
  function resolveUserByAvatar(avatarUrl) {
    if (!avatarUrl || typeof avatarUrl !== 'string') return null;
    const norm = normalizeAvatarUrl(avatarUrl);
    if (!norm) return null;
    if (avatarToUserMap.has(norm)) {
      return avatarToUserMap.get(norm);
    }
    // 模糊比對去除查詢參數之路徑
    for (const [key, user] of avatarToUserMap.entries()) {
      if (key && (norm.includes(key) || key.includes(norm))) {
        return user;
      }
    }
    return null;
  }

  /**
   * 依縮寫反查人員物件
   *
   * @param {string} initials - 縮寫文字 (例: "RAY", "BP")
   * @returns {Object|null} 人員物件
   */
  function resolveUserByInitials(initials) {
    if (!initials || typeof initials !== 'string') return null;
    const clean = initials.trim().toUpperCase();
    if (!clean || clean.length > 6) return null;
    return initialsToUserMap.get(clean) || null;
  }

  /**
   * 取得目前已註冊之全量人員清單
   *
   * @returns {Object[]}
   */
  function getAllRegisteredAssignees() {
    return Array.from(registeredAssigneesMap.values());
  }

  /**
   * 主動從當前頁面 (包含原生標頭、頭像列、篩選器與看板 DOM) 探索並註冊所有人體成員
   *
   * @returns {Object[]} 本次新發現或更新之人員清單
   */
  function discoverAssigneesFromPage() {
    if (typeof document === 'undefined') return [];
    const discovered = [];

    // 尋找原生頁面標頭、頭像組與篩選工具列候選容器
    const rootNodes = [
      document.querySelector('[data-testid="software-backlog.page-header"]'),
      document.querySelector('[data-testid*="page-header"]'),
      document.querySelector('[data-testid*="avatar-group"]'),
      document.querySelector('[data-testid*="assignee-filter"]'),
      document.querySelector('.ghx-controls-filters'),
      document.querySelector('#ghx-quick-filters'),
      document.body
    ].filter(Boolean);

    const seen = new Set();
    const candidateNodes = [];

    rootNodes.forEach((root) => {
      const items = root.querySelectorAll(
        '[data-testid*="assignee"], [data-testid*="avatar-group"] button, [data-testid*="avatar-group"] [role="button"], [data-testid*="ak-avatar"], button[aria-label*="負責人"], button[aria-label*="經辦人"], button[aria-label*="Assignee"], button:has(img[src*="avatar"]), button:has(img[src*="atl-paas"])'
      );
      items.forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          candidateNodes.push(el);
        }
      });
    });

    candidateNodes.forEach((node) => {
      const rawLabels = [];
      const add = (s) => {
        if (s && typeof s === 'string' && s.trim()) rawLabels.push(s.trim());
      };

      add(node.getAttribute('aria-label'));
      add(node.getAttribute('title'));

      node.querySelectorAll('[aria-label], [title], img[alt], [class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"]').forEach((d) => {
        add(d.getAttribute('aria-label'));
        add(d.getAttribute('title'));
        add(d.getAttribute('alt'));
        if (d.textContent) add(d.textContent.trim());
      });

      const cleanedNames = Array.from(
        new Set(
          rawLabels
            .map(cleanAssigneeLabel)
            .filter((s) => s && !isUnassignedText(s) && !/^(?:已選取|未選取|selected|unselected|avatar)$/i.test(s))
        )
      );

      const img = node.querySelector('img[src]');
      const avatarSrc = img ? img.src : '';
      const name = cleanedNames[0];

      if (name) {
        const initials = deriveInitialsVariants(name)[0] || '';
        const user = registerAssignee({ name, avatar: avatarSrc, initials });
        if (user) discovered.push(user);
      }
    });

    return discovered;
  }

  /**
   * 正規化頭像圖片網址以便比對 (去除 size 等查詢參數與尺寸路徑)
   *
   * @param {string} url - 原始頭像 URL
   * @returns {string} 正規化後的人員頭像 URL
   */
  function normalizeAvatarUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (/issuetype|\/type\/|priority|status|universal_avatar\/view\/type\/issuetype/i.test(url)) return '';
    try {
      const baseOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : 'https://swpc.atlassian.net';
      const u = new URL(url, baseOrigin);
      // 去除結尾尺寸路徑 (如 /128, /48, /32, /24, /small, /medium, /large, /xsmall)
      let cleanPath = u.pathname.replace(/\/(?:small|medium|large|xsmall|xxlarge|\d+)$/i, '');
      // 提取 ownerId / accountId 參數 (若有)
      const ownerId = u.searchParams.get('ownerId') || u.searchParams.get('accountId') || u.searchParams.get('userId');
      if (ownerId) {
        return `${u.origin}${cleanPath}?ownerId=${ownerId}`;
      }
      return `${u.origin}${cleanPath}`;
    } catch {
      return url.split('?')[0].replace(/\/(?:small|medium|large|xsmall|xxlarge|\d+)$/i, '');
    }
  }

  BetterJira.AssigneeUtils = {
    cleanAssigneeLabel,
    isUnassignedText,
    deriveInitialsVariants,
    getDisplayInitialsForIssue,
    normalizeAvatarUrl,
    registerAssignee,
    resolveUserByAvatar,
    resolveUserByInitials,
    getAllRegisteredAssignees,
    discoverAssigneesFromPage
  };
})();
