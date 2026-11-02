// Image helpers without dependencies: format + intrinsic size from the first bytes (magic bytes, never the file
// extension), data: URIs, srcset/sizes evaluation, alt-text and file-name heuristics, conversion-tool detection.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeText, CJK_RE, isStopword } from './text.mjs';

/** Bytes fetched per range request when probing an image (enough for headers, EXIF and most AVIF meta boxes). */
export const PROBE_BYTES = 65536;

/** Read-only view over one or more byte ranges of a file: [{offset, buf}] (lets the AVIF parser ask for more). */
export class ByteView {
  constructor(chunks) {
    const list = Array.isArray(chunks) ? chunks : [{ offset: 0, buf: chunks }];
    this.chunks = list.filter((c) => c && c.buf).map((c) => ({ offset: c.offset || 0, buf: Buffer.isBuffer(c.buf) ? c.buf : Buffer.from(c.buf) }));
  }

  slice(pos, len) {
    for (const c of this.chunks) if (pos >= c.offset && pos + len <= c.offset + c.buf.length) return c.buf.subarray(pos - c.offset, pos - c.offset + len);
    return null;
  }

  /** Bytes from `pos` to the end of the chunk holding it (at most `max`), or null. */
  available(pos, max) {
    for (const c of this.chunks) if (pos >= c.offset && pos < c.offset + c.buf.length) return c.buf.subarray(pos - c.offset, Math.min(c.buf.length, pos - c.offset + max));
    return null;
  }

  head() {
    const first = this.chunks.find((c) => c.offset === 0);
    return first ? first.buf : Buffer.alloc(0);
  }
}

const ascii = (b, start, end) => (b.length >= end ? b.toString('latin1', start, end) : '');

const BMFF_AVIF = new Set(['avif', 'avis']);
const BMFF_HEIF = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** Image format from magic bytes (null when unknown). SVG is sniffed as text. */
export function detectFormat(buf) {
  const b = buf || Buffer.alloc(0);
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (/^GIF8[79]a$/.test(ascii(b, 0, 6))) return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 4, 8) === 'ftyp') {
    const brands = bmffBrands(b);
    if (brands.some((x) => BMFF_AVIF.has(x))) return 'avif';
    if (brands.some((x) => BMFF_HEIF.has(x))) return 'heic';
    return null;
  }
  if (b.length >= 26 && ascii(b, 0, 2) === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(b.readUInt32LE(14))) return 'bmp';
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 && b.readUInt16LE(4) > 0) return 'ico';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0x0a) return 'jxl';
  if (b.length >= 12 && b.readUInt32BE(0) === 12 && ascii(b, 4, 8) === 'JXL ') return 'jxl';
  if (ascii(b, 0, 4) === 'II*\u0000' || ascii(b, 0, 4) === 'MM\u0000*') return 'tiff';
  if (svgRootTag(b)) return 'svg';
  return null;
}

function bmffBrands(b) {
  const size = b.length >= 8 ? b.readUInt32BE(0) : 0;
  const end = Math.min(b.length, size || b.length);
  const brands = [];
  if (end >= 12) brands.push(ascii(b, 8, 12));
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(b, i, i + 4));
  return brands;
}

/**
 * Parse format and intrinsic size from the first bytes of an image. Returns {format, width, height, animated,
 * hasAlpha, ...}; {format, needMore: {offset, length}} when an AVIF/HEIF meta box lies beyond the bytes given;
 * {format: null} when the bytes are not a known image. width/height are the displayed size (EXIF orientation and
 * HEIF rotation applied). `chunks` is a Buffer or [{offset, buf}].
 */
export function parseImageHeader(chunks, { totalBytes = null } = {}) {
  const view = chunks instanceof ByteView ? chunks : new ByteView(chunks);
  const b = view.head();
  const format = detectFormat(b);
  const base = { format, width: null, height: null, animated: false };
  try {
    switch (format) {
      case 'png':
        return { ...base, ...parsePng(b) };
      case 'jpeg':
        return { ...base, ...parseJpeg(view, totalBytes) };
      case 'gif':
        return { ...base, ...parseGif(b) };
      case 'webp':
        return { ...base, ...parseWebp(b) };
      case 'avif':
      case 'heic':
        return { ...base, ...parseIsobmff(view, totalBytes) };
      case 'svg':
        return { ...base, ...parseSvg(b) };
      case 'bmp':
        return { ...base, ...parseBmp(b) };
      case 'ico':
        return { ...base, ...parseIco(b) };
      default:
        return base;
    }
  } catch {
    return base;
  }
}

function parsePng(b) {
  let off = 8;
  const out = {};
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off);
    const type = ascii(b, off + 4, off + 8);
    if (type === 'IHDR' && off + 21 <= b.length) {
      out.width = b.readUInt32BE(off + 8);
      out.height = b.readUInt32BE(off + 12);
      out.bitDepth = b[off + 16];
      out.colorType = b[off + 17];
      out.hasAlpha = out.colorType === 4 || out.colorType === 6;
      out.palette = out.colorType === 3;
    } else if (type === 'tRNS') out.hasAlpha = true;
    else if (type === 'acTL') out.animated = true;
    else if (type === 'IDAT' || type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * JPEG: walk the segments (skipping APPn and other data by their length) to the first SOFn marker. Large
 * EXIF/XMP/ICC segments can push it past the first range: then {needMore: {offset}} asks for the bytes there.
 */
function parseJpeg(view, totalBytes) {
  let off = 2;
  let orientation = 1;
  const out = {};
  for (let guard = 0; guard < 4096; guard++) {
    if (totalBytes && off >= totalBytes) break;
    const hdr = view.slice(off, 4);
    if (!hdr) return { ...finishJpeg(out, orientation), needMore: { offset: off, length: PROBE_BYTES } };
    if (hdr[0] !== 0xff) {
      off++;
      continue;
    }
    const marker = hdr[1];
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = hdr.readUInt16BE(2);
    if (len < 2) break;
    if (SOF.has(marker)) {
      const sof = view.slice(off + 5, 4);
      if (!sof) return { ...finishJpeg(out, orientation), needMore: { offset: off, length: PROBE_BYTES } };
      out.height = sof.readUInt16BE(0);
      out.width = sof.readUInt16BE(2);
      out.progressive = [0xc2, 0xc6, 0xca, 0xce].includes(marker);
      break;
    }
    if (marker === 0xe1 && orientation === 1) {
      const seg = view.slice(off + 4, len - 2) || view.available(off + 4, len - 2);
      if (seg && ascii(seg, 0, 6) === 'Exif\u0000\u0000') orientation = exifOrientation(seg, 6, seg.length) || 1;
    }
    off += 2 + len;
  }
  return finishJpeg(out, orientation);
}

function finishJpeg(out, orientation) {
  const res = { ...out };
  if (orientation >= 5 && orientation <= 8 && res.width) [res.width, res.height] = [res.height, res.width];
  if (orientation !== 1) res.orientation = orientation;
  return res;
}

function exifOrientation(b, tiff, end) {
  if (tiff + 8 > end) return null;
  const order = ascii(b, tiff, tiff + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (p) => (le ? b.readUInt16LE(p) : b.readUInt16BE(p));
  const u32 = (p) => (le ? b.readUInt32LE(p) : b.readUInt32BE(p));
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return null;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

function skipSubBlocks(b, off) {
  while (off < b.length) {
    const size = b[off];
    off += 1;
    if (size === 0) return off;
    off += size;
  }
  return -1;
}

function parseGif(b) {
  const out = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  const flags = b[10];
  let off = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  let frames = 0;
  let loop = false;
  while (off < b.length) {
    const id = b[off];
    if (id === 0x2c) {
      frames++;
      if (frames > 1 || off + 10 > b.length) break;
      const lflags = b[off + 9];
      off += 10 + (lflags & 0x80 ? 3 * (1 << ((lflags & 7) + 1)) : 0) + 1;
      off = skipSubBlocks(b, off);
      if (off < 0) break;
    } else if (id === 0x21) {
      if (b[off + 1] === 0xff && ascii(b, off + 3, off + 14) === 'NETSCAPE2.0') loop = true;
      off = skipSubBlocks(b, off + 2);
      if (off < 0) break;
    } else break;
  }
  out.animated = frames > 1 || loop;
  out.frames = frames;
  return out;
}

function parseWebp(b) {
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, lossless: false };
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasAlpha: Boolean((bits >>> 28) & 1), lossless: true };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    const flags = b[20];
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), animated: Boolean(flags & 0x02), hasAlpha: Boolean(flags & 0x10) };
  }
  return {};
}

function boxes(buf, start = 0, end = buf.length) {
  const list = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = ascii(buf, off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) size = end - off;
    if (size < header || off + size > end) break;
    list.push({ type, start: off + header, end: off + size });
    off += size;
  }
  return list;
}

/** ISO BMFF (AVIF/HEIF): brands from ftyp, size from the primary item's ispe property (meta/iprp/ipco + ipma). */
function parseIsobmff(view, totalBytes) {
  let off = 0;
  const out = {};
  for (let guard = 0; guard < 64; guard++) {
    if (totalBytes && off >= totalBytes) break;
    const hdr = view.slice(off, 8);
    if (!hdr) return { ...out, needMore: { offset: off, length: PROBE_BYTES } };
    let size = hdr.readUInt32BE(0);
    const type = ascii(hdr, 4, 8);
    let header = 8;
    if (size === 1) {
      const big = view.slice(off + 8, 8);
      if (!big) return { ...out, needMore: { offset: off, length: PROBE_BYTES } };
      size = Number(big.readBigUInt64BE(0));
      header = 16;
    } else if (size === 0) size = totalBytes ? totalBytes - off : Infinity;
    if (size < header) break;
    if (type === 'ftyp') {
      const body = view.slice(off + header, Math.min(size, 256) - header);
      if (body) {
        const brands = [ascii(body, 0, 4)];
        for (let i = 8; i + 4 <= body.length; i += 4) brands.push(ascii(body, i, i + 4));
        out.brands = brands;
        out.animated = brands.includes('avis') || brands.includes('msf1') || brands.includes('heis');
      }
    } else if (type === 'meta') {
      if (!Number.isFinite(size)) break;
      const body = view.slice(off + header, size - header);
      if (!body) return { ...out, needMore: { offset: off, length: Math.min(size, 1024 * 1024) } };
      return { ...out, ...parseHeifMeta(body) };
    }
    if (!Number.isFinite(size)) break;
    off += size;
  }
  return out;
}

function parseHeifMeta(body) {
  // meta is a FullBox: 4 bytes version/flags before the children
  const children = boxes(body, 4);
  let primary = null;
  const props = [];
  const assoc = new Map();
  for (const box of children) {
    if (box.type === 'pitm') primary = body[box.start] === 0 ? body.readUInt16BE(box.start + 4) : body.readUInt32BE(box.start + 4);
    if (box.type !== 'iprp') continue;
    for (const inner of boxes(body, box.start, box.end)) {
      if (inner.type === 'ipco') for (const p of boxes(body, inner.start, inner.end)) props.push(p);
      if (inner.type === 'ipma') {
        const version = body[inner.start];
        const flags = body.readUIntBE(inner.start + 1, 3);
        let p = inner.start + 4;
        const count = body.readUInt32BE(p);
        p += 4;
        for (let i = 0; i < count && p < inner.end; i++) {
          const item = version < 1 ? body.readUInt16BE(p) : body.readUInt32BE(p);
          p += version < 1 ? 2 : 4;
          const n = body[p];
          p += 1;
          const list = [];
          for (let j = 0; j < n; j++) {
            if (flags & 1) {
              list.push(body.readUInt16BE(p) & 0x7fff);
              p += 2;
            } else {
              list.push(body[p] & 0x7f);
              p += 1;
            }
          }
          assoc.set(item, list);
        }
      }
    }
  }
  const ispe = (p) => ({ width: body.readUInt32BE(p.start + 4), height: body.readUInt32BE(p.start + 8) });
  let size = null;
  let rotate = 0;
  const own = primary !== null && assoc.has(primary) ? assoc.get(primary).map((i) => props[i - 1]).filter(Boolean) : [];
  for (const p of own) {
    if (p.type === 'ispe' && !size) size = ispe(p);
    if (p.type === 'irot') rotate = body[p.start] & 3;
  }
  if (!size) {
    for (const p of props) {
      if (p.type !== 'ispe') continue;
      const s = ispe(p);
      if (!size || s.width * s.height > size.width * size.height) size = s;
    }
  }
  if (!size) return {};
  return rotate === 1 || rotate === 3 ? { width: size.height, height: size.width } : size;
}

function svgRootTag(b) {
  let s = b.subarray(0, 8192).toString('utf8').replace(/^\uFEFF/, '');
  for (let i = 0; i < 20; i++) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('<?')) {
      const e = s.indexOf('?>');
      s = e < 0 ? '' : s.slice(e + 2);
    } else if (s.startsWith('<!--')) {
      const e = s.indexOf('-->');
      s = e < 0 ? '' : s.slice(e + 3);
    } else if (/^<!doctype/i.test(s)) {
      const gt = s.indexOf('>');
      const open = s.indexOf('[');
      const e = open >= 0 && (gt < 0 || open < gt) ? s.indexOf(']>', open) + 1 : gt;
      s = e <= 0 ? '' : s.slice(e + 1);
    } else break;
  }
  const m = /^<svg\b[^>]*>/i.exec(s);
  return m ? m[0] : '';
}

const SVG_UNITS = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

function svgLength(v) {
  const m = /^\s*([\d.]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(String(v || ''));
  return m ? Number(m[1]) * SVG_UNITS[(m[2] || '').toLowerCase()] : null;
}

function parseSvg(b) {
  const tag = svgRootTag(b);
  const attr = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
    return m ? (m[2] ?? m[3]) : null;
  };
  let width = svgLength(attr('width'));
  let height = svgLength(attr('height'));
  const vb = (attr('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (!width && !height) [width, height] = [vb[2], vb[3]];
    else if (width && !height) height = (width * vb[3]) / vb[2];
    else if (height && !width) width = (height * vb[2]) / vb[3];
  }
  return { width: width ? Math.round(width) : null, height: height ? Math.round(height) : null, vector: true };
}

function parseBmp(b) {
  const dib = b.readUInt32LE(14);
  if (dib === 12) return { width: b.readUInt16LE(18), height: b.readUInt16LE(20) };
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

function parseIco(b) {
  const count = Math.min(b.readUInt16LE(4), 32);
  let best = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    if (e + 2 > b.length) break;
    const w = b[e] || 256;
    const h = b[e + 1] || 256;
    if (!best || w * h > best.width * best.height) best = { width: w, height: h };
  }
  return best || {};
}

/** Decode a data: URI into {mime, buf} (base64 or percent-encoded); null when malformed. */
export function parseDataUri(uri) {
  const m = /^data:([^,;]*)((?:;[^,;]*)*?)(;base64)?,(.*)$/is.exec(String(uri || '').trim());
  if (!m) return null;
  try {
    const buf = m[3] ? Buffer.from(m[4].replace(/\s+/g, ''), 'base64') : Buffer.from(decodeURIComponent(m[4]), 'utf8');
    return { mime: (m[1] || 'text/plain').toLowerCase(), buf };
  } catch {
    return null;
  }
}

// ---------- srcset / sizes ----------

/** HTML srcset candidates: [{url, w?, x?, h?}] (URLs may contain commas; descriptors end at a top-level comma). */
export function parseSrcset(value) {
  const s = String(value || '');
  const outList = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptors = '';
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      let depth = 0;
      start = i;
      while (i < s.length) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
        i++;
      }
      descriptors = s.slice(start, i).trim();
      i++;
    }
    if (!url) continue;
    const cand = { url };
    let invalid = false;
    for (const tok of descriptors.split(/\s+/).filter(Boolean)) {
      const m = /^(\d*\.?\d+)([wxh])$/i.exec(tok);
      if (!m) continue;
      const v = Number(m[1]);
      if (!(v > 0)) invalid = true;
      cand[m[2].toLowerCase()] = v;
    }
    if (invalid) continue;
    if (!cand.w && !cand.x) cand.x = 1;
    outList.push(cand);
  }
  return outList;
}

function splitTopLevel(value, sep = ',') {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of String(value || '')) {
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const FONT_PX = 16;

/** CSS length (px, vw, vh, em, rem, %, calc/min/max/clamp) in CSS px for a viewport; null when not computable. */
export function evalLength(value, viewport, viewportHeight = Math.round(viewport * 2)) {
  const src = String(value || '').trim().toLowerCase();
  if (src.length > 500) return null;
  let i = 0;
  let depth = 0;
  const peek = () => src[i];
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const unit = (n, u) => {
    if (!u || u === 'px') return n;
    if (u === 'vw' || u === 'dvw' || u === 'svw' || u === 'lvw' || u === '%') return (n * viewport) / 100;
    if (u === 'vh' || u === 'dvh' || u === 'svh' || u === 'lvh') return (n * viewportHeight) / 100;
    if (u === 'vmin') return (n * Math.min(viewport, viewportHeight)) / 100;
    if (u === 'vmax') return (n * Math.max(viewport, viewportHeight)) / 100;
    if (u === 'em' || u === 'rem') return n * FONT_PX;
    if (u === 'ch' || u === 'ex') return n * 8;
    return NaN;
  };
  const expr = () => {
    let v = term();
    for (;;) {
      ws();
      const c = peek();
      if (c !== '+' && c !== '-') return v;
      i++;
      const r = term();
      v = c === '+' ? v + r : v - r;
    }
  };
  const term = () => {
    let v = factor();
    for (;;) {
      ws();
      const c = peek();
      if (c !== '*' && c !== '/') return v;
      i++;
      const r = factor();
      v = c === '*' ? v * r : v / r;
    }
  };
  const factor = () => {
    ws();
    const fn = /^(calc|min|max|clamp)\(/.exec(src.slice(i, i + 8));
    if (fn) {
      if (++depth > 32) return NaN;
      i += fn[0].length;
      const args = [expr()];
      ws();
      while (peek() === ',') {
        i++;
        args.push(expr());
        ws();
      }
      if (peek() === ')') i++;
      depth--;
      if (fn[1] === 'calc') return args[0];
      if (fn[1] === 'min') return Math.min(...args);
      if (fn[1] === 'max') return Math.max(...args);
      return Math.min(Math.max(args[1], args[0]), args[2]);
    }
    if (peek() === '(') {
      if (++depth > 32) return NaN;
      i++;
      const v = expr();
      ws();
      if (peek() === ')') i++;
      depth--;
      return v;
    }
    const m = /^(-?\d*\.?\d+)([a-z%]*)/.exec(src.slice(i, i + 40));
    if (!m) return NaN;
    i += m[0].length;
    return unit(Number(m[1]), m[2]);
  };
  const v = expr();
  ws();
  return i === src.length && Number.isFinite(v) ? v : null;
}

function mediaMatches(cond, viewport) {
  let c = cond.trim().toLowerCase();
  let negate = false;
  if (c.startsWith('not ')) {
    negate = true;
    c = c.slice(4);
  }
  if (/\bor\b/.test(c)) return null;
  const parts = c.split(/\s+and\s+/);
  let ok = true;
  for (const p of parts) {
    const range = /^\(\s*(?:width\s*(<=|<|>=|>)\s*([^)]+?)|([^)]+?)\s*(<=|<|>=|>)\s*width)\s*\)$/.exec(p.trim());
    if (range) {
      const flip = { '<=': '>=', '<': '>', '>=': '<=', '>': '<' };
      const op = range[1] || flip[range[4]];
      const px = evalLength(range[2] || range[3], viewport);
      if (px === null) return null;
      if (!(op === '<=' ? viewport <= px : op === '<' ? viewport < px : op === '>=' ? viewport >= px : viewport > px)) ok = false;
      continue;
    }
    const m = /^\(\s*(min|max)-width\s*:\s*([^)]+)\)$/.exec(p.trim());
    if (!m) {
      if (/^\(\s*(orientation|prefers-|hover|pointer|resolution|min-resolution|-webkit)/.test(p.trim())) continue;
      return null;
    }
    const px = evalLength(m[2], viewport);
    if (px === null) return null;
    if (m[1] === 'min' ? !(viewport >= px) : !(viewport <= px)) ok = false;
  }
  return negate ? !ok : ok;
}

/** [entry, media condition, length] of one sizes entry: the length is the last top-level token. */
function splitSizeEntry(entry) {
  const e = entry.trim();
  let depth = 0;
  for (let i = e.length - 1; i >= 0; i--) {
    const c = e[i];
    if (c === ')') depth++;
    else if (c === '(') depth--;
    else if (/\s/.test(c) && depth === 0) {
      const value = e.slice(i + 1);
      return /^((calc|min|max|clamp)\(.*\)|-?[\d.]+[a-z%]*)$/i.test(value) ? [e, e.slice(0, i), value] : null;
    }
  }
  return /^((calc|min|max|clamp)\(.*\)|-?[\d.]+[a-z%]*)$/i.test(e) ? [e, '', e] : null;
}

/**
 * Slot width (CSS px) a browser computes from a sizes attribute at a viewport width. "auto" entries are skipped
 * (they only apply to lazy images); no match = 100vw.
 */
export function evalSizes(sizes, viewport) {
  if (String(sizes || '').length > 2000) return viewport;
  for (const entry of splitTopLevel(sizes)) {
    if (/^auto$/i.test(entry)) continue;
    const m = splitSizeEntry(entry);
    if (!m) continue;
    const cond = m[1].trim();
    if (cond) {
      const ok = mediaMatches(cond, viewport);
      if (!ok) continue;
    }
    const px = evalLength(m[2], viewport);
    if (px !== null && px > 0) return px;
  }
  return viewport;
}

/** Candidate a browser would pick for a slot width (CSS px) at a device pixel ratio: smallest density >= dpr, else the largest. */
export function chooseCandidate(candidates, slotPx, dpr = 1, src = '') {
  const list = (candidates || []).filter((c) => c && c.url);
  const wList = list.filter((c) => c.w).sort((a, b) => a.w - b.w);
  if (wList.length) return wList.find((c) => c.w / slotPx >= dpr) || wList[wList.length - 1];
  const xList = list.filter((c) => c.x).slice();
  if (src && !xList.some((c) => c.x === 1)) xList.push({ url: src, x: 1 });
  xList.sort((a, b) => a.x - b.x);
  return xList.find((c) => c.x >= dpr) || xList[xList.length - 1] || null;
}

// ---------- alt text and file names ----------

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|heic|ico)$/i;
const CAMERA_RE = /^(img|dsc|dscn|dscf|dcim|pxl|mvimg|gopr|photo|image|picture|pic|screenshot|screen[ _-]?shot|untitled|unnamed|download|final|copy|new|scan)[\s_()-]*\d*[\s_()-]*\d*$/i;
const CAMERA_ALT_RE = /^((img|dsc|dscn|dscf|dcim|pxl|mvimg|gopr|photo|image|picture|pic|screenshot|scan)[\s_-]*\d{2,}|(untitled|unnamed)([\s_-]*\d+)?)$/i;

/** Original image URL behind optimizer endpoints (/_next/image?url=..., /_vercel/image?url=..., ?src=...). */
export function unwrapImageUrl(url, depth = 0) {
  const raw = String(url || '');
  if (raw.length > 4096) return raw.slice(0, 4096);
  let u;
  try {
    u = new URL(raw, 'http://x.invalid/');
  } catch {
    return raw;
  }
  if (depth >= 3) return u.href;
  for (const key of ['url', 'src', 'image', 'img', 'file']) {
    const v = u.searchParams.get(key);
    if (v && (/^(https?:)?\//i.test(v) || IMAGE_EXT_RE.test(v.split(/[?#]/)[0]))) return unwrapImageUrl(v, depth + 1);
  }
  return u.href;
}

/** Decoded file name (with extension) of an image URL, looking through optimizer endpoints. */
export function fileName(url) {
  let p = unwrapImageUrl(url);
  try {
    p = new URL(p, 'http://x.invalid/').pathname;
  } catch {
    /* keep */
  }
  const name = p.split('/').pop() || '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** File name without extension. */
export function fileBase(url) {
  return fileName(url).replace(IMAGE_EXT_RE, '');
}

const VARIANT_PARAMS = new Set(['w', 'width', 'h', 'height', 'q', 'quality', 'fit', 'format', 'fm', 'auto', 'dpr', 'v', 'ver', 'version', 'resize', 'crop', 'size', 'sz', 'tr', 'ixlib', 'ssl']);

/** Identity of an image across size variants: optimizer unwrapped, query dropped, -300x200 / -scaled / @2x / -640w removed. */
export function variantKey(url) {
  let u;
  try {
    u = new URL(unwrapImageUrl(url), 'http://x.invalid/');
  } catch {
    return String(url || '');
  }
  const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  const name = (u.pathname.split('/').pop() || '').replace(/(-\d{2,5}x\d{2,5}|-scaled|@\dx|-\d{2,4}w)(?=\.[a-z0-9]+$)/gi, '');
  const keep = [...u.searchParams.entries()].filter(([k]) => !VARIANT_PARAMS.has(k.toLowerCase())).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  return `${u.host}${dir}${name}${query}`.toLowerCase();
}

/** Reason a file name says nothing about the image ('' when fine). */
export function nonDescriptiveName(url) {
  const base = fileBase(url);
  if (!base) return '';
  const stem = base.replace(/[-_.@](\d{2,4}w|\d{2,4}x\d{2,4}|\d{2,4}|(?=[a-f]*\d)[0-9a-f]{6,12}|scaled|min|large|medium|small|thumb)$/i, '');
  if (CAMERA_RE.test(stem) || CAMERA_RE.test(base)) return `camera/CMS default name "${base}"`;
  if (/^\d+$/.test(stem)) return `number-only name "${base}"`;
  if (/^[0-9a-f]{16,}$/i.test(stem.replace(/-/g, ''))) return `hash/UUID name "${base}"`;
  if (/\(\d+\)$|(^|[-_ ])(final|copy|v\d+|new|edited)[-_ ]?\d*$/i.test(stem) || /最終|副本/.test(stem)) return `draft-style name "${base}"`;
  return '';
}

/** Source text contains spaces or raw non-ASCII characters that should be percent-encoded. */
export function unencodedName(rawSrc) {
  const s = String(rawSrc || '');
  if (!s || s.startsWith('data:')) return false;
  return /\s/.test(s.trim()) || /[^\x21-\x7e]/.test(s.trim());
}

const ALT_PREFIX_RE = /^\s*((an?\s+)?(image|picture|photo|photograph|graphic|img|screenshot)\s+of\b|(圖片|图片|圖|图|照片|相片)\s*[:：])/i;

/** Alt-text problems: [{rule, detail}] (rules: alt-filename, alt-too-long, alt-stuffed, alt-redundant-prefix). */
export function altProblems(alt, src = '') {
  const a = String(alt ?? '').trim();
  if (!a) return [];
  const found = [];
  const slugText = normalizeText(fileBase(src).replace(/[-_]+/g, ' '));
  const sameAsSlug = slugText && normalizeText(a.replace(/[-_]+/g, ' ')) === slugText && (!/\s/.test(a) || /\w[-_]\w/.test(a));
  if (IMAGE_EXT_RE.test(a) || CAMERA_ALT_RE.test(a) || sameAsSlug) {
    found.push({ rule: 'alt-filename', detail: `alt looks like a file name: "${a.slice(0, 60)}"` });
  }
  const cjk = [...a].filter((ch) => CJK_RE.test(ch)).length;
  const len = [...a].length;
  if (cjk > 40) found.push({ rule: 'alt-too-long', detail: `${cjk} CJK characters (aim for about 10-40): "${a.slice(0, 50)}..."` });
  else if (!cjk && len > 125) found.push({ rule: 'alt-too-long', detail: `${len} characters (aim for about 125 or fewer): "${a.slice(0, 60)}..."` });
  else if (cjk && len - cjk > 125) found.push({ rule: 'alt-too-long', detail: `${len} characters: "${a.slice(0, 50)}..."` });
  const stuffed = stuffingReason(a);
  if (stuffed) found.push({ rule: 'alt-stuffed', detail: `${stuffed}: "${a.slice(0, 80)}"` });
  if (ALT_PREFIX_RE.test(a)) found.push({ rule: 'alt-redundant-prefix', detail: `starts with "${ALT_PREFIX_RE.exec(a)[0].trim()}": screen readers already announce an image` });
  return found;
}

function stuffingReason(alt) {
  const norm = normalizeText(alt);
  const words = norm.split(/\s+/).filter((w) => w && !CJK_RE.test(w) && w.length >= 3 && !isStopword(w));
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  const rep = [...counts].find(([, n]) => n >= 3);
  if (rep) return `"${rep[0]}" repeated ${rep[1]} times`;
  const items = alt.split(/\s*[,|、;／/]\s*|\s+[-–]\s+/).map((x) => x.trim()).filter(Boolean);
  if (items.length >= 4 && items.every((x) => x.split(/\s+/).length <= 3 && [...x].length <= 24)) {
    const tokenSets = items.map((x) => new Set(normalizeText(x).split(/\s+/).filter((w) => w.length >= 2 && !isStopword(w))));
    const shared = tokenSets.some((a, i) => tokenSets.some((b, j) => j > i && [...a].some((w) => b.has(w))));
    if (shared) return `${items.length}-item keyword list`;
  }
  const frags = norm.split(/\s+/).filter(Boolean);
  const cjkFrags = frags.filter((f) => CJK_RE.test(f));
  if (cjkFrags.length >= 3 && cjkFrags.length === frags.length && frags.every((f) => [...f].length <= 6)) {
    const overlap = cjkFrags.some((f, i) => cjkFrags.some((g, j) => i !== j && f.length >= 2 && g.includes(f)));
    if (overlap) return `${cjkFrags.length} space-separated keyword fragments`;
  }
  return '';
}

// ---------- conversion tools ----------

/** Absolute path of an executable found in PATH (null when missing). */
export function which(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Image converters in PATH: {cwebp, avifenc, sharp, magick, convert} (legacy convert only when it is ImageMagick). */
export function detectTools(env = process.env) {
  const tools = { cwebp: which('cwebp', env), avifenc: which('avifenc', env), sharp: which('sharp', env), magick: which('magick', env), convert: null };
  if (tools.avifenc) {
    const r = spawnSync(tools.avifenc, ['--help'], { encoding: 'utf8', timeout: 5000, env });
    tools.avifencLegacy = !/--qcolor|\s-q[,\s]/.test(`${r.stdout || ''}${r.stderr || ''}`);
  }
  const legacy = which('convert', env);
  if (legacy) {
    const r = spawnSync(legacy, ['-version'], { encoding: 'utf8', timeout: 5000, env });
    if (/ImageMagick/i.test(`${r.stdout || ''}${r.stderr || ''}`)) tools.convert = legacy;
  }
  return tools;
}

export const INSTALL_HINTS = [
  'macOS (Homebrew): brew install webp libavif imagemagick',
  'Debian/Ubuntu: sudo apt install webp libavif-bin imagemagick',
  'Any OS with Node.js: npm i -g sharp-cli   (provides the "sharp" command; WebP and AVIF)',
];

/**
 * Command for one conversion (argument array, no shell): {tool, cmd, args, note} or null when no installed tool
 * can do it. format: webp | avif; resizeTo: target width or null (never enlarges: callers pass it only when wider).
 */
export function conversionCommand(tools, { input, output, inFormat, format, quality, resizeTo }) {
  const q = String(quality);
  // libavif < 1.0 (Debian 12, Ubuntu 22.04) has no -q: map quality to the 0-63 quantizer (lower = better)
  const avifQuality = tools.avifencLegacy ? ['--min', String(Math.round(((100 - quality) * 63) / 100)), '--max', String(Math.round(((100 - quality) * 63) / 100))] : ['-q', q];
  if (format === 'webp') {
    if (tools.cwebp && ['jpeg', 'png', 'webp', 'tiff'].includes(inFormat)) {
      return { tool: 'cwebp', cmd: tools.cwebp, args: ['-q', q, '-m', '6', '-metadata', 'none', ...(resizeTo ? ['-resize', String(resizeTo), '0'] : []), input, '-o', output] };
    }
  } else if (tools.avifenc && ['jpeg', 'png'].includes(inFormat) && !resizeTo) {
    return { tool: 'avifenc', cmd: tools.avifenc, args: [...avifQuality, '-s', '6', input, output] };
  }
  if (tools.sharp) {
    return { tool: 'sharp', cmd: tools.sharp, args: ['-i', input, '-o', output, '-f', format, '-q', q, ...(resizeTo ? ['resize', String(resizeTo)] : [])] };
  }
  const im = tools.magick || tools.convert;
  if (im) {
    return { tool: tools.magick ? 'magick' : 'convert', cmd: im, args: [input, ...(resizeTo ? ['-resize', `${resizeTo}x>`] : []), '-quality', q, '-strip', output] };
  }
  if (format === 'avif' && tools.avifenc && ['jpeg', 'png'].includes(inFormat)) {
    return { tool: 'avifenc', cmd: tools.avifenc, args: [...avifQuality, '-s', '6', input, output], note: 'avifenc cannot resize: kept the original width (install sharp-cli or ImageMagick for --max-width)' };
  }
  return null;
}
