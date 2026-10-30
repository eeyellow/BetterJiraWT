/**
 * @fileoverview BetterJiraWT IndexedDB & Storage Helper
 * 將設定儲存於前端 IndexedDB，並同步至 chrome.storage.local 以跨 Popup 與 Jira 頁面共享。
 * @module db
 */
const BetterJiraDB = (() => {
  const DB_NAME = 'BetterJiraWT_DB';
  const DB_VERSION = 1;
  const STORE_NAME = 'settings';

  /**
   * 樣式對應中文標籤
   * @type {Record<string, string>}
   */
  const STYLE_LABELS = {
    Default: '預設',
    Bootstrap: 'Bootstrap',
    MaterialDesign: 'MaterialDesign'
  };

  /**
   * 預設擴充功能設定物件
   * @type {{backlogUrl: string, themeStyle: string}}
   */
  const DEFAULT_SETTINGS = {
    backlogUrl: '',
    themeStyle: 'Default' // 'Default' | 'Bootstrap' | 'MaterialDesign'
  };

  /**
   * 開啟或升級 IndexedDB 資料庫連線
   * @returns {Promise<IDBDatabase>}
   */
  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        resolve(event.target.result);
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  /**
   * 從 IndexedDB 讀取指定鍵值
   * @param {string} key - 設定鍵名
   * @returns {Promise<*|undefined>} 儲存之數值
   */
  async function idbGet(key) {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[BetterJiraWT] IndexedDB read error:', err);
      return undefined;
    }
  }

  /**
   * 寫入鍵值至 IndexedDB
   * @param {string} key - 設定鍵名
   * @param {*} value - 設定數值
   * @returns {Promise<void>}
   */
  async function idbSet(key, value) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ key, value, updatedAt: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[BetterJiraWT] IndexedDB write error:', err);
    }
  }

  /**
   * 從 chrome.storage.local 讀取鍵值
   * @param {string|string[]} keys - 設定鍵名或鍵名清單
   * @returns {Promise<Object>}
   */
  function storageGet(keys) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } else {
        resolve({});
      }
    });
  }

  /**
   * 寫入設定至 chrome.storage.local
   * @param {Object} obj - 設定物件鍵值組
   * @returns {Promise<void>}
   */
  function storageSet(obj) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj, () => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * 整合讀取 IndexedDB 與 chrome.storage.local 的目前設定
   * @returns {Promise<{backlogUrl: string, themeStyle: string}>}
   */
  async function getSettings() {
    const [idbBacklogUrl, idbThemeStyle, extStorage] = await Promise.all([
      idbGet('backlogUrl'),
      idbGet('themeStyle'),
      storageGet(['backlogUrl', 'themeStyle'])
    ]);

    const backlogUrl =
      idbBacklogUrl !== undefined
        ? idbBacklogUrl
        : extStorage.backlogUrl !== undefined
        ? extStorage.backlogUrl
        : DEFAULT_SETTINGS.backlogUrl;

    const themeStyle =
      idbThemeStyle !== undefined
        ? idbThemeStyle
        : extStorage.themeStyle !== undefined
        ? extStorage.themeStyle
        : DEFAULT_SETTINGS.themeStyle;

    // 確保當前頁面的 IndexedDB 與 chrome.storage 保持同步
    if (idbBacklogUrl === undefined && backlogUrl) {
      await idbSet('backlogUrl', backlogUrl);
    }
    if (idbThemeStyle === undefined && themeStyle) {
      await idbSet('themeStyle', themeStyle);
    }

    return { backlogUrl, themeStyle };
  }

  /**
   * 儲存單一設定值並同步至 IndexedDB 與 chrome.storage.local
   * @param {string} key - 設定鍵名
   * @param {*} value - 設定數值
   * @returns {Promise<{backlogUrl: string, themeStyle: string}>} 更新後之全域設定
   */
  async function saveSetting(key, value) {
    await Promise.all([
      idbSet(key, value),
      storageSet({ [key]: value })
    ]);
    return getSettings();
  }

  /**
   * 從物件批次同步設定至 IndexedDB
   * @param {Object} settingsObj - 設定物件
   * @returns {Promise<void>}
   */
  async function syncFromObject(settingsObj) {
    const tasks = [];
    if (settingsObj.backlogUrl !== undefined) {
      tasks.push(idbSet('backlogUrl', settingsObj.backlogUrl));
    }
    if (settingsObj.themeStyle !== undefined) {
      tasks.push(idbSet('themeStyle', settingsObj.themeStyle));
    }
    await Promise.all(tasks);
  }

  /**
   * 取得指定樣式識別碼的中文標籤
   * @param {string} styleKey - 樣式鍵值 (Default / Bootstrap / MaterialDesign)
   * @returns {string} 樣式中文顯示名稱
   */
  function getStyleLabel(styleKey) {
    return STYLE_LABELS[styleKey] || styleKey || '預設';
  }

  return {
    getSettings,
    saveSetting,
    syncFromObject,
    getStyleLabel,
    STYLE_LABELS,
    DEFAULT_SETTINGS
  };
})();
