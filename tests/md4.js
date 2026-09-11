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
  // opts.commonMarkStrict (default false): CommonMark says "__x__" means
  // <strong> — the same as "**x**". This tool deliberately renders it as
  // <u> (underline) instead, since Markdown has no standard underline
  // syntax otherwise; set this to true to opt into the spec-compliant
  // <strong> behavior for "__" (e.g. for CommonMark conformance testing).
  constructor(rootEl, opts = {}) {
    rootEl.innerHTML = '';
    this.root = rootEl;
    this.dom  = new DomStack(rootEl);
    this.commonMarkStrict = !!opts.commonMarkStrict;

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
    this.inCodeFence = false; this.inIndentCode = false; this.pendingIndentNL = 0; this.indentCodeListCol = null;
    this.fenceChar = '`'; this.fencePrefix = ''; this.closingFenceBuf = null; this.fenceLineHasContent = false;
    this.fenceOpenIndent = 0; this.fenceLineIndent = 0; this.fenceLineIndentDone = false;
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
    this.mathInlineBuf = null; // "$...$" — not CommonMark, a common AI-output extension
    this.inMathBlock = false; this.mathBlockLineBuf = ''; this.mathBlockTextNode = null;

    this.sepWatch = false; this.sepFailed = false; this.sepRowEl = null; this.sepBuf = '';
    this.needsJoinSpace = false; this.hadJoinSpace = false;
    this.codeCloseRun = 0;
    this._inBlockquoteContent = false;
    this._inListContinuation = false;
    this.liAbsorb = null;
    this.atxSkipLeadingSpace = false;
    this.pendingListBlank = false; // NOT reset in resetLine(): set at the end of
    // a blank line (after resetLine already ran for it) and consumed at the
    // start of the NEXT line, so it must survive the resetLine() in between.
    this.pendingEmptyItem = false; // same idea, for a list marker with no
    // content on its own line (e.g. "-\n") — the NEXT line decides whether
    // it's this (tight) item's content or something else entirely.
    this._blankBeforeNewItem = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  _bd()              { this.blockDecided = true; this.pending = ''; }
  _pop(el)           { this.dom.popTo(el); this.dom.pop(); }
  _popMarkers()      { while (this.dom.current._mdMarker) this.dom.pop(); }
  _resetLinkUrl()    { this.linkState = null; this.urlBuf = ''; this.textNode = null; this._resetUrlParse(); }
  _resetUrlParse()   {
    this.urlPhase = 'dest'; this.urlAngle = undefined;
    this.urlDest = ''; this.urlTitle = null; this.urlTitleQuote = null;
    this.urlParenDepth = 0; this.urlEscapeNext = false; this.urlRawBuf = ''; this.urlFailed = false;
  }
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
    // Block math ("$$" alone on its own line, ended by another "$$"-alone
    // line — not CommonMark, a common AI-output extension): content is
    // fully literal, like a fenced code block, and every line (including a
    // blank one) survives until the matching close is found.
    // A dedicated text-node reference, not the shared this.textNode: the
    // latter gets reset to null by onNewline()'s own shared end-of-line
    // cleanup (flushInlinePending() etc.), which runs regardless of what
    // opened this block, unlike this.rawHtmlBuf's plain-string
    // accumulation used for the analogous raw-HTML case just above.
    if (this.inMathBlock) { this.mathBlockLineBuf += ch; if (this.mathBlockTextNode) this.mathBlockTextNode.data += ch; return; }
    // An open inline code span (an unclosed backtick-run opener) survives a
    // line ending — CommonMark 6.1 — so its content, including this line's
    // OWN leading whitespace, is still fully literal code-span content, not
    // something to run back through block-decision indentation logic
    // (which would otherwise misread it as e.g. an indented-code trigger).
    // onNewline() handles converting the line ending itself to a space.
    if (this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      this.onInlineChar(ch); this.lastChar = ch; return;
    }

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
        // Indented code WITHIN a list item, on the line right after a blank
        // one (pendingListBlank — dom.current is already sitting at the
        // <li> itself, not popped): the trigger column is the item's own
        // content column + 4, not a flat 4 from the start of the line —
        // opened as a direct child of the <li>, skipping closeBlock()'s
        // top-level _popToBlockContainer() dance, which would pop OUT of
        // the <li> entirely (there's nothing else open below it to close).
        const top = this.listStack[this.listStack.length - 1];
        if (this.pendingListBlank && top && this.lineIndent >= top.contentCol + 4) {
          this._markListLoose(top);
          if (!this.inIndentCode) {
            const pre = this.dom.push('pre');
            const code = document.createElement('code');
            pre.appendChild(code);
            this.textNode = document.createTextNode(''); code.appendChild(this.textNode);
            this.inIndentCode = true; this.lastBlockEl = pre;
          }
          this.indentCodeListCol = top.contentCol;
          this.pendingListBlank = false;
          // A tab can overshoot the trigger column (tabs jump to the next
          // multiple of 4, not one column at a time) — whatever's past the
          // threshold is still literal indentation WITHIN the code content,
          // not part of the syntax that opened it, so it's written out as
          // plain spaces rather than silently discarded.
          const overshoot = this.lineIndent - (top.contentCol + 4);
          if (overshoot > 0) this.textNode.data += ' '.repeat(overshoot);
          this._bd(); this.lineIndent = 0;
          return;
        }
        // Continuing an ALREADY-open indented code block that started
        // inside a list item (indentCodeListCol, set above) must keep
        // using that item's own trigger column, not the flat top-level 4
        // — otherwise a later, still list-relevant but less-indented line
        // (e.g. a blockquote at the item's plain content column) gets
        // wrongly absorbed as more code content instead of ending the
        // code block and being recognized as its own separate construct.
        const threshold = this.inIndentCode && this.indentCodeListCol != null ? this.indentCodeListCol + 4 : 4;
        if (this.lineIndent >= threshold && !['LI', 'P', 'DD'].includes(this.dom.currentTag())) {
          if (!this.inIndentCode) {
            this.closeBlock();
            const pre = this.dom.push('pre');
            const code = document.createElement('code');
            pre.appendChild(code);
            this.textNode = document.createTextNode(''); code.appendChild(this.textNode);
            this.inIndentCode = true; this.lastBlockEl = pre;
          }
          const overshoot = this.lineIndent - threshold;
          if (overshoot > 0) this.textNode.data += ' '.repeat(overshoot);
          this._bd(); this.lineIndent = 0;
        }
        return;
      }
      // An indented code block that was list-relative (indentCodeListCol)
      // just ended (this line's indent fell below its trigger) — if it's
      // STILL enough to belong to the item's own content column, this new
      // construct (whatever decideBlock() below decides it is) belongs
      // inside that <li> too, not at whatever level dom.current happens to
      // be sitting (the <pre> from the code block just closed). Ascend
      // back up to the <li> first so e.g. a blockquote here nests inside
      // it instead of popping all the way out of the list.
      const closedListRelativeCode = this.inIndentCode && this.indentCodeListCol != null && this.lineIndent >= this.indentCodeListCol;
      if (closedListRelativeCode) this._ascendToLI();
      this.inIndentCode = false; this.pendingIndentNL = 0; this.indentCodeListCol = null;
      if (this.pendingListBlank) {
        this.pendingListBlank = false;
        this._resolveListBlankContinuation(ch, true);
        return;
      }
      if (this.pendingEmptyItem) {
        this.pendingEmptyItem = false;
        this._resolveListBlankContinuation(ch, false);
        return;
      }
      // A list marker character (unlike most other block-starting
      // constructs) commits to opening a new item IMMEDIATELY, mid-line,
      // in decideBlock()'s own switch — before ever reaching the
      // equivalent "4+ indent while continuing an open paragraph is just
      // lazy-continuation text" check onNewline() applies to constructs
      // that stay undecided until end of line. A marker character at 4+
      // columns of indentation while continuing an open paragraph/list-
      // item/definition (and NOT just having exited a list-relative
      // indented code block, where dom.current sitting at the <li> is
      // deliberate — see _ascendToLI() above, not a real "still
      // continuing a paragraph" case) must not be allowed to interrupt it.
      if (!closedListRelativeCode && this.lineIndent >= 4 && this.dom.currentTag() === 'P'
          && /^[-*+0-9#]$/.test(ch)) {
        this.pending += ch; // _continueOrFallback() feeds `this.pending`, not `ch` directly
        // _continueOrFallback() checks hadJoinSpace, which is normally
        // promoted from needsJoinSpace at the top of onNewline() — but
        // this runs mid-line (processChar(), before that promotion for
        // THIS line has happened), so do it here instead.
        this.hadJoinSpace = this.needsJoinSpace; this.needsJoinSpace = false;
        this._continueOrFallback();
        return;
      }
      this.decideBlock(ch); return;
    }

    if (this.atxSkipLeadingSpace) {
      if (ch === ' ' || ch === '\t') return;
      this.atxSkipLeadingSpace = false;
    }
    if (this.liAbsorb) {
      const a = this.liAbsorb;
      if (ch === ' ' && a.extra < 3) {
        a.extra++; a.top.contentCol++;
        return;
      }
      if (ch === ' ') {
        // 5th consecutive space after the marker: per CommonMark, only the
        // first space is the required separator — content column snaps back
        // to right after it, and every space from the 2nd on (already
        // absorbed ones plus this one) is literal content instead.
        a.top.contentCol = a.base;
        this.liAbsorb = null;
        for (let i = 0; i < a.extra + 1; i++) { this.onContentChar(' '); }
        return;
      }
      this.liAbsorb = null;
      // The first real content character right after a list marker (and
      // its absorbed spaces) — same reasoning as openUlDecided()'s mixed-
      // buffer case just above: give it a chance to itself start a NESTED
      // block via decideBlock(), rather than always forcing it straight in
      // as this item's literal/inline text. liAbsorb is only ever set
      // right when a list item opens, so reaching this point always means
      // exactly that context.
      this.pending = ''; this.blockDecided = false;
      this.lineIndent = a.top.contentCol; // see openUlDecided()'s matching comment
      this.needsJoinSpace = false; // same reasoning: nothing to join yet
      this._inListContinuation = true; // see openUlDecided()'s matching comment
      this.decideBlock(ch);
      return;
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

    // A list item's marker was followed only by more whitespace, nothing
    // else, all the way to end of line (this.liAbsorb — set when the
    // marker's trailing spaces started absorbing, cleared the moment any
    // REAL content char arrives — is still set here only if that never
    // happened). Per CommonMark 5.2, a marker line with nothing but
    // trailing whitespace after it is treated exactly like an empty
    // marker with NO trailing spaces at all: content column snaps back to
    // right after the marker's single required space, regardless of how
    // many blank spaces actually followed it.
    if (this.liAbsorb) {
      this.liAbsorb.top.contentCol = this.liAbsorb.base;
      this.liAbsorb = null;
      this.pendingEmptyItem = true;
    }

    // A still-pending backtick run (e.g. the line ends right after "``",
    // with no following character to resolve it yet) needs resolving
    // FIRST — it may be about to open a brand new code span, which must
    // then be caught by the check right below instead of being torn down
    // again before it even holds any content.
    if (this.inlinePending && this.inlinePending[0] === '`') this.flushInlinePending();

    // An open inline code span survives the line ending — CommonMark 6.1
    // converts it to a single space in the span's content, rather than
    // closing the span (matches processChar()'s matching bypass for the
    // continuation line's own leading whitespace). Left open for however
    // many further lines it takes to find a matching-length closer, or
    // until the enclosing block itself closes — see _flushCodeSpans(),
    // which reverts it to literal text if no closer is ever found.
    if (this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      // A run of closing backticks sitting right at end-of-line, not yet
      // confirmed to be the full matching length (it could still continue
      // on... no — a line ending always terminates a backtick run either
      // way), closes the span if it's exactly the right length, else is
      // literal content — same logic as the old post-EOL check this
      // replaces, just run BEFORE appending the line-ending space so nei-
      // ther gets lost or misordered.
      if (this.codeCloseRun) {
        if (this.codeCloseRun === this.dom.current._mdMarker.length) { this._closeCodeSpan(); this.codeCloseRun = 0; this.resetLine(); return; }
        this.appendToTextNode('`'.repeat(this.codeCloseRun)); this.codeCloseRun = 0;
      }
      this.appendToTextNode(' ');
      this.resetLine(); return;
    }

    if (this.defPending && this.defPending.type === 'ref') {
      // A reference definition's destination and title may each be
      // followed by whitespace that includes a line ending (CommonMark
      // 4.7) — so a line ending doesn't necessarily finish the
      // definition; keep going while there's still a chance of a
      // destination or title continuing on the next line, and only
      // finalize once nothing more could reasonably follow.
      const d = this.defPending;
      // A genuine grammar violation (not just "no title present" — that's
      // handled by _feedDefChar()'s 'reprocess' signal, not failed) means
      // this was never a valid definition at all; finalize (as failed)
      // right away instead of waiting indefinitely for a blank line that
      // may never come, silently swallowing everything after it in the
      // meantime (the actual bug this guard exists to prevent).
      if (d.failed) { this.flushDefPending(); this.resetLine(); return; }
      if (d.phase === 'dest' && !d.angle && d.dest !== '') d.phase = 'gap'; // bare dest ends at whitespace, incl. a line ending
      if (d.phase === 'title') { d.title += '\n'; this.resetLine(); return; }
      // NOT this.pending — that's already been cleared (by _bd(), when the
      // definition itself first started) and stays empty the whole time
      // regardless of how many characters _feedDefChar() has consumed.
      // linePos counts every character of the CURRENT line the normal way
      // (processChar() increments it before dispatching anywhere), so
      // linePos === 0 here means truly nothing — not even whitespace —
      // was typed since the last line ending.
      const lineBlank = this.linePos === 0;
      if (d.phase === 'gap' || (d.phase === 'dest' && d.dest === '')) {
        if (lineBlank) { this.flushDefPending(); this.resetLine(); return; } // nothing more can follow a blank line
        this.resetLine(); return; // still might get a destination/title on the next line
      }
      // phase 'trail', or an unterminated "<...>" destination — done either way.
      if (d.phase === 'dest' && d.angle) d.failed = true;
      this.flushDefPending(); this.resetLine(); return;
    }
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
    if (this.inMathBlock) {
      const mathLine = this.mathBlockLineBuf;
      this.mathBlockLineBuf = '';
      if (this.mathBlockTextNode) this.mathBlockTextNode.data += '\n';
      if (mathLine.trim() === '$$') {
        this.inMathBlock = false;
        if (this.lastBlockEl) this._pop(this.lastBlockEl);
        this.mathBlockTextNode = null; this.textNode = null; this.lastBlockEl = null;
      }
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
        // ends the current paragraph, same as a top-level blank line — but
        // does NOT start a new one immediately (that produced a stray empty
        // <p></p> for every blank quoted line, even a lone ">" with nothing
        // else in the quote at all). A fresh paragraph is opened lazily,
        // the normal way (via fallbackToParagraph()), only once real
        // content actually follows.
        if (level > 0) {
          if (this.dom.currentTag() === 'P') this.dom.pop();
          this.ensureBlockquote(level);
        }
      } else if ((p[0] === '`' || p[0] === '~') && p.length >= 3 && p.split('').every(c => c === p[0])) {
        this.closeBlock(); this.inCodeFence = true; this.fenceChar = p[0];
        this.fenceCount = p.length; this.fencePrefix = null; this.closingFenceBuf = null;
        this.fenceOpenIndent = this.lineIndent;
        this.onCodeFenceNewline();
      } else if (p[0] === '*' && /^\*{3,}$/.test(p)) {
        this.makeHr();
      } else if (p[0] === '-' && /^-{3,}$/.test(p)) {
        if (this.lastBlockEl?.tagName === 'P' && this._setextAllowed()) this.resolveSetext('h2');
        else this.makeHr();
      } else if (/^[_ ]+$/.test(p) && (p.match(/_/g)||[]).length >= 3) {
        this.makeHr();
      } else if (/^- (- ?)+$/.test(p.trimEnd()) && (p.match(/-/g)||[]).length >= 3) {
        this.makeHr();
      } else if (p[0] === '-' && /^- /.test(p)) {
        this.openUlDecided(p.slice(2), '-');
      } else if (/^[-*+]$/.test(p) && contTag !== 'P') {
        // A bullet marker alone on its line, nothing after it — still a
        // valid (empty, for now) list item; the content column is as if
        // followed by exactly one space (CommonMark 5.2), and whatever the
        // NEXT line turns out to be decides if this item gets real content
        // or stays empty (see pendingEmptyItem in processChar()). Cannot
        // interrupt an already-open paragraph (CommonMark 5.2) — that case
        // falls through to the ordinary lazy-continuation fallback below.
        this.openListItem('ul', this.lineIndent, p, undefined, this.lineIndent + 2);
        this._bd(); this.pendingEmptyItem = true;
      } else if (/^[0-9]{1,9}[.)]$/.test(p) && contTag !== 'P') {
        this.openListItem('ol', this.lineIndent, p[p.length - 1], parseInt(p.slice(0, -1), 10), this.lineIndent + p.length + 1);
        this._bd(); this.pendingEmptyItem = true;
      } else if (/^<\/?[a-zA-Z][a-zA-Z0-9-]*$/.test(p)) {
        // decideBlock()'s "<" case waits for one more character once the
        // tag name exactly fills `p` (greedy name-matching means that's
        // the only way to be SURE the name is complete) — but if the line
        // ends right there (e.g. "<style\n", the ">" arriving on a LATER
        // line), that confirming character is a newline, which bypasses
        // decideBlock() entirely. Resolve it here the same way once the
        // whole line — just the tag name, nothing else — is known.
        const name = p.slice(p[1] === '/' ? 2 : 1).toLowerCase();
        if (HTML_BLOCK1_TAGS.has(name)) this._startHtmlBlock('tag', name);
        else if (HTML_BLOCK6_TAGS.has(name)) this._startHtmlBlock('blank', null);
        else this._continueOrFallback();
        if (this.inRawHtml) { this.rawHtmlBuf += '\n'; this.rawHtmlLineBuf = ''; }
      } else if (p[0] === '<' && !['P', 'LI', 'DD'].includes(contTag) && this._isCompleteType7Line(p)) {
        // Type 7 HTML block: the whole line is one complete tag, alone —
        // decideBlock()'s own "<" case deferred this exact decision here,
        // once the whole line (and the fact that nothing else follows the
        // tag but whitespace) is actually known.
        this._startHtmlBlock('blank', null);
        this.rawHtmlBuf += '\n'; this.rawHtmlLineBuf = '';
      } else if (p === '$$' && contTag !== 'P' && contTag !== 'LI' && contTag !== 'DD') {
        // Block math opener: "$$" alone on its own line — decideBlock()'s
        // "$" case waits here the same way "<" does for a tag name (see
        // above); resolved once the whole line is known to be just "$$".
        // Cannot interrupt an open paragraph, same restriction as type-7
        // HTML blocks and an empty list marker (a bare "$$" mid-paragraph
        // reads far more naturally as literal text than a display-math
        // opener).
        this._startMathBlock();
      } else if (/^#{1,6}$/.test(p)) {
        // A bare "#".."######" alone on a line (no trailing space, but also
        // no more content before the newline) is still a valid — empty —
        // ATX heading, per CommonMark: the trailing space is only required
        // when there IS heading content to separate it from.
        this.closeBlock(); this.listStack = [];
        const h = this.dom.push('h' + Math.min(p.length, 6)); this.lastBlockEl = h;
        this._bd(); this.atxLevel = p.length;
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
      if (li && tag === 'LI' && this.pendingEmptyItem) {
        // The list marker's own line had NO content at all, and this
        // line is ALSO blank — CommonMark: such an item stays empty
        // permanently; unlike an ordinary blank-line-then-indented-
        // content continuation, indented content after a SECOND blank
        // line does not belong to it. Finalize the (still empty) item
        // now instead of arming pendingListBlank, which would otherwise
        // let a later indented line join it as a second paragraph.
        this.pendingEmptyItem = false;
        this._flushEmphasis(this.dom.current); this.dom.pop();
        this.textNode = null; this.lastBlockEl = null;
      } else if (li && (tag === 'P' || tag === 'LI')) {
        // A blank line inside a list item doesn't necessarily end the list —
        // it might just separate this item's paragraphs, or separate this
        // item from the next one (which is what makes the whole list
        // "loose": every item's content gets wrapped in <p>, even single-
        // paragraph ones) — OR the list might simply be ending here, with
        // unrelated content following at a shallower indent, in which case
        // this blank line does NOT make it loose. Stay positioned at the LI;
        // _resolveListBlankContinuation (called for the next line) decides
        // which case this is, and marks looseness only when warranted.
        this._flushEmphasis(this.dom.current);
        if (tag === 'P') this.dom.pop();
        this.textNode = null; this.lastBlockEl = null;
        this.pendingListBlank = true;
      } else if (tag === 'P') {
        this._flushEmphasis(this.dom.current);
        this.dom.pop(); this.textNode = null; this.lastBlockEl = null;
        // A genuinely blank line (no ">" prefix at all — that case is
        // handled separately above, and does NOT exit the quote) always
        // ends every currently open blockquote, even nested ones — unlike
        // a list item, a blockquote does not survive a blank line via lazy
        // continuation.
        while (this.dom.currentTag() === 'BLOCKQUOTE') this.dom.pop();
      } else if (tag === 'DD') {
        this._flushEmphasis(this.dom.current);
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

    // Same for inline math: it doesn't span a line ending, so an
    // unresolved "$..." at end-of-line was never valid math after all.
    if (this.mathInlineBuf !== null) {
      this.appendToTextNode('$' + this.mathInlineBuf);
      this.mathInlineBuf = null;
    }

    // Same for an unresolved "&entity" attempt with no closing ";" yet.
    if (this.entityBuf !== null) {
      this.appendToTextNode(this.entityBuf);
      this.entityBuf = null;
    }

    this.flushInlinePending();
    // That flush may have JUST opened a brand new code span — most notably
    // a "``"-style opener sitting at the very start of a line, which is
    // only disambiguated from a code FENCE (3+ backticks) at the block
    // level, so it doesn't reach inline handling (and this check) until
    // the undecided-line fallback above has already run. Same preserve-
    // across-the-newline treatment as the early check at the top of this
    // function, which only catches an ALREADY-open span from a prior line.
    if (this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      this.appendToTextNode(' ');
      this.resetLine(); return;
    }
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
    } else if (this.linkState === 'url') {
      // A link destination/title never reaching its closing ")" before the
      // line ends — CommonMark's inline-link destination cannot itself
      // contain a raw line ending (a title spanning lines is a separate,
      // not-yet-supported case) — the whole "[label](..." attempt, as
      // typed so far, falls back to literal text, same shape as an
      // in-line failure (_feedUrlChar returning {failed:true}).
      const a = this.dom.find('A');
      if (a) { a.insertBefore(document.createTextNode('['), a.firstChild); a.appendChild(document.createTextNode(']')); }
      this.abortLinkElement('(' + this.urlRawBuf);
    } else if (this.linkState === 'img_url') {
      this.appendToTextNode('![');
      for (const c of this.linkBuf) { this.onInlineChar(c); this.lastChar = c; }
      this.appendToTextNode('](' + this.urlRawBuf);
      this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false; this.linkState = null;
      this._resetUrlParse();
    } else if (this.linkState !== null) {
      this.abortLinkElement(null);
    }

    if (this.atxLevel && this.textNode)
      this.textNode.data = this.textNode.data.replace(/^#+\s*$/, '').replace(/\s+#+\s*$/, '').replace(/\s+#+$/, '').replace(/ +$/, '');
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
    this._inListContinuation = false;
    this._blankBeforeNewItem = false;
    this.liAbsorb = null;
    this.atxSkipLeadingSpace = false;
  }

  // ── Block decision ─────────────────────────────────────────────────────────
  _blockDefault(ch) {
    if (this.defPending) {
      if (this.defPending.type === 'ref') { if (this._feedDefChar(ch) === 'reprocess') this._reprocessAfterDef(ch); }
      else this.defPending.value += ch;
      return;
    }
    const tag = this.dom.currentTag();
    if (tag === 'P' || tag === 'LI' || tag === 'DD') {
      if (this.needsJoinSpace) { this.needsJoinSpace = false; this.appendToTextNode(' '); this.lastChar = ' '; }
      this.feedPendingAsInline(); this.blockDecided = true; return;
    }
    if (tag === 'BLOCKQUOTE' && this._inBlockquoteContent) {
      // A freshly-entered blockquote (ensureBlockquote() just pushed it,
      // no <p> inside it yet) needs one opened directly, in place — NOT
      // the full fallbackToParagraph() (closeBlock() + listStack = []),
      // which assumes the current container is being abandoned entirely.
      // It isn't: this blockquote can itself be nested inside a list item
      // (e.g. "* a\n  > b\n"), and unconditionally clearing listStack
      // there orphaned it, so a LATER sibling marker started a whole new
      // list instead of continuing the one still legitimately open.
      this.openParagraph(); this.blockDecided = true; this.feedPendingAsInline(); return;
    }
    this.fallbackToParagraph();
  }

  decideBlock(ch) {
    // A reference definition still waiting to see whether a title follows
    // (this.defPending, phase 'gap' or an empty still-open 'dest') claims
    // every character first, even one that would otherwise look like the
    // start of some other block (most notably a FRESH "[label]:" —
    // without this, that would silently overwrite the still-pending one
    // via the "[" case below, discarding it — never flushed, never
    // registered) — _feedDefChar()'s 'reprocess' signal is what lets this
    // character fall through to the switch below once the old definition
    // is actually finished, same path _blockDefault()/onContentChar() use
    // once this line's block type is already decided.
    if (this.defPending && this.defPending.type === 'ref') {
      if (this._feedDefChar(ch) !== 'reprocess') return;
      this.flushDefPending();
    }
    this.pending += ch;
    const p = this.pending;

    switch (p[0]) {
      case '$':
        // Block math ("$$" alone on its own line — not CommonMark, a
        // common AI-output extension). Kept deliberately narrow: only
        // fires when "$$" is the WHOLE line (confirmed once a 3rd
        // character shows content follows it on the same line, or via
        // onNewline()'s undecided-line handling if the line ends right at
        // "$$") — content immediately after "$$" on its own opening line
        // is treated as ordinary text instead, avoiding any ambiguity
        // with inline math or a bare "$" for currency.
        if (p.length === 1) return;
        if (p === '$$') return;
        this._blockDefault(ch); return;
      case '#':
        if (ch === '#' && p.length <= 6) return;
        if ((ch === ' ' || ch === '\t') && p.length >= 2 && /^#{1,6}$/.test(p.slice(0,-1))) {
          const level = p.length - 1;
          // Nested directly inside a list item via that item's own first-
          // content replay (e.g. "- # Foo" — see openUlDecided()/liAbsorb)
          // — the <li> is freshly opened and still completely empty,
          // nothing to close, and the enclosing list is still legitimately
          // open; don't touch it, unlike the ordinary case (e.g. "- foo\n
          // # bar\n", where dom.current is ALSO 'LI' — a tight item's text
          // goes straight in with no <p> wrapper — but with real content
          // already in it, meaning the heading genuinely ends the list).
          const freshInLI = this.dom.currentTag() === 'LI' && this.dom.current.childNodes.length === 0;
          if (!freshInLI) { this.closeBlock(); this.listStack = []; }
          const h = this.dom.push('h' + Math.min(level, 6)); this.lastBlockEl = h;
          this._bd(); this.atxLevel = level; this.atxSkipLeadingSpace = true; return;
        }
        if (ch !== '#') this._blockDefault(ch);
        return;

      case '>': {
        const { level, i } = this._bqLevel(p);
        if (i === p.length) return;
        // Wait while everything after the ">" marker(s) so far is still
        // just whitespace — could still turn into real content, or the
        // line could end up entirely blank (">  \n"), which must NOT open
        // a paragraph at all (handled by onNewline's undecided-line
        // fallback once blockDecided never became true for this line).
        if (/^ *$/.test(p.slice(i))) return;
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
          this.fenceOpenIndent = this.lineIndent;
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
          if (this.lastBlockEl?.tagName === 'P' && this._setextAllowed()) {
            return this.lineIndent < 4 ? this.startSetextWatch('-', p, p[1] !== '-') : this._blockDefault(ch);
          }
          // "-" followed by neither a space nor another "-" can never
          // become a valid list marker, thematic break, or setext
          // underline — it's just literal text starting with "-", so
          // fall back directly instead of routing through hrWatch with a
          // hardcoded (and here, WRONG — only 1 real "-" was ever seen)
          // dash count, which lost every character typed after it.
          if (p[1] !== '-') { this._blockDefault(ch); return; }
          return this.startHrWatch('-', 2, false);
        }
        if (p.length === 3) {
          if (p === '- -' || p === '- *') return;
          if (p[1] === ' ' && p[2] !== '-' && p[2] !== ' ') return this.openUlDecided(p[2], '-');
          if (p[1] === ' ' && p[2] === ' ') return;
          if (this.lastBlockEl?.tagName === 'P' && this._setextAllowed()) {
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
        if (this.lastBlockEl?.tagName === 'P' && this.lineIndent < 4 && this._setextAllowed()) { this.startSetextWatch('=', p, ch !== '='); return; }
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
        // Reference link definition [label]: — cannot interrupt an
        // already-open paragraph (CommonMark 4.7), same restriction as
        // type-7 HTML blocks and an empty list marker. A freshly-opened,
        // still-EMPTY <p> doesn't count as "already open" here — that's
        // exactly the shape _resolveListBlankContinuation() leaves behind
        // right before replaying a list item's second-paragraph content
        // through decideBlock(), and a definition there is perfectly
        // valid (e.g. "- a\n- b\n\n  [ref]: /url\n- d\n").
        if (!p[1]) return;
        {
          const curTag = this.dom.currentTag();
          const cannotInterrupt = curTag === 'LI' || curTag === 'DD'
            || (curTag === 'P' && this.dom.current.childNodes.length > 0);
          if (cannotInterrupt) { this._blockDefault(ch); return; }
        }
        const ci = p.indexOf(']:');
        if (ci > 1) {
          // A definition produces no visible content of its own — if it's
          // starting inside a still-empty <p> (see the childNodes check
          // above), that <p> was only ever a placeholder for content that
          // never actually arrived; remove it rather than leaving a stray
          // empty element behind.
          if (this.dom.currentTag() === 'P' && this.dom.current.childNodes.length === 0) {
            const emptyP = this.dom.current;
            this.dom.pop();
            emptyP.remove();
          }
          this.defPending = {
            type: 'ref', key: p.slice(1, ci).toLowerCase(),
            phase: 'dest', dest: '', title: null, titleQuote: null,
            angle: undefined, parenDepth: 0, escapeNext: false, failed: false,
          };
          this._bd(); return;
        }
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
        // Type 7: not a recognized block-level tag name, but this line
        // could still turn out to be "a complete open or closing tag,
        // alone on its line" (any tag name) — can't tell until the WHOLE
        // line is seen (nothing else may follow but whitespace), so keep
        // waiting rather than deciding now, UNLESS already inside an open
        // paragraph/list-item/definition: unlike types 1-6, type 7 cannot
        // interrupt one. onNewline()'s undecided-line handling makes the
        // actual call once the line is complete (_isCompleteType7Line()).
        if (!['P', 'LI', 'DD'].includes(this.dom.currentTag())) return;
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
        // Ordered list — CommonMark allows any digit 0-9 to start the
        // number (start values 0 through 999999999), not just 1-9.
        if (p[0] >= '0' && p[0] <= '9') {
          let i = 1;
          while (i < p.length && p[i] >= '0' && p[i] <= '9') i++;
          if (i === p.length) return;
          if (i > 9 || (p[i] !== '.' && p[i] !== ')')) { this._blockDefault(ch); return; }
          if (i + 1 === p.length) return;
          if (p[i + 1] === ' ') {
            const contentCol = this.linePos;
            this.openListItem('ol', this.lineIndent, p[i], parseInt(p.slice(0, i), 10), contentCol);
            this._bd();
            this.liAbsorb = { top: this.listStack[this.listStack.length - 1], base: contentCol, extra: 0 };
            return;
          }
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
    if (this.defPending) {
      if (this.defPending.type === 'ref') { if (this._feedDefChar(ch) === 'reprocess') this._reprocessAfterDef(ch); }
      else this.defPending.value += ch;
      return;
    }
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

    // Inline math: $...$ (a non-standard extension, not CommonMark — but
    // near-universal in AI-model output). Content is buffered and kept
    // 100% literal, like an autolink's "<...>" span just below: LaTeX
    // relies heavily on "\" and "_" and "*", none of which should be
    // touched by escape/entity/emphasis handling while inside it. Per the
    // common convention (matching most chat-UI renderers), the delimiter
    // must not have whitespace touching it on the inside — "$5 vs $10"
    // stays plain text — and doesn't span a line ending (see onNewline()'s
    // matching abandon-on-EOL handling). Kept single-line-only (unlike the
    // DOM-native two-pass resolvers for emphasis/code spans) since inline
    // math is overwhelmingly single-line in practice, and this is already
    // the same lightweight buffer-until-delimiter shape already used here
    // for autolinks/entities, not a new pattern.
    if (this.mathInlineBuf !== null) {
      if (ch === '$') {
        if (this.mathInlineBuf.length > 0 && !/^\s|\s$/.test(this.mathInlineBuf)) {
          const span = document.createElement('span');
          span.className = 'math math-inline';
          span.appendChild(document.createTextNode('$' + this.mathInlineBuf + '$'));
          this.dom.current.appendChild(span);
          this.textNode = null; this.mathInlineBuf = null;
          this.prevCharWs = false; return;
        }
        // Empty, or whitespace touching a delimiter — never valid math;
        // the opening "$" and everything buffered become literal text,
        // and this "$" gets a fresh chance as a new potential opener.
        this.appendToTextNode('$' + this.mathInlineBuf);
        this.mathInlineBuf = '';
        return;
      }
      this.mathInlineBuf += ch;
      return;
    }
    // NOT "if (ch === '$') start math" here — a backslash-escaped "\$"
    // must be handled by the ESCAPE logic below first (consuming the "\"
    // and writing a literal "$"), or "\$" would always open math instead
    // of ever being escapable. See the trigger further down, after
    // escapeNext is checked.

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

    // A still-pending marker (e.g. an unresolved backtick run buffered by
    // isMarkerChar() below, waiting to see if it's followed by more of the
    // same char) must be resolved before any of the checks below try to
    // start a NEW special construct on the character right after it.
    // Without this, e.g. "`<b>`" resolves the '<' as the start of a raw
    // HTML/autolink tag instead of as the first literal character of the
    // code span that's still pending — turning `<abbr title="...">` into
    // a real <abbr> element instead of literal code text. Resolving here
    // mirrors what the '=' (highlight) branch already does below.
    if (this.inlinePending && (ch === '\\' || ch === '$' || ch === '&' || ch === '<' || (this.prevCharWs && ch === 'h'))) {
      this.resolveInlinePending(ch);
      this.prevCharWs = false;
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

    if (ch === '$') { this.mathInlineBuf = ''; return; }

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
      // CommonMark: links cannot nest — a "[" while already inside an open
      // link label is just a literal character (an image CAN still nest
      // inside a link, handled separately via "bang" above). Not the full
      // bracket-matching algorithm (which would also let an outer "["
      // "reclaim" this position if the resulting inner "[...]" never turns
      // out to be a valid link itself) — a scoped, lower-risk improvement
      // over unconditionally opening a nested <a>, which produced invalid
      // nested-anchor markup for any "[...[...]...]" content.
      if (this.dom.find('A')) { this.appendToTextNode(ch); this.prevCharWs = false; return; }
      const a = this.dom.push('a'); this.initAnchor(a);
      this.textNode = null;
      this.linkState = 'label_open'; this.urlBuf = ''; this.linkBuf = '';
      this.prevCharWs = false; return;
    }

    if (this.isMarkerChar(ch)) {
      if (this.inlinePending && ch !== this.inlinePending[0]) {
        this.resolveInlinePending(null, ch);
        // Resolving the PREVIOUS marker may have just opened a code span
        // right here (e.g. a backtick run immediately followed by another
        // marker char, "`*`") — re-enter onInlineChar for `ch` so it's now
        // handled by the dedicated code-content branch (checked at the
        // very top of this function) instead of being wrongly queued below
        // as a fresh marker attempt positioned INSIDE that code span.
        if (this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
          this.onInlineChar(ch);
          return;
        }
      }
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
    code._mdMarker = null; // successfully matched — no longer an "open" span for _flushCodeSpans()
    this.dom.pop();
    this.textNode = null;
    // A code span can close partway through a line that RESUMED after
    // surviving one or more earlier line endings (see onNewline()) — that
    // resume bypasses normal block-decision entirely (processChar()'s
    // top-of-function guard), leaving blockDecided false even though we're
    // still mid-paragraph. Restore it so the rest of this line's characters
    // go back through ordinary inline content handling, not decideBlock().
    this.blockDecided = true;
  }

  // CommonMark 6.6 open-tag grammar: tagname followed by zero or more
  // attributes, each of which needs its OWN leading whitespace — no
  // whitespace before an attribute (e.g. "href='bar'title=title", where
  // "title" directly follows the closing quote) makes the whole thing not
  // a valid tag at all, so it must render as literal (escaped) text
  // instead of being parsed into a real element.
  _isValidOpenTagBody(buf) {
    const m = buf.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
    if (!m) return false;
    let rest = buf.slice(m[0].length);
    const attrRe = /^\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(\s*=\s*([^\s"'=<>`]+|'[^']*'|"[^"]*"))?/;
    while (rest.length) {
      if (/^\s*\/?\s*$/.test(rest)) return true;
      const am = rest.match(attrRe);
      if (!am) return false;
      rest = rest.slice(am[0].length);
    }
    return true;
  }

  // HTML block type 7 (CommonMark 4.6): true if the whole line (already
  // known to start with "<") is nothing but ONE complete open or closing
  // tag, optionally followed by trailing whitespace — reuses the same
  // open-tag grammar already used for inline "<...>" validation.
  _isCompleteType7Line(p) {
    if (/^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>\s*$/.test(p)) return true; // closing tag
    const m = p.match(/^<([a-zA-Z][a-zA-Z0-9-]*[\s\S]*?)>\s*$/);
    return !!m && this._isValidOpenTagBody(m[1]);
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
    if (openMatch && this._isValidOpenTagBody(buf)) {
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

    // CommonMark 6.9's email autolink grammar is much stricter than "any
    // non-whitespace around an @" — no backslash, no unbalanced/invalid
    // domain-label punctuation, etc. A buffered "<...>" that doesn't fit
    // either real grammar (this one, or the URI scheme one above) is just
    // literal angle-bracketed text, not an autolink.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*$/.test(buf)
        || /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(buf)) {
      const a = document.createElement('a');
      const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(buf);
      a.href = this._encodeUrl(buf.includes('@') && !hasScheme ? 'mailto:' + buf : buf);
      this.initAnchor(a); a.appendChild(document.createTextNode(buf));
      this.dom.current.appendChild(a); this.textNode = null;
      this.prevCharWs = false; return;
    }

    // Not a valid tag or autolink after all — just an ordinary "<", the
    // buffered text, and ">". Only backslash-escape processing applies
    // (e.g. "<foo\+@bar>" -> "<foo+@bar>the ">"); full inline reprocessing
    // (emphasis, bare-URL autolinking, ...) does NOT apply here — this text
    // was never seen char-by-char by the normal inline pipeline while
    // buffered waiting for the closing ">", so replaying it through that
    // pipeline now, out of its original streaming context, doesn't
    // reproduce what char-by-char parsing would actually have done.
    this.appendToTextNode('<' + buf.replace(/\\([!-/:-@[-`{-~])/g, '$1') + '>');
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
        else if (ch === ']') {
          // Same "]]" backtrack as the non-image case: the PREVIOUS "]"
          // wasn't really the alt text's end after all — it becomes
          // literal, and this one gets a fresh chance.
          this.linkBuf += ']';
          this.linkState = 'img_alt';
          this.onLinkChar(ch);
        }
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
        const result = this._feedUrlChar(ch);
        if (result !== null) {
          const insideLink = !!this.dom.find('A');
          if (result.failed) {
            // Invalid destination/title syntax — never really an image at
            // all; "![", the label (replayed so any markup inside it still
            // works), and the whole "(...)" attempt (exactly as typed,
            // via urlRawBuf) all become literal text instead.
            this.appendToTextNode('![');
            for (const c of this.linkBuf) { this.onInlineChar(c); this.lastChar = c; }
            this.appendToTextNode('](' + this.urlRawBuf);
          } else {
            const img = document.createElement('img');
            img.src = result.url; img.alt = this._renderInlineToPlainText(this.linkBuf);
            if (result.title) img.title = result.title;
            if (!insideLink) img.className = 'blk';
            this.dom.current.appendChild(img);
            this.textNode = null;
          }
          this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
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
        else if (ch === ']') {
          // "]]" or longer — the PREVIOUS "]" (the one that got us into
          // this state) didn't actually close the label after all
          // (nothing valid follows it), so IT becomes literal label
          // content now — and THIS "]" gets a fresh chance to be the real
          // closing bracket, by going back to label_open and immediately
          // re-dispatching it there. A minimal, targeted piece of
          // CommonMark's full bracket-matching algorithm (which in
          // general also lets an even EARLIER unmatched "[" reclaim a
          // position — not implemented — but this covers the common
          // "multiple stray closing brackets in one label" case, e.g.
          // "[link [foo [bar]]](/uri)"). The <a> is still open here
          // (label_open's own "]" handling never closes it, only ends the
          // label-accumulation phase), so the literal "]" just becomes
          // ordinary label content.
          this.appendToTextNode(']');
          this.linkState = 'label_open';
          this.onLinkChar(ch);
        }
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
        const result = this._feedUrlChar(ch);
        if (result !== null) {
          if (result.failed) {
            // Invalid destination/title syntax — the "[label]" was never
            // really a link; unwrap the <a> (its content, e.g. already-
            // rendered emphasis inside the label, stays as plain content,
            // with a literal "[" restored before it — never written
            // earlier, since "[" commits straight to a real <a> for the
            // live-streaming case) and append "(" + the whole failed
            // attempt, exactly as typed.
            const a = this.dom.find('A');
            if (a) { a.insertBefore(document.createTextNode('['), a.firstChild); a.appendChild(document.createTextNode(']')); }
            this.abortLinkElement('(' + this.urlRawBuf);
          }
          else {
            const a = this.dom.find('A');
            if (a) { a.href = result.url; if (result.title) a.title = result.title; this._pop(a); }
            this._resetLinkUrl();
          }
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
    img.alt = this._renderInlineToPlainText(this.linkBuf);
    img.dataset.refKey = refKey;
    if (isShortcut) img.dataset.refShortcut = '1';
    if (!insideLink) img.className = 'blk';
    this.dom.current.appendChild(img);
    this.textNode = null; this.linkBuf = ''; this.urlBuf = ''; this.linkIsImage = false;
    this.linkState = insideLink ? 'label_open' : null;
  }

  // CommonMark: an image's "alt" attribute is the PLAIN-TEXT rendering of
  // its label — any inline markup in the label (emphasis, code spans,
  // nested links/images, entities, ...) is processed as usual and then
  // flattened to text, not kept as literal markdown source. Rendered into a
  // detached scratch element using the same inline machinery as real
  // content, then read back via textContent (which itself strips all
  // tags) — no separate plain-text renderer needed.
  _renderInlineToPlainText(raw) {
    const scratch = document.createElement('span');
    const saved = {
      current: this.dom.current, textNode: this.textNode, inlinePending: this.inlinePending,
      lastChar: this.lastChar, prevCharWs: this.prevCharWs, pendingDelimBefore: this.pendingDelimBefore,
      linkState: this.linkState, linkBuf: this.linkBuf, urlBuf: this.urlBuf, linkIsImage: this.linkIsImage,
    };
    this.dom.current = scratch; this.textNode = null; this.inlinePending = '';
    this.lastChar = undefined; this.prevCharWs = true; this.linkState = null;
    for (const ch of raw) { this.onInlineChar(ch); this.lastChar = ch; }
    this.flushInlinePending();
    this._flushCodeSpans(scratch);
    this._flushEmphasis(scratch);
    const text = scratch.textContent;
    this.dom.current = saved.current; this.textNode = saved.textNode; this.inlinePending = saved.inlinePending;
    this.lastChar = saved.lastChar; this.prevCharWs = saved.prevCharWs; this.pendingDelimBefore = saved.pendingDelimBefore;
    this.linkState = saved.linkState; this.linkBuf = saved.linkBuf; this.urlBuf = saved.urlBuf; this.linkIsImage = saved.linkIsImage;
    return text;
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

  // Feeds one character of a `(...)` inline link/image destination + title,
  // following CommonMark 6.3's actual grammar via an explicit phase state
  // machine (dest -> gap -> title -> trail), rather than accumulating
  // everything and trying to split a destination from a title after the
  // fact (which can't correctly tell an escaped delimiter from a real one,
  // since escapes are resolved as characters arrive, not after).
  // Returns null while still accumulating, or — once the closing,
  // unnested ')' is reached — either { url, title } on success or
  // { failed: true } if the destination/title never matched valid syntax
  // (caller falls the whole "(...)" attempt back to literal text, via
  // urlRawBuf, which always holds every character exactly as typed).
  _feedUrlChar(ch) {
    this.urlRawBuf += ch;

    if (this.urlEscapeNext) {
      this.urlEscapeNext = false;
      // Only ASCII punctuation is a recognized escape (CommonMark 2.4) —
      // anything else keeps the backslash literal, both characters kept.
      const lit = this._isPunct(ch) ? ch : '\\' + ch;
      if (this.urlPhase === 'dest') this.urlDest += lit;
      else if (this.urlPhase === 'title') this.urlTitle += lit;
      else this.urlFailed = true;
      return null;
    }
    if (ch === '\\' && (this.urlPhase === 'dest' || this.urlPhase === 'title')) {
      this.urlEscapeNext = true;
      return null;
    }

    if (this.urlPhase === 'dest') {
      if (this.urlAngle === undefined) {
        this.urlAngle = ch === '<' && this.urlDest === '';
        if (this.urlAngle) return null; // consume the "<" itself, not part of the destination
      }
      if (this.urlAngle) {
        if (ch === '>') { this.urlPhase = 'gap'; return null; }
        if (ch === '<') this.urlFailed = true; // an unescaped "<" inside <...> is invalid
        this.urlDest += ch; return null;
      }
      // Bare (unwrapped) destination: balanced, unescaped parens are part
      // of it; it ends at the first whitespace (start of the gap before an
      // optional title) or the closing ")" of the whole construct.
      if (ch === '(') { this.urlParenDepth++; this.urlDest += ch; return null; }
      if (ch === ')') {
        if (this.urlParenDepth > 0) { this.urlParenDepth--; this.urlDest += ch; return null; }
        return this._finishUrl();
      }
      if (/\s/.test(ch)) { this.urlPhase = 'gap'; return null; }
      this.urlDest += ch; return null;
    }

    if (this.urlPhase === 'gap') {
      // Whitespace between the destination and an optional title.
      if (ch === ')') return this._finishUrl();
      if (/\s/.test(ch)) return null;
      if (ch === '"' || ch === "'" || ch === '(') {
        this.urlPhase = 'title'; this.urlTitleQuote = ch; this.urlTitle = ''; return null;
      }
      this.urlFailed = true; return null; // anything else here isn't valid title syntax
    }

    if (this.urlPhase === 'title') {
      const closeCh = this.urlTitleQuote === '(' ? ')' : this.urlTitleQuote;
      if (this.urlTitleQuote === '(' && ch === '(') this.urlFailed = true; // unescaped "(" inside a (...)-title
      if (ch === closeCh) { this.urlPhase = 'trail'; return null; }
      this.urlTitle += ch; return null;
    }

    // 'trail': only whitespace may follow the title before the closing ")".
    if (ch === ')') return this._finishUrl();
    if (/\s/.test(ch)) return null;
    this.urlFailed = true; return null;
  }

  _finishUrl() {
    if (this.urlFailed) return { failed: true };
    return {
      url: this._encodeUrl(this._decodeEntities(this.urlDest)),
      title: this.urlTitle !== null ? this._decodeEntities(this.urlTitle) : null,
    };
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

  // ── Emphasis resolution, DOM-native (no out-of-DOM buffer) ─────────────────
  // A "*"/"_" delimiter run that can close first tries to match immediately
  // against the nearest still-open compatible run — found by walking real
  // DOM siblings backward, not a parallel data structure — so the ordinary,
  // well-formed case (e.g. typing "*foo*") resolves and renders live, same
  // as before. A run (or its leftover length after a partial match) that
  // can't be matched right now becomes a placeholder Comment node — metadata
  // stored directly on it (._emBase/._emLen/._emCanOpen/._emCanClose), the
  // same pattern already used for real elements via _mdMarker — invisible
  // until it's either matched by a LATER closer (still live, no deferral)
  // or the block containing it is finalized, at which point any leftover
  // placeholders are swept to literal text by _flushEmphasis().
  _pushDelim(marker, baseChar, canOpen, canClose) {
    let len = marker.length;
    if (canClose) {
      while (len > 0) {
        const opener = this._findOpenerSibling(baseChar, len, canOpen);
        if (!opener) break;
        const use = Math.min(2, opener._emLen, len);
        let tag = use === 2 ? 'strong' : 'em';
        if (use === 2 && baseChar === '_' && !this.commonMarkStrict) tag = 'u'; // see markerToTag()
        this._wrapDelimRange(opener, tag);
        opener._emLen -= use; len -= use;
        if (opener._emLen <= 0) opener.remove();
      }
    }
    if (len > 0) {
      if (canOpen) {
        const node = document.createComment('em');
        node._emBase = baseChar; node._emLen = len; node._emCanOpen = canOpen; node._emCanClose = canClose;
        this.dom.current.appendChild(node);
      } else {
        this.writeText(baseChar.repeat(len));
      }
    }
    this.textNode = null;
  }

  // Walks DIRECT children of dom.current backward (real siblings, not a
  // buffer) for the nearest still-open run that could pair with a closer of
  // `closerLen`/`closerCanOpen` — applying the "multiple of 3" rule (6.2
  // rules 9/10): if either side can both open and close, and the two
  // lengths sum to a multiple of 3, the pairing is only valid if BOTH
  // lengths individually are also multiples of 3.
  _findOpenerSibling(baseChar, closerLen, closerCanOpen) {
    for (let n = this.dom.current.lastChild; n; n = n.previousSibling) {
      if (n.nodeType !== 8 || n._emBase !== baseChar || !n._emCanOpen || n._emLen <= 0) continue;
      if (n._emCanClose || closerCanOpen) {
        const sum = n._emLen + closerLen;
        if (sum % 3 === 0 && (n._emLen % 3 !== 0 || closerLen % 3 !== 0)) continue;
      }
      return n;
    }
    return null;
  }

  // Wraps everything between `openerNode` and the current end of its parent
  // (i.e. everything typed since the opener) in a new <em>/<strong> element.
  _wrapDelimRange(openerNode, tag) {
    const el = document.createElement(tag);
    openerNode.parentNode.insertBefore(el, openerNode.nextSibling);
    let n = el.nextSibling;
    while (n) { const next = n.nextSibling; el.appendChild(n); n = next; }
    this.textNode = null;
  }

  // Same idea as _flushEmphasis, for code spans: an opening backtick run
  // commits immediately to a real <code> element (so the common,
  // well-formed, streaming case renders live) with everything after it
  // fed in as literal content — but per CommonMark that opener only really
  // counts once a matching-length closing run is found. If the block ends
  // (see closeBlock() and the same other call points as _flushEmphasis)
  // with the span still open, it was never really a code span: unwrap it
  // back to its literal opening backticks + raw content, and replay THAT
  // through the normal inline pipeline so anything inside it that should
  // have been ordinary markup (emphasis, links, entities, ...) is now
  // actually processed as such — must run BEFORE _flushEmphasis, since the
  // replay can itself introduce new emphasis placeholders to sweep.
  _flushCodeSpans(root) {
    if (!root || root.nodeType !== 1) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let openCode = null, n;
    while ((n = walker.nextNode())) { if (n.nodeName === 'CODE' && n._mdMarker) { openCode = n; break; } }
    if (!openCode) return;
    const marker = openCode._mdMarker;
    const raw = openCode.textContent;
    const parent = openCode.parentNode;
    openCode.remove();
    this.dom.current = parent;
    this.textNode = null;
    // The opening backticks themselves are written directly as literal
    // text (NOT replayed through onInlineChar) — replaying them would hit
    // the same "any backtick run optimistically opens a code span" logic
    // that created this exact situation, recreating another open (and
    // still ultimately unmatched) code element instead of actually
    // reverting to text. Only the CONTENT after them is replayed through
    // the normal pipeline, since it may contain real markdown (emphasis,
    // links, entities, or even a genuinely valid nested backtick pair)
    // that was wrongly suppressed while this was mistaken for a code span.
    this.appendToTextNode(marker);
    for (const c of raw) { this.onInlineChar(c); this.lastChar = c; }
    this.flushInlinePending();
    // A counted run of closing backticks confirmed only by a character
    // that never came (raw ended exactly on it) needs the same resolution
    // finalize()/onNewline() give it elsewhere — same logic, replicated
    // here since the replay is a self-contained inline-parsing pass.
    if (this.codeCloseRun && this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      if (this.codeCloseRun === this.dom.current._mdMarker.length) this._closeCodeSpan();
      else this.appendToTextNode('`'.repeat(this.codeCloseRun));
      this.codeCloseRun = 0;
    }
    // The replay can itself open (and leave open) a new code span — e.g.
    // raw content containing its own single stray backtick — so resolve
    // that too before returning.
    this._flushCodeSpans(root);
  }

  // Called when a block's inline content is done (see closeBlock() and the
  // various paragraph/list-item/definition close points): any delimiter
  // placeholder left anywhere in `root`'s subtree — including nested inside
  // an <em>/<strong> from an earlier partial match — never found a valid
  // partner and is swept to literal text (or removed, if fully consumed).
  _flushEmphasis(root) {
    if (!root || root.nodeType !== 1) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const leftover = [];
    let n;
    while ((n = walker.nextNode())) { if (n._emBase) leftover.push(n); }
    for (const node of leftover) {
      if (node._emLen > 0) node.replaceWith(document.createTextNode(node._emBase.repeat(node._emLen)));
      else node.remove();
    }
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
        this._pushDelim(marker, baseChar, canOpen, canClose);
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
    if (marker === '__') return this.commonMarkStrict ? 'strong' : 'u';
    return {'**':'strong','*':'em','_':'em','~~':'s','^':'sup','~':'sub','==':'mark'}[marker] || null;
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
    const baseChar = marker[0];
    if (baseChar === '*' || baseChar === '_') {
      // An abrupt boundary (end of a link label, etc.) — nothing follows
      // within this scope, so "after" is boundary-like for flanking.
      const { canOpen, canClose } = this._canOpenClose(baseChar, this.pendingDelimBefore, undefined);
      this._pushDelim(marker, baseChar, canOpen, canClose);
      return;
    }
    const closeEl = this.findInlineClose(marker);
    if (closeEl !== null) { this._pop(closeEl); this.textNode = null; }
    else if (baseChar === '`') {
      // Unlike the other non-emphasis markers, a backtick run CAN validly
      // open right here even at this "abrupt boundary" (this function is
      // only ever called at a genuine end-of-scope: end of line, end of a
      // link label, ...) — CommonMark code spans may span multiple lines,
      // so a "``" sitting at end-of-line (most commonly: right at the very
      // START of a line, where it doesn't reach inline handling at all
      // until the block-level fence-vs-span ambiguity — 3+ backticks needed
      // for a fence — is resolved) must still be able to open one here,
      // same as resolveInlinePending() already does mid-line. Stays open
      // until a matching closer is found later, or _flushCodeSpans()
      // reverts it to literal text if the block ends first.
      const el = this.dom.push('code'); el._mdMarker = marker; this.textNode = null;
    }
    else this.writeText(marker);
  }

  // ── Small shared helpers ───────────────────────────────────────────────────
  // If closing whatever was open left dom.current outside any list item,
  // the list (if any) has genuinely ended — clear listStack so it doesn't
  // go stale (a later, unrelated list marker would otherwise try to reuse
  // it). Left alone when the hr is nested INSIDE a still-open list item.
  makeHr()              { this.closeBlock(); if (this.dom.currentTag() !== 'LI') this.listStack = []; this.dom.current.appendChild(document.createElement('hr')); this.lastBlockEl = null; }
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
  flushDefPending() {
    if (!this.defPending) return;
    const d = this.defPending;
    if (d.type === 'ref' && !d.failed && !(d.key in this.refDefs)) {
      this.refDefs[d.key] = {
        url: this._encodeUrl(this._decodeEntities(d.dest)),
        title: d.title !== null ? this._decodeEntities(d.title) : null,
      };
    }
    if (d.type === 'abbr') this.abbrMap[d.key] = d.value.trim();
    this.defPending = null;
  }

  // Feeds one character of a reference definition's destination + title
  // ("[label]: dest \"title\""), following the same phase state machine
  // (dest -> gap -> title -> trail) as _feedUrlChar() for inline link
  // destinations — the block-level form has no wrapping parens and can
  // span multiple lines (see onNewline()'s defPending handling, which
  // decides per line ending whether to keep going or finalize), but the
  // destination/title grammar itself (bare vs <...>, escape rules, the
  // three title delimiter forms) is identical.
  // Finalizes the just-completed reference definition (destination found,
  // no title present — a title is always optional) and re-enters ordinary
  // block dispatch for `ch`, which belongs to whatever comes AFTER the
  // definition, not to it. `this.pending` is reset first: it kept growing
  // in parallel the whole time defPending was active (decideBlock() always
  // appends to it before its own switch runs, regardless of what that
  // switch does), so it holds stale accumulated characters, not just `ch`.
  _reprocessAfterDef(ch) {
    this.flushDefPending();
    this.pending = '';
    this.decideBlock(ch);
  }

  _feedDefChar(ch) {
    const d = this.defPending;
    if (d.escapeNext) {
      d.escapeNext = false;
      const lit = this._isPunct(ch) ? ch : '\\' + ch;
      if (d.phase === 'dest') d.dest += lit; else if (d.phase === 'title') d.title += lit;
      return;
    }
    if (ch === '\\' && (d.phase === 'dest' || d.phase === 'title')) { d.escapeNext = true; return; }

    if (d.phase === 'dest') {
      if (d.angle === undefined) {
        // Whitespace before the destination even starts (required between
        // "[label]:" and it, and may include a line ending — unlike the
        // inline "(url)" form, which has no such leading gap) — just skip
        // it, staying in 'dest' with nothing decided yet.
        if (/\s/.test(ch)) return;
        d.angle = ch === '<';
        if (d.angle) return;
      }
      if (d.angle) {
        if (ch === '>') { d.phase = 'gap'; return; }
        if (ch === '<') d.failed = true;
        d.dest += ch; return;
      }
      if (ch === '(') { d.parenDepth++; d.dest += ch; return; }
      if (ch === ')') {
        if (d.parenDepth > 0) { d.parenDepth--; d.dest += ch; return; }
        d.failed = true; d.dest += ch; return;
      }
      if (/\s/.test(ch)) { d.phase = 'gap'; return; }
      d.dest += ch; return;
    }
    if (d.phase === 'gap') {
      if (/\s/.test(ch)) return;
      if (ch === '"' || ch === "'" || ch === '(') { d.phase = 'title'; d.titleQuote = ch; d.title = ''; return; }
      // A title is OPTIONAL — content here that isn't whitespace or a
      // title-opening delimiter doesn't invalidate the definition (which
      // is already complete: label + destination, no title), it just
      // means the definition ENDS right here, and this character belongs
      // to whatever comes next instead (e.g. the "bar" that starts a
      // setext heading in "[foo]: /url\nbar\n===\n"). Signal the caller to
      // finalize now and reprocess `ch` through the normal pipeline.
      return 'reprocess';
    }
    if (d.phase === 'title') {
      const closeCh = d.titleQuote === '(' ? ')' : d.titleQuote;
      if (d.titleQuote === '(' && ch === '(') d.failed = true;
      if (ch === closeCh) { d.phase = 'trail'; return; }
      d.title += ch; return;
    }
    // 'trail': only whitespace may follow the title.
    if (!/\s/.test(ch)) d.failed = true;
  }
  startHrWatch(c,n,f)   { this.hrWatch = true; this.hrChar = c; this.hrCount = n; this.hrFailed = f; this._bd(); }
  startSetextWatch(c,b,f){ this.setextWatch = true; this.setextChar = c; this.setextBuf = b; this.setextFailed = f; this._bd(); }
  openUlDecided(s, marker) {
    const base = this.linePos - s.length; // column right after marker + its 1 required space
    // `s` can be a MIX of already-buffered extra spaces followed by the
    // first real content character (decideBlock() often only commits once
    // it sees that first non-space char, e.g. "-  foo" decides right at
    // "f", with s = "  f") — only the leading space RUN is indentation to
    // absorb; the rest is real content, and must not be replayed as
    // literal leading whitespace in front of it.
    const leadWsMatch = s.match(/^ */)[0];
    const isAllSpaces = leadWsMatch.length === s.length;
    const contentCol = base + leadWsMatch.length;
    this.openListItem('ul', this.lineIndent, marker, undefined, contentCol);
    this._bd();
    if (!isAllSpaces) {
      // Replay the item's own first content through decideBlock() itself
      // (not straight to inline text) — same reasoning, and same pattern,
      // as case '>' already uses for blockquote content: this line's
      // content right after the marker might itself start a NESTED block
      // (another list marker, an ATX heading, a fence, a blockquote, ...),
      // e.g. "- - foo" or "- # Foo", not just be this item's inline text.
      const rest = s.slice(leadWsMatch.length);
      this.pending = ''; this.blockDecided = false;
      // A nested marker recognized here needs its OWN indent measured
      // from where `rest` actually starts (contentCol) — not the stale
      // outer line's this.lineIndent (leading whitespace BEFORE the
      // parent marker, e.g. 0 for "- - foo") — or openListItem() sees it
      // as a sibling of the OUTER item instead of nested one level deeper.
      this.lineIndent = contentCol;
      // This item's very first character has nothing to join a soft break
      // to yet — needsJoinSpace may still be sitting true from whatever
      // ended the PREVIOUS item/block, and _blockDefault() would otherwise
      // apply it as a spurious leading space in front of this new item's
      // content.
      this.needsJoinSpace = false;
      // Whatever decideBlock() opens here (a fence, blockquote, ...) must
      // stay nested inside THIS <li>, not get popped out by closeBlock()'s
      // _popToBlockContainer() — same _inListContinuation guard used for a
      // list item's SECOND block (_resolveListBlankContinuation()).
      this._inListContinuation = true;
      for (const c of rest) {
        if (this.blockDecided) {
          if (c === ' ') this.trailingSpaces++; else this.trailingSpaces = 0;
          this.onContentChar(c);
        } else {
          this.decideBlock(c);
        }
        this.lastChar = c;
      }
      return;
    }
    const top = this.listStack[this.listStack.length - 1];
    if (s.length <= 3) {
      if (s.length > 0) this.liAbsorb = { top, base, extra: s.length };
    } else {
      // 5+ spaces already seen before the decision fired: content column
      // snaps back to right after the 1 required separator space, and every
      // space from the 2nd on is literal content, not indentation.
      top.contentCol = base;
      for (let i = 0; i < s.length; i++) this.onContentChar(' ');
    }
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
      // CommonMark: a backtick fence's info string may not itself contain a
      // backtick (a tilde fence has no such restriction) — one appearing
      // there means the opening line was never a valid fence at all, so it
      // falls back to being an ordinary paragraph line instead.
      if (this.fenceChar === '`' && (this.fencePrefix || '').includes('`')) {
        const literal = this.fenceChar.repeat(this.fenceCount) + (this.fencePrefix || '');
        this.inCodeFence = false; this.fencePrefix = null; this.closingFenceBuf = null;
        this.closeBlock(); this.openParagraph(); this.blockDecided = true;
        for (const c of literal) { this.onInlineChar(c); this.lastChar = c; }
        // A trailing backtick run right at the end of that replay (e.g.
        // "```foo``" — the final "``" never got a chance to be confirmed
        // as a real code-span closer or ruled out, the same situation
        // finalize() otherwise resolves at true end-of-input) needs the
        // same resolution here, or those characters are silently lost —
        // sitting in the counter, never actually written anywhere.
        if (this.codeCloseRun && this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
          if (this.codeCloseRun === this.dom.current._mdMarker.length) this._closeCodeSpan();
          else this.appendToTextNode('`'.repeat(this.codeCloseRun));
          this.codeCloseRun = 0;
        }
        this.resetLine(); return;
      }
      // The info string is subject to backslash-escape processing, same as
      // regular inline text (e.g. "```foo\+bar" -> language "foo+bar").
      const lang = this._decodeEntities((this.fencePrefix || '').trim().split(/\s+/)[0]
        .replace(/\\([!-/:-@[-`{-~])/g, '$1'));
      this.fencePrefix = null;
      const pre = this.dom.push('pre');
      const code = document.createElement('code');
      if (lang) code.className = 'language-' + lang;
      pre.appendChild(code);
      this.textNode = document.createTextNode(''); code.appendChild(this.textNode);
      this.closingFenceBuf = ''; this.fenceLineHasContent = false;
      this.fenceLineIndent = 0; this.fenceLineIndentDone = false; return;
    }
    // A run of (only) the fence char spanning the WHOLE line, at least as
    // long as the opening fence, closes it — a longer closer is allowed,
    // not just an exact-length match. Per CommonMark the closing fence
    // itself may be indented up to 3 spaces (fenceLineIndent, tracked by
    // feedCodeFenceLine), independent of the opening fence's own indent.
    if (!this.fenceLineHasContent && this.closingFenceBuf.length >= (this.fenceCount || 3)
        && (this.fenceLineIndent || 0) <= 3) {
      this.inCodeFence = false; this.closingFenceBuf = null; this.textNode = null;
      const pre = this.dom.find('PRE'); if (pre) this._pop(pre);
      this.lastBlockEl = null; this.resetLine(); return;
    }
    // Wasn't a valid closer after all — the withheld run (and any leading
    // indentation beyond the opening fence's own width) is literal content.
    const strip = Math.min(this.fenceLineIndent || 0, this.fenceOpenIndent || 0);
    if (this.textNode && (this.fenceLineIndent || 0) > strip) this.textNode.data += ' '.repeat(this.fenceLineIndent - strip);
    if (this.closingFenceBuf && this.textNode) this.textNode.data += this.closingFenceBuf;
    if (this.textNode) this.textNode.data += '\n';
    this.closingFenceBuf = ''; this.fenceLineHasContent = false;
    this.fenceLineIndent = 0; this.fenceLineIndentDone = false;
  }

  feedCodeFenceLine(ch) {
    // Leading-indentation phase: absorb spaces without writing them yet —
    // needed both to recognize a closing fence indented up to 3 spaces, and
    // to know how much of a content line's indentation to strip (exactly
    // the opening fence's own indent width, CommonMark 4.5).
    if (!this.fenceLineHasContent && this.closingFenceBuf === '' && !this.fenceLineIndentDone && ch === ' ') {
      this.fenceLineIndent = (this.fenceLineIndent || 0) + 1;
      return;
    }
    this.fenceLineIndentDone = true;
    // Only the *start* of a line (after any leading indent) can open a
    // potential closing-fence run — once any other content has been
    // written this line, later fence-char runs (e.g. the "```" in
    // "aaa```") can't retroactively become one.
    if (!this.fenceLineHasContent && ch === this.fenceChar) {
      this.closingFenceBuf += ch; return;
    }
    if (!this.fenceLineHasContent) {
      const strip = Math.min(this.fenceLineIndent || 0, this.fenceOpenIndent || 0);
      if (this.textNode && (this.fenceLineIndent || 0) > strip) this.textNode.data += ' '.repeat(this.fenceLineIndent - strip);
    }
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
  // Block math ("$$" alone on its own line — not CommonMark, a common
  // AI-output extension): content between the two "$$" delimiter lines is
  // fully literal (no markdown processing at all — LaTeX's own "\"/"_"/"*"
  // would otherwise be misread), rendered into a <div class="math
  // math-block"> whose text content keeps BOTH delimiter lines verbatim
  // (rather than stripping them) — matching the convention most client-
  // side math renderers (KaTeX, MathJax auto-render) expect when they
  // scan the page for "$$...$$" to typeset.
  _startMathBlock() {
    this.closeBlock();
    const div = this.dom.push('div');
    div.className = 'math math-block';
    this.mathBlockTextNode = document.createTextNode(this.pending + '\n'); // "$$\n" — the newline that ends this very opening line
    div.appendChild(this.mathBlockTextNode);
    this.textNode = null;
    this.inMathBlock = true;
    this.mathBlockLineBuf = '';
    this.lastBlockEl = div;
    this._bd();
  }

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
  // Indented code blocks: blank lines are preserved in the MIDDLE of the
  // block but stripped from its very start and end (CommonMark 4.4). Blank
  // lines were written as literal newlines as they streamed in (can't know
  // in advance whether more content follows), so trim them back out now
  // that the block is known to be complete — called both from closeBlock()
  // (a new block opens after this one) and finalize() (EOF right after it).
  _trimIndentCode() {
    if (this.inIndentCode && this.textNode) {
      this.textNode.data = this.textNode.data.replace(/^\n+/, '').replace(/\n+$/, '\n');
    }
  }

  closeBlock() {
    this._trimIndentCode();
    this.flushInlinePending();
    if (this.bareUrlOpen) this.closeBareUrl();
    // Must run BEFORE _popMarkers(), which would otherwise forcibly close
    // (and hide) a still-open code span before this gets a chance to
    // inspect and possibly unwrap it.
    this._flushCodeSpans(this.lastBlockEl);
    this._popMarkers();
    this.textNode = null;
    this._flushEmphasis(this.lastBlockEl);
    if (this.dom.depth() > 1) this._popToBlockContainer();
    // A block that just opened somewhere NOT inside the innermost
    // still-tracked list (most commonly: an HTML block, fence, or heading
    // that popped all the way out past it) leaves listStack stale —
    // pointing at a <ul>/<ol> no longer on dom.current's ancestor chain —
    // which corrupts a LATER, unrelated list's nesting decisions (the
    // same hazard fallbackToParagraph() already guards against, but only
    // for the specific paths that call it; this covers every other one).
    // Trimmed level by level, innermost first, so exiting one nested list
    // level while still validly inside an OUTER one only drops that one
    // entry, not the whole stack.
    while (this.listStack.length > 0) {
      const entry = this.listStack[this.listStack.length - 1];
      let el = this.dom.current, stillInside = false;
      while (el) {
        if (el === entry.el) { stillInside = true; break; }
        if (el === this.dom.bottomStack) break;
        el = el.parentNode;
      }
      if (stillInside) break;
      this.listStack.pop();
    }
    if (this.inTable) { this.inTable = false; this.tableHeadDone = false; this.inCell = false; this.tableColAlign = []; this.tableColIndex = 0; }
    this.inFootnoteDef = false;
    this.inIndentCode = false; this.pendingIndentNL = 0; this.indentCodeListCol = null;
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
      // Same idea for a list item's second (loose-list) block that isn't
      // a plain paragraph — a fenced code block, table, or similar,
      // recognized via _resolveListBlankContinuation()'s decideBlock()
      // replay. Only honored while actively processing that replay (this
      // flag is reset every line), not generally — an UNINDENTED
      // construct genuinely ending the list must still pop out normally.
      if (this._inListContinuation && this.dom.currentTag() === 'LI') return;
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
    // Preserve a legitimate list-item nesting (this new blockquote belongs
    // INSIDE it, e.g. as a block following indented code within the same
    // <li>) — toRoot() unconditionally here would blow that away along
    // with any genuinely stray nesting it's meant to clear.
    if (depth === 0 && this.dom.depth() > 1 && this.dom.currentTag() !== 'LI') this.dom.toRoot();
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
  // Ascends dom.current back up to the nearest enclosing <li>/<ul>/<ol> (or
  // the document root, if none), stopping there rather than popping past it
  // — used before treating a new marker as ending the current item, since
  // dom.current can be sitting several levels deeper inside it (a
  // continuation paragraph, a nested blockquote, ...) at that point.
  // A setext underline can lazily continue an open paragraph — but NOT
  // across a blockquote boundary: if that paragraph is inside a
  // blockquote, the underline itself must ALSO be prefixed with ">" (i.e.
  // we're currently replaying a ">"-led line's content, _inBlockquoteContent)
  // for it to apply. An unprefixed line ends the quote instead (handled
  // elsewhere) and gets evaluated fresh — most commonly as a thematic
  // break, not a heading for the now-closed quoted paragraph.
  _setextAllowed() {
    return !this.dom.find('BLOCKQUOTE') || this._inBlockquoteContent;
  }

  _ascendToLI() {
    while (!['LI', 'UL', 'OL'].includes(this.dom.currentTag()) && this.dom.current !== this.dom.bottomStack) {
      this.dom.pop();
    }
  }

  openListItem(type, indent, marker, startNum, contentCol) {
    this._popMarkers();
    this.textNode = null;
    if (this.listStack.length === 0) {
      const tag = this.dom.currentTag();
      if (!['UL','OL','LI'].includes(tag)) this.closeBlock();
      this.pushNewList(type, indent, marker, startNum, contentCol);
    } else {
      const top = this.listStack[this.listStack.length - 1];
      // Nesting depends on the CONTENT column of the enclosing item, not
      // just its marker's own indent — CommonMark: a new marker starts a
      // deeper sub-list only once it reaches far enough in to be part of
      // the current item's own content region. Using the marker indent
      // alone (as a looser earlier version of this code did) nested a new
      // level for every extra space of indentation between otherwise
      // plainly-sibling items (e.g. "- a\n - b\n  - c\n" — one flat list).
      if (indent >= top.contentCol) {
        // Nesting a new sub-list directly under the enclosing item's own
        // text (no blank line separating them): the CommonMark source line
        // ending right before the nested marker's line is a real newline
        // character between the item's inline content and the nested list,
        // which the spec's reference HTML preserves as a literal text node.
        // Match that so whitespace-sensitive comparisons don't see a false
        // difference between "a<ul>" and "a\n<ul>".
        const cur = this.dom.currentTag() === 'LI' ? this.dom.current : null;
        const last = cur && cur.lastChild;
        if (last && last.nodeType === 3 && last.data && !/\s$/.test(last.data)) {
          last.data += '\n';
        }
        this.pushNewList(type, indent, marker, startNum, contentCol);
      } else {
        // Staying at (not nesting deeper than, and not dedenting out of)
        // the current list level only requires reaching ITS marker's own
        // indent, not its content column — contentCol is exclusively the
        // "go one level deeper" threshold above. Popping levels here still
        // compares against each level's marker indent for the same reason
        // (using contentCol here, as a previous version of this fix did,
        // wrongly popped an inner list back out to its parent for a
        // same-level sibling whose indent fell short of the inner list's
        // own contentCol, e.g. "- a\n  - b\n  - c\n").
        if (indent < top.indent) {
          while (this.listStack.length > 1 && this.listStack[this.listStack.length - 1].indent > indent) {
            this.listStack.pop();
            this._ascendToLI(); if (this.dom.currentTag() === 'LI') { this._flushEmphasis(this.dom.current); this.dom.pop(); }
            if (['UL','OL'].includes(this.dom.currentTag())) this.dom.pop();
          }
        }
        // dom.current may be several levels deep inside the target <li>
        // right now — e.g. a blank-line-continuation <p>, or a nested
        // blockquote/code block — rather than the <li> itself, if this new
        // marker is a sibling of an item whose content didn't end with a
        // fresh line at the <li> level. Ascend back up to it first, or the
        // new sibling <li> would end up nested INSIDE whatever was still
        // open (invalid HTML: e.g. a <li> as a child of a <p>).
        this._ascendToLI();
        if (this.dom.currentTag() === 'LI') { this._flushEmphasis(this.dom.current); this.dom.pop(); }
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
  // `fromBlank`: true when a genuine blank line separated the marker/prior
  // content from this line (the pendingListBlank path — makes the list
  // loose, and this becomes a SECOND paragraph); false when this is the
  // very next line right after a list marker with no content of its own
  // (e.g. "-\n" — the pendingEmptyItem path) — that item stays tight, and
  // this is simply its (first and only) content, not a second block.
  _resolveListBlankContinuation(ch, fromBlank) {
    const top = this.listStack[this.listStack.length - 1];
    if (top && this.lineIndent >= top.contentCol) {
      this.lineIndent = 0; this.leadingWsChars = 0;
      if (fromBlank) {
        // A second paragraph within the same item: this blank line
        // genuinely separates two blocks that are both part of the list,
        // so it's loose.
        this._markListLoose(top);
        // BUT this next block isn't necessarily a paragraph — a fenced
        // code block, table, blockquote, or nested list marker here needs
        // to be recognized by decideBlock() as its OWN block (e.g. a
        // numbered step containing a code sample), not forced straight
        // into a synthesized <p> the way ordinary text needs (for correct
        // separation between two loose-list paragraphs in the same item).
        // A quick look at what `ch` could plausibly start gives
        // decideBlock() first refusal; only the ordinary "this is just
        // more text" case gets the placeholder <p> up front. A character
        // that LOOKS like one of these but turns out not to form a valid
        // one still falls back correctly through decideBlock()'s own
        // internal fallback (_blockDefault()) — just without the
        // placeholder paragraph, a narrower, rarer trade-off than leaving
        // fences/tables/nested lists broken inside list items entirely.
        if (!/^[`~|>0-9*+-]$/.test(ch)) this.openParagraph();
        else if (ch === '`' || ch === '~') {
          // A fence opened here needs fenceOpenIndent set to the item's
          // real content column (not the 0 this.lineIndent was just
          // reset to above) — later content lines' own indentation is
          // still measured in absolute columns from line start via the
          // ordinary top-level whitespace counter, so stripping the
          // fence's relative indent from them only works if the fence's
          // OWN recorded opening column matches that same absolute scale.
          this.lineIndent = top.contentCol;
        }
      } else {
        // This is the item's very FIRST content (an empty-marker line has
        // no prior content to join to) — onNewline()'s generic end-of-line
        // bookkeeping set needsJoinSpace=true merely because dom.current
        // was sitting at the (as yet empty) <li>; not a real soft break.
        this.needsJoinSpace = false;
      }
      // Whatever decideBlock() opens for `ch` (a fence, table, blockquote,
      // ...) must stay nested inside THIS <li> — closeBlock() (called by
      // most block-opening paths) otherwise pops all the way out via
      // _popToBlockContainer(), same class of fix already applied for
      // blockquote content and ATX headings inside a list item earlier
      // this session. Reset every line (resetLine()), so this only
      // affects this one replay, not the whole rest of the document.
      this._inListContinuation = true;
      this.decideBlock(ch);
      return;
    }
    if (this.dom.currentTag() === 'LI') { this._flushEmphasis(this.dom.current); this.dom.pop(); }
    this.lastBlockEl = null;
    // Not (yet) known whether this dedents fully out of the list or is a new
    // sibling item — openListItem() marks looseness itself if it turns out
    // to be the latter, reusing the same list. Only a genuine blank line
    // can make that new item loose — an empty-marker item followed
    // immediately (no blank line) by a dedented new marker does not.
    this._blankBeforeNewItem = fromBlank;
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
    if (tag === 'P' || tag === 'LI' || tag === 'DD') {
      if (this.hadJoinSpace) { this.hadJoinSpace = false; this.appendToTextNode(' '); this.lastChar = ' '; }
      this.writeText(text); return;
    }
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
    // If the input doesn't end with a trailing newline, a line whose block
    // type can only be decided at end-of-line (e.g. a thematic break, or
    // the type-7 HTML-block check above) never gets that decision made —
    // onNewline() itself is only ever triggered by an actual "\n" char.
    // Synthesize that final line ending here, same as onNewline() would
    // handle it, before any of finalize()'s own (inline-level) cleanup —
    // none of which applies yet if the block type isn't even decided.
    if (!this.blockDecided && this.pending) this.onNewline();

    // Same as onNewline()'s handling: a counted closing-backtick run is only
    // confirmed once a following character rules out a longer run — one
    // right at the very end of the input (no trailing newline either) never
    // gets that character otherwise.
    if (this.codeCloseRun && this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      if (this.codeCloseRun === this.dom.current._mdMarker.length) this._closeCodeSpan();
      else this.appendToTextNode('`'.repeat(this.codeCloseRun));
      this.codeCloseRun = 0;
    }
    // onNewline() speculatively adds a space to an open code span for every
    // line ending, in case content continues on a following line — but the
    // very last line ending in the document has no such continuation, so
    // if the span is STILL open right here at EOF, that final space was
    // never really part of anything and must not survive into the literal
    // text _flushCodeSpans() is about to revert this span to.
    if (this.dom.current._mdMarker && this.dom.current._mdMarker[0] === '`') {
      const t = this.dom.current.firstChild;
      if (t && t.nodeType === 3 && t.data.endsWith(' ')) t.data = t.data.slice(0, -1);
    }
    if (this.autolinkBuf !== null) {
      this.appendToTextNode('<' + this.autolinkBuf);
      this.autolinkBuf = null; this.autolinkQuote = null;
    }
    if (this.mathInlineBuf !== null) {
      this.appendToTextNode('$' + this.mathInlineBuf);
      this.mathInlineBuf = null;
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

    this._trimIndentCode();
    this.flushDefPending();
    this.flushInlinePending();
    if (this.bareUrlOpen) this.closeBareUrl();
    this.textNode = null;
    // Catch-all: the very last block never gets explicitly closed by a
    // NEW block opening after it, so any still-open code span or delimiter
    // placeholder anywhere in the whole document is resolved/swept here
    // (code spans first — the unwrap can itself introduce new delimiter
    // placeholders for _flushEmphasis to then sweep).
    this._flushCodeSpans(this.root);
    this._flushEmphasis(this.root);

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
        // Wrapping into <p> supersedes the tight-item trailing newline
        // openListItem() injects before a directly-nested sub-list (see
        // there) — once this content is its own paragraph, no such
        // newline belongs at its end.
        const lastLeaf = p.lastChild;
        if (lastLeaf && lastLeaf.nodeType === 3) lastLeaf.data = lastLeaf.data.replace(/\n$/, '');
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
