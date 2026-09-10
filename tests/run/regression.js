'use strict';
// Regression suite for md4.js — locks in bugs found and fixed during the
// 2026-09-09 session (see git log). Every case here reproduced a real,
// observed rendering bug; run `npm test` after any change to decideBlock()
// or the inline state machine to catch reintroductions.
const assert = require('assert');
const { render, renderAsync } = require('./render');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function countTag(html, tag) {
  const m = html.match(new RegExp(`<${tag}[ >]`, 'g'));
  return m ? m.length : 0;
}

// ── Soft line breaks: no dropped characters, joined with a space ──────────
test('two-line paragraph keeps all characters and joins with a space', () => {
  const html = render('Hello world\nSecond line here');
  assert.strictEqual(countTag(html, 'p'), 1, 'should be a single <p>');
  assert.match(html, /Hello world Second line here/, 'no dropped chars / missing join space');
});

test('three-line paragraph with mixed emphasis markers stays one paragraph', () => {
  const html = render('Alpha\n*Beta*\n_Gamma_\n`Delta`');
  assert.strictEqual(countTag(html, 'p'), 1, 'ambiguous markers must not split the paragraph');
  assert.match(html, /Alpha <em>Beta<\/em> <em>Gamma<\/em> <code>Delta<\/code>/);
});

// ── Consecutive badge images must merge into one paragraph, inline ────────
test('two badge links on consecutive lines merge into one paragraph', () => {
  const html = render('[![Version](v.png)](v.html)\n[![License](l.png)](l.html)');
  assert.strictEqual(countTag(html, 'p'), 1, 'badges must not split into separate paragraphs');
  assert.strictEqual(countTag(html, 'img'), 2);
  assert.match(html, /<\/a> <a /, 'badges should be space-separated, not glued together');
});

test('seven badge links on consecutive lines merge into one paragraph', () => {
  const lines = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    .map((l) => `[![${l}](${l}.png)](${l}.html)`)
    .join('\n');
  const html = render(lines);
  assert.strictEqual(countTag(html, 'p'), 1);
  assert.strictEqual(countTag(html, 'img'), 7);
});

// ── Blank lines must still separate paragraphs ─────────────────────────────
test('a blank line still separates two paragraphs', () => {
  const html = render('Para one\n\nPara two');
  assert.strictEqual(countTag(html, 'p'), 2);
  assert.match(html, /<p>Para one<\/p>/);
  assert.match(html, /<p>Para two<\/p>/);
  assert.doesNotMatch(html, /<\/p>\s+<p>/, 'no stray whitespace text node between paragraphs');
});

test('reference-link definition after a blank line still resolves', () => {
  const html = render('Some text\n\n[ref]: https://example.com\n\n[link][ref]');
  assert.match(html, /href="https:\/\/example\.com"/);
});

test('footnote definition after a blank line still resolves', () => {
  const html = render('Text with note[^1]\n\n[^1]: Footnote text here');
  assert.match(html, /class="fn-ref"/);
  assert.match(html, /Footnote text here/);
});

// ── Genuine block constructs must still interrupt an open paragraph ───────
test('a real ATX heading interrupts an open paragraph', () => {
  const html = render('Some text\n# Real Heading\nMore text');
  assert.match(html, /<h1>Real Heading<\/h1>/);
  assert.strictEqual(countTag(html, 'p'), 2);
});

test('an invalid heading (7 hashes) is treated as continuation text', () => {
  const html = render('Some text\n####### Not a heading');
  assert.strictEqual(countTag(html, 'p'), 1);
  assert.strictEqual(countTag(html, 'h1'), 0);
});

test('a real thematic break after a blank line interrupts', () => {
  const html = render('Some text\n\n---\n\nMore text');
  assert.strictEqual(countTag(html, 'hr'), 1);
  assert.strictEqual(countTag(html, 'p'), 2);
});

test('a real fenced code block interrupts and preserves content', () => {
  const html = render('Text before\n```js\nconst x = 1;\n```\nText after');
  assert.match(html, /<pre><code class="language-js">const x = 1;\n<\/code><\/pre>/);
  assert.strictEqual(countTag(html, 'p'), 2);
});

test('an unclosed fence marker (2 backticks) is treated as continuation text', () => {
  const html = render('Text\n``not a fence');
  assert.strictEqual(countTag(html, 'p'), 1);
  assert.strictEqual(countTag(html, 'pre'), 0);
});

test('a real blockquote interrupts an open paragraph', () => {
  const html = render('Text\n> Quoted');
  assert.match(html, /<blockquote><p>Quoted<\/p><\/blockquote>/);
});

test('real unordered/ordered/plus lists interrupt an open paragraph', () => {
  assert.match(render('Text\n- one\n- two'), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(render('Text\n1. one\n2. two'), /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(render('Text\n+ item'), /<ul><li>item<\/li><\/ul>/);
});

test('a list item does not leak a trailing join-space before the next item', () => {
  const html = render('- one\n- two\n- three');
  assert.doesNotMatch(html, /<li>one <\/li>|<li>two <\/li>/, 'join-space must not fire when the next line opens a new list item');
});

test('a list marker without a following space is continuation text', () => {
  const html = render('Text\n+nope');
  assert.strictEqual(countTag(html, 'ul'), 0);
  assert.match(html, /\+nope/);
});

// ── Setext headings: only when directly under a paragraph, no blank line ──
test('setext "---" directly under text becomes an h2', () => {
  const html = render('Text\n---\nMore');
  assert.match(html, /<h2>Text\s*<\/h2>/);
});

test('setext "===" directly under text becomes an h1', () => {
  const html = render('Text\n===\nMore');
  assert.match(html, /<h1>Text\s*<\/h1>/);
});

test('"---" after a BLANK line is a thematic break, not a setext heading', () => {
  const html = render('Text\n\n---\nMore');
  assert.strictEqual(countTag(html, 'h2'), 0, 'must not retroactively convert the earlier paragraph to h2');
  assert.strictEqual(countTag(html, 'hr'), 1);
  assert.match(html, /<p>Text<\/p>/);
});

test('"===" after a blank line stays as plain text (no prior paragraph to convert)', () => {
  const html = render('Text\n\n===\nMore');
  assert.strictEqual(countTag(html, 'h1'), 0);
  assert.match(html, /<p>Text<\/p>/);
});

// ── Raw HTML block passthrough ─────────────────────────────────────────────
test('a raw <div> block passes through unescaped', () => {
  const html = render('<div>hello</div>\n');
  assert.strictEqual(html, '<div>hello</div>');
});

test('a raw <p align="..."> block passes through unescaped, not as literal text', () => {
  const html = render('<p align="center">hi</p>\n');
  assert.doesNotMatch(html, /&lt;p/, 'the tag must not be HTML-escaped');
  assert.match(html, /<p align="center">hi<\/p>/);
});

// ── Async streaming must match the sync path and must terminate ───────────
test('async streaming renders the same as sync and terminates', async () => {
  const md = '[![Version](v.png)](v.html)\n[![License](l.png)](l.html)\n\nDone.';
  const syncHtml = render(md);
  const asyncHtml = await Promise.race([
    renderAsync(md),
    new Promise((_, reject) => setTimeout(() => reject(new Error('streaming hung (timeout)')), 5000)),
  ]);
  assert.strictEqual(asyncHtml, syncHtml);
});

// ── Emphasis flanking rules (CommonMark 6.2) ───────────────────────────────
test('emphasis with space right after the opening marker stays literal', () => {
  assert.match(render('a * foo bar*'), /<p>a \* foo bar\*<\/p>/);
});

test('a single "*" surrounded by spaces on both sides stays literal', () => {
  // "* a *" alone is ambiguous with a bullet-list marker, so use a
  // mid-sentence position to isolate the emphasis-flanking behavior.
  const html = render('x * a * y');
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /\* a \*/);
});

test('"_" cannot open/close intraword emphasis (only "*" can)', () => {
  assert.match(render('foo_bar_'), /<p>foo_bar_<\/p>/);
  assert.doesNotMatch(render('foo_bar_'), /<em>/);
});

test('"*" CAN open/close intraword emphasis, unlike "_"', () => {
  assert.match(render('foo*bar*'), /foo<em>bar<\/em>/);
});

test('nested strong-in-em still resolves correctly inside a link label', () => {
  // Regression: feedPendingAsInline()/openUlDecided()/blockquote inline-feed
  // did not update lastChar, so flanking checks for text reached only via
  // those paths (e.g. a link label, since decideBlock's own lookahead buffers
  // the whole label before dispatching) always saw lastChar=undefined.
  const html = render('[link *foo **bar** `#`*](/uri)');
  assert.match(html, /link <em>foo <strong>bar<\/strong> <code>#<\/code><\/em>/);
});

test('emphasis flanking also works for list-item and blockquote inline text', () => {
  assert.match(render('- *foo* bar'), /<em>foo<\/em> bar/);
  assert.match(render('> *foo* bar'), /<em>foo<\/em> bar/);
});

// ── Link/image URL and title parsing ───────────────────────────────────────
test('a reference-link definition splits the title out of the href', () => {
  const html = render('[foo][bar]\n\n[bar]: /url "title"');
  assert.match(html, /<a[^>]*href="\/url"[^>]*title="title"[^>]*>foo<\/a>/);
  assert.doesNotMatch(html, /&quot;title&quot;/);
});

test('the first of two duplicate reference-link definitions wins', () => {
  const html = render('[foo]: /url1\n\n[foo]: /url2\n\n[bar][foo]');
  assert.match(html, /href="\/url1"/);
});

test('balanced parens inside an inline link URL stay part of the URL', () => {
  assert.match(render('[link](foo(and(bar)))'), /href="foo\(and\(bar\)\)"/);
});

test('backslash-escaped parens in an inline link URL are unescaped', () => {
  assert.match(render('[link](foo\\(and\\(bar\\))'), /href="foo\(and\(bar\)"/);
});

test('an angle-bracket link destination strips the brackets and encodes spaces', () => {
  assert.match(render('[link](</my uri>)'), /href="\/my%20uri"/);
  assert.match(render('[link](<>)'), /href=""/);
});

// ── List marker changes and ordered-list start ─────────────────────────────
test('a bullet marker change starts a new list', () => {
  const html = render('- foo\n- bar\n+ baz');
  assert.strictEqual(countTag(html, 'ul'), 2, '"-" then "+" must be two separate <ul>s');
  assert.match(html, /<\/ul><ul>/);
});

test('an ordered-list delimiter change (. vs )) starts a new list', () => {
  const html = render('1. foo\n2. bar\n3) baz');
  assert.strictEqual(countTag(html, 'ol'), 2);
});

test('an ordered list starting above 1 gets a start= attribute', () => {
  assert.match(render('3) baz'), /<ol start="3">/);
});

test('an ordered list starting at 1 has no start= attribute', () => {
  assert.doesNotMatch(render('1. foo\n2. bar'), /start=/);
});

// ── Hard line breaks ────────────────────────────────────────────────────────
test('a hard break (trailing 2+ spaces) inserts <br> with a following space', () => {
  assert.match(render('foo  \nbaz'), /foo<br>\s?baz/);
});

test('leading whitespace on a continuation line no longer starts a code block', () => {
  // Regression: 5+ leading spaces on a line continuing an open paragraph
  // used to trigger indented-code-block detection; per CommonMark, lazy
  // continuation lines never do, regardless of leading whitespace.
  const html = render('foo  \n     bar');
  assert.doesNotMatch(html, /<pre>/);
  assert.match(html, /foo<br>\s?bar/);
});

test('a heading trims a trailing hard-break marker instead of adding <br>', () => {
  assert.match(render('### foo  \nmore'), /<h3>foo<\/h3>/);
  assert.doesNotMatch(render('### foo  \nmore'), /<br>/);
  assert.match(render('### foo\\\nmore'), /<h3>foo\\<\/h3>/);
});

test('a hard break at the very end of the document (nothing follows) is not a <br>', () => {
  assert.doesNotMatch(render('foo  \n'), /<br>/);
  assert.match(render('foo\\\n'), /<p>foo\\<\/p>/);
});

// ── Reference-style images ──────────────────────────────────────────────────
test('an explicit reference-style image resolves against its definition', () => {
  assert.match(render('![foo][bar]\n\n[bar]: /url'), /<img[^>]*src="\/url"[^>]*alt="foo"/);
});

test('a collapsed reference-style image (![alt][]) resolves against its definition', () => {
  const html = render('![foo][]\n\n[foo]: /url "title"');
  assert.match(html, /<img[^>]*src="\/url"/);
  assert.match(html, /title="title"/);
});

test('a shortcut reference-style image (![alt]) resolves against its definition', () => {
  // Regression: this exact form, ending right at end-of-line, never reached
  // onLinkChar's handling (newlines bypass it) and silently lost the image.
  assert.match(render('![Foo]\n\n[foo]: /url "title"'), /<img[^>]*src="\/url"/);
});

test('a reference-style image with no matching definition falls back to literal text', () => {
  assert.match(render('![foo][nope]'), /!\[foo\]\[nope\]/);
  assert.doesNotMatch(render('![foo][nope]'), /<img/);
});

// ── Code span backtick run-length matching (CommonMark 6.1) ────────────────
test('a code span only closes on a backtick run of the same length', () => {
  // "``" opened with 2 backticks; a single "`" inside must stay literal.
  assert.match(render('`` foo ` bar ``'), /<code>foo ` bar<\/code>/);
});

test('a shorter/longer backtick run inside a code span is literal content', () => {
  assert.match(render('``foo`bar``'), /<code>foo`bar<\/code>/);
  assert.match(render('` `` `'), /<code>``<\/code>/);
});

test('single leading/trailing space in a code span is stripped, but not more than one', () => {
  assert.match(render('`  ``  `'), /<code> `` <\/code>/);
});

test('a code span consisting only of spaces is not stripped', () => {
  assert.match(render('` `'), /<code> <\/code>/);
});

test('a closing backtick run at the very end of a line still closes the span', () => {
  // Regression: a closing run is only confirmed once a following char
  // arrives (to rule out a longer run) — one sitting right at end-of-line
  // never got that char and the span silently failed to close.
  assert.match(render('`` foo ` bar ``\nmore'), /<code>foo ` bar<\/code>/);
});

// ── Inline raw HTML (any tag, not a fixed whitelist) ───────────────────────
test('an arbitrary (non-whitelisted) inline tag passes through with attributes', () => {
  const html = render('Foo <responsive-image src="foo.jpg" />');
  assert.match(html, /<responsive-image src="foo\.jpg">/);
});

test('a closing tag pops the matching open ancestor by name', () => {
  const html = render('<kbd>x</kbd>');
  assert.match(html, /<kbd>x<\/kbd>/);
});

test('an entity inside a raw tag attribute value is not intercepted as text', () => {
  // Regression: the entity-decode check ran before the tag-buffer check,
  // so "&" inside an open "<...>" was diverted to entity processing
  // instead of being captured as part of the tag.
  assert.match(render('foo <a href="&ouml;">'), /<a href="ö">/);
});

test('an unresolved "<tag" left open at end of line falls back to literal text, not silent loss', () => {
  // Regression: resetLine() discarded a still-buffering autolinkBuf with
  // no fallback, silently dropping content like "<a href=\"hi'>".
  const html = render("<a href=\"hi'> more text");
  assert.doesNotMatch(html, /^<p>\s*<\/p>$/, 'content must not vanish entirely');
});

// ── Backslash escapes scoped to ASCII punctuation / literal in code ────────
test('backslash only escapes ASCII punctuation; "\\A" stays literal', () => {
  assert.match(render('\\A\\3'), /\\A\\3/);
});

test('backslash escape still works normally on punctuation', () => {
  assert.match(render('\\*not emphasized\\*'), /\*not emphasized\*/);
  assert.doesNotMatch(render('\\*not emphasized\\*'), /<em>/);
});

test('an indented code block is fully literal — no emphasis, links, entities, or escapes parsed', () => {
  const html = render('    *foo* [bar](baz) &amp; \\[\\]');
  assert.match(html, /<pre><code>\*foo\* \[bar\]\(baz\) [\s\S]*\\\[\\\]<\/code><\/pre>/);
  assert.doesNotMatch(html, /<em>|<a /);
});

// ── Tabs (advance to the next multiple-of-4 column for indentation) ────────
test('a leading tab is enough indentation to start an indented code block', () => {
  const html = render('\tfoo\tbaz\t\tbim');
  assert.match(html, /<pre><code>foo\tbaz\t\tbim/, 'tabs inside the content stay literal, unexpanded');
});

test('2 spaces + a tab reach column 4 and start an indented code block', () => {
  assert.match(render('  \tfoo'), /<pre><code>foo/);
});

test('a tab after "#" is a valid ATX heading separator', () => {
  assert.match(render('#\tFoo'), /<h1>Foo<\/h1>/);
});

// ── Setext heading underline: indentation and trailing whitespace ─────────
test('a setext underline with up to 3 leading spaces is still valid', () => {
  assert.match(render('Foo\n   ----\n'), /<h2>Foo<\/h2>/);
});

test('a setext underline with trailing spaces/tabs is still valid', () => {
  assert.match(render('Foo\n----   \n'), /<h2>Foo<\/h2>/);
});

test('a setext underline indented 4+ spaces is NOT valid (stays paragraph text)', () => {
  // Regression: continuation lines silently swallow all leading whitespace
  // (so the paragraph can lazily continue), which meant a 4-space-indented
  // "---" lost its indent before setext-detection ever saw it, and wrongly
  // became a heading instead of staying literal text.
  const html = render('Foo\n    ---\n');
  assert.doesNotMatch(html, /<h2>/);
  assert.match(html, /<p>Foo ---<\/p>/);
});

// ── Fenced code block closing-fence length matching ────────────────────────
test('a fenced code block closes on a LONGER closing fence, not just exact length', () => {
  const html = render('````\naaa\n```\n``````\n');
  assert.match(html, /<pre><code>aaa\n```\n<\/code><\/pre>/, 'the too-short "```" mid-block stays as content');
});

test('a shorter fence-char run than the opener stays as literal content, not lost', () => {
  const html = render('~~~~\naaa\n~~~\n~~~~\n');
  assert.match(html, /<pre><code>aaa\n~~~\n<\/code><\/pre>/);
});

test('content before a fence-char run on the same line is not itself withheld', () => {
  assert.match(render('```\naaa```\n```\n'), /<pre><code>aaa```\n<\/code><\/pre>/);
});

// ── Unresolved end-of-line pending content must not be silently lost ──────
test('a too-short marker run on its own line (not a valid hr/list) is not discarded', () => {
  // Regression: "**" (2 stars) is too short for a thematic break and never
  // gets decided mid-line either; onNewline's pending-fallback chain had no
  // catch-all case, so lines like this vanished entirely.
  const html = render('--\n**\n__\n');
  assert.match(html, /<p>-- \*\* __<\/p>/);
});

test('a join-space is still correctly applied across the newline pending-fallback path', () => {
  // Regression: needsJoinSpace was reset at the top of onNewline() before
  // this same call's own pending-fallback logic (further down) got a
  // chance to read the value the PREVIOUS line's onNewline had set.
  const html = render('--\n**\n');
  assert.match(html, /-- \*\*/);
});

test('a thematic-break-shaped line indented 4+ inside an open paragraph stays continuation text', () => {
  const html = render('Foo\n    ***\n');
  assert.doesNotMatch(html, /<hr>/);
  assert.match(html, /<p>Foo \*\*\*<\/p>/);
});

// ── Entity and numeric character references ────────────────────────────────
test('a long named entity is not truncated by the buffer length cap', () => {
  // Regression: the entity buffer bailed out (flushed as literal) after 12
  // chars, but many valid HTML5 entity names are longer, e.g. "&HilbertSpace;".
  assert.match(render('&HilbertSpace; &ClockwiseContourIntegral;'), /ℋ ∲/);
});

test('an uppercase hex numeric reference ("&#X.." not just "&#x..") is recognized', () => {
  assert.match(render('&#X22;'), /<p>"<\/p>/);
});

test('&#0; becomes the replacement character, not empty', () => {
  assert.match(render('&#0;'), /�/);
});

test('a numeric reference with too many digits is not valid (stays literal)', () => {
  // CommonMark caps decimal refs at 7 digits, hex at 6 — longer isn't an
  // "invalid code point" (-> replacement char), it isn't a reference at all.
  assert.match(render('&#87654321;'), /&amp;#87654321;/);
});

test('an unterminated entity (no trailing ";") falls back to literal text, not silent loss', () => {
  const html = render('&copy');
  assert.doesNotMatch(html, /^<p>\s*<\/p>$/);
  assert.match(html, /&amp;copy/);
});

test('entities in a link URL/title are decoded, and the URL is percent-encoded', () => {
  const html = render('[foo](/f&ouml;&ouml; "f&ouml;&ouml;")');
  assert.match(html, /href="\/f%C3%B6%C3%B6"/);
  assert.match(html, /title="föö"/);
});

// ── Blockquote content goes through real block detection ──────────────────
test('a heading inside a blockquote is recognized as a heading, not literal text', () => {
  assert.match(render('> # Foo\n> bar\n> baz\n'), /<blockquote><h1>Foo<\/h1><p>bar baz<\/p><\/blockquote>/);
});

test('a fence opening inside a blockquote is recognized (single-line content)', () => {
  // Full multi-line fence-in-blockquote support (stripping the ">" prefix
  // from each subsequent fence-content line) is a known remaining gap —
  // once inCodeFence is true, processChar short-circuits straight to raw
  // fence-content handling before blockquote-prefix stripping ever runs.
  assert.match(render('> ```js\n'), /<blockquote><pre><code class="language-js">/);
});

test('consecutive ">" lines merge into one paragraph (lazy continuation)', () => {
  assert.match(render('> foo\n> bar\n'), /<blockquote><p>foo bar<\/p><\/blockquote>/);
});

test('a blockquote paragraph continues even on a line with no ">" prefix (lazy continuation)', () => {
  assert.match(render('> bar\nbaz\n'), /<blockquote><p>bar baz<\/p><\/blockquote>/);
});

test('a plain (unprefixed) blank line still ends the blockquote', () => {
  // Regression: fixing lazy-continuation inside blockquotes by preserving
  // BLOCKQUOTE nesting through closeBlock() initially preserved it even for
  // content that never had a ">" prefix at all, wrongly keeping unrelated
  // top-level content nested inside.
  const html = render('> bar\n\nbaz\n');
  assert.match(html, /<blockquote><p>bar<\/p><\/blockquote><p>baz<\/p>/);
});

test('an unprefixed thematic break after a blockquote ends it, not nests inside it', () => {
  const html = render('> aaa\n***\n> bbb\n');
  assert.match(html, /<blockquote><p>aaa<\/p><\/blockquote><hr><blockquote><p>bbb<\/p><\/blockquote>/);
});

test('an unindented thematic break after a list item ends the list, not nests inside it', () => {
  // Regression: closeBlock()'s container-preserving fix must not also
  // apply to list items (indentation-relative-to-marker decides that,
  // unlike a blockquote's simpler lazy-continuation rule).
  const html = render('- Foo\n---\n');
  assert.match(html, /<ul><li>Foo<\/li><\/ul><hr>/);
});

// ── Loose lists and multi-paragraph list items ─────────────────────────────
test('a blank line between two list items makes the list loose (both wrapped in <p>)', () => {
  const html = render('- a\n\n- b\n');
  assert.match(html, /<ul><li><p>a<\/p><\/li><li><p>b<\/p><\/li><\/ul>/);
});

test('a tight list (no blank lines) is not wrapped in <p>', () => {
  assert.match(render('- a\n- b\n'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});

test('an indented continuation after a blank line is a second paragraph in the SAME item', () => {
  assert.match(render('- a\n\n  b\n'), /<ul><li><p>a<\/p><p>b<\/p><\/li><\/ul>/);
});

test('a blank line followed by dedented, unrelated content ends the list (stays tight, no <p>)', () => {
  // Regression: marking the list loose as soon as ANY blank line appears
  // inside an item was too eager — a blank line that's just the list's
  // natural end (followed by content that dedents out entirely, not a new
  // item or a continuation) must NOT retroactively wrap the single item.
  const html = render('- one\n\n two\n');
  assert.match(html, /<ul><li>one<\/li><\/ul><p>two<\/p>/);
});

test('three items separated by blank lines all get wrapped (looseness applies list-wide)', () => {
  const html = render('- foo\n\n- bar\n\n\n- baz\n');
  assert.match(html, /<ul><li><p>foo<\/p><\/li><li><p>bar<\/p><\/li><li><p>baz<\/p><\/li><\/ul>/);
});

// ── HTML blocks: real 7-type classification, not one generic close rule ───
test('a standalone HTML comment is not silently dropped', () => {
  // Regression: resolved (via _bd()) without ever writing anything, since
  // "the comment closes on the same line" wasn't routed through the actual
  // raw-HTML flush path at all.
  assert.strictEqual(render('<!-- comment -->\n'), '<!-- comment -->');
});

test('a type-6 HTML block (e.g. <div>) ends at the next blank line, not a matching close tag', () => {
  const html = render('<div>\n*foo*\n\n*bar*\n');
  assert.match(html, /<em>bar<\/em>/, 'content after the blank line is regular markdown again');
});

test('a block can start with a bare closing tag', () => {
  // Regression: a real HTML parser silently discards a closing tag with no
  // matching open element (confirmed empirically against jsdom/insertAdjacentHTML,
  // matching real browsers) — falls back to escaped literal text so the
  // content isn't lost outright, per the same pattern used for inline HTML.
  const html = render('</div>\n*foo*\n');
  assert.doesNotMatch(html, /^<p>\s*<\/p>$/);
  assert.match(html, /foo/);
});

test('type 1 (script/pre/style/textarea) still requires a matching closing tag, not a blank line', () => {
  const html = render('<script>\nvar x = 1;\n\nvar y = 2;\n</script>\n');
  assert.match(html, /<script>[\s\S]*var y = 2;[\s\S]*<\/script>/, 'the blank line inside must NOT end the block early');
});

test('an HTML comment inside a paragraph does not vanish (processing-instruction/declaration types)', () => {
  assert.match(render('<!ELEMENT br EMPTY>\n'), /ELEMENT br EMPTY/);
});

// ── "__" underline vs CommonMark <strong> (opt-in via commonMarkStrict) ───
test('by default, "__text__" renders as <u> (underline), not <strong>', () => {
  assert.match(render('__foo bar__\n'), /<u>foo bar<\/u>/);
  assert.doesNotMatch(render('__foo bar__\n'), /<strong>/);
});

test('with commonMarkStrict, "__text__" renders as <strong> per the CommonMark spec', () => {
  const html = render('__foo bar__\n', { commonMarkStrict: true });
  assert.match(html, /<strong>foo bar<\/strong>/);
  assert.doesNotMatch(html, /<u>/);
});

// ── DOM-native emphasis resolver (no out-of-DOM delimiter buffer) ─────────
// An opener only becomes real markup once a matching closer is actually
// found (by walking DOM siblings backward, live); an opener that never
// finds one is swept back to literal text once its block closes — this is
// what the naive "resolve immediately on every marker" approach could not
// do, since it commits to <em>/<strong> the moment a run merely LOOKS like
// an opener, with no way to undo that later if no valid close ever arrives.
test('an opener with no valid closer anywhere in the block stays fully literal', () => {
  // "_foo_bar": the first "_" can open, but the only candidate closing "_"
  // is intraword (forbidden) and so never validly closes it — the opener
  // must fall back to literal text, not render as an unclosed <em>.
  assert.strictEqual(render('_foo_bar\n', { commonMarkStrict: true }), '<p>_foo_bar</p>');
});

test('nested emphasis resolves correctly via DOM wrapping (no special-casing needed)', () => {
  const html = render('*foo **bar** baz*\n', { commonMarkStrict: true });
  assert.match(html, /<em>foo <strong>bar<\/strong> baz<\/em>/);
});

test('a run longer than needed leaves its leftover chars as literal text in place', () => {
  // "*foo **bar***": the closing "***" only needs 2 of its 3 chars to
  // close the "**bar" strong; the 1 leftover "*" stays literal, positioned
  // right after — not silently absorbed into the closing tag.
  const html = render('*foo **bar***\n', { commonMarkStrict: true });
  assert.match(html, /<em>foo <strong>bar<\/strong><\/em>/);
});

test('the "multiple of 3" rule is applied (6.2 rules 9/10)', () => {
  const html = render('foo***bar***baz\n', { commonMarkStrict: true });
  assert.match(html, /foo<em><strong>bar<\/strong><\/em>baz/);
});

// ── List item marker: spaces-after-marker absorption ───────────────────────
// CommonMark: 1-4 spaces after a list marker are indentation, defining the
// item's content column; extra leading spaces beyond the required one must
// NOT leak into the item's text. 5+ spaces means only the first is the
// separator — content column snaps back, and the rest become literal
// content instead of indentation.
test('extra spaces (up to 4 total) after a list marker are absorbed as indentation, not text', () => {
  assert.strictEqual(render('-    one\n'), '<ul><li>one</li></ul>');
});

test('5+ spaces after a list marker: only 1 is the separator, the item stays tight', () => {
  const html = render(' -    one\n\n     two\n');
  assert.match(html, /<ul><li>one<\/li><\/ul>/);
});

test('an ordered list marker with multiple spaces absorbs them into the content column', () => {
  assert.strictEqual(render('1.  A paragraph.\n'), '<ol><li>A paragraph.</li></ol>');
});

test('an inline "<...>" whose attributes lack proper leading whitespace is not a valid tag, stays literal', () => {
  // "href='bar'title=title": no whitespace between the closing quote and
  // "title" — CommonMark's tag grammar requires each attribute to have its
  // own leading whitespace, so this whole span is not an HTML tag at all.
  assert.strictEqual(render("<a href='bar'title=title>\n"), "<p>&lt;a href='bar'title=title&gt;</p>");
});

test('an autolink href percent-encodes unsafe characters like a normal link destination', () => {
  const html = render('<https://example.com?find=\\*>\n');
  assert.match(html, /href="https:\/\/example\.com\?find=%5C\*"/);
  // the visible link TEXT stays verbatim — autolink content is never escaped
  assert.match(html, />https:\/\/example\.com\?find=\\\*</);
});

test('a fenced code info string processes backslash escapes (e.g. "foo\\+bar" -> language "foo+bar")', () => {
  const html = render('``` foo\\+bar\nfoo\n```\n');
  assert.match(html, /class="language-foo\+bar"/);
});

test('an ATX heading strips leading whitespace before its content', () => {
  assert.strictEqual(render('#                  foo                     \n'), '<h1>foo</h1>');
});

test('a bare "#" alone on a line (no space, no content) is still an empty heading', () => {
  assert.strictEqual(render('#\n'), '<h1></h1>');
});

test('a fenced code info string decodes HTML entities (e.g. "f&ouml;&ouml;" -> "föö")', () => {
  const html = render('``` f&ouml;&ouml;\nfoo\n```\n');
  assert.match(html, /class="language-föö"/);
});

test('a failed setext-underline attempt still joins to its paragraph with a soft-break space', () => {
  // "= =" isn't a valid setext underline (must be all "=", no spaces) or a
  // thematic break, so it falls back to being ordinary paragraph text —
  // joined to the previous line the same way any other lazy continuation
  // line would be.
  assert.strictEqual(render('Foo\n= =\n'), '<p>Foo = =</p>');
});

test('blank lines at the start and end of an indented code block are trimmed, not just in the middle', () => {
  assert.strictEqual(render('\n    \n    foo\n    \n\n'), '<pre><code>foo\n</code></pre>');
});

test('an image alt attribute is the plain-text rendering of its label, not raw markdown source', () => {
  const html = render('![foo *bar*](train.jpg)\n');
  assert.match(html, /alt="foo bar"/);
});

test('a reference-style image label with emphasis also gets a plain-text alt', () => {
  const html = render('![foo *bar*]\n\n[foo *bar*]: train.jpg "train tracks"\n');
  assert.match(html, /alt="foo bar"/);
});

test('a backtick fence whose info string itself contains a backtick is not a valid fence', () => {
  // CommonMark: a backtick-fenced code block's info string may not contain
  // a backtick (unlike a tilde fence) — "```foo``" was never a real fence
  // opener, so the whole line falls back to ordinary paragraph content.
  const html = render('```foo``\n');
  assert.ok(!html.includes('<pre>'), 'should not render as a fenced code block: ' + html);
});

test('a fenced code block closer indented up to 3 spaces is still recognized', () => {
  assert.strictEqual(render('```\naaa\n  ```\n'), '<pre><code>aaa\n</code></pre>');
});

test("a fenced code block's content is dedented by the opening fence's own indent width", () => {
  assert.strictEqual(render('  ```\naaa\n  aaa\naaa\n  ```\n'), '<pre><code>aaa\naaa\naaa\n</code></pre>');
});

test('an ATX heading with content that is ENTIRELY the closing "#" sequence renders empty', () => {
  assert.strictEqual(render('### ###\n'), '<h3></h3>');
});

test('an email autolink with an invalid character (e.g. backslash) is not a valid autolink', () => {
  // "<foo\+@bar.example.com>": CommonMark's email-autolink grammar has no
  // backslash in it, so this was never a valid autolink at all — it falls
  // back to literal "<...>" text, where the backslash escape (still
  // processed for ordinary text, just not inside a real autolink) resolves
  // "\+" to a literal "+".
  const html = render('<foo' + String.fromCharCode(92) + '+@bar.example.com>\n');
  assert.strictEqual(html, '<p>&lt;foo+@bar.example.com&gt;</p>');
});

test('a lone blank ">" line does not create a stray empty paragraph', () => {
  assert.strictEqual(render('>\n'), '<blockquote></blockquote>');
});

test('a blank ">" line between two quoted paragraphs just separates them, no empty <p> between', () => {
  const html = render('> foo\n>\n> bar\n');
  assert.strictEqual(html, '<blockquote><p>foo</p><p>bar</p></blockquote>');
});

test('a ">" line with only trailing whitespace after the marker is still blank, not a paragraph containing a space', () => {
  assert.strictEqual(render('>\n>  \n> \n'), '<blockquote></blockquote>');
});

test('trailing whitespace on the last quoted line before a blank one does not leak into the paragraph', () => {
  const html = render('>\n> foo\n>  \n');
  assert.strictEqual(html, '<blockquote><p>foo</p></blockquote>');
});

test('a genuinely blank (unprefixed) line ends the blockquote, not just its current paragraph', () => {
  assert.strictEqual(render('> foo\n\n> bar\n'), '<blockquote><p>foo</p></blockquote><blockquote><p>bar</p></blockquote>');
});

test('a thematic break that ends a list does not leave the listStack stale for a later list', () => {
  const html = render('- foo\n***\n- bar\n');
  assert.strictEqual(html, '<ul><li>foo</li></ul><hr><ul><li>bar</li></ul>');
});

// ── DOM-native code-span resolver (same two-pass idea as emphasis) ─────────
// A backtick run commits immediately to a real <code> element so the
// common, well-formed, streaming case still renders live — but per
// CommonMark that only really counts once a matching-length closing run is
// found, possibly spanning several more lines. If the enclosing block ends
// first, _flushCodeSpans() reverts it to literal text and replays its raw
// content through the normal pipeline, the same architecture already used
// for unmatched emphasis delimiters (_flushEmphasis).
test('a code span survives a line ending, converted to a single space', () => {
  const html = render('``\nfoo\nbar  \nbaz\n``\n');
  assert.strictEqual(html, '<p><code>foo bar   baz</code></p>');
});

test('an opening backtick run with no matching closer anywhere reverts to literal text', () => {
  assert.strictEqual(render('`foo\n'), '<p>`foo</p>');
});

test('an unmatched single backtick does not swallow a LATER, genuinely matched pair', () => {
  const html = render('`foo``bar``\n');
  assert.strictEqual(html, '<p>`foo<code>bar</code></p>');
});

test('a marker char right after a code span opens correctly inside it, not lost', () => {
  const html = render('*foo`*`\n');
  assert.strictEqual(html, '<p>*foo<code>*</code></p>');
});

test('a backtick-fence-invalid line ("```foo``") falls back to fully literal text, with no characters lost', () => {
  assert.strictEqual(render('```foo``\n'), '<p>```foo``</p>');
});

// ── Link destination/title grammar (CommonMark 6.3) ─────────────────────────
test('a bare (unwrapped) link destination cannot contain a raw space — falls back to literal', () => {
  assert.strictEqual(render('[link](/my uri)\n'), '<p>[link](/my uri)</p>');
});

test('a link destination with unbalanced parens falls back to literal', () => {
  assert.strictEqual(render('[link](foo(and(bar))\n'), '<p>[link](foo(and(bar))</p>');
});

test('a link title may use parentheses as the delimiter, same as quotes', () => {
  const html = render('[link](/url (title))\n');
  assert.match(html, /<a[^>]*href="\/url"[^>]*title="title"/);
});

test('an unescaped matching quote inside a same-delimiter title is invalid — falls back to literal', () => {
  assert.strictEqual(render('[link](/url "title "and" title")\n'), '<p>[link](/url "title "and" title")</p>');
});

test('a link destination/title attempt that never reaches its closing ")" before the line ends falls back to literal, preserving the label', () => {
  const html = render('[link](foo\nbar)\n');
  assert.match(html, /^<p>\[link\]\(foo.bar\)<\/p>$/);
});

test('a "[" while already inside an open link label never creates an invalid nested <a>', () => {
  const html = render('[foo [bar](/uri)](/uri2)\n');
  assert.ok(!/<a[^>]*>[^<]*<a/.test(html), 'must not nest <a> inside <a>: ' + html);
});

// ── HTML block type 7 (CommonMark 4.6) ──────────────────────────────────────
test('a complete tag alone on its line, with a name not in the type-6 list, is an HTML block', () => {
  const html = render('<a href="foo">\n*bar*\n</a>\n');
  assert.strictEqual(html, '<a href="foo">\n*bar*\n</a>');
});

test('type 7 cannot interrupt an already-open paragraph', () => {
  // "<kbd>" isn't alone on the line (there's more before/after it), so this
  // must stay ordinary inline content, not attempt an HTML block at all.
  const html = render('<kbd>x</kbd>');
  assert.match(html, /<kbd>x<\/kbd>/);
});

test('type 7 ends at the next blank line, leaving later content as normal markdown', () => {
  const html = render('<del>\n\n*foo*\n\n</del>\n');
  assert.match(html, /<del><\/del>/);
  assert.match(html, /<em>foo<\/em>/);
});

test('indented code following a blank line inside a list item is recognized (not just a plain paragraph)', () => {
  const html = render('- foo\n\n      bar\n');
  assert.strictEqual(html, '<ul><li><p>foo</p><pre><code>bar\n</code></pre></li></ul>');
});

test('an ordered list marker may start with "0"', () => {
  assert.strictEqual(render('0. ok\n'), '<ol start="0"><li>ok</li></ol>');
});

test('an ordered list marker strips leading zeros from its start number', () => {
  assert.strictEqual(render('003. ok\n'), '<ol start="3"><li>ok</li></ol>');
});

test('a "-" immediately followed by a non-space, non-"-" character stays literal text, not truncated', () => {
  assert.strictEqual(render('-one\n\n2.two\n'), '<p>-one</p><p>2.two</p>');
});

test('"-1." is not a valid list marker (bullet needs a following space) and stays literal', () => {
  assert.strictEqual(render('-1. not ok\n'), '<p>-1. not ok</p>');
});

// ── Empty list items (CommonMark 5.2: a marker with no content) ────────────
test('a bullet marker alone on its line is a valid, empty list item', () => {
  assert.strictEqual(render('*\n'), '<ul><li></li></ul>');
});

test('an empty-marker item followed by an indented line becomes that (tight) content', () => {
  assert.strictEqual(render('-\n  foo\n'), '<ul><li>foo</li></ul>');
});

test('a marker followed only by trailing whitespace (no real content) behaves the same as one with none at all', () => {
  assert.strictEqual(render('-   \n  foo\n'), '<ul><li>foo</li></ul>');
});

test('consecutive empty and non-empty items in the same list all resolve correctly', () => {
  assert.strictEqual(render('- foo\n-\n- bar\n'), '<ul><li>foo</li><li></li><li>bar</li></ul>');
  assert.strictEqual(render('1. foo\n2.\n3. bar\n'), '<ol><li>foo</li><li></li><li>bar</li></ol>');
});

test('an empty list marker cannot interrupt an already-open paragraph', () => {
  assert.strictEqual(render('foo\n*\n'), '<p>foo *</p>');
});

// ── Bracket backtracking: multiple stray "]" in one label ──────────────────
test('extra closing brackets before the real one stay literal inside the label', () => {
  const html = render('[link [foo [bar]]](/uri)\n');
  assert.match(html, /<a[^>]*href="\/uri"[^>]*>link \[foo \[bar\]\]<\/a>/);
});

test('the same backtracking applies to image alt text', () => {
  const html = render('![foo]]](/uri)\n');
  assert.match(html, /<img[^>]*src="\/uri"[^>]*alt="foo\]\]"/);
});

test('list items with slightly increasing indentation are still one flat list, not progressively nested', () => {
  assert.strictEqual(render('- a\n - b\n  - c\n   - d\n'), '<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>');
});

test('two sibling items at the same nested level stay siblings, not popped back to the parent list', () => {
  const html = render('- a\n  - b\n  - c\n\n- d\n  - e\n  - f\n');
  assert.strictEqual(html, '<ul><li><p>a</p><ul><li>b</li><li>c</li></ul></li><li><p>d</p><ul><li>e</li><li>f</li></ul></li></ul>');
});

test('a new sibling list item after a blank-line continuation paragraph never nests inside that <p>', () => {
  const html = render('- a\n- b\n\n  c\n- d\n');
  assert.ok(!/<li>\s*d\s*<\/li>\s*<\/p>/.test(html), 'must not nest <li> inside <p>: ' + html);
  assert.strictEqual(html, '<ul><li><p>a</p></li><li><p>b</p><p>c</p></li><li><p>d</p></li></ul>');
});

test('a link reference definition cannot interrupt an already-open paragraph', () => {
  const html = render('Foo\n[bar]: /baz\n\n[bar]\n');
  assert.strictEqual(html, '<p>Foo [bar]: /baz</p><p>[bar]</p>');
});

// ── Link reference definition grammar (CommonMark 4.7) ──────────────────────
test('a link reference definition can span multiple lines (destination and title each on their own line)', () => {
  const html = render('[foo]:\n/url\n\n[foo]\n');
  assert.match(html, /<a[^>]*href="\/url"[^>]*>foo<\/a>/);
});

test('a link reference definition title may use parentheses, same as an inline link', () => {
  const html = render('[foo]: /url (title)\n\n[foo]\n');
  assert.match(html, /<a[^>]*href="\/url"[^>]*title="title"[^>]*>foo<\/a>/);
});

test('backslash escapes only apply to ASCII punctuation, elsewhere the backslash stays literal', () => {
  const html = render('[link](foo' + String.fromCharCode(92) + 'bar)\n');
  assert.match(html, /href="foo%5Cbar"/);
});

test('a reference definition with no title present still resolves; the next line is ordinary content', () => {
  const html = render('[foo]: /url\nbar\n===\n[foo]\n');
  assert.strictEqual(html, '<h1>bar</h1><p><a target="_blank" rel="noopener noreferrer" href="/url">foo</a></p>');
});

test('of two duplicate reference definitions, the first one wins', () => {
  const html = render('[foo]\n\n[foo]: first\n[foo]: second\n');
  assert.match(html, /href="first"/);
});

test('an HTML block tag name immediately followed by a newline (">" on a later line) is still recognized', () => {
  const html = render('<style\n  type="text/css">\nh1 {color:red;}\n\np {color:blue;}\n</style>\nokay\n');
  assert.match(html, /<style\s+type="text\/css">/);
  assert.match(html, /<p>okay<\/p>/);
});

test('list-relative indented code correctly ends when a later block is less indented than the code needs', () => {
  const html = render('1.  A paragraph\n    with two lines.\n\n        indented code\n\n    > A block quote.\n');
  assert.ok(!html.includes('block quote'.replace(' ', '&gt; ')), 'blockquote text must not leak into the code block: ' + html);
  assert.match(html, /<pre><code>indented code\n?<\/code><\/pre>/);
});

test('a block that follows list-relative indented code stays nested inside the same <li>', () => {
  const html = render('1.  A paragraph\n    with two lines.\n\n        indented code\n\n    > A block quote.\n');
  assert.match(html, /<ol><li>.*<blockquote>.*<\/blockquote><\/li><\/ol>/s);
});

test('an empty list marker followed by a blank line stays empty forever — later indented content is a separate paragraph', () => {
  assert.strictEqual(render('-\n\n  foo\n'), '<ul><li></li></ul><p>foo</p>');
});

test('a tab overshooting the indented-code trigger column keeps its leftover width as literal spaces', () => {
  assert.strictEqual(render('- foo\n\n\t\tbar\n'), '<ul><li><p>foo</p><pre><code>  bar\n</code></pre></li></ul>');
});

test('an unprefixed setext underline after a quoted paragraph ends the quote as a thematic break, not a heading', () => {
  assert.strictEqual(render('> Foo\n---\n'), '<blockquote><p>Foo</p></blockquote><hr>');
});

test('an unprefixed "=" underline after a quoted paragraph is just lazy-continuation text, not a heading', () => {
  assert.strictEqual(render('> foo\nbar\n===\n'), '<blockquote><p>foo bar ===</p></blockquote>');
});

test('a 4+ indented list marker after an unprefixed line inside a blockquote is lazy-continuation text, not a new list', () => {
  assert.strictEqual(render('> foo\n    - bar\n'), '<blockquote><p>foo - bar</p></blockquote>');
});

test('a link reference definition inside a list item is consumed silently, without a stray empty <p>', () => {
  assert.strictEqual(render('- a\n- b\n\n  [ref]: /url\n- d\n'), '<ul><li><p>a</p></li><li><p>b</p></li><li><p>d</p></li></ul>');
});

test('a blockquote nested inside a list item does not corrupt the list for a later sibling marker', () => {
  const html = render('* a\n  > b\n  >\n* c\n');
  assert.strictEqual((html.match(/<ul>/g) || []).length, 1, 'must stay one list, not split into two: ' + html);
  assert.match(html, /<li>a<blockquote><p>b<\/p><\/blockquote><\/li><li>c<\/li>/);
});

test('a 4+ indented ATX heading marker after an open paragraph is lazy-continuation text, not a heading', () => {
  assert.strictEqual(render('foo\n    # bar\n'), '<p>foo # bar</p>');
});

test('extra spaces buffered together with the first content character are absorbed, not kept as a leading space', () => {
  assert.strictEqual(render('-  foo\n\n   bar\n'), '<ul><li><p>foo</p><p>bar</p></li></ul>');
});

// ── Same-line block nesting right after a list marker ───────────────────────
// A list item's first content, right after its marker, is now replayed
// through decideBlock() (same pattern already used for blockquote content)
// so it can itself start a NESTED block — a marker, heading, etc. — instead
// of always being forced straight into the item as inline text.
test('a list marker immediately followed by another marker nests a sub-list', () => {
  assert.strictEqual(render('- - foo\n'), '<ul><li><ul><li>foo</li></ul></li></ul>');
});

test('marker, sub-list, and a further-nested ordered list all on one line', () => {
  assert.strictEqual(render('1. - 2. foo\n'), '<ol><li><ul><li><ol start="2"><li>foo</li></ol></li></ul></li></ol>');
});

test('an ATX heading right after a list marker nests inside the item', () => {
  assert.strictEqual(render('- # Foo\n'), '<ul><li><h1>Foo</h1></li></ul>');
});

test('an ATX heading on its OWN line after list content still ends the list normally', () => {
  assert.strictEqual(render('- foo\n# bar\n'), '<ul><li>foo</li></ul><h1>bar</h1>');
});

test('ordinary sibling list items still have no stray leading space (regression guard)', () => {
  assert.strictEqual(render('- one\n- two\n'), '<ul><li>one</li><li>two</li></ul>');
});

// ── Runner ──────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failures.push({ name, err });
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed (of ${tests.length})\n`);
  if (failures.length > 0) {
    for (const { name, err } of failures) {
      console.log(`✗ ${name}`);
      console.log(`  ${err.message}\n`);
    }
    process.exitCode = 1;
  } else {
    console.log('All regression checks passed.');
  }
})();
