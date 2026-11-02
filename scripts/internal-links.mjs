#!/usr/bin/env node
// Internal link analysis from a crawl: weighted internal PageRank / Link Score, inlinks by position, click depth,
// orphans, and a reviewed-by-hand list of contextual link suggestions from keyword-map.csv phrases.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, formatHelp, COMMON_FLAGS } from './lib/args.mjs';
import { runMain, out, log, UserError, writeText, normalizeUrl, scriptCmd } from './lib/util.mjs';
import { loadWorkspace } from './lib/config.mjs';
import { readCsvFile, writeCsvFile, findColumn } from './lib/csv.mjs';
import { loadGscFile } from './lib/gsc.mjs';
import { mdTable, shortUrl, fmtInt, textTable } from './lib/format.mjs';
import { buildGraph, pageRank, linkScores, clickDepth, inlinkCounts, phraseRegex, findMentions, batchSuggestions, resolveRedirect, normalizeKey, WEIGHTS } from './lib/link-graph.mjs';

const SPEC = {
  ...COMMON_FLAGS,
  'crawl-date': { type: 'string', placeholder: 'YYYY-MM-DD', desc: 'Use the crawl files of this date (default: newest data/crawl/*-links.jsonl)' },
  links: { type: 'string', placeholder: 'file', desc: 'Link graph JSONL from crawl-site (-links.jsonl); its -text.jsonl and -pages.csv siblings are used too' },
  text: { type: 'string', placeholder: 'file', desc: 'Page text JSONL (-text.jsonl) for suggestions' },
  pages: { type: 'string', placeholder: 'file', desc: 'Pages CSV (-pages.csv): status, indexable, sitemap, redirects' },
  'keyword-map': { type: 'string', placeholder: 'file', desc: 'keyword,target_url[,synonyms|variants] CSV (default: <workspace>/keyword-map.csv)' },
  gsc: { type: 'string', placeholder: 'file', desc: 'GSC export with query and page: opportunity = impressions at positions 5-20 per target' },
  'max-per-source': { type: 'int', desc: 'Suggestions per source page in one batch', default: 3 },
  'max-per-target': { type: 'int', desc: 'Suggestions per target page in one batch', default: 10 },
  'batch-size': { type: 'int', desc: 'Suggestions per batch (review and ship one batch at a time)', default: 30 },
  'max-batches': { type: 'int', desc: 'Batches to plan', default: 3 },
  'min-score': { type: 'number', desc: 'Drop suggestions scoring below this', default: 0 },
  'sitewide-share': { type: 'number', desc: 'A link on more than this share of pages counts as sitewide (weight 0.3)', default: 0.5 },
  top: { type: 'int', desc: 'Rows per Markdown table', default: 30 },
  json: { type: 'boolean', desc: 'Print a JSON summary' },
};

const HELP = formatHelp({
  usage: ['node scripts/internal-links.mjs [--crawl-date YYYY-MM-DD] [--gsc data/gsc/<query-page export>]', 'node scripts/internal-links.mjs --links <file>-links.jsonl [--text <file>-text.jsonl] [--pages <file>-pages.csv]'],
  summary:
    'Builds the internal link graph from the newest crawl-site output (-links.jsonl, -text.jsonl, -pages.csv). Per page: internal PageRank ' +
    `(damping 0.85, iterated to convergence; contextual links weigh ${WEIGHTS.body}, nav/header/footer/aside links ${WEIGHTS.boiler}, links on more than half ` +
    `of all pages ${WEIGHTS.sitewide}; nofollow links evaporate), a 1-100 Link Score on a log scale, inlinks (unique source pages: total, contextual body, ` +
    'navigation), outlinks, click depth from the home page, orphans, pages with <= 1 contextual inlink and pages deeper than 3 clicks. ' +
    'Suggestions: for every keyword-map.csv row with a target_url (plus synonyms/variants columns, "|" or ";" separated), body paragraphs ' +
    'that mention the phrase (whole words; CJK as substrings) on pages that do not link to the target yet. Anchor = the phrase exactly as written ' +
    'there; score = opportunity (impressions at positions 5-20 from --gsc, else 1) x source PageRank x topical match (same page group / ' +
    'keyword-map cluster). Writes data/crawl/<today>-internal-links.csv, -link-suggestions.csv and logs/reviews/<today>-internal-links.md.',
  spec: SPEC,
  examples: [
    'node scripts/internal-links.mjs',
    'node scripts/internal-links.mjs --gsc .seo-agent/data/gsc/2026-11-01-query-page-28d.json --max-per-source 2',
    'node scripts/internal-links.mjs --crawl-date 2026-11-01 --batch-size 20',
  ],
  notes: [
    'Suggestions are never applied automatically: review each one in context, add it to the named paragraph, then log the batch as one wave.',
    'Run crawl-site with link discovery (not --urls-file) so the graph is complete; orphans and depth are only meaningful for a complete crawl.',
    'Only pages that return 200, are indexable and canonicalize to themselves get a Link Score or receive suggestions.',
  ],
});

// ---------- inputs ----------
function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (e) {
      throw new UserError(`${path.basename(file)} line ${i + 1} is not valid JSON: ${e.message}`);
    }
  });
}

export function crawlFiles(ws, flags) {
  let links = flags.links ? path.resolve(flags.links) : '';
  if (!links) {
    const re = flags.crawlDate ? new RegExp(`^${flags.crawlDate.replace(/[^0-9-]/g, '')}-.*-links\\.jsonl$`) : /-links\.jsonl$/;
    links = ws.listData('crawl', re)[0] || '';
  }
  if (!links || !fs.existsSync(links)) {
    throw new UserError(flags.links ? `Links file not found: ${flags.links}` : `No crawl link graph found${flags.crawlDate ? ` for ${flags.crawlDate}` : ''} (data/crawl/*-links.jsonl)`, {
      hint: [`Crawl the site first: ${scriptCmd('crawl-site.mjs')} --max-pages 2000`, 'Or pass --links <file>-links.jsonl'],
    });
  }
  const prefix = links.replace(/-links\.jsonl$/, '');
  const sib = (suffix) => (fs.existsSync(`${prefix}${suffix}`) ? `${prefix}${suffix}` : '');
  return {
    links,
    text: flags.text ? path.resolve(flags.text) : sib('-text.jsonl'),
    pages: flags.pages ? path.resolve(flags.pages) : sib('-pages.csv'),
    crawlJson: sib('-crawl.json'),
  };
}

/** Page facts by normalized URL from -pages.csv: {status, indexable, inSitemap, final}; plus the redirect map. */
export function readPages(file) {
  const facts = new Map();
  const redirects = new Map();
  if (!file) return { facts, redirects };
  for (const r of readCsvFile(file).records) {
    const url = normalizeUrl(r.url) || r.url;
    const final = normalizeUrl(r.final_url) || r.final_url || url;
    const fact = { status: r.status, indexable: r.indexable === 'yes', inSitemap: r.in_sitemap === 'yes', final };
    facts.set(url, fact);
    if (Number(r.redirects) > 0 && final && final !== url) redirects.set(url, final);
  }
  return { facts, redirects };
}

/** keyword-map rows with a target: [{keyword, target, cluster, phrases:[...]}]. */
export function readKeywordMap(file, { origin, redirects }) {
  if (!file || !fs.existsSync(file)) return [];
  const { headers, records } = readCsvFile(file);
  const synCol = findColumn(headers, ['synonyms', 'variants', 'synonym', 'variant']);
  const rows = [];
  for (const r of records) {
    const keyword = String(r.keyword || '').trim();
    const rawTarget = String(r.target_url || '').trim();
    if (!keyword || !rawTarget) continue;
    let abs = rawTarget;
    try {
      abs = new URL(rawTarget, origin || undefined).href;
    } catch {
      continue;
    }
    const target = resolveRedirect(abs, redirects);
    const phrases = [keyword, ...String((synCol && r[synCol]) || '').split(/[|;]/)].map((s) => s.trim()).filter(Boolean);
    rows.push({ keyword, target, cluster: String(r.cluster || '').trim(), phrases });
  }
  return rows;
}

/** Impressions per page from queries ranking 5-20 (query+page aggregated over the export). */
export function opportunityByPage(file) {
  const map = new Map();
  if (!file) return map;
  const { rows, dimensions } = loadGscFile(file);
  if (!dimensions.includes('page') || !dimensions.includes('query')) throw new UserError(`--gsc needs query and page columns (found: ${dimensions.join(', ') || 'none'})`, { hint: 'Export with gsc-export.mjs --dimensions query,page' });
  const agg = new Map();
  for (const r of rows) {
    const k = `${r.query}\t${normalizeUrl(r.page) || r.page}`;
    const a = agg.get(k) || { impressions: 0, pw: 0 };
    a.impressions += r.impressions || 0;
    a.pw += (r.position || 0) * (r.impressions || 0);
    agg.set(k, a);
  }
  for (const [k, a] of agg) {
    const pos = a.impressions ? a.pw / a.impressions : 0;
    if (pos < 5 || pos > 20) continue;
    const page = k.split('\t')[1];
    map.set(page, (map.get(page) || 0) + a.impressions);
  }
  return map;
}

// ---------- analysis ----------
/** Everything except file IO; exported for tests. */
export function analyze({ linkRecords, textRecords = [], facts = new Map(), redirects = new Map(), keywordRows = [], opportunity = null, home = '', pageGroupOf = () => 'other', important = new Map(), options = {} }) {
  const graph = buildGraph(linkRecords, { redirects, sitewideShare: options.sitewideShare ?? 0.5 });
  const { pr, iterations } = pageRank(graph);
  const n = graph.nodes.length;
  const textByUrl = new Map();
  for (const t of textRecords) textByUrl.set(normalizeUrl(t.finalUrl || t.url) || t.url, t);
  const eligible = graph.nodes.map((u) => {
    const f = facts.get(u);
    if (f) return f.indexable && String(f.status) === '200';
    const t = textByUrl.get(u);
    if (!t) return true;
    const canon = t.canonical ? normalizeUrl(t.canonical) : '';
    return !t.noindex && (!canon || canon === u);
  });
  const eligibleIdx = graph.nodes.map((_, i) => i).filter((i) => eligible[i]);
  const scores = linkScores(pr, eligibleIdx);
  const homeKey = home ? resolveRedirect(home, redirects) : '';
  let start = graph.index.has(homeKey) ? graph.index.get(homeKey) : -1;
  if (start < 0) {
    const d0 = linkRecords.find((r) => r.depth === 0);
    start = d0 ? graph.index.get(normalizeUrl(d0.finalUrl || d0.url)) ?? 0 : 0;
  }
  const depth = clickDepth(graph, start);
  const inl = inlinkCounts(graph);
  const keywordsByTarget = new Map();
  for (const row of keywordRows) {
    if (!keywordsByTarget.has(row.target)) keywordsByTarget.set(row.target, []);
    keywordsByTarget.get(row.target).push(row.keyword);
  }
  const pages = graph.nodes.map((url, i) => {
    const d = depth.has(i) ? depth.get(i) : null;
    const f = facts.get(url) || {};
    return {
      url,
      eligible: eligible[i],
      linkScore: eligible[i] ? scores.get(i) : null,
      pagerank: pr[i],
      inlinksTotal: inl[i].total,
      inlinksBody: inl[i].body,
      inlinksNav: inl[i].nav,
      outlinks: graph.out[i].length,
      depth: d,
      inSitemap: Boolean(f.inSitemap),
      orphan: inl[i].total === 0 && i !== start,
      weakContextual: inl[i].body <= 1 && i !== start,
      deep: d === null ? i !== start : d > 3,
      important: important.get(url) || '',
      keywords: keywordsByTarget.get(url) || [],
      pageGroup: pageGroupOf(url),
    };
  });
  const pageByUrl = new Map(pages.map((p) => [p.url, p]));

  // suggestions
  const phraseMap = new Map();
  keywordRows.forEach((row, rowIndex) => {
    for (const p of row.phrases) {
      const key = normalizeKey(p);
      if (!key || [...key.replace(/\s/g, '')].length < 2 || phraseMap.has(key)) continue;
      const re = phraseRegex(p);
      if (re) phraseMap.set(key, { key, re, rowIndex });
    }
  });
  const phrases = [...phraseMap.values()];
  const clusterTargets = new Map();
  for (const row of keywordRows) {
    if (!row.cluster) continue;
    if (!clusterTargets.has(row.cluster)) clusterTargets.set(row.cluster, new Set());
    clusterTargets.get(row.cluster).add(row.target);
  }
  const candidates = [];
  if (phrases.length) {
    for (const t of textRecords) {
      const si = graph.index.get(normalizeUrl(t.finalUrl || t.url) || t.url);
      if (si === undefined || !eligible[si] || String(t.status || 200) !== '200') continue;
      const source = graph.nodes[si];
      const linked = new Set([...graph.pairs[si].keys()].map((to) => graph.nodes[to]));
      const mentions = findMentions(t.paragraphs || [], phrases, { linkTexts: graph.linkTexts[si] });
      const byTarget = new Map();
      for (const m of mentions) {
        const row = keywordRows[m.phrase.rowIndex];
        const ti = graph.index.get(row.target);
        if (ti === undefined || !eligible[ti]) continue;
        const target = graph.nodes[ti];
        if (target === source || linked.has(target)) continue;
        if (!byTarget.has(target)) byTarget.set(target, { row, mentions: [] });
        byTarget.get(target).mentions.push(m);
      }
      for (const [target, { row, mentions: ms }] of byTarget) {
        const tp = pageByUrl.get(target);
        const opp = opportunity ? 1 + (opportunity.get(target) || 0) : 1;
        const sameGroup = tp.pageGroup !== 'other' && tp.pageGroup === pageGroupOf(source);
        const sameCluster = Boolean(row.cluster && clusterTargets.get(row.cluster) && clusterTargets.get(row.cluster).has(source));
        const topical = 1 + (sameGroup ? 0.5 : 0) + (sameCluster ? 0.5 : 0);
        const score = opp * pr[si] * n * topical;
        candidates.push({ source, target, keyword: row.keyword, score, opp: opportunity ? opportunity.get(target) || 0 : null, sameGroup, sameCluster, targetBody: tp.inlinksBody, sourceScore: pageByUrl.get(source).linkScore, mentions: ms, paragraphs: (t.paragraphs || []).length });
      }
    }
  }
  const suggestions = batchSuggestions(candidates, { maxPerSource: options.maxPerSource ?? 3, maxPerTarget: options.maxPerTarget ?? 10, batchSize: options.batchSize ?? 30, maxBatches: options.maxBatches ?? 3, minScore: options.minScore ?? 0 }).map((c) => {
    const reason = [
      `body text mentions "${c.mention.anchor}" (keyword-map: ${c.keyword})`,
      `target has ${c.targetBody} contextual inlink${c.targetBody === 1 ? '' : 's'}`,
      c.opp !== null ? `${fmtInt(c.opp)} impressions at positions 5-20` : '',
      c.sameGroup ? `same page group (${pageGroupOf(c.source)})` : '',
      c.sameCluster ? 'source targets the same keyword cluster' : '',
      c.mention.overlapsLink ? `check: "${c.mention.overlapsLink}" is already link text on this page; do not wrap or nest an existing link` : '',
    ].filter(Boolean).join('; ');
    return {
      source: c.source,
      target: c.target,
      anchor: c.mention.anchor,
      snippet: c.mention.sentence,
      placement: `paragraph ${c.mention.paragraph + 1} of ${c.paragraphs}`,
      reason,
      score: Math.round(c.score * 1000) / 1000,
      batch: c.batch,
      keyword: c.keyword,
      link_type: 'learn',
      target_body_inlinks: c.targetBody,
      source_link_score: c.sourceScore === null || c.sourceScore === undefined ? '' : Math.round(c.sourceScore),
    };
  });
  return { graph, pages, suggestions, iterations, home: graph.nodes[start] || '', candidates: candidates.length };
}

// ---------- report ----------
function renderReport(res, meta) {
  const L = [];
  const { pages, suggestions } = res;
  const elig = pages.filter((p) => p.eligible);
  const top = meta.top;
  L.push(`# Internal links (${meta.today})`, '');
  L.push(`- Crawl: ${meta.source}; ${pages.length} pages in the graph, ${elig.length} eligible (200, indexable, self-canonical); home ${shortUrl(res.home)}`);
  L.push(`- Internal PageRank: damping 0.85, ${res.iterations} iterations; weights body ${WEIGHTS.body}, nav/header/footer/aside ${WEIGHTS.boiler}, sitewide (> ${Math.round(meta.sitewideShare * 100)}% of pages) ${WEIGHTS.sitewide}; nofollow links evaporate. Link Score: log scale, 1 = weakest eligible page, 100 = strongest.`);
  if (meta.incomplete) L.push(`- WARNING: the crawl stopped with ${meta.incomplete} discovered URL(s) not fetched: inlinks, orphans and depth undercount. Re-crawl with a higher --max-pages.`);
  if (meta.noText) L.push('- No -text.jsonl next to the link graph: no suggestions (re-crawl without --no-save-text).');
  if (!meta.keywordRows) L.push('- keyword-map.csv has no rows with target_url: no suggestions. Fill target_url (and optional synonyms) first.');
  L.push('');
  L.push('## Strongest pages (Link Score)', '');
  const cols = [
    { label: 'Page', value: (p) => shortUrl(p.url) },
    { label: 'Link Score', align: 'right', value: (p) => (p.linkScore === null ? '-' : p.linkScore.toFixed(0)) },
    { label: 'Inlinks (body / nav / total)', align: 'right', value: (p) => `${p.inlinksBody} / ${p.inlinksNav} / ${p.inlinksTotal}` },
    { label: 'Depth', align: 'right', value: (p) => (p.depth === null ? 'unreachable' : p.depth) },
  ];
  L.push(mdTable(cols, elig.slice().sort((a, b) => b.linkScore - a.linkScore).slice(0, Math.min(top, 15))));
  const weak = elig.filter((p) => p.important && p.weakContextual).sort((a, b) => a.inlinksBody - b.inlinksBody || a.linkScore - b.linkScore);
  L.push('## Important pages with weak contextual inlinks (<= 1)', '', '_Important = keyword-map targets, guardrail pages, protected URLs. Navigation links alone do not tell readers or search engines what a page is about._', '');
  L.push(mdTable([...cols, { label: 'Why important', key: 'important' }, { label: 'Suggestions', align: 'right', value: (p) => suggestions.filter((s) => s.target === p.url).length }], weak.slice(0, top), { empty: 'None: every important page has at least 2 contextual inlinks.' }));
  const orphans = elig.filter((p) => p.orphan);
  L.push('## Orphan pages (no internal links from crawled pages)', '');
  L.push(orphans.length ? orphans.slice(0, top).map((p) => `- ${p.url}${p.inSitemap ? ' (in sitemap)' : ''}`).join('\n') : '_None._', '');
  const deep = elig.filter((p) => p.deep && !p.orphan).sort((a, b) => (b.depth ?? 99) - (a.depth ?? 99));
  L.push('## Deeper than 3 clicks from the home page (or unreachable by links)', '');
  L.push(mdTable(cols, deep.slice(0, top), { empty: 'None.' }));
  const batches = [...new Set(suggestions.map((s) => s.batch))];
  L.push('## Link suggestions', '');
  L.push(`${suggestions.length} suggestion(s) in ${batches.length} batch(es) from ${res.candidates} candidate(s); at most ${meta.maxPerSource} per source page and ${meta.maxPerTarget} per target per batch, one per source->target pair. Full list: \`${path.basename(meta.suggestionsCsv)}\`.`, '');
  const b1 = suggestions.filter((s) => s.batch === 'B1');
  L.push(mdTable(
    [
      { label: 'Source', value: (s) => shortUrl(s.source) },
      { label: 'Target', value: (s) => shortUrl(s.target) },
      { label: 'Anchor (as written)', key: 'anchor' },
      { label: 'Where', key: 'placement' },
      { label: 'Sentence', value: (s) => s.snippet },
      { label: 'Target body inlinks', align: 'right', key: 'target_body_inlinks' },
      { label: 'Score', align: 'right', value: (s) => s.score.toFixed(2) },
    ],
    b1.slice(0, top),
    { empty: 'No suggestions (no keyword-map phrase is mentioned on a page that does not link to its target yet).' },
  ));
  L.push('## How to ship a batch', '');
  L.push('- Never auto-apply: read each sentence in context and link the anchor exactly as written there (keep the sentence natural; skip a suggestion that reads oddly). One link per source->target pair.');
  L.push('- Ship one batch (B1 first) as one wave. Its source URLs are the changed pages: log them with `log-change.mjs add --kind internal-links --urls-file <B1-sources.txt>`; the adopted batch\'s source URLs become the treatment group (`gsc-compare --urls-file`).');
  L.push('- The effect should show on the receiving pages: also compare the targets (`gsc-compare --urls-file <B1-targets.txt>`) against the rest of their page groups (references/06 step 5).');
  L.push('- Changing site-wide anchors or template links touches protected pages: separate batch, D0, guardrails (references/03).', '');
  return L.join('\n');
}

export async function main(argv) {
  const { flags } = parseArgs(argv, SPEC);
  if (flags.help) return void process.stdout.write(HELP);
  const ws = loadWorkspace(flags);
  const files = crawlFiles(ws, flags);
  const linkRecords = readJsonl(files.links);
  if (!linkRecords.length) throw new UserError(`${path.basename(files.links)} is empty`);
  const textRecords = files.text ? readJsonl(files.text) : [];
  const { facts, redirects } = readPages(files.pages);
  const origin = ws.siteUrl({ required: false }) ? ws.origin() : new URL(linkRecords[0].finalUrl || linkRecords[0].url).origin;
  const mapFile = flags.keywordMap ? path.resolve(flags.keywordMap) : ws.path('keyword-map.csv');
  if (flags.keywordMap && !fs.existsSync(mapFile)) throw new UserError(`Keyword map not found: ${flags.keywordMap}`);
  const keywordRows = readKeywordMap(mapFile, { origin, redirects });
  const opportunity = flags.gsc ? opportunityByPage(path.resolve(flags.gsc)) : null;
  const important = new Map();
  const mark = (u, why) => {
    let abs = u;
    try {
      abs = new URL(u, origin).href;
    } catch {
      return;
    }
    const k = resolveRedirect(abs, redirects);
    important.set(k, [important.get(k), why].filter(Boolean).join(', '));
  };
  for (const row of keywordRows) if (!important.has(row.target) || !important.get(row.target).includes('keyword-map')) mark(row.target, 'keyword-map target');
  for (const g of ws.config.guardrails || []) if (g && g.page) mark(g.page, `guardrail "${g.query}"`);
  for (const u of (ws.config.protect && ws.config.protect.urls) || []) if (!/[*?]/.test(u)) mark(u, 'protected');
  let incomplete = 0;
  if (files.crawlJson) {
    try {
      incomplete = Number(JSON.parse(fs.readFileSync(files.crawlJson, 'utf8')).meta.notFetched) || 0;
    } catch {
      incomplete = 0;
    }
  }
  const options = { maxPerSource: flags.maxPerSource, maxPerTarget: flags.maxPerTarget, batchSize: flags.batchSize, maxBatches: flags.maxBatches, minScore: flags.minScore, sitewideShare: flags.sitewideShare };
  const res = analyze({ linkRecords, textRecords, facts, redirects, keywordRows, opportunity, home: ws.siteUrl({ required: false }) || origin, pageGroupOf: (u) => ws.pageGroupOf(u), important, options });

  const pagesCsv = writeCsvFile(ws.dataFile('crawl', 'internal-links', 'csv'), res.pages.map((p) => ({
    url: p.url,
    eligible: p.eligible ? 'yes' : 'no',
    link_score: p.linkScore === null ? '' : p.linkScore.toFixed(1),
    pagerank: p.pagerank.toExponential(4),
    inlinks_total: p.inlinksTotal,
    inlinks_body: p.inlinksBody,
    inlinks_nav: p.inlinksNav,
    outlinks: p.outlinks,
    depth: p.depth === null ? '' : p.depth,
    in_sitemap: p.inSitemap ? 'yes' : '',
    orphan: p.orphan ? 'yes' : '',
    weak_contextual: p.weakContextual ? 'yes' : '',
    deep: p.deep ? (p.depth === null ? 'unreachable' : 'yes') : '',
    important: p.important,
    keywords: p.keywords.join(' | '),
    page_group: p.pageGroup,
  })).sort((a, b) => (Number(b.link_score) || -1) - (Number(a.link_score) || -1)), ['url', 'eligible', 'link_score', 'pagerank', 'inlinks_total', 'inlinks_body', 'inlinks_nav', 'outlinks', 'depth', 'in_sitemap', 'orphan', 'weak_contextual', 'deep', 'important', 'keywords', 'page_group']);
  const sugCols = ['source', 'target', 'anchor', 'snippet', 'placement', 'reason', 'score', 'batch', 'keyword', 'link_type', 'target_body_inlinks', 'source_link_score'];
  const sugCsv = writeCsvFile(ws.dataFile('crawl', 'link-suggestions', 'csv'), res.suggestions, sugCols);
  const b1 = res.suggestions.filter((s) => s.batch === 'B1');
  const extra = [];
  if (b1.length) {
    extra.push(writeText(ws.dataFile('crawl', 'link-suggestions-B1-sources', 'txt'), `${[...new Set(b1.map((s) => s.source))].join('\n')}\n`));
    extra.push(writeText(ws.dataFile('crawl', 'link-suggestions-B1-targets', 'txt'), `${[...new Set(b1.map((s) => s.target))].join('\n')}\n`));
  }
  const meta = { today: ws.today(), source: path.basename(files.links), incomplete, noText: !files.text, keywordRows: keywordRows.length, top: flags.top, maxPerSource: flags.maxPerSource, maxPerTarget: flags.maxPerTarget, suggestionsCsv: sugCsv, sitewideShare: flags.sitewideShare };
  const md = writeText(ws.path('logs', 'reviews', `${ws.today()}-internal-links.md`), renderReport(res, meta));
  const elig = res.pages.filter((p) => p.eligible);
  const weakImportant = elig.filter((p) => p.important && p.weakContextual);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ pages: res.pages.length, eligible: elig.length, iterations: res.iterations, home: res.home, orphans: elig.filter((p) => p.orphan).map((p) => p.url), deep: elig.filter((p) => p.deep).map((p) => p.url), weakImportant: weakImportant.map((p) => p.url), suggestions: res.suggestions, files: { pages: pagesCsv, suggestions: sugCsv, report: md } }, null, 2)}\n`);
    return 0;
  }
  out(`${res.pages.length} pages in the link graph (${elig.length} eligible), home ${shortUrl(res.home)}, PageRank converged in ${res.iterations} iterations.`);
  out(`Orphans: ${elig.filter((p) => p.orphan).length}; deeper than 3 clicks: ${elig.filter((p) => p.deep && !p.orphan).length}; important pages with <= 1 contextual inlink: ${weakImportant.length}`);
  if (incomplete) out(`WARNING: crawl incomplete (${incomplete} URLs not fetched): inlinks, orphans and depth undercount.`);
  const topPages = elig.slice().sort((a, b) => b.linkScore - a.linkScore).slice(0, 5);
  out(textTable(['page', 'link score', 'body/nav inlinks'], topPages.map((p) => [shortUrl(p.url), p.linkScore.toFixed(0), `${p.inlinksBody}/${p.inlinksNav}`])));
  out(`Suggestions: ${res.suggestions.length} (${b1.length} in B1)${keywordRows.length ? '' : ' - keyword-map.csv has no target_url rows'}. Review by hand; never auto-apply.`);
  out(`\nwrote ${md}\nwrote ${pagesCsv}\nwrote ${sugCsv}`);
  for (const f of extra) out(`wrote ${f}`);
  log(`Next: ship B1 as one wave: ${scriptCmd('log-change.mjs')} add --kind internal-links --title "Internal links B1" --urls-file <B1-sources.txt>`);
  return 0;
}

runMain(import.meta.url, main);
