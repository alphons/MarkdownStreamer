/**
 * md v4.0.1 - a markdown streaming parser
 * Copyright (c) 2025-2026, Alphons van der Heijden
 * https://git.heijden.com/alphons/MarkdownStreamer.git
 */

'use strict';

// ─── Module-level constants ────────────────────────────────────────────────────
// CommonMark HTML-block type 6: this exact tag-name list (not "pre" — that's
// type 1 only) makes the block end at the next BLANK LINE, no matching
// closing tag required.
const HTML_BLOCK6_TAGS = new Set(['address','article','aside','base','basefont','blockquote','body','caption','center','col','colgroup','dd','details','dialog','dir','div','dl','dt','fieldset','figcaption','figure','footer','form','frame','frameset','h1','h2','h3','h4','h5','h6','head','header','hr','html','iframe','legend','li','link','main','menu','menuitem','nav','noframes','ol','optgroup','option','p','param','section','summary','table','tbody','td','tfoot','th','thead','title','tr','track','ul']);
// Type 1: ends on a line containing the matching closing tag, not a blank line.
const HTML_BLOCK1_TAGS = new Set(['script','pre','style','textarea']);
const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

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

    this.linePos = 0; this.lineIndent = 0; this.leadingWsChars = 0; this.blockDecided = false;
    this.pending = ''; this.lastBlockEl = null; this.lineStart = true;
    this.listStack = [];
    this.inlinePending = ''; this.textNode = null;
    this.lastChar = undefined; this.pendingDelimBefore = undefined;
    this.escapeNext = false; this.entityBuf = null;
    this.autolinkBuf = null; this.autolinkQuote = null;
    this.bareUrlBuf = null; this.bareUrlOpen = false; this.prevCharWs = true;
    this.linkState = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
    this.refDefs = {};
    this.inCodeFence = false; this.inIndentCode = false; this.pendingIndentNL = 0;
    this.fenceChar = '`'; this.fencePrefix = ''; this.closingFenceBuf = null; this.fenceLineHasContent = false;
    this.inTable = false; this.tableHeadDone = false; this.tableColAlign = [];
    this.tableColIndex = 0; this.inCell = false; this.tablePipePending = false;
    this._resetSetext(); this._resetHr();
    this.trailingSpaces = 0;
    this.taskCheckBuf = null; this.taskCheckDone = false;
    this.footnoteDefs = {}; this.footnoteOrder = []; this.inFootnoteDef = false; this.footnoteDefId = '';
    this.abbrMap = {};
    this.defPending = null;
    this.inRawHtml = false; this.rawHtmlBuf = ''; this.rawHtmlLineBuf = '';
    this.rawHtmlEndMode = null; this.rawHtmlCloseTag = null;

    this.sepWatch = false; this.sepFailed = false; this.sepRowEl = null; this.sepBuf = '';
    this.needsJoinSpace = false; this.hadJoinSpace = false;
    this.codeCloseRun = 0;
    this._inBlockquoteContent = false;
    this.pendingListBlank = false; // NOT reset in resetLine(): set at the end of
    // a blank line (after resetLine already ran for it) and consumed at the
    // start of the NEXT line, so it must survive the resetLine() in between.
    this._blankBeforeNewItem = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  _bd()              { this.blockDecided = true; this.pending = ''; }
  _pop(el)           { this.dom.popTo(el); this.dom.pop(); }
  _popMarkers()      { while (this.dom.current._mdMarker) this.dom.pop(); }
  _resetLinkUrl()    { this.linkState = null; this.urlBuf = ''; this.textNode = null; this._resetUrlParse(); }
  _resetUrlParse()   { this.urlAngle = undefined; this.urlAngleValue = null; this.urlParenDepth = 0; this.urlEscapeNext = false; }
  _resetSetext()     { this.setextWatch = false; this.setextBuf = ''; this.setextChar = ''; this.setextFailed = false; this.setextTrailing = false; }
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
    if (this.inRawHtml) { this.rawHtmlBuf += ch; this.rawHtmlLineBuf += ch; return; }

    this.linePos++;
    if (this.lineStart) this.lineStart = false;

    if (!this.blockDecided) {
      // A tab, for indentation purposes, advances to the next multiple-of-4
      // column rather than counting as a single space (CommonMark: tabs
      // aren't expanded in the output, but do behave like spaces when
      // whitespace defines block structure).
      if ((ch === ' ' || ch === '\t') && this.linePos === this.leadingWsChars + 1) {
        this.leadingWsChars++;
        this.lineIndent = ch === '\t' ? (Math.floor(this.lineIndent / 4) + 1) * 4 : this.lineIndent + 1;
        if (this.lineIndent >= 4 && !['LI', 'P', 'DD'].includes(this.dom.currentTag())) {
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
      if (this.pendingListBlank) {
        this.pendingListBlank = false;
        this._resolveListBlankContinuation(ch);
        return;
      }
      this.decideBlock(ch); return;
    }

    if (ch === ' ') this.trailingSpaces++;
    else            this.trailingSpaces = 0;
    this.onContentChar(ch);
  }

  // ── Newline ────────────────────────────────────────────────────────────────
  onNewline() {
    // Captured before resetting: reflects whether the PREVIOUS line left an
    // open paragraph/list-item/definition wanting a soft-break join space —
    // needed below by _continueOrFallback(), which runs later in this same
    // call (for this line's own unresolved-pending fallback) and would
    // otherwise only ever see the reset value, never the real one.
    this.hadJoinSpace = this.needsJoinSpace;
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
      const line = this.rawHtmlLineBuf;
      this.rawHtmlBuf += '\n';
      this.rawHtmlLineBuf = '';
      if (this.rawHtmlEndMode === 'blank') {
        // Types 6/7 end BEFORE the blank line — it's not part of the block,
        // so undo the "\n" this (blank) line contributed and flush as-is.
        if (line.trim() === '') { this.rawHtmlBuf = this.rawHtmlBuf.slice(0, -1); this.flushRawHtml(); }
        return;
      }
      let closed = false;
      if (this.rawHtmlEndMode === 'tag') closed = new RegExp('</' + this.rawHtmlCloseTag + '\\s*>', 'i').test(line);
      else if (this.rawHtmlEndMode === 'comment') closed = line.includes('-->');
      else if (this.rawHtmlEndMode === 'pi') closed = line.includes('?>');
      else if (this.rawHtmlEndMode === 'decl') closed = line.includes('>');
      else if (this.rawHtmlEndMode === 'cdata') closed = line.includes(']]>');
      if (closed) this.flushRawHtml();
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
      const contTag = this.dom.currentTag();
      // 4+ columns of indentation is too much to interrupt/continue as any
      // of these block constructs while a paragraph/list-item/definition is
      // already open — it's just lazy-continuation text (matches the same
      // rule already applied to setext underlines).
      if ((contTag === 'P' || contTag === 'LI' || contTag === 'DD') && this.lineIndent >= 4) {
        this._continueOrFallback();
      } else if (p[0] === '>') {
        const { level } = this._bqLevel(p);
        // A blank line inside the blockquote (just ">" markers, no content)
        // ends the current paragraph, same as a top-level blank line.
        if (level > 0) {
          if (this.dom.currentTag() === 'P') this.dom.pop();
          this.ensureBlockquote(level);
          this.openParagraph();
        }
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
        this.openUlDecided(p.slice(2), '-');
      } else {
        // No block construct matched (this covers "[" left unresolved, a
        // "**"/"__" run too short to be a thematic break, or anything else
        // not recognized) — it's just text, and must not be silently
        // discarded: continue the open paragraph/list-item/definition if
        // there is one, else start a new paragraph.
        this._continueOrFallback();
      }
      this.pending = '';
    }

    if (!this.blockDecided) {
      const tag = this.dom.currentTag();
      const li = this.dom.find('LI');
      if (li && (tag === 'P' || tag === 'LI')) {
        // A blank line inside a list item doesn't necessarily end the list —
        // it might just separate this item's paragraphs, or separate this
        // item from the next one (which is what makes the whole list
        // "loose": every item's content gets wrapped in <p>, even single-
        // paragraph ones) — OR the list might simply be ending here, with
        // unrelated content following at a shallower indent, in which case
        // this blank line does NOT make it loose. Stay positioned at the LI;
        // _resolveListBlankContinuation (called for the next line) decides
        // which case this is, and marks looseness only when warranted.
        if (tag === 'P') this.dom.pop();
        this.textNode = null; this.lastBlockEl = null;
        this.pendingListBlank = true;
      } else if (tag === 'P') {
        this.dom.pop(); this.textNode = null; this.lastBlockEl = null;
      } else if (tag === 'DD') {
        this.dom.toRoot(); this.textNode = null; this.lastBlockEl = null;
      }
      this.resetLine(); return;
    }

    // A hard break (trailing "  " or "\") only applies mid-paragraph/list-item
    // /definition — not inside a single-line construct like a heading, where
    // trailing spaces/backslash are just trimmed with no <br>.
    const contTag = this.dom.currentTag();
    const breakEligible = contTag === 'P' || contTag === 'LI' || contTag === 'DD';
    if ((this.trailingSpaces >= 2 || this.escapeNext) && this.blockDecided && breakEligible) {
      if (this.textNode) this.textNode.data = this.textNode.data.replace(/ +$/, '');
      const br = document.createElement('br');
      br.dataset.hardbreak = this.escapeNext ? 'esc' : 'sp';
      this.dom.current.appendChild(br);
      this.textNode = null;
    } else if (this.escapeNext && this.blockDecided) {
      // Trailing "\" in a context where hard breaks don't apply (e.g. a
      // heading, which is always a single line) stays a literal character.
      this.appendToTextNode('\\');
    }
    this.escapeNext = false;

    if (this.bareUrlOpen) {
      const a = this.dom.find('A');
      if (a && !a.href) { a.href = a.textContent.trim(); this._pop(a); }
      this._resetBareUrl();
    }

    // An unresolved "<...tag attempt" left open at end-of-line (e.g. an
    // unmatched quote inside it) would otherwise be silently discarded by
    // resetLine() below — fall back to literal text instead of losing it.
    if (this.autolinkBuf !== null) {
      this.appendToTextNode('<' + this.autolinkBuf);
      this.autolinkBuf = null; this.autolinkQuote = null;
    }

    // Same for an unresolved "&entity" attempt with no closing ";" yet.
    if (this.entityBuf !== null) {
      this.appendToTextNode(this.entityBuf);
      this.entityBuf = null;
    }

    // A counted run of closing backticks (see the inline-code branch of
    // onInlineChar) only gets resolved once a following character arrives
    // to confirm the run's true length — a run sitting right at end-of-line
    // never gets that confirming character, so resolve it here instead.
    if (this.codeCloseRun && this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      if (this.codeCloseRun === this.dom.current._mdMarker.length) this._closeCodeSpan();
      else this.appendToTextNode('`'.repeat(this.codeCloseRun));
      this.codeCloseRun = 0;
    }

    this.flushInlinePending();
    if (this.linkState === 'expect_paren') {
      const a = this.dom.find('A');
      if (a && !a.href) { a.dataset.implicitRef = this.linkBuf.toLowerCase(); this._pop(a); }
      this._resetLinkUrl();
    } else if (this.linkState === 'img_expect_paren' || this.linkState === 'img_ref_id') {
      // A shortcut ![alt] or collapsed/explicit ![alt][ref] ending exactly
      // at end-of-line never reaches onLinkChar's own handling for it
      // (newlines bypass onLinkChar entirely) — resolve it here the same way.
      const isShortcut = this.linkState === 'img_expect_paren';
      const refKey = (isShortcut ? this.linkBuf : (this.urlBuf.trim() || this.linkBuf.trim())).trim().toLowerCase();
      this._pushRefImage(refKey, isShortcut);
      this._resetLinkUrl();
    } else if (this.linkState !== null) {
      this.abortLinkElement(null);
    }

    if (this.atxLevel && this.textNode)
      this.textNode.data = this.textNode.data.replace(/\s+#+\s*$/, '').replace(/\s+#+$/, '').replace(/ +$/, '');
    this.atxLevel = 0;
    this.textNode = null;

    this._popMarkers();
    if (this.inFootnoteDef) { this.dom.toRoot(); this.inFootnoteDef = false; this.footnoteDefId = ''; }
    const tag = this.dom.currentTag();
    this.needsJoinSpace = tag === 'P' || tag === 'LI' || tag === 'DD';
    this.resetLine();
  }

  resetLine() {
    this.linePos = 0; this.lineIndent = 0; this.leadingWsChars = 0; this.blockDecided = false;
    this.pending = ''; this.inlinePending = ''; this.atxLevel = 0;
    this.linkState = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
    this.inCell = false; this.tablePipePending = false; this.trailingSpaces = 0;
    this.lineStart = true; this.prevCharWs = true; this.bareUrlBuf = null;
    this.lastChar = undefined;
    this.escapeNext = false; this.entityBuf = null; this.autolinkBuf = null; this.autolinkQuote = null;
    this.taskCheckBuf = null; this.taskCheckDone = false;
    this.codeCloseRun = 0;
    this._inBlockquoteContent = false;
    this._blankBeforeNewItem = false;
  }

  // ── Block decision ─────────────────────────────────────────────────────────
  _blockDefault(ch) {
    if (this.defPending) { this.defPending.value += ch; return; }
    const tag = this.dom.currentTag();
    if (tag === 'P' || tag === 'LI' || tag === 'DD') {
      if (this.needsJoinSpace) { this.needsJoinSpace = false; this.appendToTextNode(' '); this.lastChar = ' '; }
      this.feedPendingAsInline(); this.blockDecided = true; return;
    }
    this.fallbackToParagraph();
  }

  decideBlock(ch) {
    this.pending += ch;
    const p = this.pending;

    switch (p[0]) {
      case '#':
        if (ch === '#' && p.length <= 6) return;
        if ((ch === ' ' || ch === '\t') && p.length >= 2 && /^#{1,6}$/.test(p.slice(0,-1))) {
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
        this.ensureBlockquote(level);
        // Replay the content after the ">" markers through decideBlock
        // itself (not straight to inline text) so a heading, list, fence,
        // etc. inside a blockquote is recognized as one, not forced into a
        // paragraph. If dom.current is still an open P/LI/DD (ensureBlockquote
        // only resets when the quote depth actually changed), the normal
        // continuation checks in _blockDefault() etc. keep it open as usual.
        this.pending = ''; this.blockDecided = false;
        this._inBlockquoteContent = true;
        for (const c of p.slice(i)) {
          if (this.blockDecided) {
            if (c === ' ') this.trailingSpaces++; else this.trailingSpaces = 0;
            this.onContentChar(c);
          } else {
            this.decideBlock(c);
          }
          this.lastChar = c;
        }
        // NOT reset here: block-type detection for this content may take
        // several more characters (e.g. an ATX heading waits for the
        // trailing space), which arrive as separate top-level processChar()
        // calls — reset happens once per line, in resetLine().
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
          if (p[1] === ' ') return this.openUlDecided('', '*');
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
          if (this.lastBlockEl?.tagName === 'P') {
            return this.lineIndent < 4 ? this.startSetextWatch('-', p, p[1] !== '-') : this._blockDefault(ch);
          }
          return this.startHrWatch('-', 2, p[1] !== '-');
        }
        if (p.length === 3) {
          if (p === '- -' || p === '- *') return;
          if (p[1] === ' ' && p[2] !== '-' && p[2] !== ' ') return this.openUlDecided(p[2], '-');
          if (p[1] === ' ' && p[2] === ' ') return;
          if (this.lastBlockEl?.tagName === 'P') {
            return this.lineIndent < 4 ? this.startSetextWatch('-', p, false) : this._blockDefault(ch);
          }
          return this.startHrWatch('-', p.split('-').length - 1, false);
        }
        if (p.length === 4) {
          if (p === '- - ') return;
          if (p.startsWith('- -')) return this.startHrWatch('-', 2, false);
          return this.openUlDecided(p.slice(2), '-');
        }
        if (/^(- )+$/.test(p) || /^(- )+-?$/.test(p)) return;
        if (/^- /.test(p)) return this.openUlDecided(p.slice(2), '-');
        return this.startHrWatch('-', (p.match(/-/g)||[]).length, false);

      case '+':
        if (p.length === 1) return;
        if (p[1] === ' ') { this.openUlDecided(p.slice(2), '+'); return; }
        this._blockDefault(ch); return;

      case '_':
        if (/^[_ ]+$/.test(p)) return;
        this._blockDefault(ch); return;

      case '=':
        if (this.lastBlockEl?.tagName === 'P' && this.lineIndent < 4) { this.startSetextWatch('=', p, ch !== '='); return; }
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

      // HTML block start — CommonMark defines 7 distinct types, each with
      // its own end condition (a matching closing tag/marker for types 1-5,
      // the next BLANK LINE for types 6-7). See _startHtmlBlock() and
      // onNewline()'s inRawHtml handling for how each type actually closes.
      case '<': {
        if (p.length === 1) return;
        if (p[1] === '!') {
          if (p.length === 2) return;
          if (p[2] === '-') { // building toward <!--  (type 2: comment)
            if (p.length < 4) return;
            if (p.startsWith('<!--')) { this._startHtmlBlock('comment', null); return; }
            this._blockDefault(ch); return;
          }
          if (p[2] === '[') { // building toward <![CDATA[  (type 5)
            const want = '<![CDATA[';
            if (p.length < want.length) {
              if (want.startsWith(p)) return;
              this._blockDefault(ch); return;
            }
            if (p.startsWith(want)) { this._startHtmlBlock('cdata', null); return; }
            this._blockDefault(ch); return;
          }
          if (/[A-Z]/.test(p[2])) { this._startHtmlBlock('decl', null); return; } // type 4
          this._blockDefault(ch); return;
        }
        if (p[1] === '?') { this._startHtmlBlock('pi', null); return; } // type 3
        if (p === '</') return; // closing tag, name not started yet — wait
        {
          const m = p.match(/^<\/?([a-zA-Z][a-zA-Z0-9-]*)/);
          if (!m) { this._blockDefault(ch); return; } // not a tag at all (e.g. "<3")
          // JS regex name-matching is greedy, so once p has a character past
          // the matched name, that name is definitely complete (the next
          // char, whatever it is, isn't a valid name character) — no need to
          // separately check for a following space/">"/"/".
          if (p.length === m[0].length) return; // still building the name, wait
          const name = m[1].toLowerCase();
          if (HTML_BLOCK1_TAGS.has(name)) { this._startHtmlBlock('tag', name); return; } // type 1
          if (HTML_BLOCK6_TAGS.has(name)) { this._startHtmlBlock('blank', null); return; } // type 6
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
          if (p[i + 1] === ' ') { this.openListItem('ol', this.lineIndent, p[i], parseInt(p.slice(0, i), 10), this.linePos); this._bd(); return; }
          this._blockDefault(ch); return;
        }
        this._blockDefault(ch);
    }
  }

  // ── Content chars ──────────────────────────────────────────────────────────
  onContentChar(ch) {
    // Indented code blocks are literal — no emphasis, links, entities,
    // escapes, etc. should be parsed inside them (same principle as the
    // fenced-code path, which already writes raw via feedCodeFenceLine).
    if (this.inIndentCode) { if (this.textNode) this.textNode.data += ch; return; }
    if (this.sepWatch && this.inTable) {
      this.sepBuf += ch;
      if (ch !== '-' && ch !== ':' && ch !== ' ' && ch !== '|') this.sepFailed = true;
    }
    if (this.setextWatch) {
      // The underline chars may have trailing spaces/tabs after them, but
      // no more underline chars once whitespace has started.
      if (ch === this.setextChar && !this.setextTrailing) this.setextBuf += ch;
      else if (ch === ' ' || ch === '\t') { this.setextTrailing = true; this.setextBuf += ch; }
      else { this.setextFailed = true; this.setextBuf += ch; }
      return;
    }
    if (this.hrWatch) {
      if (ch === this.hrChar) this.hrCount++;
      else if (ch !== ' ' && ch !== '\t') this.hrFailed = true;
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
    this.lastChar = ch;
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

    // Inline code — a code span closes only on a backtick run of the exact
    // same length as the one that opened it (CommonMark 6.1); a run of any
    // other length (including a lone backtick inside a `` fence) is literal
    // content, not a close.
    if (this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      const fenceLen = this.dom.current._mdMarker.length;
      if (ch === '`') { this.codeCloseRun = (this.codeCloseRun || 0) + 1; return; }
      if (this.codeCloseRun) {
        if (this.codeCloseRun === fenceLen) {
          this._closeCodeSpan();
          this.codeCloseRun = 0;
          this.onInlineChar(ch);
          return;
        }
        this.appendToTextNode('`'.repeat(this.codeCloseRun));
        this.codeCloseRun = 0;
      }
      this.appendToTextNode(ch);
      return;
    }

    if (this.linkState !== null) { this.onLinkChar(ch); return; }

    // Autolink / inline HTML — CommonMark allows ANY HTML-tag-like
    // construct (not a fixed whitelist), so the whole "<...>" span is
    // buffered and classified once its closing '>' is found: a closing
    // tag (pop the matching ancestor by name), an opening/self-closing
    // tag (create it with its real attributes, via the browser's own
    // parser so quoting/escaping is handled correctly), an autolink
    // (scheme: URL or email), an HTML comment, or — if none of those —
    // literal text. Checked before backslash/entity handling: raw HTML is
    // literal, so "&" and "\" inside an open tag must be buffered as-is,
    // not treated as an entity/escape.
    if (this.autolinkBuf !== null) {
      if (this.autolinkBuf === '!-' && ch === '-') { this.autolinkBuf = '!--'; return; }
      if (this.autolinkBuf.startsWith('!--')) {
        this.autolinkBuf += ch;
        if (this.autolinkBuf.endsWith('-->')) { this.autolinkBuf = null; this.prevCharWs = false; }
        return;
      }
      if (this.autolinkQuote) {
        this.autolinkBuf += ch;
        if (ch === this.autolinkQuote) this.autolinkQuote = null;
        return;
      }
      if (ch === '"' || ch === "'") { this.autolinkQuote = ch; this.autolinkBuf += ch; return; }
      if (ch === '>') { this._resolveAutolinkBuf(); return; }
      if (ch === '<') { this.appendToTextNode('<' + this.autolinkBuf); this.autolinkBuf = ''; return; }
      this.autolinkBuf += ch;
      if (this.autolinkBuf.length > 2000) { this.appendToTextNode('<' + this.autolinkBuf); this.autolinkBuf = null; }
      return;
    }

    // Backslash escape — only ASCII punctuation can be escaped; a backslash
    // before anything else (a letter, digit, tab, non-ASCII char, ...) is
    // itself literal, per CommonMark.
    if (this.escapeNext) {
      this.escapeNext = false;
      this.appendToTextNode(this._isPunct(ch) ? ch : '\\' + ch);
      this.prevCharWs = false; return;
    }
    if (ch === '\\') { this.escapeNext = true; return; }

    // HTML entity
    if (this.entityBuf !== null) {
      this.entityBuf += ch;
      if (ch === ';') { this.writeText(this.decodeEntity(this.entityBuf)); this.entityBuf = null; this.prevCharWs = false; return; }
      if (this.entityBuf.length > 33) { this.writeText(this.entityBuf); this.entityBuf = null; }
      return;
    }
    if (ch === '&') { this.entityBuf = '&'; return; }

    if (ch === '<') { this.autolinkBuf = ''; this.autolinkQuote = null; return; }

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
      if (this.inlinePending && ch !== this.inlinePending[0]) this.resolveInlinePending(null, ch);
      if (!this.inlinePending) this.pendingDelimBefore = this.lastChar;
      this.inlinePending += ch;
      this.prevCharWs = false; return;
    }

    if (this.inlinePending) { this.resolveInlinePending(ch); this.prevCharWs = (ch === ' '); return; }
    this.appendToTextNode(ch);
    this.prevCharWs = (ch === ' ');
  }

  isMarkerChar(ch) { return '`*_~^'.includes(ch); }

  // CommonMark 6.1: if a code span's content begins *and* ends with a
  // literal space, but isn't entirely spaces, strip exactly one from each
  // end (lets code that itself starts/ends with a backtick be fenced).
  _closeCodeSpan() {
    const code = this.dom.current;
    const text = code.firstChild;
    if (text && text.nodeType === 3 && text.data.length >= 2
        && text.data[0] === ' ' && text.data[text.data.length - 1] === ' '
        && /[^ ]/.test(text.data)) {
      text.data = text.data.slice(1, -1);
    }
    this.dom.pop();
    this.textNode = null;
  }

  // Classifies and applies a buffered "<...>" span once its closing '>' is
  // found (called from onInlineChar; see the comment there).
  _resolveAutolinkBuf() {
    const buf = this.autolinkBuf;
    this.autolinkBuf = null; this.autolinkQuote = null;

    const closeMatch = buf.match(/^\/([a-zA-Z][a-zA-Z0-9-]*)\s*$/);
    if (closeMatch) {
      const el = this.dom.find(closeMatch[1].toUpperCase());
      if (el) { this._pop(el); this.textNode = null; }
      else this.appendToTextNode('<' + buf + '>'); // no open ancestor to close — passthrough, don't lose it
      this.prevCharWs = false; return;
    }

    const openMatch = buf.match(/^([a-zA-Z][a-zA-Z0-9-]*)(\s[\s\S]*)?\/?$/);
    if (openMatch) {
      const tagName = openMatch[1];
      const selfClosing = /\/\s*$/.test(buf) || VOID_TAGS.has(tagName.toLowerCase());
      const body = selfClosing ? buf.replace(/\/\s*$/, '') : buf;
      try {
        const doc = new DOMParser().parseFromString('<' + body + '></' + tagName + '>', 'text/html');
        const src = doc.body.querySelector(tagName);
        const el = document.createElement(tagName);
        if (src) for (const attr of src.attributes) el.setAttribute(attr.name, attr.value);
        this.dom.current.appendChild(el);
        this.textNode = null;
        if (!selfClosing) this.dom.current = el;
        this.prevCharWs = false; return;
      } catch (e) { /* fall through to literal below */ }
    }

    if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/.test(buf) || /^[^\s<>@]+@[^\s<>@]+$/.test(buf)) {
      const a = document.createElement('a');
      const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(buf);
      a.href = buf.includes('@') && !hasScheme ? 'mailto:' + buf : buf;
      this.initAnchor(a); a.appendChild(document.createTextNode(buf));
      this.dom.current.appendChild(a); this.textNode = null;
      this.prevCharWs = false; return;
    }

    this.appendToTextNode('<' + buf + '>');
    this.prevCharWs = false;
  }

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
        if (ch === '(') { this.linkState = 'img_url'; this.urlBuf = ''; this._resetUrlParse(); }
        else if (ch === '[') { this.linkState = 'img_ref_id'; this.urlBuf = ''; }
        else {
          // Shortcut reference form: ![alt] with no following (...)/[...] —
          // resolved against refDefs at finalize() (defs may come later).
          this._pushRefImage(this.linkBuf.trim().toLowerCase(), true);
          if (ch !== '\n') this.onInlineChar(ch);
        }
        return;

      case 'img_ref_id':
        if (ch === ']') {
          const refKey = (this.urlBuf.trim() || this.linkBuf.trim()).toLowerCase();
          this._pushRefImage(refKey, false);
        } else { this.urlBuf += ch; }
        return;

      case 'img_url': {
        const raw = this._feedUrlChar(ch);
        if (raw !== null) {
          const { url: iUrl, title: iTitle } = this._parseUrlBuf(raw);
          const img = document.createElement('img');
          img.src = iUrl; img.alt = this.linkBuf;
          if (iTitle) img.title = iTitle;
          const insideLink = !!this.dom.find('A');
          if (!insideLink) img.className = 'blk';
          this.dom.current.appendChild(img);
          this.textNode = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
          this.linkState = insideLink ? 'label_open' : null;
          this._resetUrlParse();
        }
        return;
      }

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
        if (ch === '(') { this.linkState = 'url'; this.urlBuf = ''; this._resetUrlParse(); }
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
          const def = this.refDefs[refKey];
          const a = this.dom.find('A');
          if (a) {
            if (def) { a.href = def.url; if (def.title) a.title = def.title; }
            else { a.href = '#'; a.dataset.refKey = refKey; }
            this._pop(a);
          }
          this._resetLinkUrl();
        } else { this.urlBuf += ch; }
        return;

      case 'url': {
        const raw = this._feedUrlChar(ch);
        if (raw !== null) {
          const { url, title } = this._parseUrlBuf(raw);
          const a = this.dom.find('A');
          if (a) { a.href = url; if (title) a.title = title; this._pop(a); }
          this._resetLinkUrl();
        }
        return;
      }
    }
  }

  // Creates a placeholder <img> for a reference-style image (explicit
  // ![alt][ref], collapsed ![alt][], or shortcut ![alt]) whose definition
  // may not be known yet — resolved (or reverted to literal text) once all
  // reference definitions are known, in finalize()'s img[data-ref-key] pass.
  _pushRefImage(refKey, isShortcut) {
    const insideLink = !!this.dom.find('A');
    const img = document.createElement('img');
    img.src = ''; // set first so later resolving it in finalize() keeps src before alt in attribute order
    img.alt = this.linkBuf;
    img.dataset.refKey = refKey;
    if (isShortcut) img.dataset.refShortcut = '1';
    if (!insideLink) img.className = 'blk';
    this.dom.current.appendChild(img);
    this.textNode = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
    this.linkState = insideLink ? 'label_open' : null;
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

  // Feeds one character of a `(...)` inline link/image destination.
  // Handles backslash escapes, `<angle-bracket>` destinations (spaces
  // percent-encoded, no paren-balancing needed inside), and balanced
  // parens in the unwrapped form (foo(bar) stays part of the URL).
  // Returns the raw "url [title]" string once the closing, unnested ')'
  // is reached, else null (still accumulating).
  _feedUrlChar(ch) {
    if (this.urlEscapeNext) { this.urlBuf += ch; this.urlEscapeNext = false; return null; }
    if (ch === '\\') { this.urlEscapeNext = true; return null; }
    if (this.urlAngle === undefined) {
      this.urlAngle = ch === '<';
      if (this.urlAngle) return null;
    }
    if (this.urlAngle && this.urlAngleValue === null) {
      if (ch === '>') { this.urlAngleValue = this.urlBuf.replace(/ /g, '%20'); this.urlBuf = ''; }
      else this.urlBuf += ch;
      return null;
    }
    if (!this.urlAngle) {
      if (ch === '(') { this.urlParenDepth++; this.urlBuf += ch; return null; }
      if (ch === ')' && this.urlParenDepth > 0) { this.urlParenDepth--; this.urlBuf += ch; return null; }
    }
    if (ch === ')') {
      return this.urlAngleValue !== null ? `${this.urlAngleValue} ${this.urlBuf}` : this.urlBuf;
    }
    this.urlBuf += ch;
    return null;
  }

  _parseUrlBuf(raw = this.urlBuf) {
    raw = raw.trim();
    const m = raw.match(/^(.*?)\s+["'](.*?)["']$/);
    const rawUrl = m ? m[1] : raw;
    const rawTitle = m ? m[2] : null;
    return {
      url: this._encodeUrl(this._decodeEntities(rawUrl)),
      title: rawTitle !== null ? this._decodeEntities(rawTitle) : null,
    };
  }

  // Link/image destinations and titles process entity references (and
  // backslash escapes, already handled during accumulation) but nothing
  // else — no emphasis, no nested links, etc.
  _decodeEntities(str) {
    return str.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]*);/g, (m) => this.decodeEntity(m));
  }

  // CommonMark percent-encodes "unsafe" characters in the destination,
  // without re-encoding a "%" that's already part of a valid escape.
  _encodeUrl(url) {
    try { return encodeURI(url).replace(/%25([0-9a-fA-F]{2})/g, '%$1'); } catch (e) { return url; }
  }

  // ── Delimiter flanking (CommonMark 6.2) ────────────────────────────────────
  _isPunct(ch) { return ch !== undefined && ch !== null && /[!-/:-@[-`{-~]/.test(ch); }
  _isWsBoundary(ch) { return ch === undefined || ch === null || /\s/.test(ch); }

  // Returns whether a delimiter run bounded by `before`/`after` can open
  // and/or close emphasis, per the CommonMark left/right-flanking rules.
  // `_` additionally forbids intraword emphasis; `*` has no such restriction.
  _canOpenClose(baseChar, before, after) {
    const beforeWs = this._isWsBoundary(before), afterWs = this._isWsBoundary(after);
    const beforePunct = this._isPunct(before), afterPunct = this._isPunct(after);
    const left  = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
    if (baseChar === '_') {
      return { canOpen: left && (!right || beforePunct), canClose: right && (!left || afterPunct) };
    }
    return { canOpen: left, canClose: right };
  }

  // ── Resolve inline pending ─────────────────────────────────────────────────
  // `nextCh`: character to literally append after resolving (null = caller
  // handles it itself). `flankChar` (defaults to nextCh): the character to
  // use as "what follows" for flanking — distinct from nextCh when a new
  // delimiter run interrupts this one (that new char follows for flanking
  // purposes, but must not itself be written as plain text here).
  resolveInlinePending(nextCh, flankChar = nextCh) {
    const marker = this.inlinePending; this.inlinePending = '';
    if (marker) {
      const baseChar = marker[0];
      if (baseChar === '*' || baseChar === '_') {
        const { canOpen, canClose } = this._canOpenClose(baseChar, this.pendingDelimBefore, flankChar);
        const closeEl = canClose ? this.findInlineClose(marker) : null;
        if (marker === '***') {
          if (closeEl !== null) {
            this._pop(closeEl); this.textNode = null;
            if (this.dom.current._mdMarker === '***_em') { this.dom.pop(); this.textNode = null; }
          } else if (canOpen) {
            const strong = this.dom.push('strong'); strong._mdMarker = '***'; this.textNode = null;
            const em = this.dom.push('em'); em._mdMarker = '***_em'; this.textNode = null;
          } else {
            this.writeText(marker);
          }
        } else if (closeEl !== null) {
          this._pop(closeEl); this.textNode = null;
        } else if (canOpen) {
          const tag = this.markerToTag(marker);
          const el = this.dom.push(tag); el._mdMarker = marker; this.textNode = null;
        } else {
          this.writeText(marker);
        }
      } else {
        // Non-emphasis markers (code, strikethrough, sup/sub, highlight):
        // no flanking rules, just toggle open/close.
        const closeEl = this.findInlineClose(marker);
        if (closeEl !== null) {
          this._pop(closeEl); this.textNode = null;
        } else {
          const tag = this.markerToTag(marker);
          if (tag) {
            const el = this.dom.push(tag); el._mdMarker = marker; this.textNode = null;
          } else {
            this.writeText(marker);
          }
        }
      }
    }
    if (nextCh !== null) this.appendToTextNode(nextCh);
  }

  markerToTag(marker) {
    if (marker[0] === '`') return 'code'; // any-length backtick run opens a code span
    return {'**':'strong','*':'em','__':'u','_':'em','~~':'s','^':'sup','~':'sub','==':'mark'}[marker] || null;
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
  // Both call sites only reach here once it's already established we're NOT
  // continuing an open P/LI/DD — i.e. any list we were in has genuinely
  // ended, so listStack is cleared here too (otherwise it would go stale:
  // still pointing at indent/type info for a list no longer on the current
  // dom path, corrupting a later, unrelated list's nesting decisions).
  fallbackToParagraph() { this.closeBlock(); this.listStack = []; this.openParagraph(); this.blockDecided = true; this.feedPendingAsInline(); }

  // Used by onNewline's end-of-line "nothing matched" fallback: continue
  // the already-open paragraph/list-item/definition (with the usual
  // soft-break join space) instead of starting a new one, matching how
  // decideBlock's own _blockDefault() treats an ordinary continuation line.
  _continueOrFallback() {
    const tag = this.dom.currentTag();
    if (tag === 'P' || tag === 'LI' || tag === 'DD') {
      if (this.hadJoinSpace) { this.hadJoinSpace = false; this.appendToTextNode(' '); this.lastChar = ' '; }
      this.feedPendingAsInline(); this.blockDecided = true;
    } else this.fallbackToParagraph();
  }
  initAnchor(a)         { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  flushDefPending()     { if (!this.defPending) return; const d = this.defPending; if (d.type === 'ref' && !(d.key in this.refDefs)) this.refDefs[d.key] = this._parseUrlBuf(d.value); if (d.type === 'abbr') this.abbrMap[d.key] = d.value.trim(); this.defPending = null; }
  startHrWatch(c,n,f)   { this.hrWatch = true; this.hrChar = c; this.hrCount = n; this.hrFailed = f; this._bd(); }
  startSetextWatch(c,b,f){ this.setextWatch = true; this.setextChar = c; this.setextBuf = b; this.setextFailed = f; this._bd(); }
  openUlDecided(s, marker) {
    const contentCol = this.linePos - s.length;
    this.openListItem('ul', this.lineIndent, marker, undefined, contentCol);
    this._bd();
    for (const c of s) { this.onInlineChar(c); this.lastChar = c; }
  }

  // ── Entity decoder ─────────────────────────────────────────────────────────
  decodeEntity(raw) {
    if (ENTITY_MAP[raw]) return ENTITY_MAP[raw];
    // CommonMark caps the digit count: 1-6 hex digits, 1-7 decimal digits —
    // anything longer isn't a valid numeric reference at all (stays literal),
    // not an "invalid code point" (which would become U+FFFD).
    const hex = raw.match(/^&#[xX]([0-9a-fA-F]{1,6});$/);
    if (hex) return this._codePointOrReplacement(parseInt(hex[1], 16));
    const dec = raw.match(/^&#([0-9]{1,7});$/);
    if (dec) return this._codePointOrReplacement(parseInt(dec[1], 10));
    return raw;
  }

  // A numeric character reference for 0, a UTF-16 surrogate, or anything
  // past the last valid Unicode code point is invalid and renders as the
  // replacement character (U+FFFD), per the HTML spec.
  _codePointOrReplacement(cp) {
    if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF) || cp > 0x10FFFF) return '�';
    try { return String.fromCodePoint(cp); } catch (e) { return '�'; }
  }

  // ── Text helpers ───────────────────────────────────────────────────────────
  writeText(str) {
    if (!this.textNode) { this.textNode = document.createTextNode(''); this.dom.current.appendChild(this.textNode); }
    this.textNode.data += str;
  }
  appendToTextNode(ch) { this.writeText(ch); }
  feedPendingAsInline() { const s = this.pending; this.pending = ''; for (const ch of s) { this.onInlineChar(ch); this.lastChar = ch; } }

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
      this.closingFenceBuf = ''; this.fenceLineHasContent = false; return;
    }
    // A run of (only) the fence char spanning the WHOLE line, at least as
    // long as the opening fence, closes it — a longer closer is allowed,
    // not just an exact-length match.
    if (!this.fenceLineHasContent && this.closingFenceBuf.length >= (this.fenceCount || 3)) {
      this.inCodeFence = false; this.closingFenceBuf = null; this.textNode = null;
      const pre = this.dom.find('PRE'); if (pre) this._pop(pre);
      this.lastBlockEl = null; this.resetLine(); return;
    }
    // Wasn't a valid closer after all — the withheld run is literal content.
    if (this.closingFenceBuf && this.textNode) this.textNode.data += this.closingFenceBuf;
    if (this.textNode) this.textNode.data += '\n';
    this.closingFenceBuf = ''; this.fenceLineHasContent = false;
  }

  feedCodeFenceLine(ch) {
    // Only the *start* of a line can open a potential closing-fence run —
    // once any other content has been written this line, later fence-char
    // runs (e.g. the "```" in "aaa```") can't retroactively become one.
    if (!this.fenceLineHasContent && ch === this.fenceChar) { this.closingFenceBuf += ch; return; }
    if (this.closingFenceBuf) {
      if (this.textNode) this.textNode.data += this.closingFenceBuf;
      this.closingFenceBuf = '';
    }
    this.fenceLineHasContent = true;
    if (this.textNode) this.textNode.data += ch;
  }

  // ── Raw HTML passthrough ───────────────────────────────────────────────────
  // `mode`: 'comment'|'pi'|'decl'|'cdata' (types 2-5, end on a line containing
  // the matching close marker), 'tag' (type 1, end on a line with the
  // matching closing tag; `closeTag` names it), or 'blank' (types 6/7, end
  // at the next blank line).
  _startHtmlBlock(mode, closeTag) {
    this.closeBlock();
    this.inRawHtml = true;
    this.rawHtmlBuf = this.pending;
    this.rawHtmlLineBuf = this.pending;
    this.rawHtmlEndMode = mode;
    this.rawHtmlCloseTag = closeTag;
    this._bd();
  }

  flushRawHtml() {
    const raw = this.rawHtmlBuf;
    try {
      // A <template>'s content parses as a plain fragment, not a full
      // document — unlike DOMParser().parseFromString(), a standalone
      // comment (or other content the full-document body-detection
      // heuristic would place outside <body> entirely) lands correctly as
      // a direct child, ready to move as-is.
      const template = document.createElement('template');
      template.innerHTML = raw.trim();
      if (template.content.children.length === 0 && /^<\//.test(raw.trim())) {
        // A block starting with a closing tag that has no matching open
        // element anywhere is simply discarded by any real HTML parser
        // (there's nothing to close) — CommonMark wants it passed through
        // literally, which a DOM text node can only represent as escaped
        // text, but that's still preferable to losing the content outright.
        this.writeText(raw);
      } else {
        while (template.content.firstChild) this.dom.current.appendChild(template.content.firstChild);
      }
    } catch(e) { this.writeText(raw); }
    this.inRawHtml = false; this.rawHtmlBuf = ''; this.rawHtmlLineBuf = '';
    this.rawHtmlEndMode = null; this.rawHtmlCloseTag = null;
    this.resetLine();
  }

  // ── Block helpers ──────────────────────────────────────────────────────────
  closeBlock() {
    this.flushInlinePending();
    if (this.bareUrlOpen) this.closeBareUrl();
    this._popMarkers();
    this.textNode = null;
    if (this.dom.depth() > 1) this._popToBlockContainer();
    if (this.inTable) { this.inTable = false; this.tableHeadDone = false; this.inCell = false; this.tableColAlign = []; this.tableColIndex = 0; }
    this.inFootnoteDef = false;
    this.inIndentCode = false; this.pendingIndentNL = 0;
  }

  // Pops back to the nearest ancestor that can directly hold new block-level
  // children (a BLOCKQUOTE or the document root) — used instead of an
  // unconditional dom.toRoot() so that opening a heading/list/fence/
  // paragraph *inside* a blockquote doesn't blow away that nesting and land
  // back at the top level. Deliberately does NOT also stop at a list LI:
  // unlike a blockquote's lazy-continuation rules, whether a new block
  // belongs inside a list item depends on its indentation relative to the
  // marker (not yet tracked here) — e.g. an unindented "---" after a list
  // item must end the list, not nest a stray <hr> inside its last <li>.
  _popToBlockContainer() {
    while (this.dom.current !== this.dom.bottomStack) {
      // Only preserve BLOCKQUOTE nesting while actively processing a line
      // that itself had a ">" prefix (see case '>' in decideBlock). A
      // construct with NO ">" prefix — a bare "***"/blank line following
      // quoted content — ends the blockquote like any other interruption,
      // it doesn't belong inside it.
      if (this._inBlockquoteContent && this.dom.currentTag() === 'BLOCKQUOTE') return;
      this.dom.pop();
    }
  }

  openParagraph() { const p = this.dom.push('p'); this.lastBlockEl = p; this.textNode = null; }

  ensureBlockquote(level) {
    let depth = 0, _e = this.dom.current;
    while (_e) { if (_e.tagName === 'BLOCKQUOTE') depth++; if (_e === this.dom.bottomStack) break; _e = _e.parentNode; }
    // Already at the right nesting depth — this is a continuation line of
    // the same blockquote (possibly still inside an open P/LI/DD for lazy
    // continuation), so leave dom.current alone instead of always popping.
    if (depth === level) return;
    this.flushInlinePending();
    this._popMarkers();
    this.textNode = null;
    if (this.dom.currentTag() === 'P') this.dom.pop();
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

  // `marker`: the bullet char ('-','+','*') or ordered delimiter ('.',')')
  // — a change in marker, not just list type, starts a new list per
  // CommonMark (e.g. "- a\n+ b" is two separate <ul>s, not one).
  // `contentCol`: the column where this item's content starts (right after
  // the marker + its required space) — used to tell a paragraph-continuation
  // of THIS item (indented at least that far, after a blank line) apart from
  // content that dedents back out of the list entirely.
  openListItem(type, indent, marker, startNum, contentCol) {
    this._popMarkers();
    this.textNode = null;
    if (this.listStack.length === 0) {
      const tag = this.dom.currentTag();
      if (!['UL','OL','LI'].includes(tag)) this.closeBlock();
      this.pushNewList(type, indent, marker, startNum, contentCol);
    } else {
      const top = this.listStack[this.listStack.length - 1];
      if (indent > top.indent) {
        this.pushNewList(type, indent, marker, startNum, contentCol);
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
        if (now.type !== type || now.marker !== marker) {
          if (['UL','OL'].includes(this.dom.currentTag())) this.dom.pop();
          this.listStack.pop(); this.pushNewList(type, indent, marker, startNum, contentCol);
        } else {
          now.contentCol = contentCol;
          // This new item follows a blank line and reuses the SAME list
          // (not a fresh one) — that blank line separated two items of this
          // list, which is exactly what makes it loose.
          if (this._blankBeforeNewItem) this._markListLoose(now);
        }
      }
    }
    this._blankBeforeNewItem = false;
    const li = this.dom.push('li'); this.lastBlockEl = li;
    this.taskCheckBuf = ''; this.taskCheckDone = false;
  }

  pushNewList(type, indent, marker, startNum, contentCol) {
    const list = this.dom.push(type);
    if (type === 'ol' && startNum !== undefined && startNum !== 1) list.setAttribute('start', String(startNum));
    this.listStack.push({ el: list, type, indent, marker, contentCol, loose: false });
  }

  // Called for the first character of the line right after a blank line that
  // occurred while inside a list item (see the blank-line handling in
  // onNewline). Decides whether this line is (a) indented enough to be a new
  // paragraph continuing the SAME item, or (b) anything else — in which case
  // only the current <li> is closed (NOT the surrounding <ul>/<ol>, and NOT
  // the listStack), so decideBlock's own marker detection — which already
  // knows how to compare a new marker's indent against each list level — can
  // correctly tell a new sibling item apart from content that truly exits
  // the list (that content ends up going through _blockDefault(), sees
  // dom.currentTag() is no longer P/LI/DD, and calls fallbackToParagraph(),
  // which is what actually clears listStack once the list is genuinely done).
  _resolveListBlankContinuation(ch) {
    const top = this.listStack[this.listStack.length - 1];
    if (top && this.lineIndent >= top.contentCol) {
      // A second paragraph within the same item: this blank line genuinely
      // separates two blocks that are both part of the list, so it's loose.
      this._markListLoose(top);
      this.lineIndent = 0; this.leadingWsChars = 0;
      this.openParagraph();
      this.decideBlock(ch);
      return;
    }
    if (this.dom.currentTag() === 'LI') this.dom.pop();
    this.lastBlockEl = null;
    // Not (yet) known whether this dedents fully out of the list or is a new
    // sibling item — openListItem() marks looseness itself if it turns out
    // to be the latter, reusing the same list.
    this._blankBeforeNewItem = true;
    this.decideBlock(ch);
  }

  _markListLoose(entry) { entry.loose = true; entry.el.dataset.loose = '1'; }

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
  _isLastNode(el) {
    let node = el;
    while (node && node !== this.root) {
      if (node.nextSibling) return false;
      node = node.parentNode;
    }
    return true;
  }

  finalize() {
    // Same as onNewline()'s handling: a counted closing-backtick run is only
    // confirmed once a following character rules out a longer run — one
    // right at the very end of the input (no trailing newline either) never
    // gets that character otherwise.
    if (this.codeCloseRun && this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      if (this.codeCloseRun === this.dom.current._mdMarker.length) this._closeCodeSpan();
      else this.appendToTextNode('`'.repeat(this.codeCloseRun));
      this.codeCloseRun = 0;
    }
    if (this.autolinkBuf !== null) {
      this.appendToTextNode('<' + this.autolinkBuf);
      this.autolinkBuf = null; this.autolinkQuote = null;
    }
    if (this.entityBuf !== null) {
      this.appendToTextNode(this.entityBuf);
      this.entityBuf = null;
    }
    // An HTML block with no trailing blank line (or, for types 1-5, no
    // matching close marker) before the very end of the input — a real
    // scenario for a *streaming* renderer with content still being typed —
    // is flushed as-is rather than left stuck mid-block forever.
    if (this.inRawHtml) this.flushRawHtml();

    this.flushDefPending();
    this.flushInlinePending();
    if (this.bareUrlOpen) this.closeBareUrl();
    this.textNode = null;

    // A hard break needs a following line to break *to* — one at the very
    // end of the document, with nothing after it, was never really a break.
    const hardBreaks = this.root.querySelectorAll('br[data-hardbreak]');
    const trailingBr = hardBreaks[hardBreaks.length - 1];
    if (trailingBr && this._isLastNode(trailingBr)) {
      const wasEscape = trailingBr.dataset.hardbreak === 'esc';
      trailingBr.replaceWith(wasEscape ? document.createTextNode('\\') : document.createTextNode(''));
    }
    hardBreaks.forEach(br => br.removeAttribute('data-hardbreak'));

    this.root.querySelectorAll('a[href="#"]').forEach(a => {
      const key = a.dataset.refKey || a.textContent.trim().toLowerCase();
      const def = this.refDefs[key];
      if (def) { a.href = def.url; if (def.title) a.title = def.title; delete a.dataset.refKey; }
    });

    this.root.querySelectorAll('a[data-implicit-ref]').forEach(a => {
      const key = a.dataset.implicitRef;
      const def = this.refDefs[key];
      if (def) {
        a.href = def.url; if (def.title) a.title = def.title;
        a.removeAttribute('data-implicit-ref');
      } else {
        const parent = a.parentNode;
        if (parent) {
          parent.insertBefore(document.createTextNode('[' + a.textContent + ']'), a);
          parent.removeChild(a);
        }
      }
    });

    this.root.querySelectorAll('img[data-ref-key]').forEach(img => {
      const key = img.dataset.refKey;
      const def = this.refDefs[key];
      if (def) {
        img.src = def.url; if (def.title) img.title = def.title;
        img.removeAttribute('data-ref-key'); img.removeAttribute('data-ref-shortcut');
      } else {
        const literal = img.dataset.refShortcut ? `![${img.alt}]` : `![${img.alt}][${key}]`;
        const parent = img.parentNode;
        if (parent) parent.replaceChild(document.createTextNode(literal), img);
      }
    });

    if (Object.keys(this.abbrMap).length > 0) this.applyAbbrs(this.root);
    this.renderFootnotes();
    this._applyLooseLists();
  }

  // A list is "loose" if a blank line ever appeared between/within its
  // items (marked live in onNewline's blank-line-in-list handling via
  // data-loose). Per CommonMark, a loose list wraps EVERY item's content in
  // <p> — including items that individually had no blank line and were
  // therefore built without one at the time. Applied once at the end, since
  // an item built early can only be retroactively found "loose" by a blank
  // line appearing LATER, elsewhere in the same list.
  _applyLooseLists() {
    const BLOCK_CHILD_TAGS = new Set(['P','UL','OL','PRE','BLOCKQUOTE','TABLE','H1','H2','H3','H4','H5','H6','HR','DL']);
    this.root.querySelectorAll('ul[data-loose], ol[data-loose]').forEach((list) => {
      list.removeAttribute('data-loose');
      for (const li of list.children) {
        if (li.tagName !== 'LI') continue;
        const leading = [];
        for (const child of li.childNodes) {
          if (child.nodeType === 1 && BLOCK_CHILD_TAGS.has(child.tagName)) break;
          leading.push(child);
        }
        if (leading.length === 0) continue;
        if (leading.every((n) => n.nodeType === 3 && !n.data.trim())) continue; // whitespace-only, nothing to wrap
        const p = document.createElement('p');
        li.insertBefore(p, leading[0]);
        for (const node of leading) p.appendChild(node);
      }
    });
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
