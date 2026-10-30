/**
 * BetterJiraWT Background Service Worker
 * 根據目前設定的樣式 (Default / Bootstrap / MaterialDesign) 動態切換瀏覽器上的 Extension Icon
 */

const ICON_MAP = {
  Default: {
    16: 'icons/icon_default_16.png',
    48: 'icons/icon_default_48.png',
    128: 'icons/icon_default_128.png'
  },
  Bootstrap: {
    16: 'icons/icon_bootstrap_16.png',
    48: 'icons/icon_bootstrap_48.png',
    128: 'icons/icon_bootstrap_128.png'
  },
  MaterialDesign: {
    16: 'icons/icon_material_16.png',
    48: 'icons/icon_material_48.png',
    128: 'icons/icon_material_128.png'
  }
};

const TITLE_MAP = {
  Default: 'BetterJiraWT (樣式：預設)',
  Bootstrap: 'BetterJiraWT (樣式：Bootstrap)',
  MaterialDesign: 'BetterJiraWT (樣式：MaterialDesign)'
};

function updateExtensionIcon(themeStyle) {
  const styleKey = ICON_MAP[themeStyle] ? themeStyle : 'Default';
  if (chrome.action && chrome.action.setIcon) {
    chrome.action.setIcon({ path: ICON_MAP[styleKey] });
  }
  if (chrome.action && chrome.action.setTitle) {
    chrome.action.setTitle({ title: TITLE_MAP[styleKey] || 'BetterJiraWT' });
  }
}

function syncIconFromStorage() {
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['themeStyle'], (res) => {
      updateExtensionIcon((res && res.themeStyle) || 'Default');
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
            files: ['db.js', 'content.js']
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
  if (areaName === 'local' && changes.themeStyle) {
    updateExtensionIcon(changes.themeStyle.newValue);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'BETTER_JIRA_WT_UPDATE_ICON') {
    updateExtensionIcon(message.themeStyle);
    sendResponse({ ok: true });
    return true;
  }
});
