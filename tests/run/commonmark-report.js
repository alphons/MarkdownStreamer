'use strict';
// Runs md4.js against the official CommonMark 0.31.2 spec examples
// (tests/run/commonmark-spec.json, vendored from spec.commonmark.org under
// CC-BY-SA 4.0) and reports a pass/fail score per section.
//
// This is INFORMATIONAL, not a pass/fail gate: md4.js is a lightweight
// streaming parser that deliberately deviates from full CommonMark in
// places (e.g. no full reference-link edge cases, simplified list-item
// lazy-continuation rules). Use this report to see the current baseline
// and to notice when a change moves the score sharply in either direction.
//
// Rendered with { commonMarkStrict: true } so "__x__" scores as <strong>
// (the CommonMark-mandated meaning) rather than md4.js's default <u>
// (underline) — an intentional, documented deviation the tool keeps by
// default in normal use (see the constructor's opts.commonMarkStrict).
const { render } = require('./render');
const cases = require('./commonmark-spec.json');
const { JSDOM } = require('jsdom');

// A dedicated, reused document purely for re-parsing HTML strings through a
// real browser-grade HTML parser before comparing them (see normalize()
// below) — separate from render.js's per-call jsdom instance, which runs
// the actual md4.js parser under test.
const { document: normDoc } = new JSDOM('<!DOCTYPE html><div></div>').window;

// Loose comparison, so the score reflects real structural/content
// conformance rather than noise from:
//  - two deliberate, documented md4.js design choices: it always adds
//    target="_blank" rel="noopener noreferrer" to <a> (spec examples have
//    plain <a href>), and a standalone (non-linked) <img> gets class="blk"
//    for block display (see openTable/markStandaloneImages) — both
//    stripped before comparing.
//  - pure HTML-serialization noise that can never survive a real DOM
//    round-trip regardless of how faithfully md4.js parsed the input: a
//    self-closing slash on a non-void element, an unclosed tag that gets
//    auto-nested/closed, attribute order, U+00A0 vs "&nbsp;", etc. The spec
//    JSON's "expected" html is produced by a reference implementation that
//    concatenates strings and never runs its own output back through an
//    HTML parser — so for raw-HTML-passthrough cases in particular, its
//    "expected" string is sometimes not the DOM a browser would ever
//    actually produce from that string. md4.js parses straight into a
//    real, live DOM (see e.g. flushRawHtml()'s <template>.innerHTML=), so
//    the fair comparison is "what DOM does each side resolve to", not "are
//    the two source strings byte-identical". Both sides are re-parsed
//    through the same real HTML parser (jsdom, matching what any actual
//    browser would do) before comparing, so a difference only counts as a
//    failure when it reflects an actual difference in the rendered result.
//  - the spec also pretty-prints block tags on their own line and
//    represents a soft line break as a literal newline; md4.js emits
//    compact HTML and represents a soft line break as a space — both
//    render identically in a browser. Whitespace runs are collapsed to a
//    single space (so a soft-break space and a literal newline compare
//    equal), and any whitespace directly between '>' and '<' is dropped
//    entirely (pure block-formatting indentation, not text content).
function throughDom(html) {
  const el = normDoc.createElement('div');
  el.innerHTML = html;
  return el.innerHTML;
}

function normalize(html) {
  return throughDom(
    html
      .replace(/ target="_blank" rel="noopener noreferrer"/g, '')
      .replace(/ class="blk"/g, '')
      // A trailing text node (often just the source's own trailing "\n")
      // sitting after a </p> that auto-closed while an unclosed <a> (or
      // other formatting element) was still open triggers the HTML5
      // parser's "reconstruct active formatting elements" step, spuriously
      // reopening an empty <a></a> after the paragraph. That's a real
      // parser quirk, but one purely of *this* trailing whitespace, not of
      // any actual content difference — trim it before parsing so it can't
      // spuriously distinguish two sides that render identically otherwise.
      .trim()
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

const bySection = new Map();

for (const c of cases) {
  let actual;
  let error = null;
  try {
    actual = render(c.markdown, { commonMarkStrict: true });
  } catch (err) {
    actual = '';
    error = err;
  }
  const pass = !error && normalize(actual) === normalize(c.html);

  if (!bySection.has(c.section)) bySection.set(c.section, { pass: 0, total: 0 });
  const s = bySection.get(c.section);
  s.total++;
  if (pass) s.pass++;
}

let totalPass = 0;
let totalCases = cases.length;
const rows = [...bySection.entries()].sort((a, b) => a[1].pass / a[1].total - b[1].pass / b[1].total);

console.log('CommonMark 0.31.2 conformance (informational — not a required gate)\n');
console.log('score  section');
for (const [section, { pass, total }] of rows) {
  totalPass += pass;
  const pct = ((pass / total) * 100).toFixed(0).padStart(3, ' ');
  console.log(`${pct}%  ${pass}/${total}  ${section}`);
}
console.log(`\nOverall: ${totalPass}/${totalCases} (${((totalPass / totalCases) * 100).toFixed(1)}%)`);
