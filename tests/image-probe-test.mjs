// 校验 src/api.js 中图床的 sniffImage / probeImageSize：
// 直接从源码提取函数执行，避免测试与实现出现两份逻辑。
// 样本图片在测试内手工构造（无需 PIL / ImageMagick 等外部依赖）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/api.js'), 'utf8');

// 按花括号配平提取 api.js 中的函数源码
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`api.js 中未找到函数 ${name}`);
  const open = src.indexOf('{', start);
  for (let i = open, depth = 0; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号未闭合`);
}
const factory = new Function(`${extractFn('asciiAt')}\n${extractFn('sniffImage')}\n${extractFn('probeImageSize')}\nreturn { sniffImage, probeImageSize };`);
const { sniffImage, probeImageSize } = factory();

// ---------- 样本构造 ----------

const CRC_TABLE = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 真实可渲染的 PNG（zlib IDAT）
function makePng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const rows = [...Array(h)].map(() => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xcc)]));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// 真实可渲染的 GIF89a（2 色全局调色板 + 正确 LZW）
function makeGif(w, h) {
  const parts = [Buffer.from('GIF89a', 'ascii')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0x80; // 有 GCT，2^(0+1) 色
  parts.push(lsd, Buffer.from([0xff, 0xff, 0xff, 0x00, 0x00, 0x00])); // 白 / 黑
  parts.push(Buffer.from([0x2c])); // 图像描述符
  const desc = Buffer.alloc(8);
  desc.writeUInt16LE(0, 0);
  desc.writeUInt16LE(0, 2);
  desc.writeUInt16LE(w, 4);
  desc.writeUInt16LE(h, 6);
  parts.push(desc, Buffer.from([0x07])); // 交织关闭
  // LZW：min code size 2，clear=4 / EOI=5，码长固定 9 位（流很短不会增位）
  const minCodeSize = 2;
  const codes = [4, ...[...Array(w * h)].map(() => 0), 5];
  let bits = [];
  for (const code of codes) {
    for (let i = 0; i < minCodeSize + 1; i++) bits.push((code >> i) & 1);
  }
  const data = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => {
    if (b) data[i >> 3] |= 0x80 >> (i & 7);
  });
  parts.push(Buffer.from([minCodeSize, data.length]), data, Buffer.from([0x00, 0x3b]));
  return Buffer.concat(parts);
}

// 真实可渲染的 24 位 BMP（自底向上）
function makeBmp(w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * h, 0xcc);
  const header = Buffer.alloc(14);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(w, 4);
  info.writeInt32LE(h, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(24, 14);
  info.writeUInt32LE(pixels.length, 20);
  return Buffer.concat([header, info, pixels]);
}

// SOF0 前带 APP0/DQT 的 JPEG 头（解析器需正确跳过无关节段）
function makeJpeg(w, h, sofMarker = 0xc0) {
  const parts = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  parts.push(Buffer.from([0xff, 0xe0]), Buffer.from([0x00, app0.length + 2]), app0);
  const dqt = Buffer.alloc(65);
  dqt[0] = 0; // 8 位量化表
  parts.push(Buffer.from([0xff, 0xdb]), Buffer.from([0x00, 0x43]), dqt);
  const sof = Buffer.alloc(8);
  sof[0] = 8; // 精度
  sof.writeUInt16BE(h, 1); // 高度在前
  sof.writeUInt16BE(w, 3);
  sof[6] = 3; // 分量数
  parts.push(Buffer.from([0xff, sofMarker]), Buffer.from([0x00, 0x0b]), sof);
  parts.push(Buffer.from([0xff, 0xd9])); // EOI
  return Buffer.concat(parts);
}

// 手搓的最小 WebP：VP8X 扩展容器（24 位宽/高，-1 编码）
function makeWebpVp8x(w, h) {
  const vp8x = Buffer.alloc(18);
  Buffer.from('VP8X', 'ascii').copy(vp8x, 0);
  vp8x.writeUInt32LE(10, 4); // chunk payload长度
  vp8x[8] = 0; // flags：无 alpha / XMP / 动画
  vp8x.writeUIntLE(w - 1, 12, 3);
  vp8x.writeUIntLE(h - 1, 15, 3);
  const riff = Buffer.alloc(4);
  riff.write('WEBP', 0, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + vp8x.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, riff, vp8x]);
}

// 手搓的最小 WebP：VP8L 无损（签名 0x2F + 14 位宽/高，-1 编码）
function makeWebpVp8l(w, h) {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUIntLE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 1, 4);
  const vp8l = Buffer.concat([Buffer.from('VP8L', 'ascii'), (() => { const s = Buffer.alloc(4); s.writeUInt32LE(payload.length, 0); return s; })(), payload]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + vp8l.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, Buffer.from('WEBP', 'ascii'), vp8l]);
}

// AVIF：仅 ftyp brand（尺寸探测不支持，应返回 null）
function makeAvif() {
  const ftyp = Buffer.from('ftyp', 'ascii');
  const body = Buffer.alloc(8);
  body.write('avif', 0, 'ascii');
  body.writeUInt32LE(0, 4);
  return Buffer.concat([Buffer.alloc(4), ftyp, body]);
}

// ---------- 断言 ----------

let pass = 0;
let fail = 0;
const chk = (name, expected, actual) => {
  const ok = expected === actual;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ` (expected=[${expected}] actual=[${actual}])`}`);
};

const png = makePng(320, 180);
const pngLarge = makePng(1920, 1080);
const gif = makeGif(48, 24);
const bmp = makeBmp(64, 32);
const jpeg = makeJpeg(352, 176);
const jpegSof2 = makeJpeg(640, 480, 0xc2); // 渐进式 JPEG
const webpX = makeWebpVp8x(100, 50);
const webpL = makeWebpVp8l(33, 17);
const avif = makeAvif();
const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00]);

chk('PNG 魔数识别', 'png', sniffImage(png));
chk('PNG 尺寸 320x180', '320,180', probeImageSize(png, 'png').join(','));
chk('PNG 尺寸 1920x1080', '1920,1080', probeImageSize(pngLarge, 'png').join(','));
chk('GIF 魔数识别', 'gif', sniffImage(gif));
chk('GIF 尺寸 48x24', '48,24', probeImageSize(gif, 'gif').join(','));
chk('BMP 魔数识别', 'bmp', sniffImage(bmp));
chk('BMP 尺寸 64x32', '64,32', probeImageSize(bmp, 'bmp').join(','));
chk('JPEG 魔数识别', 'jpg', sniffImage(jpeg));
chk('JPEG 尺寸 352x176（SOF0）', '352,176', probeImageSize(jpeg, 'jpg').join(','));
chk('JPEG 尺寸 640x480（SOF2 渐进）', '640,480', probeImageSize(jpegSof2, 'jpg').join(','));
chk('WebP(VP8X) 魔数识别', 'webp', sniffImage(webpX));
chk('WebP(VP8X) 尺寸 100x50', '100,50', probeImageSize(webpX, 'webp').join(','));
chk('WebP(VP8L) 魔数识别', 'webp', sniffImage(webpL));
chk('WebP(VP8L) 尺寸 33x17', '33,17', probeImageSize(webpL, 'webp').join(','));
chk('AVIF 魔数识别', 'avif', sniffImage(avif));
chk('AVIF 尺寸探测返回 null', 'null,null', probeImageSize(avif, 'avif').map(String).join(','));
chk('ICO 魔数识别', 'ico', sniffImage(ico));
chk('ICO 尺寸探测返回 null', 'null,null', probeImageSize(ico, 'ico').map(String).join(','));

// 非图片 / 危险类型必须被拒绝
for (const [name, buf] of [
  ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
  ['伪装成 png 的 HTML', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('<script>alert(1)</script>')])],
  ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ['PDF', Buffer.from('%PDF-1.4')],
  ['空文件', Buffer.alloc(0)],
  ['ZIP', Buffer.from('PK\u0003\u0004')],
]) {
  chk(`拒绝 ${name}`, 'null', String(sniffImage(buf)));
}

// 超长文件头（>32 字节）不应导致越界
const bigHeader = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 0x41)]);
chk('超长 PNG 头仍可识别', 'png', sniffImage(bigHeader));

console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
