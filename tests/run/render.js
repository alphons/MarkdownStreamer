'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const MD4_PATH = path.join(__dirname, '..', 'md4.js');

// Loads md4.js fresh (via Function, not require/eval) so each call gets an
// isolated window/document pair — md4.js is written as a browser script
// ('use strict' + class declarations) with no module exports.
function loadMarkdownStreamer() {
  const dom = new JSDOM('<!DOCTYPE html><div id="output"></div>');
  const { document } = dom.window;
  const code = fs.readFileSync(MD4_PATH, 'utf8');
  const MarkdownStreamer = new Function(
    'document', 'DOMParser', 'NodeFilter',
    code + '\nreturn MarkdownStreamer;'
  )(document, dom.window.DOMParser, dom.window.NodeFilter);
  return { MarkdownStreamer, document };
}

// Renders markdown -> innerHTML using the synchronous (non-streaming) API.
function render(markdown) {
  const { MarkdownStreamer, document } = loadMarkdownStreamer();
  const el = document.getElementById('output');
  const streamer = new MarkdownStreamer(el);
  streamer.markdown(markdown);
  streamer.finalize();
  return el.innerHTML;
}

// Renders via the async streaming API, char-by-char at max speed — used to
// verify the streaming path doesn't hang or diverge from the sync path.
async function renderAsync(markdown) {
  const { MarkdownStreamer, document } = loadMarkdownStreamer();
  const el = document.getElementById('output');
  const streamer = new MarkdownStreamer(el);
  streamer.setSpeed(100);
  await streamer.markdownasync(markdown);
  streamer.finalize();
  return el.innerHTML;
}

module.exports = { loadMarkdownStreamer, render, renderAsync };
