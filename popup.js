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

  // 儲存樣式設定至 IndexedDB
  saveStyleBtn.addEventListener('click', async () => {
    const checkedRadio = document.querySelector('input[name="themeStyle"]:checked');
    const selectedStyle = checkedRadio ? checkedRadio.value : 'Bootstrap';
    currentSettings = await BetterJiraDB.saveSetting('themeStyle', selectedStyle);
    renderUI(currentSettings);
    notifyActiveTabs(currentSettings);
    setStatusMessage(`已套用「${selectedStyle}」樣式並存至 IndexedDB`);
    closeStyleModal();
  });

  function syncStyleSelection(styleName) {
    styleOptionCards.forEach((card) => {
      const radio = card.querySelector('input[name="themeStyle"]');
      const isMatch = radio.value === styleName;
      radio.checked = isMatch;
      card.classList.toggle('selected', isMatch);
    });
  }

  function renderUI(settings) {
    const { backlogUrl, themeStyle } = settings;

    document.body.setAttribute('data-theme', themeStyle);
    currentStyleBadge.textContent = themeStyle;
    stylePreviewText.textContent = `目前：${themeStyle}`;

    if (backlogUrl) {
      backlogUrlPreview.textContent = backlogUrl;
      backlogUrlPreview.title = backlogUrl;
    } else {
      backlogUrlPreview.textContent = '尚未設定網址 (點擊設定)';
      backlogUrlPreview.title = '';
    }

    syncStyleSelection(themeStyle);
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
                // 忽略未注入 content script 的系統分頁錯誤
                void chrome.runtime.lastError;
              }
            );
          }
        });
      });
    }
  }
});
