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
      if (!e.target.closest('.bjwt-filter-dropdown')) {
        closeAllDropdowns();
      }
    });
  }

  function closeAllDropdowns() {
    if (typeof document === 'undefined') return;
    activeDropdownName = null;
    document.querySelectorAll('.bjwt-filter-dropdown-menu').forEach((menu) => {
      menu.classList.add('hidden');
    });
    document.querySelectorAll('.bjwt-filter-dropdown-btn').forEach((btn) => {
      btn.classList.remove('is-open');
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

    const isMeActive = state.selectedAssignees.includes('__ME__');
    const isUnassignedActive = state.selectedAssignees.includes('__UNASSIGNED__');

    // 計算特定選單已選取的數量
    const assigneeSelectedCount = state.selectedAssignees.filter((a) => a !== '__ME__').length;
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
            <!-- 👤 僅我的問題 -->
            <button
              type="button"
              class="bjwt-filter-chip bjwt-filter-chip-me ${isMeActive ? 'is-active' : ''}"
              title="只顯示指派給我的工作項目"
            >
              <span class="bjwt-chip-icon">👤</span>
              <span class="bjwt-chip-label">僅我的問題</span>
              ${
                options.myIssuesCount > 0
                  ? `<span class="bjwt-chip-badge">${options.myIssuesCount}</span>`
                  : ''
              }
            </button>

            <!-- 👥 經辦人下拉 -->
            <div class="bjwt-filter-dropdown" data-dropdown="assignee">
              <button
                type="button"
                class="bjwt-filter-chip bjwt-filter-dropdown-btn ${assigneeSelectedCount > 0 ? 'is-active' : ''} ${activeDropdownName === 'assignee' ? 'is-open' : ''}"
                title="依經辦人多選篩選"
              >
                <span class="bjwt-chip-icon">👥</span>
                <span class="bjwt-chip-label">經辦人${assigneeSelectedCount > 0 ? ` (${assigneeSelectedCount})` : ''}</span>
                <span class="bjwt-chip-arrow">▾</span>
              </button>
              <div class="bjwt-filter-dropdown-menu ${activeDropdownName === 'assignee' ? '' : 'hidden'}">
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
                    <span class="bjwt-avatar-placeholder unassigned">?</span>
                    <span class="bjwt-dropdown-item-name">未指派</span>
                    <span class="bjwt-dropdown-item-count">${options.unassignedCount}</span>
                  </label>

                  <!-- 各成員列表 -->
                  ${options.assignees
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
                          ${
                            a.avatar
                              ? `<img class="bjwt-dropdown-avatar" src="${escapeHtml(a.avatar)}" alt="${escapeHtml(a.name)}" />`
                              : `<span class="bjwt-avatar-placeholder">${escapeHtml(a.initials || a.name.slice(0, 2).toUpperCase())}</span>`
                          }
                          <span class="bjwt-dropdown-item-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
                          <span class="bjwt-dropdown-item-count">${a.count}</span>
                        </label>
                      `;
                    })
                    .join('')}
                </div>
              </div>
            </div>

            <!-- 🏷️ 狀態下拉 -->
            <div class="bjwt-filter-dropdown" data-dropdown="status">
              <button
                type="button"
                class="bjwt-filter-chip bjwt-filter-dropdown-btn ${statusSelectedCount > 0 ? 'is-active' : ''} ${activeDropdownName === 'status' ? 'is-open' : ''}"
                title="依狀態多選篩選"
              >
                <span class="bjwt-chip-icon">🏷️</span>
                <span class="bjwt-chip-label">狀態${statusSelectedCount > 0 ? ` (${statusSelectedCount})` : ''}</span>
                <span class="bjwt-chip-arrow">▾</span>
              </button>
              <div class="bjwt-filter-dropdown-menu ${activeDropdownName === 'status' ? '' : 'hidden'}">
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
                          <span class="bjwt-dropdown-item-count">${st.count}</span>
                        </label>
                      `;
                    })
                    .join('')}
                </div>
              </div>
            </div>

            <!-- 📌 類型下拉 -->
            <div class="bjwt-filter-dropdown" data-dropdown="type">
              <button
                type="button"
                class="bjwt-filter-chip bjwt-filter-dropdown-btn ${typeSelectedCount > 0 ? 'is-active' : ''} ${activeDropdownName === 'type' ? 'is-open' : ''}"
                title="依問題類型多選篩選"
              >
                <span class="bjwt-chip-icon">📌</span>
                <span class="bjwt-chip-label">類型${typeSelectedCount > 0 ? ` (${typeSelectedCount})` : ''}</span>
                <span class="bjwt-chip-arrow">▾</span>
              </button>
              <div class="bjwt-filter-dropdown-menu ${activeDropdownName === 'type' ? '' : 'hidden'}">
                <div class="bjwt-dropdown-header">篩選類型</div>
                <div class="bjwt-dropdown-list">
                  ${options.types
                    .map((tp) => {
                      const checked = state.selectedTypes.includes(tp.name);
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
                              ? `<img class="bjwt-type-icon" src="${escapeHtml(tp.icon)}" alt="${escapeHtml(tp.name)}" style="width: 14px; height: 14px;" />`
                              : '<span class="bjwt-type-icon-fallback">📄</span>'
                          }
                          <span class="bjwt-dropdown-item-name">${escapeHtml(tp.name)}</span>
                          <span class="bjwt-dropdown-item-count">${tp.count}</span>
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

        <!-- 3. 結果數量提示 -->
        <div class="bjwt-filter-stats-bar ${isFiltered ? 'is-filtered' : ''}">
          ${
            isFiltered
              ? `篩選顯示 <strong>${visibleCount}</strong> / 全部 ${totalCount} 張卡片`
              : `共 <strong>${totalCount}</strong> 張卡片`
          }
        </div>
      </div>
    `;
  }

  /**
   * 為容器綁定工具列的所有互動事件 (包含輸入、勾選、清除、下拉開關)
   *
   * @param {Element} container - 包含工具列的 DOM 容器節點
   * @param {Function} onFilterChanged - 當篩選變更時的回呼
   */
  function bindToolbarEvents(container, onFilterChanged) {
    if (!container) return;
    const { FrontendFilterService } = BetterJira;

    // 1. 搜尋輸入框事件 (輸入即時過濾)
    const searchInput = container.querySelector('.bjwt-filter-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        const cursorPos = e.target.selectionStart;
        FrontendFilterService.setKeyword(val);
        if (onFilterChanged) onFilterChanged();

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
          if (onFilterChanged) onFilterChanged();
        }
      });
    }

    // 清空關鍵字按鈕
    const clearKwBtn = container.querySelector('.bjwt-filter-clear-kw-btn');
    if (clearKwBtn) {
      clearKwBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        FrontendFilterService.setKeyword('');
        if (onFilterChanged) onFilterChanged();
      });
    }

    // 2. 「僅我的問題」按鈕
    const meBtn = container.querySelector('.bjwt-filter-chip-me');
    if (meBtn) {
      meBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        FrontendFilterService.toggleAssignee('__ME__');
        if (onFilterChanged) onFilterChanged();
      });
    }

    // 3. 下拉選單開關按鈕
    container.querySelectorAll('.bjwt-filter-dropdown').forEach((dropdownEl) => {
      const btn = dropdownEl.querySelector('.bjwt-filter-dropdown-btn');
      const menu = dropdownEl.querySelector('.bjwt-filter-dropdown-menu');
      const dropdownType = dropdownEl.getAttribute('data-dropdown');

      if (btn && menu) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isCurrentlyOpen = !menu.classList.contains('hidden');
          closeAllDropdowns();
          if (!isCurrentlyOpen) {
            menu.classList.remove('hidden');
            btn.classList.add('is-open');
            activeDropdownName = dropdownType;
          }
        });
      }
    });

    // 4. 下拉選單勾選方塊事件
    container.querySelectorAll('.bjwt-filter-cb').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const type = cb.getAttribute('data-filter-type');
        const val = cb.value;

        if (type === 'assignee') {
          FrontendFilterService.toggleAssignee(val);
        } else if (type === 'status') {
          FrontendFilterService.toggleStatus(val);
        } else if (type === 'type') {
          FrontendFilterService.toggleType(val);
        }

        if (onFilterChanged) onFilterChanged();
      });
    });

    // 5. 清除所有篩選按鈕
    const resetBtn = container.querySelector('.bjwt-filter-chip-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns();
        FrontendFilterService.clearAll();
        if (onFilterChanged) onFilterChanged();
      });
    }
  }

  BetterJira.FilterToolbarComponent = {
    renderToolbarHtml,
    bindToolbarEvents,
    closeAllDropdowns
  };
})();
