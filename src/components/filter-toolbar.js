/**
 * @fileoverview 純前端篩選工具列元件 (Filter Toolbar Component)
 * 渲染於衝刺檢視頂部，提供關鍵字搜尋、經辦人/狀態/類型下拉多選、僅我的卡片與一鍵重設。
 * @module components/filter-toolbar
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  let activeDropdownName = null;

  // 監聽點擊視窗外部關閉下拉選單
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || typeof target.closest !== 'function') {
        closeAllDropdowns();
        return;
      }
      if (!target.closest('.bjwt-filter-dropdown')) {
        closeAllDropdowns();
      }
    });
  }

  /**
   * 強制設定下拉選單 DOM 元素的顯示狀態
   * 同時使用 style.setProperty(..., 'important') 與 style.display，
   * 徹底解決瀏覽器 CSSOM 規範中普通 style.display 無法覆蓋 inline !important 的死鎖問題
   *
   * @param {HTMLElement} menu - 下拉選單元素
   * @param {boolean} isVisible - 是否顯示
   */
  function setMenuDisplay(menu, isVisible) {
    if (!menu) return;
    if (isVisible) {
      menu.classList.remove('hidden');
      if (menu.style) {
        menu.style.display = 'flex';
        if (typeof menu.style.setProperty === 'function') {
          menu.style.setProperty('display', 'flex', 'important');
        }
      }
    } else {
      menu.classList.add('hidden');
      if (menu.style) {
        menu.style.display = 'none';
        if (typeof menu.style.setProperty === 'function') {
          menu.style.setProperty('display', 'none', 'important');
        }
      }
    }
  }

  function closeAllDropdowns(scopeRoot) {
    activeDropdownName = null;
    const roots = [];
    if (scopeRoot && typeof scopeRoot.querySelectorAll === 'function') roots.push(scopeRoot);
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') roots.push(document);

    roots.forEach((root) => {
      root.querySelectorAll('.bjwt-filter-dropdown').forEach((dropdownEl) => {
        dropdownEl.classList.remove('is-open');
      });
      root.querySelectorAll('.bjwt-filter-dropdown-menu').forEach((menu) => {
        setMenuDisplay(menu, false);
      });
      root.querySelectorAll('.bjwt-filter-dropdown-btn').forEach((btn) => {
        btn.classList.remove('is-open');
      });
    });
  }

  /**
   * 渲染篩選工具列 HTML 結構
   *
   * @param {Object[]} allIssues - 衝刺中所有未篩選的卡片
   * @param {Object[]} filteredIssues - 篩選後目前可見的卡片
   * @param {string} [scopeId=''] - 衝刺分支專屬識別碼
   * @returns {string} 工具列 HTML
   */
  function renderToolbarHtml(allIssues, filteredIssues, scopeId = '') {
    const { FrontendFilterService, TextUtils } = BetterJira;
    const escapeHtml = TextUtils ? TextUtils.escapeHtml : (s) => String(s || '');

    const state = FrontendFilterService.getState();
    const options = FrontendFilterService.extractFilterOptions(allIssues);

    const isUnassignedActive = state.selectedAssignees.includes('__UNASSIGNED__');

    // 計算特定選單已選取的數量
    const assigneeSelectedCount = state.selectedAssignees.length;
    const statusSelectedCount = state.selectedStatuses.length;
    const typeSelectedCount = state.selectedTypes.length;

    const totalCount = allIssues.length;
    const visibleCount = filteredIssues.length;
    const isFiltered = state.isActive;

    return `
      <div class="bjwt-filter-toolbar" data-bjwt-scope="${escapeHtml(scopeId)}">
        <div class="bjwt-filter-toolbar-main">
          <!-- 1. 搜尋輸入框 -->
          <div class="bjwt-filter-search-box">
            <svg class="bjwt-filter-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              class="bjwt-filter-search-input"
              placeholder="搜尋卡片 (Key、標題、負責人、狀態)..."
              value="${escapeHtml(state.keyword)}"
              autocomplete="off"
              spellcheck="false"
            />
            ${
              state.keyword
                ? `<button type="button" class="bjwt-filter-clear-kw-btn" title="清除關鍵字">✕</button>`
                : ''
            }
          </div>

          <!-- 2. 快捷按鈕與下拉選單組 -->
          <div class="bjwt-filter-chips-group">
            <!-- 👥 經辦人下拉 -->
            <div class="bjwt-filter-dropdown ${activeDropdownName === 'assignee' ? 'is-open' : ''}" data-dropdown="assignee">
              <button
                type="button"
                class="bjwt-filter-chip bjwt-filter-dropdown-btn ${assigneeSelectedCount > 0 ? 'is-active' : ''} ${activeDropdownName === 'assignee' ? 'is-open' : ''}"
                title="依經辦人多選篩選"
              >
                <span class="bjwt-chip-icon">👥</span>
                <span class="bjwt-chip-label">經辦人${assigneeSelectedCount > 0 ? ` (${assigneeSelectedCount})` : ''}</span>
                <span class="bjwt-chip-arrow">▾</span>
              </button>
              <div class="bjwt-filter-dropdown-menu ${activeDropdownName === 'assignee' ? '' : 'hidden'}" style="${activeDropdownName === 'assignee' ? 'display: flex !important;' : 'display: none !important;'}">
                <div class="bjwt-dropdown-header">篩選經辦人</div>
                <div class="bjwt-dropdown-list">
                  <!-- 未指派選項 -->
                  <label class="bjwt-dropdown-item">
                    <input
                      type="checkbox"
                      class="bjwt-filter-cb"
                      data-filter-type="assignee"
                      value="__UNASSIGNED__"
                      ${isUnassignedActive ? 'checked' : ''}
                    />
                    <span class="bjwt-dropdown-item-name">未指派</span>
                  </label>

                  <!-- 各成員列表 -->
                  ${
                    options.assignees.length > 0
                      ? options.assignees
                          .map((a) => {
                            const checked = state.selectedAssignees.includes(a.name);
                            return `
                              <label class="bjwt-dropdown-item">
                                <input
                                  type="checkbox"
                                  class="bjwt-filter-cb"
                                  data-filter-type="assignee"
                                  value="${escapeHtml(a.name)}"
                                  ${checked ? 'checked' : ''}
                                />
                                <div class="bjwt-dropdown-item-info" style="display:flex; flex-direction:column; overflow:hidden; min-width:0; flex:1;">
                                  <span class="bjwt-dropdown-item-name" title="${escapeHtml(a.email ? `${a.name} (${a.email})` : a.name)}">${escapeHtml(a.name)}</span>
                                  ${a.email ? `<small class="bjwt-dropdown-item-email" style="font-size:10px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(a.email)}</small>` : ''}
                                </div>
                              </label>
                            `;
                          })
                          .join('')
                      : `<div class="bjwt-dropdown-empty-hint" style="padding: 8px 12px; font-size: 11px; color: #888; text-align: center;">尚未於設定中新增人員名單</div>`
                  }
                </div>
              </div>
            </div>

            <!-- 🏷️ 狀態下拉 -->
            <div class="bjwt-filter-dropdown ${activeDropdownName === 'status' ? 'is-open' : ''}" data-dropdown="status">
              <button
                type="button"
                class="bjwt-filter-chip bjwt-filter-dropdown-btn ${statusSelectedCount > 0 ? 'is-active' : ''} ${activeDropdownName === 'status' ? 'is-open' : ''}"
                title="依狀態多選篩選"
              >
                <span class="bjwt-chip-icon">🏷️</span>
                <span class="bjwt-chip-label">狀態${statusSelectedCount > 0 ? ` (${statusSelectedCount})` : ''}</span>
                <span class="bjwt-chip-arrow">▾</span>
              </button>
              <div class="bjwt-filter-dropdown-menu ${activeDropdownName === 'status' ? '' : 'hidden'}" style="${activeDropdownName === 'status' ? 'display: flex !important;' : 'display: none !important;'}">
                <div class="bjwt-dropdown-header">篩選狀態</div>
                <div class="bjwt-dropdown-list">
                  ${options.statuses
                    .map((st) => {
                      const checked = state.selectedStatuses.includes(st.name);
                      return `
                        <label class="bjwt-dropdown-item">
                          <input
                            type="checkbox"
                            class="bjwt-filter-cb"
                            data-filter-type="status"
                            value="${escapeHtml(st.name)}"
                            ${checked ? 'checked' : ''}
                          />
                          <span class="bjwt-status-dot bjwt-status-${escapeHtml(st.category || 'new')}"></span>
                          <span class="bjwt-dropdown-item-name">${escapeHtml(st.name)}</span>
                        </label>
                      `;
                    })
                    .join('')}
                </div>
              </div>
            </div>

            <!-- 📌 類型下拉 -->
            <div class="bjwt-filter-dropdown ${activeDropdownName === 'type' ? 'is-open' : ''}" data-dropdown="type">
              <button
                type="button"
                class="bjwt-filter-chip bjwt-filter-dropdown-btn ${typeSelectedCount > 0 ? 'is-active' : ''} ${activeDropdownName === 'type' ? 'is-open' : ''}"
                title="依問題類型多選篩選"
              >
                <span class="bjwt-chip-icon">📌</span>
                <span class="bjwt-chip-label">類型${typeSelectedCount > 0 ? ` (${typeSelectedCount})` : ''}</span>
                <span class="bjwt-chip-arrow">▾</span>
              </button>
              <div class="bjwt-filter-dropdown-menu ${activeDropdownName === 'type' ? '' : 'hidden'}" style="${activeDropdownName === 'type' ? 'display: flex !important;' : 'display: none !important;'}">
                <div class="bjwt-dropdown-header">篩選類型</div>
                <div class="bjwt-dropdown-list">
                  ${options.types
                    .map((tp) => {
                      const checked = state.selectedTypes.includes(tp.name);
                      const typeLabelMap = {
                        'Story': 'Story (故事)',
                        'Bug': 'Bug (缺陷 / 錯誤)',
                        'Task': 'Task (任務)',
                        'Sub-task': 'Sub-task (子任務)',
                        'Epic': 'Epic (史詩)'
                      };
                      const displayName = typeLabelMap[tp.name] || tp.name;
                      const fallbackIconMap = {
                        'Story': '📗',
                        'Bug': '🐞',
                        'Task': '📋',
                        'Sub-task': '🔹',
                        'Epic': '⚡'
                      };
                      const fallbackIcon = fallbackIconMap[tp.name] || '📄';
                      return `
                        <label class="bjwt-dropdown-item">
                          <input
                            type="checkbox"
                            class="bjwt-filter-cb"
                            data-filter-type="type"
                            value="${escapeHtml(tp.name)}"
                            ${checked ? 'checked' : ''}
                          />
                          ${
                            tp.icon
                              ? `<img class="bjwt-type-icon" src="${escapeHtml(tp.icon)}" alt="${escapeHtml(tp.name)}" style="width: 14px; height: 14px; object-fit: contain;" />`
                              : `<span class="bjwt-type-icon-fallback" style="font-size: 13px;">${fallbackIcon}</span>`
                          }
                          <span class="bjwt-dropdown-item-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
                        </label>
                      `;
                    })
                    .join('')}
                </div>
              </div>
            </div>

            <!-- 清除所有篩選按鈕 (有啟用時顯示) -->
            ${
              isFiltered
                ? `
                  <button type="button" class="bjwt-filter-chip bjwt-filter-chip-reset" title="重設所有篩選條件">
                    ✕ 清除篩選 (${state.activeCount})
                  </button>
                `
                : ''
            }
          </div>
        </div>

        <!-- 3. 結果數量提示 (僅篩選啟用時顯示) -->
        ${
          isFiltered
            ? `
              <div class="bjwt-filter-stats-bar is-filtered">
                ${
                  scopeId === 'global'
                    ? `跨衝刺篩選顯示 <strong>${visibleCount}</strong> 個工作項目`
                    : `篩選顯示 <strong>${visibleCount}</strong> 張卡片`
                }
              </div>
            `
            : ''
        }
      </div>
    `;
  }

  /**
   * 為容器綁定工具列的所有互動事件 (包含輸入、勾選、清除、下拉開關)
   * 採用容器層級事件委派 (Event Delegation) 確保動態重繪與點擊穿透問題完美解決
   *
   * @param {Element} container - 包含工具列的 DOM 容器節點
   * @param {Function} onFilterChanged - 當篩選變更時的回呼
   */
  function bindToolbarEvents(container, onFilterChanged) {
    if (!container || typeof container.addEventListener !== 'function') return;
    const { FrontendFilterService } = BetterJira;

    // 始終更新最新的回呼函式參考
    container._bjwtOnFilterChanged = onFilterChanged;
    const triggerFilterChanged = () => {
      if (typeof container._bjwtOnFilterChanged === 'function') {
        container._bjwtOnFilterChanged();
      }
    };

    // 1. 搜尋輸入框事件 (每次重繪 innerHTML 後為新 input 節點，透過 _bjwtInputBound 避免重複綁定)
    const searchInput = container.querySelector('.bjwt-filter-search-input');
    if (searchInput && typeof searchInput.addEventListener === 'function' && !searchInput._bjwtInputBound) {
      searchInput._bjwtInputBound = true;
      searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        const cursorPos = e.target.selectionStart;
        FrontendFilterService.setKeyword(val);
        triggerFilterChanged();

        // 重新渲染後恢復游標與焦點
        const nextInput = container.querySelector('.bjwt-filter-search-input');
        if (nextInput) {
          nextInput.focus();
          try {
            nextInput.setSelectionRange(cursorPos, cursorPos);
          } catch {
            // ignore
          }
        }
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          FrontendFilterService.setKeyword('');
          triggerFilterChanged();
        }
      });
    }

    // 2. 容器層級事件委派 (Click / Change Event Delegation)
    // 嚴格確保同一個持久容器 (例如 globalToolbar) 終生只註冊唯一一次監聽器，
    // 徹底杜絕多次重繪後累積偶數個 click 監聽器導致「點一下觸發兩次 Toggle 而瞬間關閉」的根因！
    if (container._bjwtDelegatedEventsBound) {
      return;
    }
    container._bjwtDelegatedEventsBound = true;

    container.addEventListener('click', (e) => {
      // (a) 清除關鍵字按鈕
      const clearKwBtn = e.target.closest('.bjwt-filter-clear-kw-btn');
      if (clearKwBtn) {
        e.stopPropagation();
        FrontendFilterService.setKeyword('');
        triggerFilterChanged();
        return;
      }

      // (b) 重設所有篩選按鈕
      const resetBtn = e.target.closest('.bjwt-filter-chip-reset');
      if (resetBtn) {
        e.stopPropagation();
        closeAllDropdowns();
        FrontendFilterService.clearAll();
        triggerFilterChanged();
        return;
      }

      // (c) 下拉選單開關按鈕 (點擊開關或切換)
      const btn = e.target.closest('.bjwt-filter-dropdown-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const dropdownEl = btn.closest('.bjwt-filter-dropdown');
        const dropdownType = dropdownEl ? dropdownEl.getAttribute('data-dropdown') : null;
        const menu = dropdownEl ? dropdownEl.querySelector('.bjwt-filter-dropdown-menu') : null;

        const isCurrentlyOpen = activeDropdownName === dropdownType;
        closeAllDropdowns(container);

        if (!isCurrentlyOpen && dropdownType && menu) {
          activeDropdownName = dropdownType;
          if (dropdownEl) dropdownEl.classList.add('is-open');
          btn.classList.add('is-open');
          setMenuDisplay(menu, true);
        } else if (isCurrentlyOpen && menu) {
          if (dropdownEl) dropdownEl.classList.remove('is-open');
          btn.classList.remove('is-open');
          setMenuDisplay(menu, false);
        }
        return;
      }

      // (d) 下拉選單清單項目點擊 (Label 或內部元素)
      const item = e.target.closest('.bjwt-dropdown-item');
      if (item) {
        e.stopPropagation();
        const cb = item.querySelector('.bjwt-filter-cb');
        if (cb) {
          // 若點擊目標非 checkbox 本身 (點在文字、頭像或計數上)，主動切換 checked 狀態
          if (e.target !== cb) {
            cb.checked = !cb.checked;
          }
          const filterType = cb.getAttribute('data-filter-type');
          const val = cb.value;

          if (filterType === 'assignee') {
            FrontendFilterService.toggleAssignee(val);
          } else if (filterType === 'status') {
            FrontendFilterService.toggleStatus(val);
          } else if (filterType === 'type') {
            FrontendFilterService.toggleType(val);
          }

          triggerFilterChanged();
        }
        return;
      }

      // (e) 點擊選單內部其他區塊 (例如 header、空白邊距等)，阻止冒泡以防止外部 click 關閉選單
      if (e.target.closest('.bjwt-filter-dropdown-menu')) {
        e.stopPropagation();
        return;
      }
    });

    // 3. 下拉選單核取方塊 change 事件備援 (支援鍵盤 Space 鍵切換，並防護重複觸發)
    container.addEventListener('change', (e) => {
      const cb = e.target.closest('.bjwt-filter-cb');
      if (!cb) return;
      e.stopPropagation();
      const filterType = cb.getAttribute('data-filter-type');
      const val = cb.value;

      const state = FrontendFilterService.getState();
      const isCurrentlyActive =
        (filterType === 'assignee' && state.selectedAssignees.includes(val)) ||
        (filterType === 'status' && state.selectedStatuses.includes(val)) ||
        (filterType === 'type' && state.selectedTypes.includes(val));

      if (cb.checked !== isCurrentlyActive) {
        if (filterType === 'assignee') {
          FrontendFilterService.toggleAssignee(val);
        } else if (filterType === 'status') {
          FrontendFilterService.toggleStatus(val);
        } else if (filterType === 'type') {
          FrontendFilterService.toggleType(val);
        }
        triggerFilterChanged();
      }
    });
  }

  BetterJira.FilterToolbarComponent = {
    renderToolbarHtml,
    bindToolbarEvents,
    closeAllDropdowns,
    getActiveDropdownName: () => activeDropdownName,
    setActiveDropdownName: (name) => { activeDropdownName = name; }
  };
})();
