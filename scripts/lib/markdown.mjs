// Minimal Markdown reader: front matter, headings, links, paragraphs and plain text.
import { textStats } from './text.mjs';

function parseScalar(v) {
  const s = v.trim();
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return s.slice(1, -1);
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  return s;
}

/** YAML-ish (key: value, simple lists) or TOML-ish (+++ key = value) front matter. */
export function parseFrontMatter(src) {
  const text = String(src || '').replace(/^\uFEFF/, '');
  const m = /^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let lastKey = '';
  for (const line of m[2].split(/\r?\n/)) {
    const list = /^\s*-\s+(.*)$/.exec(line);
    if (list && lastKey) {
      if (!Array.isArray(data[lastKey])) data[lastKey] = data[lastKey] ? [data[lastKey]] : [];
      data[lastKey].push(parseScalar(list[1]));
      continue;
    }
    const kv = m[1] === '+++' ? /^([\w.-]+)\s*=\s*(.*)$/.exec(line) : /^([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1].toLowerCase();
      data[lastKey] = kv[2] === '' ? '' : parseScalar(kv[2]);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

export function parseMarkdown(src) {
  const { data, body } = parseFrontMatter(src);
  const withoutCode = body.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, '\n');
  const headings = [];
  const links = [];
  const images = [];
  const paragraphs = [];
  const blocks = [];
  let current = [];
  const flush = () => {
    const t = current.join(' ').replace(/\s+/g, ' ').trim();
    if (t) {
      paragraphs.push(t);
      blocks.push({ type: 'p', text: t });
    }
    current = [];
  };
  const inlineText = (s) =>
    s
      .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt, src2) => {
        images.push({ src: src2.split(/\s+/)[0], alt });
        return '';
      })
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, label, href) => {
        links.push({ href: href.split(/\s+/)[0].replace(/^<|>$/g, ''), text: label });
        return label;
      })
      .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_, href, label) => {
        links.push({ href, text: label.replace(/<[^>]+>/g, '') });
        return label;
      })
      .replace(/<[^>]+>/g, ' ')
      .replace(/[*_`~]+/g, '')
      .trim();
  const lines = withoutCode.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const setext = i + 1 < lines.length && line.trim() && /^(=+|-+)\s*$/.test(lines[i + 1]) && !/^\s*[-*+]\s/.test(line);
    if (h) {
      flush();
      headings.push({ level: h[1].length, text: inlineText(h[2]) });
      blocks.push({ type: 'h', ...headings[headings.length - 1] });
    } else if (setext) {
      flush();
      headings.push({ level: lines[i + 1].trim().startsWith('=') ? 1 : 2, text: inlineText(line) });
      blocks.push({ type: 'h', ...headings[headings.length - 1] });
      i++;
    } else if (!line.trim()) flush();
    else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const t = inlineText(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      if (t) {
        paragraphs.push(t);
        blocks.push({ type: 'li', text: t });
      }
    } else if (/^\s*>/.test(line)) current.push(inlineText(line.replace(/^\s*>\s?/, '')));
    else if (/^\s*\|/.test(line)) {
      flush();
    } else current.push(inlineText(line));
  }
  flush();
  const tables = (withoutCode.match(/^\s*\|.*\|\s*\n\s*\|[\s:|-]+\|\s*$/gm) || []).length;
  const lists = (withoutCode.match(/(^|\n)(\s*([-*+]|\d+[.)])\s+.*\n?){2,}/g) || []).length;
  const text = [...headings.map((x) => x.text), ...paragraphs].join('\n');
  const title = String(data.title || (headings.find((x) => x.level === 1) || {}).text || '');
  return {
    frontMatter: data,
    title,
    description: String(data.description || data.summary || data.excerpt || ''),
    headings,
    links,
    images,
    paragraphs,
    blocks,
    text,
    stats: textStats(paragraphs.join('\n')),
    counts: { tables, lists },
    dates: {
      published: String(data.date || data.published || data.pubdate || data.publishdate || ''),
      modified: String(data.updated || data.lastmod || data.modified || data.last_modified || data.updated_at || ''),
    },
  };
}
