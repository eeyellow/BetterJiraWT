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
   * 收集看板中所有曾出現的經辦人名單 (去除重複)
   *
   * @param {Object} currentIssue - 當前卡片資料
   * @returns {Array<Object>} 成員列表
   */
  function collectCandidateAssignees(currentIssue) {
    const { AssigneeUtils, IssueStore } = BetterJira;
    const candidates = [];
    const seenNames = new Set();

    // 1. 自訂設定經辦人名單 (最高優先)
    const customList = AssigneeUtils && typeof AssigneeUtils.getCustomAssignees === 'function'
      ? AssigneeUtils.getCustomAssignees()
      : [];

    customList.forEach((m) => {
      if (m && m.name && !seenNames.has(m.name)) {
        seenNames.add(m.name);
        candidates.push({
          name: m.name,
          email: m.email || '',
          initials: m.initials || m.name.slice(0, 2).toUpperCase(),
          avatar: m.avatar || '',
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
          !(AssigneeUtils && AssigneeUtils.isUnassignedText(name)) &&
          !seenNames.has(name)
        ) {
          seenNames.add(name);
          candidates.push({
            name,
            email: iss.assigneeEmail || '',
            initials: iss.assigneeInitials || name.slice(0, 2).toUpperCase(),
            avatar: iss.assigneeAvatar || '',
            isCustom: false
          });
        }
      });
    }

    // 3. 當前卡片的經辦人若不在名單中也納入
    if (currentIssue && currentIssue.assigneeName) {
      const cName = currentIssue.assigneeName.trim();
      if (
        cName &&
        cName !== '未指派' &&
        !(AssigneeUtils && AssigneeUtils.isUnassignedText(cName)) &&
        !seenNames.has(cName)
      ) {
        seenNames.add(cName);
        candidates.push({
          name: cName,
          email: currentIssue.assigneeEmail || '',
          initials: currentIssue.assigneeInitials || cName.slice(0, 2).toUpperCase(),
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
   * @param {'status'|'points'|'priority'|'assignee'} editType - 編輯欄位類型
   * @param {Object} [currentIssue={}] - 卡片目前資料物件
   */
  async function open(triggerEl, issueKey, editType, currentIssue = {}) {
    close();

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
      status: { icon: '⚡', label: '切換狀態' },
      points: { icon: '🔢', label: '修改 Story Points' },
      priority: { icon: '🎯', label: '修改優先順序' },
      assignee: { icon: '👤', label: '指派經辦人' }
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
      if (editType === 'status') {
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
              const targetCategory = matchedT ? (matchedT.to && matchedT.to.statusCategory && matchedT.to.statusCategory.key) || '' : '';

              btn.disabled = true;
              btn.textContent = '切換中...';

              const res = await JiraApiService.transitionIssue(issueKey, transitionId);
              if (res.success) {
                if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                  IssueStore.mergeAndCacheIssue({
                    key: issueKey,
                    statusName: targetName,
                    statusCategory: targetCategory
                  });
                }
                if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
                  LayoutManager.scheduleLayoutRefresh();
                }
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
              <span class="bjwt-popover-chip" data-pt="0">0</span>
              <span class="bjwt-popover-chip" data-pt="0.5">0.5</span>
              <span class="bjwt-popover-chip" data-pt="1">1</span>
              <span class="bjwt-popover-chip" data-pt="2">2</span>
              <span class="bjwt-popover-chip" data-pt="3">3</span>
              <span class="bjwt-popover-chip" data-pt="5">5</span>
              <span class="bjwt-popover-chip" data-pt="8">8</span>
              <span class="bjwt-popover-chip" data-pt="13">13</span>
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
            if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
              IssueStore.mergeAndCacheIssue({
                key: issueKey,
                storyPoints: newPts !== null && !isNaN(newPts) ? newPts : null
              });
            }
            if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
              LayoutManager.scheduleLayoutRefresh();
            }
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
                  priorityIcon: matchedP.iconUrl || ''
                });
              }
              if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
                LayoutManager.scheduleLayoutRefresh();
              }
              close();
            } else {
              btn.disabled = false;
              if (textSpan) textSpan.textContent = pName;
              alert(`優先度更新失敗：${res.error || '請重試'}`);
            }
          });
        });
      } else if (editType === 'assignee') {
        // --- 經辦人修改 ---
        const candidates = collectCandidateAssignees(currentIssue);
        const currentAssignee = currentIssue.isUnassigned ? '未指派' : (currentIssue.assigneeName || '未指派');

        function renderAssigneeList(filterKw = '') {
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
              <!-- 未指派選項 -->
              <button type="button" class="bjwt-popover-item bjwt-popover-item-assignee ${currentAssignee === '未指派' ? 'is-selected' : ''}" data-assignee-name="__UNASSIGNED__">
                <span class="bjwt-avatar-placeholder unassigned">?</span>
                <span class="bjwt-popover-item-text" style="font-weight: 600;">未指派</span>
                ${currentAssignee === '未指派' ? `<span class="bjwt-popover-check">✓</span>` : ''}
              </button>

              ${filtered
                .map((c) => {
                  const isSelected = currentAssignee === c.name;
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
                        <span class="bjwt-popover-item-text">直接指派為：「${escapeHtml(filterKw.trim())}」</span>
                      </div>
                    </button>
                  `
                  : ''
              }
            </div>
          `;
        }

        bodyEl.innerHTML = renderAssigneeList('');

        function bindAssigneeEvents() {
          const searchInput = bodyEl.querySelector('#bjwt-assignee-search-input');
          if (searchInput) {
            searchInput.focus();
            searchInput.addEventListener('input', (e) => {
              const kw = e.target.value;
              bodyEl.innerHTML = renderAssigneeList(kw);
              const newSearchInput = bodyEl.querySelector('#bjwt-assignee-search-input');
              if (newSearchInput) {
                newSearchInput.focus();
                newSearchInput.selectionStart = newSearchInput.selectionEnd = kw.length;
              }
              bindAssigneeEvents();
              positionPopover(popoverEl, triggerEl);
            });
          }

          bodyEl.querySelectorAll('.bjwt-popover-item-assignee').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              const targetName = btn.getAttribute('data-assignee-name');
              const isUnassign = !targetName || targetName === '__UNASSIGNED__';
              const matchedMember = candidates.find((c) => c.name === targetName);

              btn.disabled = true;
              const textSpan = btn.querySelector('.bjwt-popover-item-text');
              if (textSpan) textSpan.textContent = '指派中...';

              const res = await JiraApiService.updateIssueAssignee(issueKey, isUnassign ? null : targetName);
              if (res.success) {
                if (IssueStore && typeof IssueStore.mergeAndCacheIssue === 'function') {
                  IssueStore.mergeAndCacheIssue({
                    key: issueKey,
                    assigneeName: isUnassign ? '未指派' : targetName,
                    isUnassigned: isUnassign,
                    assigneeAvatar: matchedMember ? matchedMember.avatar : '',
                    assigneeInitials: matchedMember ? matchedMember.initials : (isUnassign ? '' : targetName.slice(0, 2).toUpperCase()),
                    assigneeEmail: matchedMember ? matchedMember.email : ''
                  });
                }
                if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
                  LayoutManager.scheduleLayoutRefresh();
                }
                close();
              } else {
                btn.disabled = false;
                if (textSpan) textSpan.textContent = isUnassign ? '未指派' : targetName;
                alert(`經辦人指派失敗：${res.error || '請重試'}`);
              }
            });
          });
        }

        bindAssigneeEvents();
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
    collectCandidateAssignees
  };
})();
