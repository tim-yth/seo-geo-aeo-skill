#!/usr/bin/env node
// Mechanical content audit: template ratio, near-duplicates, stuffing, answer-first intro, GEO blocks,
// headings, outdated years, placeholders, internal links. Grades pages and joins GSC metrics.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeJson, writeText, globFiles, normalizeUrl, sameSite, mapLimit, rateLimiter, scriptCmd, staticBase, urlFromTemplate } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { parseHtml } from './lib/html.mjs';
import { parseMarkdown } from './lib/markdown.mjs';
import { fetchPage } from './lib/http.mjs';
import { loadGscFile } from './lib/gsc.mjs';
import { readCsvFile, writeCsvFile } from './lib/csv.mjs';
import { normalizeText, compactKey, splitSentences, displayWidth, shingleSet, minhashSignature, lshCandidatePairs, jaccard, textStats, topicTokens, buildCjkVocabulary, CJK_RE } from './lib/text.mjs';
import { groupMetrics } from './lib/metrics.mjs';
import { loadWaves, isOpen } from './lib/experiments.mjs';
import { fmtInt, fmtPct, fmtPos, mdTable, shortUrl } from './lib/format.mjs';

export const INVENTORY_COLUMNS = ['url', 'slug', 'title', 'page_type', 'intent_key', 'grade', 'x_flags', 'action', 'target_url', 'cluster_id', 'wave', 'imp_28d', 'clk_28d', 'ctr_28d', 'pos_28d', 'index_status', 'http_status', 'template_ratio', 'audited_at', 'notes', 'review_grade', 'review_x', 'review_action', 'review_target', 'value_tier', 'protected'];
/** Columns this script owns and refreshes on every run (mechanical results and metrics). */
export const INVENTORY_MACHINE_COLUMNS = ['title', 'grade', 'x_flags', 'imp_28d', 'clk_28d', 'ctr_28d', 'pos_28d', 'index_status', 'http_status', 'template_ratio', 'audited_at', 'file', 'word_eq', 'score', 'flags'];
/** Manual columns: seeded only while empty, never overwritten. Any column a user adds is never touched either. */
export const INVENTORY_MANUAL_COLUMNS = ['slug', 'page_type', 'intent_key', 'action', 'target_url', 'cluster_id', 'wave', 'notes', 'review_grade', 'review_x', 'review_action', 'review_target', 'value_tier', 'protected'];
const PLACEHOLDER = '\u25C6'; // survives NFKC + lower-casing

const SPEC = {
  ...COMMON_FLAGS,
  glob: { type: 'list', placeholder: 'pattern', desc: 'Content files (md/markdown/mdx/html/htm); default: config repo.contentGlobs under repo.path' },
  root: { type: 'string', placeholder: 'dir', desc: 'Base directory for --glob (default: current directory)' },
  'from-crawl': { type: 'string', placeholder: 'file', desc: 'Page-text JSONL from crawl-site.mjs (default when no globs: newest data/crawl/*-text.jsonl)' },
  'url-template': { type: 'string', placeholder: 'tpl', desc: 'Map files to URLs, e.g. https://example.com/blog/{slug}/ ({slug}, {path}); default config repo.urlTemplate' },
  'gsc-pages': { type: 'string', placeholder: 'file', desc: 'GSC export with a page dimension (JSON/CSV) to join impressions and prioritize' },
  'keyword-map': { type: 'string', placeholder: 'file', desc: 'keyword-map.csv for target terms (default: workspace keyword-map.csv)' },
  'template-min-docs': { type: 'int', desc: 'A sentence is "template" if it appears in >= N pages (default max(3, 2% of pages))' },
  'min-sentence-units': { type: 'int', desc: 'Ignore sentences narrower than this display width (CJK char = 2)', default: 28 },
  'dup-threshold': { type: 'number', desc: 'Near-duplicate Jaccard threshold on 4-token shingles', default: 0.5 },
  'max-density': { type: 'number', desc: 'Keyword density above this share is stuffing', default: 0.03 },
  'min-words': { type: 'int', desc: 'Thin-content threshold in word-equivalents', default: 300 },
  'stale-days': { type: 'int', desc: 'Flag pages whose modified date is older than this', default: 365 },
  'check-links': { type: 'boolean', desc: 'Fetch internal link targets not seen in the corpus/crawl (polite, slow)' },
  'no-inventory': { type: 'boolean', desc: 'Do not update content-inventory.csv' },
  top: { type: 'int', desc: 'Rows per Markdown section', default: 30 },
  json: { type: 'boolean', desc: 'Print the result JSON to stdout' },
};

const HELP = formatHelp({
  usage: ['node scripts/content-audit.mjs [--glob "content/**/*.md"] [--gsc-pages data/gsc/<file>.json]', 'node scripts/content-audit.mjs --from-crawl data/crawl/<date>-crawl-text.jsonl'],
  summary:
    'Mechanical audit of content files (Markdown/HTML) or crawled pages. Per page: length (CJK aware), template ratio (share of sentences ' +
    'that also appear in many other pages, after replacing the page title with a placeholder), near-duplicates (shingle Jaccard via MinHash), ' +
    'keyword stuffing (targets from keyword-map.csv / front matter), answer-first intro, TL;DR / answer capsules / FAQ (GEO), heading ' +
    'structure, outdated years and stale dates, leftover placeholders (X = must fix), internal links. Grades A-D, joins GSC metrics so review ' +
    'is ordered by impressions, writes data/content/ and updates content-inventory.csv (manual columns are never overwritten).',
  spec: SPEC,
  examples: [
    'node scripts/content-audit.mjs --glob "content/blog/**/*.md" --url-template "https://www.example.com/blog/{slug}/" --gsc-pages .seo-agent/data/gsc/2026-11-01-page-28d.json',
    'node scripts/content-audit.mjs   (uses repo.contentGlobs, or the newest crawl text)',
  ],
  notes: [
    'Scores rank what to read first; they do not replace reading. Grades: A keep, B small fixes, C rewrite, D merge/redirect, X must fix now.',
    'Template ratio is the strongest signal of programmatic/AI boilerplate: >= 0.5 means half of the page is shared with many other pages.',
    'content-inventory.csv: machine columns are refreshed every run (title, grade, x_flags, 28-day metrics, index/HTTP status, template_ratio, audited_at); manual columns (slug, page_type, intent_key, action, target_url, cluster_id, wave, notes, review_grade, review_x, review_action, review_target, value_tier, protected) are only seeded while empty, and columns you add are never touched. Record human review verdicts in the review_* columns, not in grade/x_flags.',
  ],
});

// ---------- document loading ----------
export function docFromFile(file, { url, origin }) {
  const src = fs.readFileSync(file, 'utf8');
  if (/\.html?$/i.test(file)) {
    const p = parseHtml(src, url || origin || 'https://example.invalid/');
    return {
      file,
      url: (p.canonical && /^https?:/i.test(p.canonical) ? normalizeUrl(p.canonical) : '') || url || '',
      title: p.title,
      description: p.metaDescription,
      h1: p.h1,
      headings: p.contentHeadings.map((h) => ({ level: h.level, text: h.text })),
      paragraphs: p.contentParagraphs.length ? p.contentParagraphs : p.text.split('\n').filter(Boolean),
      links: p.links.filter((l) => l.url && !l.fragmentOnly && !l.boiler).map((l) => ({ url: normalizeUrl(l.url) || l.url, text: l.text })),
      blocks: p.contentBlocks,
      dates: p.dates,
      jsonldTypes: p.jsonLdTypes,
      faqQuestions: p.faqQuestions,
      tables: p.counts.tables,
      keywords: [],
      kind: 'html',
    };
  }
  const m = parseMarkdown(src);
  const fm = m.frontMatter;
  const fmUrl = fm.url || fm.permalink || fm.canonical || '';
  let fmAbs = '';
  if (fmUrl) {
    try {
      fmAbs = new URL(fmUrl, origin || (url ? new URL(url).origin : undefined)).href;
    } catch {
      fmAbs = /^https?:/i.test(fmUrl) ? fmUrl : '';
    }
  }
  const resolved = fmAbs || url || '';
  const base = resolved || origin || 'https://example.invalid/';
  return {
    file,
    url: resolved ? normalizeUrl(resolved) || resolved : '',
    title: m.title,
    description: m.description,
    h1: m.headings.filter((h) => h.level === 1).map((h) => h.text).concat(m.headings.some((h) => h.level === 1) ? [] : m.title ? [m.title] : []),
    headings: m.headings,
    paragraphs: m.paragraphs,
    links: m.links.filter((l) => l.href && !l.href.startsWith('#') && !/^(mailto|tel):/i.test(l.href)).map((l) => {
      let u = l.href;
      try {
        u = normalizeUrl(new URL(l.href, base).href) || l.href;
      } catch {
        /* keep */
      }
      return { url: u, text: l.text };
    }),
    blocks: m.blocks,
    dates: m.dates,
    jsonldTypes: [],
    faqQuestions: [],
    tables: m.counts.tables,
    keywords: [].concat(fm.keyword || [], fm.keywords || [], fm.focus_keyword || []).flatMap((k) => String(k).split(',')).map((k) => k.trim()).filter(Boolean),
    kind: 'markdown',
    markdownH1: m.headings.some((h) => h.level === 1),
  };
}

export function docFromCrawl(line) {
  return {
    file: '',
    url: normalizeUrl(line.finalUrl || line.url) || line.url,
    title: line.title || '',
    description: line.description || '',
    h1: line.h1 || [],
    headings: line.headings || [],
    paragraphs: line.paragraphs && line.paragraphs.length ? line.paragraphs : String(line.text || '').split('\n').filter(Boolean),
    links: (line.links || []).map((l) => ({ url: l.url, text: l.text })),
    blocks: line.blocks || [],
    dates: { published: line.datePublished || '', modified: line.dateModified || '' },
    jsonldTypes: line.jsonldTypes || [],
    faqQuestions: [],
    faqCount: line.faqQuestions || 0,
    tables: line.tables || 0,
    keywords: [],
    kind: 'crawl',
    status: line.status,
    noindex: line.noindex,
  };
}

// ---------- analyses ----------
const normSentence = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function bodyFor(doc, extraTerms = []) {
  let text = [...doc.headings.map((h) => h.text), ...doc.paragraphs].join('\n');
  const terms = [doc.title && doc.title.split(/\s[|｜\-–—]\s/)[0], ...doc.h1, ...extraTerms].filter((t) => t && t.trim().length >= 2).sort((a, b) => b.length - a.length);
  for (const t of terms) text = text.replace(new RegExp(t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), PLACEHOLDER);
  return text;
}

/** Port of the proven template-ratio logic: sentences shared by >= minDocs pages. */
export function templateAnalysis(docs, { minDocs, minUnits = 28, termsFor = () => [] } = {}) {
  const n = docs.length;
  const threshold = minDocs || Math.max(3, Math.round(n * 0.02));
  const perDoc = docs.map((d) => splitSentences(bodyFor(d, termsFor(d))).filter((s) => displayWidth(s) >= minUnits).map(normSentence));
  const df = new Map();
  for (const sents of perDoc) for (const s of new Set(sents)) df.set(s, (df.get(s) || 0) + 1);
  const template = new Set([...df].filter(([, c]) => c >= threshold).map(([s]) => s));
  const ratios = perDoc.map((sents) => {
    const total = sents.reduce((a, s) => a + s.length, 0);
    if (!total) return 0;
    return sents.filter((s) => template.has(s)).reduce((a, s) => a + s.length, 0) / total;
  });
  const top = [...df].filter(([s]) => template.has(s)).sort((a, b) => b[1] - a[1]).map(([sentence, docsCount]) => ({ sentence, docs: docsCount }));
  return { threshold, ratios, top };
}

export function nearDuplicates(docs, { threshold = 0.5 } = {}) {
  const sets = docs.map((d) => {
    const text = d.paragraphs.join('\n');
    return textStats(text).wordEq >= 40 ? shingleSet(text, 4) : null;
  });
  const sigs = sets.map((s) => (s && s.size ? minhashSignature(s, 60) : null));
  const pairs = [];
  for (const [i, j] of lshCandidatePairs(sigs, { bands: 20, rows: 3 })) {
    const sim = jaccard(sets[i], sets[j]);
    if (sim >= threshold) pairs.push({ a: i, b: j, similarity: sim });
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function keywordDensity(doc, term) {
  const text = [doc.title, ...doc.headings.map((h) => h.text), ...doc.paragraphs].join(' ');
  if (CJK_RE.test(term)) {
    const hay = compactKey(text);
    const needle = compactKey(term);
    const count = countOccurrences(hay, needle);
    return { term, count, density: hay.length ? (count * needle.length) / hay.length : 0 };
  }
  const hay = ` ${normalizeText(text)} `;
  const needle = ` ${normalizeText(term)} `;
  const count = countOccurrences(hay, needle);
  const words = hay.trim().split(' ').length;
  return { term, count, density: words ? (count * needle.trim().split(' ').length) / words : 0 };
}

const GENERIC_OPENER = /^(in this (article|post|guide|blog)|this (article|post|guide) (will|explains|covers)|have you ever|are you (wondering|looking|searching)|welcome to|today,? we|let'?s (talk|dive|explore)|in today'?s (world|fast)|when it comes to|本文將|本文将|這篇文章|这篇文章|在這篇文章|在这篇文章|本篇|你是否曾|你是否也|你有沒有|你有没有|相信很多人|相信大家|大家好|今天要|今天我們|今天我们|讓我們|让我们|在現代社會|在现代社会|隨著|随着|眾所周知|众所周知)/i;
const META_TALK = /(本文將|本文将|這篇文章將|这篇文章将|以下將|以下将|in this article|this article will|this post will|we will (cover|explore|discuss))/i;
const TLDR = /^(tl;?dr|summary|key takeaways|in short|at a glance|quick answer|short answer|重點|重点|摘要|重點整理|重点整理|懶人包|懒人包|總結|总结|一句話|一句话|快速回答|簡答|简答|要点|まとめ|요약)/i;
const FAQ_HEADING = /(faq|frequently asked|common questions|常見問題|常见问题|q\s*&\s*a|問與答|问与答|よくある質問|자주 묻는)/i;
const QUESTION = /[?？]\s*$|^(how|what|why|when|which|who|can|does|is|are|should|如何|怎麼|怎么|什麼|什么|為什麼|为什么|哪|是否|能不能|可以)/i;
const PLACEHOLDER_RE = /\{\{?\s*[\w.-]+\s*\}?\}|\[(?:TODO|TBD|INSERT[^\]]*|PLACEHOLDER)\]|\bTODO\b|\bTBD\b|\blorem ipsum\b|\bundefined\b|\bNaN\b|\[object Object\]|待補|待补|待填|佔位|占位/;
const AI_RESIDUE = /(as an ai language model|as an ai,? i|i cannot browse|作為一個?\s*AI|作为一个?\s*AI|我是一個人工智慧|身為AI語言模型|as of my (last )?knowledge (update|cutoff))/i;
const RECENCY = /(latest|newest|this year|current|up[- ]to[- ]date|最新|今年|本年度|最新版|最新的)/i;
const EXPERT_CLAIM = /(my (clients?|patients?|students?|cases?)|in my \d+ years|\d+\+? years of (experience|practice)|我的(個案|个案|客戶|客户|學生|学生|案主)|(\d+|十|二十|三十)\s*年(的)?(經驗|经验|資歷|资历))/i;
const WIKI_CODE = /\[\[[^\]]{1,80}\]\]/;
// High-frequency characters that exist only in Simplified (left) or only in Traditional (right) Chinese.
const SIMPLIFIED_ONLY = '们这为说时国会对发开关门问间现东车长马书买卖爱体学写区医乐听见观话语认让谢还进远运过边达选钱银错键际难题颜风飞饭鸟龙简产亲优传价众条够权计设证试读谁调资质贵费赛软轻转较输办应该图务动劳势单卖历厅县参双变号叶吗吧园围华团头夺妈实宁宝审宽对导岁带帮广庆库废归总恋惊惯愿战户挥损换据摄态护报拥择无旧显晓术机杀杂极构标样桥梦检楼欢气汉汤沟没泽洁浅测济浓涛湾灭灯灵灾炼点烟热爷状独猎环现盘监盖矿码礼祸种积称穷窗笔筑签类紧级纪纯纸纹线练组细织终经绍给络绝统继续维综绿网罗罚职聪联肃肠肤胜脑脚脸舍艺节芦苏药获荣莱虽蚕补装见规视览觉触誓认讨让训议记讲许论访证评识诉诊词译试诗诚话诞询该详语误说请诸读课谈谊谋谓谢谨谱贝负贡财责败货质贩贪贫购贯贴贸贺资赋赏赔赖赚赠赶趋跃践踪轮软载辆辈辉辑输辩边辽达迁过迈运还这进远违连迟适选递逻遗郑邻酱释里鉴针钓钟钢钱铁铃铜铭银铺链锁锅锋错锦键镇镜长门闪闭问闲间闷闹闻阀阅队阳阴阵阶际陆陈险随隐难雏雾霁静鞑韦韩页顶项顺须顾顿预领频题颜额风飘飞饥饭饮饰饱饼馆馈马驱驶驾驻驼验骂骑骗鬓鱼鲁鲜鸟鸡鸣鸭鹅黄齐齿龄龙';
const TRADITIONAL_ONLY = '們這為說時國會對發開關門問間現東車長馬書買賣愛體學寫區醫樂聽見觀話語認讓謝還進遠運過邊達選錢銀錯鍵際難題顏風飛飯鳥龍簡產親優傳價眾條夠權計設證試讀誰調資質貴費賽軟輕轉較輸辦應該圖務動勞勢單歷廳縣參雙變號葉嗎園圍華團頭奪媽實寧寶審寬導歲帶幫廣慶庫廢歸總戀驚慣願戰戶揮損換據攝態護報擁擇無舊顯曉術機殺雜極構標樣橋夢檢樓歡氣漢湯溝沒澤潔淺測濟濃濤灣滅燈靈災煉點煙熱爺狀獨獵環盤監蓋礦碼禮禍種積稱窮窗筆築簽類緊級紀純紙紋線練組細織終經紹給絡絕統繼續維綜綠網羅罰職聰聯肅腸膚勝腦腳臉捨藝節蘆蘇藥獲榮萊雖蠶補裝規視覽覺觸誓討訓議記講許論訪評識訴診詞譯詩誠誕詢詳誤請諸課談誼謀謂謹譜貝負貢財責敗貨販貪貧購貫貼貿賀賦賞賠賴賺贈趕趨躍踐蹤輪載輛輩輝輯辯遼遷邁違連遲適遞邏遺鄭鄰醬釋裡鑑針釣鐘鋼鐵鈴銅銘鋪鏈鎖鍋鋒錦鎮鏡閃閉閒悶鬧聞閥閱隊陽陰陣階陸陳險隨隱雛霧霽靜韃韋韓頁頂項順須顧頓預領頻額飄飢飲飾飽餅館饋驅駛駕駐駝驗罵騎騙鬢魚魯鮮雞鳴鴨鵝黃齊齒齡';

export function auditDoc(doc, ctx) {
  const flags = [];
  const xFlags = [];
  let score = 100;
  const pen = (n, flag) => {
    score -= n;
    if (flag) flags.push(flag);
  };
  const text = doc.paragraphs.join('\n');
  const stats = textStats(text);
  const year = ctx.currentYear;
  // placeholders / residue
  const allText = [doc.title, doc.description, ...doc.headings.map((h) => h.text), ...doc.paragraphs].join('\n');
  const ph = PLACEHOLDER_RE.exec(allText);
  if (ph) {
    xFlags.push(`placeholder "${ph[0]}"`);
    pen(30, 'placeholder');
  }
  if (AI_RESIDUE.test(allText)) {
    xFlags.push('AI boilerplate left in text');
    pen(30, 'ai-residue');
  }
  if (WIKI_CODE.test(allText) || doc.headings.some((h) => /^(heading|subheading|title|h[1-6])$/i.test(h.text.trim()))) {
    xFlags.push('template code left in text');
    pen(30, 'template-code');
  }
  if (EXPERT_CLAIM.test(allText)) pen(5, 'first-person-expert');
  const authorNames = (ctx.authorNames || []).filter((n) => n && n.length >= 2);
  if (authorNames.some((n) => countOccurrences(allText.toLowerCase(), n.toLowerCase()) > 2)) pen(5, 'name-stuffing');
  const linkCounts = new Map();
  for (const l of doc.links) linkCounts.set(l.url, (linkCounts.get(l.url) || 0) + 1);
  if ([...linkCounts.values()].some((c) => c >= 3)) pen(3, 'repeated-link');
  const simp = [...allText].filter((ch) => SIMPLIFIED_ONLY.includes(ch)).length;
  const trad = [...allText].filter((ch) => TRADITIONAL_ONLY.includes(ch)).length;
  if (Math.min(simp, trad) >= 3 && Math.min(simp, trad) / Math.max(simp, trad) >= 0.05) pen(5, `mixed-script:${simp}s/${trad}t`);
  const paraCounts = new Map();
  for (const p of doc.paragraphs) if (displayWidth(p) >= 40) paraCounts.set(p, (paraCounts.get(p) || 0) + 1);
  if ([...paraCounts.values()].some((c) => c > 1)) pen(10, 'repeated-paragraph');
  // length
  if (stats.wordEq < ctx.minWords) pen(15, 'thin');
  // template
  const tr = ctx.templateRatio;
  if (tr >= 0.5) pen(30, 'template-heavy');
  else if (tr >= 0.3) pen(15, 'template-medium');
  else if (tr >= 0.15) pen(5, 'template-light');
  // duplicates
  if (ctx.bestDup) {
    if (ctx.bestDup.similarity >= 0.8) pen(30, 'near-duplicate');
    else pen(15, 'similar-content');
  }
  // stuffing
  for (const term of ctx.terms) {
    const d = keywordDensity(doc, term);
    if (d.count >= 5 && d.density > ctx.maxDensity) {
      pen(10, `stuffing:${term}`);
      break;
    }
    const inTitle = countOccurrences(compactKey(doc.title), compactKey(term));
    if (inTitle >= 2) pen(5, `title-repeats:${term}`);
    const h2 = doc.headings.filter((h) => h.level === 2);
    if (h2.length >= 3 && h2.filter((h) => compactKey(h.text).includes(compactKey(term))).length / h2.length >= 0.6) pen(5, `headings-stuffed:${term}`);
  }
  // intro
  const firstBlock = (doc.blocks || []).find((b, i, arr) => b.type === 'p' && displayWidth(b.text) >= 20 && !arr.slice(0, i).some((x) => x.type === 'h' && x.level >= 2));
  const first = (firstBlock && firstBlock.text) || doc.paragraphs.find((p) => displayWidth(p) >= 20) || '';
  const firstStats = textStats(first);
  if (first && GENERIC_OPENER.test(first.trim())) pen(5, 'generic-opener');
  if (firstStats.wordEq > 120) pen(5, 'long-intro');
  const titleTokens = topicTokens(doc.title.split(/\s[|｜\-–—]\s/)[0] || '', { vocab: ctx.vocab });
  const opening = compactKey(doc.paragraphs.slice(0, 2).join(' '));
  if (titleTokens.length && first && !titleTokens.some((t) => opening.includes(compactKey(t)))) pen(5, 'topic-late');
  if (doc.paragraphs.slice(0, 3).some((p) => META_TALK.test(p))) pen(3, 'meta-commentary');
  // GEO blocks
  const firstThird = [...doc.headings.map((h) => h.text), ...doc.paragraphs.slice(0, Math.max(3, Math.ceil(doc.paragraphs.length * 0.3)))];
  const hasTldr = firstThird.some((t) => TLDR.test(t.trim()));
  const questionHeadings = doc.headings.filter((h) => h.level >= 2 && QUESTION.test(h.text.trim()));
  const hasFaq = doc.headings.some((h) => FAQ_HEADING.test(h.text)) || doc.jsonldTypes.includes('FAQPage') || (doc.faqCount || 0) > 0 || questionHeadings.length >= 3;
  // answer capsule: a question heading immediately followed by a short, self-contained answer
  let capsules = 0;
  const blocks = doc.blocks || [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const b = blocks[i];
    if (b.type !== 'h' || b.level < 2 || !QUESTION.test(b.text.trim())) continue;
    const next = blocks[i + 1];
    const w = next && next.type !== 'h' ? textStats(next.text).wordEq : 0;
    if (w >= 15 && w <= 90) capsules++;
  }
  if (stats.wordEq > 800 && !hasTldr && !hasFaq) pen(3, 'no-tldr-or-faq');
  if (hasTldr && doc.description) {
    const blocksArr = doc.blocks || [];
    const at = blocksArr.findIndex((b) => TLDR.test(b.text.trim()));
    const summary = at >= 0 ? [blocksArr[at], blocksArr[at + 1]].filter(Boolean).map((b) => b.text).join(' ') : '';
    if (summary && jaccard(shingleSet(summary, 2), shingleSet(doc.description, 2)) >= 0.5) pen(3, 'summary-copies-description');
  }
  // headings
  const levels = doc.headings.map((h) => h.level);
  const h1Count = doc.kind === 'markdown' ? doc.headings.filter((h) => h.level === 1).length || (doc.title ? 1 : 0) : doc.h1.length;
  let headingPen = 0;
  if (!h1Count) {
    headingPen += 3;
    flags.push('h1-missing');
  } else if (h1Count > 1) {
    headingPen += 3;
    flags.push('h1-multiple');
  }
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1 && levels[i - 1] >= 1) {
      headingPen += 3;
      flags.push('heading-skip');
      break;
    }
  }
  const htexts = doc.headings.map((h) => normalizeText(h.text)).filter(Boolean);
  if (new Set(htexts).size < htexts.length) {
    headingPen += 3;
    flags.push('heading-duplicate');
  }
  if (stats.wordEq > 800 && doc.headings.filter((h) => h.level === 2).length < 2) {
    headingPen += 3;
    flags.push('few-subheadings');
  }
  score -= Math.min(10, headingPen);
  // years and freshness
  const yearsIn = (s) => [...String(s || '').matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => Number(m[1]));
  const titleYears = [...yearsIn(doc.title), ...doc.h1.flatMap(yearsIn), ...doc.headings.filter((h) => h.level === 2).flatMap((h) => yearsIn(h.text))];
  if (titleYears.some((y) => y < year && y >= 2000)) pen(10, `outdated-year:${Math.min(...titleYears)}`);
  const staleBody = splitSentences(text).some((s) => RECENCY.test(s) && yearsIn(s).some((y) => y < year - 1));
  if (staleBody) pen(3, 'outdated-year-body');
  const modified = doc.dates.modified || doc.dates.published || '';
  const modTime = Date.parse(modified);
  if (modified && Number.isFinite(modTime) && (ctx.now - modTime) / 86400000 > ctx.staleDays) pen(5, 'stale');
  // links
  const broken = ctx.brokenLinks.length;
  if (broken) pen(Math.min(15, broken * 5), `broken-links:${broken}`);
  if (ctx.redirectLinks.length) pen(Math.min(6, ctx.redirectLinks.length * 2), `links-to-redirects:${ctx.redirectLinks.length}`);
  score = Math.max(0, Math.round(score));
  let grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : 'D';
  if (ctx.mergeInto) grade = 'D';
  return {
    score,
    grade,
    flags,
    xFlags,
    stats,
    hasTldr,
    hasFaq,
    answerCapsules: capsules,
    firstParagraphWordEq: firstStats.wordEq,
  };
}

function suggestedAction(r) {
  if (r.xFlags.length) return 'fix now (X)';
  if (r.mergeInto) return `merge into ${r.mergeInto}`;
  return { A: 'keep', B: 'small fixes', C: 'rewrite', D: 'merge or redirect' }[r.grade];
}

// ---------- main ----------
export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const origin = ws.siteUrl({ required: false }) ? ws.origin() : '';
  const host = origin ? ws.host() : '';
  const docs = [];
  let source = '';
  const globs = flags.glob.length ? flags.glob : [];
  let base = flags.root ? path.resolve(flags.root) : process.cwd();
  let patterns = globs;
  if (!patterns.length && ws.config.repo.path && ws.config.repo.contentGlobs.length && !flags.fromCrawl) {
    base = ws.resolveFile(ws.config.repo.path, { prefer: 'project' });
    patterns = ws.config.repo.contentGlobs;
  }
  const tpl = flags.urlTemplate || ws.config.repo.urlTemplate || '';
  if (patterns.length) {
    const seen = new Set();
    for (const pat of patterns) {
      const globBase = path.resolve(base, staticBase(pat));
      for (const f of globFiles([pat], { cwd: base }).filter((x) => /\.(md|markdown|mdx|html?)$/i.test(x))) {
        if (seen.has(f)) continue;
        seen.add(f);
        docs.push(docFromFile(f, { url: tpl ? urlFromTemplate(tpl, f, globBase) : '', origin }));
      }
    }
    const files = [...seen];
    if (!files.length) throw new UserError(`No content files matched ${patterns.join(', ')} (base ${base})`);
    source = `${files.length} files (${patterns.join(', ')})`;
    if (!tpl && docs.some((d) => !d.url)) log('Note: some files have no URL (no canonical/permalink and no --url-template); GSC metrics and link checks cannot be joined for them.');
  } else {
    const file = flags.fromCrawl || ws.listData('crawl', /-text\.jsonl$/)[0];
    if (!file || !fs.existsSync(file)) {
      throw new UserError('Nothing to audit: no --glob, no repo.contentGlobs and no crawl text', {
        hint: [`Audit source files: ${scriptCmd('content-audit.mjs')} --glob "content/**/*.md" --url-template "https://example.com/blog/{slug}/"`, `Or crawl first: ${scriptCmd('crawl-site.mjs')} (writes data/crawl/<date>-crawl-text.jsonl)`],
      });
    }
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.status && rec.status !== 200) continue;
      docs.push(docFromCrawl(rec));
    }
    source = `crawl text ${path.basename(file)} (${docs.length} pages)`;
  }
  if (!docs.length) throw new UserError('No documents to audit');
  log(`Auditing ${docs.length} documents...`);

  // keyword targets
  const mapFile = flags.keywordMap || ws.path('keyword-map.csv');
  const targets = new Map();
  if (fs.existsSync(mapFile)) {
    for (const r of readCsvFile(mapFile).records) {
      const u = r.target_url && (normalizeUrl(r.target_url) || r.target_url);
      if (!u || !r.keyword) continue;
      if (!targets.has(u)) targets.set(u, []);
      targets.get(u).push(r.keyword);
    }
  }
  const termsFor = (d) => [...new Set([...(d.url && targets.get(d.url) ? targets.get(d.url) : []), ...d.keywords])];

  // corpus analyses
  const tmpl = templateAnalysis(docs, { minDocs: flags.templateMinDocs, minUnits: flags.minSentenceUnits, termsFor });
  const dups = nearDuplicates(docs, { threshold: flags.dupThreshold });
  const vocab = buildCjkVocabulary(docs.map((d) => d.title));

  // GSC metrics
  const gsc = new Map();
  if (flags.gscPages) {
    const g = loadGscFile(path.resolve(flags.gscPages));
    if (!g.dimensions.includes('page')) throw new UserError(`${flags.gscPages} has no page dimension`, { hint: `Export one with ${scriptCmd('gsc-export.mjs')} --dimensions page --days 28` });
    for (const [page, m] of groupMetrics(g.rows, (r) => normalizeUrl(r.page) || r.page)) gsc.set(page, m);
  }
  const gscFor = (u) => {
    if (!u) return null;
    if (gsc.has(u)) return gsc.get(u);
    const alt = u.endsWith('/') ? u.slice(0, -1) : `${u}/`;
    return gsc.get(alt) || null;
  };

  // links: known URLs from corpus + newest crawl
  const known = new Map();
  for (const d of docs) if (d.url) known.set(d.url, { status: 200 });
  const crawlJson = ws.listData('crawl', /-crawl\.json$/)[0];
  if (crawlJson) {
    try {
      for (const p of JSON.parse(fs.readFileSync(crawlJson, 'utf8')).pages || []) known.set(p.url, { status: p.status, finalUrl: p.finalUrl, redirects: p.redirects });
    } catch {
      /* ignore */
    }
  }
  const unknownTargets = new Set();
  for (const d of docs) for (const l of d.links) if (host && sameSite(l.url, host) && !known.has(l.url)) unknownTargets.add(l.url);
  if (flags.checkLinks && unknownTargets.size) {
    log(`Checking ${unknownTargets.size} internal link targets...`);
    const wait = rateLimiter(300);
    await mapLimit([...unknownTargets], 3, async (u) => {
      await wait();
      const res = await fetchPage(u, { method: 'GET', timeoutMs: 15000, maxBytes: 200000 });
      known.set(u, { status: res.status, redirects: res.chain.length, finalUrl: res.finalUrl });
    });
  }

  // per-doc audit
  const bestDup = new Map();
  for (const p of dups) {
    for (const [x, y] of [[p.a, p.b], [p.b, p.a]]) if (!bestDup.has(x) || bestDup.get(x).similarity < p.similarity) bestDup.set(x, { other: y, similarity: p.similarity });
  }
  const waves = fs.existsSync(ws.path('logs', 'experiments.json')) ? loadWaves(ws).filter(isOpen) : [];
  const now = Date.now();
  const currentYear = Number(ws.today().slice(0, 4));
  const results = docs.map((d, i) => {
    const dup = bestDup.get(i);
    const other = dup ? docs[dup.other] : null;
    const mine = gscFor(d.url);
    const theirs = other ? gscFor(other.url) : null;
    const mergeInto = dup && dup.similarity >= 0.8 && other && other.url && (theirs ? theirs.impressions : 0) > (mine ? mine.impressions : 0) ? other.url : '';
    const linkRows = d.links.filter((l) => host && sameSite(l.url, host));
    const brokenLinks = linkRows.filter((l) => known.has(l.url) && known.get(l.url).status >= 400).map((l) => l.url);
    const redirectLinks = linkRows.filter((l) => known.has(l.url) && known.get(l.url).redirects > 0).map((l) => l.url);
    const unverified = linkRows.filter((l) => !known.has(l.url)).map((l) => l.url);
    const a = auditDoc(d, { authorNames: (ws.config.brand.authors || []).map((x) => x && x.name).concat(ws.config.brand.founder || []), currentYear, now, minWords: flags.minWords, maxDensity: flags.maxDensity, staleDays: flags.staleDays, templateRatio: tmpl.ratios[i], bestDup: dup, terms: termsFor(d), vocab, brokenLinks, redirectLinks, mergeInto });
    const r = {
      url: d.url,
      file: d.file ? path.relative(base, d.file) : '',
      title: d.title,
      grade: a.grade,
      score: a.score,
      xFlags: a.xFlags,
      flags: a.flags,
      wordEq: a.stats.wordEq,
      cjkChars: a.stats.cjkChars,
      latinWords: a.stats.latinWords,
      templateRatio: tmpl.ratios[i],
      duplicateOf: other ? other.url || other.file : '',
      duplicateSimilarity: dup ? dup.similarity : 0,
      mergeInto,
      hasTldr: a.hasTldr,
      hasFaq: a.hasFaq,
      answerCapsules: a.answerCapsules,
      firstParagraphWordEq: a.firstParagraphWordEq,
      brokenLinks,
      redirectLinks,
      unverifiedLinks: unverified.length,
      targets: termsFor(d),
      impressions: mine ? mine.impressions : null,
      clicks: mine ? mine.clicks : null,
      ctr: mine ? mine.ctr : null,
      position: mine ? mine.position : null,
      modified: d.dates.modified || d.dates.published || '',
      wave: waves.filter((w) => (w.urls || []).includes(d.url)).map((w) => w.id).join(' '),
    };
    r.action = suggestedAction(r);
    r.priority = Math.round(((mine ? mine.impressions : 0) + 1) * (100 - a.score)) / 100;
    return r;
  });
  results.sort((x, y) => y.priority - x.priority);

  // outputs
  const files = [];
  files.push(writeCsvFile(ws.dataFile('content', 'content-audit', 'csv'), results.map((r) => ({
    url: r.url, file: r.file, title: r.title, grade: r.grade, score: r.score, x_flags: r.xFlags.join('; '), flags: r.flags.join(' '), action: r.action, priority: r.priority,
    impressions: r.impressions ?? '', clicks: r.clicks ?? '', ctr: r.ctr === null ? '' : r.ctr.toFixed(4), position: r.position === null ? '' : r.position.toFixed(1),
    word_eq: r.wordEq, cjk_chars: r.cjkChars, latin_words: r.latinWords, template_ratio: r.templateRatio.toFixed(2), duplicate_of: r.duplicateOf, duplicate_similarity: r.duplicateSimilarity ? r.duplicateSimilarity.toFixed(2) : '',
    merge_into: r.mergeInto, has_tldr: r.hasTldr ? 'yes' : '', has_faq: r.hasFaq ? 'yes' : '', answer_capsules: r.answerCapsules, first_paragraph_word_eq: r.firstParagraphWordEq,
    broken_links: r.brokenLinks.join(' '), redirect_links: r.redirectLinks.join(' '), unverified_links: r.unverifiedLinks, targets: r.targets.join(' | '), modified: r.modified, wave: r.wave,
  }))));
  files.push(writeCsvFile(ws.dataFile('content', 'duplicates', 'csv'), dups.map((p) => ({ a: docs[p.a].url || docs[p.a].file, b: docs[p.b].url || docs[p.b].file, similarity: p.similarity.toFixed(3) }))));
  files.push(writeCsvFile(ws.dataFile('content', 'template-sentences', 'csv'), tmpl.top.slice(0, 500).map((t) => ({ docs: t.docs, sentence: t.sentence }))));
  files.push(writeJson(ws.dataFile('content', 'content-audit', 'json'), { meta: { source, documents: docs.length, templateMinDocs: tmpl.threshold, dupThreshold: flags.dupThreshold, generatedAt: new Date().toISOString() }, results }));

  // inventory
  let inventoryInfo = null;
  if (!flags.noInventory) {
    const invPath = ws.path('content-inventory.csv');
    const inv = fs.existsSync(invPath) ? readCsvFile(invPath) : { headers: INVENTORY_COLUMNS, records: [] };
    const headers = [...inv.headers];
    for (const c of [...INVENTORY_COLUMNS, 'file', 'word_eq', 'score', 'flags']) if (!headers.includes(c)) headers.push(c);
    const byUrl = new Map(inv.records.map((r) => [r.url || r.file, r]));
    let indexState = {};
    try {
      indexState = JSON.parse(fs.readFileSync(ws.path('data', 'indexing', 'state.json'), 'utf8')).urls || {};
    } catch {
      /* none yet */
    }
    let added = 0;
    for (const r of results) {
      const key = r.url || r.file;
      if (!key) continue;
      let rec = byUrl.get(key);
      if (!rec) {
        rec = Object.fromEntries(headers.map((h) => [h, '']));
        inv.records.push(rec);
        byUrl.set(key, rec);
        added++;
      }
      const fillEmpty = (col, v) => {
        if ((rec[col] === undefined || rec[col] === '') && v !== undefined && v !== null && v !== '') rec[col] = String(v);
      };
      const setMachine = (col, v) => {
        if (!INVENTORY_MACHINE_COLUMNS.includes(col)) throw new Error(`content-inventory: ${col} is not a machine column`);
        rec[col] = v === undefined || v === null ? '' : String(v);
      };
      rec.url = rec.url || r.url;
      const lastSeg = r.url ? new URL(r.url).pathname.replace(/\/$/, '').split('/').pop() || '/' : path.basename(r.file).replace(/\.[^.]+$/, '');
      let slugValue = lastSeg;
      try {
        slugValue = decodeURIComponent(lastSeg);
      } catch {
        /* keep the raw segment */
      }
      fillEmpty('slug', slugValue);
      setMachine('title', r.title);
      fillEmpty('page_type', r.url ? ws.pageGroupOf(r.url) : '');
      setMachine('grade', r.grade);
      setMachine('x_flags', r.xFlags.join('; '));
      fillEmpty('action', r.action);
      fillEmpty('target_url', r.mergeInto);
      fillEmpty('wave', r.wave);
      if (r.impressions !== null) {
        setMachine('imp_28d', r.impressions);
        setMachine('clk_28d', r.clicks);
        setMachine('ctr_28d', r.ctr.toFixed(4));
        setMachine('pos_28d', r.position.toFixed(1));
      }
      const st = r.url ? indexState[r.url] : null;
      if (st && st.coverageState) setMachine('index_status', st.coverageState);
      if (r.url && known.has(r.url) && known.get(r.url).status) setMachine('http_status', known.get(r.url).status);
      setMachine('template_ratio', r.templateRatio.toFixed(2));
      setMachine('audited_at', ws.today());
      setMachine('file', r.file || rec.file || '');
      setMachine('word_eq', r.wordEq);
      setMachine('score', r.score);
      setMachine('flags', r.flags.join(' '));
    }
    writeCsvFile(invPath, inv.records, headers);
    inventoryInfo = { path: invPath, added, total: inv.records.length };
  }

  // report
  const gradeCount = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of results) gradeCount[r.grade]++;
  const xs = results.filter((r) => r.xFlags.length);
  const L = [];
  L.push(`# Content audit (${ws.today()})`, '');
  L.push(`- Source: ${source}; template sentence = shared by >= ${tmpl.threshold} pages; near-duplicate threshold ${flags.dupThreshold}`);
  L.push(`- Grades: A ${gradeCount.A}, B ${gradeCount.B}, C ${gradeCount.C}, D ${gradeCount.D}; X (must fix now): ${xs.length}`);
  L.push(`- Pages with template ratio >= 0.5: ${results.filter((r) => r.templateRatio >= 0.5).length}; near-duplicate pairs: ${dups.length}${gsc.size ? `; GSC metrics joined for ${results.filter((r) => r.impressions !== null).length} pages` : ''}`);
  L.push('- This ranks what to read first. A human (or reviewer agent) must still read each page before rewriting, merging or redirecting.', '');
  if (xs.length) {
    L.push('## X: fix now', '');
    L.push(mdTable([{ label: 'Page', value: (r) => (r.url ? shortUrl(r.url) : r.file) }, { label: 'Problem', value: (r) => r.xFlags.join('; ') }, { label: 'Impr.', align: 'right', value: (r) => fmtInt(r.impressions) }], xs.slice(0, flags.top)));
  }
  L.push('## Review queue (by impressions x problems)', '');
  L.push(mdTable(
    [
      { label: 'Page', value: (r) => (r.url ? shortUrl(r.url) : r.file) },
      { label: 'Grade', value: (r) => `${r.grade} (${r.score})` },
      { label: 'Impr.', align: 'right', value: (r) => fmtInt(r.impressions) },
      { label: 'Pos', align: 'right', value: (r) => fmtPos(r.position) },
      { label: 'Words', align: 'right', value: (r) => fmtInt(r.wordEq) },
      { label: 'Template', align: 'right', value: (r) => fmtPct(r.templateRatio, 0) },
      { label: 'Flags', value: (r) => r.flags.slice(0, 6).join(' ') },
      { label: 'Suggested', value: (r) => r.action },
    ],
    results.slice(0, flags.top),
  ));
  if (dups.length) {
    L.push('## Near-duplicate pairs', '', '_Merge only when clicks and rankings favour one side; otherwise give each page a distinct angle and cross-link._', '');
    L.push(mdTable([{ label: 'Page A', value: (p) => shortUrl(docs[p.a].url) || docs[p.a].file }, { label: 'Page B', value: (p) => shortUrl(docs[p.b].url) || docs[p.b].file }, { label: 'Similarity', align: 'right', value: (p) => p.similarity.toFixed(2) }], dups.slice(0, flags.top)));
  }
  if (tmpl.top.length) {
    L.push('## Most repeated sentences (template)', '', `_"${PLACEHOLDER}" marks where each page's own title was._`, '');
    L.push(mdTable([{ label: 'Pages', key: 'docs', align: 'right' }, { label: 'Sentence', value: (t) => t.sentence.slice(0, 140) }], tmpl.top.slice(0, 20)));
  }
  const geo = results.filter((r) => r.wordEq > 600);
  if (geo.length) {
    L.push('## GEO/AEO answer blocks (pages > 600 words)', '');
    L.push(`TL;DR or summary near the top: ${geo.filter((r) => r.hasTldr).length}/${geo.length}; FAQ: ${geo.filter((r) => r.hasFaq).length}/${geo.length}; pages with question headings answered by a short paragraph: ${geo.filter((r) => r.answerCapsules > 0).length}/${geo.length}.`, '');
  }
  if (inventoryInfo) L.push(`content-inventory.csv: ${inventoryInfo.total} rows (${inventoryInfo.added} new). Refreshed machine columns (${INVENTORY_MACHINE_COLUMNS.join(', ')}); manual columns (${INVENTORY_MANUAL_COLUMNS.join(', ')}) and any column you added were only filled where empty.`, '');
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-content-audit.md`), L.join('\n'));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ meta: { source }, results }, null, 2)}\n`);
    return 0;
  }
  out(`Audited ${docs.length} pages (${source})`);
  out(`Grades: A ${gradeCount.A} | B ${gradeCount.B} | C ${gradeCount.C} | D ${gradeCount.D} | X ${xs.length}; template-heavy ${results.filter((r) => r.templateRatio >= 0.5).length}; near-duplicate pairs ${dups.length}`);
  for (const r of results.slice(0, 5)) out(`  ${r.grade} ${String(r.score).padStart(3)}  ${(r.url ? shortUrl(r.url) : r.file).slice(0, 60).padEnd(60)} ${r.flags.slice(0, 4).join(' ')}`);
  out(`\nwrote ${md}`);
  for (const f of files) out(`wrote ${f}`);
  if (inventoryInfo) out(`updated ${inventoryInfo.path}`);
  return 0;
}

runMain(import.meta.url, main);
