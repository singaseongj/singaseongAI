async function streamTinyLlama(prompt, onToken) {
  const res = await fetch('https://tight-cloud-0f5e.seongj1589.workers.dev/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'tinyllama', prompt, stream: true })
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const json = JSON.parse(line);
        if (json.response) onToken(json.response); // append to your UI
        if (json.done) onToken('\n[done]');
      } catch { /* ignore partial lines */ }
    }
  }
}

// example usage:
streamTinyLlama('안녕! TinyLlama 테스트.', token => {
  // e.g., document.querySelector('#out').textContent += token;
  console.log(token);
});
