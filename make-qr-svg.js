import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = 4;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 80;
const ECC_CODEWORDS = 20;

const EXP = new Array(512);
const LOG = new Array(256);
let x = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

function gfMul(a, b) {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.slice(0, degree);
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ res.shift();
    res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= gfMul(gen[i], factor);
  }
  return res;
}

function bitsToCodewords(text) {
  const bytes = [...Buffer.from(text, "utf8")];
  const bits = [];
  const append = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, 8);
  for (const b of bytes) append(b, 8);
  const capacityBits = DATA_CODEWORDS * 8;
  append(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  for (let pad = 0xec; data.length < DATA_CODEWORDS; pad ^= 0xec ^ 0x11) {
    data.push(pad);
  }
  return data.concat(rsRemainder(data, ECC_CODEWORDS));
}

function makeMatrix() {
  return {
    dark: Array.from({ length: SIZE }, () => Array(SIZE).fill(false)),
    func: Array.from({ length: SIZE }, () => Array(SIZE).fill(false)),
  };
}

function setModule(m, r, c, dark, func = true) {
  if (r < 0 || c < 0 || r >= SIZE || c >= SIZE) return;
  m.dark[r][c] = !!dark;
  m.func[r][c] = !!func;
}

function finder(m, r, c) {
  for (let y = -1; y <= 7; y++) {
    for (let x = -1; x <= 7; x++) {
      const rr = r + y;
      const cc = c + x;
      const dark = y >= 0 && y <= 6 && x >= 0 && x <= 6 &&
        (y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4));
      setModule(m, rr, cc, dark);
    }
  }
}

function alignment(m, r, c) {
  for (let y = -2; y <= 2; y++) {
    for (let x = -2; x <= 2; x++) {
      setModule(m, r + y, c + x, Math.max(Math.abs(x), Math.abs(y)) !== 1);
    }
  }
}

function addFunctionPatterns(m) {
  finder(m, 0, 0);
  finder(m, 0, SIZE - 7);
  finder(m, SIZE - 7, 0);
  for (let i = 8; i < SIZE - 8; i++) {
    setModule(m, 6, i, i % 2 === 0);
    setModule(m, i, 6, i % 2 === 0);
  }
  alignment(m, 26, 26);
  setModule(m, VERSION * 4 + 9, 8, true);
  reserveFormat(m);
}

function reserveFormat(m) {
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      m.func[8][i] = true;
      m.func[i][8] = true;
    }
  }
  for (let i = SIZE - 8; i < SIZE; i++) {
    m.func[8][i] = true;
    m.func[i][8] = true;
  }
}

function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2 + (r * c) % 3) === 0;
    case 6: return (((r * c) % 2 + (r * c) % 3) % 2) === 0;
    case 7: return (((r + c) % 2 + (r * c) % 3) % 2) === 0;
  }
}

function drawData(m, codewords, mask) {
  const bits = codewords.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >>> (7 - i)) & 1));
  let bit = 0;
  let upward = true;
  for (let c = SIZE - 1; c >= 1; c -= 2) {
    if (c === 6) c--;
    for (let i = 0; i < SIZE; i++) {
      const r = upward ? SIZE - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const cc = c - dc;
        if (!m.func[r][cc]) {
          m.dark[r][cc] = !!(bits[bit++] ^ (maskBit(mask, r, cc) ? 1 : 0));
        }
      }
    }
    upward = !upward;
  }
}

function formatBits(mask) {
  let data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(m, mask) {
  const bits = formatBits(mask);
  const get = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setModule(m, 8, i, get(i));
  setModule(m, 8, 7, get(6));
  setModule(m, 8, 8, get(7));
  setModule(m, 7, 8, get(8));
  for (let i = 9; i < 15; i++) setModule(m, 14 - i, 8, get(i));
  for (let i = 0; i < 8; i++) setModule(m, SIZE - 1 - i, 8, get(i));
  for (let i = 8; i < 15; i++) setModule(m, 8, SIZE - 15 + i, get(i));
}

function penalty(m) {
  let p = 0;
  const countRuns = (line) => {
    let runColor = line[0];
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === runColor) run++;
      else {
        if (run >= 5) p += 3 + run - 5;
        runColor = line[i];
        run = 1;
      }
    }
  };
  for (let r = 0; r < SIZE; r++) countRuns(m.dark[r]);
  for (let c = 0; c < SIZE; c++) countRuns(m.dark.map((row) => row[c]));
  for (let r = 0; r < SIZE - 1; r++) {
    for (let c = 0; c < SIZE - 1; c++) {
      const v = m.dark[r][c];
      if (v === m.dark[r][c + 1] && v === m.dark[r + 1][c] && v === m.dark[r + 1][c + 1]) p += 3;
    }
  }
  const pattern = "10111010000";
  const reverse = "00001011101";
  const scan = (line) => {
    const s = line.map((v) => (v ? "1" : "0")).join("");
    for (let i = 0; i <= s.length - 11; i++) {
      const part = s.slice(i, i + 11);
      if (part === pattern || part === reverse) p += 40;
    }
  };
  for (let r = 0; r < SIZE; r++) scan(m.dark[r]);
  for (let c = 0; c < SIZE; c++) scan(m.dark.map((row) => row[c]));
  const darkCount = m.dark.flat().filter(Boolean).length;
  p += Math.floor(Math.abs((darkCount * 20) / (SIZE * SIZE) - 10)) * 10;
  return p;
}

function qrMatrix(text) {
  const codewords = bitsToCodewords(text);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = makeMatrix();
    addFunctionPatterns(m);
    drawData(m, codewords, mask);
    drawFormat(m, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m.dark;
}

function saveSvg(text, filename, title) {
  const modules = qrMatrix(text);
  const quiet = 4;
  const scale = 12;
  const total = (SIZE + quiet * 2) * scale;
  const rects = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (modules[r][c]) rects.push(`<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`);
    }
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" role="img" aria-label="${title}">\n<title>${title}</title>\n<rect width="100%" height="100%" fill="#fff"/>\n<g fill="#000">\n${rects.join("\n")}\n</g>\n</svg>\n`;
  fs.writeFileSync(path.join(__dirname, filename), svg);
}

saveSvg("https://singular-profiterole-dcb667.netlify.app/", "esdp-common-verification-qr.svg", "ESDP common verification QR");
saveSvg("https://singular-profiterole-dcb667.netlify.app/?roll=ESDP2026-001", "rahul-varma-qr.svg", "Rahul Varma ESDP record QR");
