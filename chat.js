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

  console.log('Response headers:', Object.fromEntries(response.headers.entries()));

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    
    console.log('Raw chunk received:', chunk.substring(0, 200)); // 처음 200자만 로그
    
    // 줄 단위로 처리
    let lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // Worker 특수 명령 건너뛰기
      if (trimmed.startsWith(':')) {
        console.log('Worker command:', trimmed);
        continue;
      }
      
      // SSE 형식 (data: prefix)
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.substring(5).trim();
        if (dataStr === '[DONE]') continue;
        
        try {
          // JSON 파싱 시도
          const data = JSON.parse(dataStr);
          console.log('Parsed SSE data:', data);
          
          // 텍스트 추출 - 가능한 모든 필드 체크
          const text = extractText(data);
          if (text) {
            fullResponse += text;
            onChunk?.({ response: text, ...data });
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
          console.log('Parsed JSON:', data);
          
          const text = extractText(data);
          if (text) {
            fullResponse += text;
            onChunk?.({ response: text, ...data });
          } else if (data.event && data.event !== 'meta') {
            // 메타 이벤트가 아닌 경우 전체 데이터 전달
            onChunk?.(data);
          }
        } catch (e) {
          console.error('JSON parse error:', e, 'Line:', trimmed.substring(0, 100));
        }
      }
      // 그 외 텍스트는 직접 응답으로 처리
      else {
        console.log('Plain text line:', trimmed.substring(0, 100));
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

  console.log('Final response:', fullResponse || '(empty)');
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
  
  // Ollama 스타일
  if (data.response) return data.response;
  
  return '';
}

async function sendChatMessage({ prompt, history = [], stream = true, onChunk, maxMillis = 30000 } = {}) {
  // 먼저 prompt만 사용해보고, 안 되면 messages 사용
  const payload = {
    model: 'Qwen2:0.5B',
    prompt: prompt,  // 직접 prompt 필드 사용
    stream: true,
    max_tokens: 256,
    temperature: 0.7
  };

  console.log('Sending payload:', JSON.stringify(payload, null, 2));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), maxMillis);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*'  // 모든 형식 허용
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    console.log('Response status:', response.status);
    console.log('Content-Type:', response.headers.get('Content-Type'));

    if (!response.ok) {
      let errorText = '';
      try {
        errorText = await response.text();
      } catch (e) {
        errorText = 'Could not read error response';
      }
      console.error('API Error:', errorText);
      throw new Error(`API 요청 실패: ${response.status}`);
    }

    // 스트리밍 응답 처리
    const fullResponse = await readStream(response, onChunk);
    
    if (!fullResponse) {
      console.warn('빈 응답. Ollama API 형식으로 재시도...');
      
      // Ollama 형식으로 재시도
      const ollamaPayload = {
        model: 'Qwen2:0.5B',
        prompt: prompt,
        stream: false  // 스트리밍 없이 시도
      };
      
      const retryResponse = await fetch(API_URL.replace('?hb=1', ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaPayload)
      });
      
      if (retryResponse.ok) {
        const data = await retryResponse.json();
        console.log('Ollama response:', data);
        return { fullResponse: data.response || data.content || '' };
      }
    }
    
    return { fullResponse };
  } catch (error) {
    console.error('sendChatMessage error:', error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ping() {
  console.log('Pinging server...');
  try {
    // 간단한 GET 요청으로 먼저 시도
    const getResponse = await fetch('https://api.singaseong.uk/api/generate', {
      method: 'GET'
    });
    
    console.log('GET ping status:', getResponse.status);
    
    // POST로 시도
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

    console.log('POST ping status:', response.status);
    
    if (!response.ok) {
      // 에러여도 서버가 응답했으면 연결은 된 것
      if (response.status < 500) {
        console.log('Server responded with client error, but connection works');
        return;
      }
      throw new Error('서버 오류: ' + response.status);
    }
    
    // 응답 본문 읽기 시도
    const text = await response.text();
    console.log('Ping response text:', text.substring(0, 200));
    
    // Worker 응답이면 성공으로 처리
    if (text.includes('worker-op') || text.includes(':')) {
      console.log('Worker response detected, connection successful');
      return;
    }
    
    // JSON 파싱 시도
    try {
      const data = JSON.parse(text);
      console.log('Ping JSON response:', data);
    } catch (e) {
      // JSON이 아니어도 응답이 있으면 성공
      console.log('Non-JSON response, but server is responding');
    }
  } catch (error) {
    console.error('Ping failed:', error);
    // 네트워크 오류가 아니면 연결은 성공한 것으로 간주
    if (!error.message.includes('Failed to fetch') && !error.message.includes('NetworkError')) {
      console.log('Connection seems OK despite error');
      return;
    }
    throw new Error('서버에 연결할 수 없습니다: ' + error.message);
  }
}

// 테스트 함수
async function testAPI() {
  console.log('=== API 테스트 시작 ===');
  
  try {
    // 1. 가장 간단한 형식
    console.log('Test 1: Simple prompt');
    const result1 = await sendChatMessage({
      prompt: "Hello",
      onChunk: (data) => {
        console.log('Chunk received:', data);
      }
    });
    console.log('Result 1:', result1);
    
    if (!result1.fullResponse) {
      console.log('Test 2: Without streaming');
      // 스트리밍 없이 시도
      const response = await fetch(API_URL.replace('?hb=1', ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'Qwen2:0.5B',
          prompt: 'Hello',
          stream: false
        })
      });
      
      const text = await response.text();
      console.log('Non-streaming response:', text);
    }
  } catch (e) {
    console.error('Test failed:', e);
  }
  
  console.log('=== API 테스트 종료 ===');
}

window.client = {
  sendChatMessage,
  ping,
  testAPI
};
