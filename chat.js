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

export function createSingaseongClient({
  baseUrl = DEFAULT_API_BASE_URL,
  clientId = resolveEnvVariable('CF_ACCESS_CLIENT_ID'),
  clientSecret = resolveEnvVariable('CF_ACCESS_CLIENT_SECRET'),
} = {}) {
  const hasCredentials = Boolean(clientId && clientSecret);

  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    if (!hasCredentials) {
      throw new Error('CF Access credentials are missing. Please ensure CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are available.');
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

    if (!response.ok) {
      const message = sanitiseErrorPayload(payload);
      throw new Error(`Request to ${url} failed with ${response.status} ${response.statusText}: ${message}`);
    }

    return payload;
  }

  async function get(path = '/') {
    return request(path, { method: 'GET' });
  }

  async function post(path, body) {
    return request(path, { method: 'POST', body });
  }

  async function ping() {
    return get('/');
  }

  async function sendChatMessage({ prompt, history = [] }) {
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('A non-empty prompt string is required to send a chat message.');
    }

    const payload = {
      prompt,
      history,
    };

    return post('/chat', payload);
  }

  return {
    baseUrl,
    hasCredentials,
    get,
    post,
    ping,
    sendChatMessage,
  };
}
