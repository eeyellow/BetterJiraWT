/**
 * @fileoverview 經辦人與人員頭像、縮寫處理公用函式庫
 * 提供經辦人名稱清理、未指派狀態檢測、頭像縮寫推導與頭像網址正規化等功能。
 * @module utils/assignee-utils
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 清理負責人標籤字串 (去除 Jira 前綴、動作詞與篩選後綴)
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

    // 去除前綴動作詞與屬性標籤 (例如 "按 ", "依 ", "負責人: ", "Filter by assignee: ")
    s = s
      .replace(
        /^(?:按\s*|依\s*|篩選依據\s*[:：]?\s*|負責人\s*[:：]?\s*|經辦人\s*[:：]?\s*|受託人\s*[:：]?\s*|指派給\s*[:：]?\s*|指派對象\s*[:：]?\s*|使用者\s*[:：]?\s*|頭像\s*[:：]?\s*|Assignee\s*[:：]?\s*|Assigned\s+to\s*[:：]?\s*|Filter\s+by(?:\s+assignee)?\s*[:：]?\s*|User\s*[:：]?\s*|Avatar(?:\s+for)?\s*[:：]?\s*)/i,
        ''
      )
      .trim();

    // 去除後綴狀態與動作名詞 (例如 "篩選受託人", "已選取", "filter")
    s = s
      .replace(/\s*[,，(（]?\s*(?:已選取|未選取|selected|not\s+selected|unselected)\s*[)）]?$/i, '')
      .trim();
    s = s.replace(/\s*(?:篩選受託人|受託人|篩選經辦人|篩選負責人|篩選|的頭像|filter|avatar)$/i, '').trim();

    // 若清理後仍屬於未指派詞彙或純指令動作詞，一律回傳空字串
    if (/^(?:未指派|未分配|無負責人|無經辦人|無受託人|unassigned|none)$/i.test(s) || /^(?:按|篩選|filter)$/i.test(s)) {
      return '';
    }
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
    const raw = String(str).toLowerCase().trim();
    // 包含常見的未指派相關詞彙 (如 "按 未指派 篩選受託人", "unassigned", "no assignee")
    if (/未指派|未分配|無負責人|無經辦人|無受託人|unassigned|no\s*assignee|none/i.test(raw)) {
      return true;
    }
    const t = cleanAssigneeLabel(str).toLowerCase();
    return !t || /^(?:未指派|未分配|無負責人|無經辦人|無受託人|無|unassigned|no\s+assignee|none)$/i.test(t);
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
  const emailToUserMap = new Map();         // key: email.toLowerCase()
  const avatarToUserMap = new Map();        // key: normalizedAvatarUrl
  const initialsToUserMap = new Map();      // key: initials.toUpperCase()

  /**
   * 嘗試從 Atlassian / Jira 頭像 URL 中提取 Account ID (若存在)
   *
   * @param {string} url - 頭像網址
   * @returns {string} 提取出的 accountId 或空字串
   */
  function extractAccountIdFromAvatarUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (/issuetype|\/type\/|priority|status/i.test(url)) return '';
    try {
      const baseOrigin = typeof window !== 'undefined' && window.location ? window.location.origin : 'https://swpc.atlassian.net';
      const u = new URL(url, baseOrigin);
      const qId = u.searchParams.get('accountId') || u.searchParams.get('ownerId');
      if (qId && qId.trim()) return qId.trim();
      // Atlassian Cloud: https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/<accountId>/...
      if (/atl-paas\.net/i.test(u.hostname)) {
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length > 0 && segs[0].toLowerCase() !== 'initials' && segs[0].length >= 6) {
          return decodeURIComponent(segs[0]);
        }
      }
    } catch {
      // ignore
    }
    return '';
  }

  /**
   * 註冊人員資料至人員目錄與頭像反查表
   *
   * @param {Object} userObj
   * @param {string} userObj.name - 經辦人完整姓名
   * @param {string} [userObj.avatar=''] - 頭像圖片網址
   * @param {string} [userObj.initials=''] - 頭像縮寫
   * @param {string} [userObj.accountId=''] - Jira Cloud Account ID
   * @param {string} [userObj.username=''] - Jira Server/DC 登入帳號名稱
   * @param {string} [userObj.email=''] - 電子郵件
   * @returns {Object|null} 註冊後的使用者物件
   */
  function registerAssignee({ name, avatar = '', initials = '', accountId = '', username = '', email = '' }) {
    if (!name || typeof name !== 'string') return null;
    const cleanName = cleanAssigneeLabel(name);
    if (!cleanName || isUnassignedText(cleanName) || cleanName === '已指派') {
      return null;
    }

    const normName = cleanName.toLowerCase();
    const normAvatar = avatar ? normalizeAvatarUrl(avatar) : '';
    const cleanInitials = initials ? initials.trim().toUpperCase() : getDisplayInitialsForIssue({ assigneeName: cleanName });
    const resolvedAccId = (accountId && String(accountId).trim()) || extractAccountIdFromAvatarUrl(avatar) || '';
    const cleanUsername = username ? String(username).trim() : '';
    const cleanEmail = email ? String(email).trim() : '';

    let existing = registeredAssigneesMap.get(normName) || (cleanEmail ? emailToUserMap.get(cleanEmail.toLowerCase()) : null);
    if (!existing) {
      existing = {
        name: cleanName,
        avatar: avatar || '',
        initials: cleanInitials,
        accountId: resolvedAccId,
        username: cleanUsername,
        email: cleanEmail
      };
      registeredAssigneesMap.set(normName, existing);
    } else {
      if (avatar && !/issuetype|\/type\//i.test(avatar)) existing.avatar = avatar;
      if (!existing.initials && cleanInitials) existing.initials = cleanInitials;
      if (resolvedAccId) existing.accountId = resolvedAccId;
      if (cleanUsername) existing.username = cleanUsername;
      if (cleanEmail) existing.email = cleanEmail;
      registeredAssigneesMap.set(normName, existing);
    }

    if (existing.email) {
      emailToUserMap.set(existing.email.toLowerCase(), existing);
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
   * 依名稱、Email 或 AccountId 從已註冊目錄中查找最匹配的使用者資訊
   *
   * @param {Object|string} hint - 名稱字串或 { name, email, accountId, username }
   * @returns {Object|null}
   */
  function findRegisteredUser(hint) {
    if (!hint) return null;
    const name = typeof hint === 'string' ? hint.trim() : String(hint.name || '').trim();
    const email = typeof hint === 'object' && hint.email ? String(hint.email).trim().toLowerCase() : '';
    const accountId = typeof hint === 'object' && hint.accountId ? String(hint.accountId).trim() : '';

    if (accountId) {
      for (const u of registeredAssigneesMap.values()) {
        if (u.accountId === accountId) return u;
      }
    }
    if (email && emailToUserMap.has(email)) {
      return emailToUserMap.get(email);
    }
    const cleanName = cleanAssigneeLabel(name).toLowerCase();
    if (cleanName && registeredAssigneesMap.has(cleanName)) {
      return registeredAssigneesMap.get(cleanName);
    }
    // 透過 matchCustomAssignee 模糊比對姓名、Email 前綴或縮寫
    const memberObj = { name: name || email.split('@')[0], email };
    if (memberObj.name) {
      for (const u of registeredAssigneesMap.values()) {
        if (
          matchCustomAssignee(
            {
              assigneeName: u.name,
              assigneeEmail: u.email,
              assigneeInitials: u.initials,
              assigneeAvatar: u.avatar
            },
            memberObj
          )
        ) {
          return u;
        }
      }
    }
    return null;
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

  /**
   * 使用者在設定中自訂的人員名單 (由 IndexedDB 載入)
   * @type {Array<{name: string, email: string}>}
   */
  let customAssigneesList = [];

  /**
   * 設定自訂人員名單，並自動註冊至目錄中
   *
   * @param {Array<{name: string, email: string}>} list - 人員名單
   */
  function setCustomAssignees(list) {
    customAssigneesList = Array.isArray(list)
      ? list
          .filter((m) => m && typeof m.name === 'string' && m.name.trim())
          .map((m) => ({
            name: m.name.trim(),
            email: (m.email || '').trim()
          }))
      : [];

    // 自動為每位自訂成員註冊縮寫、Email 與名稱
    customAssigneesList.forEach((m) => {
      const initials = deriveInitialsVariants(m.name)[0] || '';
      const regUser = registerAssignee({ name: m.name, initials, avatar: '', email: m.email || '' });
      if (m.email) {
        const emailPrefix = m.email.split('@')[0];
        const cleanEmailPrefix = emailPrefix.replace(/[._-]+/g, ' ');
        deriveInitialsVariants(cleanEmailPrefix).forEach((variant) => {
          if (variant && !initialsToUserMap.has(variant)) {
            initialsToUserMap.set(variant, regUser || { name: m.name, initials, avatar: '', email: m.email });
          }
        });
      }
    });
  }

  /**
   * 取得自訂人員名單
   *
   * @returns {Array<{name: string, email: string}>}
   */
  function getCustomAssignees() {
    return customAssigneesList;
  }

  /**
   * 判斷卡片是否屬於指定的自訂人員 (透過名稱、Email、縮寫與 Token 比對)
   *
   * @param {Object} issue - 卡片資料物件
   * @param {Object} member - 自訂人員物件 { name, email }
   * @returns {boolean} 是否符合
   */
  function matchCustomAssignee(issue, member) {
    if (!issue || !member || !member.name) return false;
    if (issue.isUnassigned || isUnassignedText(issue.assigneeName)) return false;

    const targetName = member.name.toLowerCase().trim();
    const targetEmail = (member.email || '').toLowerCase().trim();
    const emailPrefix = targetEmail ? targetEmail.split('@')[0] : '';
    const cleanEmailPrefix = emailPrefix ? emailPrefix.replace(/[._-]+/g, ' ') : '';

    const targetInitials = deriveInitialsVariants(member.name);
    if (cleanEmailPrefix) {
      deriveInitialsVariants(cleanEmailPrefix).forEach((v) => targetInitials.push(v));
    }

    const cardName = cleanAssigneeLabel(issue.assigneeName || '').toLowerCase().trim();
    const cardInitials = (issue.assigneeInitials || '').toUpperCase().trim();
    const cardTokens = Array.isArray(issue.assigneeTokens)
      ? issue.assigneeTokens.map((t) => String(t).toLowerCase())
      : [];
    const cardEmail = (issue.assigneeEmail || '').toLowerCase().trim();

    // 1. Email 精確比對
    if (targetEmail && cardEmail && targetEmail === cardEmail) {
      return true;
    }

    // 2. 名稱完全或部分吻合
    if (cardName && cardName !== '已指派') {
      if (cardName === targetName) return true;
      if (cardName.includes(targetName) || targetName.includes(cardName)) return true;
      if (cleanEmailPrefix && (cardName.includes(cleanEmailPrefix) || cleanEmailPrefix.includes(cardName))) return true;
    }

    // 3. Email 帳號前綴吻合 (例如 "Ray_Huang" 與卡片名稱比對)
    if (emailPrefix && cardName && cardName !== '已指派') {
      if (cardName.includes(emailPrefix) || emailPrefix.includes(cardName)) return true;
    }

    // 4. 頭像縮寫吻合 (例如 "RH", "RAY", "BP")
    if (cardInitials && targetInitials.includes(cardInitials)) {
      return true;
    }

    // 5. 卡片 Token 比對
    if (cardTokens.length > 0) {
      if (cardTokens.includes(targetName)) return true;
      if (emailPrefix && cardTokens.includes(emailPrefix)) return true;
      for (const ti of targetInitials) {
        if (cardTokens.includes(ti.toLowerCase())) return true;
      }
    }

    // 6. 頭像已由全域目錄解析為此姓名
    if (issue.assigneeAvatar) {
      const resolved = resolveUserByAvatar(issue.assigneeAvatar);
      if (resolved && resolved.name && resolved.name.toLowerCase() === targetName) {
        return true;
      }
    }

    return false;
  }

  BetterJira.AssigneeUtils = {
    cleanAssigneeLabel,
    isUnassignedText,
    deriveInitialsVariants,
    getDisplayInitialsForIssue,
    normalizeAvatarUrl,
    extractAccountIdFromAvatarUrl,
    registerAssignee,
    findRegisteredUser,
    resolveUserByAvatar,
    resolveUserByInitials,
    getAllRegisteredAssignees,
    discoverAssigneesFromPage,
    setCustomAssignees,
    getCustomAssignees,
    matchCustomAssignee
  };
})();
