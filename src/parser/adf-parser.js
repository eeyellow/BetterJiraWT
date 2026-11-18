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

    const { type, text, content, marks, attrs } = node;
    if (type === 'text') {
      let val = text || '';
      if (Array.isArray(marks)) {
        for (const mark of marks) {
          if (mark.type === 'code') val = `\`${val}\``;
          else if (mark.type === 'strong') val = `**${val}**`;
          else if (mark.type === 'em') val = `*${val}*`;
          else if (mark.type === 'strike') val = `~~${val}~~`;
          else if (mark.type === 'link' && mark.attrs && mark.attrs.href) {
            val = `[${val}](${mark.attrs.href})`;
          }
        }
      }
      return val;
    }
    if (type === 'hardBreak') return '\n';
    if (type === 'rule') return '\n---\n';
    if (type === 'mention') {
      const name = (attrs && (attrs.text || attrs.id)) || '';
      return `@${name}`;
    }
    if (type === 'inlineCard') {
      const url = (attrs && attrs.url) || '';
      return url ? `[${url}](${url})` : '';
    }

    if (type === 'orderedList' && Array.isArray(content)) {
      return (
        content
          .map((item, idx) => {
            const itemInner = Array.isArray(item.content) ? item.content.map(adfToPlainText).join('') : '';
            return `${idx + 1}. ${itemInner.trim()}\n`;
          })
          .join('') + '\n'
      );
    }

    const inner = Array.isArray(content) ? content.map(adfToPlainText).join('') : '';

    switch (type) {
      case 'doc':
        return inner.trim();
      case 'paragraph':
        return inner ? `${inner}\n\n` : '\n';
      case 'heading': {
        const level = Math.min(Math.max((attrs && attrs.level) || 2, 1), 6);
        return `${'#'.repeat(level)} ${inner.trim()}\n\n`;
      }
      case 'bulletList':
      case 'orderedList':
        return `${inner}\n`;
      case 'listItem':
        return `- ${inner.trim()}\n`;
      case 'codeBlock': {
        const lang = (attrs && attrs.language) || '';
        return `\`\`\`${lang}\n${inner}\n\`\`\`\n\n`;
      }
      case 'blockquote':
        return `> ${inner.trim().replace(/\n/g, '\n> ')}\n\n`;
      default:
        return inner;
    }
  }

  /**
   * 判斷文字是否包含常見 Markdown 語法特徵
   *
   * @param {string} text - 原始文字
   * @returns {boolean}
   */
  function hasMarkdownSyntax(text) {
    if (!text || typeof text !== 'string') return false;
    return /(^|\n)\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+|```|---+\s*$)|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]]+\]\([^)]+\)/m.test(
      text
    );
  }

  /**
   * 判斷 HTML 字串是否已經過 Jira 伺服器端富文字渲染（包含圖片、清單、標題、粗體、底線等標籤）
   *
   * @param {string} html - renderedFields 回傳之 HTML 字串
   * @returns {boolean}
   */
  function hasJiraRenderedHtml(html) {
    if (!html || typeof html !== 'string') return false;
    return /<(?:img|ul|ol|li|h[1-6]|strong|b|u|em|i|code|pre|blockquote|table|a|span)\b/i.test(html);
  }

  /**
   * 從附件清單中依據檔名尋找對應的圖片或檔案下載網址
   *
   * @param {string} filename - 附件檔名
   * @param {Array<Object>|null} attachments - 卡片附件清單
   * @returns {string|null} 附件 URL
   */
  function resolveAttachmentUrl(filename, attachments) {
    if (!filename || !Array.isArray(attachments) || attachments.length === 0) return null;
    const target = String(filename).trim();
    const exact = attachments.find((att) => att && att.filename === target);
    const match = exact || attachments.find((att) => att && att.filename && att.filename.toLowerCase() === target.toLowerCase());
    if (!match) return null;
    return match.content || match.thumbnail || null;
  }

  /**
   * 解析 Jira Wiki 圖片屬性字串 (例如 width=565,alt="image.png")
   *
   * @param {string} attrStr - 屬性字串
   * @returns {{width: string|null, alt: string|null}}
   */
  function parseJiraWikiImageAttrs(attrStr) {
    const result = { width: null, alt: null };
    if (!attrStr || typeof attrStr !== 'string') return result;
    const widthMatch = attrStr.match(/(?:^|,|\s)width\s*=\s*"?(\d+)"?/i);
    if (widthMatch) result.width = widthMatch[1];
    const altMatch = attrStr.match(/(?:^|,|\s)alt\s*=\s*"([^"]*)"/i) || attrStr.match(/(?:^|,|\s)alt\s*=\s*([^,\s]+)/i);
    if (altMatch) result.alt = altMatch[1];
    return result;
  }

  /**
   * 驗證連結 URL 是否為安全協定 (http, https, 相對路徑或錨點)
   *
   * @param {string} url - 網址字串
   * @returns {string} 安全網址或 '#'
   */
  function sanitizeLinkUrl(url) {
    const trimmed = String(url || '').trim();
    if (/^(https?:\/\/|\/|#)/i.test(trimmed)) {
      return trimmed;
    }
    return '#';
  }

  /**
   * 將單行純文字中的行內 Markdown / Jira Wiki 語法轉換為安全 HTML
   *
   * @param {string} text - 原始純文字
   * @param {Array<Object>|null} [attachments=null] - 卡片附件清單 (供解析 Jira Wiki 圖片語法)
   * @returns {string} HTML 字串
   */
  function formatInlineMarkdown(text, attachments = null) {
    const { escapeHtml } = BetterJira.TextUtils;
    if (!text) return '';

    const placeholders = [];
    const pushPlaceholder = (html) => {
      const token = `\u0000MDPH${placeholders.length}\u0000`;
      placeholders.push(html);
      return token;
    };

    let processed = String(text);

    // 1. 先抽離行內程式碼 `code`，避免內部符號被當作粗體或斜體
    processed = processed.replace(/`([^`\n]+)`/g, (_, code) =>
      pushPlaceholder(`<code>${escapeHtml(code)}</code>`)
    );

    // 2. Markdown 圖片 ![alt](url)
    processed = processed.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
      const resolved = resolveAttachmentUrl(url, attachments) || url;
      const safeUrl = escapeHtml(sanitizeLinkUrl(resolved));
      return pushPlaceholder(`<img class="bjwt-md-image" src="${safeUrl}" alt="${escapeHtml(alt)}" />`);
    });

    // 2.5 Jira Wiki 圖片 !filename.png|width=565,alt="..."! 或 !https://...!
    processed = processed.replace(
      /!([^\s!|][^!\n|]*?\.(?:png|jpe?g|gif|webp|svg|bmp)|https?:\/\/[^\s!|]+)(?:\|([^!\n]*))?!/gi,
      (fullMatch, target, attrStr) => {
        const resolvedUrl = /^https?:\/\//i.test(target)
          ? target
          : resolveAttachmentUrl(target, attachments);
        if (!resolvedUrl) {
          return fullMatch;
        }
        const parsedAttrs = parseJiraWikiImageAttrs(attrStr);
        const safeUrl = escapeHtml(sanitizeLinkUrl(resolvedUrl));
        const altText = escapeHtml(parsedAttrs.alt || target);
        const widthAttr = parsedAttrs.width ? ` width="${escapeHtml(parsedAttrs.width)}"` : '';
        return pushPlaceholder(`<img class="bjwt-md-image" src="${safeUrl}" alt="${altText}"${widthAttr} />`);
      }
    );

    // 3. 超連結 [label](url)
    processed = processed.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const safeUrl = escapeHtml(sanitizeLinkUrl(url));
      return pushPlaceholder(
        `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      );
    });

    // 4. HTML 安全跳脫
    processed = escapeHtml(processed);

    // 5. Jira Wiki 粗體+底線 (+*text*+)、刪除線、粗體、斜體
    processed = processed.replace(/\+\*([^*\n]+)\*\+/g, '<u><strong>$1</strong></u>');
    processed = processed.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    processed = processed.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    processed = processed.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    processed = processed.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

    // 6. 還原 placeholders
    return processed.replace(/\u0000MDPH(\d+)\u0000/g, (_, idx) => placeholders[Number(idx)] || '');
  }

  /**
   * 將完整 Markdown 文字安全轉換為 HTML
   * 支援標題、粗體、斜體、刪除線、行內程式碼、程式碼區塊、清單、引用、分隔線、圖片與超連結
   *
   * @param {string} markdownText - Markdown 純文字
   * @param {Array<Object>|null} [attachments=null] - 卡片附件清單
   * @returns {string} HTML 字串
   */
  function markdownToHtml(markdownText, attachments = null) {
    const { escapeHtml } = BetterJira.TextUtils;
    if (!markdownText || typeof markdownText !== 'string') return '';

    const normalized = markdownText.replace(/\r\n/g, '\n');
    const codeBlocks = [];
    const withPlaceholders = normalized.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const token = `\u0000MDCB${codeBlocks.length}\u0000`;
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
      return `\n${token}\n`;
    });

    const lines = withPlaceholders.split('\n');
    const out = [];
    let listType = null;
    let paragraphBuf = [];
    let quoteBuf = [];

    const flushParagraph = () => {
      if (paragraphBuf.length > 0) {
        out.push(`<p>${paragraphBuf.map((l) => formatInlineMarkdown(l, attachments)).join('<br />')}</p>`);
        paragraphBuf = [];
      }
    };
    const flushList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };
    const flushQuote = () => {
      if (quoteBuf.length > 0) {
        out.push(`<blockquote><p>${quoteBuf.map((l) => formatInlineMarkdown(l, attachments)).join('<br />')}</p></blockquote>`);
        quoteBuf = [];
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        flushParagraph();
        flushList();
        flushQuote();
        continue;
      }

      const cbMatch = trimmed.match(/^\u0000MDCB(\d+)\u0000$/);
      if (cbMatch) {
        flushParagraph();
        flushList();
        flushQuote();
        out.push(codeBlocks[Number(cbMatch[1])] || '');
        continue;
      }

      const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        flushQuote();
        const level = headingMatch[1].length;
        out.push(`<h${level}>${formatInlineMarkdown(headingMatch[2].trim(), attachments)}</h${level}>`);
        continue;
      }

      if (/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        flushParagraph();
        flushList();
        flushQuote();
        out.push('<hr />');
        continue;
      }

      const quoteMatch = line.match(/^\s{0,3}>\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        quoteBuf.push(quoteMatch[1]);
        continue;
      }
      flushQuote();

      const ulMatch = line.match(/^\s*[-*+]\s+(.+)$/);
      if (ulMatch) {
        flushParagraph();
        if (listType !== 'ul') {
          flushList();
          listType = 'ul';
          out.push('<ul>');
        }
        out.push(`<li>${formatInlineMarkdown(ulMatch[1], attachments)}</li>`);
        continue;
      }

      const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
      if (olMatch) {
        flushParagraph();
        if (listType !== 'ol') {
          flushList();
          listType = 'ol';
          out.push('<ol>');
        }
        out.push(`<li>${formatInlineMarkdown(olMatch[1], attachments)}</li>`);
        continue;
      }

      flushList();
      paragraphBuf.push(line);
    }

    flushParagraph();
    flushList();
    flushQuote();

    return out.join('');
  }

  /**
   * 將純文字中的行內 Markdown 轉為 ADF inline 節點陣列
   *
   * @param {string} text - 單行文字
   * @returns {Array<Object>} ADF text 節點陣列
   */
  function parseInlineMarkdownToAdf(text) {
    if (!text) return [];
    const nodes = [];
    const inlineRegex = /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/g;
    let lastIndex = 0;
    let match;

    while ((match = inlineRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
      }
      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'code' }] });
      } else if (token.startsWith('**') && token.endsWith('**')) {
        nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'strong' }] });
      } else if (token.startsWith('~~') && token.endsWith('~~')) {
        nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'strike' }] });
      } else if (token.startsWith('*') && token.endsWith('*')) {
        nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'em' }] });
      } else {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (linkMatch) {
          nodes.push({
            type: 'text',
            text: linkMatch[1],
            marks: [{ type: 'link', attrs: { href: sanitizeLinkUrl(linkMatch[2]) } }]
          });
        } else {
          nodes.push({ type: 'text', text: token });
        }
      }
      lastIndex = inlineRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      nodes.push({ type: 'text', text: text.slice(lastIndex) });
    }
    return nodes;
  }

  /**
   * 將 Markdown 文字轉換為 Jira v3 API 所需的 ADF (Atlassian Document Format) 文件物件
   *
   * @param {string} markdownText - Markdown 純文字
   * @returns {Object} ADF document 物件
   */
  function markdownToAdf(markdownText) {
    const normalized = String(markdownText || '').replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const content = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      const fenceMatch = line.match(/^\s*```([a-zA-Z0-9_-]*)\s*$/);
      if (fenceMatch) {
        const lang = fenceMatch[1] || undefined;
        const codeLines = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        i += 1;
        const codeNode = {
          type: 'codeBlock',
          content: [{ type: 'text', text: codeLines.join('\n') }]
        };
        if (lang) codeNode.attrs = { language: lang };
        content.push(codeNode);
        continue;
      }

      const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        content.push({
          type: 'heading',
          attrs: { level: headingMatch[1].length },
          content: parseInlineMarkdownToAdf(headingMatch[2].trim())
        });
        i += 1;
        continue;
      }

      if (/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        content.push({ type: 'rule' });
        i += 1;
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+(.+)$/.test(lines[i])) {
          const itemText = lines[i].replace(/^\s*[-*+]\s+/, '');
          items.push({
            type: 'listItem',
            content: [{ type: 'paragraph', content: parseInlineMarkdownToAdf(itemText) }]
          });
          i += 1;
        }
        content.push({ type: 'bulletList', content: items });
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+(.+)$/.test(lines[i])) {
          const itemText = lines[i].replace(/^\s*\d+\.\s+/, '');
          items.push({
            type: 'listItem',
            content: [{ type: 'paragraph', content: parseInlineMarkdownToAdf(itemText) }]
          });
          i += 1;
        }
        content.push({ type: 'orderedList', content: items });
        continue;
      }

      if (/^\s{0,3}>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s{0,3}>\s?(.*)$/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        content.push({
          type: 'blockquote',
          content: [{ type: 'paragraph', content: parseInlineMarkdownToAdf(quoteLines.join(' ')) }]
        });
        continue;
      }

      content.push({
        type: 'paragraph',
        content: parseInlineMarkdownToAdf(line)
      });
      i += 1;
    }

    return {
      type: 'doc',
      version: 1,
      content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }]
    };
  }

  /**
   * 格式化卡片詳細說明內容為 HTML 呈現
   *
   * @param {Object|string|null} rawDesc - 原始說明資料 (可能是 ADF 物件或純文字/Markdown)
   * @param {string|null} [renderedDesc=null] - Jira API 渲染後之 HTML 說明
   * @param {Array<Object>|null} [attachments=null] - 卡片附件清單 (供無 renderedDesc 時解析圖片)
   * @returns {string} 最終可用的 HTML 字串
   */
  function formatDescriptionHtml(rawDesc, renderedDesc, attachments = null) {
    // 若原始內容為 Markdown 且 Jira v2 renderedDesc 不存在或尚未被 Jira 渲染為富文字標籤，優先以 Markdown 渲染
    if (typeof rawDesc === 'string' && rawDesc.trim() && hasMarkdownSyntax(rawDesc)) {
      if (!renderedDesc || (!hasJiraRenderedHtml(renderedDesc) && hasMarkdownSyntax(renderedDesc.replace(/<[^>]+>/g, '')))) {
        return markdownToHtml(rawDesc, attachments);
      }
    }
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
      return markdownToHtml(trimmed, attachments);
    }
    return '<div class="bjwt-detail-empty-desc">此工作項目沒有提供詳細說明。</div>';
  }

  /**
   * 從 img 元素或附件清單推導 Jira Wiki 圖片標記 (!filename|width=...,alt="..."!)
   *
   * @param {Element} imgEl - img DOM 元素
   * @param {Array<Object>|null} attachments - 卡片附件清單
   * @returns {string} Jira Wiki 圖片語法
   */
  function imgElementToJiraWiki(imgEl, attachments = null) {
    if (!imgEl || typeof imgEl.getAttribute !== 'function') return '';
    const src = imgEl.getAttribute('src') || '';
    const altAttr = imgEl.getAttribute('alt') || '';
    const dataName = imgEl.getAttribute('data-attachment-name') || '';
    let filename = dataName || altAttr;

    if (!filename && src && Array.isArray(attachments)) {
      const idMatch = src.match(/\/attachment\/(?:content|thumbnail)\/(\d+)/i);
      const found = attachments.find(
        (att) =>
          att &&
          (att.content === src ||
            att.thumbnail === src ||
            (idMatch && String(att.id) === String(idMatch[1])))
      );
      if (found && found.filename) {
        filename = found.filename;
      }
    }

    const target = filename || src;
    if (!target) return '';

    const widthAttr = imgEl.getAttribute('width');
    const styleWidth = imgEl.style && imgEl.style.width ? String(imgEl.style.width).replace(/px$/i, '') : '';
    const widthVal = widthAttr || (/^\d+$/.test(styleWidth) ? styleWidth : '');

    if (widthVal && /^\d+$/.test(String(widthVal))) {
      const safeAlt = (altAttr || target).replace(/"/g, "'");
      return `!${target}|width=${widthVal},alt="${safeAlt}"!`;
    }
    return `!${target}!`;
  }

  /**
   * 將所見即所得編輯器 (contenteditable) 的 HTML DOM 樹轉換回 Jira Wiki Markup 純文字
   *
   * @param {Element|null} rootEl - 編輯器根元素
   * @param {Array<Object>|null} [attachments=null] - 卡片附件清單
   * @returns {string} Jira Wiki Markup 字串
   */
  function htmlToJiraWiki(rootEl, attachments = null) {
    if (!rootEl) return '';

    const serializeChildren = (parent, listDepth = 0) => {
      const nodes = parent.childNodes && parent.childNodes.length > 0 ? Array.from(parent.childNodes) : (parent.children || []);
      if (nodes.length === 0) {
        return parent.textContent || '';
      }
      return nodes.map((child) => serializeNode(child, listDepth)).join('');
    };

    const serializeNode = (node, listDepth = 0) => {
      if (!node) return '';
      // Text node (nodeType === 3)
      if (node.nodeType === 3) {
        return String(node.nodeValue || '').replace(/\u00A0/g, ' ');
      }
      // Skip non-element nodes other than text
      if (node.nodeType && node.nodeType !== 1) return '';

      const tag = (node.tagName || '').toLowerCase();
      if (!tag) {
        return node.textContent || '';
      }

      if (tag === 'br') {
        return '\n';
      }
      if (tag === 'hr') {
        return '\n----\n';
      }
      if (tag === 'img') {
        return imgElementToJiraWiki(node, attachments);
      }

      if (tag === 'strong' || tag === 'b') {
        const inner = serializeChildren(node, listDepth);
        if (!inner) return '';
        const childEls = node.children || [];
        if (childEls.length === 1 && (childEls[0].tagName || '').toLowerCase() === 'u') {
          return inner;
        }
        return `*${inner}*`;
      }
      if (tag === 'u') {
        const inner = serializeChildren(node, listDepth);
        if (!inner) return '';
        const childEls = node.children || [];
        if (
          childEls.length === 1 &&
          ((childEls[0].tagName || '').toLowerCase() === 'strong' || (childEls[0].tagName || '').toLowerCase() === 'b')
        ) {
          const boldInner = serializeChildren(childEls[0], listDepth);
          return `+*${boldInner}*+`;
        }
        return `+${inner}+`;
      }
      if (tag === 'em' || tag === 'i') {
        const inner = serializeChildren(node, listDepth);
        return inner ? `_${inner}_` : '';
      }
      if (tag === 's' || tag === 'del' || tag === 'strike') {
        const inner = serializeChildren(node, listDepth);
        return inner ? `-${inner}-` : '';
      }
      if (tag === 'code') {
        const parentTag = node.parentElement ? (node.parentElement.tagName || '').toLowerCase() : '';
        if (parentTag === 'pre') {
          return node.textContent || '';
        }
        const inner = serializeChildren(node, listDepth);
        return inner ? `{{${inner}}}` : '';
      }
      if (tag === 'pre') {
        const codeText = (node.textContent || '').replace(/^\n+|\n+$/g, '');
        return `\n{code}\n${codeText}\n{code}\n`;
      }
      if (tag === 'blockquote') {
        const inner = serializeChildren(node, listDepth).trim();
        return `\n{quote}\n${inner}\n{quote}\n`;
      }
      if (tag === 'a') {
        const childImgs = typeof node.querySelectorAll === 'function' ? node.querySelectorAll('img') : [];
        const textOnly = (node.textContent || '').trim();
        if (childImgs && childImgs.length > 0 && !textOnly) {
          return Array.from(childImgs).map((im) => imgElementToJiraWiki(im, attachments)).join('');
        }
        const href = typeof node.getAttribute === 'function' ? node.getAttribute('href') || '' : '';
        const inner = serializeChildren(node, listDepth).trim();
        if (!href) return inner;
        if (!inner || inner === href) return `[${href}]`;
        return `[${inner}|${href}]`;
      }
      if (/^h([1-6])$/.test(tag)) {
        const level = tag.slice(1);
        const inner = serializeChildren(node, listDepth).trim();
        return inner ? `\nh${level}. ${inner}\n` : '';
      }
      if (tag === 'ul' || tag === 'ol') {
        const markerChar = tag === 'ol' ? '#' : '*';
        const prefix = markerChar.repeat(listDepth + 1);
        const items = Array.from(node.children || []).filter((c) => (c.tagName || '').toLowerCase() === 'li');
        const lines = items.map((li) => {
          const liNodes = li.childNodes && li.childNodes.length > 0 ? Array.from(li.childNodes) : (li.children || []);
          let textPart = '';
          let subListPart = '';
          if (liNodes.length === 0) {
            textPart = li.textContent || '';
          } else {
            for (const ch of liNodes) {
              const chTag = ch.tagName ? ch.tagName.toLowerCase() : '';
              if (chTag === 'ul' || chTag === 'ol') {
                subListPart += serializeNode(ch, listDepth + 1);
              } else {
                textPart += serializeNode(ch, listDepth);
              }
            }
          }
          const cleanText = textPart.replace(/\n+$/, '').trim();
          return `${prefix} ${cleanText}\n${subListPart}`;
        });
        return (listDepth === 0 ? '\n' : '') + lines.join('');
      }
      if (tag === 'p' || tag === 'div') {
        const inner = serializeChildren(node, listDepth).replace(/\n+$/, '');
        if (!inner.trim()) return '\n';
        return `${inner}\n`;
      }
      return serializeChildren(node, listDepth);
    };

    const raw = serializeChildren(rootEl, 0);
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * 格式化單一留言內容為 HTML
   * 支援 Jira API renderedFields 回傳之 HTML、ADF 富文字結構與 Markdown / 一般純文字
   *
   * @param {Object} comment - 留言物件
   * @param {string|null} [renderedBody=null] - Jira renderedFields 回傳之渲染後 HTML
   * @returns {string} HTML 格式的留言內容
   */
  function formatCommentBody(comment, renderedBody = null) {
    if (!comment) return '';

    const body = comment.body;

    // 若原始留言為 Markdown 且 renderedBody 仍保留原始 Markdown 符號，優先以 Markdown 渲染
    if (typeof body === 'string' && body.trim() && hasMarkdownSyntax(body)) {
      const isHtml = /<\/?(?:p|div|span|a|ul|ol|li|table|tr|td|th|strong|b|em|i|code|pre|blockquote|h[1-6]|br|hr)\b/i.test(body);
      if (!isHtml && !comment.isRendered) {
        if (!renderedBody || (!hasJiraRenderedHtml(renderedBody) && hasMarkdownSyntax(renderedBody.replace(/<[^>]+>/g, '')))) {
          return markdownToHtml(body);
        }
      }
    }

    // 1. 若顯式提供 renderedBody，或 comment 物件自帶 renderedBody，直接輸出渲染後之 HTML
    const htmlCandidate = renderedBody || comment.renderedBody;
    if (htmlCandidate && typeof htmlCandidate === 'string' && htmlCandidate.trim()) {
      return htmlCandidate;
    }

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
      return markdownToHtml(trimmed);
    }
    return '';
  }

  BetterJira.AdfParser = {
    adfToHtml,
    adfToPlainText,
    markdownToHtml,
    markdownToAdf,
    formatDescriptionHtml,
    formatCommentBody,
    htmlToJiraWiki
  };
})();
