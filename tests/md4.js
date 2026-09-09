/**
 * md v4.0.1 - a markdown streaming parser
 * Copyright (c) 2025-2026, Alphons van der Heijden
 * https://git.heijden.com/alphons/MarkdownStreamer.git
 */

'use strict';

// ─── Module-level constants ────────────────────────────────────────────────────
const ENTITY_MAP = {
  '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"',"&apos;":"'",'&nbsp;':'\u00a0',
  '&copy;':'©','&reg;':'®','&trade;':'™','&euro;':'€','&pound;':'£','&yen;':'¥',
  '&mdash;':'—','&ndash;':'–','&laquo;':'«','&raquo;':'»','&hellip;':'…',
  '&rarr;':'→','&larr;':'←','&uarr;':'↑','&darr;':'↓',
  '&times;':'×','&divide;':'÷','&plusmn;':'±','&deg;':'°',
  '&frac12;':'½','&frac14;':'¼','&frac34;':'¾','&hearts;':'♥','&spades;':'♠',
};
const BLOCK_TAGS = new Set(['details','summary','figure','figcaption','aside','section','article','div','table','thead','tbody','tr','td','th','ul','ol','li','dl','dt','dd','form','nav','header','footer','main','blockquote','pre','hr','h1','h2','h3','h4','h5','h6']);

// ─── DomStack ─────────────────────────────────────────────────────────────────
class DomStack {
  constructor(root) { this.current = root; this.bottomStack = root; }

  push(nodeName) {
    const el = document.createElement(nodeName);
    this.current.appendChild(el);
    this.current = el;
    return el;
  }

  pop() {
    if (this.current !== this.bottomStack && this.current.parentNode)
      this.current = this.current.parentNode;
    return this.current;
  }

  popTo(el) { this.current = el; }
  toRoot()  { this.current = this.bottomStack; }
  currentTag() { return this.current.nodeName; }

  find(tag) {
    const t = tag.toUpperCase();
    let el = this.current;
    while (el) {
      if (el.nodeName === t) return el;
      if (el === this.bottomStack) break;
      el = el.parentNode;
    }
    return null;
  }

  depth() {
    let d = 1, el = this.current;
    while (el !== this.bottomStack && el.parentNode) { d++; el = el.parentNode; }
    return d;
  }

  replaceAt(oldEl, newEl) { if (this.current === oldEl) this.current = newEl; }
}

// ─── MarkdownStreamer ──────────────────────────────────────────────────────────
class MarkdownStreamer {
  constructor(rootEl) {
    rootEl.innerHTML = '';
    this.root = rootEl;
    this.dom  = new DomStack(rootEl);

    this.linePos = 0; this.lineIndent = 0; this.blockDecided = false;
    this.pending = ''; this.lastBlockEl = null; this.lineStart = true;
    this.listStack = [];
    this.inlinePending = ''; this.textNode = null;
    this.escapeNext = false; this.entityBuf = null;
    this.autolinkBuf = null;
    this.bareUrlBuf = null; this.bareUrlOpen = false; this.prevCharWs = true;
    this.linkState = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
    this.refDefs = {};
    this.inCodeFence = false; this.inIndentCode = false; this.pendingIndentNL = 0;
    this.fenceChar = '`'; this.fencePrefix = ''; this.closingFenceBuf = null;
    this.inTable = false; this.tableHeadDone = false; this.tableColAlign = [];
    this.tableColIndex = 0; this.inCell = false; this.tablePipePending = false;
    this._resetSetext(); this._resetHr();
    this.trailingSpaces = 0;
    this.taskCheckBuf = null; this.taskCheckDone = false;
    this.footnoteDefs = {}; this.footnoteOrder = []; this.inFootnoteDef = false; this.footnoteDefId = '';
    this.abbrMap = {};
    this.defPending = null;
    this.inRawHtml = false; this.rawHtmlBuf = ''; this.rawHtmlTag = null;

    this.sepWatch = false; this.sepFailed = false; this.sepRowEl = null; this.sepBuf = '';
    this.needsJoinSpace = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  _bd()              { this.blockDecided = true; this.pending = ''; }
  _pop(el)           { this.dom.popTo(el); this.dom.pop(); }
  _popMarkers()      { while (this.dom.current._mdMarker) this.dom.pop(); }
  _resetLinkUrl()    { this.linkState = null; this.urlBuf = ''; this.textNode = null; }
  _resetSetext()     { this.setextWatch = false; this.setextBuf = ''; this.setextChar = ''; this.setextFailed = false; }
  _resetHr()         { this.hrWatch = false; this.hrChar = ''; this.hrCount = 0; this.hrFailed = false; }
  _doneTaskCheck()   { this.taskCheckDone = true; this.taskCheckBuf = null; }
  _bqLevel(p)   {
    let level = 0, i = 0;
    while (i < p.length && p[i] === '>') { level++; i++; if (i < p.length && p[i] === ' ') i++; }
    return { level, i };
  }

  // ── Public processChar ─────────────────────────────────────────────────────
  processChar(ch) {
    if (ch === '\n') { this.onNewline(); return; }
    if (this.inCodeFence) {
      if (this.fencePrefix === null) { this.feedCodeFenceLine(ch); return; }
      this.fencePrefix += ch; return;
    }
    if (this.inRawHtml) { this.rawHtmlBuf += ch; return; }

    this.linePos++;
    if (this.lineStart) this.lineStart = false;

    if (!this.blockDecided) {
      if (ch === ' ' && this.linePos === this.lineIndent + 1) {
        this.lineIndent++;
        if (this.lineIndent === 4 && this.dom.currentTag() !== 'LI') {
          if (!this.inIndentCode) {
            this.closeBlock();
            const pre = this.dom.push('pre');
            const code = document.createElement('code');
            pre.appendChild(code);
            this.textNode = document.createTextNode(''); code.appendChild(this.textNode);
            this.inIndentCode = true; this.lastBlockEl = pre;
          }
          this._bd(); this.lineIndent = 0;
        }
        return;
      }
      this.inIndentCode = false; this.pendingIndentNL = 0;
      this.decideBlock(ch); return;
    }

    if (ch === ' ') this.trailingSpaces++;
    else            this.trailingSpaces = 0;
    this.onContentChar(ch);
  }

  // ── Newline ────────────────────────────────────────────────────────────────
  onNewline() {
    this.needsJoinSpace = false;
    if (this.defPending) { this.flushDefPending(); this.resetLine(); return; }

    if (this.sepWatch && this.inTable) {
      this.sepWatch = false;
      if (!this.sepFailed && this.sepRowEl) {
        this.applyTableSep('|' + this.sepBuf);
        const tr = this.sepRowEl;
        this._pop(tr); tr.remove();
        const thead = this.dom.find('THEAD');
        if (thead) this._pop(thead);
        this.tableHeadDone = true;
        const tbody = document.createElement('tbody');
        this.dom.find('TABLE').appendChild(tbody); this.dom.current = tbody;
        this.textNode = null; this.inCell = false; this.tablePipePending = false; this.tableColIndex = 0;
        this.sepRowEl = null; this.resetLine(); return;
      }
      this.sepRowEl = null;
    }

    if (this.inCodeFence) { this.onCodeFenceNewline(); return; }
    if (this.inIndentCode) {
      if (!this.blockDecided) this.pendingIndentNL++;
      else { if (this.textNode) this.textNode.data += '\n'.repeat(this.pendingIndentNL) + '\n'; this.pendingIndentNL = 0; }
      this.resetLine(); return;
    }
    if (this.inRawHtml) {
      this.rawHtmlBuf += '\n';
      if (!this.rawHtmlTag) {
        const m = this.rawHtmlBuf.match(/^<([a-zA-Z][a-zA-Z0-9-]*)/);
        this.rawHtmlTag = m ? m[1].toLowerCase() : null;
      }
      if (this.rawHtmlTag && new RegExp('<\\/' + this.rawHtmlTag + '\\s*>$', 'i').test(this.rawHtmlBuf.trimEnd()))
        this.flushRawHtml();
      return;
    }

    if (this.setextWatch) {
      if (!this.setextFailed && this.setextBuf.length >= 1) this.resolveSetext(this.setextChar === '=' ? 'h1' : 'h2');
      else this.flushSetextAsFallback();
      this._resetSetext();
      this.needsJoinSpace = this.dom.currentTag() === 'P';
      this.resetLine(); return;
    }
    if (this.hrWatch) {
      if (!this.hrFailed && this.hrCount >= 3) this.makeHr();
      else this.flushHrAsFallback();
      this._resetHr();
      this.needsJoinSpace = this.dom.currentTag() === 'P';
      this.resetLine(); return;
    }

    if (!this.blockDecided && this.pending) {
      const p = this.pending;
      if (p[0] === '>') {
        const { level } = this._bqLevel(p);
        if (level > 0) { this.ensureBlockquote(level); this.openParagraph(); }
      } else if ((p[0] === '`' || p[0] === '~') && p.length >= 3 && p.split('').every(c => c === p[0])) {
        this.closeBlock(); this.inCodeFence = true; this.fenceChar = p[0];
        this.fenceCount = p.length; this.fencePrefix = null; this.closingFenceBuf = null;
        this.onCodeFenceNewline();
      } else if (p[0] === '*' && /^\*{3,}$/.test(p)) {
        this.makeHr();
      } else if (p[0] === '-' && /^-{3,}$/.test(p)) {
        if (this.lastBlockEl?.tagName === 'P') this.resolveSetext('h2');
        else this.makeHr();
      } else if (/^[_ ]+$/.test(p) && (p.match(/_/g)||[]).length >= 3) {
        this.makeHr();
      } else if (/^- (- ?)+$/.test(p.trimEnd()) && (p.match(/-/g)||[]).length >= 3) {
        this.makeHr();
      } else if (p[0] === '-' && /^- /.test(p)) {
        this.openUlDecided(p.slice(2));
      } else if (p[0] === '[') {
        const tag = this.dom.currentTag();
        if (tag === 'P' || tag === 'LI' || tag === 'DD') { this.feedPendingAsInline(); this.blockDecided = true; }
        else this.fallbackToParagraph();
      }
      this.pending = '';
    }

    if (!this.blockDecided) {
      const tag = this.dom.currentTag();
      if      (tag === 'P')  { this.dom.pop(); this.textNode = null; }
      else if (tag === 'LI') { this.dom.toRoot(); this.listStack = []; this.textNode = null; }
      else if (tag === 'DD') { this.dom.toRoot(); this.textNode = null; }
      this.resetLine(); return;
    }

    let hardBreak = false;
    if ((this.trailingSpaces >= 2 || this.escapeNext) && this.blockDecided) {
      if (this.textNode) this.textNode.data = this.textNode.data.replace(/ +$/, '');
      this.dom.current.appendChild(document.createElement('br'));
      this.textNode = null;
      hardBreak = true;
    }
    this.escapeNext = false;

    if (this.bareUrlOpen) {
      const a = this.dom.find('A');
      if (a && !a.href) { a.href = a.textContent.trim(); this._pop(a); }
      this._resetBareUrl();
    }

    this.flushInlinePending();
    if (this.linkState === 'expect_paren') {
      const a = this.dom.find('A');
      if (a && !a.href) { a.dataset.implicitRef = this.linkBuf.toLowerCase(); this._pop(a); }
      this._resetLinkUrl();
    } else if (this.linkState !== null) {
      this.abortLinkElement(null);
    }

    if (this.atxLevel && this.textNode)
      this.textNode.data = this.textNode.data.replace(/\s+#+\s*$/, '').replace(/\s+#+$/, '');
    this.atxLevel = 0;
    this.textNode = null;

    this._popMarkers();
    if (this.inFootnoteDef) { this.dom.toRoot(); this.inFootnoteDef = false; this.footnoteDefId = ''; }
    const tag = this.dom.currentTag();
    this.needsJoinSpace = !hardBreak && (tag === 'P' || tag === 'LI' || tag === 'DD');
    this.resetLine();
  }

  resetLine() {
    this.linePos = 0; this.lineIndent = 0; this.blockDecided = false;
    this.pending = ''; this.inlinePending = ''; this.atxLevel = 0;
    this.linkState = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
    this.inCell = false; this.tablePipePending = false; this.trailingSpaces = 0;
    this.lineStart = true; this.prevCharWs = true; this.bareUrlBuf = null;
    this.escapeNext = false; this.entityBuf = null; this.autolinkBuf = null;
    this.taskCheckBuf = null; this.taskCheckDone = false;
  }

  // ── Block decision ─────────────────────────────────────────────────────────
  _blockDefault(ch) {
    if (this.defPending) { this.defPending.value += ch; return; }
    const tag = this.dom.currentTag();
    if (tag === 'P' || tag === 'LI' || tag === 'DD') { this.feedPendingAsInline(); this.blockDecided = true; return; }
    this.fallbackToParagraph();
  }

  decideBlock(ch) {
    if (this.needsJoinSpace) { this.needsJoinSpace = false; this.appendToTextNode(' '); }
    this.pending += ch;
    const p = this.pending;

    switch (p[0]) {
      case '#':
        if (ch === '#' && p.length <= 6) return;
        if (ch === ' ' && p.length >= 2 && /^#{1,6}$/.test(p.slice(0,-1))) {
          const level = p.length - 1;
          this.closeBlock(); this.listStack = [];
          const h = this.dom.push('h' + Math.min(level, 6)); this.lastBlockEl = h;
          this._bd(); this.atxLevel = level; return;
        }
        if (ch !== '#') this._blockDefault(ch);
        return;

      case '>': {
        const { level, i } = this._bqLevel(p);
        if (i === p.length) return;
        this.ensureBlockquote(level); this.openParagraph(); this._bd();
        for (const c of p.slice(i)) this.onInlineChar(c);
        return;
      }

      case '`':
      case '~': {
        const fc = p[0];
        if (p.length < 3) return;
        if (p.split('').every(c => c === fc)) return;
        const fenceCount = p.length - 1;
        if (fenceCount >= 3) {
          this.closeBlock(); this.inCodeFence = true; this.fenceChar = fc;
          this.fenceCount = fenceCount; this.fencePrefix = ch; this.closingFenceBuf = null;
          this._bd(); return;
        }
        this._blockDefault(ch); return;
      }

      case '|':
        if (!this.inTable) { this.closeBlock(); this.openTable(); }
        else this.startTableRow();
        this._bd(); this.openTableCell(); return;

      case '*': {
        // Abbreviation definition *[Abbr]:
        if (p[1] === '[') {
          const ci = p.indexOf(']:');
          if (ci > 2) { this.defPending = { type: 'abbr', key: p.slice(2, ci), value: '' }; this._bd(); return; }
          const bracketIdx = p.indexOf(']', 2);
          if (bracketIdx === -1) return;
          if (p.length === bracketIdx + 1) return;
          this._blockDefault(ch); return;
        }
        // Unordered list / thematic break
        if (p.length === 1) return;
        if (p.length === 2) {
          if (p[1] === ' ') return this.openUlDecided('');
          if (p[1] !== '*') return this._blockDefault(ch);
          return;
        }
        if (p.length === 3) { if (p === '***') return; this._blockDefault(ch); return; }
        if (p.length === 4) {
          if (p[3] === ' ' || p[3] === '*') return this.startHrWatch('*', p.split('*').length - 1, false);
          this._blockDefault(ch); return;
        }
        this._blockDefault(ch); return;
      }

      case '-':
        if (p.length === 1) return;
        if (p.length === 2) {
          if (p[1] === ' ') return;
          if (this.lastBlockEl?.tagName === 'P') return this.startSetextWatch('-', p, p[1] !== '-');
          return this.startHrWatch('-', 2, p[1] !== '-');
        }
        if (p.length === 3) {
          if (p === '- -' || p === '- *') return;
          if (p[1] === ' ' && p[2] !== '-' && p[2] !== ' ') return this.openUlDecided(p[2]);
          if (p[1] === ' ' && p[2] === ' ') return;
          return (this.lastBlockEl?.tagName === 'P')
            ? this.startSetextWatch('-', p, false)
            : this.startHrWatch('-', p.split('-').length - 1, false);
        }
        if (p.length === 4) {
          if (p === '- - ') return;
          if (p.startsWith('- -')) return this.startHrWatch('-', 2, false);
          return this.openUlDecided(p.slice(2));
        }
        if (/^(- )+$/.test(p) || /^(- )+-?$/.test(p)) return;
        if (/^- /.test(p)) return this.openUlDecided(p.slice(2));
        return this.startHrWatch('-', (p.match(/-/g)||[]).length, false);

      case '+':
        if (p.length === 1) return;
        if (p[1] === ' ') { this.openUlDecided(p.slice(2)); return; }
        this._blockDefault(ch); return;

      case '_':
        if (/^[_ ]+$/.test(p)) return;
        this._blockDefault(ch); return;

      case '=':
        if (this.lastBlockEl?.tagName === 'P') { this.startSetextWatch('=', p, ch !== '='); return; }
        this._blockDefault(ch); return;

      case '[': {
        if (p[1] === '^') {
          // Footnote definition [^id]:
          const ci = p.indexOf(']:');
          if (ci !== -1 && ci >= 3) {
            const id = p.slice(2, ci);
            this.closeBlock();
            if (!this.footnoteDefs[id]) {
              const span = document.createElement('span');
              span.dataset.fn = id; span.style.display = 'none';
              this.root.appendChild(span);
              this.footnoteDefs[id] = span; this.footnoteOrder.push(id);
            }
            this.dom.toRoot(); this.dom.current = this.footnoteDefs[id];
            this.inFootnoteDef = true; this.footnoteDefId = id;
            this._bd(); return;
          }
          if (!p.includes(']') || p[p.length - 1] === ']') return;
          this._blockDefault(ch); return;
        }
        // Reference link definition [label]:
        if (!p[1]) return;
        const ci = p.indexOf(']:');
        if (ci > 1) { this.defPending = { type: 'ref', key: p.slice(1, ci).toLowerCase(), value: '' }; this._bd(); return; }
        if (!p.includes(']') || p[p.length - 1] === ']') return;
        this._blockDefault(ch); return;
      }

      case '<': {
        if (p.length === 1) return;
        if (p.startsWith('<!--')) {
          if (p.endsWith('-->')) { this._bd(); return; }
          if (p.length < 7) return;
          this.closeBlock(); this.inRawHtml = true; this.rawHtmlBuf = p; this.rawHtmlTag = '!--';
          this._bd(); return;
        }
        if (p.search(/[>\s/]/, 1) === -1) return;
        const m = p.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
        if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
          this.closeBlock(); this.inRawHtml = true; this.rawHtmlBuf = p; this.rawHtmlTag = null;
          this._bd(); return;
        }
        this._blockDefault(ch); return;
      }

      case ':': {
        if (p.length === 1) return;
        if (p[1] === ' ' && this.lastBlockEl) {
          if (this.lastBlockEl.tagName === 'P') { this.convertLastPToDt(); this._bd(); return; }
          if (this.lastBlockEl.tagName === 'DD') {
            const dlEl = this.dom.find('DL');
            if (dlEl) {
              this.dom.popTo(dlEl);
              const dd = this.dom.push('dd'); this.lastBlockEl = dd; this.textNode = null;
              this._bd(); return;
            }
          }
        }
        this._blockDefault(ch); return;
      }

      default:
        // Ordered list
        if (p[0] >= '1' && p[0] <= '9') {
          let i = 1;
          while (i < p.length && p[i] >= '0' && p[i] <= '9') i++;
          if (i === p.length) return;
          if (i > 9 || (p[i] !== '.' && p[i] !== ')')) { this._blockDefault(ch); return; }
          if (i + 1 === p.length) return;
          if (p[i + 1] === ' ') { this.openListItem('ol', this.lineIndent); this._bd(); return; }
          this._blockDefault(ch); return;
        }
        this._blockDefault(ch);
    }
  }

  // ── Content chars ──────────────────────────────────────────────────────────
  onContentChar(ch) {
    if (this.sepWatch && this.inTable) {
      this.sepBuf += ch;
      if (ch !== '-' && ch !== ':' && ch !== ' ' && ch !== '|') this.sepFailed = true;
    }
    if (this.setextWatch) {
      if (ch === this.setextChar) this.setextBuf += ch;
      else { this.setextFailed = true; this.setextBuf += ch; }
      return;
    }
    if (this.hrWatch) {
      if (ch === this.hrChar) this.hrCount++;
      else if (ch !== ' ') this.hrFailed = true;
      return;
    }
    if (this.defPending) { this.defPending.value += ch; return; }
    if (this.inTable && ch === '|') {
      this.flushInlinePending();
      if (this.bareUrlOpen) this.closeBareUrl();
      this.textNode = null;
      if (this.inCell) { this.dom.pop(); this.inCell = false; }
      this.tablePipePending = true; this.tableColIndex++;
      return;
    }
    if (this.inTable && this.tablePipePending) { this.tablePipePending = false; this.openTableCell(); }
    this.onInlineChar(ch);
  }

  // ── Inline state machine ───────────────────────────────────────────────────
  onInlineChar(ch) {
    // Task list checkbox
    if (this.taskCheckBuf !== null && !this.taskCheckDone) {
      this.taskCheckBuf += ch;
      const b = this.taskCheckBuf;
      if (b.length === 1 && b !== '[') {
        this._doneTaskCheck(); // fall through
      } else if (b.length <= 3 && !['[ ','[x','[X','[ ]','[x]','[X]'].some(s => b === s || s.startsWith(b))) {
        this._doneTaskCheck(); this.writeText(b); return;
      } else if (b.length === 4) {
        if (b === '[ ] ' || b === '[x] ' || b === '[X] ') {
          const li = this.dom.find('LI');
          if (li) li.classList.add('task-item');
          const cb = document.createElement('input');
          cb.type = 'checkbox'; cb.disabled = true; cb.checked = b[1].toLowerCase() === 'x';
          this.dom.current.appendChild(cb); this.textNode = null;
        } else { this.writeText(b); }
        this._doneTaskCheck(); return;
      } else { return; }
      // b.length===1 && b!=='[': fall through to normal inline
    }

    // Inline code
    if (this.dom.current._mdMarker === '`') {
      if (ch === '`') { this.dom.pop(); this.textNode = null; }
      else this.appendToTextNode(ch);
      return;
    }

    if (this.linkState !== null) { this.onLinkChar(ch); return; }

    // Backslash escape
    if (this.escapeNext) { this.escapeNext = false; this.appendToTextNode(ch); this.prevCharWs = false; return; }
    if (ch === '\\') { this.escapeNext = true; return; }

    // HTML entity
    if (this.entityBuf !== null) {
      this.entityBuf += ch;
      if (ch === ';') { this.writeText(this.decodeEntity(this.entityBuf)); this.entityBuf = null; this.prevCharWs = false; return; }
      if (this.entityBuf.length > 12) { this.writeText(this.entityBuf); this.entityBuf = null; }
      return;
    }
    if (ch === '&') { this.entityBuf = '&'; return; }

    // Autolink / inline HTML
    if (this.autolinkBuf !== null) {
      if (this.autolinkBuf === '!-' && ch === '-') { this.autolinkBuf = '!--'; return; }
      if (this.autolinkBuf.startsWith('!--')) {
        this.autolinkBuf += ch;
        if (this.autolinkBuf.endsWith('-->')) { this.autolinkBuf = null; this.prevCharWs = false; }
        return;
      }
      if (ch === '>') {
        const buf = this.autolinkBuf;
        if (buf.startsWith('/') && /^\/\w+$/.test(buf)) {
          const el = this.dom.find(buf.slice(1).toUpperCase());
          if (el) this._pop(el);
          this.textNode = null; this.autolinkBuf = null; this.prevCharWs = false; return;
        }
        const tagMatch = buf.match(/^(\w+)(\s|$)/);
        const knownInline = ['KBD','SPAN','SUP','SUB','ABBR','CITE','CODE','B','I','U','S','MARK','SMALL','DEL','INS','Q','VAR'];
        if (tagMatch && knownInline.includes(tagMatch[1].toUpperCase())) {
          this.dom.push(tagMatch[1]); this.textNode = null;
          this.autolinkBuf = null; this.prevCharWs = false; return;
        }
        if (buf.includes('://') || buf.includes('@')) {
          const a = document.createElement('a');
          a.href = buf.includes('@') && !buf.startsWith('http') ? 'mailto:' + buf : buf;
          this.initAnchor(a); a.appendChild(document.createTextNode(buf));
          this.dom.current.appendChild(a); this.textNode = null;
          this.autolinkBuf = null; this.prevCharWs = false; return;
        }
        this.appendToTextNode('<' + buf + '>');
        this.autolinkBuf = null; this.prevCharWs = false; return;
      }
      if (ch === ' ' || ch === '<') {
        this.appendToTextNode('<' + this.autolinkBuf); this.autolinkBuf = null;
        if (ch === '<') this.autolinkBuf = ''; return;
      }
      this.autolinkBuf += ch; return;
    }
    if (ch === '<') { this.autolinkBuf = ''; return; }

    // Bare URL
    if (this.bareUrlOpen) {
      if (ch === ' ' || ch === '\n' || (ch === ')' && !this.bareUrlParens)) {
        this.closeBareUrl();
        if (ch === ' ') this.appendToTextNode(ch);
      } else {
        if (ch === '(') this.bareUrlParens = (this.bareUrlParens || 0) + 1;
        if (ch === ')') this.bareUrlParens = Math.max(0, (this.bareUrlParens || 0) - 1);
        this.appendToTextNode(ch);
      }
      this.prevCharWs = (ch === ' '); return;
    }
    if (this.bareUrlBuf !== null) {
      this.bareUrlBuf += ch;
      const b = this.bareUrlBuf;
      const prefixes = ['https://', 'http://'];
      if (!prefixes.some(pfx => pfx.startsWith(b) || b.startsWith(pfx))) {
        this.writeText(b); this.bareUrlBuf = null; this.prevCharWs = false; return;
      }
      if (prefixes.find(pfx => b.startsWith(pfx))) {
        const a = this.dom.push('a'); this.initAnchor(a);
        this.textNode = null; this.writeText(b);
        this.bareUrlBuf = null; this.bareUrlOpen = true; this.bareUrlParens = 0;
      }
      return;
    }
    if (this.prevCharWs && ch === 'h') { this.bareUrlBuf = 'h'; this.prevCharWs = false; return; }

    // ==highlight==
    if (ch === '=') {
      if (this.inlinePending && this.inlinePending[0] === '=') {
        this.inlinePending += ch;
        if (this.inlinePending.length > 2) this.flushInlinePending();
        return;
      }
      if (!this.inlinePending) { this.inlinePending = '='; return; }
      this.resolveInlinePending(ch); return;
    }

    if (ch === '!') { this.linkState = 'bang'; this.linkIsImage = true; this.prevCharWs = false; return; }
    if (ch === '[') {
      const a = this.dom.push('a'); this.initAnchor(a);
      this.textNode = null;
      this.linkState = 'label_open'; this.urlBuf = ''; this.linkBuf = '';
      this.prevCharWs = false; return;
    }

    if (this.isMarkerChar(ch)) {
      if (this.inlinePending && ch !== this.inlinePending[0]) this.resolveInlinePending(null);
      this.inlinePending += ch;
      this.prevCharWs = false; return;
    }

    if (this.inlinePending) { this.resolveInlinePending(ch); this.prevCharWs = (ch === ' '); return; }
    this.appendToTextNode(ch);
    this.prevCharWs = (ch === ' ');
  }

  isMarkerChar(ch) { return '`*_~^'.includes(ch); }

  closeBareUrl() {
    const a = this.dom.find('A');
    if (a && !a.href) {
      const text = a.textContent;
      const m = text.match(/[.,!?)\]>]+$/);
      if (m) {
        a.textContent = text.slice(0, -m[0].length);
        a.href = a.textContent;
        this._pop(a); this._resetBareUrl();
        this.writeText(m[0]); return;
      }
      a.href = text.trim();
      this._pop(a);
    }
    this._resetBareUrl();
  }
  _resetBareUrl() { this.bareUrlOpen = false; this.bareUrlBuf = null; this.bareUrlParens = 0; this.textNode = null; }

  // ── Link / image state machine ─────────────────────────────────────────────
  onLinkChar(ch) {
    switch (this.linkState) {
      case 'bang':
        if (ch === '[') { this.linkState = 'img_alt'; this.linkBuf = ''; this.urlBuf = ''; }
        else { this.linkState = null; this.linkIsImage = false; this.appendToTextNode('!'); this.onInlineChar(ch); }
        return;

      case 'img_alt':
        if (ch === ']') this.linkState = 'img_expect_paren';
        else this.linkBuf += ch;
        return;

      case 'img_expect_paren':
        if (ch === '(') { this.linkState = 'img_url'; this.urlBuf = ''; }
        else { this.appendToTextNode('![' + this.linkBuf + ']' + ch); this.linkState = null; this.linkIsImage = false; this.linkBuf = ''; }
        return;

      case 'img_url':
        if (ch === ')') {
          const { url: iUrl, title: iTitle } = this._parseUrlBuf();
          const img = document.createElement('img');
          img.src = iUrl; img.alt = this.linkBuf;
          if (iTitle) img.title = iTitle;
          const insideLink = !!this.dom.find('A');
          if (!insideLink) img.className = 'blk';
          this.dom.current.appendChild(img);
          this.textNode = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
          this.linkState = insideLink ? 'label_open' : null;
        } else { this.urlBuf += ch; }
        return;

      case 'label_open':
        if (ch === '!') { this.linkState = 'bang'; this.linkIsImage = true; return; }
        if (ch === ']') {
          this.flushInlinePending();
          this._popMarkers(); this.textNode = null;
          const a = this.dom.find('A'); if (a) this.linkBuf = a.textContent;
          this.linkState = 'expect_paren'; return;
        }
        if (ch === '^' && this.linkBuf === '') {
          this.abortLinkElement(null);
          this.linkState = 'fn_ref'; this.linkBuf = ''; return;
        }
        this.linkState = null; this.onInlineChar(ch); this.linkState = 'label_open';
        return;

      case 'fn_ref':
        if (ch === ']') {
          const id = this.linkBuf;
          const a = document.createElement('a');
          a.className = 'fn-ref'; a.dataset.fnid = id; a.href = '#fn-' + id;
          a.appendChild(document.createTextNode('?'));
          this.dom.current.appendChild(a); this.textNode = null;
          this.linkState = null; this.linkBuf = '';
        } else { this.linkBuf += ch; }
        return;

      case 'expect_paren':
        if (ch === '(') { this.linkState = 'url'; this.urlBuf = ''; }
        else if (ch === '[') { this.linkState = 'ref_id'; this.urlBuf = ''; }
        else {
          const a = this.dom.find('A');
          if (a) { a.dataset.implicitRef = this.linkBuf.toLowerCase(); this._pop(a); }
          this._resetLinkUrl();
          if (ch !== '\n') this.onInlineChar(ch);
        }
        return;

      case 'ref_id':
        if (ch === ']') {
          const refKey = (this.urlBuf.trim() || this.linkBuf.trim()).toLowerCase();
          const url = this.refDefs[refKey];
          const a = this.dom.find('A');
          if (a) {
            if (url) a.href = url;
            else { a.href = '#'; a.dataset.refKey = refKey; }
            this._pop(a);
          }
          this._resetLinkUrl();
        } else { this.urlBuf += ch; }
        return;

      case 'url':
        if (ch === ')') {
          const { url, title } = this._parseUrlBuf();
          const a = this.dom.find('A');
          if (a) { a.href = url; if (title) a.title = title; this._pop(a); }
          this._resetLinkUrl();
        } else { this.urlBuf += ch; }
        return;
    }
  }

  abortLinkElement(extraCh) {
    const a = this.dom.find('A');
    if (a) {
      const parent = a.parentNode;
      if (parent) { while (a.firstChild) parent.insertBefore(a.firstChild, a); parent.removeChild(a); }
      this.dom.current = parent || this.dom.bottomStack;
    }
    this._resetLinkUrl();
    if (extraCh !== null) this.appendToTextNode(extraCh);
  }

  _parseUrlBuf() {
    const raw = this.urlBuf.trim();
    const m = raw.match(/^(.*?)\s+["'](.*?)["']$/);
    return { url: m ? m[1] : raw, title: m ? m[2] : null };
  }

  // ── Resolve inline pending ─────────────────────────────────────────────────
  resolveInlinePending(nextCh) {
    const marker = this.inlinePending; this.inlinePending = '';
    if (marker) {
      if (marker === '***') {
        const closeEl = this.findInlineClose('***');
        if (closeEl !== null) {
          this._pop(closeEl); this.textNode = null;
          if (this.dom.current._mdMarker === '***_em') { this.dom.pop(); this.textNode = null; }
        } else {
          const strong = this.dom.push('strong'); strong._mdMarker = '***'; this.textNode = null;
          const em = this.dom.push('em'); em._mdMarker = '***_em'; this.textNode = null;
        }
      } else {
        const closeEl = this.findInlineClose(marker);
        if (closeEl !== null) {
          this._pop(closeEl); this.textNode = null;
        } else {
          const tag = this.markerToTag(marker);
          if (tag) {
            if (tag === 'strong+em') {
              const strong = this.dom.push('strong'); strong._mdMarker = marker;
              const em = document.createElement('em'); em._mdMarker = '***_em';
              strong.appendChild(em); this.dom.current = em; this.textNode = null;
            } else {
              const el = this.dom.push(tag); el._mdMarker = marker; this.textNode = null;
            }
          } else {
            this.writeText(marker);
          }
        }
      }
    }
    if (nextCh !== null) this.appendToTextNode(nextCh);
  }

  markerToTag(marker) {
    return {'**':'strong','*':'em','__':'u','_':'em','~~':'s','^':'sup','~':'sub','`':'code','==':'mark'}[marker] || null;
  }

  findInlineClose(marker) {
    let el = this.dom.current;
    while (el) {
      if (el._mdMarker === marker) return el;
      if (el === this.dom.bottomStack) break;
      el = el.parentNode;
    }
    return null;
  }

  flushInlinePending() {
    if (!this.inlinePending) return;
    const marker = this.inlinePending; this.inlinePending = '';
    const closeEl = this.findInlineClose(marker);
    if (closeEl !== null) { this._pop(closeEl); this.textNode = null; }
    else this.writeText(marker);
  }

  // ── Small shared helpers ───────────────────────────────────────────────────
  makeHr()              { this.closeBlock(); this.dom.current.appendChild(document.createElement('hr')); this.lastBlockEl = null; }
  fallbackToParagraph() { this.closeBlock(); this.openParagraph(); this.blockDecided = true; this.feedPendingAsInline(); }
  initAnchor(a)         { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  flushDefPending()     { if (!this.defPending) return; const d = this.defPending; if (d.type === 'ref') this.refDefs[d.key] = d.value.trim(); if (d.type === 'abbr') this.abbrMap[d.key] = d.value.trim(); this.defPending = null; }
  startHrWatch(c,n,f)   { this.hrWatch = true; this.hrChar = c; this.hrCount = n; this.hrFailed = f; this._bd(); }
  startSetextWatch(c,b,f){ this.setextWatch = true; this.setextChar = c; this.setextBuf = b; this.setextFailed = f; this._bd(); }
  openUlDecided(s)      { this.openListItem('ul', this.lineIndent); this._bd(); for (const c of s) this.onInlineChar(c); }

  // ── Entity decoder ─────────────────────────────────────────────────────────
  decodeEntity(raw) {
    if (ENTITY_MAP[raw]) return ENTITY_MAP[raw];
    if (raw.startsWith('&#x')) try { return String.fromCodePoint(parseInt(raw.slice(3,-1), 16)); } catch(e) {}
    if (raw.startsWith('&#'))  try { return String.fromCodePoint(parseInt(raw.slice(2,-1), 10));  } catch(e) {}
    return raw;
  }

  // ── Text helpers ───────────────────────────────────────────────────────────
  writeText(str) {
    if (!this.textNode) { this.textNode = document.createTextNode(''); this.dom.current.appendChild(this.textNode); }
    this.textNode.data += str;
  }
  appendToTextNode(ch) { this.writeText(ch); }
  feedPendingAsInline() { const s = this.pending; this.pending = ''; for (const ch of s) this.onInlineChar(ch); }

  // ── Code fence ─────────────────────────────────────────────────────────────
  onCodeFenceNewline() {
    if (!this.dom.find('PRE')) {
      const lang = (this.fencePrefix || '').trim().split(/\s+/)[0];
      this.fencePrefix = null;
      const pre = this.dom.push('pre');
      const code = document.createElement('code');
      if (lang) code.className = 'language-' + lang;
      pre.appendChild(code);
      this.textNode = document.createTextNode(''); code.appendChild(this.textNode);
      this.closingFenceBuf = ''; return;
    }
    if (this.closingFenceBuf === this.fenceChar.repeat(this.fenceCount || 3)) {
      this.inCodeFence = false; this.closingFenceBuf = null; this.textNode = null;
      const pre = this.dom.find('PRE'); if (pre) this._pop(pre);
      this.lastBlockEl = null; this.resetLine(); return;
    }
    if (this.textNode) this.textNode.data += '\n';
    this.closingFenceBuf = '';
  }

  feedCodeFenceLine(ch) {
    this.closingFenceBuf += ch;
    const fc = this.fenceCount || 3;
    const fence = this.fenceChar.repeat(fc);
    if (this.closingFenceBuf === fence) return;
    if (this.closingFenceBuf.startsWith(this.fenceChar) && this.closingFenceBuf.length <= fc) return;
    if (this.textNode) this.textNode.data += ch;
  }

  // ── Raw HTML passthrough ───────────────────────────────────────────────────
  flushRawHtml() {
    try {
      const doc = new DOMParser().parseFromString(this.rawHtmlBuf.trim(), 'text/html');
      const body = doc.body;
      while (body.firstChild) this.dom.current.appendChild(document.adoptNode(body.firstChild));
    } catch(e) { this.writeText(this.rawHtmlBuf); }
    this.inRawHtml = false; this.rawHtmlBuf = ''; this.rawHtmlTag = null; this.resetLine();
  }

  // ── Block helpers ──────────────────────────────────────────────────────────
  closeBlock() {
    this.flushInlinePending();
    if (this.bareUrlOpen) this.closeBareUrl();
    this._popMarkers();
    this.textNode = null;
    if (this.dom.depth() > 1) this.dom.toRoot();
    if (this.inTable) { this.inTable = false; this.tableHeadDone = false; this.inCell = false; this.tableColAlign = []; this.tableColIndex = 0; }
    this.inFootnoteDef = false;
    this.inIndentCode = false; this.pendingIndentNL = 0;
  }

  openParagraph() { const p = this.dom.push('p'); this.lastBlockEl = p; this.textNode = null; }

  ensureBlockquote(level) {
    this.flushInlinePending();
    this._popMarkers();
    this.textNode = null;
    if (this.dom.currentTag() === 'P') this.dom.pop();
    let depth = 0, _e = this.dom.current;
    while (_e) { if (_e.tagName === 'BLOCKQUOTE') depth++; if (_e === this.dom.bottomStack) break; _e = _e.parentNode; }
    if (depth === 0 && this.dom.depth() > 1) this.dom.toRoot();
    while (depth < level) { this.dom.push('blockquote'); depth++; }
    while (depth > level) {
      if (this.dom.currentTag() === 'P') this.dom.pop();
      if (this.dom.currentTag() === 'BLOCKQUOTE') this.dom.pop();
      depth--;
    }
  }

  convertLastPToDt() {
    const p = this.lastBlockEl;
    const prev = p?.previousElementSibling;
    const dl = (prev?.tagName === 'DL') ? prev : (() => {
      const newDl = document.createElement('dl');
      if (p?.parentNode) p.parentNode.insertBefore(newDl, p);
      else this.dom.current.appendChild(newDl);
      return newDl;
    })();
    const dt = document.createElement('dt');
    while (p?.firstChild) dt.appendChild(p.firstChild);
    p?.parentNode?.removeChild(p);
    dl.appendChild(dt);
    if (this.dom.current === p) this.dom.current = dl;
    const dd = this.dom.push('dd'); this.lastBlockEl = dd; this.textNode = null;
  }

  openListItem(type, indent) {
    this._popMarkers();
    this.textNode = null;
    if (this.listStack.length === 0) {
      const tag = this.dom.currentTag();
      if (!['UL','OL','LI'].includes(tag)) this.closeBlock();
      this.pushNewList(type, indent);
    } else {
      const top = this.listStack[this.listStack.length - 1];
      if (indent > top.indent) {
        this.pushNewList(type, indent);
      } else {
        if (indent < top.indent) {
          while (this.listStack.length > 1 && this.listStack[this.listStack.length - 1].indent > indent) {
            this.listStack.pop();
            if (this.dom.currentTag() === 'LI') this.dom.pop();
            if (['UL','OL'].includes(this.dom.currentTag())) this.dom.pop();
          }
        }
        if (this.dom.currentTag() === 'LI') this.dom.pop();
        const now = this.listStack[this.listStack.length - 1];
        if (now.type !== type) {
          if (['UL','OL'].includes(this.dom.currentTag())) this.dom.pop();
          this.listStack.pop(); this.pushNewList(type, indent);
        }
      }
    }
    const li = this.dom.push('li'); this.lastBlockEl = li;
    this.taskCheckBuf = ''; this.taskCheckDone = false;
  }

  pushNewList(type, indent) {
    const list = this.dom.push(type);
    this.listStack.push({ el: list, type, indent });
  }

  // ── Setext ─────────────────────────────────────────────────────────────────
  resolveSetext(tag) {
    const p = this.lastBlockEl;
    if (!p || p.tagName !== 'P') return;
    const h = document.createElement(tag);
    while (p.firstChild) h.appendChild(p.firstChild);
    p.parentNode.replaceChild(h, p);
    this.dom.replaceAt(p, h);
    this.lastBlockEl = h; this.textNode = null;
  }
  _appendOrNewParagraph(text) {
    const tag = this.dom.currentTag();
    if (tag === 'P' || tag === 'LI' || tag === 'DD') { this.writeText(text); return; }
    this.closeBlock(); this.openParagraph(); this.writeText(text);
  }
  flushSetextAsFallback() { this._appendOrNewParagraph(this.setextBuf); }
  flushHrAsFallback()     { this._appendOrNewParagraph(this.hrChar.repeat(this.hrCount)); }

  // ── Table ──────────────────────────────────────────────────────────────────
  openTable() {
    this.inTable = true; this.tableHeadDone = false; this.tableColAlign = []; this.tableColIndex = 0;
    this.dom.push('table'); this.dom.push('thead'); this.dom.push('tr');
  }

  startTableRow() {
    const tr = this.dom.find('TR');
    if (tr) this._pop(tr);
    this.textNode = null; this.inCell = false; this.tableColIndex = 0;
    const container = this.dom.find(this.tableHeadDone ? 'TBODY' : 'THEAD');
    if (container) this.dom.popTo(container);
    this.dom.push('tr');
    this.sepWatch = true; this.sepFailed = false;
    this.sepRowEl = this.dom.find('TR'); this.sepBuf = '';
  }

  openTableCell() {
    const tag  = this.tableHeadDone ? 'td' : 'th';
    const cell = this.dom.push(tag);
    const align = this.tableColAlign[this.tableColIndex] || '';
    if (align) cell.className = 'align-' + align;
    this.textNode = null; this.inCell = true;
  }

  applyTableSep(buf) {
    const cells = buf.replace(/^\||\|$/g, '').split('|');
    this.tableColAlign = cells.map(c => {
      c = c.trim();
      if (c.startsWith(':') && c.endsWith(':')) return 'center';
      if (c.endsWith(':'))   return 'right';
      if (c.startsWith(':')) return 'left';
      return '';
    });
    const thead = this.dom.find('THEAD');
    if (thead) thead.querySelectorAll('th').forEach((th, i) => { if (this.tableColAlign[i]) th.className = 'align-' + this.tableColAlign[i]; });
  }

  // ── Finalize ───────────────────────────────────────────────────────────────
  finalize() {
    this.flushDefPending();
    this.flushInlinePending();
    if (this.bareUrlOpen) this.closeBareUrl();
    this.textNode = null;

    this.root.querySelectorAll('a[href="#"]').forEach(a => {
      const key = a.dataset.refKey || a.textContent.trim().toLowerCase();
      if (this.refDefs[key]) { a.href = this.refDefs[key]; delete a.dataset.refKey; }
    });

    this.root.querySelectorAll('a[data-implicit-ref]').forEach(a => {
      const key = a.dataset.implicitRef;
      if (this.refDefs[key]) {
        a.href = this.refDefs[key]; a.removeAttribute('data-implicit-ref');
      } else {
        const parent = a.parentNode;
        if (parent) {
          parent.insertBefore(document.createTextNode('[' + a.textContent + ']'), a);
          parent.removeChild(a);
        }
      }
    });

    if (Object.keys(this.abbrMap).length > 0) this.applyAbbrs(this.root);
    this.renderFootnotes();
  }

  applyAbbrs(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!node.parentElement) continue;
      const tag = node.parentElement.tagName;
      if (['CODE','PRE','A','ABBR','KBD'].includes(tag)) continue;
      let segments = [{text: node.data, title: null}];
      for (const [abbr, title] of Object.entries(this.abbrMap)) {
        const re = new RegExp('(?<![\\w])' + abbr.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?![\\w])', 'g');
        const next = [];
        for (const seg of segments) {
          if (seg.title !== null) { next.push(seg); continue; }
          let last = 0; re.lastIndex = 0; let m;
          while ((m = re.exec(seg.text)) !== null) {
            if (m.index > last) next.push({text: seg.text.slice(last, m.index), title: null});
            next.push({text: m[0], title});
            last = m.index + m[0].length;
          }
          if (last < seg.text.length) next.push({text: seg.text.slice(last), title: null});
          else if (last === 0) next.push(seg);
        }
        segments = next;
      }
      if (segments.length === 1 && segments[0].title === null) continue;
      const frag = document.createDocumentFragment();
      for (const seg of segments) {
        if (seg.title === null) frag.appendChild(document.createTextNode(seg.text));
        else { const el = document.createElement('abbr'); el.title = seg.title; el.appendChild(document.createTextNode(seg.text)); frag.appendChild(el); }
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  renderFootnotes() {
    if (!this.footnoteOrder.length) return;
    const idToNum = {}; let num = 1;
    this.root.querySelectorAll('.fn-ref').forEach(ref => {
      const id = ref.dataset.fnid;
      if (!idToNum[id]) idToNum[id] = num++;
      ref.textContent = '[' + idToNum[id] + ']';
      ref.href = '#fn-' + id;
    });
    const section = document.createElement('div');
    section.className = 'footnotes';
    const ol = document.createElement('ol');
    section.appendChild(ol);
    for (const id of this.footnoteOrder) {
      if (!idToNum[id]) continue;
      const li = document.createElement('li'); li.id = 'fn-' + id;
      const span = this.footnoteDefs[id];
      if (span) { while (span.firstChild) li.appendChild(span.firstChild); span.remove(); }
      ol.appendChild(li);
    }
    this.root.appendChild(section);
  }

  // ── Streaming control ──────────────────────────────────────────────────────
  run = true; speed = 100; delay = 0; batch = 4;

  setSpeed(s) { this.speed = s; this.delay = Math.max(0, 80 - s * 0.80); this.batch = s > 80 ? 4 : 1; }
  stop()      { this.run = false; }

  async markdownasync(text) {
    this.run = true;
    for (let index = 0; index < text.length;) {
      if (!this.run) return;
      for (let b = 0; b < this.batch && index < text.length; b++) {
        if (!this.run) return;
        this.processChar(text[index++]);
      }
      if (this.delay > 0) await new Promise(resolve => setTimeout(resolve, this.delay));
    }
  }

  markdown(text) { for (const char of text) this.processChar(char); }
}
