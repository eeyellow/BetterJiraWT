/**
 * @fileoverview 卡片右鍵上下文選單 (Card Context Menu) 元件
 * 提供在卡片上按滑鼠右鍵時彈出選單，支援快速複製「卡片編號」與「卡片標題」。
 * @module components/card-context-menu
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  const MENU_ID = 'bjwt-card-context-menu';
  const TOAST_ID = 'bjwt-copy-toast';
  let activeMenu = null;
  let activeCleanup = null;
  let toastTimer = null;

  /**
   * 複製文字至使用者剪貼簿
   *
   * @param {string} text - 欲複製之文字
   * @returns {Promise<boolean>} 是否成功
   */
  async function copyTextToClipboard(text) {
    if (!text) return false;
    const nav = (typeof window !== 'undefined' && window.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
    try {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(text);
        return true;
      }
    } catch {
      // ignore and try fallback
    }

    try {
      if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        return successful;
      }
    } catch {
      // ignore
    }
    return false;
  }

  /**
   * 顯示簡潔浮動 Toast 提示
   *
   * @param {string} message - 提示文字
   */
  function showToast(message) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return;

    let toast = doc.getElementById(TOAST_ID);
    if (!toast) {
      toast = doc.createElement('div');
      toast.id = TOAST_ID;
      toast.className = 'bjwt-copy-toast';
      doc.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add('is-visible');

    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
      if (toast && toast.parentNode) {
        toast.classList.remove('is-visible');
      }
    }, 1800);
  }

  /**
   * 關閉並清理當前右鍵選單
   */
  function close() {
    if (activeCleanup) {
      activeCleanup();
      activeCleanup = null;
    }
    if (activeMenu && activeMenu.parentNode) {
      activeMenu.parentNode.removeChild(activeMenu);
    }
    activeMenu = null;
  }

  /**
   * 智慧定位選單於滑鼠點擊位置，並防止超出可視區域
   *
   * @param {HTMLElement} menuEl - 選單 DOM 元素
   * @param {number} x - 滑鼠 clientX
   * @param {number} y - 滑鼠 clientY
   */
  function positionMenu(menuEl, x, y) {
    if (!menuEl) return;
    const winWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const winHeight = typeof window !== 'undefined' ? window.innerHeight : 768;

    menuEl.style.visibility = 'hidden';
    menuEl.style.display = 'block';

    const menuWidth = menuEl.offsetWidth || 190;
    const menuHeight = menuEl.offsetHeight || 120;

    let left = x + 2;
    let top = y + 2;

    if (left + menuWidth > winWidth - 10) {
      left = Math.max(10, x - menuWidth - 2);
    }
    if (top + menuHeight > winHeight - 10) {
      top = Math.max(10, y - menuHeight - 2);
    }

    menuEl.style.left = `${Math.round(left)}px`;
    menuEl.style.top = `${Math.round(top)}px`;
    menuEl.style.visibility = 'visible';
  }

  /**
   * 開啟卡片右鍵選單
   *
   * @param {number} clientX - 滑鼠水平座標
   * @param {number} clientY - 滑鼠垂直座標
   * @param {Object} issueData - 卡片資訊 { key, summary }
   */
  function open(clientX, clientY, issueData = {}) {
    close();

    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return;

    const key = String(issueData.key || '').trim();
    const summary = String(issueData.summary || '').trim();
    if (!key && !summary) return;

    const { TextUtils } = BetterJira;
    const escapeHtml = TextUtils && TextUtils.escapeHtml ? TextUtils.escapeHtml : (s) => String(s || '');

    const menuEl = doc.createElement('div');
    menuEl.id = MENU_ID;
    menuEl.className = 'bjwt-card-context-menu';
    menuEl.setAttribute('role', 'menu');

    menuEl.innerHTML = `
      <div class="bjwt-context-menu-header">
        <span class="bjwt-context-menu-badge">${escapeHtml(key)}</span>
      </div>
      <div class="bjwt-context-menu-list">
        <!-- 0. 在新分頁開啟 -->
        <button type="button" class="bjwt-context-menu-item" data-action="open-tab" role="menuitem">
          <svg class="bjwt-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
          <span class="bjwt-context-text">在新分頁開啟</span>
          <span class="bjwt-context-sub-icon">↗</span>
        </button>

        <div class="bjwt-context-divider"></div>

        <!-- 1. 移動卡片到其他 Sprint -->
        <button type="button" class="bjwt-context-menu-item" data-action="move-sprint" role="menuitem">
          <svg class="bjwt-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="bjwt-context-text">移動至其他 Sprint...</span>
        </button>

        <div class="bjwt-context-divider"></div>

        <!-- 2. 複製卡片編號 -->
        <button type="button" class="bjwt-context-menu-item" data-action="copy-key" role="menuitem">
          <svg class="bjwt-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span class="bjwt-context-text">複製卡片編號</span>
        </button>

        <!-- 3. 複製卡片標題 -->
        <button type="button" class="bjwt-context-menu-item" data-action="copy-summary" role="menuitem">
          <svg class="bjwt-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
            <polyline points="10 9 9 9 8 9"></polyline>
          </svg>
          <span class="bjwt-context-text">複製卡片標題</span>
        </button>

        <div class="bjwt-context-divider"></div>

        <!-- 4. 複製編號與標題 -->
        <button type="button" class="bjwt-context-menu-item" data-action="copy-both" role="menuitem">
          <svg class="bjwt-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
          </svg>
          <span class="bjwt-context-text">複製編號與標題</span>
        </button>
      </div>
    `;

    doc.body.appendChild(menuEl);
    activeMenu = menuEl;

    // 綁定項目點擊事件
    const openTabBtn = menuEl.querySelector('[data-action="open-tab"]');
    if (openTabBtn) {
      openTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openIssueInNewTab(key);
        close();
      });
    }

    const moveSprintBtn = menuEl.querySelector('[data-action="move-sprint"]');
    if (moveSprintBtn) {
      moveSprintBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        openMoveSprintModal(issueData);
      });
    }

    const copyKeyBtn = menuEl.querySelector('[data-action="copy-key"]');
    if (copyKeyBtn) {
      copyKeyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await copyTextToClipboard(key);
        showToast(`✓ 已複製卡片編號：${key}`);
        close();
      });
    }

    const copySummaryBtn = menuEl.querySelector('[data-action="copy-summary"]');
    if (copySummaryBtn) {
      copySummaryBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await copyTextToClipboard(summary);
        showToast('✓ 已複製卡片標題');
        close();
      });
    }

    const copyBothBtn = menuEl.querySelector('[data-action="copy-both"]');
    if (copyBothBtn) {
      copyBothBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const combined = `${key} ${summary}`.trim();
        await copyTextToClipboard(combined);
        showToast(`✓ 已複製編號與標題：${key}`);
        close();
      });
    }

    // 綁定外部關閉監聽器 (點擊外部、按 Esc、視窗滾動)
    const handleDocumentClick = (e) => {
      if (menuEl && !menuEl.contains(e.target)) {
        close();
      }
    };
    const handleDocumentKeydown = (e) => {
      if (e.key === 'Escape') {
        close();
      }
    };
    const handleWindowScroll = () => {
      close();
    };

    setTimeout(() => {
      doc.addEventListener('click', handleDocumentClick, true);
      doc.addEventListener('contextmenu', handleDocumentClick, true);
      doc.addEventListener('keydown', handleDocumentKeydown, true);
      if (typeof window !== 'undefined') {
        window.addEventListener('scroll', handleWindowScroll, true);
      }
    }, 10);

    activeCleanup = () => {
      doc.removeEventListener('click', handleDocumentClick, true);
      doc.removeEventListener('contextmenu', handleDocumentClick, true);
      doc.removeEventListener('keydown', handleDocumentKeydown, true);
      if (typeof window !== 'undefined') {
        window.removeEventListener('scroll', handleWindowScroll, true);
      }
    };

    positionMenu(menuEl, clientX, clientY);
  }

  /**
   * 在新分頁開啟指定卡片的 Jira 頁面
   *
   * @param {string} issueKey - 卡片編號
   * @returns {string|null} 開啟之 URL
   */
  function openIssueInNewTab(issueKey) {
    if (!issueKey) return null;
    const origin = typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : '';
    const url = `${origin}/browse/${encodeURIComponent(issueKey)}`;
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    return url;
  }

  const MOVE_MODAL_ID = 'bjwt-move-sprint-modal';

  /**
   * 取得可用於移動卡片的候選衝刺清單 (嚴格僅包含「進行中」與「未開始」，排除「已結束」歷史衝刺)
   *
   * @returns {Promise<Array<Object>>} 候選衝刺清單 [{ id, name, rawName, state, stateLabel }]
   */
  async function getCandidateMoveSprints() {
    const { IssueStore, JiraApiService, TextUtils } = BetterJira;
    const cleanTitle = (TextUtils && TextUtils.cleanSprintTitle) || ((s) => s || '');

    let list = [];
    // 1. 優先嘗試從 IssueStore 取得已快取的 boardSprints
    if (IssueStore && typeof IssueStore.getBoardSprints === 'function') {
      const cached = IssueStore.getBoardSprints();
      if (Array.isArray(cached) && cached.length > 0) {
        list = [...cached];
      }
    }

    // 2. 若為空，嘗試透過 boardId 呼叫 fetchActiveAndFutureSprintsForBoard
    if (list.length === 0 && JiraApiService && typeof JiraApiService.fetchActiveAndFutureSprintsForBoard === 'function') {
      let boardId = IssueStore && typeof IssueStore.getBoardId === 'function' ? IssueStore.getBoardId() : null;
      if (!boardId && typeof window !== 'undefined' && window.location) {
        const m = window.location.href.match(/\/boards\/(\d+)/i) || window.location.href.match(/[?&]rapidView=(\d+)/i);
        if (m && m[1]) boardId = m[1];
      }
      if (boardId) {
        try {
          const fetched = await JiraApiService.fetchActiveAndFutureSprintsForBoard(boardId);
          if (Array.isArray(fetched) && fetched.length > 0) {
            list = [...fetched];
          }
        } catch {
          // ignore
        }
      }
    }

    // 3. 補充檢查 DOM 上的未結束衝刺節點 (以防 API 尚未返回或離線快取)
    if (typeof document !== 'undefined') {
      const domBranches = Array.from(document.querySelectorAll('[data-bjwt-sprint-branch="true"]'));
      domBranches.forEach((branch) => {
        const sprintId =
          branch.getAttribute('data-sprint-id') ||
          (branch.parentElement && branch.parentElement.getAttribute('data-sprint-id')) ||
          '';
        const titleEl = branch.querySelector('.bjwt-history-banner-title, header h2, .ghx-name');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const badgeEl = branch.querySelector('.badge-active, .badge-future');
        const isFuture = badgeEl ? badgeEl.classList.contains('badge-future') : false;
        const state = isFuture ? 'future' : 'active';

        if (sprintId && !list.some((s) => String(s.id) === String(sprintId))) {
          list.push({
            id: sprintId,
            name: title || `Sprint ${sprintId}`,
            state
          });
        }
      });
    }

    // 4. 正規化清單：僅保留進行中 (active) 與未開始 (future)，排除已結束 (closed)
    const candidateSprints = list
      .filter((s) => s && s.id && (s.state === 'active' || s.state === 'future'))
      .map((s) => ({
        id: String(s.id),
        name: cleanTitle(s.name || ''),
        rawName: s.name || '',
        state: s.state === 'future' ? 'future' : 'active',
        stateLabel: s.state === 'future' ? '未開始' : '進行中'
      }));

    return candidateSprints;
  }

  /**
   * 顯示卡片成功移動衝刺之綠色浮動 Toast 提示
   *
   * @param {string} issueKey - 卡片編號
   * @param {string} sprintTitle - 目標衝刺標題
   */
  function showSprintMoveToast(issueKey, sprintTitle) {
    if (typeof document === 'undefined' || !document.body) return;
    const existing = (typeof document.querySelector === 'function')
      ? document.querySelector('.bjwt-sprint-create-toast')
      : null;
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'bjwt-sprint-create-toast';
    const cleanTitle = (BetterJira.TextUtils && typeof BetterJira.TextUtils.cleanSprintTitle === 'function')
      ? BetterJira.TextUtils.cleanSprintTitle(sprintTitle || '')
      : (sprintTitle || '');
    toast.innerHTML = `
      <span class="bjwt-toast-icon">✨</span>
      <span>卡片 <strong>${issueKey}</strong> 已成功移動至衝刺 <strong>「${cleanTitle}」</strong>！</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('bjwt-toast-fade-out');
      setTimeout(() => toast.remove(), 350);
    }, 4000);
  }

  /**
   * 開啟「移動卡片至其他 Sprint」選擇視窗
   *
   * @param {Object} issueData - 卡片資訊 { key, summary, sprintItem, sprintTitle, sprintId }
   */
  async function openMoveSprintModal(issueData = {}) {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.body) return;

    const existing = doc.getElementById(MOVE_MODAL_ID);
    if (existing) existing.remove();

    const key = String(issueData.key || '').trim();
    const summary = String(issueData.summary || '').trim();
    const { TextUtils, JiraApiService, IssueStore, LayoutManager, ActiveSprintView } = BetterJira;
    const escapeHtml = (TextUtils && TextUtils.escapeHtml) ? TextUtils.escapeHtml : ((s) => String(s || ''));
    const cleanSprintTitle = (TextUtils && TextUtils.cleanSprintTitle) || ((s) => s || '');

    let currentSprintId = issueData.sprintId ? String(issueData.sprintId) : '';
    if (!currentSprintId && issueData.sprintItem && JiraApiService && typeof JiraApiService.resolveSprintId === 'function') {
      try {
        currentSprintId = await JiraApiService.resolveSprintId(issueData.sprintItem);
      } catch {
        // ignore
      }
    }
    const currentSprintTitle = cleanSprintTitle(issueData.sprintTitle || '');

    const modalOverlay = doc.createElement('div');
    modalOverlay.id = MOVE_MODAL_ID;
    modalOverlay.setAttribute('id', MOVE_MODAL_ID);
    modalOverlay.className = 'bjwt-move-sprint-overlay';
    modalOverlay.innerHTML = `
      <div class="bjwt-move-sprint-dialog" role="dialog" aria-modal="true" aria-labelledby="bjwt-move-sprint-title">
        <div class="bjwt-move-sprint-header">
          <div class="bjwt-move-sprint-title-group">
            <svg class="bjwt-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
            <h3 id="bjwt-move-sprint-title">移動卡片至其他 Sprint</h3>
          </div>
          <button type="button" class="bjwt-move-sprint-close" title="關閉" aria-label="關閉">✕</button>
        </div>
        <div class="bjwt-move-sprint-body">
          <div class="bjwt-move-sprint-issue-preview">
            <span class="bjwt-move-sprint-badge">${escapeHtml(key)}</span>
            <span class="bjwt-move-sprint-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
          </div>
          ${
            currentSprintTitle
              ? `<div class="bjwt-move-sprint-current">目前所在衝刺：<strong>${escapeHtml(currentSprintTitle)}</strong></div>`
              : ''
          }
          <div class="bjwt-move-sprint-field">
            <label class="bjwt-move-sprint-label" for="bjwt-move-sprint-select">
              選擇目標 Sprint (進行中 / 未開始)：
            </label>
            <div class="bjwt-move-sprint-select-wrap">
              <select id="bjwt-move-sprint-select" class="bjwt-move-sprint-select" disabled>
                <option value="">正在載入可移動的 Sprint 清單...</option>
              </select>
            </div>
          </div>
          <div class="bjwt-move-sprint-status" aria-live="polite"></div>
        </div>
        <div class="bjwt-move-sprint-footer">
          <button type="button" class="bjwt-move-sprint-cancel-btn">取消</button>
          <button type="button" class="bjwt-move-sprint-submit-btn" disabled>儲存</button>
        </div>
      </div>
    `;

    doc.body.appendChild(modalOverlay);

    const closeBtn = modalOverlay.querySelector('.bjwt-move-sprint-close');
    const cancelBtn = modalOverlay.querySelector('.bjwt-move-sprint-cancel-btn');
    const submitBtn = modalOverlay.querySelector('.bjwt-move-sprint-submit-btn');
    const selectEl = modalOverlay.querySelector('#bjwt-move-sprint-select');
    const statusEl = modalOverlay.querySelector('.bjwt-move-sprint-status');

    function closeModal() {
      if (modalOverlay && modalOverlay.parentNode) {
        modalOverlay.parentNode.removeChild(modalOverlay);
      }
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });

    const handleKeydown = (e) => {
      if (e.key === 'Escape') {
        doc.removeEventListener('keydown', handleKeydown);
        closeModal();
      }
    };
    doc.addEventListener('keydown', handleKeydown);

    // 載入候選衝刺清單
    try {
      const candidates = await getCandidateMoveSprints();
      const activeSprints = candidates.filter((s) => s.state === 'active');
      const futureSprints = candidates.filter((s) => s.state === 'future');

      if (candidates.length === 0) {
        selectEl.innerHTML = '<option value="">沒有可移動的進行中或未開始 Sprint</option>';
        submitBtn.disabled = true;
        statusEl.textContent = '目前看板沒有進行中或未開始的 Sprint 可供移動。';
        statusEl.className = 'bjwt-move-sprint-status error';
      } else {
        let optHtml = '<option value="">-- 請選擇目標 Sprint --</option>';

        if (activeSprints.length > 0) {
          optHtml += '<optgroup label="進行中衝刺 (Active)">';
          activeSprints.forEach((s) => {
            const isCurrent = currentSprintId && String(s.id) === String(currentSprintId);
            optHtml += `<option value="${escapeHtml(s.id)}" data-sprint-name="${escapeHtml(s.name)}" ${isCurrent ? 'disabled' : ''}>${escapeHtml(s.name)} ${isCurrent ? '(目前)' : ''}</option>`;
          });
          optHtml += '</optgroup>';
        }

        if (futureSprints.length > 0) {
          optHtml += '<optgroup label="未開始衝刺 (Future)">';
          futureSprints.forEach((s) => {
            const isCurrent = currentSprintId && String(s.id) === String(currentSprintId);
            optHtml += `<option value="${escapeHtml(s.id)}" data-sprint-name="${escapeHtml(s.name)}" ${isCurrent ? 'disabled' : ''}>${escapeHtml(s.name)} ${isCurrent ? '(目前)' : ''}</option>`;
          });
          optHtml += '</optgroup>';
        }

        selectEl.innerHTML = optHtml;
        selectEl.disabled = false;

        selectEl.addEventListener('change', () => {
          const val = selectEl.value;
          const isCurrent = currentSprintId && String(val) === String(currentSprintId);
          submitBtn.disabled = !val || isCurrent;
          if (isCurrent) {
            statusEl.textContent = '此卡片已在該衝刺中，無需移動。';
            statusEl.className = 'bjwt-move-sprint-status error';
          } else {
            statusEl.textContent = '';
            statusEl.className = 'bjwt-move-sprint-status';
          }
        });
      }
    } catch (err) {
      selectEl.innerHTML = '<option value="">讀取衝刺失敗</option>';
      statusEl.textContent = '讀取衝刺清單失敗：' + (err && err.message ? err.message : String(err));
      statusEl.className = 'bjwt-move-sprint-status error';
    }

    // 儲存移動卡片
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const targetSprintId = selectEl.value;
        if (!targetSprintId) return;

        const selectedOption = selectEl.options[selectEl.selectedIndex];
        const targetSprintName = (selectedOption && selectedOption.getAttribute('data-sprint-name')) ||
          (selectedOption && selectedOption.textContent.replace(/\(目前\)/g, '').trim()) ||
          targetSprintId;

        submitBtn.disabled = true;
        submitBtn.textContent = '移動中...';
        selectEl.disabled = true;
        statusEl.textContent = `正在將卡片 ${key} 移動至衝刺「${targetSprintName}」...`;
        statusEl.className = 'bjwt-move-sprint-status loading';

        try {
          let moved = false;
          if (JiraApiService && typeof JiraApiService.moveIssuesToSprint === 'function') {
            moved = await JiraApiService.moveIssuesToSprint(targetSprintId, [key]);
          }

          if (moved) {
            // 1. 同步更新記憶體快取
            if (IssueStore && typeof IssueStore.moveIssueInSprintStore === 'function') {
              IssueStore.moveIssueInSprintStore(key, targetSprintId);
            }

            // 2. 關閉彈窗
            closeModal();

            // 3. 顯示綠色浮動 Toast
            showSprintMoveToast(key, targetSprintName);

            // 4. 重置自定義檢視渲染 Signature 並觸發畫面重繪
            if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
              document.querySelectorAll('.bjwt-active-sprint-custom-view').forEach((el) => {
                el.removeAttribute('data-bjwt-render-sig');
              });
            }

            if (issueData.sprintItem && ActiveSprintView && typeof ActiveSprintView.syncActiveSprintIssuesFromApi === 'function') {
              ActiveSprintView.syncActiveSprintIssuesFromApi(issueData.sprintItem, true).catch(() => {});
            }

            if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
              LayoutManager.scheduleLayoutRefresh();
            }
          } else {
            submitBtn.disabled = false;
            submitBtn.textContent = '儲存';
            selectEl.disabled = false;
            statusEl.textContent = '卡片移動失敗，請確認您具備此卡片的編輯與衝刺指派權限。';
            statusEl.className = 'bjwt-move-sprint-status error';
          }
        } catch (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = '儲存';
          selectEl.disabled = false;
          statusEl.textContent = '移動錯誤：' + (err && err.message ? err.message : String(err));
          statusEl.className = 'bjwt-move-sprint-status error';
        }
      });
    }
  }

  BetterJira.CardContextMenuComponent = {
    open,
    close,
    showToast,
    copyTextToClipboard,
    openIssueInNewTab,
    positionMenu,
    openMoveSprintModal,
    getCandidateMoveSprints,
    showSprintMoveToast
  };
})();
