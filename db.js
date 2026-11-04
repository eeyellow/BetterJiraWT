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
    Default: '預設'
  };

  /**
   * 預設擴充功能設定物件
   * @type {{backlogUrl: string, defaultSprint: string, customAssignees: Array<{name: string, email: string}>, themeStyle: string, enabled: boolean}}
   */
  const DEFAULT_SETTINGS = {
    backlogUrl: '',
    defaultSprint: '',
    customAssignees: [],
    themeStyle: 'Default',
    enabled: true
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
   * @returns {Promise<{backlogUrl: string, defaultSprint: string, customAssignees: Array<{name: string, email: string}>, themeStyle: string, enabled: boolean}>}
   */
  async function getSettings() {
    const [idbBacklogUrl, idbDefaultSprint, idbCustomAssignees, idbThemeStyle, idbEnabled, extStorage] = await Promise.all([
      idbGet('backlogUrl'),
      idbGet('defaultSprint'),
      idbGet('customAssignees'),
      idbGet('themeStyle'),
      idbGet('enabled'),
      storageGet(['backlogUrl', 'defaultSprint', 'customAssignees', 'themeStyle', 'enabled'])
    ]);

    const backlogUrl =
      idbBacklogUrl !== undefined
        ? idbBacklogUrl
        : extStorage.backlogUrl !== undefined
        ? extStorage.backlogUrl
        : DEFAULT_SETTINGS.backlogUrl;

    const defaultSprint =
      idbDefaultSprint !== undefined
        ? idbDefaultSprint
        : extStorage.defaultSprint !== undefined
        ? extStorage.defaultSprint
        : DEFAULT_SETTINGS.defaultSprint;

    const customAssignees = Array.isArray(idbCustomAssignees)
      ? idbCustomAssignees
      : Array.isArray(extStorage.customAssignees)
      ? extStorage.customAssignees
      : DEFAULT_SETTINGS.customAssignees;

    const themeStyle =
      idbThemeStyle !== undefined
        ? idbThemeStyle
        : extStorage.themeStyle !== undefined
        ? extStorage.themeStyle
        : DEFAULT_SETTINGS.themeStyle;

    const enabled =
      idbEnabled !== undefined
        ? Boolean(idbEnabled)
        : extStorage.enabled !== undefined
        ? Boolean(extStorage.enabled)
        : DEFAULT_SETTINGS.enabled;

    // 確保當前頁面的 IndexedDB 與 chrome.storage 保持同步
    if (idbBacklogUrl === undefined && backlogUrl) {
      await idbSet('backlogUrl', backlogUrl);
    }
    if (idbDefaultSprint === undefined && defaultSprint) {
      await idbSet('defaultSprint', defaultSprint);
    }
    if (idbCustomAssignees === undefined && customAssignees.length > 0) {
      await idbSet('customAssignees', customAssignees);
    }
    if (idbThemeStyle === undefined && themeStyle) {
      await idbSet('themeStyle', themeStyle);
    }
    if (idbEnabled === undefined) {
      await idbSet('enabled', enabled);
    }

    return { backlogUrl, defaultSprint, customAssignees, themeStyle, enabled };
  }

  /**
   * 儲存單一設定值並同步至 IndexedDB 與 chrome.storage.local
   * @param {string} key - 設定鍵名
   * @param {*} value - 設定數值
   * @returns {Promise<{backlogUrl: string, defaultSprint: string, customAssignees: Array<{name: string, email: string}>, themeStyle: string, enabled: boolean}>} 更新後之全域設定
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
    if (settingsObj.defaultSprint !== undefined) {
      tasks.push(idbSet('defaultSprint', settingsObj.defaultSprint));
    }
    if (settingsObj.customAssignees !== undefined) {
      tasks.push(idbSet('customAssignees', settingsObj.customAssignees));
    }
    if (settingsObj.themeStyle !== undefined) {
      tasks.push(idbSet('themeStyle', settingsObj.themeStyle));
    }
    if (settingsObj.enabled !== undefined) {
      tasks.push(idbSet('enabled', Boolean(settingsObj.enabled)));
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

if (typeof window !== 'undefined') {
  window.BetterJiraDB = BetterJiraDB;
}
if (typeof global !== 'undefined') {
  global.BetterJiraDB = BetterJiraDB;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BetterJiraDB;
}
