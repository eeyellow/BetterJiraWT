/**
 * BetterJiraWT IndexedDB & Storage Helper
 * 將設定儲存於前端 IndexedDB，並同步至 chrome.storage.local 以跨 Popup 與 Jira 頁面共享。
 */
const BetterJiraDB = (() => {
  const DB_NAME = 'BetterJiraWT_DB';
  const DB_VERSION = 1;
  const STORE_NAME = 'settings';

  const DEFAULT_SETTINGS = {
    backlogUrl: '',
    themeStyle: 'Bootstrap' // 'Bootstrap' | 'MaterialDesign' | 'Default'
  };

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

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } else {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(obj, () => resolve());
      } else {
        resolve();
      }
    });
  }

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

  async function saveSetting(key, value) {
    await Promise.all([
      idbSet(key, value),
      storageSet({ [key]: value })
    ]);
    return getSettings();
  }

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

  return {
    getSettings,
    saveSetting,
    syncFromObject,
    DEFAULT_SETTINGS
  };
})();
