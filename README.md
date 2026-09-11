# MarkdownStreamer

![Version](https://img.shields.io/badge/version-4.0.1-blue)
![Regression tests](https://img.shields.io/badge/regression%20tests-189%2F189-brightgreen)
![CommonMark conformance](https://img.shields.io/badge/CommonMark-618%2F652%20(95%25)-yellow)

A lightweight, streaming Markdown parser that renders directly into the DOM — character by character, in real time. No dependencies, no build step.

> **Version:** md v4.0.1
> **Author:** Alphons van der Heijden

Badges are updated by hand from `tests/run/regression.js` and `tests/run/commonmark-report.js` — run both after any parser change and refresh the numbers above.

---

## How it works

`MarkdownStreamer` processes Markdown one character at a time. This makes it ideal for streaming output from an LLM or any character-based text source: the DOM is updated live as characters arrive, with no buffering of the full document required.

---

## Quick start

### Synchronous (instant render)

```html
<div id="output" class="pane-output"></div>
<link rel="stylesheet" href="md4.css">
<link rel="stylesheet" href="md4-dark.css"> <!-- or md4-light.css -->
<script src="md4-entities.js"></script>
<script src="md4.js"></script>
<script>
  const el = document.getElementById('output');
  const streamer = new MarkdownStreamer(el);
  streamer.markdown('# Hello\n\nThis is **MarkdownStreamer**.');
  streamer.finalize();
</script>
```

Notes:
- `md4-entities.js` must load *before* `md4.js` — it defines the `ENTITY_MAP` used to decode HTML entities, kept in a separate file only to stay out of the main parser source.
- `md4.css`'s rules are scoped to a `.pane-output` class, and rely on custom properties (`--accent`, `--text`, `--code-bg`, ...) defined by a theme file — pair it with `md4-dark.css` or `md4-light.css`, or supply your own values for those properties.

### Animated streaming

```html
<div id="output" class="pane-output"></div>
<script src="md4-entities.js"></script>
<script src="md4.js"></script>
<script>
  async function stream() {
    const el = document.getElementById('output');
    const streamer = new MarkdownStreamer(el);

    streamer.setSpeed(80); // 1–100, higher = faster

    await streamer.markdownasync('# Hello\n\nStreamed **word by word**...');

    streamer.finalize();
  }

  stream();
</script>
```

### Stop mid-stream

```js
streamer.stop(); // halts markdownasync() immediately
```

---

## API

| Method | Description |
|---|---|
| `new MarkdownStreamer(rootEl)` | Create a new instance. Clears `rootEl` and attaches the parser. |
| `markdown(text)` | Render the full text synchronously (instant). |
| `markdownasync(text)` | Render the text asynchronously with animated streaming. Returns a `Promise`. |
| `finalize()` | Flush any remaining state and close open elements. Always call this after rendering. |
| `setSpeed(n)` | Set streaming speed (1–100). Controls the batch size and delay between frames. |
| `stop()` | Abort an in-progress `markdownasync()` call. |

### Real-world: LLM chat via Server-Sent Events

A common pattern is to stream LLM output chunk by chunk using the browser's `EventSource` API (SSE). Each incoming chunk is fed into `markdownasync()`. Because chunks arrive asynchronously and out of order, the calls are chained through a `Promise` so they are always processed sequentially.

```js
var streamer;
let eventSource = new EventSource('/api/Chat/Events');

// Chain incoming chunks so they are rendered in order
let processingPromise = Promise.resolve();

eventSource.onmessage = function (event) {
  const text = event.data.replace(/\\n/g, '\n');
  processingPromise = processingPromise.then(() => streamer.markdownasync(text));
};
```

When the user sends a message, a new `div` and `MarkdownStreamer` are created for the assistant reply, and `setSpeed()` is tuned for near-real-time output:

```js
async function sendMessage(text) {
  // Render the user message instantly
  const divUser = document.createElement('div');
  divUser.classList.add('user');
  const userStreamer = new MarkdownStreamer(divUser);
  userStreamer.markdown(text);
  userStreamer.finalize();
  output.append(divUser);

  // Prepare the assistant reply container
  const divAssistant = document.createElement('div');
  divAssistant.classList.add('assistant');
  streamer = new MarkdownStreamer(divAssistant);
  streamer.setSpeed(95); // near-real-time
  output.append(divAssistant);

  // POST to the API — SSE events will drive the streamer above
  await fetch('/api/Chat/Say', { method: 'POST', body: JSON.stringify({ text }) });
}
```

Existing chat history (already complete messages) is rendered synchronously with `markdown()` + `finalize()`:

```js
function renderHistory(messages) {
  messages.forEach(item => {
    if (item.role === 'system') return;
    const div = document.createElement('div');
    div.classList.add(item.role);            // 'user' or 'assistant'
    const s = new MarkdownStreamer(div);
    s.markdown(item.content);
    s.finalize();
    output.append(div);
  });
}
```

**Key points:**
- Use **one `MarkdownStreamer` instance per message bubble** — do not reuse across messages.
- Chain `markdownasync()` calls via a `Promise` when chunks arrive concurrently.
- Use `markdown()` + `finalize()` for already-complete text (history, user input).
- `setSpeed(95)` gives smooth, near-real-time LLM output animation.

---

## Implemented Markdown features

### Headings

```markdown
# H1
## H2
### H3
#### H4
##### H5
###### H6

Setext H1
=========

Setext H2
---------

## Heading with closing hashes ##
```

### Inline formatting

| Syntax | Result |
|---|---|
| `**bold**` | **bold** |
| `*italic*` | *italic* |
| `__underline__` | underline |
| `~~strikethrough~~` | ~~strikethrough~~ |
| `==highlight==` | highlighted |
| `` `inline code` `` | `inline code` |
| `x^sup^` | superscript |
| `H~sub~` | subscript |
| `***bold italic***` | ***bold italic*** |

### Hard line breaks

```markdown
Line one (two trailing spaces)
Line two

Line one\
Line two
```

### Links

```markdown
[label](https://example.com)
[label](https://example.com "title")
<https://example.com>            <!-- autolink -->
<info@example.com>               <!-- email autolink -->
https://example.com              <!-- bare URL (auto-detected) -->
[Google][ref]                    <!-- reference link -->
[Google]                         <!-- implicit reference link -->

[ref]: https://www.google.com "optional title"
```

### Images

```markdown
![alt text](https://example.com/image.png)
[![linked image](image.png)](https://example.com)
```

### Blockquotes (nested)

```markdown
> Level 1
>
> > Level 2
> >
> > > Level 3
```

### Lists

**Unordered:**
```markdown
- Item A
- Item B
  - Sub B1
  - Sub B2
```

**Ordered:**
```markdown
1. First
2. Second
   1. Sub 2a
3. Third

1) Alternative style
2) With parentheses
```

**Mixed:**
```markdown
- Fruit
  1. Apple
  2. Pear
```

### Task lists

```markdown
- [x] Done
- [ ] Open task
```

### Code blocks

**Fenced (backticks or tildes):**
````markdown
```javascript
function hello() { return 'world'; }
```

~~~css
body { color: red; }
~~~

~~~~
four-tilde fence
~~~~
````

**Indented (4 spaces):**
```markdown
    this is a code block
    indented by 4 spaces
```

### Tables

```markdown
| Left   | Center  | Right |
|:-------|:-------:|------:|
| a      | b       |     1 |
| **vet**| *cursief*| `code`|
```

Column alignment: `:---` left, `:---:` center, `---:` right.

### Horizontal rules

```markdown
---
***
_ _ _
- - -
```

### Definition lists

```markdown
Markdown
: A lightweight markup language

HTML
: HyperText Markup Language
: The structure language of the web
```

### Footnotes

```markdown
This has a footnote.[^1]

[^1]: Footnote text here.
```

### Abbreviations

```markdown
The HTML spec is used daily.

*[HTML]: HyperText Markup Language
```

Abbreviations are automatically wrapped in `<abbr title="...">` throughout the document.

### Raw HTML

Block-level HTML elements are passed through directly:

```markdown
<details>
<summary>Click to expand</summary>
Hidden content.
</details>
```

Inline HTML comments are also supported:

```markdown
before <!-- hidden --> after
```

### Backslash escapes

```markdown
\*not italic\*  \`not code\`  \[not a link\]
```

### HTML entities

Named and numeric entities are decoded:

```markdown
&copy;  &amp;  &lt;  &gt;  &euro;  &mdash;  &#128512;
```

### Math (non-standard extension)

Not part of CommonMark, but supported since it's near-universal in AI-model output. Content is kept 100% literal (backslashes, underscores, asterisks are never touched by markdown processing) so it can be handed to a client-side renderer like KaTeX or MathJax:

```markdown
Inline: $E = mc^2$

Block:

$$
\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}
$$
```

Inline math renders as `<span class="math math-inline">`, block math as `<div class="math math-block">` (which keeps both `$$` delimiter lines verbatim, matching what most auto-render math libraries expect).

---

## File overview

| File | Description |
|---|---|
| `tests/md4.js` | The parser — include this in your page |
| `tests/md4-entities.js` | HTML entity table (`ENTITY_MAP`) — load before `md4.js` |
| `tests/md4.css` | Base stylesheet for rendered markdown output (theme-agnostic) |
| `tests/md4-dark.css` | Dark-theme variables/overrides |
| `tests/md4-light.css` | Light-theme variables/overrides |
| `tests/md4-demo.css` | Styling for the demo page shell only (not needed for embedding) |
| `tests/md4.html` | Interactive demo with live streaming, speed control, and theme toggle |
| `tests/md4start.js` | Demo wiring (stream/stop buttons, theme toggle) |
| `tests/run/render.js` | Node/JSDOM helper for rendering markdown to HTML in tests |
| `tests/run/regression.js` | Regression test suite |
| `tests/run/commonmark-report.js` | CommonMark spec conformance report |

---

## License

Copyright (c) 2025–2026, Alphons van der Heijden.
[https://github.com/alphons/MarkdownStreamer](https://github.com/alphons/MarkdownStreamer)
