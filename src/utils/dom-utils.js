/**
 * @fileoverview DOM 節點檢測、遍歷與樣式鎖定公用函式庫
 * 提供隱藏節點辨識、最低共同祖先尋找、擴充元件 UI 範圍判定等功能。
 * @module utils/dom-utils
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 判斷 DOM 元素是否為螢幕報讀專用 (VisuallyHidden) 或隱藏節點
   *
   * @param {Element|*} el - 欲檢查的 DOM 節點
   * @returns {boolean} 是否為隱藏或僅供報讀之節點
   */
  function isVisuallyHiddenOrIgnoredNode(el) {
    if (!el || !(el instanceof Element)) return false;
    if (
      el.matches(
        '[aria-hidden="true"], [class*="ScreenReader"], [class*="visually-hidden"], [class*="sr-only"], [hidden], svg, img, style, script, noscript'
      )
    ) {
      return true;
    }
    if (el.isConnected) {
      try {
        const style = window.getComputedStyle(el);
        if (style) {
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return true;
          }
          if (
            (style.width === '1px' && style.height === '1px') ||
            (style.clip && style.clip.includes('rect(1px')) ||
            (style.clipPath && style.clipPath.includes('inset(50%)'))
          ) {
            return true;
          }
        }
      } catch {
        // ignore
      }
    }
    return false;
  }

  /**
   * 找出所有衝刺容器節點的最低共同父節點 (Lowest Common Ancestor)
   *
   * @param {Element[]} elements - DOM 元素陣列
   * @returns {Element|null} 最低共同祖先容器
   */
  function findLowestCommonAncestor(elements) {
    if (!elements || elements.length === 0) return null;
    if (elements.length === 1) return elements[0].parentElement;

    let candidate = elements[0].parentElement;
    while (candidate && candidate !== document.body && candidate !== document.documentElement) {
      const containsAll = elements.every((el) => candidate.contains(el));
      if (containsAll) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    return elements[0].parentElement;
  }

  /**
   * 判斷某個點擊或輸入目標是否位於自定義的側邊欄、自定義卡片檢視或 Modal 內
   *
   * @param {Element|EventTarget|*} el - 點擊或輸入目標節點
   * @returns {boolean} 是否位於擴充功能自定義 UI 內
   */
  function isInsideExtensionUi(el) {
    if (!el || !(el instanceof Element)) return false;
    const {
      SIDEBAR_ID,
      MODAL_BACKDROP_ID,
      HISTORY_PICKER_MODAL_ID,
      HISTORY_ISSUE_MODAL_ID
    } = BetterJira.Constants;

    return Boolean(
      el.closest(`#${SIDEBAR_ID}`) ||
        el.closest(`#${MODAL_BACKDROP_ID}`) ||
        el.closest(`#${HISTORY_PICKER_MODAL_ID}`) ||
        el.closest(`#${HISTORY_ISSUE_MODAL_ID}`) ||
        el.closest('[data-bjwt-history-branch="true"]') ||
        el.closest('[data-bjwt-custom-view]')
    );
  }

  /**
   * 預先將從 sprintsHost 往上到 <main> 之間的祖先鏈鎖定為 100% 寬度，
   * 確保點擊卡片的瞬間，右欄絕對不會被 Jira 的分割面板切成兩半。
   *
   * @param {Element} sprintsHost - 衝刺清單的直接宿主節點
   */
  function lockBacklogAncestorWidths(sprintsHost) {
    if (!sprintsHost) return;
    const mainBoundary =
      sprintsHost.closest('main, [role="main"]') || document.body;
    let curr = sprintsHost;
    while (curr && curr !== mainBoundary && curr !== document.body) {
      curr.setAttribute('data-bjwt-backlog-pane', 'true');
      curr = curr.parentElement;
    }
  }

  /**
   * 搜尋並隱藏 Jira 原生搜尋與篩選工具列，由擴充套件自製純前端篩選器接管
   *
   * @param {Document|Element} [root=document] - 搜尋根節點
   */
  function hideNativeFilterBars(root) {
    const doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.querySelectorAll !== 'function') return;

    const selectors = [
      '[data-testid="software-backlog.page-header"]',
      '[data-testid*="filter-bar"]',
      '[data-testid="software-backlog.filter-bar"]',
      '[data-testid="software-board.header.filter-bar"]',
      '[data-testid*="quick-filters"]',
      '[data-testid*="filters.ui.filter-bar"]',
      '[data-testid="software-backlog.header"] [data-testid*="filter"]',
      '[data-testid="software-backlog.header"] [role="search"]',
      '.ghx-controls-filters',
      '#ghx-quick-filters'
    ];

    try {
      doc.querySelectorAll(selectors.join(', ')).forEach((el) => {
        if (!isInsideExtensionUi(el)) {
          el.setAttribute('data-bjwt-native-filter-hidden', 'true');
        }
      });
    } catch {
      // ignore
    }
  }

  BetterJira.DomUtils = {
    isVisuallyHiddenOrIgnoredNode,
    findLowestCommonAncestor,
    isInsideExtensionUi,
    lockBacklogAncestorWidths,
    hideNativeFilterBars
  };
})();
