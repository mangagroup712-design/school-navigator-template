import polygonClipping, { type Polygon, type Ring } from "polygon-clipping";
import { SVG_HEIGHT, SVG_WIDTH } from "../map/constants";

/**
 * フロア形状（歩行エリア・障害物・装飾）と、そこから生成する階層SVG。
 *
 * 生成SVGはアプリ本体からは通常の地図画像として表示され、経路探索は
 * 塗り色 #caffd1 の図形を歩行可能エリアとして読む（src/map/search の buildFloorGrid）。
 * 編集用の元データは <metadata> に JSON で埋め込み、エディタで再編集できるようにする。
 */

export type ShapeKind = "walk" | "block" | "deco" | "floor";
export type LatLng = [number, number];

export interface Shape {
  kind: ShapeKind;
  /** [lat, lng] の頂点列（閉じた多角形） */
  points: LatLng[];
  /** 装飾の塗り色 */
  color?: string;
}

/** 廊下（歩行エリア）の色 */
export const WALK_FILL = "#dcdcdc";
/** 廊下の輪郭（外形の内側の区切り） */
export const WALK_STROKE = "#a8a8a8";
const WALK_STROKE_WIDTH = 2;
export const FLOOR_FILL = "#ffffff";
/** 建物の外形の枠（緑の太線） */
export const FLOOR_STROKE = "#13ae67";
const FLOOR_STROKE_WIDTH = 12;

export const SHAPE_KINDS: Record<ShapeKind, { label: string; hint: string }> = {
  walk: { label: "歩行エリア", hint: "廊下・ホールなど歩ける範囲。経路探索に使われます" },
  block: { label: "障害物", hint: "歩行エリア内の柱・吹き抜けなど。歩行エリアから切り抜かれます" },
  deco: { label: "装飾", hint: "校庭・植え込みなど見た目だけの領域。経路探索には使われません" },
  floor: { label: "外形", hint: "建物（フロア）の外形。描かない場合は歩行エリアと部屋から自動で作られます" },
};

export const DECO_COLORS = ["#e0e0e0", "#d7ccc8", "#c8e6c9", "#bbdefb", "#fff9c4", "#ffe0b2"];

const round = (v: number) => Math.round(v * 100) / 100;

/** 符号付き面積（[lat, lng] 平面で反時計回りが正） */
export function signedArea(points: LatLng[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [y1, x1] = points[i];
    const [y2, x2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function pointInPolygon([lat, lng]: LatLng, points: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [yi, xi] = points[i];
    const [yj, xj] = points[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 歩行エリアのいずれかに含まれ、障害物に含まれない点か */
export function isWalkable(point: LatLng, shapes: Shape[]): boolean {
  return shapes.some((s) => s.kind === "walk" && pointInPolygon(point, s.points)) &&
    !shapes.some((s) => s.kind === "block" && pointInPolygon(point, s.points));
}

function segmentsIntersect(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const cross = (p: LatLng, q: LatLng, r: LatLng) => (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
  const within = (p: LatLng, q: LatLng, r: LatLng) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) ||
    (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

/** 2つの多角形が重なる・接するか */
export function polygonsTouch(a: LatLng[], b: LatLng[]): boolean {
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
  return a.some((p, i) => b.some((q, j) =>
    segmentsIntersect(p, a[(i + 1) % a.length], q, b[(j + 1) % b.length])));
}

/** 歩行エリアを、重なり・接触でつながったグループに分ける（形状の index の配列） */
export function walkGroups(shapes: Shape[]): number[][] {
  const walk = shapes.map((s, i) => ({ s, i })).filter(({ s }) => s.kind === "walk" && s.points.length >= 3);
  const parent = new Map(walk.map(({ i }) => [i, i]));
  const find = (i: number): number => (parent.get(i) === i ? i : find(parent.get(i)!));
  for (let x = 0; x < walk.length; x++) {
    for (let y = x + 1; y < walk.length; y++) {
      if (polygonsTouch(walk[x].s.points, walk[y].s.points)) parent.set(find(walk[x].i), find(walk[y].i));
    }
  }
  const groups = new Map<number, number[]>();
  for (const { i } of walk) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return [...groups.values()];
}

// ---------------------------------------------------------------- 結合

const toRing = (points: LatLng[]): Ring => [...points, points[0]];

/** 頂点列から重複点と一直線上の点を取り除く */
export const cleanPoints = (points: LatLng[]): LatLng[] => cleanRing(toRing(points));

/** 閉じたリングを頂点列に戻し、重複点と一直線上の点を取り除く */
function cleanRing(ring: Ring): LatLng[] {
  let points: LatLng[] = ring.slice(0, -1).map(([a, b]) => [round(a), round(b)]);
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    const next: LatLng[] = [];
    for (let i = 0; i < points.length; i++) {
      const prev = next[next.length - 1] ?? points[points.length - 1];
      const cur = points[i];
      const after = points[(i + 1) % points.length];
      const cross = (cur[0] - prev[0]) * (after[1] - cur[1]) - (cur[1] - prev[1]) * (after[0] - cur[0]);
      if ((cur[0] === prev[0] && cur[1] === prev[1]) || Math.abs(cross) < 1e-9) {
        changed = true;
        continue;
      }
      next.push(cur);
    }
    points = next;
  }
  return points;
}

/**
 * 直交した輪郭の小さな段差（Z 字の短い辺）をならす。
 * 画像から検出した輪郭の、1〜2px のずれで生じたギザギザを取るのに使う。
 */
export function removeSmallSteps(points: LatLng[], eps: number): LatLng[] {
  let pts = points.map((p) => [...p] as LatLng);
  for (let pass = 0; pass < 20 && pts.length > 4; pass++) {
    let changed = false;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % n], p2 = pts[(i + 2) % n], p3 = pts[(i + 3) % n];
      // axis: 短い辺 p1→p2 が動く方向（0 = lat, 1 = lng）
      const found = p1[0] !== p2[0] && p1[1] === p2[1] ? 0 : p1[1] !== p2[1] && p1[0] === p2[0] ? 1 : -1;
      if (found < 0) continue;
      const axis = found as 0 | 1;
      const other = (1 - axis) as 0 | 1;
      if (Math.abs(p1[axis] - p2[axis]) >= eps) continue;
      // 前後の辺が同じ向きに平行なとき（Z 字）だけならす
      const along0 = p1[other] - p0[other], along1 = p3[other] - p2[other];
      if (p0[axis] !== p1[axis] || p2[axis] !== p3[axis] || Math.sign(along0) !== Math.sign(along1) || !along0) continue;
      // 短い方の辺を長い方の辺の高さにそろえる
      if (Math.abs(along0) >= Math.abs(along1)) {
        p2[axis] = p1[axis];
        p3[axis] = p1[axis];
      } else {
        p0[axis] = p2[axis];
        p1[axis] = p2[axis];
      }
      changed = true;
      break;
    }
    if (!changed) break;
    pts = cleanRing(toRing(pts));
  }
  return pts;
}

/** 歩行エリアの和集合（外周と穴のリング）。表示用の輪郭線や結合に使う */
export function walkUnion(shapes: Shape[]): LatLng[][][] {
  const polygons: Polygon[] = shapes
    .filter((s) => s.kind === "walk" && s.points.length >= 3)
    .map((s) => [toRing(s.points)]);
  if (!polygons.length) return [];
  return polygonClipping.union(polygons[0], ...polygons.slice(1))
    .map((polygon) => polygon.map(cleanRing).filter((ring) => ring.length >= 3));
}

/**
 * 重なる・接する歩行エリアを1つの多角形に結合する。
 * 結合でできた穴（中庭など）は障害物になる。装飾と既存の障害物はそのまま残す。
 */
export function mergeWalkShapes(shapes: Shape[]): Shape[] {
  const union = walkUnion(shapes);
  const byKind = (kind: ShapeKind) => shapes.filter((s) => s.kind === kind);
  // 描画順: 装飾 → 歩行エリア → 障害物（歩行エリアの上に見えるように）
  return [
    ...byKind("deco"),
    ...byKind("floor"),
    ...union.map(([outer]) => ({ kind: "walk" as const, points: outer })),
    ...byKind("block"),
    ...union.flatMap(([, ...holes]) => holes.map((points) => ({ kind: "block" as const, points }))),
  ];
}

/** 部屋の範囲を多角形にする（隣との細い隙間を埋めるため pad だけ広げる） */
function roomRing(room: RoomInfo, pad: number): Ring {
  const [[a, b], [c, d]] = room.bounds;
  const n = Math.max(a, c) + pad, s = Math.min(a, c) - pad;
  const w = Math.min(b, d) - pad, e = Math.max(b, d) + pad;
  return [[n, w], [n, e], [s, e], [s, w], [n, w]];
}

/** 外形の穴のうち、これより小さいもの（部屋と通路の間のすき間など）は埋める */
const MIN_COURTYARD_AREA = 400;

/**
 * フロアの外形（建物の輪郭）。
 * 「外形」の形状が描かれていればそれを使い、なければ歩行エリアと部屋を合わせた範囲から作る。
 */
export function floorOutline(shapes: Shape[], rooms: RoomInfo[]): LatLng[][][] {
  const manual = shapes.filter((s) => s.kind === "floor" && s.points.length >= 3);
  const polygons: Polygon[] = manual.length
    ? manual.map((s) => [toRing(s.points)])
    : [
      ...shapes.filter((s) => s.kind === "walk" && s.points.length >= 3).map((s) => [toRing(s.points)]),
      ...rooms.map((r) => [roomRing(r, 1)]),
    ];
  if (!polygons.length) return [];
  return polygonClipping.union(polygons[0], ...polygons.slice(1))
    .map(([outer, ...holes]) => [outer, ...holes.filter((h) => Math.abs(signedArea(h.slice(0, -1))) >= MIN_COURTYARD_AREA)]
      .map(cleanRing)
      .filter((ring) => ring.length >= 3))
    .filter((polygon) => polygon.length);
}

export function centroid(points: LatLng[]): LatLng {
  const lat = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  return [lat, lng];
}

/** [lat, lng] → SVG の "x y"（SVG は上が y=0） */
const svgPoint = ([lat, lng]: LatLng) => `${round(lng)} ${round(SVG_HEIGHT - lat)}`;

/**
 * 多角形をパスのサブパスにする。
 * 歩行エリアと障害物で回転方向を逆にし、nonzero 塗りで障害物が穴になるようにする。
 */
function ring(points: LatLng[], counterClockwise: boolean): string {
  const ordered = (signedArea(points) > 0) === counterClockwise ? points : [...points].reverse();
  return `M${ordered.map(svgPoint).join("L")}Z`;
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function shapesToSvg(shapes: Shape[], rooms: RoomInfo[] = []): string {
  const valid = shapes.filter((s) => s.points.length >= 3);
  // 外形は外周と中庭（穴）を1つのパスにし、evenodd で穴を抜く
  const outline = floorOutline(valid, rooms)
    .map((polygon) => polygon.map((r) => `M${r.map(svgPoint).join("L")}Z`).join(""))
    .join("");
  const deco = valid.filter((s) => s.kind === "deco");
  const walkPath = [
    ...valid.filter((s) => s.kind === "walk").map((s) => ring(s.points, true)),
    ...valid.filter((s) => s.kind === "block").map((s) => ring(s.points, false)),
  ].join("");
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" data-map-editor="1">`,
    `  <metadata id="map-editor">${escapeXml(JSON.stringify({ version: 1, shapes }))}</metadata>`,
    `  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#ffffff"/>`,
    ...deco.map((s) =>
      `  <path d="${ring(s.points, true)}" fill="${s.color ?? DECO_COLORS[0]}" stroke="#9e9e9e" stroke-width="2" stroke-linejoin="round"/>`),
  ];
  if (outline) lines.push(`  <path d="${outline}" fill="${FLOOR_FILL}" fill-rule="evenodd"/>`);
  if (walkPath) {
    // 経路探索は data-walkable の付いた図形を歩行エリアとして読む。
    // 1枚目で輪郭線を描き、2枚目の塗りで重なった歩行エリア同士の内側の線を消す
    lines.push(
      `  <path d="${walkPath}" data-walkable="1" fill="${WALK_FILL}" stroke="${WALK_STROKE}" stroke-width="${WALK_STROKE_WIDTH}" stroke-linejoin="round"/>`,
      `  <path d="${walkPath}" data-walkable="1" fill="${WALK_FILL}"/>`,
    );
  }
  // 外形の枠は廊下に隠れないよう最後に重ねる
  if (outline) {
    lines.push(`  <path d="${outline}" fill="none" stroke="${FLOOR_STROKE}" stroke-width="${FLOOR_STROKE_WIDTH}" stroke-linejoin="round"/>`);
  }
  lines.push("</svg>", "");
  return lines.join("\n");
}

/** エディタが生成したSVGなら形状を取り出す。それ以外のSVGは null。 */
export function parseEditorSvg(text: string): Shape[] | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (!doc.documentElement.hasAttribute("data-map-editor")) return null;
  try {
    const data = JSON.parse(doc.getElementById("map-editor")?.textContent ?? "");
    return Array.isArray(data.shapes) ? data.shapes : [];
  } catch {
    return [];
  }
}
