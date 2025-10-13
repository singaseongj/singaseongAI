// ============================================
// Ollama Client
// ============================================

const DEFAULT_API_BASE_URL = 'https://api.singaseong.uk';

function resolveEnvVariable(key) {
  if (typeof window !== 'undefined') {
    if (window.__ENV__ && window.__ENV__[key]) {
      return window.__ENV__[key];
    }
    if (window[key]) {
      return window[key];
    }
  }
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key];
  }
  return undefined;
}

function normalisePath(path) {
  if (!path) return '';
  return String(path).replace(/^\/+/, '');
}

function buildUrl(baseUrl, path) {
  const trimmedBase = baseUrl.replace(/\/$/, '');
  const trimmedPath = normalisePath(path);
  return trimmedPath ? `${trimmedBase}/${trimmedPath}` : trimmedBase;
}

function sanitiseErrorPayload(payload) {
  if (payload === undefined || payload === null) {
    return 'No response body received';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return String(payload);
  }
}

function createSingaseongClient({
  baseUrl = DEFAULT_API_BASE_URL,
  clientId = resolveEnvVariable('CF_ACCESS_CLIENT_ID'),
  clientSecret = resolveEnvVariable('CF_ACCESS_CLIENT_SECRET'),
  defaultModel = 'tinyllama',
} = {}) {
  const hasCredentials = Boolean(clientId && clientSecret);

  async function request(path, { method = 'GET', body, headers = {}, stream = false } = {}) {
    if (!hasCredentials) {
      throw new Error('CF Access credentials are missing. Please configure CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.');
    }

    const url = buildUrl(baseUrl, path);
    const requestHeaders = {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };

    const init = {
      method,
      headers: requestHeaders,
      cache: 'no-store',
    };

    if (body !== undefined && body !== null) {
      const hasFormData = typeof FormData !== 'undefined';
      const hasBlob = typeof Blob !== 'undefined';
      if (
        typeof body === 'string' ||
        (hasFormData && body instanceof FormData) ||
        (hasBlob && body instanceof Blob)
      ) {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        if (!init.headers['Content-Type']) {
          init.headers['Content-Type'] = 'application/json';
        }
      }
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      const rawText = await response.text();
      let payload = rawText;
      
      if (contentType.includes('application/json')) {
        try {
          payload = rawText ? JSON.parse(rawText) : null;
        } catch (_) {
          payload = rawText;
        }
      }
      
      const message = sanitiseErrorPayload(payload);
      throw new Error(`Request to ${url} failed with ${response.status} ${response.statusText}: ${message}`);
    }

    // 스트리밍 응답인 경우 response 객체 반환
    if (stream) {
      return response;
    }

    // 일반 응답 처리
    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    let payload = rawText;

    if (contentType.includes('application/json')) {
      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch (_) {
        payload = rawText;
      }
    }

    return payload;
  }

  async function get(path = '/') {
    return request(path, { method: 'GET' });
  }

  async function post(path, body, { stream = false } = {}) {
    return request(path, { method: 'POST', body, stream });
  }

  async function ping() {
    return get('/');
  }

  // Ollama /api/generate - 단일 응답 생성
  async function generate({ model = defaultModel, prompt, stream = false, options = {}, onChunk = null }) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('A non-empty prompt string is required to generate a response.');
    }

    const payload = {
      model,
      prompt,
      stream,
      ...options,
    };

    const response = await post('/api/generate', payload, { stream });

    // 스트리밍 응답 처리
    if (stream) {
      return handleStreamResponse(response, onChunk);
    }

    return response;
  }

  // Ollama /api/chat - 대화형 채팅 (history 지원)
  async function sendChatMessage({ 
    model = defaultModel, 
    prompt, 
    history = [], 
    stream = false,
    options = {},
    onChunk = null
  }) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('A non-empty prompt string is required to send a chat message.');
    }

    // Ollama chat format: messages array with role and content
    const messages = [
      ...history.map(msg => ({
        role: msg.role || 'user',
        content: msg.content || msg.prompt || msg,
      })),
      {
        role: 'user',
        content: prompt,
      }
    ];

    const payload = {
      model,
      messages,
      stream,
      ...options,
    };

    const response = await post('/api/chat', payload, { stream });

    // 스트리밍 응답 처리
    if (stream) {
      return handleStreamResponse(response, onChunk);
    }

    return response;
  }

  // 스트림 응답 처리 헬퍼 함수
  async function handleStreamResponse(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            
            // Ollama 응답에서 텍스트 추출
            const text = json.response || json.message?.content || '';
            fullResponse += text;

            // 콜백이 제공된 경우 각 청크마다 호출
            if (onChunk && typeof onChunk === 'function') {
              onChunk(json);
            }

            // 스트림 종료 체크
            if (json.done) {
              return {
                ...json,
                fullResponse,
              };
            }
          } catch (e) {
            // JSON 파싱 실패 시 무시 (불완전한 청크일 수 있음)
            console.warn('Failed to parse chunk:', line, e);
          }
        }
      }

      return { fullResponse };
    } finally {
      reader.releaseLock();
    }
  }

  // 사용 가능한 모델 목록 조회
  async function listModels() {
    return get('/api/tags');
  }

  return {
    baseUrl,
    hasCredentials,
    defaultModel,
    get,
    post,
    ping,
    generate,
    sendChatMessage,
    listModels,
  };
}

// ============================================
// Application Code
// ============================================

// 클라이언트 초기화
const client = createSingaseongClient();

// 앱 초기화
async function init() {
  console.log('Initializing app...');
  
  if (!client.hasCredentials) {
    console.error('Missing credentials! Please check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.');
    return;
  }

  console.log('Client initialized:', {
    baseUrl: client.baseUrl,
    hasCredentials: client.hasCredentials,
    defaultModel: client.defaultModel
  });

  // 연결 테스트
  try {
    await client.ping();
    console.log('✓ Connected to API');
  } catch (error) {
    console.error('✗ Connection failed:', error.message);
  }
}

// 사용 예시 함수들
async function testGenerate() {
  try {
    const result = await client.generate({
      prompt: 'Say hello!',
      stream: false
    });
    console.log('Generate result:', result);
  } catch (error) {
    console.error('Generate error:', error);
  }
}

async function testStreamingChat() {
  try {
    const result = await client.sendChatMessage({
      prompt: 'Tell me a short joke',
      stream: true,
      onChunk: (chunk) => {
        // 실시간으로 텍스트 출력
        const text = chunk.response || chunk.message?.content || '';
        if (text) {
          process.stdout?.write?.(text) || console.log(text);
        }
      }
    });
    console.log('\n\nFull response:', result.fullResponse);
  } catch (error) {
    console.error('Streaming error:', error);
  }
}

// 페이지 로드 시 초기화
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', init);
  
  // 전역으로 노출 (콘솔에서 테스트 가능)
  window.client = client;
  window.testGenerate = testGenerate;
  window.testStreamingChat = testStreamingChat;
}
