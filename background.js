/**
 * @fileoverview BetterJiraWT Background Service Worker
 * 依分頁網址與設定之待辦事項網址比對結果維護 Extension Icon 狀態與啟用徽章，並在安裝或啟動時注入腳本。
 * @module background
 */

if (typeof importScripts === 'function') {
  importScripts('src/utils/text-utils.js');
}

/**
 * 網址符合時之藍色擴充功能圖示路徑設定
 * @type {{16: string, 48: string, 128: string}}
 */
const BLUE_ICON = {
  16: 'icons/icon_default_16.png',
  48: 'icons/icon_default_48.png',
  128: 'icons/icon_default_128.png'
};

/**
 * 網址不符合或尚未設定時之灰色擴充功能圖示路徑設定
 * @type {{16: string, 48: string, 128: string}}
 */
const GRAY_ICON = {
  16: 'icons/icon_gray_16.png',
  48: 'icons/icon_gray_48.png',
  128: 'icons/icon_gray_128.png'
};

/**
 * 取得共用之網址比對函式
 * @param {string} currentHref - 目前分頁網址
 * @param {string} targetBacklogUrl - 設定之待辦事項網址
 * @returns {boolean}
 */
function checkUrlMatched(currentHref, targetBacklogUrl) {
  const scopes = [
    typeof globalThis !== 'undefined' ? globalThis : null,
    typeof self !== 'undefined' ? self : null,
    typeof window !== 'undefined' ? window : null,
    typeof global !== 'undefined' ? global : null
  ].filter(Boolean);

  for (const scope of scopes) {
    const textUtils =
      (scope.BetterJira && scope.BetterJira.TextUtils) ||
      (scope.window && scope.window.BetterJira && scope.window.BetterJira.TextUtils);
    if (textUtils && typeof textUtils.isUrlMatched === 'function') {
      return textUtils.isUrlMatched(currentHref, targetBacklogUrl);
    }
  }
  return false;
}

/**
 * 安全呼叫 chrome.action API 並消耗 runtime.lastError 避免分頁已關閉時報錯
 * @param {Function|undefined} fn - chrome.action 方法
 * @param {Object} details - 參數物件
 */
function safeActionCall(fn, details) {
  if (typeof fn !== 'function') return;
  fn(details, () => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      void chrome.runtime.lastError;
    }
  });
}

/**
 * 依單一分頁網址與啟用狀態更新該分頁之擴充功能圖示、徽章與標題
 * - 未設定 backlogUrl 或網址不相符：顯示灰色圖示，不顯示 OFF 徽章
 * - 網址相符且已啟用：顯示藍色圖示，不顯示徽章
 * - 網址相符但已關閉：顯示藍色圖示 + OFF 徽章
 *
 * @param {chrome.tabs.Tab} tab - 分頁物件
 * @param {{enabled?: boolean, backlogUrl?: string}} [settings={}] - 目前設定
 */
function updateTabIcon(tab, settings = {}) {
  if (!tab || !tab.id || typeof chrome === 'undefined' || !chrome.action) return;

  const isEnabled = settings.enabled !== false;
  const backlogUrl = typeof settings.backlogUrl === 'string' ? settings.backlogUrl.trim() : '';
  const tabUrl = tab.url || tab.pendingUrl || '';
  const matched = Boolean(backlogUrl && tabUrl && checkUrlMatched(tabUrl, backlogUrl));

  const iconPath = matched ? BLUE_ICON : GRAY_ICON;
  const badgeText = matched && !isEnabled ? 'OFF' : '';
  const title = matched
    ? isEnabled
      ? 'BetterJiraWT'
      : 'BetterJiraWT (已關閉)'
    : 'BetterJiraWT (目前頁面未符合設定網址)';

  safeActionCall(chrome.action.setIcon, { tabId: tab.id, path: iconPath });
  safeActionCall(chrome.action.setBadgeText, { tabId: tab.id, text: badgeText });
  safeActionCall(chrome.action.setBadgeBackgroundColor, { tabId: tab.id, color: '#6c757d' });
  safeActionCall(chrome.action.setTitle, { tabId: tab.id, title });
}

/**
 * 更新所有已開啟分頁之圖示狀態
 * @param {{enabled?: boolean, backlogUrl?: string}} settings - 目前設定
 * @returns {Promise<void>}
 */
function updateAllTabsIcons(settings = {}) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.query !== 'function') {
      resolve();
      return;
    }
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime) {
        void chrome.runtime.lastError;
      }
      if (Array.isArray(tabs)) {
        tabs.forEach((tab) => updateTabIcon(tab, settings));
      }
      resolve();
    });
  });
}

/**
 * 從 chrome.storage.local 讀取設定並同步指定分頁或所有分頁圖示
 * @param {chrome.tabs.Tab|null} [targetTab=null] - 指定更新的單一分頁，省略則更新所有分頁
 * @returns {Promise<void>}
 */
function syncIconFromStorage(targetTab = null) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }
    chrome.storage.local.get(['enabled', 'backlogUrl'], (res) => {
      const settings = {
        enabled: res ? res.enabled !== false : true,
        backlogUrl: res && typeof res.backlogUrl === 'string' ? res.backlogUrl : ''
      };
      if (targetTab && targetTab.id) {
        updateTabIcon(targetTab, settings);
        resolve();
        return;
      }
      updateAllTabsIcons(settings).then(resolve);
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    syncIconFromStorage();

    if (chrome.tabs && chrome.scripting) {
      chrome.tabs.query({ url: ['*://*.atlassian.net/*'] }, (tabs) => {
        if (!tabs) return;
        tabs.forEach((tab) => {
          if (!tab.id) return;
          chrome.scripting.insertCSS(
            {
              target: { tabId: tab.id },
              files: ['styles.css']
            },
            () => void chrome.runtime.lastError
          );
          chrome.scripting.executeScript(
            {
              target: { tabId: tab.id },
              files: [
                'db.js',
                'src/constants.js',
                'src/utils/text-utils.js',
                'src/utils/dom-utils.js',
                'src/utils/assignee-utils.js',
                'src/services/sprint-stats.js',
                'src/state/issue-store.js',
                'src/services/jira-api.js',
                'src/services/filter-service.js',
                'src/parser/adf-parser.js',
                'src/parser/sprint-dom-parser.js',
                'src/parser/card-dom-parser.js',
                'src/components/runtime-styles.js',
                'src/components/issue-card.js',
                'src/components/issue-modal.js',
                'src/components/history-picker-modal.js',
                'src/components/sidebar.js',
                'src/components/active-sprint-view.js',
                'src/components/history-sprint-view.js',
                'src/layout/layout-manager.js',
                'content.js'
              ]
            },
            () => void chrome.runtime.lastError
          );
        });
      });
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    syncIconFromStorage();
  });
}

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.enabled !== undefined || changes.backlogUrl !== undefined)) {
      syncIconFromStorage();
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') {
      syncIconFromStorage(tab);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (typeof chrome.tabs.get !== 'function') return;
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime && chrome.runtime.lastError) return;
      if (tab) {
        syncIconFromStorage(tab);
      }
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE || !chrome.tabs || !chrome.tabs.query) return;
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (chrome.runtime && chrome.runtime.lastError) return;
      if (Array.isArray(tabs) && tabs[0]) {
        syncIconFromStorage(tabs[0]);
      }
    });
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'BETTER_JIRA_WT_UPDATE_ICON') {
      const hasExplicitSettings =
        message.enabled !== undefined && message.backlogUrl !== undefined;
      const targetTab = sender && sender.tab && sender.tab.id ? sender.tab : null;

      if (hasExplicitSettings) {
        const settings = {
          enabled: message.enabled !== false,
          backlogUrl: typeof message.backlogUrl === 'string' ? message.backlogUrl : ''
        };
        if (targetTab) {
          updateTabIcon(targetTab, settings);
          sendResponse({ ok: true });
        } else {
          updateAllTabsIcons(settings).then(() => sendResponse({ ok: true }));
        }
      } else {
        syncIconFromStorage(targetTab).then(() => sendResponse({ ok: true }));
      }
      return true;
    }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BLUE_ICON,
    GRAY_ICON,
    updateTabIcon,
    updateAllTabsIcons,
    syncIconFromStorage
  };
}
