# md4.js tests

```
npm install        # once, installs jsdom (devDependency)
npm test            # regression suite — must pass, blocks on failure
npm run test:commonmark   # CommonMark 0.31.2 conformance report — informational only
```

## `regression.js`

Locks in real rendering bugs found and fixed on 2026-09-09 (see git log):
paragraphs incorrectly splitting on almost any marker character (`[`, `*`,
`_`, `` ` ``, `#`, `+`, `<`, ordered lists), characters dropped on paragraph
continuation lines, a setext heading (`---`/`===`) wrongly converting a
paragraph across a blank line, and `<p>` not being recognized as a raw HTML
block. Run this after any change to `decideBlock()` or the inline state
machine — it's the fast, authoritative check.

## `commonmark-report.js`

Runs md4.js against the official CommonMark spec examples
(`commonmark-spec.json`, vendored from spec.commonmark.org under CC-BY-SA
4.0) and prints a per-section pass score. **This does not gate anything** —
md4.js is a lightweight streaming parser, not a full CommonMark
implementation, and deviates in places by design (e.g. all links get
`target="_blank" rel="noopener noreferrer"`, standalone images get a `blk`
class for block display). Use it to see the current baseline and to notice
when a change moves a section's score sharply — that's usually worth a
second look even if nothing here fails outright.

## `render.js`

Shared jsdom harness: loads `md4.js` fresh per call into an isolated
window/document (the file is a plain browser script, not a module) and
exposes `render(markdown)` / `renderAsync(markdown)`.
