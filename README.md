# MarkdownStreamer

A lightweight, streaming Markdown parser that renders directly into the DOM — character by character, in real time. No dependencies, no build step.

> **Version:** md v4.0.1
> **Author:** Alphons van der Heijden

---

## How it works

`MarkdownStreamer` processes Markdown one character at a time. This makes it ideal for streaming output from an LLM or any character-based text source: the DOM is updated live as characters arrive, with no buffering of the full document required.

---

## Quick start

### Synchronous (instant render)

```html
<div id="output"></div>
<script src="md4.js"></script>
<script>
  const el = document.getElementById('output');
  const streamer = new MarkdownStreamer(el);
  streamer.markdown('# Hello\n\nThis is **MarkdownStreamer**.');
  streamer.finalize();
</script>
```

### Animated streaming

```html
<div id="output"></div>
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
| `processChar(ch)` | Feed a single character into the parser. |
| `finalize()` | Flush any remaining state and close open elements. Always call this after rendering. |
| `setSpeed(n)` | Set streaming speed (1–100). Controls the batch size and delay between frames. |
| `stop()` | Abort an in-progress `markdownasync()` call. |

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

---

## File overview

| File | Description |
|---|---|
| `tests/md4.js` | The parser — include this in your page |
| `tests/md4.css` | Full stylesheet for rendered output (dark/light) |
| `tests/md4-light.css` | Light-theme-only stylesheet |
| `tests/md4.html` | Interactive demo with live streaming, speed control, and theme toggle |
| `tests/md4start.js` | Demo wiring (stream/stop buttons, theme toggle) |

---

## License

Copyright (c) 2025–2026, Alphons van der Heijden.
[https://github.com/alphons/MarkdownStreamer](https://github.com/alphons/MarkdownStreamer)
