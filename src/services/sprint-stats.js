/**
 * @fileoverview 衝刺卡片與點數統計服務
 * 提供 Story Points 累計、卡片狀態統計與側邊欄徽章動態更新功能。
 * @module services/sprint-stats
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * @typedef {Object} SprintStatistics
   * @property {number} totalIssues - 工作項目總數量
   * @property {number} todoCount - 待辦狀態卡片數量
   * @property {number} inProgressCount - 進行中狀態卡片數量
   * @property {number} doneCount - 已完成狀態卡片數量
   * @property {number} totalPoints - Story Points 總點數
   * @property {number} todoPoints - 待辦 Story Points 點數
   * @property {number} inProgressPoints - 進行中 Story Points 點數
   * @property {number} donePoints - 已完成 Story Points 點數
   */

  /**
   * 計算一個衝刺中各狀態的卡片數與 Story Points 總和
   *
   * @param {Array<Object>} issues - 卡片資料物件陣列
   * @returns {SprintStatistics} 統計結果物件
   */
  function calculateSprintStatistics(issues) {
    if (!Array.isArray(issues) || issues.length === 0) {
      return {
        totalIssues: 0,
        todoCount: 0,
        inProgressCount: 0,
        doneCount: 0,
        totalPoints: 0,
        todoPoints: 0,
        inProgressPoints: 0,
        donePoints: 0
      };
    }

    let doneCount = 0;
    let inProgressCount = 0;
    let todoCount = 0;

    let donePoints = 0;
    let inProgressPoints = 0;
    let todoPoints = 0;

    issues.forEach((iss) => {
      const pt = parseFloat(iss.storyPoints);
      const points = !isNaN(pt) && pt > 0 ? pt : 0;

      if (iss.statusCategory === 'done') {
        doneCount++;
        donePoints += points;
      } else if (iss.statusCategory === 'indeterminate') {
        inProgressCount++;
        inProgressPoints += points;
      } else {
        todoCount++;
        todoPoints += points;
      }
    });

    const roundPt = (val) => Math.round(val * 10) / 10;

    return {
      totalIssues: issues.length,
      todoCount,
      inProgressCount,
      doneCount,
      totalPoints: roundPt(donePoints + inProgressPoints + todoPoints),
      todoPoints: roundPt(todoPoints),
      inProgressPoints: roundPt(inProgressPoints),
      donePoints: roundPt(donePoints)
    };
  }

  /**
   * 更新左側欄指定衝刺的 StoryPoint / 卡片總計徽章
   *
   * @param {string} key - 衝刺鍵值
   * @param {number} points - 統計總點數
   * @param {number} count - 卡片總數量
   */
  function updateSidebarBadgeForSprint(key, points, count) {
    const escapedKey = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
      ? CSS.escape(key)
      : String(key).replace(/["\\]/g, '\\$&');
    const badge = document.querySelector(`.bjwt-sprint-tab-badge[data-bjwt-tab-key="${escapedKey}"]`);
    if (badge) {
      const badgeText = points > 0 ? `${points}` : `${count}`;
      badge.textContent = badgeText;
      badge.title = `共 ${points > 0 ? `${points} 點 Story Points · ` : ''}${count} 個工作項目`;
    }
  }

  BetterJira.SprintStatsService = {
    calculateSprintStatistics,
    updateSidebarBadgeForSprint
  };
})();
