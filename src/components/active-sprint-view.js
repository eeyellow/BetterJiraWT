/**
 * @fileoverview 右欄 80% 未結束衝刺自定義卡片檢視 (Active Sprint View) 元件
 * 提供衝刺標題橫幅、狀態計數徽章、卡片即時關鍵字過濾、非同步 API 同步與完成衝刺觸發。
 * @module components/active-sprint-view
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 非同步同步未結束衝刺的卡片資料，並寫入 issueMetadataMap 與 allApiIssues，
   * 具備狀態防重、TTL 快取保護與防振盪更新，絕不無窮重複發起請求。
   *
   * @param {Object} item - 衝刺結構物件
   * @param {boolean} [forceRefresh=false] - 是否強制重新發起網路請求
   */
  async function syncActiveSprintIssuesFromApi(item, forceRefresh = false) {
    const { IssueStore, JiraApiService, LayoutManager } = BetterJira;
    const key = item.meta.key;
    const sprintId = item.meta.sprintId;
    const cacheKey = sprintId ? `sprint_${sprintId}` : key;

    let cached = IssueStore.getActiveSprintCache(cacheKey) || IssueStore.getActiveSprintCache(key);
    if (!cached) {
      cached = {
        key: cacheKey,
        title: item.meta.title,
        issues: [],
        allApiIssues: null,
        filterKeyword: '',
        fromApi: false,
        apiSyncing: false,
        lastSyncTime: 0
      };
      IssueStore.setActiveSprintCache(cacheKey, cached);
      IssueStore.setActiveSprintCache(key, cached);
    }

    if (cached.apiSyncing && !forceRefresh) {
      return;
    }
    cached.apiSyncing = true;

    try {
      const apiIssues = await JiraApiService.fetchSprintIssuesForActive(item, forceRefresh);

      if (Array.isArray(apiIssues) && apiIssues.length > 0) {
        const mergedList = apiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss));
        cached.allApiIssues = mergedList;
        if (!cached.masterIssuesMap) cached.masterIssuesMap = new Map();
        mergedList.forEach((iss) => cached.masterIssuesMap.set(iss.key, iss));
        cached.rawIssues = Array.from(cached.masterIssuesMap.values());
      } else if (!cached.allApiIssues) {
        cached.allApiIssues = [];
      }
    } catch {
      // ignore network errors, fallback to cooldown
    } finally {
      cached.apiSyncing = false;
      cached.fromApi = true;
      cached.lastSyncTime = Date.now();
      IssueStore.setActiveSprintCache(cacheKey, cached);
      IssueStore.setActiveSprintCache(key, cached);

      // 同步完成後清除自定義檢視的舊渲染簽名，確保卡片即時重繪出現在畫面上
      if (item.branch) {
        const cv = item.branch.querySelector('.bjwt-active-sprint-custom-view');
        if (cv) cv.removeAttribute('data-bjwt-render-sig');
      }

      if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
        LayoutManager.scheduleLayoutRefresh();
      }
    }
  }

  let activeCreationTracker = null;
  let creationObserverAttached = false;

  /**
   * 顯示卡片已成功加入當前衝刺的浮動提示
   *
   * @param {string} issueKey - 卡片編號
   * @param {string} sprintTitle - 衝刺標題
   */
  function showSprintCreationToast(issueKey, sprintTitle) {
    if (typeof document === 'undefined' || !document.body) return;
    const existing = document.querySelector('.bjwt-sprint-create-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'bjwt-sprint-create-toast';
    const cleanTitle = (BetterJira.TextUtils && typeof BetterJira.TextUtils.cleanSprintTitle === 'function')
      ? BetterJira.TextUtils.cleanSprintTitle(sprintTitle || '')
      : (sprintTitle || '');
    toast.innerHTML = `
      <span class="bjwt-toast-icon">✨</span>
      <span>新卡片 <strong>${issueKey}</strong> 已建立於衝刺 <strong>「${cleanTitle}」</strong>！</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('bjwt-toast-fade-out');
      setTimeout(() => toast.remove(), 350);
    }, 4000);
  }

  /**
   * 處理新建立的卡片：若未被指派至當前衝刺 (跑到 Backlog)，立即自動移動至當前衝刺
   *
   * @param {string} issueKey - 剛建立的卡片 Key
   * @param {Object} tracker - 追蹤器物件
   */
  async function handleNewlyCreatedIssue(issueKey, tracker) {
    if (!issueKey || !tracker || !tracker.item) return;
    const { JiraApiService, LayoutManager } = BetterJira;
    if (!JiraApiService || typeof JiraApiService.moveIssuesToSprint !== 'function') return;

    let sprintId = tracker.sprintId;
    if (!sprintId && typeof JiraApiService.resolveSprintId === 'function') {
      sprintId = await JiraApiService.resolveSprintId(tracker.item);
      if (sprintId) tracker.sprintId = sprintId;
    }
    if (!sprintId) return;

    try {
      const moved = await JiraApiService.moveIssuesToSprint(sprintId, [issueKey]);
      if (moved) {
        showSprintCreationToast(issueKey, tracker.sprintTitle);
        if (typeof syncActiveSprintIssuesFromApi === 'function') {
          await syncActiveSprintIssuesFromApi(tracker.item, true);
        }
        if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
          LayoutManager.scheduleLayoutRefresh();
        }
      }
    } catch (err) {
      console.warn('[BetterJiraWT] Auto move issue to sprint error:', err);
    }
  }

  /**
   * 確保全域建立監聽器已掛載 (監聽 Jira Toast/Flag 提示與 DOM 異動)
   */
  function ensureCreationObserver() {
    if (creationObserverAttached || typeof document === 'undefined' || !document.body) return;
    creationObserverAttached = true;

    const parseKeysFromText = (str) => {
      if (!str || typeof str !== 'string') return [];
      const matches = str.match(/([A-Z][A-Z0-9_]*-\d+)/g);
      return matches ? Array.from(new Set(matches)) : [];
    };

    const processCandidateNode = (node) => {
      if (!activeCreationTracker || Date.now() - activeCreationTracker.startTime > 300000) {
        return;
      }
      if (!node || !(node instanceof Element)) return;

      // 檢查是否為 Jira Flag、Toast、AUI Message 或包含建立成功的通知
      const isFlagOrAlert =
        Boolean(node.closest && node.closest('[data-testid*="flag"], [role="alert"], [class*="flag"], [class*="Flag"], [class*="toast"], .aui-message')) ||
        (node.getAttribute && /flag|alert|toast/i.test(node.getAttribute('data-testid') || node.getAttribute('role') || '')) ||
        (typeof node.className === 'string' && /flag|toast|aui-message/i.test(node.className));

      if (!isFlagOrAlert) return;

      const links = Array.from(node.querySelectorAll('a[href*="/browse/"]'));
      const keys = [];
      links.forEach((a) => {
        const m = (a.getAttribute('href') || '').match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i);
        if (m) keys.push(m[1].toUpperCase());
      });

      if (keys.length === 0) {
        const textKeys = parseKeysFromText(node.textContent || '');
        keys.push(...textKeys);
      }

      keys.forEach((key) => {
        if (!activeCreationTracker.processedKeys.has(key)) {
          activeCreationTracker.processedKeys.add(key);
          handleNewlyCreatedIssue(key, activeCreationTracker);
        }
      });
    };

    try {
      const observer = new MutationObserver((mutations) => {
        if (!activeCreationTracker) return;
        for (const m of mutations) {
          if (m.type === 'childList') {
            m.addedNodes.forEach((node) => {
              processCandidateNode(node);
            });
          }
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    } catch {
      // ignore
    }
  }

  /**
   * 啟動針對當前衝刺建立卡片的狀態追蹤
   *
   * @param {Object} item - 衝刺結構物件
   */
  function startSprintCreationTracking(item) {
    if (!item || !item.meta) return;
    const { cleanSprintTitle } = BetterJira.TextUtils || {};
    const sprintTitle = (cleanSprintTitle ? cleanSprintTitle(item.meta.title) : item.meta.title) || '';

    activeCreationTracker = {
      item,
      sprintId: item.meta.sprintId || null,
      sprintTitle,
      rawTitle: item.meta.rawTitle || '',
      startTime: Date.now(),
      processedKeys: new Set()
    };

    // 若 sprintId 尚未解析，背景非同步比對解析
    if (!activeCreationTracker.sprintId && BetterJira.JiraApiService && typeof BetterJira.JiraApiService.resolveSprintId === 'function') {
      BetterJira.JiraApiService.resolveSprintId(item).then((id) => {
        if (id && activeCreationTracker) {
          activeCreationTracker.sprintId = id;
        }
      }).catch(() => {});
    }

    ensureCreationObserver();
  }

  /**
   * 當 Jira 原生建立對話框跳出時，嘗試自動選取當前衝刺
   *
   * @param {Object} item - 衝刺結構物件
   */
  function autoFillSprintInModal(item) {
    if (!item || !item.meta || typeof document === 'undefined') return;
    const { cleanSprintTitle } = BetterJira.TextUtils || {};
    const sprintTitle = (cleanSprintTitle ? cleanSprintTitle(item.meta.title) : item.meta.title) || '';
    const sprintId = item.meta.sprintId || '';

    let attempts = 0;
    const maxAttempts = 15;
    const timer = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(timer);
        return;
      }

      const modal = document.querySelector(
        '[data-testid="issue-create.ui.modal.modal-wrapper.modal"], [data-testid*="issue-create"], [role="dialog"], #create-issue-dialog, .jira-dialog'
      );
      if (!modal) return;

      const success = attemptFillSprintField(modal, sprintTitle, sprintId);
      if (success) {
        clearInterval(timer);
      }
    }, 250);
  }

  /**
   * 於建立對話框內尋找並選取衝刺欄位
   */
  function attemptFillSprintField(modal, sprintTitle, sprintId) {
    if (!modal) return false;

    // 1. 檢查原生 <select>
    const selects = Array.from(modal.querySelectorAll('select'));
    const sprintSelect = selects.find((s) => {
      const name = (s.getAttribute('name') || '').toLowerCase();
      const id = (s.getAttribute('id') || '').toLowerCase();
      return name.includes('sprint') || name.includes('10020') || id.includes('sprint') || id.includes('10020');
    });

    if (sprintSelect && sprintSelect.options) {
      const opt = Array.from(sprintSelect.options).find(
        (o) =>
          (sprintId && String(o.value) === String(sprintId)) ||
          (sprintTitle && o.textContent.toLowerCase().includes(sprintTitle.toLowerCase()))
      );
      if (opt && sprintSelect.value !== opt.value) {
        sprintSelect.value = opt.value;
        sprintSelect.dispatchEvent(new Event('change', { bubbles: true }));
        sprintSelect.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
    }

    // 2. 檢查 Atlaskit / React-Select 容器
    const labels = Array.from(modal.querySelectorAll('label, [data-testid*="label"]'));
    const sprintLabel = labels.find((l) => /sprint|衝刺/i.test(l.textContent || ''));
    const fieldContainer =
      modal.querySelector('[data-testid*="sprint-select"], [data-testid*="field-sprint"], [id*="customfield_10020"]') ||
      (sprintLabel ? sprintLabel.closest('[data-testid*="form-field"], .field-group, div') : null);

    if (fieldContainer) {
      const currentText = (fieldContainer.textContent || '').trim().toLowerCase();
      if (sprintTitle && currentText.includes(sprintTitle.toLowerCase())) {
        return true;
      }

      const input = fieldContainer.querySelector('input[id*="react-select"], input[id*="sprint"], input');
      if (input && typeof input.focus === 'function') {
        input.focus();
        const control = fieldContainer.querySelector('[class*="control"], [class*="select__control"]') || input;
        control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

        setTimeout(() => {
          const menuOptions = Array.from(
            document.querySelectorAll('[data-testid*="select-option"], [class*="-option"], [role="option"]')
          );
          const targetOpt = menuOptions.find((o) => {
            const t = (o.textContent || '').trim().toLowerCase();
            return (sprintTitle && t.includes(sprintTitle.toLowerCase())) || (sprintId && t.includes(String(sprintId)));
          });
          if (targetOpt && typeof targetOpt.click === 'function') {
            targetOpt.click();
          }
        }, 120);
        return true;
      }
    }

    return false;
  }

  /**
   * 觸發 Jira 原生「建立問題 (Create Issue)」操作
   * 依序嘗試 Jira 頂部導航列之全域「建立 / Create」按鈕、導航列文字按鈕或原生快捷鍵 'c'，
   * 同時註冊當前衝刺自動指派與建立對話框自動選取衝刺。
   *
   * @param {Object|null} [item=null] - 衝刺結構物件
   * @returns {boolean} 是否成功觸發按鈕或分發快捷鍵
   */
  function triggerCreateIssue(item = null) {
    if (item) {
      startSprintCreationTracking(item);
    }

    // 1. 優先尋找 Jira 頂部導航列之全域「建立 / Create」按鈕
    const globalCreateSelectors = [
      '#createGlobalItem',
      '[data-testid="atlassian-navigation--create"]',
      '[data-testid="atlassian-navigation--primary-actions--create"]',
      '#create-menu',
      '#quick-create-button',
      'button[aria-label="Create"]',
      'button[aria-label="建立"]',
      'button[aria-label*="Create issue"]',
      'button[aria-label*="建立問題"]'
    ];

    let triggered = false;
    for (const selector of globalCreateSelectors) {
      const btn = document.querySelector(selector);
      if (btn && typeof btn.click === 'function') {
        btn.click();
        triggered = true;
        break;
      }
    }

    // 2. 尋找頂部導航列包含「建立」或「Create」文字的按鈕
    if (!triggered) {
      const navButtons = Array.from(
        document.querySelectorAll('header button, nav button, [role="banner"] button, [data-testid*="navigation"] button')
      );
      const matchedNavBtn = navButtons.find((btn) => {
        const text = (btn.textContent || '').trim();
        const aria = btn.getAttribute('aria-label') || '';
        return /^(建立|create)$/i.test(text) || /^(建立|create)/i.test(aria);
      });
      if (matchedNavBtn && typeof matchedNavBtn.click === 'function') {
        matchedNavBtn.click();
        triggered = true;
      }
    }

    // 3. 嘗試衝刺容器或 partner 內部的原生建立按鈕（若存在且非自定義檢視內的按鈕）
    if (!triggered && item) {
      const containers = [item.branch, item.headerPartner].filter(Boolean);
      for (const container of containers) {
        const nativeBtn = container.querySelector(
          'button[data-testid*="create-issue"], button[data-testid*="inline-issue-create"], .ghx-create-issue, button[aria-label*="建立"], button[aria-label*="Create"]'
        );
        if (nativeBtn && !nativeBtn.classList.contains('bjwt-active-create-btn') && !nativeBtn.classList.contains('bjwt-active-inline-create-btn')) {
          nativeBtn.click();
          triggered = true;
          break;
        }
      }
    }

    // 4. 退回方案：分發 Jira 原生快捷鍵 'c' 觸發建立對話框
    if (!triggered) {
      try {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
          activeEl.blur();
        }
        const keyboardEvent = new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          keyCode: 67,
          which: 67,
          bubbles: true,
          cancelable: true
        });
        document.dispatchEvent(keyboardEvent);
        triggered = true;
      } catch {
        triggered = false;
      }
    }

    if (item && triggered) {
      autoFillSprintInModal(item);
    }

    return triggered;
  }

  /**
   * 渲染未結束衝刺的自定義卡片檢視 (與歷史衝刺一體呈現，並即時連動 Jira 原生篩選搜尋區)
   *
   * @param {Object} item - 衝刺結構物件
   * @param {Object|null} [nativeFilter=null] - 原生篩選狀態物件
   */
  function renderActiveSprintBranch(item, nativeFilter = null) {
    const { TextUtils, SprintStatsService, FilterService, FrontendFilterService, FilterToolbarComponent, IssueStore, IssueCardComponent, IssueModalComponent, QuickEditPopoverComponent, CardContextMenuComponent, LayoutManager } = BetterJira;
    const { cleanSprintTitle, cleanSummaryText, escapeHtml } = TextUtils;
    const { calculateSprintStatistics } = SprintStatsService;
    const { getNativeBacklogFilterState } = FilterService;
    const { renderIssueCardHtml } = IssueCardComponent;
    const { openHistoricalIssueDetailModal } = IssueModalComponent;

    const branchEl = item.branch;
    if (!branchEl) return;

    const key = item.meta.key;
    const activeNativeFilter = nativeFilter || getNativeBacklogFilterState();

    // 每次渲染前皆確保與最新原生 DOM 及篩選狀態同步 (純畫面計算，不重複觸發 API 請求)
    if (LayoutManager && typeof LayoutManager.resolveSprintIssuesForLayout === 'function') {
      LayoutManager.resolveSprintIssuesForLayout(item, activeNativeFilter, false);
    }
    const sprintData = IssueStore.getActiveSprintCache(key);
    if (!sprintData) return;

    // 確保快取中的所有卡片標題皆經過深度去重清理
    if (Array.isArray(sprintData.issues)) {
      sprintData.issues.forEach((iss) => {
        if (iss && iss.summary) {
          iss.summary = cleanSummaryText(iss.summary);
        }
      });
    }

    // 從原生標頭提取日期區間 (例如 "22 10月 - 4 11月")
    let dateRange = sprintData.dateRange || '';
    const headerNodes = [
      item.headerPartner,
      branchEl.querySelector('[data-testid*="header"], .ghx-backlog-header, header')
    ].filter(Boolean);

    if (!dateRange) {
      for (const hdr of headerNodes) {
        const text = (hdr.innerText || hdr.textContent || '').replace(/\s+/g, ' ');
        const dateMatch =
          text.match(/(\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?\s*[-~至到–—]\s*\d{1,4}[-/年\s]?\d{1,2}[-/月\s]?\d{1,2}[日]?)/i) ||
          text.match(/(\d{1,2}\s*[^\d\s\(\)]+\s*[-~至到–—]\s*\d{1,2}\s*[^\d\s\(\)]+)/i);
        if (dateMatch) {
          dateRange = dateMatch[1].trim();
          break;
        }
      }
      sprintData.dateRange = dateRange;
    }

    // 尋找原生「完成衝刺」或「開始衝刺」按鈕以利在自定義 Banner 中支援轉發點擊
    let nativeCompleteBtn = null;
    let nativeStartBtn = null;
    for (const hdr of headerNodes) {
      const btns = Array.from(hdr.querySelectorAll('button, [role="button"], a, input[type="button"]'));
      if (!nativeCompleteBtn) {
        nativeCompleteBtn = btns.find(
          (b) =>
            /完成衝刺|complete sprint/i.test((b.textContent || b.value || '').trim()) ||
            (b.getAttribute('data-testid') || '').includes('complete-sprint')
        );
      }
      if (!nativeStartBtn) {
        nativeStartBtn = btns.find(
          (b) =>
            /開始衝刺|start sprint/i.test((b.textContent || b.value || '').trim()) ||
            (b.getAttribute('data-testid') || '').includes('start-sprint')
        );
      }
    }

    // 建立或取得自定義容器
    let customView = branchEl.querySelector('.bjwt-active-sprint-custom-view');
    if (!customView) {
      customView = document.createElement('div');
      customView.className = 'bjwt-active-sprint-custom-view';
      customView.setAttribute('data-bjwt-custom-view', 'true');
      branchEl.appendChild(customView);
    }

    // 取得衝刺完整未篩選卡片清單 (母體卡片池優先，確保選單中人員與類型 100% 完整列出，嚴格排除子任務)
    const rawCandidateIssues =
      Array.isArray(sprintData.rawIssues) && sprintData.rawIssues.length > 0
        ? sprintData.rawIssues
        : Array.isArray(sprintData.allApiIssues) && sprintData.allApiIssues.length > 0
        ? sprintData.allApiIssues.map((iss) => IssueStore.mergeAndCacheIssue(iss))
        : sprintData.issues || [];
    const allIssues = rawCandidateIssues.filter((iss) => !iss.isSubtask);

    // 透過純前端篩選服務多維度過濾卡片
    const visibleIssues = (
      FrontendFilterService && typeof FrontendFilterService.filterIssues === 'function'
        ? FrontendFilterService.filterIssues(allIssues)
        : allIssues
    ).filter((iss) => !iss.isSubtask);

    // 點數與數量統計完全依據目前篩選後可見的卡片計算
    const stats = calculateSprintStatistics(visibleIssues);
    const displayTitle = cleanSprintTitle(sprintData.title);

    const issuesSig = visibleIssues
      .map(
        (i) =>
          `${i.key}:${i.summary}:${i.statusName}:${i.statusCategory || ''}:${i.storyPoints ?? ''}:${i.priorityName || ''}:${i.priorityIcon || ''}:${i.issueTypeName || ''}:${i.issueTypeIcon || ''}:${i.isUnassigned ? 'U' : 'A'}:${i.assigneeName || ''}:${i.assigneeInitials || ''}:${i.assigneeAvatar || ''}`
      )
      .join('|');

    const currentTheme = LayoutManager ? LayoutManager.getCurrentTheme() : 'Default';
    const frontendFilterSig = FrontendFilterService ? JSON.stringify(FrontendFilterService.getState()) : '';
    const filterOptions = FrontendFilterService ? FrontendFilterService.extractFilterOptions(allIssues) : null;
    const optionsSig = filterOptions
      ? `${filterOptions.assignees.length}:${filterOptions.types.length}:${allIssues.length}`
      : '';

    const sig = JSON.stringify({
      key,
      count: visibleIssues.length,
      points: stats.totalPoints,
      fromApi: Boolean(sprintData.fromApi),
      apiSyncing: Boolean(sprintData.apiSyncing),
      nativeFilterSig: activeNativeFilter.sig,
      frontendFilterSig,
      optionsSig,
      issuesSig,
      dateRange,
      theme: currentTheme
    });

    if (customView.getAttribute('data-bjwt-render-sig') === sig) {
      return;
    }
    customView.setAttribute('data-bjwt-render-sig', sig);

    const isBacklogPool = /backlog|待辦池|待辦事項/i.test(sprintData.title);
    const isFuture = isBacklogPool || (item.meta && item.meta.sprintState === 'future');
    const badgeText = isBacklogPool ? '待辦池' : (isFuture ? '未開始' : '進行中');
    const badgeClass = isFuture ? 'badge-future' : 'badge-active';

    customView.innerHTML = `
      <div class="bjwt-history-sprint-container sprint-container">
        <!-- 全新設計的 Sprint 標題 Banner (與歷史衝刺一體呈現) -->
        <div class="bjwt-history-sprint-banner">
          <div class="bjwt-history-banner-main">
            <span class="bjwt-history-banner-badge ${badgeClass}">
              <svg class="bjwt-icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              ${badgeText}
            </span>
            <h2 class="bjwt-history-banner-title">${escapeHtml(displayTitle)}</h2>
            ${dateRange ? `<span class="bjwt-history-banner-dates">${escapeHtml(dateRange)}</span>` : ''}
            <span class="bjwt-history-banner-stats">
              (${stats.totalIssues} 個工作項目 · 共 ${stats.totalPoints} 點)
            </span>
          </div>
          <div class="bjwt-history-banner-controls">
            <span class="bjwt-history-status-counters" title="Story Points (待辦 / 進行中 / 完成)">
              <span class="bjwt-counter-pill counter-todo" title="待辦: ${stats.todoPoints} 點 (${stats.todoCount} 個工作項目)">${stats.todoPoints}</span>
              <span class="bjwt-counter-pill counter-inprogress" title="進行中: ${stats.inProgressPoints} 點 (${stats.inProgressCount} 個工作項目)">${stats.inProgressPoints}</span>
              <span class="bjwt-counter-pill counter-done" title="完成: ${stats.donePoints} 點 (${stats.doneCount} 個工作項目)">${stats.donePoints}</span>
            </span>
            <button type="button" class="bjwt-active-create-btn" title="在此衝刺新增卡片">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              新增卡片
            </button>
            <button type="button" class="bjwt-history-refresh-btn" title="從 Jira 重新同步此衝刺">
              ↻ 重新整理
            </button>
            ${
              nativeCompleteBtn
                ? `<button type="button" class="bjwt-active-complete-btn" title="完成此衝刺">完成衝刺</button>`
                : (nativeStartBtn
                    ? `<button type="button" class="bjwt-active-start-btn" title="開始此衝刺">開始衝刺</button>`
                    : '')
            }
          </div>
        </div>
        ${
          sprintData.goal
            ? `<div class="bjwt-history-sprint-goal"><strong>衝刺目標：</strong>${escapeHtml(sprintData.goal)}</div>`
            : ''
        }
        <div class="bjwt-history-card-list">
          ${
            visibleIssues.length === 0
              ? (sprintData.apiSyncing
                  ? `<div class="bjwt-history-empty-cards"><span class="bjwt-spinner-inline">⏳</span> 正在從 Jira 同步此衝刺卡片資料...</div>`
                  : `<div class="bjwt-history-empty-cards">目前沒有符合搜尋與篩選條件的卡片。您可以點選左側其他衝刺查看結果，或點擊上方「清除篩選」。</div>`)
              : visibleIssues.map(renderIssueCardHtml).join('')
          }
        </div>
        <div class="bjwt-active-create-card-row">
          <button type="button" class="bjwt-active-inline-create-btn" title="在此衝刺建立卡片">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            建立問題 (Create Issue)
          </button>
          <div class="bjwt-active-inline-create-form" style="display: none;">
            <div class="bjwt-inline-create-input-wrap">
              <input type="text" class="bjwt-inline-create-input" placeholder="需要完成什麼工作？(按 Enter 建立)" />
            </div>
            <div class="bjwt-inline-create-actions">
              <button type="button" class="bjwt-inline-create-submit-btn">建立</button>
              <button type="button" class="bjwt-inline-create-modal-btn" title="開啟 Jira 完整建立視窗">完整視窗...</button>
              <button type="button" class="bjwt-inline-create-cancel-btn">取消</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // 綁定重新整理按鈕
    const refreshBtn = customView.querySelector('.bjwt-history-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '同步中...';
        if (IssueStore && typeof IssueStore.clearUserOverrides === 'function') {
          IssueStore.clearUserOverrides();
        }
        customView.removeAttribute('data-bjwt-render-sig');
        await syncActiveSprintIssuesFromApi(item, true);
        if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
          LayoutManager.scheduleLayoutRefresh();
        }
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ 重新整理';
      });
    }

    // 綁定完成衝刺按鈕
    const completeBtn = customView.querySelector('.bjwt-active-complete-btn');
    if (completeBtn && nativeCompleteBtn) {
      completeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        nativeCompleteBtn.click();
      });
    }

    // 綁定開始衝刺按鈕
    const startBtn = customView.querySelector('.bjwt-active-start-btn');
    if (startBtn && nativeStartBtn) {
      startBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        nativeStartBtn.click();
      });
    }

    // 綁定新增卡片按鈕 (頂部 Banner 控制列按鈕)
    const createBtn = customView.querySelector('.bjwt-active-create-btn');
    if (createBtn) {
      createBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerCreateIssue(item);
      });
    }

    // 綁定卡片清單底部行內建立問題與輸入表單
    const inlineCreateBtn = customView.querySelector('.bjwt-active-inline-create-btn');
    const inlineCreateForm = customView.querySelector('.bjwt-active-inline-create-form');
    const inlineInput = customView.querySelector('.bjwt-inline-create-input');
    const inlineSubmitBtn = customView.querySelector('.bjwt-inline-create-submit-btn');
    const inlineModalBtn = customView.querySelector('.bjwt-inline-create-modal-btn');
    const inlineCancelBtn = customView.querySelector('.bjwt-inline-create-cancel-btn');

    if (inlineCreateBtn && inlineCreateForm) {
      const showInlineForm = () => {
        inlineCreateBtn.style.display = 'none';
        inlineCreateForm.style.display = 'block';
        if (inlineInput) {
          inlineInput.value = '';
          inlineInput.disabled = false;
          inlineInput.focus();
        }
        startSprintCreationTracking(item);
      };

      const hideInlineForm = () => {
        inlineCreateForm.style.display = 'none';
        inlineCreateBtn.style.display = '';
        if (inlineInput) {
          inlineInput.value = '';
        }
      };

      inlineCreateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showInlineForm();
      });

      if (inlineCancelBtn) {
        inlineCancelBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          hideInlineForm();
        });
      }

      if (inlineModalBtn) {
        inlineModalBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          hideInlineForm();
          triggerCreateIssue(item);
        });
      }

      const executeInlineSubmit = async () => {
        if (!inlineInput || !inlineSubmitBtn) return;
        const summary = (inlineInput.value || '').trim();
        if (!summary) return;

        inlineSubmitBtn.disabled = true;
        inlineInput.disabled = true;
        const originalText = inlineSubmitBtn.textContent;
        inlineSubmitBtn.textContent = '建立中...';

        const { JiraApiService, LayoutManager } = BetterJira;
        let sprintId = item.meta && item.meta.sprintId;
        if (!sprintId && JiraApiService && typeof JiraApiService.resolveSprintId === 'function') {
          sprintId = await JiraApiService.resolveSprintId(item);
        }

        let projectKey = '';
        if (Array.isArray(sprintData.issues) && sprintData.issues.length > 0) {
          const firstKey = sprintData.issues[0].key || '';
          const match = firstKey.match(/^([A-Z][A-Z0-9_]*)-\d+/);
          if (match) projectKey = match[1];
        }
        if (!projectKey && item.meta && item.meta.key) {
          const match = String(item.meta.key).match(/^([A-Z][A-Z0-9_]*)/);
          if (match) projectKey = match[1];
        }

        let res = null;
        if (JiraApiService && typeof JiraApiService.createIssueInSprint === 'function') {
          res = await JiraApiService.createIssueInSprint({
            summary,
            sprintId,
            projectKey
          });
        }

        if (res && res.success) {
          inlineInput.value = '';
          inlineInput.disabled = false;
          inlineSubmitBtn.disabled = false;
          inlineSubmitBtn.textContent = originalText;
          hideInlineForm();

          showSprintCreationToast(res.key, sprintData.title);
          await syncActiveSprintIssuesFromApi(item, true);
          if (LayoutManager && typeof LayoutManager.scheduleLayoutRefresh === 'function') {
            LayoutManager.scheduleLayoutRefresh();
          }
        } else {
          // 若 API 直接建立失敗 (例如該專案有必填自訂欄位)，自動降級轉開完整 Jira 建立對話框，並由建立追蹤器處理
          inlineInput.disabled = false;
          inlineSubmitBtn.disabled = false;
          inlineSubmitBtn.textContent = originalText;
          hideInlineForm();
          triggerCreateIssue(item);
        }
      };

      if (inlineSubmitBtn) {
        inlineSubmitBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          executeInlineSubmit();
        });
      }

      if (inlineInput) {
        inlineInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            executeInlineSubmit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            hideInlineForm();
          }
        });
      }
    } else if (inlineCreateBtn) {
      inlineCreateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerCreateIssue(item);
      });
    }

    // 綁定卡片點擊事件以置中 Modal 預覽
    customView.querySelectorAll('.bjwt-history-card').forEach((cardEl) => {
      const issueKey = cardEl.getAttribute('data-bjwt-history-issue-key');
      const issueObj =
        visibleIssues.find((i) => i.key === issueKey) ||
        sprintData.issues.find((i) => i.key === issueKey);
      const handleActivate = (e) => {
        const latestIssue =
          (IssueStore && typeof IssueStore.getCachedIssue === 'function' && IssueStore.getCachedIssue(issueKey)) ||
          issueObj;
        // 檢查是否點擊了快速編輯欄位 (類型、狀態、StoryPoint、優先度、指派人員)
        const quickEditTarget = e.target && e.target.closest ? e.target.closest('[data-bjwt-quick-edit]') : null;
        if (quickEditTarget) {
          e.preventDefault();
          e.stopPropagation();
          const editType = quickEditTarget.getAttribute('data-bjwt-quick-edit');
          if (QuickEditPopoverComponent && typeof QuickEditPopoverComponent.open === 'function') {
            QuickEditPopoverComponent.open(quickEditTarget, issueKey, editType, latestIssue);
          }
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (issueKey) {
          openHistoricalIssueDetailModal(issueKey, latestIssue);
        }
      };
      cardEl.addEventListener('click', handleActivate);
      cardEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          handleActivate(e);
        }
      });
      cardEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const summaryText =
          (issueObj && (issueObj.summary || issueObj.cleanSummary)) ||
          cardEl.getAttribute('data-bjwt-issue-summary') ||
          (cardEl.querySelector('.bjwt-history-card-summary') && cardEl.querySelector('.bjwt-history-card-summary').textContent.trim()) ||
          '';
        if (CardContextMenuComponent && typeof CardContextMenuComponent.open === 'function') {
          CardContextMenuComponent.open(e.clientX, e.clientY, {
            key: issueKey,
            summary: summaryText
          });
        }
      });
    });
  }

  BetterJira.ActiveSprintView = {
    syncActiveSprintIssuesFromApi,
    renderActiveSprintBranch,
    triggerCreateIssue,
    startSprintCreationTracking,
    handleNewlyCreatedIssue,
    showSprintCreationToast
  };
})();
