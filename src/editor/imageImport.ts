import { SVG_HEIGHT, SVG_WIDTH } from "../map/constants";
import { cleanPoints, isWalkable, mergeWalkShapes, removeSmallSteps, type LatLng, type Shape } from "./shapes";

/**
 * 間取り画像から歩行エリアと部屋を大まかに検出する。
 *
 * 1. 黒っぽい線を壁とみなし、似た色で連続する領域ごとに分割する
 * 2. 指定色（既定は自動推定した灰色）の領域を歩行エリアとし、細い線の切れ目を埋めて長方形に分解する
 * 3. 画像の端に接しない、それ以外の色の領域を部屋（外接長方形）とする
 * 4. 領域の中に浮いた線（階段の印）があれば階段とする
 * 5. 部屋・歩行エリアを壁の線の中心まで広げ、互いに隙間や重なりが出ないようにする
 * 6. 部屋の辺の外側で歩行エリアに接する場所に lineDot を置く
 */

export type RGB = [number, number, number];

export interface AnalyzeOptions {
  /** 歩行エリアの色。null なら自動推定 */
  walkColor: RGB | null;
  /** 同じ領域とみなす色の差（各チャンネルの最大差） */
  tolerance: number;
  /** 歩行エリア内の細い線を埋める半径（px） */
  closeRadius: number;
  /** 部屋とみなす最小面積（画像全体に対する割合） */
  minRoomRatio: number;
  /** 階段を検出する */
  detectStairs: boolean;
}

export interface PxRect { x0: number; y0: number; x1: number; y1: number; }

export interface DetectedRoom extends PxRect {
  color: RGB;
  stair: boolean;
  /** 画像座標の lineDot */
  dot?: [number, number];
}

export interface Analysis {
  width: number;
  height: number;
  walkColor: RGB;
  /** 歩行エリアを長方形に分解したときの格子の大きさ（px） */
  cell: number;
  walkRects: PxRect[];
  rooms: DetectedRoom[];
  /** 推定した壁の線の太さ（px） */
  lineWidth: number;
}

interface Component extends PxRect {
  count: number;
  r: number; g: number; b: number;
  border: boolean;
}

const DARK_LUMINANCE = 110;
const MAX_IMAGE_SIZE = 1600;

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const colorDistance = (a: RGB, b: RGB) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const meanColor = (c: Component): RGB => [c.r / c.count, c.g / c.count, c.b / c.count];

export function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** 取り込み元の1ページ（画像なら1枚、PDF なら各ページ） */
export interface SourcePage {
  data: ImageData;
  /** 下絵として表示する画像 */
  blob: Blob;
}

const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/** 画像または PDF を読み込み、ページごとの画像にする */
export async function loadSource(file: File): Promise<SourcePage[]> {
  if (isPdf(file)) {
    // pdf.js は大きいので、PDF を開くときだけ読み込む
    const { renderPdf } = await import("./pdfPages");
    return renderPdf(file, MAX_IMAGE_SIZE);
  }
  return [{ data: await loadImageData(file), blob: file }];
}

/** 画像を読み込み、大きすぎる場合は縮小した ImageData を返す */
export async function loadImageData(file: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // 透過部分は白として扱う
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** 線で区切られた、似た色で連続する領域に分ける（-1 は線） */
function segment(img: ImageData, tolerance: number): { labels: Int32Array; comps: Component[] } {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const labels = new Int32Array(n).fill(-2);
  for (let i = 0; i < n; i++) {
    if (luminance(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) < DARK_LUMINANCE) labels[i] = -1;
  }
  const comps: Component[] = [];
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -2) continue;
    const id = comps.length;
    const seed: RGB = [data[start * 4], data[start * 4 + 1], data[start * 4 + 2]];
    const c: Component = { count: 0, r: 0, g: 0, b: 0, x0: w, y0: h, x1: 0, y1: 0, border: false };
    let head = 0, tail = 0;
    queue[tail++] = start;
    labels[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i - x) / w;
      c.count++;
      c.r += data[i * 4]; c.g += data[i * 4 + 1]; c.b += data[i * 4 + 2];
      if (x < c.x0) c.x0 = x;
      if (y < c.y0) c.y0 = y;
      if (x + 1 > c.x1) c.x1 = x + 1;
      if (y + 1 > c.y1) c.y1 = y + 1;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.border = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || labels[j] !== -2) continue;
        if (colorDistance(seed, [data[j * 4], data[j * 4 + 1], data[j * 4 + 2]]) > tolerance) continue;
        labels[j] = id;
        queue[tail++] = j;
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/** 無彩色で明るすぎない色のうち、最も面積が大きい色を歩行エリアの色と推定する */
function guessWalkColor(comps: Component[], total: number): RGB {
  const buckets = new Map<string, { area: number; r: number; g: number; b: number }>();
  for (const c of comps) {
    if (c.border || c.count < total * 0.001) continue;
    const [r, g, b] = meanColor(c);
    const lum = luminance(r, g, b);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 24 || lum < 150 || lum > 245) continue;
    const key = [r, g, b].map((v) => Math.round(v / 12)).join(",");
    const bucket = buckets.get(key) ?? { area: 0, r: 0, g: 0, b: 0 };
    bucket.area += c.count;
    bucket.r += r * c.count; bucket.g += g * c.count; bucket.b += b * c.count;
    buckets.set(key, bucket);
  }
  const best = [...buckets.values()].sort((a, b) => b.area - a.area)[0];
  if (best) return [best.r / best.area, best.g / best.area, best.b / best.area];
  const largest = comps.filter((c) => !c.border).sort((a, b) => b.count - a.count)[0];
  return largest ? meanColor(largest) : [224, 224, 224];
}

/** 正方形の構造要素での膨張 (dilate=true) / 収縮。横・縦に分けて移動窓で数える */
function morph(mask: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return mask;
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    const [len, lines] = horizontal ? [w, h] : [h, w];
    const at = (line: number, k: number) => (horizontal ? line * w + k : k * w + line);
    const size = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) if (k >= 0 && k < len) sum += src[at(line, k)];
      for (let k = 0; k < len; k++) {
        out[at(line, k)] = dilate ? (sum > 0 ? 1 : 0) : (sum === size ? 1 : 0);
        const add = k + r + 1, remove = k - r;
        if (add < len) sum += src[at(line, add)];
        if (remove >= 0) sum -= src[at(line, remove)];
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/** マスクを長方形の集まりに分解する（横方向の連続を縦に積み上げる） */
function maskToRects(mask: Uint8Array, w: number, h: number, cell: number): PxRect[] {
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const on = (gx: number, gy: number) => {
    let hit = 0, all = 0;
    for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y++) {
      for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x++) {
        hit += mask[y * w + x];
        all++;
      }
    }
    return hit * 2 >= all;
  };
  // 行ごとの横方向の連続を、上の行とほぼ同じ幅（±1セル）なら縦に積み上げる。
  // 壁の端などで1セルだけずれた行ができても分断されないようにするため。
  const rects: PxRect[] = [];
  let active: PxRect[] = [];
  for (let gy = 0; gy <= gh; gy++) {
    const next: PxRect[] = [];
    let gx = 0;
    while (gy < gh && gx < gw) {
      if (!on(gx, gy)) { gx++; continue; }
      const x0 = gx;
      while (gx < gw && on(gx, gy)) gx++;
      const index = active.findIndex((r) => Math.abs(r.x0 - x0) <= 1 && Math.abs(r.x1 - gx) <= 1);
      const rect = index >= 0 ? active.splice(index, 1)[0] : { x0, x1: gx, y0: gy, y1: gy };
      rect.x0 = Math.min(rect.x0, x0);
      rect.x1 = Math.max(rect.x1, gx);
      rect.y1 = gy + 1;
      next.push(rect);
    }
    rects.push(...active);
    active = next;
  }
  return rects
    .filter((r) => (r.x1 - r.x0) * (r.y1 - r.y0) >= 4)
    .map((r) => ({
      x0: r.x0 * cell, y0: r.y0 * cell,
      x1: Math.min(w, r.x1 * cell), y1: Math.min(h, r.y1 * cell),
    }));
}

/** 部屋の辺の外側で歩行エリアに接する位置を探す */
function findDot(room: PxRect, mask: Uint8Array, w: number, h: number): [number, number] | undefined {
  const isWalk = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && mask[Math.round(y) * w + Math.round(x)] === 1;
  const sides = [
    { along: [room.x0, room.x1], at: (t: number, d: number) => [t, room.y0 - d] },
    { along: [room.x0, room.x1], at: (t: number, d: number) => [t, room.y1 - 1 + d] },
    { along: [room.y0, room.y1], at: (t: number, d: number) => [room.x0 - d, t] },
    { along: [room.y0, room.y1], at: (t: number, d: number) => [room.x1 - 1 + d, t] },
  ] as const;
  let best: { hits: number[][]; d: number } | null = null;
  for (const side of sides) {
    const [a, b] = side.along;
    for (let d = 2; d <= 14; d++) {
      const hits: number[][] = [];
      for (let t = a + (b - a) * 0.1; t <= a + (b - a) * 0.9; t++) {
        const p = side.at(t, d);
        if (isWalk(p[0], p[1])) hits.push([t, d]);
      }
      if (!hits.length) continue;
      // 通路に入り込んだ位置に置くため、見つかった距離より少し外側を使う
      const inner = hits.map(([t]) => side.at(t, d + 4)).filter(([x, y]) => isWalk(x, y));
      const points = inner.length ? inner : hits.map(([t]) => side.at(t, d));
      if (!best || points.length > best.hits.length) best = { hits: points.map((p) => [...p]), d };
      break;
    }
  }
  if (!best) return undefined;
  const mid = best.hits[Math.floor(best.hits.length / 2)];
  return [mid[0], mid[1]];
}

/** (x, y) から (dx, dy) 方向に続く線の画素数 */
function lineRun(isLine: Uint8Array, w: number, h: number, x: number, y: number, dx: number, dy: number, max: number): number {
  let n = 0;
  for (let k = 1; k <= max; k++) {
    const px = x + dx * k, py = y + dy * k;
    if (px < 0 || py < 0 || px >= w || py >= h || !isLine[py * w + px]) break;
    n++;
  }
  return n;
}

/** 線の画素へ歩行エリアを広げる（壁の中心まで届かせる） */
function growInto(mask: Uint8Array, allowed: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let cur = mask;
  for (let it = 0; it < iterations; it++) {
    const next = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i] || !allowed[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

interface LineComp extends PxRect { count: number; border: boolean; }

/** 暗い画素の連結成分（8近傍）。階段の印のような「浮いた線」を探すのに使う */
function lineComponents(isDark: (i: number) => boolean, w: number, h: number): LineComp[] {
  const seen = new Uint8Array(w * h);
  const out: LineComp[] = [];
  const queue = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !isDark(start)) continue;
    const c: LineComp = { x0: w, y0: h, x1: 0, y1: 0, count: 0, border: false };
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i - x) / w;
      c.count++;
      c.x0 = Math.min(c.x0, x); c.y0 = Math.min(c.y0, y);
      c.x1 = Math.max(c.x1, x + 1); c.y1 = Math.max(c.y1, y + 1);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) c.border = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (seen[j] || !isDark(j)) continue;
          seen[j] = 1;
          queue[tail++] = j;
        }
      }
    }
    out.push(c);
  }
  return out;
}

const overlaps = (a: PxRect, b: PxRect, gap: number) =>
  a.x0 <= b.x1 + gap && b.x0 <= a.x1 + gap && a.y0 <= b.y1 + gap && b.y0 <= a.y1 + gap;

/**
 * 階段を検出する。
 * 領域の内側に浮いている細長い線（両側が同じ領域）を階段の印とみなし、
 * 部屋として検出される領域ならその領域を、通路の一部なら線の周りの壁までを階段とする。
 */
function detectStairs(
  labels: Int32Array, isLine: Uint8Array, isWalkComp: boolean[], w: number, h: number,
): { stairComps: Set<number>; walkStairs: PxRect[] } {
  const stairComps = new Set<number>();
  const rects: PxRect[] = [];
  const labelAt = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -3 : labels[y * w + x]);
  const lines = lineComponents((i) => labels[i] === -1, w, h);
  /** 同じ直線上の近くに別の線片がある（点線・一点鎖線の1片） */
  const isDash = (line: LineComp, vertical: boolean, long: number) => lines.some((o) => {
    if (o === line) return false;
    return vertical
      ? Math.abs((o.x0 + o.x1) - (line.x0 + line.x1)) <= 4 && o.x1 - o.x0 <= 4 &&
        o.y1 >= line.y0 - long && o.y0 <= line.y1 + long && (o.y1 <= line.y0 || o.y0 >= line.y1)
      : Math.abs((o.y0 + o.y1) - (line.y0 + line.y1)) <= 4 && o.y1 - o.y0 <= 4 &&
        o.x1 >= line.x0 - long && o.x0 <= line.x1 + long && (o.x1 <= line.x0 || o.x0 >= line.x1);
  });
  for (const line of lines) {
    const bw = line.x1 - line.x0, bh = line.y1 - line.y0;
    const long = Math.max(bw, bh), thin = Math.min(bw, bh);
    if (line.border || thin > 4 || long < 10 || long < thin * 4) continue;
    const vertical = bh > bw;
    if (isDash(line, vertical, long)) continue;
    const cx = Math.floor((line.x0 + line.x1) / 2), cy = Math.floor((line.y0 + line.y1) / 2);
    // 線の両側が同じ領域なら「浮いた線」（ドア脇の壁などは両側が別の領域になる）
    const [a, b] = vertical
      ? [labelAt(line.x0 - 2, cy), labelAt(line.x1 + 1, cy)]
      : [labelAt(cx, line.y0 - 2), labelAt(cx, line.y1 + 1)];
    if (a < 0 || a !== b) continue;
    if (!isWalkComp[a]) {
      stairComps.add(a);
      continue;
    }
    // 通路の一部: 線と直交する向きは両側の壁まで、線の向きは壁までの距離（片側だけなら反対側にも同じ距離）
    const scan = (x: number, y: number, dx: number, dy: number) => {
      for (let k = 1; k <= long; k++) {
        const px = x + dx * k, py = y + dy * k;
        if (px < 0 || py < 0 || px >= w || py >= h || isLine[py * w + px]) return k - 1;
      }
      return -1;
    };
    const fill = (pair: number[], fallback: number) => {
      const known = pair.filter((v) => v >= 0);
      const d = known.length ? Math.min(...known) : fallback;
      return pair.map((v) => (v >= 0 ? v : d));
    };
    const [acrossA, acrossB] = fill(vertical
      ? [scan(line.x0, cy, -1, 0), scan(line.x1 - 1, cy, 1, 0)]
      : [scan(cx, line.y0, 0, -1), scan(cx, line.y1 - 1, 0, 1)], Math.round(long / 3));
    const [alongA, alongB] = fill(vertical
      ? [scan(cx, line.y0, 0, -1), scan(cx, line.y1 - 1, 0, 1)]
      : [scan(line.x0, cy, -1, 0), scan(line.x1 - 1, cy, 1, 0)], Math.round(long / 4));
    rects.push(vertical
      ? { x0: line.x0 - acrossA, x1: line.x1 + acrossB, y0: line.y0 - alongA, y1: line.y1 + alongB }
      : { x0: line.x0 - alongA, x1: line.x1 + alongB, y0: line.y0 - acrossA, y1: line.y1 + acrossB });
  }
  // 段板のように何本も線がある階段は1つにまとめる
  const walkStairs: PxRect[] = [];
  for (const r of rects) {
    const hit = walkStairs.find((m) => overlaps(m, r, 3));
    if (hit) {
      hit.x0 = Math.min(hit.x0, r.x0); hit.y0 = Math.min(hit.y0, r.y0);
      hit.x1 = Math.max(hit.x1, r.x1); hit.y1 = Math.max(hit.y1, r.y1);
    } else {
      walkStairs.push({ ...r });
    }
  }
  // 点線の1片などでできた小さすぎる候補は除く
  const minSize = 10;
  return { stairComps, walkStairs: walkStairs.filter((r) => r.x1 - r.x0 >= minSize && r.y1 - r.y0 >= minSize) };
}

/** 各辺の外側にある壁の線の太さを測り、部屋を線の中心まで広げる。測った太さを返す */
function expandToWallCenter(room: PxRect, isLine: Uint8Array, w: number, h: number): number[] {
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const sample = (a: number, b: number) => [0.25, 0.5, 0.75].map((t) => Math.round(a + (b - a - 1) * t));
  const top = median(sample(room.x0, room.x1).map((x) => lineRun(isLine, w, h, x, room.y0, 0, -1, 8)));
  const bottom = median(sample(room.x0, room.x1).map((x) => lineRun(isLine, w, h, x, room.y1 - 1, 0, 1, 8)));
  const left = median(sample(room.y0, room.y1).map((y) => lineRun(isLine, w, h, room.x0, y, -1, 0, 8)));
  const right = median(sample(room.y0, room.y1).map((y) => lineRun(isLine, w, h, room.x1 - 1, y, 1, 0, 8)));
  // 8px 以上続くのは壁ではなく別の暗い領域なので広げない
  const half = (run: number) => (run < 8 ? Math.floor(run / 2) : 0);
  room.y0 -= half(top);
  room.y1 += half(bottom);
  room.x0 -= half(left);
  room.x1 += half(right);
  return [top, bottom, left, right].filter((run) => run > 0 && run < 8);
}

export function analyzeImage(img: ImageData, options: AnalyzeOptions): Analysis {
  const { width: w, height: h } = img;
  const n = w * h;
  const { labels, comps } = segment(img, options.tolerance);
  const walkColor = options.walkColor ?? guessWalkColor(comps, n);
  const isWalkComp = comps.map((c) => !c.border && colorDistance(meanColor(c), walkColor) <= options.tolerance);

  // 線 = 暗い画素と、線のふちのアンチエイリアスでできた小さな領域
  const noise = Math.max(12, n * 0.00002);
  const isLine = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] === -1 || comps[labels[i]].count < noise) isLine[i] = 1;

  const { stairComps, walkStairs } = options.detectStairs
    ? detectStairs(labels, isLine, isWalkComp, w, h)
    : { stairComps: new Set<number>(), walkStairs: [] as PxRect[] };

  const minArea = n * options.minRoomRatio;
  const rooms: DetectedRoom[] = comps
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => !c.border && !isWalkComp[i] && c.count >= minArea &&
      c.x1 - c.x0 >= 4 && c.y1 - c.y0 >= 4 &&
      c.count / ((c.x1 - c.x0) * (c.y1 - c.y0)) >= 0.6)
    .map(({ c, i }) => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, color: meanColor(c), stair: stairComps.has(i) }));
  const runs = rooms.flatMap((room) => expandToWallCenter(room, isLine, w, h));
  const lineWidth = runs.length ? runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)] : 1;
  rooms.push(...walkStairs.map((r) => ({ ...r, color: walkColor, stair: true })));

  let mask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] >= 0 && isWalkComp[labels[i]]) mask[i] = 1;
  // 通路内の細い線（階段の印・点線など）を埋める
  mask = morph(morph(mask, w, h, options.closeRadius, true), w, h, options.closeRadius, false);
  // 壁の線の中心まで広げ、部屋との間に隙間ができないようにする
  mask = growInto(mask, isLine, w, h, Math.ceil(lineWidth / 2));

  const cell = Math.max(2, Math.round(Math.max(w, h) / 400));
  const walkRects = maskToRects(mask, w, h, cell);

  // 上の行から左→右の順に並べる
  const rowHeight = Math.max(4, h * 0.05);
  rooms.sort((a, b) => Math.floor(a.y0 / rowHeight) - Math.floor(b.y0 / rowHeight) || a.x0 - b.x0);
  for (const room of rooms) room.dot = findDot(room, mask, w, h);

  return { width: w, height: h, walkColor, cell, walkRects, rooms, lineWidth };
}

// ---------------------------------------------------------------- 地図座標への変換

/** 画像を地図 (700x800) の中央に、余白を残して収まるよう配置する */
export function imageToMap(width: number, height: number, margin = 20) {
  const scale = Math.min((SVG_WIDTH - margin * 2) / width, (SVG_HEIGHT - margin * 2) / height);
  const ox = (SVG_WIDTH - width * scale) / 2;
  const oy = (SVG_HEIGHT - height * scale) / 2;
  const point = (x: number, y: number): LatLng =>
    [Math.round(SVG_HEIGHT - (oy + y * scale)), Math.round(ox + x * scale)];
  /** 地図上で画像を置く範囲 [[下, 左], [上, 右]] */
  const bounds: [LatLng, LatLng] = [point(0, height), point(width, 0)];
  return { point, bounds, scale };
}

export interface ImportedFloor {
  shapes: Shape[];
  rooms: RoomInfo[];
}

/**
 * 近い座標値（eps 以内）を1つにまとめる関数を作る。
 * 隣り合う部屋の辺や、部屋と通路の境目をぴったりそろえるのに使う。
 */
function clusterSnap(values: number[], eps: number): (v: number) => number {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const snapped = new Map<number, number>();
  let group: number[] = [];
  const flush = () => {
    const mean = Math.round(group.reduce((sum, v) => sum + v, 0) / group.length);
    for (const v of group) snapped.set(v, mean);
    group = [];
  };
  for (const v of sorted) {
    if (group.length && v - group[0] > eps) flush();
    group.push(v);
  }
  if (group.length) flush();
  return (v) => snapped.get(v) ?? v;
}

export function toMapData(
  analysis: Analysis,
  include: { walk: boolean; rooms: boolean; dots: boolean },
): ImportedFloor {
  const { point, scale } = imageToMap(analysis.width, analysis.height);
  const rectPoints = (r: PxRect): LatLng[] =>
    [point(r.x0, r.y0), point(r.x1, r.y0), point(r.x1, r.y1), point(r.x0, r.y1)];
  // 検出の格子（cell）の 1.5 倍未満のずれ・段差はそろえる
  const eps = Math.max(1.5, analysis.cell * scale * 1.5);
  // 検出した長方形は結合して、通路ごとの外周を持つ多角形にする
  let shapes: Shape[] = include.walk
    ? mergeWalkShapes(analysis.walkRects.map((r) => ({ kind: "walk" as const, points: rectPoints(r) })))
      .map((shape) => ({ ...shape, points: removeSmallSteps(shape.points, eps) }))
    : [];
  const detected = include.rooms ? analysis.rooms : [];
  const roomRects = detected.map((r) => {
    const [top, left] = point(r.x0, r.y0);
    const [bottom, right] = point(r.x1, r.y1);
    return { top, left, bottom, right };
  });

  // 部屋の辺と通路の頂点の座標をそろえ、隙間や重なりをなくす
  const snapLat = clusterSnap([
    ...roomRects.flatMap((r) => [r.top, r.bottom]),
    ...shapes.flatMap((s) => s.points.map((p) => p[0])),
  ], eps);
  const snapLng = clusterSnap([
    ...roomRects.flatMap((r) => [r.left, r.right]),
    ...shapes.flatMap((s) => s.points.map((p) => p[1])),
  ], eps);
  shapes = shapes
    .map((shape) => ({
      ...shape,
      points: cleanPoints(shape.points.map(([lat, lng]): LatLng => [snapLat(lat), snapLng(lng)])),
    }))
    .filter((shape) => shape.points.length >= 3);

  let roomNumber = 0;
  const rooms: RoomInfo[] = detected.map((r, i) => {
    const raw = roomRects[i];
    const snapped = { top: snapLat(raw.top), bottom: snapLat(raw.bottom), left: snapLng(raw.left), right: snapLng(raw.right) };
    // そろえた結果つぶれてしまう小さな部屋は元の座標のまま
    const { top, bottom, left, right } =
      snapped.top - snapped.bottom >= 2 && snapped.right - snapped.left >= 2 ? snapped : raw;
    // 階段の名前と StairID は、ほかの階との対応づけ（エディタ側）で決める
    const room: RoomInfo = { name: r.stair ? "階段" : `部屋${++roomNumber}`, bounds: [[bottom, right], [top, left]] };
    if (include.dots) {
      // 最終的な歩行エリアに対して置く（画像上の位置は、見つからないときの予備）
      const dot = findDotOnMap({ top, bottom, left, right }, shapes) ??
        (r.dot && (!shapes.length || isWalkable(point(r.dot[0], r.dot[1]), shapes)) ? point(r.dot[0], r.dot[1]) : undefined);
      if (dot) room.lineDot = dot;
    }
    return room;
  });
  return { shapes, rooms };
}

/**
 * 部屋の各辺のすぐ外側を調べ、歩行エリアに最も広く接している辺の中央付近に lineDot を置く。
 * 輪郭をならしたり座標をそろえたりした後の、最終的な形に対して判定する。
 */
function findDotOnMap(room: { top: number; bottom: number; left: number; right: number }, shapes: Shape[]): LatLng | undefined {
  if (!shapes.some((s) => s.kind === "walk")) return undefined;
  const sides: { from: number; to: number; at: (t: number, d: number) => LatLng }[] = [
    { from: room.left, to: room.right, at: (t, d) => [room.top + d, t] },
    { from: room.left, to: room.right, at: (t, d) => [room.bottom - d, t] },
    { from: room.bottom, to: room.top, at: (t, d) => [t, room.left - d] },
    { from: room.bottom, to: room.top, at: (t, d) => [t, room.right + d] },
  ];
  let best: { side: (typeof sides)[number]; hits: number[]; d: number } | null = null;
  for (const side of sides) {
    const span = side.to - side.from;
    for (const d of [2, 3, 4, 6, 8, 10]) {
      const hits: number[] = [];
      for (let t = side.from + span * 0.1; t <= side.from + span * 0.9; t += 1) {
        // 通路に少し入り込んだ位置まで歩けること
        if (isWalkable(side.at(t, d), shapes) && isWalkable(side.at(t, d + 2), shapes)) hits.push(t);
      }
      if (!hits.length) continue;
      if (!best || hits.length > best.hits.length) best = { side, hits, d };
      break;
    }
  }
  if (!best) return undefined;
  const t = best.hits[Math.floor(best.hits.length / 2)];
  const [lat, lng] = best.side.at(t, best.d + 2);
  return [Math.round(lat), Math.round(lng)];
}
