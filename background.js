/**
 * @fileoverview BetterJiraWT Background Service Worker
 * 維護 Extension Icon 狀態與啟用徽章，並在安裝或啟動時注入腳本。
 * @module background
 */

/**
 * 預設擴充功能圖示路徑設定
 * @type {{16: string, 48: string, 128: string}}
 */
const DEFAULT_ICON = {
  16: 'icons/icon_default_16.png',
  48: 'icons/icon_default_48.png',
  128: 'icons/icon_default_128.png'
};

/**
 * 依據啟用狀態動態更新擴充功能圖示與提示標題
 * @param {boolean} [enabled=true] - 擴充功能是否啟用
 */
function updateExtensionIcon(enabled = true) {
  const isEnabled = enabled !== false;
  if (chrome.action && chrome.action.setIcon) {
    chrome.action.setIcon({ path: DEFAULT_ICON });
  }
  if (chrome.action && chrome.action.setBadgeText) {
    chrome.action.setBadgeText({ text: isEnabled ? '' : 'OFF' });
  }
  if (chrome.action && chrome.action.setBadgeBackgroundColor) {
    chrome.action.setBadgeBackgroundColor({ color: '#6c757d' });
  }
  if (chrome.action && chrome.action.setTitle) {
    const title = isEnabled ? 'BetterJiraWT' : 'BetterJiraWT (已關閉)';
    chrome.action.setTitle({ title });
  }
}

/**
 * 從 chrome.storage.local 讀取啟用狀態並同步圖示
 */
function syncIconFromStorage() {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['enabled'], (res) => {
      const isEnabled = res ? res.enabled !== false : true;
      updateExtensionIcon(isEnabled);
    });
  }
}

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

chrome.runtime.onStartup.addListener(() => {
  syncIconFromStorage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.enabled !== undefined) {
    chrome.storage.local.get(['enabled'], (res) => {
      const isEnabled = res ? res.enabled !== false : true;
      updateExtensionIcon(isEnabled);
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'BETTER_JIRA_WT_UPDATE_ICON') {
    updateExtensionIcon(message.enabled !== false);
    sendResponse({ ok: true });
    return true;
  }
});
