/**
 * 纯文本隔离 HTML 解析器（浏览器与 Node 共用同一套实现）：
 * - 不调用浏览器 DOMParser，不创建任何真实 DOM 节点；
 * - 绝不执行脚本，绝不触发 <img>/<link>/<video> 等子资源网络请求（Safari/Chrome/Edge 行为完全一致）；
 * - 显式限制输入大小与节点总数，防止畸形大文档耗尽内存。
 */

import { LIMITS } from './model.js';

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const BLOCK_BREAK_TAGS = new Set(['BR', 'P', 'DIV', 'LI', 'TR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function decodeHtmlEntities(str) {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });
}

function parseAttributes(attrStr) {
  const attrs = Object.create(null);
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(attrStr))) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = decodeHtmlEntities(val);
  }
  return attrs;
}

class InertNode {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = attrs;
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
  }

  get id() {
    return this.attrs.id || '';
  }

  get className() {
    return this.attrs.class || '';
  }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }

  get textContent() {
    let out = '';
    for (const child of this.childNodes) {
      if (typeof child === 'string') out += child;
      else if (child.tagName === 'BR') out += '\n';
      else if (!RAW_TEXT_TAGS.has(child.tagName.toLowerCase())) out += child.textContent;
    }
    return out;
  }

  matchesSimpleSelector(sel) {
    const trimmed = sel.trim();
    if (!trimmed) return false;
    let rest = trimmed;

    const attrMatches = [];
    rest = rest.replace(/\[([^\]]+)\]/g, (_, inner) => {
      attrMatches.push(inner.trim());
      return '';
    });

    let reqId = null;
    rest = rest.replace(/#([\w-]+)/g, (_, id) => {
      reqId = id;
      return '';
    });

    const reqClasses = [];
    rest = rest.replace(/\.([\w-]+)/g, (_, cls) => {
      reqClasses.push(cls);
      return '';
    });

    const reqTag = rest.trim().toUpperCase();
    if (reqTag && reqTag !== '*' && this.tagName !== reqTag) return false;
    if (reqId !== null && this.id !== reqId) return false;

    if (reqClasses.length > 0) {
      const clsSet = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const c of reqClasses) {
        if (!clsSet.has(c)) return false;
      }
    }

    for (const am of attrMatches) {
      const eqIdx = am.indexOf('=');
      if (eqIdx === -1) {
        if (this.getAttribute(am) === null) return false;
      } else {
        const k = am.slice(0, eqIdx).trim();
        const v = am.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (this.getAttribute(k) !== v) return false;
      }
    }

    return true;
  }

  matchesSelector(selector) {
    const groups = selector.split(',').map((s) => s.trim()).filter(Boolean);
    for (const group of groups) {
      const parts = group.split(/\s+/).filter(Boolean);
      if (parts.length === 0) continue;
      if (!this.matchesSimpleSelector(parts[parts.length - 1])) continue;
      if (parts.length === 1) return true;

      let ancestor = this.parentNode;
      let idx = parts.length - 2;
      while (ancestor && idx >= 0) {
        if (ancestor.matchesSimpleSelector(parts[idx])) {
          idx -= 1;
        }
        ancestor = ancestor.parentNode;
      }
      if (idx < 0) return true;
    }
    return false;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }
}

/**
 * 跨环境一致地按 <br> / <p> / <div> 等显式换行节点提取纯文本行，
 * 避免浏览器 textContent 吞掉 <br> 导致字段黏连。
 */
export function extractTextLines(node) {
  const lines = [];
  let buf = '';

  const flush = () => {
    const cleaned = buf.replace(/[\u00A0\u3000]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned) lines.push(cleaned);
    buf = '';
  };

  const walk = (n) => {
    if (!n) return;
    if (typeof n === 'string') {
      const parts = n.split(/\r?\n/);
      for (let i = 0; i < parts.length; i += 1) {
        if (i > 0) flush();
        buf += parts[i];
      }
      return;
    }
    // 兼容标准浏览器 DOM Node 与 InertNode
    if (n.nodeType === 3) {
      walk(n.nodeValue || '');
      return;
    }
    const tag = String(n.tagName || '').toUpperCase();
    if (RAW_TEXT_TAGS.has(tag.toLowerCase())) return;
    if (tag === 'BR' || tag === 'HR') {
      flush();
      return;
    }
    const isBlock = BLOCK_BREAK_TAGS.has(tag);
    if (isBlock) flush();
    for (const child of n.childNodes || []) {
      walk(child);
    }
    if (isBlock) flush();
  };

  walk(node);
  flush();
  return lines;
}

/**
 * 将外部 HTML 文本解析为纯 JS 只读元素树（零浏览器 DOM，零网络子资源加载）。
 */
export function parseInertHtmlDocument(html) {
  const text = String(html || '');
  if (text.length > LIMITS.MAX_HTML_BYTES) {
    throw new Error(`HTML 内容超过安全上限（最大 ${Math.round(LIMITS.MAX_HTML_BYTES / 1024 / 1024)} MB）。`);
  }

  const root = new InertNode('#document');
  const stack = [root];
  let nodeCount = 0;

  const src = text.replace(/<!--[\s\S]*?-->/g, '');
  const tokenRe = /<\/?([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;

  let lastIndex = 0;
  let skipRawTag = null;
  let m;

  while ((m = tokenRe.exec(src))) {
    const full = m[0];
    const isClose = full.startsWith('</');
    const tag = m[1].toLowerCase();
    const attrStr = m[2] || '';
    const selfClose = m[3] === '/' || VOID_TAGS.has(tag);

    if (skipRawTag) {
      if (isClose && tag === skipRawTag) {
        skipRawTag = null;
      }
      lastIndex = tokenRe.lastIndex;
      continue;
    }

    if (m.index > lastIndex) {
      const piece = decodeHtmlEntities(src.slice(lastIndex, m.index));
      if (piece) stack[stack.length - 1].childNodes.push(piece);
    }

    if (isClose) {
      for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].tagName.toLowerCase() === tag) {
          stack.length = i;
          break;
        }
      }
    } else {
      if (RAW_TEXT_TAGS.has(tag)) {
        if (!selfClose) skipRawTag = tag;
        lastIndex = tokenRe.lastIndex;
        continue;
      }

      nodeCount += 1;
      if (nodeCount > LIMITS.MAX_HTML_NODES) {
        throw new Error(`HTML 标签节点数超过安全上限（最大 ${LIMITS.MAX_HTML_NODES} 个节点）。`);
      }

      const topTag = stack[stack.length - 1].tagName.toLowerCase();
      if (tag === 'p' && topTag === 'p') stack.pop();
      if ((tag === 'td' || tag === 'th') && (topTag === 'td' || topTag === 'th')) stack.pop();
      if (tag === 'tr') {
        while (stack.length > 1 && ['td', 'th', 'tr'].includes(stack[stack.length - 1].tagName.toLowerCase())) {
          stack.pop();
        }
      }

      const node = new InertNode(tag, parseAttributes(attrStr));
      const parent = stack[stack.length - 1];
      node.parentNode = parent;
      parent.children.push(node);
      parent.childNodes.push(node);
      if (!selfClose && stack.length < 128) stack.push(node);
    }

    lastIndex = tokenRe.lastIndex;
  }

  if (!skipRawTag && lastIndex < src.length) {
    const tail = decodeHtmlEntities(src.slice(lastIndex));
    if (tail) stack[stack.length - 1].childNodes.push(tail);
  }

  return root;
}
