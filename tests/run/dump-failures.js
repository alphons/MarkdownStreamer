'use strict';
// Dumps individual failing CommonMark cases for one section, so we can see
// markdown/expected/actual side by side instead of just a pass count.
// Uses the same DOM-based comparison as commonmark-report.js.
// Usage: node dump-failures.js "<section name>" [maxCases]
const { render } = require('./render');
const cases = require('./commonmark-spec.json');
const { JSDOM } = require('jsdom');

const { document: normDoc } = new JSDOM('<!DOCTYPE html><div></div>').window;

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
  )
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

const section = process.argv[2];
const max = parseInt(process.argv[3] || '10', 10);
if (!section) { console.error('usage: node dump-failures.js "<section>" [maxCases]'); process.exit(1); }

let shown = 0;
for (const c of cases) {
  if (c.section !== section) continue;
  let actual; let error = null;
  try { actual = render(c.markdown, { commonMarkStrict: true }); } catch (err) { actual = ''; error = err; }
  const pass = !error && normalize(actual) === normalize(c.html);
  if (pass) continue;
  shown++;
  console.log('='.repeat(70));
  console.log(`example #${c.example}`);
  console.log('--- markdown ---');
  console.log(JSON.stringify(c.markdown));
  console.log('--- expected ---');
  console.log(c.html);
  console.log('--- actual ---');
  console.log(error ? 'ERROR: ' + error.stack : actual);
  if (shown >= max) break;
}
console.log('='.repeat(70));
console.log(`shown ${shown} failing case(s) in section "${section}"`);
