const API_URL = 'https://api.singaseong.uk/api/generate?hb=1';

function buildMessages(history = [], prompt) {
  const seed = [{
    role: 'system',
    content: [
      'You are TinyLlama, a warm and friendly conversational assistant.',
      'Respond naturally and keep the dialogue flowing like a real chat.',
      'Stay concise (≤60 words) unless the user explicitly asks for more detail.'
    ].join(' ')
  }];
  const normalized = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string');

  const recent = normalized.slice(-6); // last 6 messages only
  const messages = seed.concat(recent);
  if (typeof prompt === 'string' && prompt.length > 0) {
    messages.push({ role: 'user', content: prompt });
  }
  return messages;
}

async function readStream(response, onChunk) {
  if (!response.body) throw new Error('스트리밍을 지원하지 않는 응답입니다.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';
  let sseMode = false;

  const flushNDJSONLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith(':')) return; // SSE comments / keepalives
    try {
      const data = JSON.parse(trimmed);
      const text = data.response || data.message?.content || '';
      if (text) {
        fullResponse += text;
        onChunk?.(data);
      } else {
        // still forward non-text payloads (e.g., meta/error envelopes)
        onChunk?.(data);
      }
    } catch {
      // ignore non-JSON lines in NDJSON mode
    }
  };

  // SSE parsing state
  let sseEvent = null;
  let sseDataLines = [];

  const flushSSEEvent = () => {
    if (sseDataLines.length === 0 && !sseEvent) return;
    const dataStr = sseDataLines.join('\n');
    let payload = dataStr;
    try {
      payload = JSON.parse(dataStr);
    } catch { /* best-effort */ }
    const envelope = sseEvent ? { event: sseEvent, data: payload } : { data: payload };

    // unify callback contract
    if (envelope && envelope.data) {
      const maybeText = envelope.data.response || envelope.data.message?.content || '';
      if (maybeText) {
        fullResponse += maybeText;
      }
    }
    onChunk?.(envelope);

    sseEvent = null;
    sseDataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    // Detect SSE mode by headers or first bytes (very forgiving)
    // If server sends "text/event-stream", prefer SSE mode.
    if (!sseMode) {
      const ct = response.headers.get('Content-Type') || '';
      if (ct.includes('text/event-stream')) sseMode = true;
      // also switch if we see "data:" / ":" sentinel before any JSON line
      if (!sseMode && (buffer.includes('data:') || buffer.startsWith(':'))) {
        sseMode = true;
      }
    }

    if (sseMode) {
      // Parse SSE by lines; events are separated by blank line
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = raw.replace(/\r$/, '');

        if (line === '') {
          // end of event
          flushSSEEvent();
          continue;
        }
        if (line.startsWith(':')) {
          // comment / heartbeat (ignore but keeps connection alive)
          continue;
        }
        const idx = line.indexOf(':');
        const field = (idx === -1 ? line : line.slice(0, idx)).trim();
        const value = (idx === -1 ? '' : line.slice(idx + 1)).replace(/^ /, '');

        if (field === 'event') sseEvent = value;
        else if (field === 'data') sseDataLines.push(value);
        // (you could handle id/retry if you add reconnection later)
      }
    } else {
      // NDJSON mode
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        flushNDJSONLine(line);
      }
    }

    if (done) break;
  }

  // flush tail
  if (sseMode) flushSSEEvent();
  else if (buffer.trim()) flushNDJSONLine(buffer);

  return fullResponse;
}

async function sendChatMessage({ prompt, history = [], stream = true, onChunk, maxMillis = 0 } = {}) {
  const messages = buildMessages(history, prompt);
  const payload = {
    model: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0',
    prompt,
    history,
    messages,
    stream: true,          // hb mode is for streaming
    max_tokens: 256,       // keep outputs short; adjust to taste
    temperature: 0.2
  };

  const controller = new AbortController();
  let timeoutId = null;
  if (maxMillis > 0) {
    timeoutId = setTimeout(() => controller.abort(), maxMillis);
  } else {
    // optional: keep a generous guard (e.g., 5 minutes)
    timeoutId = setTimeout(() => controller.abort(), 300_000);
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'   // prefer SSE path with heartbeats
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`API 요청 실패: ${response.status}`);
    }

    const fullResponse = stream
      ? await readStream(response, onChunk)
      : await response.json().then((r) => (r.response || r.message?.content || ''));

    return { fullResponse };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function ping() {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'TinyLlama/TinyLlama-1.1B-Chat-v1.0', prompt: 'ping', stream: true })
    });

    if (!response.ok) {
      throw new Error('서버 상태 확인 실패');
    }
  } catch (error) {
    throw new Error(error.message || '서버에 연결할 수 없습니다.');
  }
}

window.client = {
  sendChatMessage,
  ping
};
