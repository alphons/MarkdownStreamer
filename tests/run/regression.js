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
