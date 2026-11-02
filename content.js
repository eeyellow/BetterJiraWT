/**
 * @fileoverview BetterJiraWT Content Script 主進入點與事件協調器
 * 1. 偵測當前網址是否符合設定的「待辦事項網址」
 * 2. 套用選定樣式：預設 (Default) / Bootstrap / MaterialDesign (透過 Extension Icon 呈現狀態)
 * 3. 將「待辦事項」頁面改為左右兩欄排版 (左 20% 衝刺清單 + 右 80% 選取衝刺卡片)
 * 4. 點擊卡片時，以置中 Modal 視窗展示詳細資訊
 * 5. 監聽 Jira SPA 路由切換、原生篩選器與非同步 DOM 變動，即時無縫同步
 * @module content
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  const {
    Constants,
    TextUtils,
    DomUtils,
    SprintDomParser,
    JiraApiService,
    IssueModalComponent,
    LayoutManager
  } = BetterJira;

  const {
    SIDEBAR_ID,
    RUNTIME_STYLE_ID,
    HISTORY_PICKER_MODAL_ID
  } = Constants;

  const { isUrlMatched } = TextUtils;
  const { isInsideExtensionUi } = DomUtils;
  const { isInsideCard } = SprintDomParser;
  const { syncExtensionIcon } = JiraApiService;
  const { applyIssueDetailModalTransform, closeIssueDetailModal } = IssueModalComponent;
  const {
    applyThemeAndLayout,
    updateColumnsViewportHeight,
    scheduleLayoutRefresh,
    getCurrentSettings,
    setCurrentSettings
  } = LayoutManager;

  /**
   * 評估目前網址並套用對應主題與雙欄排版
   */
  function evaluateAndApply() {
    const settings = getCurrentSettings();
    const matched = isUrlMatched(window.location.href, settings.backlogUrl);
    applyThemeAndLayout(matched, settings.themeStyle);
  }

  /**
   * 當使用者在 Jira 原生篩選搜尋區 (人員頭像、搜尋框、下拉選單、清除篩選按鈕) 操作時，
   * 立即排程多次微延遲刷新，確保 React 完成狀態更新與虛擬列表重繪後，左右兩欄 100% 即時同步。
   */
  function triggerNativeFilterSyncBurst() {
    scheduleLayoutRefresh(evaluateAndApply);
    setTimeout(() => scheduleLayoutRefresh(evaluateAndApply), 32);
    setTimeout(() => scheduleLayoutRefresh(evaluateAndApply), 120);
    setTimeout(() => scheduleLayoutRefresh(evaluateAndApply), 280);
  }

  // 將 evaluateAndApply 掛載至 BetterJira.App 供全域或組件排程刷新呼叫
  BetterJira.App = {
    evaluateAndApply,
    triggerNativeFilterSyncBurst
  };

  // 當點擊卡片時，立即在同一個 frame 及後續微任務偵測右側面板並轉為 Modal (0 延遲)；
  // 當點擊 Jira 原生篩選搜尋區 (如人員頭像、篩選條件、清除篩選) 時，立即同步左右側欄
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!target || !(target instanceof Element)) return;

      if (isInsideCard(target)) {
        requestAnimationFrame(() => applyIssueDetailModalTransform());
        setTimeout(() => applyIssueDetailModalTransform(), 16);
        setTimeout(() => applyIssueDetailModalTransform(), 60);
        return;
      }

      if (!isInsideExtensionUi(target)) {
        triggerNativeFilterSyncBurst();
      }
    },
    true
  );

  // 監聽原生搜尋框輸入與變更事件，即時連動左右側欄
  document.addEventListener(
    'input',
    (e) => {
      const target = e.target;
      if (target && target instanceof Element && !isInsideExtensionUi(target)) {
        triggerNativeFilterSyncBurst();
      }
    },
    true
  );

  document.addEventListener(
    'change',
    (e) => {
      const target = e.target;
      if (target && target instanceof Element && !isInsideExtensionUi(target)) {
        triggerNativeFilterSyncBurst();
      }
    },
    true
  );

  document.addEventListener(
    'keyup',
    (e) => {
      const target = e.target;
      if (target && target instanceof Element && !isInsideExtensionUi(target)) {
        scheduleLayoutRefresh(evaluateAndApply);
      }
    },
    true
  );

  // 按下 ESC 鍵時可關閉卡片 Modal 或歷史 Sprint 選擇視窗
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const pickerModal = document.getElementById(HISTORY_PICKER_MODAL_ID);
      if (pickerModal) {
        pickerModal.remove();
        return;
      }
      const openModal = document.querySelector('[data-bjwt-issue-modal="true"]');
      if (openModal) {
        closeIssueDetailModal(openModal);
      }
    }
  });

  window.addEventListener('resize', () => {
    const sidebar = document.getElementById(SIDEBAR_ID);
    const host = document.querySelector('[data-bjwt-layout-host="true"]');
    if (sidebar || host) {
      updateColumnsViewportHeight(host, sidebar);
    }
  });

  /**
   * 初始化擴充功能：讀取 IndexedDB 與 chrome.storage 設定並啟動版面評估
   */
  async function init() {
    try {
      const oldStyle = document.getElementById(RUNTIME_STYLE_ID);
      if (oldStyle) {
        oldStyle.remove();
      }
      const existingSidebar = document.getElementById(SIDEBAR_ID);
      if (existingSidebar) {
        existingSidebar.removeAttribute('data-bjwt-sig');
      }
      const settings = await BetterJiraDB.getSettings();
      setCurrentSettings(settings);
      await BetterJiraDB.syncFromObject(settings);
      syncExtensionIcon(settings.themeStyle);
      evaluateAndApply();
    } catch (err) {
      console.warn('[BetterJiraWT] Initialization error:', err);
    }
  }

  // 接收來自 Popup 選單的即時更新訊息
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === 'BETTER_JIRA_WT_SETTINGS_UPDATED' && message.payload) {
        const newSettings = message.payload;
        setCurrentSettings(newSettings);
        syncExtensionIcon(newSettings.themeStyle);
        BetterJiraDB.syncFromObject(newSettings).then(() => {
          evaluateAndApply();
          sendResponse({ ok: true });
        });
        return true;
      }
    });
  }

  // 監聽 storage 變更 (多視窗同步)
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        const current = getCurrentSettings();
        if (changes.backlogUrl) {
          current.backlogUrl = changes.backlogUrl.newValue;
        }
        if (changes.themeStyle) {
          current.themeStyle = changes.themeStyle.newValue;
          syncExtensionIcon(current.themeStyle);
        }
        setCurrentSettings(current);
        BetterJiraDB.syncFromObject(current).then(() => {
          evaluateAndApply();
        });
      }
    });
  }

  // 監聽 Jira SPA 路由切換、原生篩選器屬性變更、非同步衝刺載入與點擊卡片開啟詳細區 (無 50ms 盲區)
  const observer = new MutationObserver((mutations) => {
    const isExternalChange = mutations.some((m) => {
      const rawTarget = m.target;
      const target =
        rawTarget instanceof Element ? rawTarget : rawTarget ? rawTarget.parentElement : null;
      if (!target) return true;
      return !isInsideExtensionUi(target);
    });

    if (isExternalChange) {
      scheduleLayoutRefresh(evaluateAndApply);
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'aria-checked',
        'aria-pressed',
        'aria-selected',
        'aria-expanded',
        'data-selected',
        'data-state',
        'class',
        'value'
      ]
    });
  }

  init();
})();
