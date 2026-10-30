/**
 * @fileoverview 文字處理與清理公用函式庫
 * 提供卡片標題去重、截斷比對、HTML跳脫、日期格式化與網址比對等功能。
 * @module utils/text-utils
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 判斷 shortStr 是否為 fullStr 的截斷重複合併版 (以 "..." 或 "…" 結尾，且前半段與完整標題一致)
   *
   * @param {string} shortStr - 疑似截斷的短字串
   * @param {string} fullStr - 完整字串
   * @returns {boolean} 是否為截斷重複版
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
   *
   * @param {string} rawText - 原始文字內容
   * @param {number} [depth=0] - 遞迴深度，最多 3 次防止無窮迴圈
   * @returns {string} 清理後的乾淨標題
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
   *
   * @param {string[]} chunks - 原始文字片段陣列
   * @param {string} [issueKey=''] - 當前卡片編號，避免編號被重複加入標題中
   * @returns {string[]} 去重後的文字片段陣列
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
   * 清理 Sprint 標題，移除尾部殘留的卡片數量與日期區間
   *
   * @param {string} raw - 原始標題字串
   * @returns {string} 清理後的 Sprint 標題
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
   * 將 ISO 日期字串轉換為短格式 (YYYY/MM/DD)
   *
   * @param {string} isoStr - ISO 8601 日期字串
   * @returns {string} 格式化後的短日期字串，若解析失敗則回傳空字串
   */
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
   * 將 ISO 日期字串轉換為詳細時間格式 (YYYY-MM-DD HH:mm)
   *
   * @param {string} isoStr - ISO 8601 日期時間字串
   * @returns {string} 格式化後的時間字串
   */
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

  /**
   * 將特殊字元轉為 HTML 安全的實體字串
   *
   * @param {string|*} str - 欲跳脫的字串
   * @returns {string} 跳脫後的安全字串
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 正規化網址，移除多餘的結尾斜線
   *
   * @param {string} rawUrl - 原始網址字串
   * @returns {string} 正規化後的網址字串
   */
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

  /**
   * 比對當前瀏覽器網址與設定之待辦事項網址是否匹配
   *
   * @param {string} currentHref - 目前視窗網址
   * @param {string} targetBacklogUrl - 使用者設定的待辦事項網址
   * @returns {boolean} 是否符合匹配條件
   */
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

  BetterJira.TextUtils = {
    isTruncatedDuplicateOf,
    cleanSummaryText,
    deduplicateSummaryChunks,
    cleanSprintTitle,
    formatShortDate,
    formatShortDateTime,
    escapeHtml,
    normalizeUrl,
    isUrlMatched
  };
})();
