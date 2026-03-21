const sourceEl    = document.getElementById('source');
const outputEl    = document.getElementById('output');
const streamBtn   = document.getElementById('streamBtn');
const stopBtn     = document.getElementById('stopBtn');
const speedSlider = document.getElementById('speedSlider');
const themeBtn    = document.getElementById('themeBtn');

var streamer;

async function startStream() 
{
  const text = sourceEl.value;
  outputEl.innerHTML = '';
  streamer = new MarkdownStreamer(outputEl);

  streamBtn.disabled = true; 
  stopBtn.disabled = false;

  streamer.setSpeed( parseInt(speedSlider.value));

  await streamer.markdownasync(text);
  
  streamer.finalize();
  streamBtn.disabled = false; 
  stopBtn.disabled = true;
}

function stopStream() 
{
  streamBtn.disabled = false; 
  stopBtn.disabled = true; 
  streamer.stop();
}

streamBtn.addEventListener('click', startStream);
stopBtn.addEventListener('click', stopStream);


themeBtn.addEventListener('click', () => 
{
  const light = outputEl.classList.toggle('light');
  themeBtn.textContent = light ? 'Dark' : 'Light';
});
