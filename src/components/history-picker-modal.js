/**
 * @fileoverview 歷史 Sprint 選擇視窗 (History Sprint Picker Modal) 元件
 * 提供查詢看板已結束 Sprint、關鍵字即時篩選建議清單、點選加入左右兩欄之對話框介面。
 * @module components/history-picker-modal
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 開啟「載入歷史 Sprint」對話框：支援直接輸入 Sprint 名稱查詢，並自動列出最近已結束的 Sprint 供點選
   */
  function openHistorySprintPickerModal() {
    const { Constants, TextUtils, JiraApiService, IssueStore, RuntimeStyles, LayoutManager } = BetterJira;
    const { HISTORY_PICKER_MODAL_ID } = Constants;
    const { escapeHtml, formatShortDate } = TextUtils;
    const { fetchClosedSprintsForBoard, fetchHistoricalSprintData } = JiraApiService;
    const { appendHistoricalSprintToState, loadedHistoricalSprints } = IssueStore;

    RuntimeStyles.ensureRuntimeCriticalStyles();
    const existing = document.getElementById(HISTORY_PICKER_MODAL_ID);
    if (existing) {
      existing.remove();
    }

    const modalOverlay = document.createElement('div');
    modalOverlay.id = HISTORY_PICKER_MODAL_ID;
    modalOverlay.className = 'bjwt-history-picker-overlay';
    modalOverlay.innerHTML = `
      <div class="bjwt-history-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="bjwt-history-picker-title">
        <div class="bjwt-history-picker-header">
          <div class="bjwt-history-picker-title-group">
            <svg class="bjwt-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <polyline points="12 7 12 12 15 15"></polyline>
            </svg>
            <h3 id="bjwt-history-picker-title">載入已結束的歷史 Sprint</h3>
          </div>
          <button type="button" class="bjwt-history-picker-close" title="關閉" aria-label="關閉">✕</button>
        </div>
        <div class="bjwt-history-picker-body">
          <label class="bjwt-history-picker-label" for="bjwt-history-sprint-input">
            輸入已結束的 Sprint 名稱（可透過 API 抓取卡片並 Append 至左右兩欄）：
          </label>
          <div class="bjwt-history-picker-input-row">
            <input
              id="bjwt-history-sprint-input"
              type="text"
              class="bjwt-history-picker-input"
              placeholder="例如：Sprint 24 或輸入關鍵字篩選下方清單..."
              autocomplete="off"
            />
            <button type="button" class="bjwt-history-picker-submit">查詢並加入</button>
          </div>
          <div class="bjwt-history-picker-status" aria-live="polite"></div>
          <div class="bjwt-history-suggestions-wrap">
            <div class="bjwt-history-suggestions-title">看板最近已結束的 Sprint（點擊可直接載入）：</div>
            <div class="bjwt-history-suggestions-list">
              <div class="bjwt-history-suggestions-loading">正在從 Jira API 讀取已結束的 Sprint 清單...</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modalOverlay);

    const inputEl = modalOverlay.querySelector('#bjwt-history-sprint-input');
    const submitBtn = modalOverlay.querySelector('.bjwt-history-picker-submit');
    const closeBtn = modalOverlay.querySelector('.bjwt-history-picker-close');
    const statusEl = modalOverlay.querySelector('.bjwt-history-picker-status');
    const suggestionsListEl = modalOverlay.querySelector('.bjwt-history-suggestions-list');

    function closePicker() {
      modalOverlay.remove();
    }

    closeBtn.addEventListener('click', closePicker);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closePicker();
    });

    async function handleLoadSprint(nameStr, explicitSprint = null) {
      const targetName = (explicitSprint && explicitSprint.name) || (nameStr || '').trim();
      if (!targetName) {
        statusEl.textContent = '請先輸入或選擇一個已結束的 Sprint 名稱';
        statusEl.className = 'bjwt-history-picker-status error';
        inputEl.focus();
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '載入中...';
      statusEl.textContent = `正在透過 Jira API 載入「${targetName}」的卡片資料...`;
      statusEl.className = 'bjwt-history-picker-status loading';

      try {
        const sprintData = await fetchHistoricalSprintData(targetName, explicitSprint);
        appendHistoricalSprintToState(sprintData);
        if (LayoutManager) {
          LayoutManager.setActiveSprintKey(sprintData.key);
          LayoutManager.applyTwoColumnBacklogLayout();
        }
        closePicker();
      } catch (err) {
        statusEl.textContent = err && err.message ? err.message : '載入失敗，請確認 Sprint 名稱是否正確';
        statusEl.className = 'bjwt-history-picker-status error';
        submitBtn.disabled = false;
        submitBtn.textContent = '查詢並加入';
      }
    }

    submitBtn.addEventListener('click', () => {
      handleLoadSprint(inputEl.value);
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleLoadSprint(inputEl.value);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        closePicker();
      }
    });

    let allClosedSprints = [];

    function renderSuggestions(filterText = '') {
      const kw = (filterText || '').trim().toLowerCase();
      const filtered = kw
        ? allClosedSprints.filter((s) => (s.name || '').toLowerCase().includes(kw))
        : allClosedSprints;

      if (filtered.length === 0) {
        suggestionsListEl.innerHTML = `
          <div class="bjwt-history-suggestions-empty">
            ${
              allClosedSprints.length === 0
                ? '未能自動列出看板歷史清單，請直接在上方輸入框輸入 Sprint 名稱並點擊「查詢並加入」。'
                : '沒有符合關鍵字的已結束 Sprint，您仍可直接點擊「查詢並加入」以 JQL 搜尋。'
            }
          </div>
        `;
        return;
      }

      suggestionsListEl.innerHTML = '';
      filtered.slice(0, 30).forEach((sp) => {
        const alreadyLoaded = loadedHistoricalSprints.some(
          (h) => String(h.sprintId) === String(sp.id) || h.title === sp.name
        );
        const dateRange = [formatShortDate(sp.startDate), formatShortDate(sp.completeDate || sp.endDate)]
          .filter(Boolean)
          .join(' ~ ');

        const row = document.createElement('button');
        row.type = 'button';
        row.className = `bjwt-history-suggestion-item ${alreadyLoaded ? 'loaded' : ''}`;
        row.innerHTML = `
          <div class="bjwt-history-suggestion-info">
            <span class="bjwt-history-suggestion-name">${escapeHtml(sp.name || `Sprint ${sp.id}`)}</span>
            ${dateRange ? `<span class="bjwt-history-suggestion-date">${escapeHtml(dateRange)}</span>` : ''}
          </div>
          <span class="bjwt-history-suggestion-action">${alreadyLoaded ? '重新載入' : '＋ 加入'}</span>
        `;
        row.addEventListener('click', () => {
          inputEl.value = sp.name || '';
          handleLoadSprint(sp.name, sp);
        });
        suggestionsListEl.appendChild(row);
      });
    }

    inputEl.addEventListener('input', () => {
      renderSuggestions(inputEl.value);
    });

    inputEl.focus();

    fetchClosedSprintsForBoard().then((list) => {
      allClosedSprints = list;
      renderSuggestions(inputEl.value);
    });
  }

  BetterJira.HistoryPickerModalComponent = {
    openHistorySprintPickerModal
  };
})();
