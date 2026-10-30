/**
 * @fileoverview BetterJiraWT Popup 選單邏輯
 * 提供待辦事項網址設定、樣式切換 (Default / Bootstrap / MaterialDesign) 與跨頁面設定同步。
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

  const openStyleModalBtn = document.getElementById('openStyleModalBtn');
  const styleModal = document.getElementById('styleModal');
  const closeStyleModalBtn = document.getElementById('closeStyleModalBtn');
  const cancelStyleBtn = document.getElementById('cancelStyleBtn');
  const saveStyleBtn = document.getElementById('saveStyleBtn');
  const stylePreviewText = document.getElementById('stylePreviewText');
  const currentStyleBadge = document.getElementById('currentStyleBadge');
  const styleOptionCards = document.querySelectorAll('.style-option-card');
  const styleRadios = document.querySelectorAll('input[name="themeStyle"]');

  const statusText = document.getElementById('statusText');

  const EXAMPLE_URL = 'https://swpc.atlassian.net/jira/software/projects/WMC/boards/391/backlog';

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

  let currentSettings = await BetterJiraDB.getSettings();
  renderUI(currentSettings);

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

  // 1.2 樣式 Modal 開關
  openStyleModalBtn.addEventListener('click', () => {
    syncStyleSelection(currentSettings.themeStyle);
    styleModal.classList.remove('hidden');
  });

  function closeStyleModal() {
    styleModal.classList.add('hidden');
  }

  closeStyleModalBtn.addEventListener('click', closeStyleModal);
  cancelStyleBtn.addEventListener('click', closeStyleModal);

  styleRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      syncStyleSelection(radio.value);
    });
  });

  // 儲存樣式設定至 IndexedDB 並更新 Extension Icon
  saveStyleBtn.addEventListener('click', async () => {
    const checkedRadio = document.querySelector('input[name="themeStyle"]:checked');
    const selectedStyle = checkedRadio ? checkedRadio.value : 'Default';
    currentSettings = await BetterJiraDB.saveSetting('themeStyle', selectedStyle);
    renderUI(currentSettings);
    notifyActiveTabs(currentSettings);
    const label = BetterJiraDB.getStyleLabel(selectedStyle);
    setStatusMessage(`已套用「${label}」樣式並存至 IndexedDB`);
    closeStyleModal();
  });

  function syncStyleSelection(styleName) {
    const normalized = styleName || 'Default';
    styleOptionCards.forEach((card) => {
      const radio = card.querySelector('input[name="themeStyle"]');
      const isMatch = radio.value === normalized;
      radio.checked = isMatch;
      card.classList.toggle('selected', isMatch);
    });
  }

  function updateBrowserActionIcon(themeStyle) {
    const styleKey = ICON_MAP[themeStyle] ? themeStyle : 'Default';
    if (typeof chrome !== 'undefined' && chrome.action && chrome.action.setIcon) {
      chrome.action.setIcon({ path: ICON_MAP[styleKey] });
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'BETTER_JIRA_WT_UPDATE_ICON', themeStyle: styleKey }, () => {
        void chrome.runtime.lastError;
      });
    }
  }

  function renderUI(settings) {
    const { backlogUrl, themeStyle } = settings;
    const styleLabel = BetterJiraDB.getStyleLabel(themeStyle);

    document.body.setAttribute('data-theme', themeStyle || 'Default');
    currentStyleBadge.textContent = styleLabel;
    stylePreviewText.textContent = `目前：${styleLabel}`;

    if (backlogUrl) {
      backlogUrlPreview.textContent = backlogUrl;
      backlogUrlPreview.title = backlogUrl;
    } else {
      backlogUrlPreview.textContent = '尚未設定網址 (點擊設定)';
      backlogUrlPreview.title = '';
    }

    syncStyleSelection(themeStyle);
    updateBrowserActionIcon(themeStyle);
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
