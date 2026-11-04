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

  const openAssigneesModalBtn = document.getElementById('openAssigneesModalBtn');
  const assigneesModal = document.getElementById('assigneesModal');
  const closeAssigneesModalBtn = document.getElementById('closeAssigneesModalBtn');
  const cancelAssigneesBtn = document.getElementById('cancelAssigneesBtn');
  const saveAssigneesBtn = document.getElementById('saveAssigneesBtn');
  const newAssigneeNameInput = document.getElementById('newAssigneeNameInput');
  const newAssigneeEmailInput = document.getElementById('newAssigneeEmailInput');
  const addAssigneeBtn = document.getElementById('addAssigneeBtn');
  const clearAllAssigneesBtn = document.getElementById('clearAllAssigneesBtn');
  const assigneesList = document.getElementById('assigneesList');
  const assigneesCount = document.getElementById('assigneesCount');
  const assigneesPreview = document.getElementById('assigneesPreview');

  let modalAssignees = [];

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

  // 1.3 經辦人名單 Modal 開關與互動
  function renderModalAssigneesList() {
    if (!assigneesList) return;
    assigneesList.innerHTML = '';
    if (assigneesCount) {
      assigneesCount.textContent = String(modalAssignees.length);
    }

    if (modalAssignees.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'assignees-empty-placeholder';
      emptyEl.textContent = '尚未新增任何人員，請在上方輸入名稱與 Email 後點擊「新增」';
      assigneesList.appendChild(emptyEl);
      return;
    }

    modalAssignees.forEach((member, index) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'assignee-item';

      const infoEl = document.createElement('div');
      infoEl.className = 'assignee-item-info';

      const nameEl = document.createElement('span');
      nameEl.className = 'assignee-item-name';
      nameEl.textContent = member.name;

      infoEl.appendChild(nameEl);

      if (member.email) {
        const emailEl = document.createElement('span');
        emailEl.className = 'assignee-item-email';
        emailEl.textContent = member.email;
        infoEl.appendChild(emailEl);
      }

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'assignee-remove-btn';
      removeBtn.title = '刪除此人員';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        modalAssignees.splice(index, 1);
        renderModalAssigneesList();
      });

      itemEl.appendChild(infoEl);
      itemEl.appendChild(removeBtn);
      assigneesList.appendChild(itemEl);
    });
  }

  function handleAddNewAssignee() {
    const name = (newAssigneeNameInput.value || '').trim();
    const email = (newAssigneeEmailInput.value || '').trim();

    if (!name) {
      newAssigneeNameInput.focus();
      return;
    }

    // 檢查是否重複名稱
    const isDuplicate = modalAssignees.some(
      (m) => m.name.toLowerCase() === name.toLowerCase() || (email && m.email && m.email.toLowerCase() === email.toLowerCase())
    );
    if (isDuplicate) {
      setStatusMessage(`人員「${name}」已在名單中`);
    }

    modalAssignees.push({ name, email });
    newAssigneeNameInput.value = '';
    newAssigneeEmailInput.value = '';
    newAssigneeNameInput.focus();
    renderModalAssigneesList();
  }

  if (openAssigneesModalBtn && assigneesModal) {
    openAssigneesModalBtn.addEventListener('click', () => {
      modalAssignees = Array.isArray(currentSettings.customAssignees)
        ? JSON.parse(JSON.stringify(currentSettings.customAssignees))
        : [];
      renderModalAssigneesList();
      assigneesModal.classList.remove('hidden');
      if (newAssigneeNameInput) newAssigneeNameInput.focus();
    });

    const closeAssigneesModal = () => {
      assigneesModal.classList.add('hidden');
    };

    if (closeAssigneesModalBtn) closeAssigneesModalBtn.addEventListener('click', closeAssigneesModal);
    if (cancelAssigneesBtn) cancelAssigneesBtn.addEventListener('click', closeAssigneesModal);

    if (addAssigneeBtn) {
      addAssigneeBtn.addEventListener('click', handleAddNewAssignee);
    }

    if (newAssigneeNameInput) {
      newAssigneeNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (newAssigneeEmailInput && !newAssigneeEmailInput.value) {
            newAssigneeEmailInput.focus();
          } else {
            handleAddNewAssignee();
          }
        }
      });
    }

    if (newAssigneeEmailInput) {
      newAssigneeEmailInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAddNewAssignee();
        }
      });
    }

    if (clearAllAssigneesBtn) {
      clearAllAssigneesBtn.addEventListener('click', () => {
        modalAssignees = [];
        renderModalAssigneesList();
      });
    }

    if (saveAssigneesBtn) {
      saveAssigneesBtn.addEventListener('click', async () => {
        currentSettings = await BetterJiraDB.saveSetting('customAssignees', modalAssignees);
        renderUI(currentSettings);
        notifyActiveTabs(currentSettings);
        setStatusMessage(`已儲存「經辦人名單」至 IndexedDB (共 ${modalAssignees.length} 位)`);
        closeAssigneesModal();
      });
    }
  }

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

    if (assigneesPreview) {
      const list = Array.isArray(settings.customAssignees) ? settings.customAssignees : [];
      if (list.length > 0) {
        assigneesPreview.textContent = `已設定 ${list.length} 位人員`;
        assigneesPreview.title = list.map((m) => m.email ? `${m.name} (${m.email})` : m.name).join('、');
      } else {
        assigneesPreview.textContent = '尚未設定人員 (點擊設定)';
        assigneesPreview.title = '';
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
