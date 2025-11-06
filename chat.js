const API_URL = 'https://api.singaseong.uk/api/generate?hb=1';

function buildMessages(history = [], prompt) {
  const seed = [{ role: 'system', content: 'Reply concisely (≤60 words) unless asked.' }];
  const normalized = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.role === 'string' && typeof m.content === 'string');

  const recent = normalized.slice(-6);
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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    
    // 줄 단위로 처리
    let lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Worker 특수 명령 건너뛰기
      if (trimmed.startsWith(':')) {
        continue;
      }
      
      // SSE 형식 (data: prefix)
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.substring(5).trim();
        if (dataStr === '[DONE]') continue;
        
        try {
          const data = JSON.parse(dataStr);
          
          // 메타 이벤트는 무시
          if (data.event === 'meta') {
            continue;
          }
          
          const text = extractText(data);
          if (text) {
            fullResponse += text;
            onChunk?.({ response: text });
          }
        } catch (e) {
          // JSON이 아닌 경우 직접 텍스트로 처리
          if (dataStr && !dataStr.startsWith('{')) {
            fullResponse += dataStr;
            onChunk?.({ response: dataStr });
          }
        }
      }
      // 일반 JSON 라인
      else if (trimmed.startsWith('{')) {
        try {
          const data = JSON.parse(trimmed);
          
          // 메타 이벤트는 완전히 무시
          if (data.event === 'meta') {
            continue;
          }
          
          const text = extractText(data);
          if (text) {
            fullResponse += text;
            onChunk?.({ response: text });
          }
        } catch (e) {
          // 파싱 오류 무시
        }
      }
      // 그 외 텍스트는 직접 응답으로 처리
      else {
        if (!trimmed.includes('worker-op')) {
          fullResponse += trimmed;
          onChunk?.({ response: trimmed });
        }
      }
    }
  }
  
  // 남은 버퍼 처리
  if (buffer.trim() && !buffer.includes(':worker-op')) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        const text = extractText(data);
        if (text) fullResponse += text;
      } catch (e) {
        // 무시
      }
    } else {
      fullResponse += trimmed;
    }
  }

  return fullResponse;
}

// 다양한 응답 형식에서 텍스트 추출
function extractText(data) {
  if (!data || typeof data !== 'object') return '';
  
  // 직접 필드들
  if (data.response) return data.response;
  if (data.content) return data.content;
  if (data.text) return data.text;
  
  // 중첩된 필드들
  if (data.message?.content) return data.message.content;
  if (data.delta?.content) return data.delta.content;
  
  // OpenAI 스타일
  if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
    const choice = data.choices[0];
    if (choice.delta?.content) return choice.delta.content;
    if (choice.message?.content) return choice.message.content;
    if (choice.text) return choice.text;
  }
  
  return '';
}

async function sendChatMessage({ prompt, history = [], stream = true, onChunk, maxMillis = 30000 } = {}) {
  const payload = {
    model: 'Qwen2:0.5B',
    prompt: prompt,
    stream: true,
    max_tokens: 256,
    temperature: 0.7
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), maxMillis);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`API 요청 실패: ${response.status}`);
    }

    const fullResponse = await readStream(response, onChunk);
    
    // 빈 응답인 경우 스트리밍 없이 재시도
    if (!fullResponse) {
      const ollamaPayload = {
        model: 'Qwen2:0.5B',
        prompt: prompt,
        stream: false
      };
      
      const retryResponse = await fetch(API_URL.replace('?hb=1', ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaPayload)
      });
      
      if (retryResponse.ok) {
        const data = await retryResponse.json();
        return { fullResponse: data.response || data.content || '' };
      }
    }
    
    return { fullResponse };
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ping() {
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        model: 'Qwen2:0.5B', 
        prompt: 'hi',
        stream: false
      })
    });

    if (!response.ok && response.status >= 500) {
      throw new Error('서버 오류: ' + response.status);
    }
    
    // Worker 응답이나 다른 형식도 성공으로 처리
    const text = await response.text();
    if (text.includes('worker-op') || text.includes(':') || response.ok) {
      return;
    }
    
    // JSON 파싱 시도
    try {
      JSON.parse(text);
    } catch (e) {
      // JSON이 아니어도 응답이 있으면 성공
    }
  } catch (error) {
    if (!error.message.includes('Failed to fetch') && !error.message.includes('NetworkError')) {
      return;
    }
    throw new Error('서버에 연결할 수 없습니다: ' + error.message);
  }
}

window.client = {
  sendChatMessage,
  ping
};
