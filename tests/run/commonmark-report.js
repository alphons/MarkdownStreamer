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
const { render } = require('./render');
const cases = require('./commonmark-spec.json');

// Loose comparison, so the score reflects real structural/content
// conformance rather than noise from two deliberate, documented md4.js
// design choices plus block-formatting whitespace:
//  - md4.js always adds target="_blank" rel="noopener noreferrer" to <a>
//    (spec examples have plain <a href>) — stripped before comparing.
//  - a standalone (non-linked) <img> gets class="blk" for block display
//    (see openTable/markStandaloneImages) — stripped before comparing.
//  - the spec pretty-prints block tags on their own line and represents a
//    soft line break as a literal newline; md4.js emits compact HTML and
//    represents a soft line break as a space — both render identically in
//    a browser. Whitespace runs are collapsed to a single space (so a
//    soft-break space and a literal newline compare equal), and any
//    whitespace that ends up directly between '>' and '<' is then dropped
//    entirely (pure block-formatting indentation, not text content).
function normalize(html) {
  return html
    .replace(/ target="_blank" rel="noopener noreferrer"/g, '')
    .replace(/ class="blk"/g, '')
    // a live DOM's innerHTML always serializes a literal U+00A0 character as
    // the "&nbsp;" entity; the spec's own JSON keeps it as a literal char.
    .replace(/&nbsp;/g, ' ')
    // void-element self-closing slash: a real DOM/innerHTML can never
    // produce "<br />" or "<img ... />", only "<br>"/"<img ...>" — not a
    // fixable difference, and attribute order on a real element is
    // insertion-order, not alphabetical, so tolerate that too for <img>.
    .replace(/<br\s*\/?>/g, '<br>')
    .replace(/<img([^>]*?)\s*\/>/g, '<img$1>')
    .replace(/<img ([^>]*)>/g, (_, attrs) => {
      const tokens = attrs.trim().match(/[\w-]+(?:="[^"]*"|='[^']*')?/g) || [];
      return '<img ' + tokens.sort().join(' ') + '>';
    })
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

const bySection = new Map();

for (const c of cases) {
  let actual;
  let error = null;
  try {
    actual = render(c.markdown);
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
