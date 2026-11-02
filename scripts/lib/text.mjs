// Text normalization, CJK-aware counting, tokenization, sentences, shingles and MinHash.

export const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RE_G = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'\u2019_-]*/gu;
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;

/** NFKC, lower-case, punctuation to spaces, collapsed whitespace. */
export function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** normalizeText without any spaces: robust key for CJK queries typed with/without spaces. */
export function compactKey(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

export function textStats(text) {
  const s = String(text || '');
  const cjkChars = (s.match(CJK_RE_G) || []).length;
  const latinWords = (s.replace(CJK_RE_G, ' ').match(LATIN_WORD_RE) || []).length;
  return {
    cjkChars,
    latinWords,
    // ~1.6 CJK characters per English word, so lengths are comparable across languages.
    wordEq: latinWords + Math.round(cjkChars / 1.6),
    chars: s.replace(/\s+/g, '').length,
  };
}

export function cjkRatio(text) {
  const s = String(text || '').replace(/\s+/g, '');
  if (!s.length) return 0;
  return (s.match(CJK_RE_G) || []).length / s.length;
}

/** Display width: full-width characters count 2, everything else 1. */
export function displayWidth(text) {
  let w = 0;
  for (const ch of String(text || '')) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}

export function truncate(text, max = 80) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

// ---------- stopwords ----------
const LATIN_STOPWORDS = new Set(
  (
    'a an and are as at be by can do does for from has have how i if in into is it its me my of on or our so ' +
    'than that the their them then there these they this to too us was we were what when where which who why will with you your ' +
    'el la los las un una unos unas de del y o en por para con que es se su sus al lo ' +
    'le les des du et ou au aux en dans pour par sur avec est une ce cette ' +
    'der die das ein eine und oder zu im mit von fur ist den dem des ' +
    'o a os as um uma de do da dos das e em no na com por para que ' +
    'il lo gli i un una di da in con per su che e'
  ).split(/\s+/),
);
const CJK_STOP_TOKENS = new Set(
  ('的 了 是 嗎 吗 呢 吧 啊 和 與 与 或 在 有 我 你 他 她 它 們 们 這 这 那 也 都 就 很 會 会 要 嗎 ' +
    'の は が を に と で も や か な へ から まで より とは ' +
    '은 는 이 가 을 를 에 의 와 과 도 로 으로').split(/\s+/),
);

export function isStopword(token) {
  return LATIN_STOPWORDS.has(token) || CJK_STOP_TOKENS.has(token);
}

// ---------- tokenization ----------
/** Split text into latin words and CJK runs (runs are kept whole; segment later with a vocabulary). */
export function rawTokens(text) {
  const norm = normalizeText(text);
  const tokens = [];
  let last = 0;
  for (const m of norm.matchAll(CJK_RUN_RE)) {
    tokens.push(...latinWords(norm.slice(last, m.index)));
    tokens.push({ cjk: true, text: m[0] });
    last = m.index + m[0].length;
  }
  tokens.push(...latinWords(norm.slice(last)));
  return tokens;
}

function latinWords(segment) {
  return (segment.match(LATIN_WORD_RE) || []).map((w) => ({ cjk: false, text: w }));
}

export function stemLatin(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('is')) return word.slice(0, -1);
  return word;
}

/**
 * Build a CJK vocabulary from a corpus of strings (no dictionary needed):
 * 1. substrings (2..maxLen chars) of CJK runs occurring in >= minDf documents;
 * 2. drop grams that only ever appear inside a one-char-longer gram (same frequency);
 * 3. replace phrases that can be fully segmented into other frequent grams by those pieces.
 */
export function buildCjkVocabulary(texts, { minDf = 2, maxLen = 6 } = {}) {
  const df = new Map();
  for (const text of texts) {
    const seen = new Set();
    for (const tok of rawTokens(text)) {
      if (!tok.cjk) continue;
      const run = tok.text;
      for (let i = 0; i < run.length; i++) {
        for (let len = 2; len <= maxLen && i + len <= run.length; len++) seen.add(run.slice(i, i + len));
      }
    }
    for (const g of seen) df.set(g, (df.get(g) || 0) + 1);
  }
  const frequent = new Map();
  for (const [gram, count] of df) if (count >= minDf) frequent.set(gram, count);
  const vocab = new Map(frequent);
  const explained = new Set();
  for (const [gram, count] of frequent) {
    if (gram.length < 3) continue;
    for (const sub of [gram.slice(1), gram.slice(0, -1)]) if (frequent.get(sub) === count) explained.add(sub);
  }
  for (const gram of explained) vocab.delete(gram);
  const byLength = [...vocab.keys()].sort((a, b) => b.length - a.length);
  for (const gram of byLength) {
    if (gram.length < 4 || !vocab.has(gram)) continue;
    const pieces = bestSegmentation(gram, frequent, vocab);
    // only a phrase if at least one piece also lives outside it (otherwise it is one word, e.g. katakana)
    if (pieces && pieces.some((piece) => frequent.get(piece) > frequent.get(gram))) {
      vocab.delete(gram);
      for (const piece of pieces) if (!vocab.has(piece)) vocab.set(piece, frequent.get(piece));
    }
  }
  return vocab;
}

/** Split `text` into >= 2 frequent grams (each >= 2 chars), preferring few pieces that are already words. */
function bestSegmentation(text, frequent, vocab) {
  const n = text.length;
  const best = new Array(n + 1).fill(null);
  best[0] = { cost: 0, pieces: [] };
  for (let i = 0; i < n; i++) {
    if (!best[i]) continue;
    for (let len = 2; i + len <= n; len++) {
      const piece = text.slice(i, i + len);
      if (piece === text || !frequent.has(piece)) continue;
      const cost = best[i].cost + 10 + (vocab.has(piece) ? 0 : 1);
      if (!best[i + len] || cost < best[i + len].cost) best[i + len] = { cost, pieces: [...best[i].pieces, piece] };
    }
  }
  return best[n] && best[n].pieces.length >= 2 ? best[n].pieces : null;
}

/** Map a CJK word to a shorter, at-least-as-frequent vocabulary word (e.g. a word + suffix char). */
function canonicalCjk(token, vocab) {
  let current = token;
  for (let step = 0; step < 2 && current.length >= 3; step++) {
    const own = vocab.get(current) || 0;
    const prefix = current.slice(0, -1);
    const suffix = current.slice(1);
    if (vocab.has(prefix) && vocab.get(prefix) >= own) current = prefix;
    else if (vocab.has(suffix) && vocab.get(suffix) >= own) current = suffix;
    else break;
  }
  return current;
}

/**
 * Forward maximum matching of a CJK run against a vocabulary. Unknown stretches of >= 2 chars are
 * kept as tokens; isolated unknown single chars are dropped.
 */
export function segmentCjk(run, vocab, maxLen = 6) {
  const out = [];
  let unknown = '';
  const flush = () => {
    if (unknown.length >= 2) out.push(unknown);
    unknown = '';
  };
  let i = 0;
  while (i < run.length) {
    let matched = '';
    if (vocab) {
      for (let len = Math.min(maxLen, run.length - i); len >= 2; len--) {
        const cand = run.slice(i, i + len);
        if (vocab.has(cand)) {
          matched = cand;
          break;
        }
      }
    }
    if (matched) {
      flush();
      out.push(canonicalCjk(matched, vocab));
      i += matched.length;
    } else {
      unknown += run[i];
      i += 1;
    }
  }
  flush();
  if (!out.length && run.length) out.push(run);
  return out;
}

/** Topic tokens for a string: stemmed latin words + vocabulary-segmented CJK, minus stopwords. */
export function topicTokens(text, { vocab, exclude } = {}) {
  const tokens = [];
  for (const tok of rawTokens(text)) {
    if (tok.cjk) tokens.push(...segmentCjk(tok.text, vocab));
    else if (!/^(19|20)\d{2}$/.test(tok.text)) tokens.push(stemLatin(tok.text));
  }
  return [...new Set(tokens.filter((t) => t && !isStopword(t) && !(exclude && exclude.has(t))))];
}

// ---------- sentences ----------
export function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?\n\r]+|(?<=[.;])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ---------- shingles + MinHash ----------
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Hashed w-token shingles where CJK characters and latin words are both single tokens. */
export function shingleSet(text, w = 4) {
  const units = [];
  for (const tok of rawTokens(text)) {
    if (tok.cjk) units.push(...tok.text);
    else units.push(tok.text);
  }
  const set = new Set();
  if (units.length < w) {
    if (units.length) set.add(fnv1a(units.join(' ')));
    return set;
  }
  for (let i = 0; i + w <= units.length; i++) set.add(fnv1a(units.slice(i, i + w).join(' ')));
  return set;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function mix(x, seed) {
  let h = Math.imul(x ^ seed, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function minhashSignature(set, numHashes = 60) {
  const sig = new Uint32Array(numHashes).fill(0xffffffff);
  for (const x of set) {
    for (let i = 0; i < numHashes; i++) {
      const v = mix(x, 0x5bd1e995 + i * 0x27d4eb2d);
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}

/** Candidate pairs [i, j] whose signatures collide in at least one LSH band. */
export function lshCandidatePairs(signatures, { bands = 20, rows = 3 } = {}) {
  const pairs = new Set();
  for (let b = 0; b < bands; b++) {
    const buckets = new Map();
    signatures.forEach((sig, idx) => {
      if (!sig) return;
      const key = Array.from(sig.slice(b * rows, b * rows + rows)).join(',');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(idx);
    });
    for (const members of buckets.values()) {
      if (members.length < 2 || members.length > 200) continue; // giant buckets = shared boilerplate
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.add(`${members[i]}:${members[j]}`);
    }
  }
  return [...pairs].map((p) => p.split(':').map(Number));
}
