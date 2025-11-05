const API_URL = 'https://ollama-api.singaseong.uk/api/generate';

function buildMessages(history = [], prompt) {
  const normalizedHistory = Array.isArray(history) ? history : [];
  const messages = normalizedHistory
    .filter(msg => msg && typeof msg.role === 'string' && typeof msg.content === 'string')
    .map(msg => ({ role: msg.role, content: msg.content }));

  if (typeof prompt === 'string' && prompt.length > 0) {
    messages.push({ role: 'user', content: prompt });
  }

  return messages;
}

async function readStream(response, onChunk) {
  if (!response.body) {
    throw new Error('스트리밍을 지원하지 않는 응답입니다.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResponse = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        const data = JSON.parse(line);
        const text = data.response || data.message?.content || '';
        if (text) {
          fullResponse += text;
          if (typeof onChunk === 'function') {
            onChunk(data);
          }
        }
      } catch (error) {
        console.warn('스트림 청크 파싱 실패:', error);
      }
    }
  }

  return fullResponse;
}

async function sendChatMessage({ prompt, history = [], stream = false, onChunk } = {}) {
  const payload = {
    model: 'tinyllama',
    prompt,
    history,
    messages: buildMessages(history, prompt),
    stream
  };

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`API 요청 실패: ${response.status}`);
  }

  if (stream) {
    const fullResponse = await readStream(response, chunk => {
      if (typeof onChunk === 'function') {
        onChunk(chunk);
      }
    });

    return { fullResponse };
  }

  const result = await response.json();
  const fullResponse = result.response || result.message?.content || '';
  if (fullResponse && typeof onChunk === 'function') {
    onChunk(result);
  }

  return { fullResponse, raw: result };
}

async function ping() {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'tinyllama', prompt: 'ping', stream: false })
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
