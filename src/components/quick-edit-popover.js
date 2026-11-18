/**
 * @fileoverview 卡片四欄位 (狀態、StoryPoint、優先度、指派人員) 小型就地編輯視窗 (Quick Edit Popover)
 * 點擊右側欄卡片對應欄位時，彈出輕量級浮動面版，允許使用者直接編輯並透過 Jira API 儲存。
 * @module components/quick-edit-popover
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  const POPOVER_ID = 'bjwt-quick-edit-popover';
  let activePopover = null;
  let activeCleanup = null;

  /**
   * 關閉當前開啟的快速編輯浮動視窗
   */
  function close() {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
    if (activePopover && activePopover.parentNode) {
      activePopover.parentNode.removeChild(activePopover);
    }
    activePopover = null;
  }

  /**
   * 計算並設定浮窗的位置，使其貼齊 triggerEl 且不超出瀏覽器可視區域
   *
   * @param {HTMLElement} popoverEl - 浮窗元素
   * @param {HTMLElement} triggerEl - 觸發之欄位按鈕/元素
   */
  function positionPopover(popoverEl, triggerEl) {
    if (!popoverEl || !triggerEl || typeof triggerEl.getBoundingClientRect !== 'function') return;

    const rect = triggerEl.getBoundingClientRect();
    const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const winHeight = typeof window !== 'undefined' ? window.innerHeight : 768;

    // 先設定為可量測狀態
    popoverEl.style.visibility = 'hidden';
    popoverEl.style.display = 'flex';
    const popWidth = popoverEl.offsetWidth || 260;
    const popHeight = popoverEl.offsetHeight || 220;

    // 垂直定位：預設出現在下方，若超出螢幕下方則轉至上方
    let top = rect.bottom + 6;
    if (top + popHeight > winHeight - 12) {
      top = Math.max(12, rect.top - popHeight - 6);
    }

    // 水平定位：卡片右欄通常靠右，優先靠右對齊 (right-aligned)
    let left = rect.right - popWidth;
    if (left < 12) {
      left = Math.max(12, rect.left);
    }
    if (left + popWidth > winWidth - 12) {
      left = Math.max(12, winWidth - popWidth - 12);
    }

    popoverEl.style.top = `${Math.round(top)}px`;
    popoverEl.style.left = `${Math.round(left)}px`;
    popoverEl.style.visibility = 'visible';
  }

  /**
   * 立即清除各區塊渲染簽名並同步執行雙欄排版刷新 (0ms 零延遲更新 UI)
   */
  function triggerImmediateUiRefresh() {
    const { LayoutManager, Constants } = BetterJira;
    const doc = typeof document !== 'undefined' ? document : null;
    if (doc && typeof doc.querySelectorAll === 'function') {
      doc.querySelectorAll('.bjwt-active-sprint-custom-view, [data-bjwt-history-branch="true"]').forEach((el) => {
        if (el && typeof el.removeAttribute === 'function') {
          el.removeAttribute('data-bjwt-render-sig');
        }
      });
      const sidebarId = (Constants && Constants.SIDEBAR_ID) || 'bjwt-sprint-sidebar';
      const sidebar = typeof doc.getElementById === 'function' ? doc.getElementById(sidebarId) : null;
      if (sidebar && typeof sidebar.removeAttribute === 'function') {
        sidebar.removeAttribute('data-bjwt-sig');
      }
      const toolbarId = (Constants && Constants.GLOBAL_FILTER_TOOLBAR_ID) || 'bjwt-global-filter-toolbar';
      const toolbar = typeof doc.getElementById === 'function' ? doc.getElementById(toolbarId) : null;
      if (toolbar && typeof toolbar.removeAttribute === 'function') {
        toolbar.removeAttribute('data-bjwt-toolbar-sig');
      }
    }

    if (LayoutManager) {
      if (typeof LayoutManager.applyTwoColumnBacklogLayout === 'function') {
        try {
          LayoutManager.applyTwoColumnBacklogLayout();
        } catch {
          // ignore
        }
      }
      if (typeof LayoutManager.scheduleLayoutRefresh === 'function') {
        LayoutManager.scheduleLayoutRefresh();
      }
    }
  }

  /**
   * 收集看板中所有曾出現的經辦人名單 (去除重複，並融合 Account ID、Email 與頭像資訊)
   *
   * @param {Object} currentIssue - 當前卡片資料
   * @returns {Array<Object>} 成員列表
   */
  function collectCandidateAssignees(currentIssue) {
    const { AssigneeUtils, IssueStore } = BetterJira;
    const candidates = [];
    const seenNames = new Set();

    const deriveInitials = (name, explicit) => {
      if (explicit) return explicit;
      if (AssigneeUtils && typeof AssigneeUtils.getDisplayInitialsForIssue === 'function') {
        return AssigneeUtils.getDisplayInitialsForIssue({ assigneeName: name, isUnassigned: false });
      }
      return String(name || '').slice(0, 2).toUpperCase();
    };

    // 1. 自訂設定經辦人名單 (最高優先，並自動融合已註冊目錄中的 accountId 與頭像)
    const customList = AssigneeUtils && typeof AssigneeUtils.getCustomAssignees === 'function'
      ? AssigneeUtils.getCustomAssignees()
      : [];

    customList.forEach((m) => {
      if (m && m.name && !seenNames.has(m.name.toLowerCase())) {
        seenNames.add(m.name.toLowerCase());
        const reg =
          AssigneeUtils && typeof AssigneeUtils.findRegisteredUser === 'function'
            ? AssigneeUtils.findRegisteredUser(m)
            : null;
        candidates.push({
          name: m.name,
          email: m.email || (reg && reg.email) || '',
          accountId: (m && m.accountId) || (reg && reg.accountId) || '',
          username: (m && m.username) || (reg && reg.username) || '',
          initials: deriveInitials(m.name, m.initials || (reg && reg.initials) || ''),
          avatar: m.avatar || (reg && reg.avatar) || '',
          isCustom: true
        });
      }
    });

    // 2. 從 IssueStore 快取中蒐集已知經辦人
    if (IssueStore && typeof IssueStore.getAllIssues === 'function') {
      const allIssues = IssueStore.getAllIssues() || [];
      allIssues.forEach((iss) => {
        const name = (iss.assigneeName || '').trim();
        if (
          name &&
          name !== '未指派' &&
          name !== '已指派' &&
          !(AssigneeUtils && AssigneeUtils.isUnassignedText(name))
        ) {
          const lowerName = name.toLowerCase();
          // 若已在自訂名單中，補充其缺少的 accountId / avatar / email
          const existingCandidate = candidates.find(
            (c) =>
              c.name.toLowerCase() === lowerName ||
              (AssigneeUtils &&
                typeof AssigneeUtils.matchCustomAssignee === 'function' &&
                AssigneeUtils.matchCustomAssignee(iss, c))
          );
          if (existingCandidate) {
            if (!existingCandidate.accountId && iss.assigneeAccountId) {
              existingCandidate.accountId = iss.assigneeAccountId;
            }
            if (!existingCandidate.username && iss.assigneeUsername) {
              existingCandidate.username = iss.assigneeUsername;
            }
            if (!existingCandidate.avatar && iss.assigneeAvatar) {
              existingCandidate.avatar = iss.assigneeAvatar;
            }
            if (!existingCandidate.email && iss.assigneeEmail) {
              existingCandidate.email = iss.assigneeEmail;
            }
          } else if (!seenNames.has(lowerName)) {
            seenNames.add(lowerName);
            candidates.push({
              name,
              email: iss.assigneeEmail || '',
              accountId: iss.assigneeAccountId || '',
              username: iss.assigneeUsername || '',
              initials: deriveInitials(name, iss.assigneeInitials),
              avatar: iss.assigneeAvatar || '',
              isCustom: false
            });
          }
        }
      });
    }

    // 3. 從 AssigneeUtils 全域已註冊人員目錄補充
    if (AssigneeUtils && typeof AssigneeUtils.getAllRegisteredAssignees === 'function') {
      const regList = AssigneeUtils.getAllRegisteredAssignees() || [];
      regList.forEach((reg) => {
        if (!reg || !reg.name) return;
        const lowerName = reg.name.toLowerCase();
        const existingCandidate = candidates.find(
          (c) =>
            c.name.toLowerCase() === lowerName ||
            (c.email && reg.email && c.email.toLowerCase() === reg.email.toLowerCase())
        );
        if (existingCandidate) {
          if (!existingCandidate.accountId && reg.accountId) existingCandidate.accountId = reg.accountId;
          if (!existingCandidate.username && reg.username) existingCandidate.username = reg.username;
          if (!existingCandidate.avatar && reg.avatar) existingCandidate.avatar = reg.avatar;
          if (!existingCandidate.email && reg.email) existingCandidate.email = reg.email;
        } else if (!seenNames.has(lowerName)) {
          seenNames.add(lowerName);
          candidates.push({
            name: reg.name,
            email: reg.email || '',
            accountId: reg.accountId || '',
            username: reg.username || '',
            initials: deriveInitials(reg.name, reg.initials),
            avatar: reg.avatar || '',
            isCustom: false
          });
        }
      });
    }

    // 4. 當前卡片的經辦人若不在名單中也納入
    if (currentIssue && currentIssue.assigneeName) {
      const cName = currentIssue.assigneeName.trim();
      if (
        cName &&
        cName !== '未指派' &&
        cName !== '已指派' &&
        !(AssigneeUtils && AssigneeUtils.isUnassignedText(cName)) &&
        !seenNames.has(cName.toLowerCase())
      ) {
        seenNames.add(cName.toLowerCase());
        candidates.push({
          name: cName,
          email: currentIssue.assigneeEmail || '',
          accountId: currentIssue.assigneeAccountId || '',
          username: currentIssue.assigneeUsername || '',
          initials: deriveInitials(cName, currentIssue.assigneeInitials),
          avatar: currentIssue.assigneeAvatar || '',
          isCustom: false
        });
      }
    }

    return candidates;
  }

  /**
   * 開啟小型設定視窗 (Quick Edit Popover)
   *
   * @param {HTMLElement} triggerEl - 觸發元素 (狀態 badge、StoryPoint slot、優先度 slot 或經辦人 slot)
   * @param {string} issueKey - 卡片編號 (例如 "WMC-123")
   * @param {'type'|'status'|'points'|'priority'|'assignee'|'reporter'|'duedate'|'labels'|'parent'} editType - 編輯欄位類型
   * @param {Object} [currentIssue={}] - 卡片目前資料物件
   * @param {Object} [options={}] - 額外選項 ({ onSuccess?: Function })
   */
  async function open(triggerEl, issueKey, editType, currentIssue = {}, options = {}) {
    close();

    const notifySuccess = (updatedFields) => {
      if (options && typeof options.onSuccess === 'function') {
        try {
          options.onSuccess(updatedFields);
        } catch {
          // ignore
        }
      }
    };

    const { TextUtils, JiraApiService, IssueStore, LayoutManager } = BetterJira;
    const { escapeHtml, cleanStatusText } = TextUtils || {
      escapeHtml: (s) => String(s || ''),
      cleanStatusText: (s) => String(s || '')
    };

    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !triggerEl) return;

    const popoverEl = doc.createElement('div');
    popoverEl.id = POPOVER_ID;
    popoverEl.className = `bjwt-quick-edit-popover bjwt-popover-${editType}`;
    popoverEl.setAttribute('role', 'dialog');
    popoverEl.setAttribute('aria-modal', 'true');
    popoverEl.setAttribute('data-bjwt-issue-key', issueKey);
    popoverEl.setAttribute('data-bjwt-edit-type', editType);

    // 標題資訊對照
    const titles = {
      type: { icon: '📌', label: '切換問題類型' },
      status: { icon: '⚡', label: '切換狀態' },
      points: { icon: '🔢', label: '修改 Story Points' },
      priority: { icon: '🎯', label: '修改優先順序' },
      assignee: { icon: '👤', label: '指派經辦人' },
      reporter: { icon: '📝', label: '修改報告者' },
      duedate: { icon: '📅', label: '修改到期日' },
      labels: { icon: '🏷️', label: '編輯標籤' },
      parent: { icon: '🔗', label: '修改上層項目' }
    };
    const currentMeta = titles[editType] || { icon: '✏️', label: '編輯欄位' };

    // 1. 產生基本 Header 骨架
    popoverEl.innerHTML = `
      <div class="bjwt-popover-header">
        <div class="bjwt-popover-title">
          <span class="bjwt-popover-icon">${currentMeta.icon}</span>
          <span class="bjwt-popover-label">${escapeHtml(currentMeta.label)}</span>
          <span class="bjwt-popover-key">${escapeHtml(issueKey)}</span>
        </div>
        <button type="button" class="bjwt-popover-close-btn" title="關閉 (Esc)" aria-label="關閉">✕</button>
      </div>
      <div class="bjwt-popover-body">
        <div class="bjwt-popover-loading">載入中...</div>
      </div>
    `;

    doc.body.appendChild(popoverEl);
    activePopover = popoverEl;

    // 綁定關閉按鈕
    const closeBtn = popoverEl.querySelector('.bjwt-popover-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });
    }

    // 綁定外部點擊與 Esc 關閉
    const handleDocumentClick = (e) => {
      if (popoverEl && !popoverEl.contains(e.target) && !triggerEl.contains(e.target)) {
        close();
      }
    };
    const handleDocumentKeydown = (e) => {
      if (e.key === 'Escape') {
        close();
      }
    };

    setTimeout(() => {
      doc.addEventListener('click', handleDocumentClick, true);
      doc.addEventListener('keydown', handleDocumentKeydown, true);
    }, 10);

    activeCleanup = () => {
      doc.removeEventListener('click', handleDocumentClick, true);
      doc.removeEventListener('keydown', handleDocumentKeydown, true);
    };

    // 立即進行初步定位
    positionPopover(popoverEl, triggerEl);

    const bodyEl = popoverEl.querySelector('.bjwt-popover-body');

    // 2. 針對不同欄位非同步載入介面並綁定互動事件
    try {
      if (editType === 'type') {
        // --- 問題類型切換 ---
        const types = await JiraApiService.fetchIssueTypesForIssue(issueKey);
        if (!popoverEl.isConnected) return;

        const currentTypeName = (currentIssue && currentIssue.issueTypeName) || '未知類型';
        const typeLabelMap = {
          'Story': 'Story (故事)',
          'Bug': 'Bug (缺陷 / 錯誤)',
          'Task': 'Task (任務)',
          'Sub-task': 'Sub-task (子任務)',
          'Epic': 'Epic (史詩)'
        };
        const fallbackIconMap = {
          'Story': '📗',
          'Bug': '🐞',
          'Task': '📋',
          'Sub-task': '🔹',
          'Epic': '⚡'
        };

        if (!Array.isArray(types) || types.length === 0) {
          bodyEl.innerHTML = `
            <div class="bjwt-popover-empty">
              目前卡片類型為 <strong>${escapeHtml(currentTypeName)}</strong>，無可切換之類型選項。
            </div>
          `;
        } else {
          bodyEl.innerHTML = `
            <div class="bjwt-popover-current-hint">目前類型：<strong>${escapeHtml(typeLabelMap[currentTypeName] || currentTypeName)}</strong></div>
            <div class="bjwt-popover-list">
              ${types
                .map((tp) => {
                  const isSelected = currentTypeName && currentTypeName.toLowerCase() === tp.name.toLowerCase();
                  const displayName = typeLabelMap[tp.name] || tp.name;
                  const fallbackIcon = fallbackIconMap[tp.name] || '📄';
                  return `
                    <button type="button" class="bjwt-popover-item bjwt-popover-item-type ${isSelected ? 'is-selected' : ''}" data-type-id="${escapeHtml(tp.id)}" data-type-name="${escapeHtml(tp.name)}">
                      ${
                        tp.iconUrl
                          ? `<img class="bjwt-popover-item-icon" src="${escapeHtml(tp.iconUrl)}" alt="${escapeHtml(tp.name)}" />`
                          : `<span class="bjwt-popover-item-icon-fallback">${fallbackIcon}</span>`
                      }
                      <span class="bjwt-popover-item-text">${escapeHtml(displayName)}</span>
                      ${isSelected ? `<span class="bjwt-popover-check">✓</span>` : ''}
                    </button>
                  `;
                })
                .join('')}
            </div>
          `;

          bodyEl.querySelectorAll('.bjwt-popover-item-type').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const typeId = btn.getAttribute('data-type-id');
              const typeName = btn.getAttribute('data-type-name');
              const matchedT = types.find((t) => String(t.id) === String(typeId)) || { id: typeId, name: typeName, iconUrl: '' };

              btn.disabled = true;
              const textSpan = btn.querySelector('.bjwt-popover-item-text');
              if (textSpan) textSpan.textContent = '切換中...';

              const res = await JiraApiService.updateIssueType(issueKey, { id: typeId, name: typeName });
              if (res.success) {
                if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                  IssueStore.mergeAndCacheIssue({
                    key: issueKey,
                    issueTypeName: typeName,
                    issueTypeIcon: matchedT.iconUrl || '',
                    isUserEdit: true
                  });
                }
                triggerImmediateUiRefresh();
                notifySuccess({ issueTypeName: typeName, issueTypeIcon: matchedT.iconUrl || '' });
                close();
              } else {
                btn.disabled = false;
                if (textSpan) textSpan.textContent = typeLabelMap[typeName] || typeName;
                alert(`問題類型切換失敗：${res.error || '請重試'}`);
              }
            });
          });
        }
      } else if (editType === 'status') {
        // --- 狀態切換 ---
        const transitions = await JiraApiService.fetchIssueTransitions(issueKey);
        if (!popoverEl.isConnected) return;

        const currentStatusName = cleanStatusText(currentIssue.statusName) || '未知狀態';
        if (!Array.isArray(transitions) || transitions.length === 0) {
          bodyEl.innerHTML = `
            <div class="bjwt-popover-empty">
              目前卡片狀態為 <strong>${escapeHtml(currentStatusName)}</strong>，無其他可流轉的狀態轉換選項。
            </div>
          `;
        } else {
          bodyEl.innerHTML = `
            <div class="bjwt-popover-current-hint">目前狀態：<strong>${escapeHtml(currentStatusName)}</strong></div>
            <div class="bjwt-popover-list">
              ${transitions
                .map((t) => {
                  const targetStatus = (t.to && t.to.name) || t.name;
                  const cat = (t.to && t.to.statusCategory && t.to.statusCategory.key) || 'new';
                  return `
                    <button type="button" class="bjwt-popover-item bjwt-popover-item-status" data-transition-id="${escapeHtml(t.id)}">
                      <span class="bjwt-status-dot bjwt-status-${escapeHtml(cat)}"></span>
                      <span class="bjwt-popover-item-text">${escapeHtml(targetStatus)}</span>
                    </button>
                  `;
                })
                .join('')}
            </div>
          `;

          bodyEl.querySelectorAll('.bjwt-popover-item-status').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const transitionId = btn.getAttribute('data-transition-id');
              const matchedT = transitions.find((t) => String(t.id) === String(transitionId));
              const targetName = matchedT ? (matchedT.to && matchedT.to.name) || matchedT.name : '';
              let targetCategory = matchedT ? (matchedT.to && matchedT.to.statusCategory && matchedT.to.statusCategory.key) || '' : '';
              if (!targetCategory && targetName) {
                if (/完成|done|closed|resolved/i.test(targetName)) {
                  targetCategory = 'done';
                } else if (/進行中|in progress|testing|verify|wait|開發|進行/i.test(targetName)) {
                  targetCategory = 'indeterminate';
                } else {
                  targetCategory = 'new';
                }
              }

              btn.disabled = true;
              btn.textContent = '切換中...';

              const res = await JiraApiService.transitionIssue(issueKey, transitionId);
              if (res.success) {
                if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                  IssueStore.mergeAndCacheIssue({
                    key: issueKey,
                    statusName: targetName,
                    statusCategory: targetCategory,
                    isUserEdit: true
                  });
                }
                triggerImmediateUiRefresh();
                notifySuccess({ statusName: targetName, statusCategory: targetCategory });
                close();
              } else {
                btn.disabled = false;
                btn.textContent = targetName;
                alert(`狀態切換失敗：${res.error || '請重試'}`);
              }
            });
          });
        }
      } else if (editType === 'points') {
        // --- Story Points 修改 ---
        const currentPts =
          currentIssue.storyPoints !== null && currentIssue.storyPoints !== undefined && currentIssue.storyPoints !== ''
            ? currentIssue.storyPoints
            : '';

        bodyEl.innerHTML = `
          <form class="bjwt-popover-form-points" onsubmit="return false;">
            <div class="bjwt-popover-input-group">
              <label for="bjwt-quick-points-input" class="bjwt-popover-input-label">Story Points 點數：</label>
              <input
                type="number"
                step="any"
                min="0"
                id="bjwt-quick-points-input"
                class="bjwt-popover-input"
                value="${escapeHtml(String(currentPts))}"
                placeholder="輸入點數 (空白為清空)"
                autofocus
              />
            </div>
            <div class="bjwt-popover-quick-chips">
              <span class="bjwt-popover-chip" data-pt="1">1</span>
              <span class="bjwt-popover-chip" data-pt="2">2</span>
              <span class="bjwt-popover-chip" data-pt="3">3</span>
              <span class="bjwt-popover-chip" data-pt="5">5</span>
              <span class="bjwt-popover-chip" data-pt="8">8</span>
              <span class="bjwt-popover-chip" data-pt="13">13</span>
              <span class="bjwt-popover-chip" data-pt="20">20</span>
              <span class="bjwt-popover-chip bjwt-chip-clear" data-pt="">清空</span>
            </div>
            <div class="bjwt-popover-actions">
              <button type="button" class="bjwt-popover-btn bjwt-popover-cancel-btn">取消</button>
              <button type="submit" class="bjwt-popover-btn bjwt-popover-save-btn">儲存</button>
            </div>
          </form>
        `;

        const inputEl = bodyEl.querySelector('#bjwt-quick-points-input');
        if (inputEl) {
          inputEl.focus();
          inputEl.select();
        }

        bodyEl.querySelectorAll('.bjwt-popover-chip').forEach((chip) => {
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            if (inputEl) {
              inputEl.value = chip.getAttribute('data-pt') || '';
              inputEl.focus();
            }
          });
        });

        const cancelBtn = bodyEl.querySelector('.bjwt-popover-cancel-btn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            close();
          });
        }

        const formEl = bodyEl.querySelector('.bjwt-popover-form-points');
        const saveBtn = bodyEl.querySelector('.bjwt-popover-save-btn');
        formEl.addEventListener('submit', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const rawVal = inputEl ? inputEl.value.trim() : '';
          const newPts = rawVal === '' ? null : parseFloat(rawVal);

          if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '儲存中...';
          }

          const res = await JiraApiService.updateIssueEstimation(issueKey, newPts);
          if (res.success) {
            const resolvedPts = newPts !== null && !isNaN(newPts) ? newPts : null;
            if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
              IssueStore.mergeAndCacheIssue({
                key: issueKey,
                storyPoints: resolvedPts,
                isUserEdit: true
              });
            }
            triggerImmediateUiRefresh();
            notifySuccess({ storyPoints: resolvedPts });
            close();
          } else {
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.textContent = '儲存';
            }
            alert(`Story Points 儲存失敗：${res.error || '請重試'}`);
          }
        });
      } else if (editType === 'priority') {
        // --- 優先度修改 ---
        const priorities = await JiraApiService.fetchPriorities();
        if (!popoverEl.isConnected) return;

        const currentPriName = currentIssue.priorityName || '';
        bodyEl.innerHTML = `
          <div class="bjwt-popover-current-hint">目前優先度：<strong>${escapeHtml(currentPriName || '未指定')}</strong></div>
          <div class="bjwt-popover-list">
            ${priorities
              .map((p) => {
                const isSelected = currentPriName && currentPriName.toLowerCase() === p.name.toLowerCase();
                return `
                  <button type="button" class="bjwt-popover-item bjwt-popover-item-priority ${isSelected ? 'is-selected' : ''}" data-priority-id="${escapeHtml(p.id)}" data-priority-name="${escapeHtml(p.name)}">
                    ${
                      p.iconUrl
                        ? `<img class="bjwt-popover-item-icon" src="${escapeHtml(p.iconUrl)}" alt="${escapeHtml(p.name)}" />`
                        : `<span class="bjwt-popover-item-icon-fallback">🎯</span>`
                    }
                    <span class="bjwt-popover-item-text">${escapeHtml(p.name)}</span>
                    ${isSelected ? `<span class="bjwt-popover-check">✓</span>` : ''}
                  </button>
                `;
              })
              .join('')}
          </div>
        `;

        bodyEl.querySelectorAll('.bjwt-popover-item-priority').forEach((btn) => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const pId = btn.getAttribute('data-priority-id');
            const pName = btn.getAttribute('data-priority-name');
            const matchedP = priorities.find((p) => String(p.id) === String(pId)) || { id: pId, name: pName, iconUrl: '' };

            btn.disabled = true;
            const textSpan = btn.querySelector('.bjwt-popover-item-text');
            if (textSpan) textSpan.textContent = '更新中...';

            const res = await JiraApiService.updateIssuePriority(issueKey, { id: pId, name: pName });
            if (res.success) {
              if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                IssueStore.mergeAndCacheIssue({
                  key: issueKey,
                  priorityName: pName,
                  priorityIcon: matchedP.iconUrl || '',
                  prioritySvg: '',
                  isUserEdit: true
                });
              }
              triggerImmediateUiRefresh();
              notifySuccess({ priorityName: pName, priorityIcon: matchedP.iconUrl || '', prioritySvg: '' });
              close();
            } else {
              btn.disabled = false;
              if (textSpan) textSpan.textContent = pName;
              alert(`優先度更新失敗：${res.error || '請重試'}`);
            }
          });
        });
      } else if (editType === 'assignee' || editType === 'reporter') {
        // --- 經辦人 / 報告者修改 (共用人員搜尋與選擇邏輯) ---
        const isReporter = editType === 'reporter';
        let candidates = collectCandidateAssignees(currentIssue);
        const currentUserLabel = isReporter
          ? currentIssue.reporterName || '未指定'
          : currentIssue.isUnassigned
          ? '未指派'
          : currentIssue.assigneeName || '未指派';

        // 在背景預先查詢此卡片在 Jira 中的可指派成員，自動補齊自訂成員的 accountId 與頭像
        if (JiraApiService && typeof JiraApiService.fetchAssignableUsers === 'function') {
          JiraApiService.fetchAssignableUsers(issueKey)
            .then((apiUsers) => {
              if (!popoverEl.isConnected || !Array.isArray(apiUsers) || apiUsers.length === 0) return;
              candidates = collectCandidateAssignees(currentIssue);
            })
            .catch(() => {});
        }

        function renderUserList(filterKw = '') {
          const kw = filterKw.trim().toLowerCase();
          const filtered = candidates.filter((c) => {
            if (!kw) return true;
            return (
              c.name.toLowerCase().includes(kw) ||
              (c.email && c.email.toLowerCase().includes(kw))
            );
          });

          return `
            <!-- 搜尋框 -->
            <div class="bjwt-popover-search-box">
              <input
                type="text"
                class="bjwt-popover-search-input"
                id="bjwt-assignee-search-input"
                placeholder="搜尋姓名或 Email..."
                value="${escapeHtml(filterKw)}"
                autofocus
              />
            </div>
            <div class="bjwt-popover-list bjwt-assignee-scroll-list">
              ${
                !isReporter
                  ? `
                    <!-- 未指派選項 -->
                    <button type="button" class="bjwt-popover-item bjwt-popover-item-assignee ${currentUserLabel === '未指派' ? 'is-selected' : ''}" data-assignee-name="__UNASSIGNED__">
                      <span class="bjwt-avatar-placeholder unassigned">?</span>
                      <span class="bjwt-popover-item-text" style="font-weight: 600;">未指派</span>
                      ${currentUserLabel === '未指派' ? `<span class="bjwt-popover-check">✓</span>` : ''}
                    </button>
                  `
                  : ''
              }

              ${filtered
                .map((c) => {
                  const isSelected = currentUserLabel === c.name;
                  return `
                    <button type="button" class="bjwt-popover-item bjwt-popover-item-assignee ${isSelected ? 'is-selected' : ''}" data-assignee-name="${escapeHtml(c.name)}">
                      ${
                        c.avatar
                          ? `<img class="bjwt-dropdown-avatar" src="${escapeHtml(c.avatar)}" alt="" />`
                          : `<span class="bjwt-avatar-placeholder">${escapeHtml(c.initials || c.name.slice(0, 2).toUpperCase())}</span>`
                      }
                      <div class="bjwt-popover-assignee-info">
                        <span class="bjwt-popover-item-text">${escapeHtml(c.name)}</span>
                        ${c.email ? `<small class="bjwt-popover-item-sub">${escapeHtml(c.email)}</small>` : ''}
                      </div>
                      ${isSelected ? `<span class="bjwt-popover-check">✓</span>` : ''}
                    </button>
                  `;
                })
                .join('')}

              ${
                kw && !filtered.some((c) => c.name.toLowerCase() === kw)
                  ? `
                    <button type="button" class="bjwt-popover-item bjwt-popover-item-assignee bjwt-item-custom-name" data-assignee-name="${escapeHtml(filterKw.trim())}">
                      <span class="bjwt-avatar-placeholder">+</span>
                      <div class="bjwt-popover-assignee-info">
                        <span class="bjwt-popover-item-text">直接${isReporter ? '設為報告者' : '指派為'}：「${escapeHtml(filterKw.trim())}」</span>
                      </div>
                    </button>
                  `
                  : ''
              }
            </div>
          `;
        }

        bodyEl.innerHTML = renderUserList('');

        function bindUserPickerEvents() {
          const searchInput = bodyEl.querySelector('#bjwt-assignee-search-input');
          if (searchInput) {
            searchInput.focus();
            searchInput.addEventListener('input', (e) => {
              const kw = e.target.value;
              bodyEl.innerHTML = renderUserList(kw);
              const newSearchInput = bodyEl.querySelector('#bjwt-assignee-search-input');
              if (newSearchInput) {
                newSearchInput.focus();
                newSearchInput.selectionStart = newSearchInput.selectionEnd = kw.length;
              }
              bindUserPickerEvents();
              positionPopover(popoverEl, triggerEl);
            });
          }

          bodyEl.querySelectorAll('.bjwt-popover-item-assignee').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const targetName = btn.getAttribute('data-assignee-name');
              const isUnassign = !isReporter && (!targetName || targetName === '__UNASSIGNED__');
              const matchedMember = candidates.find((c) => c.name === targetName);

              btn.disabled = true;
              const textSpan = btn.querySelector('.bjwt-popover-item-text');
              if (textSpan) textSpan.textContent = isReporter ? '更新中...' : '指派中...';

              const res = isReporter
                ? await JiraApiService.updateIssueReporter(
                    issueKey,
                    targetName,
                    matchedMember ? matchedMember.accountId : null,
                    matchedMember || { name: targetName }
                  )
                : await JiraApiService.updateIssueAssignee(
                    issueKey,
                    isUnassign ? null : targetName,
                    matchedMember ? matchedMember.accountId : null,
                    matchedMember || { name: targetName }
                  );

              if (res.success) {
                const resolved = res.resolvedUser || null;
                const finalName = isUnassign ? '未指派' : (resolved && resolved.name) || targetName;
                const finalAvatar = isUnassign
                  ? ''
                  : (resolved && resolved.avatar) || (matchedMember ? matchedMember.avatar : '');
                const finalEmail = isUnassign
                  ? ''
                  : (resolved && resolved.email) || (matchedMember ? matchedMember.email : '');
                const finalAccountId = isUnassign
                  ? ''
                  : (resolved && resolved.accountId) || (matchedMember ? matchedMember.accountId : '');
                const finalUsername = isUnassign
                  ? ''
                  : (resolved && resolved.username) || (matchedMember ? matchedMember.username : '');
                const finalInitials = isUnassign
                  ? ''
                  : (matchedMember && matchedMember.initials) ||
                    (BetterJira.AssigneeUtils && typeof BetterJira.AssigneeUtils.getDisplayInitialsForIssue === 'function'
                      ? BetterJira.AssigneeUtils.getDisplayInitialsForIssue({ assigneeName: finalName, isUnassigned: false })
                      : finalName.slice(0, 2).toUpperCase());

                if (isReporter) {
                  notifySuccess({
                    reporterName: finalName,
                    reporterAvatar: finalAvatar,
                    reporterEmail: finalEmail,
                    reporterAccountId: finalAccountId,
                    reporterUsername: finalUsername
                  });
                } else {
                  const assigneeUpdate = {
                    key: issueKey,
                    assigneeName: finalName,
                    isUnassigned: isUnassign,
                    assigneeAvatar: finalAvatar,
                    assigneeInitials: finalInitials,
                    assigneeBgColor: '',
                    assigneeEmail: finalEmail,
                    assigneeAccountId: finalAccountId,
                    assigneeUsername: finalUsername,
                    isUserEdit: true
                  };
                  if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                    IssueStore.mergeAndCacheIssue(assigneeUpdate);
                  }
                  triggerImmediateUiRefresh();
                  notifySuccess(assigneeUpdate);
                }
                close();
              } else {
                btn.disabled = false;
                if (textSpan) textSpan.textContent = isUnassign ? '未指派' : targetName;
                alert(`${isReporter ? '報告者更新' : '經辦人指派'}失敗：${res.error || '請重試'}`);
              }
            });
          });
        }

        bindUserPickerEvents();
      } else if (editType === 'duedate') {
        // --- 到期日修改 ---
        const formatDateOffset = (days) => {
          const d = new Date();
          d.setDate(d.getDate() + days);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          return `${yyyy}-${mm}-${dd}`;
        };
        const rawDue = String(currentIssue.dueDate || '').trim();
        const initialDateVal = /^\d{4}-\d{2}-\d{2}$/.test(rawDue) ? rawDue : '';

        bodyEl.innerHTML = `
          <form class="bjwt-popover-form-points" onsubmit="return false;">
            <div class="bjwt-popover-input-group">
              <label for="bjwt-quick-duedate-input" class="bjwt-popover-input-label">到期日 (YYYY-MM-DD)：</label>
              <input
                type="date"
                id="bjwt-quick-duedate-input"
                class="bjwt-popover-input"
                value="${escapeHtml(initialDateVal)}"
              />
            </div>
            <div class="bjwt-popover-quick-chips">
              <span class="bjwt-popover-chip" data-due="${escapeHtml(formatDateOffset(0))}">今天</span>
              <span class="bjwt-popover-chip" data-due="${escapeHtml(formatDateOffset(1))}">明天</span>
              <span class="bjwt-popover-chip" data-due="${escapeHtml(formatDateOffset(7))}">+7 天</span>
              <span class="bjwt-popover-chip bjwt-chip-clear" data-due="">清空</span>
            </div>
            <div class="bjwt-popover-actions">
              <button type="button" class="bjwt-popover-btn bjwt-popover-cancel-btn">取消</button>
              <button type="submit" class="bjwt-popover-btn bjwt-popover-save-btn">儲存</button>
            </div>
          </form>
        `;

        const dateInput = bodyEl.querySelector('#bjwt-quick-duedate-input');
        if (dateInput) dateInput.focus();

        bodyEl.querySelectorAll('.bjwt-popover-chip').forEach((chip) => {
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dateInput) {
              dateInput.value = chip.getAttribute('data-due') || '';
              dateInput.focus();
            }
          });
        });

        const cancelBtn = bodyEl.querySelector('.bjwt-popover-cancel-btn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            close();
          });
        }

        const formEl = bodyEl.querySelector('.bjwt-popover-form-points');
        const saveBtn = bodyEl.querySelector('.bjwt-popover-save-btn');
        formEl.addEventListener('submit', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const newDue = dateInput ? dateInput.value.trim() : '';

          if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '儲存中...';
          }

          const res = await JiraApiService.updateIssueDueDate(issueKey, newDue || null);
          if (res.success) {
            if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
              IssueStore.mergeAndCacheIssue({
                key: issueKey,
                dueDate: newDue,
                isUserEdit: true
              });
            }
            triggerImmediateUiRefresh();
            notifySuccess({ dueDate: newDue });
            close();
          } else {
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.textContent = '儲存';
            }
            alert(`到期日更新失敗：${res.error || '請重試'}`);
          }
        });
      } else if (editType === 'labels') {
        // --- 標籤編輯 ---
        let workingLabels = Array.isArray(currentIssue.labels) ? [...currentIssue.labels] : [];
        let suggestedLabels = [];

        if (JiraApiService && typeof JiraApiService.fetchLabelSuggestions === 'function') {
          JiraApiService.fetchLabelSuggestions('')
            .then((suggestions) => {
              if (!popoverEl.isConnected || !Array.isArray(suggestions)) return;
              suggestedLabels = suggestions.slice(0, 12);
              renderLabelsBody();
            })
            .catch(() => {});
        }

        function renderLabelsBody(inputVal = '') {
          const availableSuggestions = suggestedLabels.filter((s) => !workingLabels.includes(s)).slice(0, 8);
          bodyEl.innerHTML = `
            <div class="bjwt-popover-input-group">
              <label for="bjwt-quick-label-input" class="bjwt-popover-input-label">目前標籤：</label>
              <div class="bjwt-popover-label-chips">
                ${
                  workingLabels.length > 0
                    ? workingLabels
                        .map(
                          (lbl) => `
                            <span class="bjwt-popover-label-chip">
                              <span>${escapeHtml(lbl)}</span>
                              <button type="button" class="bjwt-popover-label-remove" data-label="${escapeHtml(lbl)}" title="移除標籤">×</button>
                            </span>
                          `
                        )
                        .join('')
                    : '<span class="bjwt-popover-label-empty">尚無標籤</span>'
                }
              </div>
              <div class="bjwt-popover-label-add-row">
                <input
                  type="text"
                  id="bjwt-quick-label-input"
                  class="bjwt-popover-input"
                  placeholder="輸入標籤名稱 (空白將底線化)..."
                  value="${escapeHtml(inputVal)}"
                />
                <button type="button" class="bjwt-popover-btn bjwt-popover-add-label-btn">新增</button>
              </div>
            </div>
            ${
              availableSuggestions.length > 0
                ? `
                  <div class="bjwt-popover-quick-chips" style="margin-top: 8px;">
                    ${availableSuggestions
                      .map((s) => `<span class="bjwt-popover-chip bjwt-popover-suggest-label" data-label="${escapeHtml(s)}">+ ${escapeHtml(s)}</span>`)
                      .join('')}
                  </div>
                `
                : ''
            }
            <div class="bjwt-popover-actions">
              <button type="button" class="bjwt-popover-btn bjwt-popover-cancel-btn">取消</button>
              <button type="button" class="bjwt-popover-btn bjwt-popover-save-btn">儲存</button>
            </div>
          `;

          const labelInput = bodyEl.querySelector('#bjwt-quick-label-input');
          const addBtn = bodyEl.querySelector('.bjwt-popover-add-label-btn');

          const addLabel = (raw) => {
            const clean = String(raw || '').trim().replace(/\s+/g, '_');
            if (!clean) return;
            if (!workingLabels.includes(clean)) {
              workingLabels.push(clean);
            }
            renderLabelsBody('');
            const nextInput = bodyEl.querySelector('#bjwt-quick-label-input');
            if (nextInput) nextInput.focus();
            positionPopover(popoverEl, triggerEl);
          };

          if (labelInput) {
            labelInput.focus();
            labelInput.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                addLabel(labelInput.value);
              }
            });
          }

          if (addBtn) {
            addBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (labelInput) addLabel(labelInput.value);
            });
          }

          bodyEl.querySelectorAll('.bjwt-popover-label-remove').forEach((btn) => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const target = btn.getAttribute('data-label');
              workingLabels = workingLabels.filter((l) => l !== target);
              renderLabelsBody(labelInput ? labelInput.value : '');
              positionPopover(popoverEl, triggerEl);
            });
          });

          bodyEl.querySelectorAll('.bjwt-popover-suggest-label').forEach((chip) => {
            chip.addEventListener('click', (e) => {
              e.stopPropagation();
              addLabel(chip.getAttribute('data-label'));
            });
          });

          const cancelBtn = bodyEl.querySelector('.bjwt-popover-cancel-btn');
          if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              close();
            });
          }

          const saveBtn = bodyEl.querySelector('.bjwt-popover-save-btn');
          if (saveBtn) {
            saveBtn.addEventListener('click', async (e) => {
              e.stopPropagation();
              if (labelInput && labelInput.value.trim()) {
                const pending = labelInput.value.trim().replace(/\s+/g, '_');
                if (pending && !workingLabels.includes(pending)) {
                  workingLabels.push(pending);
                }
              }
              saveBtn.disabled = true;
              saveBtn.textContent = '儲存中...';

              const res = await JiraApiService.updateIssueLabels(issueKey, workingLabels);
              if (res.success) {
                if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                  IssueStore.mergeAndCacheIssue({
                    key: issueKey,
                    labels: [...workingLabels],
                    isUserEdit: true
                  });
                }
                notifySuccess({ labels: [...workingLabels] });
                close();
              } else {
                saveBtn.disabled = false;
                saveBtn.textContent = '儲存';
                alert(`標籤更新失敗：${res.error || '請重試'}`);
              }
            });
          }
        }

        renderLabelsBody('');
      } else if (editType === 'parent') {
        // --- 上層項目 (Parent / Epic) 修改 ---
        const currentParentKey = String(currentIssue.parentKey || '').trim();
        let candidates = await JiraApiService.searchParentCandidates(issueKey, '');
        if (!popoverEl.isConnected) return;

        let searchTimer = null;

        function renderParentList(filterKw = '') {
          const kw = filterKw.trim();
          const kwLower = kw.toLowerCase();
          const filtered = candidates.filter((c) => {
            if (!kwLower) return true;
            return (
              c.key.toLowerCase().includes(kwLower) ||
              (c.summary && c.summary.toLowerCase().includes(kwLower))
            );
          });

          return `
            <div class="bjwt-popover-search-box">
              <input
                type="text"
                class="bjwt-popover-search-input"
                id="bjwt-parent-search-input"
                placeholder="搜尋卡片編號或標題 (如 PROJ-10)..."
                value="${escapeHtml(filterKw)}"
                autofocus
              />
            </div>
            <div class="bjwt-popover-list bjwt-assignee-scroll-list">
              <button type="button" class="bjwt-popover-item bjwt-popover-item-parent ${!currentParentKey ? 'is-selected' : ''}" data-parent-key="">
                <span class="bjwt-avatar-placeholder unassigned">×</span>
                <span class="bjwt-popover-item-text" style="font-weight: 600;">無上層項目 (清除)</span>
                ${!currentParentKey ? `<span class="bjwt-popover-check">✓</span>` : ''}
              </button>

              ${filtered
                .map((c) => {
                  const isSelected = currentParentKey && currentParentKey.toUpperCase() === c.key.toUpperCase();
                  return `
                    <button type="button" class="bjwt-popover-item bjwt-popover-item-parent ${isSelected ? 'is-selected' : ''}" data-parent-key="${escapeHtml(c.key)}" data-parent-summary="${escapeHtml(c.summary || '')}">
                      <span class="bjwt-popover-item-icon-fallback">🔗</span>
                      <div class="bjwt-popover-assignee-info">
                        <span class="bjwt-popover-item-text">${escapeHtml(c.key)}</span>
                        ${c.summary ? `<small class="bjwt-popover-item-sub">${escapeHtml(c.summary)}</small>` : ''}
                      </div>
                      ${isSelected ? `<span class="bjwt-popover-check">✓</span>` : ''}
                    </button>
                  `;
                })
                .join('')}

              ${
                kw && !filtered.some((c) => c.key.toLowerCase() === kwLower)
                  ? `
                    <button type="button" class="bjwt-popover-item bjwt-popover-item-parent bjwt-item-custom-name" data-parent-key="${escapeHtml(kw.toUpperCase())}">
                      <span class="bjwt-avatar-placeholder">+</span>
                      <div class="bjwt-popover-assignee-info">
                        <span class="bjwt-popover-item-text">設定上層項目為：「${escapeHtml(kw.toUpperCase())}」</span>
                      </div>
                    </button>
                  `
                  : ''
              }
            </div>
          `;
        }

        bodyEl.innerHTML = renderParentList('');

        function bindParentEvents() {
          const searchInput = bodyEl.querySelector('#bjwt-parent-search-input');
          if (searchInput) {
            searchInput.focus();
            searchInput.addEventListener('input', (e) => {
              const kw = e.target.value;
              bodyEl.innerHTML = renderParentList(kw);
              const newInput = bodyEl.querySelector('#bjwt-parent-search-input');
              if (newInput) {
                newInput.focus();
                newInput.selectionStart = newInput.selectionEnd = kw.length;
              }
              bindParentEvents();
              positionPopover(popoverEl, triggerEl);

              if (searchTimer) clearTimeout(searchTimer);
              searchTimer = setTimeout(async () => {
                const remote = await JiraApiService.searchParentCandidates(issueKey, kw);
                if (!popoverEl.isConnected) return;
                if (Array.isArray(remote) && remote.length > 0) {
                  const existingKeys = new Set(candidates.map((c) => c.key));
                  remote.forEach((r) => {
                    if (!existingKeys.has(r.key)) {
                      candidates.push(r);
                      existingKeys.add(r.key);
                    }
                  });
                  const activeInput = bodyEl.querySelector('#bjwt-parent-search-input');
                  const currentVal = activeInput ? activeInput.value : kw;
                  bodyEl.innerHTML = renderParentList(currentVal);
                  const restoredInput = bodyEl.querySelector('#bjwt-parent-search-input');
                  if (restoredInput) {
                    restoredInput.focus();
                    restoredInput.selectionStart = restoredInput.selectionEnd = currentVal.length;
                  }
                  bindParentEvents();
                  positionPopover(popoverEl, triggerEl);
                }
              }, 260);
            });
          }

          bodyEl.querySelectorAll('.bjwt-popover-item-parent').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const targetKey = btn.getAttribute('data-parent-key') || '';
              const fallbackSummary = btn.getAttribute('data-parent-summary') || '';

              btn.disabled = true;
              const textSpan = btn.querySelector('.bjwt-popover-item-text');
              if (textSpan) textSpan.textContent = '更新中...';

              const res = await JiraApiService.updateIssueParent(issueKey, targetKey || null);
              if (res.success) {
                const finalKey = res.parentKey || targetKey;
                const finalSummary = finalKey ? (res.parentSummary || fallbackSummary || finalKey) : '';
                if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                  IssueStore.mergeAndCacheIssue({
                    key: issueKey,
                    parentKey: finalKey,
                    parentSummary: finalSummary,
                    isUserEdit: true
                  });
                }
                triggerImmediateUiRefresh();
                notifySuccess({ parentKey: finalKey, parentSummary: finalSummary });
                close();
              } else {
                btn.disabled = false;
                if (textSpan) textSpan.textContent = targetKey || '無上層項目 (清除)';
                alert(`上層項目更新失敗：${res.error || '請重試'}`);
              }
            });
          });
        }

        bindParentEvents();
      }

      // 載入完成後重新校準一次座標
      positionPopover(popoverEl, triggerEl);
    } catch (err) {
      if (popoverEl.isConnected) {
        bodyEl.innerHTML = `<div class="bjwt-popover-error">載入失敗：${escapeHtml(err.message || '未知錯誤')}</div>`;
      }
    }
  }

  BetterJira.QuickEditPopoverComponent = {
    open,
    close,
    positionPopover,
    collectCandidateAssignees,
    triggerImmediateUiRefresh
  };
})();
