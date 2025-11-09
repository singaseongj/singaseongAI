const fs = require('fs');
const path = require('path');

const GENERIC_KEYWORDS = new Set([
  '정부 관련',
  '비즈니스 관련',
  '정부',
  '비즈니스',
  '정부 이슈',
  '산업 동향',
  '시장 동향',
  '일반 이슈',
  '정책 관련'
]);

const PARTICLE_REGEX = /(은|는|이|가|을|를|과|와|에|에서|으로|으로써|에게|께서|에게서|께|한테|에서의|의|도|만|까지|부터|조차|마저|마다|라며|라고|라는|이라|라|이다|하며|에게는)$/u;
const VERB_ENDING_REGEX = /(했다|했다가|했다고|하며|하면서|하고|하고서|하는|한다|할|하려|되며|되면서|되는|된다|됐다|됐고|됐으며|됐다며|되자|되었다|되어|되어서|되었습니다|되었습니다만|도록|고|했)$/u;

const STOPWORDS = new Set([
  ...GENERIC_KEYWORDS,
  '관련',
  '내용',
  '개요',
  '소식',
  '기사',
  '주가',
  '주식',
  '기업',
  '회사',
  '시장',
  '산업',
  '업계',
  '비즈니스',
  '정부',
  '정책',
  '동향',
  '분석',
  '발표',
  '보고서',
  '업데이트'
]);

const SEPARATOR_REGEX = /[\n,;\u2022\u2023\u25E6\u2043\u2219]/;
const PREFIX_REGEX = /^(?:\s*[\-*•‣⁃◦·]\s*)?(?:키워드|개요)\s*[:：]\s*/iu;
const PUNCT_TRIM_REGEX = /^[\s"'“”‘’`´’‘\-·•‣⁃◦·\[\]\(\)\{\}<>,.!?·:;]+|[\s"'“”‘’`´’‘\-·•‣⁃◦·\[\]\(\)\{\}<>,.!?·:;]+$/gu;
const LETTER_NUMBER_REGEX = /[\p{Letter}\p{Number}]/u;

function sanitizeKeyword(raw) {
  if (typeof raw !== 'string') return '';
  let keyword = raw.trim();
  keyword = keyword.replace(PREFIX_REGEX, '');
  keyword = keyword.replace(/^(?:\s*[\-*•‣⁃◦·]\s*|\d+\.\s*)/u, '');
  keyword = keyword.replace(PUNCT_TRIM_REGEX, '');
  keyword = keyword.replace(/\s{2,}/g, ' ');
  keyword = keyword.trim();
  return keyword;
}

function stripParticles(word) {
  if (!word) return '';
  let cleaned = word.replace(PUNCT_TRIM_REGEX, '');
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(PARTICLE_REGEX, '');
    if (cleaned.length > 2) {
      cleaned = cleaned.replace(VERB_ENDING_REGEX, '');
    }
  } while (cleaned !== previous);
  return cleaned;
}

function isGenericKeyword(keyword) {
  if (!keyword) return true;
  if (GENERIC_KEYWORDS.has(keyword)) return true;
  if (keyword.length <= 2 && !/^[A-Z0-9]{2,}$/i.test(keyword)) return true;
  if (!LETTER_NUMBER_REGEX.test(keyword)) return true;
  if (/관련$/u.test(keyword) && keyword.length <= 4) return true;
  return false;
}

function dedupePreserveOrder(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function tokenizeSummary(summary) {
  if (typeof summary !== 'string') return [];
  return summary
    .split(/\s+/u)
    .map(token => token.replace(/^[^\p{Letter}\p{Number}]+|[^\p{Letter}\p{Number}]+$/gu, ''))
    .map(stripParticles)
    .map(token => token.trim())
    .filter(token => token.length > 1 && LETTER_NUMBER_REGEX.test(token));
}

function isCoveredByExisting(keyword, existingKeywords) {
  if (!keyword) return true;
  const normalized = keyword.replace(/\s+/g, '').toLowerCase();
  if (!normalized) return true;
  return existingKeywords.some(existing => {
    const normalizedExisting = existing.replace(/\s+/g, '').toLowerCase();
    if (!normalizedExisting) return false;
    return (
      normalizedExisting.length >= normalized.length &&
      normalizedExisting.includes(normalized)
    );
  });
}

function refineGenericKeyword(keyword, summary) {
  if (!summary) return '';
  const base = keyword.replace(/\s*관련$/u, '').trim();
  if (!base) return '';

  const tokens = summary
    .split(/\s+/u)
    .map(part => stripParticles(part))
    .map(part => part.replace(/관련$/u, '').trim())
    .filter(Boolean);

  const candidates = [];
  for (let idx = 0; idx < tokens.length; idx++) {
    const token = tokens[idx];
    if (!token.includes(base)) continue;

    const normalizedBase = token.includes(base) ? token : base;
    const phraseTokens = [normalizedBase];

    let forward = idx + 1;
    while (forward < tokens.length && phraseTokens.length < 3) {
      const next = tokens[forward];
      if (!next || STOPWORDS.has(next) || isGenericKeyword(next)) {
        forward++;
        continue;
      }
      phraseTokens.push(next);
      forward++;
    }

    if (phraseTokens.length === 1) {
      let backward = idx - 1;
      while (backward >= 0 && phraseTokens.length < 3) {
        const prev = tokens[backward];
        if (!prev || STOPWORDS.has(prev) || isGenericKeyword(prev)) {
          backward--;
          continue;
        }
        phraseTokens.unshift(prev);
        backward--;
      }
    }

    const candidate = sanitizeKeyword(phraseTokens.join(' '));
    if (!candidate || candidate.length <= base.length) continue;
    if (isGenericKeyword(candidate)) continue;
    candidates.push(candidate);
  }

  const ordered = dedupePreserveOrder(
    candidates.sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return a.localeCompare(b, 'ko');
    })
  );

  return ordered[0] || '';
}

function extractKeywordsFromSummary(summary, existingKeywords = [], limit = 5) {
  if (!summary) return [];
  const counts = new Map();
  const normalizedExisting = new Set(existingKeywords.map(keyword => keyword.replace(/\s+/g, '').toLowerCase()));

  for (const token of tokenizeSummary(summary)) {
    const normalized = token.replace(/\s+/g, '').toLowerCase();
    if (normalizedExisting.has(normalized)) continue;
    if (isCoveredByExisting(token, existingKeywords)) continue;
    if (STOPWORDS.has(token)) continue;
    if (token.length <= 1) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })
    .map(([token]) => token)
    .filter(keyword => !isGenericKeyword(keyword))
    .slice(0, limit);
}

function parseKeywords(rawKeywords, options = {}) {
  const { summary = '', max = 6 } = options;
  const rawList = Array.isArray(rawKeywords) ? rawKeywords : [rawKeywords];

  const parsed = [];
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue;
    const parts = raw
      .split(SEPARATOR_REGEX)
      .map(part => sanitizeKeyword(part))
      .filter(Boolean);

    for (const keyword of parts) {
      if (!keyword) continue;
      if (isGenericKeyword(keyword)) {
        const refined = refineGenericKeyword(keyword, summary);
        if (refined) {
          parsed.push(refined);
        }
        continue;
      }
      parsed.push(keyword);
    }
  }

  let keywords = dedupePreserveOrder(parsed);

  if (summary && keywords.length < max) {
    const additional = extractKeywordsFromSummary(summary, keywords, max - keywords.length);
    keywords = dedupePreserveOrder([...keywords, ...additional]);
  }

  return keywords.slice(0, max);
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const summary = item.summary || item.overview || item.description || '';
  const rawKeywords =
    item.keywords || item.keyword || item.tags || item.tagline || item.keyphrases || [];

  const keywords = parseKeywords(rawKeywords, { summary });
  return { ...item, keywords };
}

function loadJson(filePath) {
  const absolutePath = path.resolve(filePath);
  const data = fs.readFileSync(absolutePath, 'utf8');
  return JSON.parse(data);
}

function writeJson(filePath, value) {
  const absolutePath = path.resolve(filePath);
  const json = JSON.stringify(value, null, 2);
  fs.writeFileSync(absolutePath, json, 'utf8');
}

function processFile(inputPath, outputPath) {
  const data = loadJson(inputPath);
  if (Array.isArray(data)) {
    const mapped = data.map(item => normalizeItem(item) || item);
    writeJson(outputPath, mapped);
    return;
  }

  if (data && typeof data === 'object') {
    const normalized = normalizeItem(data) || data;
    writeJson(outputPath, normalized);
    return;
  }

  throw new Error('지원하지 않는 입력 형식입니다. JSON 객체 또는 배열을 제공하세요.');
}

if (require.main === module) {
  const [, , inputPath, outputPath] = process.argv;

  if (!inputPath || !outputPath) {
    console.error('Usage: node stockKeywords.cjs <input-json> <output-json>');
    process.exit(1);
  }

  try {
    processFile(inputPath, outputPath);
    console.log(`키워드가 처리되어 ${outputPath} 파일에 저장되었습니다.`);
  } catch (error) {
    console.error('키워드 처리 중 오류가 발생했습니다:', error.message);
    process.exit(1);
  }
}

module.exports = {
  sanitizeKeyword,
  parseKeywords,
  refineGenericKeyword,
  extractKeywordsFromSummary,
  processFile,
  normalizeItem
};
