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

  // 디버깅을 위한 로그
  console.log('Response headers:', Object.fromEntries(response.headers.entries()));

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    
    // 디버깅: 원시 데이터 출력
    console.log('Raw chunk:', chunk);
    
    // 줄 단위로 처리 (NDJSON)
    let lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 마지막 불완전한 줄은 버퍼에 유지
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      // SSE 형식 처리
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.substring(5).trim();
        if (dataStr === '[DONE]') continue;
        
        try {
          const data = JSON.parse(dataStr);
          console.log('Parsed SSE data:', data);
          
          // 다양한 응답 형식 처리
          const text = data.response || 
                      data.content || 
                      data.message?.content || 
                      data.text ||
                      data.delta?.content ||
                      data.choices?.[0]?.delta?.content ||
                      data.choices?.[0]?.message?.content ||
                      '';
                      
          if (text) {
            fullResponse += text;
            onChunk?.({ response: text, ...data });
          }
        } catch (e) {
          console.error('SSE 파싱 에러:', e, 'Line:', dataStr);
        }
      } 
      // 일반 JSON 형식 처리
      else {
        try {
          const data = JSON.parse(trimmed);
          console.log('Parsed JSON data:', data);
          
          // 다양한 응답 형식 처리
          const text = data.response || 
                      data.content || 
                      data.message?.content || 
                      data.text ||
                      data.delta?.content ||
                      data.choices?.[0]?.delta?.content ||
                      data.choices?.[0]?.message?.content ||
                      '';
                      
          if (text) {
            fullResponse += text;
            onChunk?.({ response: text, ...data });
          } else if (data.event !== 'meta') {
            // meta 이벤트가 아닌데 텍스트가 없으면 전체 데이터 전달
            onChunk?.(data);
          }
        } catch (e) {
          // JSON이 아닌 경우 무시
          console.log('Non-JSON line:', trimmed);
        }
      }
    }
  }
  
  // 남은 버퍼 처리
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer.trim());
      const text = data.response || data.content || data.message?.content || '';
      if (text) {
        fullResponse += text;
      }
    } catch (e) {
      // 무시
    }
  }

  console.log('Final response:', fullResponse);
  return fullResponse;
}

async function sendChatMessage({ prompt, history = [], stream = true, onChunk, maxMillis = 30000 } = {}) {
  // 다양한 페이로드 형식 시도
  const payload = {
    model: 'Qwen2:0.5B',
    messages: buildMessages(history, prompt),
    stream: true,
    max_tokens: 256,
    temperature: 0.7  // 온도를 약간 올려서 더 다양한 응답 유도
  };

  console.log('Sending payload:', payload);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), maxMillis);

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/x-ndjson, application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    console.log('Response status:', response.status);
    console.log('Response Content-Type:', response.headers.get('Content-Type'));

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error Response:', errorText);
      throw new Error(`API 요청 실패: ${response.status} - ${errorText}`);
    }

    const fullResponse = await readStream(response, onChunk);
    
    if (!fullResponse) {
      console.warn('응답이 비어있습니다. API 형식을 확인해주세요.');
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
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        model: 'Qwen2:0.5B', 
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 10
      })
    });

    console.log('Ping response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Ping error:', errorText);
      throw new Error('서버 상태 확인 실패: ' + errorText);
    }
    
    const data = await response.json();
    console.log('Ping response:', data);
  } catch (error) {
    console.error('Ping failed:', error);
    throw new Error(error.message || '서버에 연결할 수 없습니다.');
  }
}

// 테스트 함수 추가
async function testAPI() {
  console.log('=== API 테스트 시작 ===');
  
  // 1. 간단한 테스트
  try {
    const result = await sendChatMessage({
      prompt: "Say hello",
      onChunk: (data) => {
        console.log('Test chunk received:', data);
      }
    });
    console.log('Test result:', result);
  } catch (e) {
    console.error('Test failed:', e);
  }
  
  console.log('=== API 테스트 종료 ===');
}

window.client = {
  sendChatMessage,
  ping,
  testAPI  // 테스트 함수 추가
};
