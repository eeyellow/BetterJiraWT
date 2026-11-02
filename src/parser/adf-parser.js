/**
 * @fileoverview Atlassian Document Format (ADF) 結構解析與 HTML 轉譯器
 * 將 Jira Cloud API 回傳的 ADF 富文字 JSON 樹狀節點轉換為標準安全的 HTML 標籤。
 * @module parser/adf-parser
 */

(() => {
  const BetterJira = (typeof window !== 'undefined' ? window : global).BetterJira =
    (typeof window !== 'undefined' ? window : global).BetterJira || {};

  /**
   * 將 ADF (Atlassian Document Format) 節點遞迴轉譯為 HTML 字串
   *
   * @param {Object|Array|string|null} node - ADF 節點結構
   * @returns {string} 轉譯後的 HTML 字串
   */
  function adfToHtml(node) {
    const { escapeHtml } = BetterJira.TextUtils;

    if (!node) return '';
    if (typeof node === 'string') return escapeHtml(node);
    if (Array.isArray(node)) {
      return node.map(adfToHtml).join('');
    }

    const { type, text, marks, content, attrs } = node;

    if (type === 'text') {
      let result = escapeHtml(text || '');
      if (Array.isArray(marks)) {
        for (const mark of marks) {
          if (mark.type === 'strong') result = `<strong>${result}</strong>`;
          else if (mark.type === 'em') result = `<em>${result}</em>`;
          else if (mark.type === 'code') result = `<code>${result}</code>`;
          else if (mark.type === 'strike') result = `<s>${result}</s>`;
          else if (mark.type === 'underline') result = `<u>${result}</u>`;
          else if (mark.type === 'link' && mark.attrs && mark.attrs.href) {
            const href = escapeHtml(mark.attrs.href);
            result = `<a href="${href}" target="_blank" rel="noopener noreferrer">${result}</a>`;
          }
        }
      }
      return result;
    }

    const innerHtml = Array.isArray(content) ? content.map(adfToHtml).join('') : '';

    switch (type) {
      case 'doc':
        return innerHtml;
      case 'paragraph':
        return innerHtml ? `<p>${innerHtml}</p>` : '<p><br /></p>';
      case 'heading': {
        const level = (attrs && attrs.level) || 3;
        const validLevel = Math.min(Math.max(level, 1), 6);
        return `<h${validLevel}>${innerHtml}</h${validLevel}>`;
      }
      case 'bulletList':
        return `<ul>${innerHtml}</ul>`;
      case 'orderedList':
        return `<ol>${innerHtml}</ol>`;
      case 'listItem':
        return `<li>${innerHtml}</li>`;
      case 'codeBlock': {
        const lang = attrs && attrs.language ? ` class="language-${escapeHtml(attrs.language)}"` : '';
        return `<pre><code${lang}>${innerHtml}</code></pre>`;
      }
      case 'blockquote':
        return `<blockquote>${innerHtml}</blockquote>`;
      case 'rule':
        return '<hr />';
      case 'hardBreak':
        return '<br />';
      case 'mention': {
        const name = (attrs && (attrs.text || attrs.id)) || '';
        return `<span class="bjwt-mention">@${escapeHtml(name)}</span>`;
      }
      case 'inlineCard': {
        const url = (attrs && attrs.url) || '#';
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
      }
      case 'table':
        return `<div class="bjwt-table-wrap"><table>${innerHtml}</table></div>`;
      case 'tableRow':
        return `<tr>${innerHtml}</tr>`;
      case 'tableHeader':
        return `<th>${innerHtml}</th>`;
      case 'tableCell':
        return `<td>${innerHtml}</td>`;
      default:
        return innerHtml;
    }
  }

  /**
   * 將 ADF 節點結構轉換為適合在編輯器文字框中編輯的純文字 / Markdown 內容
   *
   * @param {Object|Array|string|null} node - ADF 節點結構
   * @returns {string} 純文字或 Markdown 格式字串
   */
  function adfToPlainText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) {
      return node.map(adfToPlainText).join('');
    }

    const { type, text, content } = node;
    if (type === 'text') return text || '';
    if (type === 'hardBreak') return '\n';
    if (type === 'rule') return '\n---\n';
    if (type === 'mention') {
      const name = (node.attrs && (node.attrs.text || node.attrs.id)) || '';
      return `@${name}`;
    }

    const inner = Array.isArray(content) ? content.map(adfToPlainText).join('') : '';

    switch (type) {
      case 'doc':
        return inner.trim();
      case 'paragraph':
        return inner ? `${inner}\n\n` : '\n';
      case 'heading':
        return `${inner}\n\n`;
      case 'bulletList':
      case 'orderedList':
        return `${inner}\n`;
      case 'listItem':
        return `• ${inner.trim()}\n`;
      case 'codeBlock':
        return `\`\`\`\n${inner}\n\`\`\`\n\n`;
      case 'blockquote':
        return `> ${inner}\n\n`;
      default:
        return inner;
    }
  }

  /**
   * 格式化卡片詳細說明內容為 HTML 呈現
   *
   * @param {Object|string|null} rawDesc - 原始說明資料 (可能是 ADF 物件或純文字)
   * @param {string|null} [renderedDesc=null] - Jira API 渲染後之 HTML 說明
   * @returns {string} 最終可用的 HTML 字串
   */
  function formatDescriptionHtml(rawDesc, renderedDesc) {
    const { escapeHtml } = BetterJira.TextUtils;

    if (renderedDesc && typeof renderedDesc === 'string' && renderedDesc.trim()) {
      return renderedDesc;
    }
    if (!rawDesc) {
      return '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
    }
    if (typeof rawDesc === 'object' && rawDesc.type === 'doc') {
      const html = adfToHtml(rawDesc);
      return html || '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
    }
    if (typeof rawDesc === 'string') {
      const trimmed = rawDesc.trim();
      if (!trimmed) {
        return '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
      }
      return trimmed
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
        .join('');
    }
    return '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
  }

  /**
   * 格式化單一留言內容為 HTML
   * 支援 Jira API renderedFields 回傳之 HTML、ADF 富文字結構與一般純文字 (避免雙重 escapeHtml 導致顯示 HTML 程式碼)
   *
   * @param {Object} comment - 留言物件
   * @param {string|null} [renderedBody=null] - Jira renderedFields 回傳之渲染後 HTML
   * @returns {string} HTML 格式的留言內容
   */
  function formatCommentBody(comment, renderedBody = null) {
    const { escapeHtml } = BetterJira.TextUtils;

    if (!comment) return '';

    // 1. 若顯式提供 renderedBody，或 comment 物件自帶 renderedBody，直接輸出渲染後之 HTML
    const htmlCandidate = renderedBody || comment.renderedBody;
    if (htmlCandidate && typeof htmlCandidate === 'string' && htmlCandidate.trim()) {
      return htmlCandidate;
    }

    const body = comment.body;
    if (!body) return '';

    // 2. 若為 ADF (Atlassian Document Format) doc 物件結構，遞迴轉為 HTML
    if (typeof body === 'object' && body.type === 'doc') {
      return adfToHtml(body);
    }

    // 3. 若為字串型態
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (!trimmed) return '';
      // 若字串含有 HTML 標籤結構（例如 Jira renderedFields 回傳之 <p>...</p>），直接輸出 HTML，避免二次 escapeHtml
      const isHtml = /<\/?(?:p|div|span|a|ul|ol|li|table|tr|td|th|strong|b|em|i|code|pre|blockquote|h[1-6]|br|hr)\b/i.test(trimmed);
      if (isHtml || comment.isRendered) {
        return trimmed;
      }
      return escapeHtml(trimmed).replace(/\n/g, '<br />');
    }
    return '';
  }

  BetterJira.AdfParser = {
    adfToHtml,
    adfToPlainText,
    formatDescriptionHtml,
    formatCommentBody
  };
})();
