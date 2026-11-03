/**
 * @fileoverview BetterJiraWT Popup 選單邏輯
 * 提供待辦事項網址設定、快捷功能開關與跨頁面設定同步。
 * @module popup
 */

document.addEventListener('DOMContentLoaded', async () => {
  const settingsToggleBtn = document.getElementById('settingsToggleBtn');
  const settingsSubmenu = document.getElementById('settingsSubmenu');

  const openBacklogModalBtn = document.getElementById('openBacklogModalBtn');
  const backlogModal = document.getElementById('backlogModal');
  const closeBacklogModalBtn = document.getElementById('closeBacklogModalBtn');
  const cancelBacklogBtn = document.getElementById('cancelBacklogBtn');
  const saveBacklogBtn = document.getElementById('saveBacklogBtn');
  const backlogUrlInput = document.getElementById('backlogUrlInput');
  const backlogUrlPreview = document.getElementById('backlogUrlPreview');
  const useCurrentTabUrlBtn = document.getElementById('useCurrentTabUrlBtn');
  const useExampleUrlBtn = document.getElementById('useExampleUrlBtn');

  const openDefaultSprintModalBtn = document.getElementById('openDefaultSprintModalBtn');
  const defaultSprintModal = document.getElementById('defaultSprintModal');
  const closeDefaultSprintModalBtn = document.getElementById('closeDefaultSprintModalBtn');
  const cancelDefaultSprintBtn = document.getElementById('cancelDefaultSprintBtn');
  const saveDefaultSprintBtn = document.getElementById('saveDefaultSprintBtn');
  const defaultSprintInput = document.getElementById('defaultSprintInput');
  const defaultSprintPreview = document.getElementById('defaultSprintPreview');

  const powerToggle = document.getElementById('powerToggle');
  const powerStatusDesc = document.getElementById('powerStatusDesc');

  const statusText = document.getElementById('statusText');

  const EXAMPLE_URL = 'https://swpc.atlassian.net/jira/software/projects/WMC/boards/391/backlog';

  const DEFAULT_ICON = {
    16: 'icons/icon_default_16.png',
    48: 'icons/icon_default_48.png',
    128: 'icons/icon_default_128.png'
  };

  let currentSettings = await BetterJiraDB.getSettings();
  renderUI(currentSettings);

  // 0. 快捷開啟/關閉切換
  if (powerToggle) {
    powerToggle.addEventListener('change', async () => {
      const isEnabled = powerToggle.checked;
      currentSettings = await BetterJiraDB.saveSetting('enabled', isEnabled);
      renderUI(currentSettings);
      notifyActiveTabs(currentSettings);
      setStatusMessage(isEnabled ? '已啟用 BetterJiraWT 擴充功能' : '已關閉 BetterJiraWT (恢復 Jira 原生版面)');
    });
  }

  // 1. 設定 選單展開/收合
  settingsToggleBtn.addEventListener('click', () => {
    const isExpanded = settingsToggleBtn.classList.toggle('expanded');
    settingsSubmenu.classList.toggle('collapsed', !isExpanded);
  });

  // 1.1 待辦事項網址 Modal 開關
  openBacklogModalBtn.addEventListener('click', () => {
    backlogUrlInput.value = currentSettings.backlogUrl || '';
    backlogModal.classList.remove('hidden');
    backlogUrlInput.focus();
  });

  function closeBacklogModal() {
    backlogModal.classList.add('hidden');
  }

  closeBacklogModalBtn.addEventListener('click', closeBacklogModal);
  cancelBacklogBtn.addEventListener('click', closeBacklogModal);

  // 快捷：帶入目前分頁網址
  useCurrentTabUrlBtn.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].url) {
          backlogUrlInput.value = tabs[0].url;
          backlogUrlInput.focus();
        }
      });
    }
  });

  // 快捷：填入範例網址
  useExampleUrlBtn.addEventListener('click', () => {
    backlogUrlInput.value = EXAMPLE_URL;
    backlogUrlInput.focus();
  });

  // 儲存待辦事項網址至 IndexedDB
  saveBacklogBtn.addEventListener('click', async () => {
    const urlValue = backlogUrlInput.value.trim();
    currentSettings = await BetterJiraDB.saveSetting('backlogUrl', urlValue);
    renderUI(currentSettings);
    notifyActiveTabs(currentSettings);
    setStatusMessage('已儲存「待辦事項網址」至 IndexedDB');
    closeBacklogModal();
  });

  backlogUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBacklogBtn.click();
    }
  });

  // 1.2 預設 Sprint Modal 開關
  openDefaultSprintModalBtn.addEventListener('click', () => {
    defaultSprintInput.value = currentSettings.defaultSprint || '';
    defaultSprintModal.classList.remove('hidden');
    defaultSprintInput.focus();
  });

  function closeDefaultSprintModal() {
    defaultSprintModal.classList.add('hidden');
  }

  closeDefaultSprintModalBtn.addEventListener('click', closeDefaultSprintModal);
  cancelDefaultSprintBtn.addEventListener('click', closeDefaultSprintModal);

  // 儲存預設 Sprint 至 IndexedDB
  saveDefaultSprintBtn.addEventListener('click', async () => {
    const sprintVal = defaultSprintInput.value.trim();
    currentSettings = await BetterJiraDB.saveSetting('defaultSprint', sprintVal);
    renderUI(currentSettings);
    notifyActiveTabs(currentSettings);
    setStatusMessage('已儲存「預設 Sprint」至 IndexedDB');
    closeDefaultSprintModal();
  });

  defaultSprintInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveDefaultSprintBtn.click();
    }
  });

  function updateBrowserActionIcon(enabled = true) {
    const isEnabled = enabled !== false;
    if (typeof chrome !== 'undefined' && chrome.action) {
      if (chrome.action.setIcon) {
        chrome.action.setIcon({ path: DEFAULT_ICON });
      }
      if (chrome.action.setBadgeText) {
        chrome.action.setBadgeText({ text: isEnabled ? '' : 'OFF' });
      }
      if (chrome.action.setBadgeBackgroundColor) {
        chrome.action.setBadgeBackgroundColor({ color: '#6c757d' });
      }
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: 'BETTER_JIRA_WT_UPDATE_ICON',
          enabled: isEnabled
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  }

  function renderUI(settings) {
    const { backlogUrl, defaultSprint, enabled } = settings;
    const isEnabled = enabled !== false;

    document.body.classList.toggle('is-disabled', !isEnabled);

    if (powerToggle) {
      powerToggle.checked = isEnabled;
    }
    if (powerStatusDesc) {
      powerStatusDesc.textContent = isEnabled ? '已啟用雙欄版面美化' : '已停用 (保持 Jira 預設介面)';
    }

    if (backlogUrl) {
      backlogUrlPreview.textContent = backlogUrl;
      backlogUrlPreview.title = backlogUrl;
    } else {
      backlogUrlPreview.textContent = '尚未設定網址 (點擊設定)';
      backlogUrlPreview.title = '';
    }

    if (defaultSprintPreview) {
      if (defaultSprint) {
        defaultSprintPreview.textContent = defaultSprint;
        defaultSprintPreview.title = defaultSprint;
      } else {
        defaultSprintPreview.textContent = '尚未設定 (依首個衝刺)';
        defaultSprintPreview.title = '';
      }
    }

    updateBrowserActionIcon(isEnabled);
  }

  function setStatusMessage(msg) {
    statusText.textContent = msg;
  }

  function notifyActiveTabs(settings) {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          if (tab.id) {
            chrome.tabs.sendMessage(
              tab.id,
              {
                type: 'BETTER_JIRA_WT_SETTINGS_UPDATED',
                payload: settings
              },
              () => {
                void chrome.runtime.lastError;
              }
            );
          }
        });
      });
    }
  }
});
