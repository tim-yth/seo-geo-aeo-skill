import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test, assert, tmpDir, makeWorkspace, runScript, runScriptSync, editConfig, dataFile } from './harness.mjs';
import { csvToRecords } from '../lib/csv.mjs';
import { parseImageHeader, detectFormat, parseSrcset, evalSizes, evalLength, chooseCandidate, altProblems, nonDescriptiveName, unencodedName, parseDataUri, conversionCommand, variantKey, fileName } from '../lib/images.mjs';
import { RULES, auditPage, siteIssues, findLcp, formatSaving, jsonLdImageRefs, htmlExtras, collapseIssues, planConvert } from '../image-audit.mjs';

// ---------- tiny binary builders ----------
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function png(w, h, { colorType = 2, apng = false, pad = 0 } = {}) {
  const chunk = (type, data) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, colorType, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...(apng ? [chunk('acTL', Buffer.alloc(8))] : []), chunk('IDAT', Buffer.alloc(pad, 7)), chunk('IEND', Buffer.alloc(0))]);
}

function jpeg(w, h, { orientation = 0, progressive = false, pad = 0 } = {}) {
  const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]);
  const parts = [Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000', 'latin1'))];
  if (orientation) {
    const tiff = Buffer.concat([Buffer.from('MM', 'latin1'), u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), u16(0), u32(0)]);
    parts.push(seg(0xe1, Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff])));
  }
  parts.push(seg(progressive ? 0xc2 : 0xc0, Buffer.concat([Buffer.from([8]), u16(h), u16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])])));
  parts.push(seg(0xda, Buffer.alloc(10)), Buffer.alloc(pad, 0x11), Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/** JPEG with large APP1/APP2 segments before the SOF marker (needs more than one 64 KB range). */
function jpegBigHeader(w, h) {
  const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.alloc(60000, 0x41)), seg(0xe2, Buffer.alloc(30000, 0x42)), seg(0xc0, Buffer.concat([Buffer.from([8]), u16(h), u16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])])), seg(0xda, Buffer.alloc(10)), Buffer.alloc(20000, 0x11), Buffer.from([0xff, 0xd9])]);
}

function gif(w, h, { frames = 1, loop = false } = {}) {
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0x80;
  const parts = [Buffer.from('GIF89a', 'latin1'), lsd, Buffer.alloc(6)];
  if (loop) parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0]));
  for (let i = 0; i < frames; i++) {
    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(w, 5);
    id.writeUInt16LE(h, 7);
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]), id, Buffer.from([2, 2, 0x44, 1, 0]));
  }
  parts.push(Buffer.from([0x3b]), Buffer.alloc(frames > 1 ? 60000 : 0));
  return Buffer.concat(parts);
}

function riff(type, payload) {
  const ch = Buffer.alloc(8);
  ch.write(type, 0, 'latin1');
  ch.writeUInt32LE(payload.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ch, payload]);
  const hdr = Buffer.alloc(8);
  hdr.write('RIFF', 0, 'latin1');
  hdr.writeUInt32LE(body.length, 4);
  return Buffer.concat([hdr, body]);
}
const webpLossy = (w, h, pad = 20) => {
  const p = Buffer.alloc(10 + pad);
  Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a]).copy(p, 0);
  p.writeUInt16LE(w, 6);
  p.writeUInt16LE(h, 8);
  return riff('VP8 ', p);
};
const webpLossless = (w, h) => {
  const p = Buffer.alloc(10);
  p[0] = 0x2f;
  p.writeUInt32LE(((w - 1) | ((h - 1) << 14) | (1 << 28)) >>> 0, 1);
  return riff('VP8L', p);
};
const webpExtended = (w, h, animated) => {
  const p = Buffer.alloc(10);
  p[0] = animated ? 0x12 : 0x10;
  p.writeUIntLE(w - 1, 4, 3);
  p.writeUIntLE(h - 1, 7, 3);
  return riff('VP8X', p);
};

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
const fullbox = (type, version, flags, ...parts) => {
  const vf = Buffer.alloc(4);
  vf[0] = version;
  vf.writeUIntBE(flags, 1, 3);
  return box(type, vf, ...parts);
};
function avif(w, h, { mdatFirst = false, rotate = 0 } = {}) {
  const ftyp = box('ftyp', Buffer.from('avif', 'latin1'), Buffer.alloc(4), Buffer.from('mif1miafavif', 'latin1'));
  const props = [fullbox('ispe', 0, 0, u32(64), u32(64)), fullbox('ispe', 0, 0, u32(w), u32(h)), ...(rotate ? [box('irot', Buffer.from([rotate]))] : [])];
  const ipma = fullbox('ipma', 0, 0, u32(2), u16(2), Buffer.from([1, 0x81]), u16(1), Buffer.from(rotate ? [2, 0x82, 0x03] : [1, 0x82]));
  const meta = fullbox('meta', 0, 0, fullbox('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)), fullbox('pitm', 0, 0, u16(1)), box('iprp', box('ipco', ...props), ipma));
  const mdat = box('mdat', Buffer.alloc(mdatFirst ? 70000 : 200, 3));
  return Buffer.concat(mdatFirst ? [ftyp, mdat, meta] : [ftyp, meta, mdat]);
}

function bmp(w, h) {
  const b = Buffer.alloc(54);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(-h, 22);
  return b;
}

test('image-audit: --help lists every check and works without a workspace', () => {
  const r = runScriptSync('image-audit.mjs', ['--help']);
  assert.equal(r.status, 0, r.stderr);
  for (const rule of RULES) assert.ok(r.stdout.includes(`${rule.id} [${rule.severity}]`), `help lacks ${rule.id}`);
  assert.match(r.stdout, /convert <file\|dir>/);
});

test('image-audit: header parsers read format and intrinsic size from magic bytes', () => {
  assert.deepEqual(pick(parseImageHeader(png(800, 600, { colorType: 6 }))), { format: 'png', width: 800, height: 600, animated: false });
  assert.equal(parseImageHeader(png(800, 600, { colorType: 6 })).hasAlpha, true);
  assert.equal(parseImageHeader(png(10, 10, { apng: true })).animated, true);
  assert.deepEqual(pick(parseImageHeader(jpeg(1200, 600))), { format: 'jpeg', width: 1200, height: 600, animated: false });
  assert.equal(parseImageHeader(jpeg(1200, 600, { progressive: true })).progressive, true);
  assert.deepEqual(pick(parseImageHeader(jpeg(1200, 600, { orientation: 6 }))), { format: 'jpeg', width: 600, height: 1200, animated: false }, 'EXIF rotation swaps the displayed size');
  assert.deepEqual(pick(parseImageHeader(gif(320, 240))), { format: 'gif', width: 320, height: 240, animated: false });
  assert.equal(parseImageHeader(gif(320, 240, { frames: 3 })).animated, true);
  assert.equal(parseImageHeader(gif(320, 240, { loop: true })).animated, true);
  assert.deepEqual(pick(parseImageHeader(webpLossy(640, 480))), { format: 'webp', width: 640, height: 480, animated: false });
  assert.deepEqual(pick(parseImageHeader(webpLossless(333, 222))), { format: 'webp', width: 333, height: 222, animated: false });
  assert.deepEqual(pick(parseImageHeader(webpExtended(1920, 1080, true))), { format: 'webp', width: 1920, height: 1080, animated: true });
  assert.deepEqual(pick(parseImageHeader(avif(1600, 900))), { format: 'avif', width: 1600, height: 900, animated: false });
  assert.deepEqual(pick(parseImageHeader(avif(1600, 900, { rotate: 1 }))), { format: 'avif', width: 900, height: 1600, animated: false });
  const far = avif(1600, 900, { mdatFirst: true });
  const first = parseImageHeader([{ offset: 0, buf: far.subarray(0, 65536) }], { totalBytes: far.length });
  assert.equal(first.format, 'avif');
  assert.ok(first.needMore && first.needMore.offset > 65536, 'asks for the meta box further in');
  const second = parseImageHeader([{ offset: 0, buf: far.subarray(0, 65536) }, { offset: first.needMore.offset, buf: far.subarray(first.needMore.offset) }], { totalBytes: far.length });
  assert.deepEqual([second.width, second.height], [1600, 900]);
  assert.deepEqual(pick(parseImageHeader(Buffer.from('\uFEFF<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><rect/></svg>'))), { format: 'svg', width: 640, height: 480, animated: false });
  assert.deepEqual(pick(parseImageHeader(Buffer.from('<svg width="120px" height="2in"></svg>'))), { format: 'svg', width: 120, height: 192, animated: false });
  assert.deepEqual(pick(parseImageHeader(bmp(300, 200))), { format: 'bmp', width: 300, height: 200, animated: false });
  // an EXIF segment that continues past the first range still yields the orientation (IFD0 is at its start)
  const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker]), u16(data.length + 2), data]);
  const tiff = Buffer.concat([Buffer.from('MM', 'latin1'), u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(6), u16(0), u32(0)]);
  const exif = Buffer.concat([Buffer.from('Exif\u0000\u0000', 'latin1'), tiff]);
  const padded = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\u0000\u0001\u0001\u0000\u0000\u0001\u0000\u0001\u0000\u0000', 'latin1')), seg(0xe1, Buffer.concat([exif, Buffer.alloc(65530 - exif.length)])), seg(0xc0, Buffer.concat([Buffer.from([8]), u16(3000), u16(4000), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])])), seg(0xda, Buffer.alloc(10)), Buffer.from([0xff, 0xd9])]);
  const firstRange = parseImageHeader([{ offset: 0, buf: padded.subarray(0, 65536) }], { totalBytes: padded.length });
  const both = parseImageHeader([{ offset: 0, buf: padded.subarray(0, 65536) }, { offset: firstRange.needMore.offset, buf: padded.subarray(firstRange.needMore.offset) }], { totalBytes: padded.length });
  assert.deepEqual([both.width, both.height, both.orientation], [3000, 4000, 6]);
  assert.equal(detectFormat(Buffer.from('<!doctype html><html><body>not found</body></html>')), null);
  assert.equal(detectFormat(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00])), 'ico');
  const d = parseDataUri('data:image/gif;base64,R0lGODlhAQABAAAAACw=');
  assert.equal(d.mime, 'image/gif');
  assert.equal(detectFormat(d.buf), 'gif');
});

const pick = (x) => ({ format: x.format, width: x.width, height: x.height, animated: x.animated });

test('image-audit: srcset, sizes and the candidate a browser picks', () => {
  const c = parseSrcset('/a-640.webp 640w, /cdn-cgi/image/width=1280,quality=78/a.jpg 1280w,/b.jpg 2x');
  assert.deepEqual(c.map((x) => x.url), ['/a-640.webp', '/cdn-cgi/image/width=1280,quality=78/a.jpg', '/b.jpg']);
  assert.equal(c[1].w, 1280);
  assert.equal(c[2].x, 2);
  assert.equal(evalSizes('(max-width: 720px) 100vw, 720px', 412), 412);
  assert.equal(evalSizes('(max-width: 720px) 100vw, 720px', 1280), 720);
  assert.equal(evalSizes('auto, (max-width: 720px) calc(100vw - 40px), 320px', 412), 372);
  assert.equal(evalSizes('(min-width: 50em) 33vw, 100vw', 1280), 422.4);
  assert.equal(evalSizes('(min-width: 50em) 33vw, 100vw', 412), 412);
  assert.equal(evalLength('clamp(200px, 50vw, 600px)', 1280), 600);
  assert.equal(chooseCandidate(parseSrcset('/s.jpg 640w, /l.jpg 1280w'), 412, 1.75).url, '/l.jpg');
  assert.equal(chooseCandidate(parseSrcset('/s.jpg 640w, /l.jpg 1280w'), 300, 1).url, '/s.jpg');
  assert.equal(chooseCandidate(parseSrcset('/hi.jpg 2x'), 300, 1, '/lo.jpg').url, '/lo.jpg');
});

test('image-audit: alt and file-name heuristics', () => {
  const rules = (alt, src) => altProblems(alt, src).map((p) => p.rule);
  assert.deepEqual(rules('IMG_1234.jpg'), ['alt-filename']);
  assert.deepEqual(rules('DSC_0042'), ['alt-filename']);
  assert.deepEqual(rules('gooseneck-kettle-steel', '/img/gooseneck-kettle-steel.webp'), ['alt-filename']);
  assert.deepEqual(rules('Gooseneck kettle pouring water over a paper filter', '/img/gooseneck-kettle.webp'), []);
  assert.deepEqual(rules('Picture of a burr grinder'), ['alt-redundant-prefix']);
  assert.deepEqual(rules('圖片：手沖咖啡壺'), ['alt-redundant-prefix']);
  assert.deepEqual(rules('coffee, coffee beans, best coffee, coffee grinder, cheap coffee'), ['alt-stuffed']);
  assert.deepEqual(rules('咖啡 咖啡豆 手沖 免費咖啡 手沖咖啡'), ['alt-stuffed']);
  assert.deepEqual(rules('A '.repeat(70).trim() + ' long caption'), ['alt-too-long']);
  assert.deepEqual(rules('這是一段非常非常長的替代文字，用來描述一張咖啡沖煮流程的照片，裡面有濾杯、手沖壺、電子秤、溫度計、磨豆機和兩個杯子'), ['alt-too-long']);
  assert.match(nonDescriptiveName('/up/IMG_0023.jpg'), /camera/);
  assert.match(nonDescriptiveName('/up/9f86d081884c7d659a2feaa0c55ad015.png'), /hash/);
  assert.match(nonDescriptiveName('/up/cover-final(2).png'), /draft/);
  assert.equal(nonDescriptiveName('/img/pour-over-ratio-1280.webp'), '');
  assert.equal(unencodedName('/img/a b.jpg'), true);
  assert.notEqual(variantKey('https://s.example/getimage.aspx?id=1'), variantKey('https://s.example/getimage.aspx?id=2'), 'identifying query kept');
  assert.equal(variantKey('https://s.example/a.jpg?w=300&q=70'), variantKey('https://s.example/a.jpg?w=800'), 'size/quality parameters dropped');
  assert.equal(typeof fileName(`/x?url=${'/x?url='.repeat(20000)}a.jpg`), 'string', 'bounded unwrapping');
  assert.equal(unencodedName('/img/%E5%92%96%E5%95%A1.webp'), false);
  assert.equal(unencodedName('/img/咖啡.webp'), true);
});

test('image-audit: page rules on synthetic records (LCP, og, Discover, site-wide)', () => {
  const page = 'https://www.example.com/guides/kettle/';
  const info = new Map([
    ['https://www.example.com/img/hero.jpg', { ok: true, format: 'jpeg', width: 2400, height: 1200, bytes: 400 * 1024, status: 200 }],
    ['https://www.example.com/img/og.png', { ok: true, format: 'png', width: 600, height: 315, bytes: 20 * 1024, status: 200, colorType: 3, palette: true }],
  ]);
  const infoOf = (u) => info.get(u) || null;
  const rec = {
    url: page,
    finalUrl: page,
    ogImage: 'https://www.example.com/img/og.png',
    og: { image: 'https://www.example.com/img/og.png' },
    twitter: {},
    robots: [],
    preloads: [],
    preconnects: [],
    images: [
      { src: 'https://www.example.com/img/logo.png', rawSrc: '/img/logo.png', lazySrc: '', alt: 'Example', boiler: true, width: '120', height: '40', loading: '', fetchpriority: '', srcset: '', sizes: '', sources: [] },
      { src: 'https://www.example.com/img/hero.jpg', rawSrc: '/img/hero.jpg', lazySrc: '', alt: 'Kettle on a scale', main: true, width: '600', height: '300', loading: 'lazy', fetchpriority: '', srcset: '', sizes: '', sources: [] },
    ],
  };
  const lcp = findLcp(rec, infoOf);
  assert.equal(lcp.img.src, 'https://www.example.com/img/hero.jpg', 'boiler logo is skipped');
  const { issues } = auditPage(rec, infoOf, { home: 'https://www.example.com/' });
  const rules = new Set(issues.map((i) => i.rule));
  for (const r of ['lcp-lazy', 'lcp-no-fetchpriority', 'oversized', 'bytes-over-budget', 'format-not-modern', 'og-image-small', 'og-image-meta', 'discover-large-preview']) assert.ok(rules.has(r), `missing ${r}`);
  assert.ok(issues.find((i) => i.rule === 'oversized').detail.includes('wasted'));
  assert.equal(issues.find((i) => i.rule === 'format-not-modern').severity, 'medium');
  assert.equal(formatSaving({ format: 'png', bytes: 900 * 1024, width: 800, height: 600, colorType: 2 }).target, 'lossy WebP or AVIF');
  assert.equal(formatSaving({ format: 'gif', bytes: 300 * 1024, width: 400, height: 300, animated: true }).target, 'MP4/WebM video or animated WebP');
  assert.equal(formatSaving({ format: 'webp', bytes: 300 * 1024 }), null);
  // site-wide: same og:image on most pages, duplicate alt, one name for many files
  const mk = (n) => ({ url: `https://www.example.com/p${n}/`, finalUrl: `https://www.example.com/p${n}/`, ogImage: '/img/default-share.jpg', preloads: [], images: [{ src: `https://www.example.com/d${n}/hero.webp`, rawSrc: `/d${n}/hero.webp`, lazySrc: '', alt: 'Coffee' }] });
  const site = siteIssues([mk(1), mk(2), mk(3), mk(4)], () => null);
  const siteRules = site.map((i) => i.rule);
  for (const r of ['og-image-generic', 'alt-duplicate', 'filename-not-descriptive']) assert.ok(siteRules.includes(r), `missing site rule ${r}`);
  const collapsed = collapseIssues(Array.from({ length: 6 }, (_, i) => ({ severity: 'medium', rule: 'alt-missing', page: `https://www.example.com/x${i}/`, image: 'https://www.example.com/logo.png', detail: 'no alt' })));
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0].detail, /same on 6 pages/);
  const nextImg = (n, name) => ({ url: `https://www.example.com/n${n}/`, finalUrl: `https://www.example.com/n${n}/`, ogImage: '', preloads: [], images: [{ src: `https://www.example.com/_next/image?url=%2Fimg%2F${name}&w=640&q=75`, rawSrc: `/_next/image?url=%2Fimg%2F${name}&w=640&q=75`, lazySrc: '', alt: name }] });
  const nextIssues = siteIssues([nextImg(1, 'kettle-steel.jpg'), nextImg(2, 'grinder-dial.jpg'), nextImg(3, 'paper-filter.jpg')], () => null);
  assert.ok(!nextIssues.some((i) => i.rule === 'filename-not-descriptive'), 'optimizer endpoints are not all named "image"');
  const wp = (n, size) => ({ url: `https://www.example.com/w${n}/`, finalUrl: `https://www.example.com/w${n}/`, ogImage: '', preloads: [], images: [{ src: `https://www.example.com/wp-content/uploads/2026/05/kettle${size}.jpg`, rawSrc: '', lazySrc: '', alt: 'Copper kettle on a gas stove' }] });
  assert.ok(!siteIssues([wp(1, '-300x200'), wp(2, '-1024x683'), wp(3, '')], () => null).some((i) => i.rule === 'alt-duplicate'), 'size variants of one image are one image');
  const yoast = jsonLdImageRefs([{ data: { '@context': 'https://schema.org', '@graph': [{ '@type': 'Article', '@id': 'https://www.example.com/p/#article', image: { '@id': 'https://www.example.com/p/#primaryimage' } }, { '@type': 'ImageObject', '@id': 'https://www.example.com/p/#primaryimage', url: 'https://www.example.com/up/cover.jpg', width: 1200, height: 675 }] } }], page);
  assert.ok(yoast.some((r) => r.prop === 'image' && r.url === 'https://www.example.com/up/cover.jpg' && r.types.includes('Article')), 'Article image resolved through @id');
  const refs = jsonLdImageRefs([{ data: { '@context': 'https://schema.org', '@graph': [{ '@type': 'Organization', logo: { '@type': 'ImageObject', url: '/logo.png' } }, { '@type': 'Article', image: ['/a-16x9.jpg', '/a-1x1.jpg'] }, { '@type': 'ImageObject', contentUrl: '/photo.jpg' }] } }], page);
  assert.deepEqual(refs.map((r) => `${r.prop}:${r.url.replace('https://www.example.com', '')}`).sort(), ['ImageObject:/photo.jpg', 'image:/a-16x9.jpg', 'image:/a-1x1.jpg', 'logo:/logo.png'].sort());
  const extras = htmlExtras('<html><head><link rel="preconnect" href="https://img.example.org"></head><body><header><div style="background:url(/h.jpg)"></div></header><main><section style="background-image: url(\'/hero-bg.jpg\')"><h1>x</h1></section><img src="/a.jpg"></main></body></html>', page);
  assert.deepEqual(extras.preconnects, ['img.example.org']);
  assert.equal(extras.bgHero.url, 'https://www.example.com/hero-bg.jpg');
});

// ---------- end-to-end with a local server ----------
const IMAGES = {
  '/img/hero.jpg': { type: 'image/jpeg', body: jpeg(1200, 600, { pad: 250 * 1024 }) },
  '/img/card.jpg': { type: 'image/jpeg', body: jpeg(1600, 1067, { pad: 30 * 1024 }) },
  '/img/photo.png': { type: 'image/png', body: png(800, 600, { colorType: 2, pad: 700 * 1024 }) },
  '/img/anim.gif': { type: 'image/gif', body: gif(400, 300, { frames: 2, loop: true }) },
  '/img/thumb.webp': { type: 'image/webp', body: webpLossy(400, 300), noHead: true },
  '/img/thumb-400.webp': { type: 'image/webp', body: webpLossy(400, 300) },
  '/img/thumb-800.webp': { type: 'image/webp', body: webpLossy(800, 600) },
  '/img/logo.png': { type: 'image/png', body: png(240, 80, { colorType: 6, pad: 3000 }) },
  '/img/og-small.jpg': { type: 'image/jpeg', body: jpeg(800, 400, { pad: 9000 }), noRange: true },
  '/img/tiny.png': { type: 'image/png', body: png(100, 100, { colorType: 3 }) },
  '/img/hero-b.avif': { type: 'image/avif', body: avif(1600, 900, { mdatFirst: true }), noLength: true },
  '/img/wide-1600.jpg': { type: 'image/jpeg', body: jpeg(1600, 1000, { pad: 4000 }) },
  '/img/wide-3200.jpg': { type: 'image/jpeg', body: jpeg(3200, 2000, { pad: 4000 }) },
  '/img/share-1200.jpg': { type: 'image/jpeg', body: jpeg(1200, 630, { pad: 4000 }) },
  '/img/pic-fallback.jpg': { type: 'image/jpeg', body: jpeg(1200, 800, { pad: 120 * 1024 }) },
  '/img/pic.avif': { type: 'image/avif', body: avif(1200, 800) },
  '/img/IMG_0023.jpg': { type: 'image/jpeg', body: jpeg(640, 480, { pad: 2000 }) },
  '/img/a b.jpg': { type: 'image/jpeg', body: jpeg(640, 480, { pad: 2000 }) },
  '/x/hero.webp': { type: 'image/webp', body: webpLossy(640, 360) },
  '/y/hero.webp': { type: 'image/webp', body: webpLossy(640, 360) },
  '/z/hero.webp': { type: 'image/webp', body: webpLossy(640, 360) },
  '/img/bg.jpg': { type: 'image/jpeg', body: jpeg(1600, 900, { pad: 1000 }) },
  '/img/c1.webp': { type: 'image/webp', body: webpLossy(300, 200) },
  '/img/big-exif.jpg': { type: 'image/jpeg', body: jpegBigHeader(3000, 2000) },
  '/img/busy.webp': { type: 'image/webp', body: webpLossy(300, 200), status: 429 },
};

const HOME = `<!doctype html><html lang="en"><head><title>Home</title>
<meta property="og:image" content="/img/og-small.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization","name":"Example","logo":"{{ORIGIN}}/img/logo-404.png"},{"@type":"Article","headline":"Kettles","image":"{{ORIGIN}}/img/tiny.png"}]}</script>
</head><body><header><a href="/"><img src="/img/logo.png" width="240" height="80" alt="Example Coffee"></a><nav><a href="/b/">B</a> <a href="/c/">C</a></nav></header>
<main><h1>Pour-over kettles</h1>
<img src="/img/hero.jpg" width="1200" height="600" alt="Gooseneck kettle on a scale" loading="lazy">
<p>Text.</p>
<img src="/img/card.jpg" width="300" height="200" alt="IMG_1234.jpg">
<img data-src="/img/thumb-800.webp" class="lazyload" alt="Lazy loaded kettle" width="800" height="600">
<img src="" alt="Nothing here" width="10" height="10">
<img src="/" alt="Home again" width="10" height="10">
<img src="/img/photo.png" width="800" height="600" alt="Image of a copper kettle">
<img src="/img/anim.gif" width="400" height="300" alt="Water pouring in circles">
<img src="/img/thumb.webp" srcset="/img/thumb-400.webp 400w, /img/thumb-800.webp 800w" width="400" height="300" alt="Kettle thumbnail">
<img src="/img/missing.webp" alt="A missing photo">
</main><footer>Footer</footer></body></html>`;

const PAGE_B = `<!doctype html><html lang="en"><head><title>B</title>
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:image" content="{{ORIGIN}}/img/share-1200.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="Kettles side by side"><meta name="twitter:card" content="summary_large_image">
<link rel="preload" as="image" href="/img/hero-b.avif" fetchpriority="high">
</head><body><main>
<img src="/img/hero-b.avif" width="1600" height="900" alt="Three kettles on a counter">
<img src="/img/wide-1600.jpg" srcset="/img/wide-1600.jpg 1600w, /img/wide-3200.jpg 3200w" sizes="300px" width="300" height="200" alt="Wide shot" fetchpriority="high">
<img src="/img/c1.webp" width="300" height="200" alt="Coffee" fetchpriority="high" sizes="auto, 300px" srcset="/img/c1.webp 300w">
<img src="/img/IMG_0023.jpg" width="640" height="480" alt="coffee, coffee beans, best coffee, coffee grinder, cheap coffee" fetchpriority="high">
<img src="/img/a b.jpg" width="640" height="480" alt="Coffee">
<picture><source type="image/avif" srcset="/img/pic.avif"><img src="/img/pic-fallback.jpg" width="1200" height="800" alt="Brew station"></picture>
<img src="/x/hero.webp" width="640" height="360" alt="Coffee">
<img src="/y/hero.webp" width="640" height="360" alt="Filter papers">
<img src="/z/hero.webp" width="640" height="360" alt="Grinder dial">
<img src="/img/big-exif.jpg" width="600" height="400" alt="Camera export with a large header" loading="lazy">
<img src="/img/busy.webp" width="300" height="200" alt="Rate limited image" loading="lazy">
</main></body></html>`;

const PAGE_C = `<!doctype html><html lang="en"><head><title>C</title></head><body><main>
<section style="background-image: url('/img/bg.jpg')"><h1>Big hero</h1></section>
<img src="http://localhost:{{PORT}}/img/c1.webp" width="1200" height="800" alt="Cup on a saucer">
</main></body></html>`;

async function startSite() {
  let origin = '';
  let port = 0;
  const pages = { '/': HOME, '/b/': PAGE_B, '/c/': PAGE_C };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pages[p]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : pages[p].replaceAll('{{ORIGIN}}', origin).replaceAll('{{PORT}}', String(port)));
    }
    const f = IMAGES[p];
    if (!f) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end(req.method === 'HEAD' ? undefined : '<html><body>Not found</body></html>');
    }
    const body = f.body;
    if (f.status) {
      res.writeHead(f.status, { 'content-type': 'text/plain' });
      return res.end(req.method === 'HEAD' ? undefined : 'slow down');
    }
    if (req.method === 'HEAD') {
      if (f.noHead) {
        res.writeHead(405);
        return res.end();
      }
      res.writeHead(200, { 'content-type': f.type, ...(f.noLength ? {} : { 'content-length': body.length }) });
      return res.end();
    }
    const m = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '');
    if (m && !f.noRange) {
      const start = Number(m[1]);
      const end = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
      res.writeHead(206, { 'content-type': f.type, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': f.type, 'content-length': body.length });
    return res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('image-audit CLI: live pages + HEAD/Range probing trigger the main rules', async () => {
  const site = await startSite();
  try {
    const ws = makeWorkspace();
    editConfig(ws, (c) => {
      c.site.url = `${site.origin}/`;
    });
    const r = await runScript('image-audit.mjs', ['--workspace', ws, '--urls', '/', '--urls', '/b/', '--urls', '/c/', '--delay', '0']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Audited 3 page\(s\)/);
    const issues = csvToRecords(fs.readFileSync(dataFile(ws, 'images', /image-issues\.csv$/), 'utf8')).records;
    const has = (rule, part = '') => issues.some((i) => i.rule === rule && (i.image + i.page + i.detail).includes(part));
    for (const [rule, part] of [
      ['image-broken', 'logo-404.png'],
      ['image-broken', 'missing.webp'],
      ['src-empty', 'this page'],
      ['src-empty', 'without a usable src'],
      ['js-lazy-only', 'thumb-800.webp'],
      ['lcp-lazy', 'hero.jpg'],
      ['lcp-no-fetchpriority', 'hero.jpg'],
      ['fetchpriority-overuse', ''],
      ['missing-dimensions', 'missing.webp'],
      ['oversized', 'card.jpg'],
      ['oversized', '1600w candidate'],
      ['bytes-over-budget', 'hero.jpg'],
      ['format-not-modern', 'photo.png'],
      ['format-not-modern', 'anim.gif'],
      ['raster-icon', 'logo.png'],
      ['srcset-no-sizes', 'thumb.webp'],
      ['sizes-auto', 'c1.webp'],
      ['alt-filename', 'card.jpg'],
      ['alt-stuffed', 'IMG_0023.jpg'],
      ['alt-redundant-prefix', 'photo.png'],
      ['alt-duplicate', 'Coffee'],
      ['filename-not-descriptive', 'IMG_0023'],
      ['filename-not-descriptive', 'hero.webp'],
      ['filename-not-encoded', 'a b.jpg'],
      ['og-image-relative', 'og-small.jpg'],
      ['og-image-small', 'og-small.jpg'],
      ['og-image-meta', 'twitter:card'],
      ['og-image-missing', '/c/'],
      ['jsonld-image', 'tiny.png'],
      ['discover-large-preview', ''],
      ['lcp-no-preconnect', 'localhost'],
      ['css-background-hero', 'bg.jpg'],
    ]) assert.ok(has(rule, part), `missing ${rule} ${part}`);
    assert.ok(!issues.some((i) => i.rule === 'format-not-modern' && i.image.includes('pic-fallback.jpg')), 'a <picture> fallback is not a format problem');
    assert.ok(!issues.some((i) => i.rule === 'lcp-no-fetchpriority' && i.page.endsWith('/b/')), 'preloaded LCP with fetchpriority=high is fine');
    assert.ok(!issues.some((i) => i.rule === 'og-image-meta' && i.page.endsWith('/b/')), 'complete og meta on /b/');
    const rows = csvToRecords(fs.readFileSync(dataFile(ws, 'images', /-images\.csv$/), 'utf8')).records;
    const row = (part) => rows.find((x) => x.src.includes(part));
    assert.equal(row('hero-b.avif').intrinsic, '1600x900', 'AVIF meta box fetched with a second range request');
    assert.equal(row('hero-b.avif').lcp, 'yes');
    assert.equal(row('thumb.webp').intrinsic, '400x300', 'HEAD 405 falls back to a range GET');
    assert.equal(row('og-small.jpg').intrinsic, '800x400', 'server ignoring Range still parses');
    assert.equal(row('anim.gif').format, 'gif');
    assert.equal(row('big-exif.jpg').intrinsic, '3000x2000', 'SOF beyond the first 64 KB: follow-up range');
    assert.ok(issues.some((i) => i.rule === 'oversized' && i.image.includes('big-exif.jpg')));
    const busy = issues.find((i) => i.rule === 'image-broken' && i.image.includes('busy.webp'));
    assert.equal(busy.severity, 'low', 'HTTP 429 is not reported as a broken image');
    assert.match(busy.detail, /--delay/);
    assert.equal(row('hero.jpg').alt_state, 'ok');
    assert.equal(row('card.jpg').alt_state, 'poor');
    assert.ok(Number(row('photo.png').bytes) > 700 * 1024);
    assert.ok(fs.readFileSync(dataFile(ws, 'images', /image-summary\.md$/), 'utf8').includes('## Likely LCP image per page'));
    const offline = await runScript('image-audit.mjs', ['--workspace', ws, '--urls', '/', '--no-fetch', '--delay', '0', '--json']);
    assert.equal(offline.status, 0, offline.stderr);
    const j = JSON.parse(offline.stdout);
    assert.equal(j.meta.probed, 0);
    assert.ok(j.issues.some((i) => i.rule === 'js-lazy-only') && !j.issues.some((i) => i.rule === 'format-not-modern'));
  } finally {
    await site.close();
  }
});

test('image-audit: crawl mode reads crawl-site output (images, JSON-LD, pages without images)', async () => {
  const site = await startSite();
  try {
    const ws = makeWorkspace();
    editConfig(ws, (c) => {
      c.site.url = `${site.origin}/`;
    });
    const crawl = await runScript('crawl-site.mjs', ['--workspace', ws, '--delay', '0', '--no-sitemap']);
    assert.equal(crawl.status, 0, crawl.stderr);
    const r = await runScript('image-audit.mjs', ['--workspace', ws, '--delay', '0']);
    assert.equal(r.status, 0, r.stderr);
    const issues = csvToRecords(fs.readFileSync(dataFile(ws, 'images', /image-issues\.csv$/), 'utf8')).records;
    for (const rule of ['lcp-lazy', 'image-broken', 'jsonld-image', 'js-lazy-only', 'og-image-relative']) assert.ok(issues.some((i) => i.rule === rule), `crawl mode lacks ${rule}`);
    assert.ok(issues.some((i) => i.rule === 'og-image-meta'), 'crawl-site stores og/twitter meta, so crawl mode judges it too');
    const missing = await runScript('image-audit.mjs', ['--workspace', makeWorkspace()]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /crawl-site\.mjs/);
  } finally {
    await site.close();
  }
});

test('image-audit convert: plan, dry run with a stub tool, refusal and missing-tool message', () => {
  const dir = tmpDir('img-src-');
  fs.writeFileSync(path.join(dir, 'kettle.jpg'), jpeg(2000, 1000, { pad: 5000 }));
  fs.writeFileSync(path.join(dir, 'chart.png'), png(600, 400, { colorType: 3, pad: 3000 }));
  fs.writeFileSync(path.join(dir, 'logo.svg'), '<svg width="10" height="10"></svg>');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(dir, 'renamed.webp'), jpeg(300, 200));
  const plan = planConvert([dir], { format: 'both', maxWidth: 1280 });
  const kettle = plan.filter((p) => p.input.endsWith('kettle.jpg'));
  assert.deepEqual(kettle.map((p) => p.format), ['webp', 'avif']);
  assert.equal(kettle[0].resizeTo, 1280);
  assert.ok(kettle[0].output.startsWith(`${dir}-optimized`));
  assert.equal(plan.find((p) => p.input.endsWith('chart.png')).resizeTo, null, 'never enlarges');
  assert.ok(plan.find((p) => p.input.endsWith('logo.svg')).skip);
  assert.ok(!plan.some((p) => p.input.endsWith('notes.txt')));
  assert.equal(plan.find((p) => p.input.endsWith('renamed.webp')).inFormat, 'jpeg', 'detected by content, not extension');
  assert.throws(() => planConvert([dir], { out: path.join(dir, 'sub') }), /input directory/);
  const inPlace = planConvert([dir], { inPlace: true, force: true });
  assert.ok(inPlace.filter((p) => !p.skip).every((p) => p.output !== p.input && path.dirname(p.output) === dir));
  assert.equal(inPlace.find((p) => p.input.endsWith('renamed.webp')).skip, 'would overwrite an original file');
  // never overwrite originals: a hand-made logo.webp next to logo.png, an upper-case HERO.WEBP (one file on
  // case-insensitive disks), two inputs with one output name, and --force only replacing earlier outputs in --out
  const orig = tmpDir('img-orig-');
  fs.writeFileSync(path.join(orig, 'logo.png'), png(400, 200, { colorType: 6, pad: 2000 }));
  fs.writeFileSync(path.join(orig, 'logo.webp'), 'hand-made, must survive');
  fs.writeFileSync(path.join(orig, 'HERO.WEBP'), jpeg(2400, 1200, { pad: 2000 }));
  fs.writeFileSync(path.join(orig, 'photo.jpg'), jpeg(800, 600, { pad: 2000 }));
  fs.writeFileSync(path.join(orig, 'photo.png'), png(800, 600, { pad: 2000 }));
  const safe = planConvert([orig], { inPlace: true, force: true, maxWidth: 1200 });
  assert.equal(safe.find((p) => p.input.endsWith('logo.png')).skip, 'would overwrite an original file');
  for (const p of safe.filter((x) => !x.skip)) assert.ok(!fs.existsSync(p.output), `would replace ${p.output}`);
  const photos = safe.filter((p) => /photo\.(jpg|png)$/.test(p.input));
  assert.equal(photos.filter((p) => !p.skip).length, 1);
  assert.match(photos.find((p) => p.skip).skip, /same output name/);
  const outDir = tmpDir('img-out-');
  fs.writeFileSync(path.join(outDir, 'photo.webp'), 'earlier output');
  assert.match(planConvert([path.join(orig, 'photo.jpg')], { out: outDir }).find((p) => p.format === 'webp').skip, /output exists/);
  assert.equal(planConvert([path.join(orig, 'photo.jpg')], { out: outDir, force: true }).find((p) => p.format === 'webp').skip, undefined, '--force replaces earlier outputs');
  assert.deepEqual(conversionCommand({ avifenc: '/bin/avifenc', avifencLegacy: true }, { input: 'a.png', output: 'a.avif', inFormat: 'png', format: 'avif', quality: 58 }).args, ['--min', '26', '--max', '26', '-s', '6', 'a.png', 'a.avif'], 'libavif < 1.0 has no -q');
  const cmd = conversionCommand({ cwebp: '/bin/cwebp' }, { input: 'a.jpg', output: 'a.webp', inFormat: 'jpeg', format: 'webp', quality: 78, resizeTo: 1280 });
  assert.deepEqual(cmd.args, ['-q', '78', '-m', '6', '-metadata', 'none', '-resize', '1280', '0', 'a.jpg', '-o', 'a.webp']);
  assert.equal(conversionCommand({ avifenc: '/bin/avifenc' }, { input: 'a.jpg', output: 'a.avif', inFormat: 'jpeg', format: 'avif', quality: 58, resizeTo: 1280 }).tool, 'avifenc');
  assert.equal(conversionCommand({}, { input: 'a.gif', output: 'a.webp', inFormat: 'gif', format: 'webp', quality: 78 }), null);

  const empty = tmpDir('img-bin-empty-');
  const none = runScriptSync('image-audit.mjs', ['convert', dir], { env: { PATH: empty } });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /No image converter found/);
  assert.match(none.stderr, /brew install webp libavif imagemagick/);
  assert.match(none.stderr, /npm i -g sharp-cli/);
  if (process.platform === 'win32') return;
  const bin = tmpDir('img-bin-');
  const stub = path.join(bin, 'cwebp');
  // stub converter: only shell builtins (PATH contains nothing else); writes a 100-byte "WebP"
  fs.writeFileSync(stub, '#!/bin/sh\nprev=""; in=""; out=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; if [ "$a" = "-o" ]; then in="$prev"; fi; prev="$a"; done\n[ -f "$in" ] && printf "%0100d" 0 > "$out"\n');
  fs.chmodSync(stub, 0o755);
  const dry = runScriptSync('image-audit.mjs', ['convert', dir, '--max-width', '1280', '--dry-run'], { env: { PATH: bin } });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /cwebp -q 78 -m 6 -metadata none -resize 1280 0 /);
  assert.ok(!fs.existsSync(`${dir}-optimized`), 'dry run writes nothing');
  const run = runScriptSync('image-audit.mjs', ['convert', dir, '--max-width', '1280'], { env: { PATH: bin } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.statSync(path.join(`${dir}-optimized`, 'kettle.webp')).size, 100);
  assert.match(run.stdout, /Total: .* smaller/);
  assert.ok(fs.existsSync(path.join(dir, 'kettle.jpg')), 'original kept');
  const again = runScriptSync('image-audit.mjs', ['convert', dir], { env: { PATH: bin } });
  assert.match(again.stdout, /output exists/);
});
