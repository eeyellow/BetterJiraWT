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
        <!-- 1. 複製卡片編號 -->
        <button type="button" class="bjwt-context-menu-item" data-action="copy-key" role="menuitem">
          <svg class="bjwt-context-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span class="bjwt-context-text">複製卡片編號</span>
        </button>

        <!-- 2. 複製卡片標題 -->
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

        <!-- 3. 複製編號與標題 -->
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

  BetterJira.CardContextMenuComponent = {
    open,
    close,
    showToast,
    copyTextToClipboard,
    positionMenu
  };
})();
