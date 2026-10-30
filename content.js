/**
 * BetterJiraWT Content Script
 * 偵測當前網址是否符合設定的「待辦事項網址」，若符合則從 IndexedDB 載入並套用指定樣式 (Bootstrap / MaterialDesign)
 */
(() => {
  const THEME_ATTR = 'data-betterjira-theme';
  const BADGE_ID = 'betterjira-wt-floating-badge';

  let currentSettings = {
    backlogUrl: '',
    themeStyle: 'Bootstrap'
  };
  let lastCheckedHref = '';

  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      // 移除結尾斜線以利比對，保留 origin + pathname
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

  function applyThemeToDOM(matched, themeStyle) {
    const root = document.documentElement;
    if (!matched) {
      root.removeAttribute(THEME_ATTR);
      if (document.body) {
        document.body.removeAttribute(THEME_ATTR);
      }
      removeFloatingBadge();
      return;
    }

    const activeStyle = themeStyle || 'Bootstrap';
    root.setAttribute(THEME_ATTR, activeStyle);
    if (document.body) {
      document.body.setAttribute(THEME_ATTR, activeStyle);
    }
    renderFloatingBadge(activeStyle);
  }

  function renderFloatingBadge(activeStyle) {
    if (!document.body) return;

    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = BADGE_ID;
      document.body.appendChild(badge);
    }

    badge.setAttribute('data-style', activeStyle);
    badge.innerHTML = `
      <span class="bjwt-dot"></span>
      <span class="bjwt-title">BetterJiraWT</span>
      <span class="bjwt-pill">${activeStyle}</span>
    `;
  }

  function removeFloatingBadge() {
    const badge = document.getElementById(BADGE_ID);
    if (badge) {
      badge.remove();
    }
  }

  async function evaluateAndApply() {
    const matched = isUrlMatched(window.location.href, currentSettings.backlogUrl);
    applyThemeToDOM(matched, currentSettings.themeStyle);
  }

  async function init() {
    try {
      const settings = await BetterJiraDB.getSettings();
      currentSettings = settings;
      // 同步寫入當前網頁前端的 IndexedDB，確保重啟後與跨頁皆保留於 IndexedDB
      await BetterJiraDB.syncFromObject(settings);
      await evaluateAndApply();
    } catch (err) {
      console.warn('[BetterJiraWT] Initialization error:', err);
    }
  }

  // 接收來自 Popup 選單的即時更新訊息
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'BETTER_JIRA_WT_SETTINGS_UPDATED' && message.payload) {
        currentSettings = message.payload;
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
        }
        BetterJiraDB.syncFromObject(currentSettings).then(() => {
          evaluateAndApply();
        });
      }
    });
  }

  // 支援 Jira SPA 路由切換偵測
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastCheckedHref) {
      lastCheckedHref = window.location.href;
      evaluateAndApply();
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  init();
})();
