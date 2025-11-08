const ACCESS_KEY_STORAGE_KEY = 'singaseong.chat.accessKey';

const ACCESS_KEY = (() => {
  const normalizeValue = (value) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'undefined' || trimmed === 'null') return '';
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) return '';
    if (/^%[A-Z0-9_]+%$/.test(trimmed)) return '';
    return trimmed;
  };

  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && typeof import.meta.env.VITE_ACCESS_KEY === 'string') {
      const normalized = normalizeValue(import.meta.env.VITE_ACCESS_KEY);
      if (normalized) return normalized;
    }
  } catch (error) {
    // ignore environments that do not support import.meta
  }
  if (typeof window !== 'undefined' && typeof window.__ACCESS_KEY__ === 'string') {
    const normalized = normalizeValue(window.__ACCESS_KEY__);
    if (normalized) return normalized;
  }
  if (typeof document !== 'undefined') {
    const fromBody = normalizeValue(document.body?.dataset?.accessCode);
    if (fromBody) return fromBody;

    const metaAccess = document.querySelector('meta[name="access-code"]');
    const fromMeta = normalizeValue(metaAccess?.getAttribute('content'));
    if (fromMeta) return fromMeta;
  }
  return '';
})();

const readStoredAccessKey = () => {
  if (typeof window === 'undefined' || !window.localStorage) return '';
  try {
    return window.localStorage.getItem(ACCESS_KEY_STORAGE_KEY) || '';
  } catch (error) {
    console.warn('Failed to read stored access code:', error);
    return '';
  }
};

const writeStoredAccessKey = (value) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(ACCESS_KEY_STORAGE_KEY, value);
  } catch (error) {
    console.warn('Failed to persist access code:', error);
  }
};

const clearStoredAccessKey = () => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(ACCESS_KEY_STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to clear stored access code:', error);
  }
};

const loginView = document.getElementById('login-view');
const chatView = document.getElementById('chat-view');
const loginForm = document.getElementById('login-form');
const accessInput = document.getElementById('access-code');
const loginStatus = document.getElementById('login-status');
const loginButton = loginForm.querySelector('button[type="submit"]');
const resetButton = document.getElementById('reset-access-code');

const manualAccessAllowed = !ACCESS_KEY;
let effectiveAccessKey = ACCESS_KEY;

if (manualAccessAllowed) {
  const storedKey = readStoredAccessKey();
  if (storedKey) {
    effectiveAccessKey = storedKey;
  }
} else {
  clearStoredAccessKey();
}

let chatModuleLoaded = false;

function setLoginStatus(message, variant) {
  loginStatus.textContent = message;
  loginStatus.classList.remove('error', 'success');
  if (variant) {
    loginStatus.classList.add(variant);
  }
}

function setResetButtonVisible(visible) {
  if (!resetButton) return;
  if (visible) {
    resetButton.classList.remove('hidden');
  } else {
    resetButton.classList.add('hidden');
  }
}

if (manualAccessAllowed) {
  if (effectiveAccessKey) {
    setLoginStatus('저장된 접근 코드가 자동으로 적용되었습니다. 동일한 코드를 입력하면 접속할 수 있습니다.', 'success');
    setResetButtonVisible(true);
  } else {
    setLoginStatus('접근 코드가 구성되지 않았습니다. 받은 코드를 입력하면 이 브라우저에 저장됩니다.', 'error');
    setResetButtonVisible(false);
  }
} else {
  setResetButtonVisible(false);
}

if (resetButton) {
  resetButton.addEventListener('click', () => {
    if (!manualAccessAllowed) return;
    clearStoredAccessKey();
    effectiveAccessKey = '';
    accessInput.disabled = false;
    loginButton.disabled = false;
    accessInput.value = '';
    accessInput.focus();
    setResetButtonVisible(false);
    setLoginStatus('저장된 접근 코드가 초기화되었습니다. 새 코드를 입력하세요.', 'success');
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const entered = accessInput.value.trim();
  if (!entered) {
    setLoginStatus('접근 코드를 입력하세요.', 'error');
    accessInput.focus();
    return;
  }

  const hadEffectiveKey = Boolean(effectiveAccessKey);

  if (manualAccessAllowed && !effectiveAccessKey) {
    effectiveAccessKey = entered;
    writeStoredAccessKey(entered);
    setResetButtonVisible(true);
  }

  if (entered !== effectiveAccessKey) {
    const message = manualAccessAllowed
      ? '저장된 접근 코드와 일치하지 않습니다. 다시 입력하거나 코드 초기화를 누르세요.'
      : '잘못된 접근 코드입니다. 다시 시도하세요.';
    setLoginStatus(message, 'error');
    accessInput.value = '';
    accessInput.focus();
    return;
  }

  const successMessage = manualAccessAllowed && !hadEffectiveKey
    ? '접속 허용되었습니다. 입력하신 접근 코드를 저장했습니다. 챗봇 UI를 불러오는 중...'
    : '접속 허용되었습니다. 챗봇 UI를 불러오는 중...';
  setLoginStatus(successMessage, 'success');
  accessInput.value = '';

  loginButton.disabled = true;
  loginButton.textContent = '로딩 중...';

  try {
    await loadChatInterface();
  } catch (error) {
    console.error('Failed to load chat UI:', error);
    setLoginStatus(`챗봇 UI 로드 실패: ${error.message}`, 'error');
    loginButton.disabled = false;
    loginButton.textContent = '접속하기';
  }
});

async function loadChatInterface() {
  if (chatModuleLoaded) {
    revealChatView();
    return;
  }

  chatModuleLoaded = true;

  try {
    await import('./chat.js');
    initChatUI();
    revealChatView();
  } catch (error) {
    chatModuleLoaded = false;
    throw error;
  }
}

function revealChatView() {
  loginView.classList.add('hidden');
  loginView.setAttribute('aria-hidden', 'true');
  chatView.classList.remove('hidden');
  chatView.setAttribute('aria-hidden', 'false');
}

function initChatUI() {
  const chatBox = document.getElementById('chat-box');
  const promptInput = document.getElementById('prompt');
  const sendBtn = document.getElementById('send-btn');
  const status = document.getElementById('status');
  const modelSelect = document.getElementById('model-select');

  if (!window.client) {
    throw new Error('chat.js가 window.client를 초기화하지 않았습니다.');
  }

  let history = [];
  let isProcessing = false;
  let currentModel = modelSelect.value;

  function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = content;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function showStatus(message, isError = false) {
    status.textContent = message;
    status.className = isError ? 'status-error' : 'status-ok';
    if (!message) return;
    setTimeout(() => {
      status.textContent = '';
      status.className = '';
    }, 3000);
  }

  const extractText = (chunk) => {
    if (!chunk) return '';
    if (typeof chunk === 'string') return chunk;

    if (typeof chunk.response === 'string') return chunk.response;
    if (chunk.message && typeof chunk.message.content === 'string') {
      return chunk.message.content;
    }

    if (Array.isArray(chunk.choices)) {
      const choice = chunk.choices.find((c) => c);
      if (choice) {
        if (typeof choice.delta?.content === 'string') {
          return choice.delta.content;
        }
        if (typeof choice.message?.content === 'string') {
          return choice.message.content;
        }
      }
    }

    if (typeof chunk.delta === 'string') return chunk.delta;
    if (typeof chunk.text === 'string') return chunk.text;

    if (chunk.data) {
      return extractText(chunk.data);
    }

    return '';
  };

  async function sendMessage() {
    const prompt = promptInput.value.trim();
    if (!prompt || isProcessing) return;

    isProcessing = true;
    sendBtn.disabled = true;
    promptInput.disabled = true;

    addMessage('user', prompt);
    promptInput.value = '';

    try {
      const assistantDiv = document.createElement('div');
      assistantDiv.className = 'message assistant';
      chatBox.appendChild(assistantDiv);

      const result = await window.client.sendChatMessage({
        prompt,
        history,
        stream: true,
        model: currentModel,
        onChunk: (chunk) => {
          const text = extractText(chunk);
          if (text) {
            assistantDiv.textContent += text;
            chatBox.scrollTop = chatBox.scrollHeight;
          }
        }
      });

      history.push(
        { role: 'user', content: prompt },
        { role: 'assistant', content: result.fullResponse }
      );

      showStatus(`${currentModel} 응답 완료!`);
    } catch (error) {
      console.error('Error:', error);
      addMessage('assistant', `오류: ${error.message}`);
      showStatus(error.message, true);
    } finally {
      isProcessing = false;
      sendBtn.disabled = false;
      promptInput.disabled = false;
      promptInput.focus();
    }
  }

  modelSelect.addEventListener('change', async (event) => {
    currentModel = event.target.value;
    history = [];
    chatBox.innerHTML = '';
    showStatus(`${currentModel} 모델로 전환 중...`);
    try {
      await window.client.ping(currentModel);
      showStatus(`${currentModel} 모델 사용 가능`);
    } catch (error) {
      showStatus(`${currentModel} 연결 실패: ${error.message}`, true);
    }
  });

  sendBtn.addEventListener('click', sendMessage);
  promptInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  showStatus('연결 확인 중...');
  window.client
    .ping(currentModel)
    .then(() => showStatus(`${currentModel} 모델 연결됨!`))
    .catch((err) => showStatus(`${currentModel} 연결 실패: ${err.message}`, true));
}
