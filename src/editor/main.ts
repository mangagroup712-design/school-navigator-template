import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./editor.css";
import { SVG_HEIGHT, SVG_WIDTH, mapBounds } from "../map/constants";
import {
  DECO_COLORS, FLOOR_FILL, FLOOR_STROKE, SHAPE_KINDS, WALK_FILL, WALK_STROKE,
  centroid, floorOutline, isWalkable, mergeWalkShapes, parseEditorSvg, pointInPolygon, shapesToSvg, walkGroups, walkUnion,
  type LatLng, type Shape, type ShapeKind,
} from "./shapes";
import { imageToMap } from "./imageImport";
import { setupImportDialog } from "./importDialog";

/**
 * 地図エディタ（開発用）。
 * env/mapinfo.js の部屋・階層と、フロア形状（→ env/map/*.svg を生成）を GUI で編集し、
 * 開発サーバー経由で保存する。
 * 座標はアプリ本体と同じ Leaflet CRS.Simple の [lat, lng]（lat は下が 0）。
 */

type Mode = "select" | "draw" | "dot" | "shape-rect" | "shape-poly";
interface Rect { n: number; s: number; w: number; e: number; }
/** shapes があるフロアはエディタ管理で、保存時に floorFile の SVG を生成する */
type EditorFloor = FloorInfo & { shapes?: Shape[] };
type EditorInfo = Omit<MapInfo, "floors"> & { floors: EditorFloor[] };

const API = "/__map-editor";
const DRAFT_KEY = "map-editor-draft";
const HISTORY_LIMIT = 200;

let info: EditorInfo = { floors: [] };
let floorIndex = 0;
let selected: number | null = null;
let selectedShape: number | null = null;
let mode: Mode = "select";
let savedJson = "";
let svgFiles: string[] = [];
/** ファイル → 最後に保存（読込）した SVG テキスト。変更があるときだけ書き出す */
const savedSvgs = new Map<string, string>();
/** floorFile → 下絵の画像と配置範囲（保存しない） */
interface TraceImage { url: string; bounds: L.LatLngBoundsExpression; }
const traceImages = new Map<string, TraceImage>();
const undoStack: string[] = [];
const redoStack: string[] = [];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("room-form");
const shapeForm = $<HTMLFormElement>("shape-form");
const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

// ---------------------------------------------------------------- geometry

const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
const snapValue = (v: number) => {
  const step = Number($<HTMLSelectElement>("snap").value) || 1;
  return Math.round(v / step) * step;
};
const snapLatLng = (p: L.LatLng): LatLng =>
  [clamp(snapValue(p.lat), SVG_HEIGHT), clamp(snapValue(p.lng), SVG_WIDTH)];

function rectOf(room: RoomInfo): Rect {
  const [[a, b], [c, d]] = room.bounds;
  return { n: Math.max(a, c), s: Math.min(a, c), w: Math.min(b, d), e: Math.max(b, d) };
}

/** アプリ本体のクリック判定に合わせ [[下, 右], [上, 左]] の順で保存する。 */
function setRect(room: RoomInfo, r: Rect): void {
  const n = Math.max(r.n, r.s), s = Math.min(r.n, r.s);
  const w = Math.min(r.w, r.e), e = Math.max(r.w, r.e);
  room.bounds = [[s, e], [n, w]];
}

const toLeaflet = (r: Rect) => L.latLngBounds([r.s, r.w], [r.n, r.e]);
const rectPoints = (r: Rect): LatLng[] => [[r.n, r.w], [r.n, r.e], [r.s, r.e], [r.s, r.w]];
const boundsOfPoints = (points: LatLng[]): Rect => ({
  n: Math.max(...points.map((p) => p[0])), s: Math.min(...points.map((p) => p[0])),
  w: Math.min(...points.map((p) => p[1])), e: Math.max(...points.map((p) => p[1])),
});
const isStair = (room: RoomInfo) => !!room.StairID || room.name.includes("階段");
const isToilet = (room: RoomInfo) => room.name.includes("トイレ");

function shiftRect(r: Rect, dLat: number, dLng: number): Rect {
  // 地図の外へはみ出さないよう移動量を制限する
  dLat = Math.min(SVG_HEIGHT - r.n, Math.max(-r.s, dLat));
  dLng = Math.min(SVG_WIDTH - r.e, Math.max(-r.w, dLng));
  return { n: r.n + dLat, s: r.s + dLat, w: r.w + dLng, e: r.e + dLng };
}

function shiftPoints(points: LatLng[], dLat: number, dLng: number): LatLng[] {
  const before = boundsOfPoints(points);
  const after = shiftRect(before, dLat, dLng);
  return points.map(([lat, lng]) => [lat + after.s - before.s, lng + after.w - before.w]);
}

/** Shift 押下時、直前の点から水平・垂直にそろえる */
function constrain(p: LatLng, from: LatLng | undefined, orthogonal: boolean): LatLng {
  if (!orthogonal || !from) return p;
  return Math.abs(p[0] - from[0]) > Math.abs(p[1] - from[1]) ? [p[0], from[1]] : [from[0], p[1]];
}

// ---------------------------------------------------------------- state

const floor = (): EditorFloor | undefined => info.floors[floorIndex];
const room = (): RoomInfo | undefined =>
  selected === null ? undefined : floor()?.rooms[selected];
const shape = (): Shape | undefined =>
  selectedShape === null ? undefined : floor()?.shapes?.[selectedShape];

/** 変更前に呼ぶ。undo 用のスナップショットを積む。 */
function checkpoint(): void {
  undoStack.push(JSON.stringify(info));
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function restore(from: string[], to: string[]): void {
  const snapshot = from.pop();
  if (!snapshot) return;
  to.push(JSON.stringify(info));
  info = JSON.parse(snapshot);
  floorIndex = Math.min(floorIndex, Math.max(0, info.floors.length - 1));
  if (selected !== null && selected >= (floor()?.rooms.length ?? 0)) selected = null;
  if (selectedShape !== null && selectedShape >= (floor()?.shapes?.length ?? 0)) selectedShape = null;
  renderAll();
}

function changed(): void {
  const json = JSON.stringify(info);
  try { localStorage.setItem(DRAFT_KEY, json); } catch { /* 下書き保存は任意 */ }
  const dirty = json !== savedJson;
  document.title = `${dirty ? "● " : ""}Map Editor`;
  setStatus(dirty ? "未保存の変更があります" : "保存済み", dirty ? "warn" : "ok");
}

function setStatus(text: string, kind: "ok" | "warn" | "error" = "ok"): void {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
}

// ---------------------------------------------------------------- map

const map = L.map("map", {
  crs: L.CRS.Simple,
  minZoom: -1,
  maxZoom: 5,
  zoomSnap: 0.25,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 120,
  boxZoom: false,
  doubleClickZoom: false,
}).fitBounds(mapBounds);

new ResizeObserver(() => map.invalidateSize()).observe($("map"));
const fitMap = () => map.fitBounds(mapBounds);

// 下から 背景画像・下絵 → フロア形状 → 部屋 → ハンドル
map.createPane("underlay").style.zIndex = "250";
map.createPane("shapes").style.zIndex = "350";
// 歩行エリアは塗りを不透明にして重ねても濃くならないようにし、下絵が透けるよう層ごと半透明にする
map.getPane("shapes")!.style.opacity = "0.85";
const shapeRenderer = L.svg({ pane: "shapes" });

let overlay: L.ImageOverlay | null = null;
let traceOverlay: L.ImageOverlay | null = null;
const shapeLayer = L.layerGroup().addTo(map);
const roomLayer = L.layerGroup().addTo(map);
const handleLayer = L.layerGroup().addTo(map);
L.rectangle(mapBounds, { color: "#888", weight: 1, fill: false, dashArray: "4 4", interactive: false }).addTo(map);

const rectLayers = new Map<number, L.Rectangle>();
const shapeLayers = new Map<number, L.Polygon>();

function styleFor(r: RoomInfo, isSelected: boolean): L.PathOptions {
  const color = isSelected ? "#f57c00" : isStair(r) ? "#8d6e63" : isToilet(r) ? "#00acc1" : "#3388ff";
  return {
    color,
    weight: isSelected ? 3 : 2,
    fillColor: color,
    fillOpacity: isSelected ? 0.3 : 0.15,
    dashArray: r.name ? undefined : "6 4",
    bubblingMouseEvents: false,
  };
}

function shapeStyle(s: Shape, isSelected: boolean): L.PolylineOptions {
  const base: L.PolylineOptions = {
    pane: "shapes",
    renderer: shapeRenderer,
    bubblingMouseEvents: false,
    weight: isSelected ? 3 : 2,
    lineJoin: "round",
  };
  if (s.kind === "walk") {
    // 個々の枠線は描かず、結合した外周を別に描く（renderMap）。選択中だけ自分の輪郭を出す
    return { ...base, stroke: isSelected, color: "#f57c00", fillColor: WALK_FILL, fillOpacity: 1 };
  }
  if (s.kind === "floor") {
    return { ...base, color: isSelected ? "#f57c00" : FLOOR_STROKE, dashArray: "8 4", fillColor: FLOOR_FILL, fillOpacity: 0.6 };
  }
  if (s.kind === "block") {
    return { ...base, color: isSelected ? "#f57c00" : "#c62828", dashArray: "6 4", fillColor: "#ffffff", fillOpacity: 0.9 };
  }
  return { ...base, color: isSelected ? "#f57c00" : "#9e9e9e", fillColor: s.color ?? DECO_COLORS[0], fillOpacity: 0.9 };
}

function floorImageUrl(file: string): string {
  return file.startsWith("map/") ? `${API}/file/${file}` : `/env/${file}`;
}

function setImage(
  current: L.ImageOverlay | null, url: string | null, opacity = 1, bounds: L.LatLngBoundsExpression = mapBounds,
): L.ImageOverlay | null {
  if (current && current.getElement()?.getAttribute("src") !== url) {
    current.remove();
    current = null;
  }
  if (url && !current) current = L.imageOverlay(url, bounds, { pane: "underlay", opacity }).addTo(map);
  current?.setOpacity(opacity);
  return current;
}

function renderMap(): void {
  const f = floor();
  // エディタ管理のフロアは形状そのものを描くので、SVG 画像は表示しない
  overlay = setImage(overlay, f && !f.shapes ? floorImageUrl(f.floorFile) : null);
  const trace = f ? traceImages.get(f.floorFile) ?? null : null;
  traceOverlay = setImage(traceOverlay, trace?.url ?? null, Number($<HTMLInputElement>("trace-opacity").value), trace?.bounds);
  traceOverlay?.bringToFront();
  $("trace-controls").hidden = !trace;

  shapeLayer.clearLayers();
  shapeLayers.clear();
  if (f?.shapes) {
    // フロアの外形（生成SVGと同じもの）を一番下に表示する
    for (const polygon of floorOutline(f.shapes, f.rooms)) {
      L.polygon(polygon, {
        pane: "shapes", renderer: shapeRenderer, interactive: false,
        color: FLOOR_STROKE, weight: 6, fillColor: FLOOR_FILL, fillOpacity: 1, lineJoin: "round",
      }).addTo(shapeLayer);
    }
  }
  f?.shapes?.forEach((s, i) => {
    const poly = L.polygon(s.points, shapeStyle(s, i === selectedShape));
    poly.on("mousedown", (e: L.LeafletMouseEvent) => onShapeMouseDown(e, i));
    poly.on("click", (e: L.LeafletMouseEvent) => {
      if (mode === "select") selectShape(i);
      else onMapClick(e);
    });
    poly.addTo(shapeLayer);
    shapeLayers.set(i, poly);
  });
  if (f?.shapes) {
    // 重なった歩行エリアを1つの輪郭として表示する
    for (const polygon of walkUnion(f.shapes)) {
      L.polygon(polygon, {
        pane: "shapes", renderer: shapeRenderer, interactive: false,
        color: WALK_STROKE, weight: 1.5, fill: false, lineJoin: "round",
      }).addTo(shapeLayer);
    }
    if (selectedShape !== null) shapeLayers.get(selectedShape)?.bringToFront();
  }

  roomLayer.clearLayers();
  rectLayers.clear();
  f?.rooms.forEach((r, i) => {
    const rect = L.rectangle(toLeaflet(rectOf(r)), styleFor(r, i === selected));
    rect.bindTooltip(roomLabel(r), {
      permanent: true,
      direction: "center",
      className: isStair(r) ? "room-label stair-label" : "room-label",
    });
    rect.on("mousedown", (e: L.LeafletMouseEvent) => onRoomMouseDown(e, i));
    rect.on("click", (e: L.LeafletMouseEvent) => { if (mode !== "select") onMapClick(e); });
    rect.addTo(roomLayer);
    rectLayers.set(i, rect);
    if (r.lineDot) {
      L.circleMarker(r.lineDot, {
        radius: 3, color: "#c62828", weight: 1, fillOpacity: 1, interactive: false,
      }).addTo(roomLayer);
    }
  });
  renderHandles();
}

/** 部屋名のラベル。階段にはリンク先の階を添える */
function roomLabel(r: RoomInfo): HTMLElement {
  const label = document.createElement("span");
  label.textContent = r.name || "(名前なし)";
  if (isStair(r)) {
    const links = stairLinks(r);
    const sub = document.createElement("small");
    sub.textContent = links.length ? `⇅ ${[...new Set(links.map((l) => l.floor.floorName))].join("・")}` : "未リンク";
    sub.classList.toggle("unlinked", !links.length);
    label.append(document.createElement("br"), sub);
  }
  return label;
}

/**
 * 選択の変更だけを反映する。
 * レイヤーを作り直すと、押下中の要素が消えて mouseup/click が地図側に流れ、
 * 選択がすぐ解除されてしまうため、既存レイヤーのスタイルだけ更新する。
 */
function renderSelection(): void {
  const f = floor();
  rectLayers.forEach((rect, i) => {
    const r = f?.rooms[i];
    if (r) rect.setStyle(styleFor(r, i === selected));
  });
  shapeLayers.forEach((poly, i) => {
    const s = f?.shapes?.[i];
    if (s) poly.setStyle(shapeStyle(s, i === selectedShape));
  });
  if (selectedShape !== null) shapeLayers.get(selectedShape)?.bringToFront();
  renderHandles();
}

function handleMarker(at: LatLng, className: string, size: number, title?: string): L.Marker {
  return L.marker(at, {
    draggable: true,
    icon: L.divIcon({ className, iconSize: [size, size] }),
    keyboard: false,
    title,
  });
}

// 選択中の部屋のリサイズハンドル・lineDot、または選択中の形状の頂点ハンドル
function renderHandles(): void {
  handleLayer.clearLayers();
  const r = room();
  if (r && selected !== null) renderRoomHandles(r, rectLayers.get(selected));
  const s = shape();
  if (s && selectedShape !== null) renderShapeHandles(s, shapeLayers.get(selectedShape));
}

function renderRoomHandles(r: RoomInfo, rect: L.Rectangle | undefined): void {
  const corners: [keyof Rect, keyof Rect][] = [["n", "w"], ["n", "e"], ["s", "w"], ["s", "e"]];
  for (const [latKey, lngKey] of corners) {
    const base = rectOf(r);
    const marker = handleMarker([base[latKey], base[lngKey]], "handle", 12);
    marker.on("dragstart", () => checkpoint());
    marker.on("drag", () => {
      const [lat, lng] = snapLatLng(marker.getLatLng());
      const next = { ...rectOf(r), [latKey]: lat, [lngKey]: lng };
      rect?.setBounds(toLeaflet(next));
      setCursor(lat, lng);
    });
    marker.on("dragend", () => {
      const [lat, lng] = snapLatLng(marker.getLatLng());
      setRect(r, { ...rectOf(r), [latKey]: lat, [lngKey]: lng });
      commit();
    });
    marker.addTo(handleLayer);
  }
  if (r.lineDot) {
    const dot = handleMarker(r.lineDot, "line-dot", 14, "lineDot（ドラッグで移動）");
    dot.on("dragstart", () => checkpoint());
    dot.on("drag", () => setCursor(...snapLatLng(dot.getLatLng())));
    dot.on("dragend", () => {
      r.lineDot = snapLatLng(dot.getLatLng());
      commit();
    });
    dot.addTo(handleLayer);
  }
}

function renderShapeHandles(s: Shape, poly: L.Polygon | undefined): void {
  const n = s.points.length;
  s.points.forEach((p, vi) => {
    const vertex = handleMarker(p, "handle vertex", 12, "ドラッグで移動 / 右クリックで削除");
    vertex.on("dragstart", () => checkpoint());
    vertex.on("drag", () => {
      const pts = s.points.slice();
      pts[vi] = snapLatLng(vertex.getLatLng());
      poly?.setLatLngs(pts);
      setCursor(...pts[vi]);
    });
    vertex.on("dragend", () => {
      s.points[vi] = snapLatLng(vertex.getLatLng());
      commit();
    });
    vertex.on("contextmenu", (e: L.LeafletMouseEvent) => {
      L.DomEvent.preventDefault(e.originalEvent);
      if (s.points.length <= 3) {
        setStatus("頂点は3つ以上必要です", "warn");
        return;
      }
      checkpoint();
      s.points.splice(vi, 1);
      commit();
    });
    vertex.addTo(handleLayer);

    // 辺の中点: ドラッグすると頂点を追加する
    const next = s.points[(vi + 1) % n];
    const mid: LatLng = [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2];
    const midpoint = handleMarker(mid, "midpoint", 10, "ドラッグで頂点を追加");
    midpoint.on("dragstart", () => {
      checkpoint();
      s.points.splice(vi + 1, 0, mid);
    });
    midpoint.on("drag", () => {
      const pts = s.points.slice();
      pts[vi + 1] = snapLatLng(midpoint.getLatLng());
      poly?.setLatLngs(pts);
    });
    midpoint.on("dragend", () => {
      s.points[vi + 1] = snapLatLng(midpoint.getLatLng());
      commit();
    });
    midpoint.addTo(handleLayer);
  });
}

// ---- マウス操作（描画・移動）

type Drag =
  | { kind: "draw"; target: "room" | "shape"; start: LatLng; preview: L.Rectangle }
  | { kind: "move"; index: number; origin: L.LatLng; rect: Rect; dot?: LatLng; moved: boolean }
  | { kind: "move-shape"; index: number; origin: L.LatLng; points: LatLng[]; moved: boolean };
let drag: Drag | null = null;

/** 多角形の作図中の状態 */
let polyDraft: { points: LatLng[]; line: L.Polyline; last: L.CircleMarker } | null = null;

function onRoomMouseDown(e: L.LeafletMouseEvent, index: number): void {
  if (mode !== "select") return onMapMouseDown(e);
  if (e.originalEvent.button !== 0) return;
  L.DomEvent.stop(e.originalEvent);
  if (selected !== index) select(index);
  const r = floor()!.rooms[index];
  map.dragging.disable();
  drag = { kind: "move", index, origin: e.latlng, rect: rectOf(r), dot: r.lineDot, moved: false };
}

function onShapeMouseDown(e: L.LeafletMouseEvent, index: number): void {
  if (mode !== "select") return onMapMouseDown(e);
  // 大きな歩行エリアをうっかり動かさないよう、選択済みの形状だけドラッグで移動する
  if (e.originalEvent.button !== 0 || selectedShape !== index) return;
  L.DomEvent.stop(e.originalEvent);
  map.dragging.disable();
  drag = { kind: "move-shape", index, origin: e.latlng, points: floor()!.shapes![index].points, moved: false };
}

function onMapMouseDown(e: L.LeafletMouseEvent): void {
  if ((mode !== "draw" && mode !== "shape-rect") || e.originalEvent.button !== 0 || !floor()) return;
  L.DomEvent.stop(e.originalEvent);
  map.dragging.disable();
  const start = snapLatLng(e.latlng);
  const preview = L.rectangle(L.latLngBounds(start, start), {
    color: "#f57c00", weight: 2, dashArray: "4 4", interactive: false,
  }).addTo(map);
  drag = { kind: "draw", target: mode === "draw" ? "room" : "shape", start, preview };
}

map.on("mousedown", onMapMouseDown);

map.on("mousemove", (e: L.LeafletMouseEvent) => {
  const [lat, lng] = snapLatLng(e.latlng);
  setCursor(lat, lng);
  if (polyDraft) {
    const last = polyDraft.points[polyDraft.points.length - 1];
    const p = constrain([lat, lng], last, e.originalEvent.shiftKey);
    polyDraft.line.setLatLngs([...polyDraft.points, p]);
    polyDraft.last.setLatLng(p);
  }
  if (!drag) return;
  if (drag.kind === "draw") {
    drag.preview.setBounds(L.latLngBounds(drag.start, [lat, lng]));
    return;
  }
  const dLat = snapValue(e.latlng.lat - drag.origin.lat);
  const dLng = snapValue(e.latlng.lng - drag.origin.lng);
  if (!drag.moved && (dLat || dLng)) {
    drag.moved = true;
    checkpoint();
  }
  if (!drag.moved) return;
  if (drag.kind === "move") rectLayers.get(drag.index)?.setBounds(toLeaflet(shiftRect(drag.rect, dLat, dLng)));
  else shapeLayers.get(drag.index)?.setLatLngs(shiftPoints(drag.points, dLat, dLng));
  handleLayer.clearLayers();
});

let lastDragEnd = 0;

function finishDrag(latlng?: L.LatLng): void {
  if (!drag) return;
  const current = drag;
  drag = null;
  lastDragEnd = performance.now();
  map.dragging.enable();
  const f = floor()!;
  if (current.kind === "draw") {
    current.preview.remove();
    if (!latlng) return;
    const [lat, lng] = snapLatLng(latlng);
    const [sLat, sLng] = current.start;
    if (Math.abs(lat - sLat) < 2 || Math.abs(lng - sLng) < 2) return;
    const rect: Rect = { n: Math.max(lat, sLat), s: Math.min(lat, sLat), w: Math.min(lng, sLng), e: Math.max(lng, sLng) };
    if (current.target === "shape") return addShape(rectPoints(rect));
    checkpoint();
    const r: RoomInfo = { name: "", bounds: [[0, 0], [0, 0]] };
    setRect(r, rect);
    f.rooms.push(r);
    selected = f.rooms.length - 1;
    selectedShape = null;
    commit();
    field("name").focus();
    return;
  }
  if (!current.moved) return;
  if (!latlng) return renderMap();
  const dLat = snapValue(latlng.lat - current.origin.lat);
  const dLng = snapValue(latlng.lng - current.origin.lng);
  if (current.kind === "move-shape") {
    f.shapes![current.index].points = shiftPoints(current.points, dLat, dLng);
    return commit();
  }
  const r = f.rooms[current.index];
  const next = shiftRect(current.rect, dLat, dLng);
  setRect(r, next);
  if (current.dot) {
    r.lineDot = [current.dot[0] + next.s - current.rect.s, current.dot[1] + next.w - current.rect.w];
  }
  commit();
}

map.on("mouseup", (e: L.LeafletMouseEvent) => finishDrag(e.latlng));
document.addEventListener("mouseup", () => finishDrag());

function onMapClick(e: L.LeafletMouseEvent): void {
  // 移動・描画の直後に届く click は無視する（離した位置の要素が作り直されて地図に届くことがある）
  if (performance.now() - lastDragEnd < 300) return;
  // 何もない場所のクリックで選択解除（地図のパン後は Leaflet が click を出さない）
  if (mode === "select") select(null);
  else if (mode === "dot") placeDot(e.latlng);
  else if (mode === "shape-poly") addPolyPoint(e);
}

map.on("click", onMapClick);
map.on("dblclick", () => { if (polyDraft) finishPoly(); });

function placeDot(latlng: L.LatLng): void {
  const r = room();
  if (!r) {
    setStatus("先に lineDot を設定する部屋を選択してください", "warn");
    return;
  }
  checkpoint();
  r.lineDot = snapLatLng(latlng);
  commit();
}

function addPolyPoint(e: L.LeafletMouseEvent): void {
  if (!floor()) return;
  if (!polyDraft) {
    polyDraft = {
      points: [],
      line: L.polyline([], { color: "#f57c00", weight: 2, dashArray: "4 4", interactive: false }).addTo(map),
      last: L.circleMarker([0, 0], { radius: 4, color: "#f57c00", interactive: false }).addTo(map),
    };
  }
  const pts = polyDraft.points;
  const p = constrain(snapLatLng(e.latlng), pts[pts.length - 1], e.originalEvent.shiftKey);
  // 始点付近のクリックで閉じる
  if (pts.length >= 3 && map.latLngToContainerPoint(pts[0]).distanceTo(e.containerPoint) < 10) {
    finishPoly();
    return;
  }
  const last = pts[pts.length - 1];
  if (last && last[0] === p[0] && last[1] === p[1]) return;
  pts.push(p);
  polyDraft.line.setLatLngs(pts);
  setStatus(pts.length < 3 ? "クリックで頂点を追加" : "始点クリック・ダブルクリック・Enter で確定 / Backspace で1つ戻す", "warn");
}

function cancelPoly(): void {
  polyDraft?.line.remove();
  polyDraft?.last.remove();
  polyDraft = null;
}

function finishPoly(): void {
  const pts = polyDraft?.points ?? [];
  cancelPoly();
  if (pts.length < 3) {
    setStatus("多角形には3つ以上の頂点が必要です", "warn");
    return;
  }
  addShape(pts);
}

function addShape(points: LatLng[]): void {
  const f = floor();
  if (!f) return;
  checkpoint();
  if (!f.shapes) convertFloorToShapes(f);
  const kind = $<HTMLSelectElement>("shape-kind").value as ShapeKind;
  const s: Shape = { kind, points };
  if (kind === "deco") s.color = DECO_COLORS[0];
  f.shapes!.push(s);
  selectedShape = f.shapes!.length - 1;
  selected = null;
  commit();
}

function setCursor(lat: number, lng: number): void {
  $("cursor").textContent = `lat ${lat} / lng ${lng}`;
}



// ---------------------------------------------------------------- panels

function renderAll(): void {
  renderFloors();
  renderRooms();
  renderForm();
  renderShapeForm();
  renderMap();
  renderIssues();
  renderMode();
  changed();
}

/** 編集後に呼ぶ。 */
function commit(): void {
  renderAll();
}

function select(index: number | null): void {
  selected = index;
  selectedShape = null;
  renderRooms();
  renderForm();
  renderShapeForm();
  renderSelection();
}

function selectShape(index: number | null): void {
  selectedShape = index;
  selected = null;
  renderRooms();
  renderForm();
  renderShapeForm();
  renderSelection();
}

function renderFloors(): void {
  const list = $("floor-list");
  list.replaceChildren(...info.floors.map((f, i) => {
    const li = document.createElement("li");
    li.textContent = `${f.floorName || "(名前なし)"}`;
    const count = document.createElement("small");
    count.textContent = `${f.rooms.length}室`;
    li.append(count);
    li.classList.toggle("active", i === floorIndex);
    li.addEventListener("click", () => {
      floorIndex = i;
      selected = selectedShape = null;
      cancelPoly();
      renderAll();
    });
    return li;
  }));

  const f = floor();
  const nameInput = $<HTMLInputElement>("floor-name");
  const fileSelect = $<HTMLSelectElement>("floor-file");
  nameInput.disabled = fileSelect.disabled = !f;
  nameInput.value = f?.floorName ?? "";
  const files = new Set(svgFiles);
  if (f?.floorFile) files.add(f.floorFile);
  fileSelect.replaceChildren(...[...files].sort().map((file) => new Option(file, file)));
  fileSelect.value = f?.floorFile ?? "";
  $("floor-shape-status").textContent = !f ? "" : f.shapes
    ? `エディタで作成した形状です。保存時に ${f.floorFile} を生成します。`
    : "外部のSVGを表示しています。";
  $("floor-shapes-new").hidden = !f || !!f.shapes;
  $("floor-merge").hidden = !f?.shapes?.some((s) => s.kind === "walk");
}

function renderRooms(): void {
  const f = floor();
  const filter = $<HTMLInputElement>("room-filter").value.trim().toLowerCase();
  $("room-count").textContent = f ? `(${f.rooms.length})` : "";
  const items = (f?.rooms ?? []).map((r, i) => ({ r, i }))
    .filter(({ r }) => !filter || [r.name, ...(r.searchTerms ?? []), r.StairID ?? ""]
      .some((v) => v.toLowerCase().includes(filter)));
  $("room-list").replaceChildren(...items.map(({ r, i }) => {
    const li = document.createElement("li");
    li.textContent = r.name || "(名前なし)";
    if (r.StairID) {
      const tag = document.createElement("small");
      tag.textContent = r.StairID;
      li.append(tag);
    }
    li.classList.toggle("active", i === selected);
    li.classList.toggle("unnamed", !r.name);
    li.addEventListener("click", () => {
      select(i);
      map.panTo(toLeaflet(rectOf(r)).getCenter());
    });
    return li;
  }));
}

function renderForm(): void {
  const r = room();
  form.hidden = !r;
  $("room-empty").hidden = !!r || !!shape();
  if (!r) return;
  const rect = rectOf(r);
  const values: Record<string, string> = {
    name: r.name,
    searchTerms: (r.searchTerms ?? r.aliases ?? []).join(", "),
    StairID: r.StairID ?? "",
    eventIds: (r.eventIds ?? []).join(", "),
    n: String(rect.n), s: String(rect.s), w: String(rect.w), e: String(rect.e),
    dotLat: r.lineDot ? String(r.lineDot[0]) : "",
    dotLng: r.lineDot ? String(r.lineDot[1]) : "",
  };
  for (const [name, value] of Object.entries(values)) {
    const input = field(name);
    if (document.activeElement !== input) input.value = value;
  }
  const ids = new Set(info.floors.flatMap((f) => f.rooms.map((x) => x.StairID).filter(Boolean)));
  $("stair-ids").replaceChildren(...[...ids].map((id) => new Option(id)));
  const links = stairLinks(r);
  $("stair-links").textContent = links.length
    ? `リンク先: ${links.map((l) => `${l.floor.floorName}「${l.room.name}」`).join("、")}`
    : isStair(r) ? "ほかの階の階段とリンクされていません" : "";
  $("stair-autolink").textContent = isStair(r) ? "近くの階段とリンク" : "階段にして近くの階段とリンク";
}

function renderShapeForm(): void {
  const s = shape();
  shapeForm.hidden = !s;
  $("room-empty").hidden = !!s || !!room();
  if (!s) return;
  (shapeForm.elements.namedItem("kind") as HTMLSelectElement).value = s.kind;
  $("shape-kind-hint").textContent = SHAPE_KINDS[s.kind].hint;
  const b = boundsOfPoints(s.points);
  $("shape-info").textContent = `頂点 ${s.points.length} / 範囲 lat ${b.s}–${b.n}, lng ${b.w}–${b.e}`;
  const colors = $("shape-colors");
  colors.hidden = s.kind !== "deco";
  colors.replaceChildren(...DECO_COLORS.map((c) => {
    const button = document.createElement("button");
    button.type = "button";
    button.style.background = c;
    button.title = c;
    button.classList.toggle("active", c === (s.color ?? DECO_COLORS[0]));
    button.addEventListener("click", () => {
      checkpoint();
      s.color = c;
      commit();
    });
    return button;
  }));
}

const splitList = (v: string) => v.split(/[,、]/).map((s) => s.trim()).filter(Boolean);

// フォーム入力は input ごとに反映し、フォーカス中の編集はまとめて1回の undo にする
let formCheckpointed = false;
form.addEventListener("focusin", () => { formCheckpointed = false; });
form.addEventListener("input", (e) => {
  const r = room();
  const input = e.target as HTMLInputElement;
  if (!r || !input.name) return;
  if (!formCheckpointed) {
    checkpoint();
    formCheckpointed = true;
  }
  const v = input.value;
  switch (input.name) {
    case "name": r.name = v; break;
    case "searchTerms": {
      const list = splitList(v);
      delete r.aliases;
      if (list.length) r.searchTerms = list; else delete r.searchTerms;
      break;
    }
    case "StairID": if (v.trim()) r.StairID = v.trim(); else delete r.StairID; break;
    case "eventIds": {
      const list = splitList(v);
      if (list.length) r.eventIds = list; else delete r.eventIds;
      break;
    }
    case "n": case "s": case "w": case "e": {
      if (v === "" || !Number.isFinite(Number(v))) return;
      setRect(r, { ...rectOf(r), [input.name]: Number(v) });
      break;
    }
    case "dotLat": case "dotLng": {
      const lat = Number(field("dotLat").value), lng = Number(field("dotLng").value);
      if (field("dotLat").value === "" || field("dotLng").value === "") return;
      if (Number.isFinite(lat) && Number.isFinite(lng)) r.lineDot = [lat, lng];
      break;
    }
  }
  renderRooms();
  renderMap();
  renderIssues();
  changed();
});
form.addEventListener("submit", (e) => e.preventDefault());
shapeForm.addEventListener("submit", (e) => e.preventDefault());

shapeForm.addEventListener("change", (e) => {
  const s = shape();
  const input = e.target as HTMLSelectElement;
  if (!s || input.name !== "kind") return;
  checkpoint();
  s.kind = input.value as ShapeKind;
  if (s.kind === "deco") s.color ??= DECO_COLORS[0];
  else delete s.color;
  commit();
});

$("dot-pick").addEventListener("click", () => setMode("dot"));
$("dot-clear").addEventListener("click", () => {
  const r = room();
  if (!r?.lineDot) return;
  checkpoint();
  delete r.lineDot;
  commit();
});
$("room-delete").addEventListener("click", deleteSelection);
$("room-duplicate").addEventListener("click", duplicateSelection);
$("shape-delete").addEventListener("click", deleteSelection);
$("shape-duplicate").addEventListener("click", duplicateSelection);
$("room-filter").addEventListener("input", renderRooms);

for (const [id, toFront] of [["shape-front", true], ["shape-back", false]] as const) {
  $(id).addEventListener("click", () => {
    const shapes = floor()?.shapes;
    if (!shapes || selectedShape === null) return;
    checkpoint();
    const [s] = shapes.splice(selectedShape, 1);
    if (toFront) shapes.push(s); else shapes.unshift(s);
    selectedShape = toFront ? shapes.length - 1 : 0;
    commit();
  });
}

function deleteSelection(): void {
  const f = floor();
  if (!f) return;
  if (selected !== null) {
    checkpoint();
    f.rooms.splice(selected, 1);
    selected = null;
  } else if (selectedShape !== null && f.shapes) {
    checkpoint();
    f.shapes.splice(selectedShape, 1);
    selectedShape = null;
  } else {
    return;
  }
  commit();
}

function duplicateSelection(): void {
  const f = floor();
  if (!f) return;
  const offset = 10;
  const r = room();
  const s = shape();
  if (r) {
    checkpoint();
    const copy: RoomInfo = structuredClone(r);
    copy.name = r.name ? `${r.name} のコピー` : "";
    setRect(copy, shiftRect(rectOf(r), -offset, offset));
    if (copy.lineDot) copy.lineDot = [copy.lineDot[0] - offset, copy.lineDot[1] + offset];
    f.rooms.push(copy);
    selected = f.rooms.length - 1;
  } else if (s && f.shapes) {
    checkpoint();
    f.shapes.push({ ...structuredClone(s), points: shiftPoints(s.points, -offset, offset) });
    selectedShape = f.shapes.length - 1;
  } else {
    return;
  }
  commit();
}

function moveSelection(dLat: number, dLng: number): void {
  const r = room();
  const s = shape();
  if (!r && !s) return;
  checkpoint();
  if (r) {
    const before = rectOf(r);
    const next = shiftRect(before, dLat, dLng);
    setRect(r, next);
    if (r.lineDot) r.lineDot = [r.lineDot[0] + next.s - before.s, r.lineDot[1] + next.w - before.w];
  } else if (s) {
    s.points = shiftPoints(s.points, dLat, dLng);
  }
  commit();
}

// ---- 階層

/** 既存のファイル・他の階と重ならない SVG ファイル名 */
function unusedSvgName(): string {
  const used = new Set([...svgFiles, ...info.floors.map((f) => f.floorFile)]);
  for (let n = 1; ; n++) {
    const name = `map/floor${n}.svg`;
    if (!used.has(name)) return name;
  }
}

/**
 * フロアをエディタ管理（形状から SVG を生成）に切り替える。
 * 外部 SVG は上書きせず新しいファイル名にし、元の画像は下絵として残す。
 */
function convertFloorToShapes(f: EditorFloor): void {
  const external = svgFiles.includes(f.floorFile) || !f.floorFile.startsWith("map/");
  if (external) {
    const name = unusedSvgName();
    traceImages.set(name, { url: floorImageUrl(f.floorFile), bounds: mapBounds });
    f.floorFile = name;
  }
  f.shapes = [];
}

$("floor-merge").addEventListener("click", () => {
  const f = floor();
  if (!f?.shapes) return;
  const before = f.shapes.filter((s) => s.kind === "walk").length;
  checkpoint();
  f.shapes = mergeWalkShapes(f.shapes);
  selectedShape = null;
  commit();
  const after = f.shapes.filter((s) => s.kind === "walk").length;
  setStatus(`歩行エリアを ${before} 個 → ${after} 個に結合しました`);
});

$("floor-shapes-new").addEventListener("click", () => {
  const f = floor();
  if (!f || f.shapes) return;
  checkpoint();
  convertFloorToShapes(f);
  setMode("shape-rect");
  $<HTMLSelectElement>("shape-kind").value = "walk";
  commit();
  setStatus("元のSVGを下絵として表示しています。四角形・多角形で歩行エリアを描いてください", "warn");
});

$("floor-add").addEventListener("click", () => {
  checkpoint();
  const n = info.floors.length + 1;
  info.floors.push({ floorFile: unusedSvgName(), floorName: `${n}階`, rooms: [], shapes: [] });
  floorIndex = info.floors.length - 1;
  selected = selectedShape = null;
  setMode("shape-rect");
  $<HTMLSelectElement>("shape-kind").value = "walk";
  commit();
  $<HTMLInputElement>("floor-name").select();
});
$("floor-delete").addEventListener("click", () => {
  const f = floor();
  if (!f) return;
  if (!confirm(`「${f.floorName}」と含まれる ${f.rooms.length} 室を削除しますか？`)) return;
  checkpoint();
  info.floors.splice(floorIndex, 1);
  floorIndex = Math.max(0, floorIndex - 1);
  selected = selectedShape = null;
  commit();
});
for (const [id, delta] of [["floor-up", -1], ["floor-down", 1]] as const) {
  $(id).addEventListener("click", () => {
    const to = floorIndex + delta;
    if (!floor() || to < 0 || to >= info.floors.length) return;
    checkpoint();
    const [f] = info.floors.splice(floorIndex, 1);
    info.floors.splice(to, 0, f);
    floorIndex = to;
    commit();
  });
}
let floorNameCheckpointed = false;
$("floor-name").addEventListener("focus", () => { floorNameCheckpointed = false; });
$("floor-name").addEventListener("input", (e) => {
  const f = floor();
  if (!f) return;
  if (!floorNameCheckpointed) {
    checkpoint();
    floorNameCheckpointed = true;
  }
  f.floorName = (e.target as HTMLInputElement).value;
  renderFloors();
  renderIssues();
  changed();
});
$("floor-file").addEventListener("change", async (e) => {
  const f = floor();
  if (!f) return;
  checkpoint();
  f.floorFile = (e.target as HTMLSelectElement).value;
  await loadShapes(f);
  selectedShape = null;
  commit();
});
$("svg-upload").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const res = await fetch(`${API}/svg?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: await file.text(),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    await loadSvgList();
    const f = floor();
    if (f) {
      checkpoint();
      f.floorFile = body.floorFile;
      await loadShapes(f);
      // 同名ファイルの上書き時も再読込させる
      overlay?.remove();
      overlay = null;
    }
    commit();
    setStatus(`${body.floorFile} をアップロードしました`);
  } catch (error) {
    setStatus(`アップロード失敗: ${error}`, "error");
  }
});

// ---- 下絵

/** 画像の縦横比を保ったまま、取り込み時と同じ位置に下絵を置く */
async function setTrace(f: EditorFloor, file: Blob): Promise<void> {
  const bitmap = await createImageBitmap(file);
  const { bounds } = imageToMap(bitmap.width, bitmap.height);
  bitmap.close();
  traceImages.set(f.floorFile, { url: URL.createObjectURL(file), bounds });
}

$("trace-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const f = floor();
  if (!file || !f) return;
  await setTrace(f, file);
  renderMap();
});

// ---- 画像から取り込む

const openImport = setupImportDialog(async (request) => {
  if (!floor()) return;
  checkpoint();
  // ページ k は今の階から k 階上に取り込む。足りない階は追加する
  const first = floorIndex;
  const targets: number[] = [];
  for (const [k, page] of request.pages.entries()) {
    const fi = first + k;
    if (!info.floors[fi]) {
      info.floors.push({ floorFile: unusedSvgName(), floorName: `${info.floors.length + 1}階`, rooms: [], shapes: [] });
    }
    const f = info.floors[fi];
    if (!f.shapes) convertFloorToShapes(f);
    if (request.replace) {
      f.shapes = [];
      f.rooms = [];
    }
    f.shapes!.push(...page.shapes);
    f.rooms.push(...page.rooms);
    await setTrace(f, page.image);
    targets.push(fi);
  }
  const rooms = request.pages.flatMap((p) => p.rooms);
  const stairs = rooms.filter(isStair).length;
  const linked = stairs ? autoLinkStairs(targets) : 0;
  floorIndex = first;
  selected = selectedShape = null;
  setMode("select");
  commit();
  fitMap();
  const where = targets.length > 1 ? `${targets.length} 階分に` : "";
  setStatus(`${where}部屋 ${rooms.length - stairs} 室・階段 ${stairs} か所（うち ${linked} か所を上下の階とリンク）を取り込みました。部屋名を設定してください`, "warn");
});
$("floor-import").addEventListener("click", () => {
  if (!floor()) $("floor-add").click();
  openImport();
});
$("trace-opacity").addEventListener("input", renderMap);
$("trace-clear").addEventListener("click", () => {
  const f = floor();
  if (f) traceImages.delete(f.floorFile);
  renderMap();
});

// ---- 階段のリンク

/** 上下の階の階段をリンクするときの、中心どうしの最大距離（地図座標） */
const STAIR_LINK_DISTANCE = 40;

const centerOf = (r: RoomInfo): LatLng => {
  const b = rectOf(r);
  return [(b.n + b.s) / 2, (b.w + b.e) / 2];
};

/** 同じ StairID を持つ、ほかの階の階段 */
function stairLinks(r: RoomInfo): { floor: EditorFloor; room: RoomInfo }[] {
  if (!r.StairID) return [];
  return info.floors.flatMap((f) => (f.rooms.includes(r) ? [] : f.rooms
    .filter((x) => x.StairID === r.StairID)
    .map((room) => ({ floor: f, room }))));
}

/** A, B, …, Z, AA, AB … の順で未使用の StairID */
function nextStairId(): string {
  const used = new Set(info.floors.flatMap((f) => f.rooms.map((r) => r.StairID)));
  for (let i = 0; ; i++) {
    let id = "";
    for (let k = i + 1; k > 0; k = Math.floor((k - 1) / 26)) id = String.fromCharCode(65 + ((k - 1) % 26)) + id;
    if (!used.has(id)) return id;
  }
}

/** 仮の名前（「階段」や「階段<旧ID>」）なら StairID に合わせた名前にする */
function setStairId(r: RoomInfo, id: string): void {
  if (r.name === "階段" || (r.StairID && r.name === `階段${r.StairID}`)) r.name = `階段${id}`;
  r.StairID = id;
}

/**
 * 階段を、上下の階の近い位置にある階段とリンクする（同じ StairID にする）。
 * 相手がいなければ StairID だけ付ける。リンクできたら true。
 */
function linkStair(fi: number, stair: RoomInfo): boolean {
  if (stairLinks(stair).length) return true;
  const here = centerOf(stair);
  const best = [fi - 1, fi + 1]
    .flatMap((j) => (info.floors[j]?.rooms ?? []).filter(isStair).map((room) => ({
      room,
      d: Math.hypot(centerOf(room)[0] - here[0], centerOf(room)[1] - here[1]),
    })))
    // この階の別の階段がすでに使っている ID の相手は除く
    .filter((c) => c.d <= STAIR_LINK_DISTANCE &&
      !info.floors[fi].rooms.some((x) => x !== stair && x.StairID && x.StairID === c.room.StairID))
    .sort((a, b) => a.d - b.d)[0];
  if (best?.room.StairID) {
    setStairId(stair, best.room.StairID);
    return true;
  }
  const id = stair.StairID ?? nextStairId();
  setStairId(stair, id);
  if (!best) return false;
  setStairId(best.room, id);
  return true;
}

/** 指定した階（省略時は全階）の、まだつながっていない階段を自動リンクする。リンクした数を返す */
function autoLinkStairs(floorIndexes = info.floors.map((_, i) => i)): number {
  let linked = 0;
  for (const fi of floorIndexes) {
    for (const stair of info.floors[fi]?.rooms.filter(isStair) ?? []) {
      if (!stairLinks(stair).length && linkStair(fi, stair)) linked++;
    }
  }
  return linked;
}

$("floor-stairs-link").addEventListener("click", () => {
  checkpoint();
  const linked = autoLinkStairs();
  commit();
  setStatus(linked ? `${linked} か所の階段をリンクしました` : "リンクできる階段が見つかりませんでした（上下の階の近い位置に階段が必要です）", linked ? "ok" : "warn");
});
$("stair-autolink").addEventListener("click", () => {
  const r = room();
  if (!r) return;
  checkpoint();
  if (!isStair(r)) r.name = r.name ? `${r.name}（階段）` : "階段";
  const linked = linkStair(floorIndex, r);
  commit();
  setStatus(linked ? "近くの階段とリンクしました" : "上下の階の近い位置に階段が見つかりませんでした", linked ? "ok" : "warn");
});

// ---- チェック

interface Issue { floor: number; room?: number; shape?: number; text: string; }

function collectIssues(): Issue[] {
  const issues: Issue[] = [];
  const stairFloors = new Map<string, Set<number>>();
  info.floors.forEach((f, fi) => {
    if (!f.floorName) issues.push({ floor: fi, text: "階層名が空です" });
    if (info.floors.findIndex((x) => x.floorName === f.floorName) !== fi) {
      issues.push({ floor: fi, text: `階層名「${f.floorName}」が重複しています` });
    }
    const shapes = f.shapes;
    if (shapes && !shapes.some((s) => s.kind === "walk")) {
      issues.push({ floor: fi, text: "歩行エリアがありません（経路探索できません）" });
    }
    const groups = shapes ? walkGroups(shapes) : [];
    if (groups.length > 1) {
      // 一番小さいグループを指して、つなげる場所の目安にする
      const smallest = groups.sort((a, b) => a.length - b.length)[0];
      issues.push({ floor: fi, shape: smallest[0], text: `歩行エリアが ${groups.length} つに分かれています（離れた場所へは経路が引けません）` });
    }
    shapes?.forEach((s, si) => {
      if (s.kind === "block" && !shapes.some((w) => w.kind === "walk" && s.points.every((p) => pointInPolygon(p, w.points) || isOnEdge(p, w.points)))) {
        issues.push({ floor: fi, shape: si, text: "障害物が歩行エリアからはみ出しています（はみ出た部分は歩行エリア扱いになります）" });
      }
    });
    const names = new Map<string, number>();
    f.rooms.forEach((r, ri) => {
      const label = r.name || "(名前なし)";
      if (!r.name) issues.push({ floor: fi, room: ri, text: "名前が空です" });
      else if (names.has(r.name)) issues.push({ floor: fi, room: ri, text: `「${r.name}」が同じ階に重複しています` });
      names.set(r.name, ri);
      const rect = rectOf(r);
      if (rect.n - rect.s < 1 || rect.e - rect.w < 1) issues.push({ floor: fi, room: ri, text: `${label}: 範囲が小さすぎます` });
      if (!r.lineDot) issues.push({ floor: fi, room: ri, text: `${label}: lineDot が未設定です` });
      else if (r.lineDot[0] > rect.s && r.lineDot[0] < rect.n && r.lineDot[1] > rect.w && r.lineDot[1] < rect.e) {
        issues.push({ floor: fi, room: ri, text: `${label}: lineDot が部屋の内側にあります（廊下側に置いてください）` });
      } else if (shapes && !isWalkable(r.lineDot, shapes)) {
        issues.push({ floor: fi, room: ri, text: `${label}: lineDot が歩行エリアの外です` });
      }
      if (isStair(r) && !r.StairID) issues.push({ floor: fi, room: ri, text: `${label}: StairID がありません（ほかの階とつながりません）` });
      if (r.StairID) {
        if (!stairFloors.has(r.StairID)) stairFloors.set(r.StairID, new Set());
        stairFloors.get(r.StairID)!.add(fi);
      }
    });
  });
  for (const [id, floors] of stairFloors) {
    if (floors.size < 2) {
      const fi = [...floors][0];
      const ri = info.floors[fi].rooms.findIndex((r) => r.StairID === id);
      issues.push({ floor: fi, room: ri, text: `階段「${id}」がほかの階の階段とリンクされていません` });
    }
  }
  return issues;
}

/** 点が多角形の辺上にあるか（障害物が歩行エリアの縁に接する場合を許容する） */
function isOnEdge([lat, lng]: LatLng, points: LatLng[]): boolean {
  return points.some((a, i) => {
    const b = points[(i + 1) % points.length];
    const cross = (b[1] - a[1]) * (lat - a[0]) - (b[0] - a[0]) * (lng - a[1]);
    return Math.abs(cross) < 1e-6 &&
      lat >= Math.min(a[0], b[0]) && lat <= Math.max(a[0], b[0]) &&
      lng >= Math.min(a[1], b[1]) && lng <= Math.max(a[1], b[1]);
  });
}

function renderIssues(): void {
  const issues = collectIssues();
  $("issue-count").textContent = issues.length ? `(${issues.length})` : "✓";
  $("issues").replaceChildren(...issues.map((issue) => {
    const li = document.createElement("li");
    li.textContent = `${info.floors[issue.floor]?.floorName ?? ""}: ${issue.text}`;
    li.addEventListener("click", () => {
      floorIndex = issue.floor;
      selected = issue.room ?? null;
      selectedShape = issue.shape ?? null;
      renderAll();
      const r = room();
      const s = shape();
      if (r) map.panTo(toLeaflet(rectOf(r)).getCenter());
      else if (s) map.panTo(centroid(s.points));
    });
    return li;
  }));
}

// ---------------------------------------------------------------- modes & keys

function setMode(next: Mode): void {
  if (next !== "shape-poly") cancelPoly();
  mode = next;
  renderMode();
}

function renderMode(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  $("map").dataset.mode = mode;
}

document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
  b.addEventListener("click", () => setMode(b.dataset.mode as Mode));
});
$("fit").addEventListener("click", fitMap);
$("undo").addEventListener("click", () => restore(undoStack, redoStack));
$("redo").addEventListener("click", () => restore(redoStack, undoStack));

document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void save();
    return;
  }
  const typing = (e.target as HTMLElement).closest("input, select, textarea");
  if (typing) {
    if (e.key === "Escape") (e.target as HTMLElement).blur();
    return;
  }
  const key = e.key.toLowerCase();
  if (polyDraft) {
    if (key === "enter") { finishPoly(); return; }
    if (key === "escape") { cancelPoly(); setStatus("多角形の作図を取り消しました"); return; }
    if (key === "backspace") {
      e.preventDefault();
      polyDraft.points.pop();
      polyDraft.line.setLatLngs(polyDraft.points);
      if (!polyDraft.points.length) cancelPoly();
      return;
    }
  }
  if (ctrl && key === "z") { e.preventDefault(); restore(e.shiftKey ? redoStack : undoStack, e.shiftKey ? undoStack : redoStack); return; }
  if (ctrl && key === "y") { e.preventDefault(); restore(redoStack, undoStack); return; }
  if (ctrl && key === "d") { e.preventDefault(); duplicateSelection(); return; }
  if (ctrl) return;
  if (key === "v") setMode("select");
  else if (key === "r") setMode("draw");
  else if (key === "d") setMode("dot");
  else if (key === "s") setMode("shape-rect");
  else if (key === "p") setMode("shape-poly");
  else if (key === "f") fitMap();
  else if (key === "escape") { select(null); setMode("select"); }
  else if (key === "delete" || key === "backspace") deleteSelection();
  else if (key.startsWith("arrow")) {
    if (!room() && !shape()) return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (Number($<HTMLSelectElement>("snap").value) || 1);
    const dLat = key === "arrowup" ? step : key === "arrowdown" ? -step : 0;
    const dLng = key === "arrowright" ? step : key === "arrowleft" ? -step : 0;
    moveSelection(dLat, dLng);
  }
});

// ---------------------------------------------------------------- output

const IDENT = /^[A-Za-z_$][\w$]*$/;
const ROOM_KEYS = ["name", "searchTerms", "aliases", "StairID", "eventIds", "lineDot", "bounds"];

/** mapinfo.js と同じ体裁（座標や文字列配列は1行）で整形する。 */
function formatValue(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    const inline = value.every((v) => typeof v !== "object" || (Array.isArray(v) && v.every((x) => typeof x !== "object")));
    if (inline) return `[${value.map((v) => formatValue(v, indent)).join(", ")}]`;
    const inner = indent + "  ";
    return `[\n${value.map((v) => `${inner}${formatValue(v, inner)},\n`).join("")}${indent}]`;
  }
  if (value && typeof value === "object") {
    const inner = indent + "  ";
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{\n${entries.map(([k, v]) => `${inner}${IDENT.test(k) ? k : JSON.stringify(k)}: ${formatValue(v, inner)},\n`).join("")}${indent}}`;
  }
  return JSON.stringify(value);
}

function normalizedInfo(): MapInfo {
  return {
    ...info,
    floors: info.floors.map((f) => ({
      floorFile: f.floorFile,
      floorName: f.floorName,
      rooms: f.rooms.map((r) => {
        const out: Record<string, unknown> = {};
        const copy = structuredClone(r);
        setRect(copy, rectOf(copy));
        for (const key of [...ROOM_KEYS, ...Object.keys(copy)]) {
          const v = (copy as unknown as Record<string, unknown>)[key];
          if (key in out || v === undefined || (Array.isArray(v) && !v.length)) continue;
          out[key] = v;
        }
        return out as unknown as RoomInfo;
      }),
    })),
  };
}

function toSource(): string {
  return `/// <reference path="../types/map.d.ts"/>

/** @type {MapInfo} */
const map = ${formatValue(normalizedInfo(), "")};

export default map;
`;
}

async function save(): Promise<void> {
  try {
    // 形状を編集したフロアの SVG を先に書き出す
    const written: string[] = [];
    for (const f of info.floors) {
      if (!f.shapes) continue;
      const svg = shapesToSvg(f.shapes, f.rooms);
      if (savedSvgs.get(f.floorFile) === svg) continue;
      const res = await fetch(`${API}/svg?name=${encodeURIComponent(f.floorFile.replace(/^map\//, ""))}`, {
        method: "POST",
        body: svg,
      });
      if (!res.ok) throw new Error((await res.json()).error);
      savedSvgs.set(f.floorFile, svg);
      written.push(f.floorFile);
    }
    if (written.length) await loadSvgList();
    const res = await fetch(`${API}/mapinfo`, { method: "POST", body: toSource() });
    if (!res.ok) throw new Error((await res.json()).error);
    savedJson = JSON.stringify(info);
    renderFloors();
    changed();
    setStatus(`env/mapinfo.js${written.length ? ` と ${written.join(", ")}` : ""} を保存しました`);
  } catch (error) {
    setStatus(`保存失敗: ${error}（開発サーバーで開いていますか？）`, "error");
  }
}

$("save").addEventListener("click", () => void save());
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(toSource());
  setStatus("mapinfo.js の内容をコピーしました");
});
$("download").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toSource()], { type: "text/javascript" }));
  a.download = "mapinfo.js";
  a.click();
  URL.revokeObjectURL(a.href);
});

/** mapinfo.js のソースをモジュールとして評価して MapInfo を取り出す。 */
async function evaluateMapInfo(source: string): Promise<EditorInfo> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    if (!Array.isArray(mod.default?.floors)) throw new Error("floors がありません");
    return mod.default;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** フロアの SVG がエディタ生成なら形状を読み込む */
async function loadShapes(f: EditorFloor): Promise<void> {
  delete f.shapes;
  if (!f.floorFile.startsWith("map/")) return;
  try {
    const res = await fetch(floorImageUrl(f.floorFile));
    if (!res.ok) return;
    const text = await res.text();
    const shapes = parseEditorSvg(text);
    if (!shapes) return;
    f.shapes = shapes;
    // 生成方法が変わった（外形の追加など）場合も次の保存で書き直されるよう、実際の内容を覚えておく
    savedSvgs.set(f.floorFile, text);
  } catch { /* 読めない場合は外部 SVG として扱う */ }
}

$("import").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const loaded = await evaluateMapInfo(await file.text());
    await Promise.all(loaded.floors.map(loadShapes));
    checkpoint();
    info = loaded;
    floorIndex = 0;
    selected = selectedShape = null;
    renderAll();
    setStatus(`${file.name} を読み込みました（未保存）`, "warn");
  } catch (error) {
    setStatus(`読み込み失敗: ${error}`, "error");
  }
});

window.addEventListener("beforeunload", (e) => {
  if (JSON.stringify(info) !== savedJson) e.preventDefault();
});

// ---------------------------------------------------------------- boot

async function loadSvgList(): Promise<void> {
  try {
    const res = await fetch(`${API}/svgs`);
    if (res.ok) svgFiles = await res.json();
  } catch { /* 一覧が取れなくても編集は可能 */ }
}

async function boot(): Promise<void> {
  await loadSvgList();
  try {
    const res = await fetch(`${API}/mapinfo`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await evaluateMapInfo(await res.text());
    await Promise.all(info.floors.map(loadShapes));
  } catch (error) {
    setStatus(`mapinfo.js を読み込めません: ${error}`, "error");
  }
  savedJson = JSON.stringify(info);
  let draft: string | null = null;
  try { draft = localStorage.getItem(DRAFT_KEY); } catch { /* ignore */ }
  if (draft && draft !== savedJson && confirm("保存されていない下書きがあります。復元しますか？")) {
    info = JSON.parse(draft);
  }
  renderAll();
}

void boot();
