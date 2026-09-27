import L from "leaflet";
import mapInfo from "../../env/mapinfo.js";
import { debug } from "../debug";
import { mapState, refreshRoomHighlights, requireMap } from "./state";
import { refreshCurrentFloorDisplay, showFloor } from "./update";
import { SVG_HEIGHT } from "./constants";
import { parseSvgPathRings, type Point } from "./navmesh";

declare global {
  var ROUTE_GRID_CELL_SIZE: number | string | undefined;
  var ROUTE_GRID_TRACE_ROOM: string | undefined;
  interface Window {
    validateRoomRoutes: typeof validateAllRoomPairs;
  }
}

type SearchMode = "current" | "destination";
interface Selection {
  room: RoomInfo;
  floor: FloorInfo;
}
interface CurrentLocation {
  name: string;
  floorName: string;
  point: L.LatLngTuple | L.LatLng;
}
interface GridCell {
  x: number;
  y: number;
}
interface BoundaryCell extends GridCell {
  distance: number;
  component: number | null;
  mainComponent: boolean;
}
interface FloorGrid {
  floor: FloorInfo;
  outer: Point[];
  holes: Point[][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  walkable: (x: number, y: number) => boolean;
  /** 格子点 (gx, gy) が歩けるか（範囲外は false） */
  cellAt: (gx: number, gy: number) => boolean;
  components: number;
  componentSizes: number[];
  componentAt: (x: number, y: number) => number | null;
}
interface GridConnection {
  node: GridCell;
  path: L.LatLng[];
}
/** [ラベル, 座標, 塗り色] */
type RouteMarker = [string, L.LatLngExpression, string];
interface RouteDefinition {
  floor: FloorInfo;
  start: L.LatLng;
  goal: L.LatLng;
  startRoom: RoomInfo | null;
  goalRoom: RoomInfo | null;
  startMarker: RouteMarker;
  endMarker: RouteMarker;
}
interface RouteSegment {
  layers: () => L.Layer[];
}

// Set window.ROUTE_GRID_CELL_SIZE before initialization to inspect coarser grids.
const GRID_CELL_SIZE = Number(globalThis.ROUTE_GRID_CELL_SIZE ?? 2);
const defaultCurrentRoom = mapInfo.floors
  .flatMap((floor) => floor.rooms.map((room) => ({ floor, room })))
  .find(({ room }) => room.name === "昇降口");
const currentLocation: CurrentLocation = {
  name: "昇降口",
  floorName: defaultCurrentRoom?.floor.floorName ?? "1階",
  point: defaultCurrentRoom?.room.lineDot ?? [212, 284],
};
let destinationLocation: Selection | null = null;

/** 画面に出す移動の手順（階をまたぐ経路を分かりやすくする） */
interface RouteStep {
  floorName: string;
  icon: string;
  text: string;
  /** 手順を選んだときに表示する範囲 */
  focus: L.LatLng[];
}
let routeSteps: RouteStep[] = [];
let activeStep = 0;
const STAIR_COLOR = "#8e44ad";
let searchMode: SearchMode = "destination";
let routeLayer: L.LayerGroup | null = null;
const routeSegments = new Map<string, RouteSegment>();
let routeRequestId = 0;
const floorGridCache = new Map<string, FloorGrid>();

const pointInRing = (p: Point, ring: Point[]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const windingNumber = (p: Point, ring: Point[]): number => {
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) -
        (p.x - a.x) * (b.y - a.y) > 0) winding++;
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) -
      (p.x - a.x) * (b.y - a.y) < 0) {
      winding--;
    }
  }
  return winding;
};
const area = (ring: Point[]): number => Math.abs(ring.reduce((sum, p, i) => {
  const n = ring[(i + 1) % ring.length];
  return sum + p.x * n.y - n.x * p.y;
}, 0) / 2);
const centerOf = (room: RoomInfo): L.LatLng => {
  const [[a, b], [c, d]] = room.bounds;
  return L.latLng((a + c) / 2, (b + d) / 2);
};
const roomContains = (room: RoomInfo, p: L.LatLng): boolean => {
  const [[a, b], [c, d]] = room.bounds;
  return p.lat > Math.min(a, c) && p.lat < Math.max(a, c) &&
    p.lng > Math.min(b, d) && p.lng < Math.max(b, d);
};
const roomContainsWithTolerance = (room: RoomInfo, p: L.LatLng, tolerance = GRID_CELL_SIZE * 6): boolean => {
  const [[a, b], [c, d]] = room.bounds;
  return p.lat > Math.min(a, c) - tolerance && p.lat < Math.max(a, c) + tolerance &&
    p.lng > Math.min(b, d) - tolerance && p.lng < Math.max(b, d) + tolerance;
};
const roomBoundaryDistance = (room: RoomInfo, point: L.LatLng): number => {
  const [[a, b], [c, d]] = room.bounds;
  const north = Math.min(a, c), south = Math.max(a, c);
  const west = Math.min(b, d), east = Math.max(b, d);
  const dx = Math.max(west - point.lng, 0, point.lng - east);
  const dy = Math.max(north - point.lat, 0, point.lat - south);
  return Math.hypot(dx, dy);
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("ja-JP").replace(/[　\s]+/g, "")
    .replace(/コンピューター/g, "コンピュータ")
    .replace(/(\d+)[年ｰー−-]?(\d+)[組クラス]*$/u, "$1-$2");
}
function getRoomMatches(query: string): Selection[] {
  const q = normalize(query);
  if (!q) return [];
  return mapInfo.floors.flatMap((floor) => floor.rooms
    .filter((room) => [room.name, ...(room.searchTerms ?? room.aliases ?? [])]
      .some((value) => {
        const n = normalize(value);
        return n.includes(q) || (q.includes("-") && n.includes(q.replace("-", "")));
      }))
    .map((room) => ({ room, floor })));
}

function updateNavigationBanner(): void {
  document.getElementById("current-location")?.replaceChildren(
    `${currentLocation.name}（${currentLocation.floorName}）`);
  document.getElementById("destination-location")?.replaceChildren(
    destinationLocation ? `${destinationLocation.room.name}（${destinationLocation.floor.floorName}）` : "目的地を選択");
}
function renderRouteForFloor(name: string): void {
  routeLayer?.remove();
  const segment = routeSegments.get(name);
  routeLayer = segment ? L.layerGroup(segment.layers()).addTo(requireMap()) : null;
}
function handleRouteFloorChange(event: L.LayersControlEvent): void {
  renderRouteForFloor(event.name);
  // 階を手動で切り替えたら、その階の最初の手順を選択中にする
  const index = routeSteps.findIndex((step) => step.floorName === event.name);
  if (index >= 0) activeStep = index;
  renderRouteSteps();
}

/** 手順の一覧（階をまたぐときだけ表示） */
function renderRouteSteps(): void {
  const list = document.getElementById("route-steps");
  if (!list) return;
  list.hidden = routeSteps.length < 2;
  list.replaceChildren(...routeSteps.map((step, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-step";
    button.classList.toggle("active", index === activeStep);
    button.classList.toggle("done", index < activeStep);
    const number = document.createElement("span");
    number.className = "route-step-number";
    number.textContent = String(index + 1);
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined";
    icon.textContent = step.icon;
    const text = document.createElement("span");
    text.className = "route-step-text";
    const floor = document.createElement("small");
    floor.textContent = step.floorName;
    text.append(floor, step.text);
    button.append(number, icon, text);
    button.addEventListener("click", () => goToStep(index));
    item.append(button);
    return item;
  }));
}

/** 手順の階を表示し、その手順の範囲に寄せる */
function goToStep(index: number): void {
  const step = routeSteps[index];
  if (!step) return;
  activeStep = index;
  if (mapState.nowBaseLayerName !== step.floorName) {
    showFloor(step.floorName);
    refreshCurrentFloorDisplay();
  }
  renderRouteForFloor(step.floorName);
  renderRouteSteps();
  if (step.focus.length) {
    // 左上の案内パネルに隠れないよう、パネルの分だけ余白をとる
    const map = requireMap();
    const panel = document.querySelector(".navigation-banner")?.getBoundingClientRect();
    const box = map.getContainer().getBoundingClientRect();
    const wide = panel && panel.right < box.width * 0.6;
    const padding: L.PointTuple = panel
      ? wide ? [panel.right - box.left + 16, 16] : [16, panel.bottom - box.top + 16]
      : [16, 16];
    map.fitBounds(L.latLngBounds(step.focus).pad(0.15), { maxZoom: 2, paddingTopLeft: padding, paddingBottomRight: [16, 16] });
  }
}

function parseStyles(document: Document): Map<string, Record<string, string>> {
  const styles = new Map<string, Record<string, string>>();
  for (const style of document.querySelectorAll("style")) {
    for (const m of (style.textContent ?? "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations: Record<string, string> = Object.fromEntries(m[2].split(";").map((x) => x.split(":").map((v) => v.trim().toLowerCase()))
        .filter(([a, b]) => a && b));
      for (const selector of m[1].split(",")) {
        const name = selector.trim().match(/^\.([\w-]+)$/)?.[1];
        if (name) styles.set(name, declarations);
      }
    }
  }
  return styles;
}
function color(value: string | undefined): [number, number, number] | null {
  const m = value?.trim().toLowerCase().match(/^#([\da-f]{6})$/i);
  return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4), 16)] : null;
}
function ringFromElement(element: Element, scaleX: number, scaleY: number): Point[][] {
  const raw = element.tagName.toLowerCase() === "path"
    ? parseSvgPathRings(element.getAttribute("d") ?? "")
    : [[...(element.getAttribute("points") ?? "").matchAll(/(-?(?:\d*\.)?\d+)[,\s]+(-?(?:\d*\.)?\d+)/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))];
  // SVG は上が y=0、地図座標 (lat) は下が 0 なので上下を反転する
  return raw.map((ring) => ring.map((p) => ({ x: p.x * scaleX, y: SVG_HEIGHT - p.y * scaleY })))
    .filter((ring) => ring.length > 2 && area(ring) > 10);
}

async function buildFloorGrid(floor: FloorInfo): Promise<FloorGrid> {
  const cached = floorGridCache.get(floor.floorName);
  if (cached) return cached;
  const response = await fetch(`/env/${floor.floorFile}`);
  if (!response.ok) throw new Error("歩行可能エリアを読み込めません");
  const document = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
  const vb = (document.documentElement.getAttribute("viewBox") ?? "0 0 595.28 841.89").split(/\s+/).map(Number);
  const sx = 700 / (vb[2] || 700), sy = 800 / (vb[3] || 800);
  const styles = parseStyles(document);
  const rings = [...document.querySelectorAll<SVGElement>("path,polygon")].flatMap((el) => {
    const attrs: Record<string, string | undefined> = {};
    for (const cls of el.getAttribute("class")?.split(/\s+/) ?? []) Object.assign(attrs, styles.get(cls));
    Object.assign(attrs, el.dataset, { fill: el.getAttribute("fill") ?? attrs.fill, stroke: el.getAttribute("stroke") ?? attrs.stroke });
    const c = color(attrs.fill);
    // 地図エディタが生成した SVG は data-walkable で示す。古い SVG は塗り色で判定する
    const walkable = attrs.walkable === "1" || (c && ((c[0] === 202 && c[1] === 255 && c[2] === 209) ||
      (c[0] === 0 && c[1] === 122 && c[2] === 232)));
    return walkable ? ringFromElement(el, sx, sy) : [];
  });
  const boundary = [...document.querySelectorAll("path,polygon")].flatMap((el) => {
    const stroke = el.getAttribute("stroke") ?? [...el.getAttribute("class")?.split(/\s+/) ?? []]
      .map((c) => styles.get(c)?.stroke).find(Boolean);
    return stroke?.toLowerCase() === "#13ae67" ? ringFromElement(el, sx, sy) : [];
  });
  const walkableRings = rings.length ? rings : boundary;
  const outer = walkableRings.sort((a, b) => area(b) - area(a))[0];
  if (!outer) throw new Error(`${floor.floorName} の歩行可能ポリゴンがありません`);
  const roomHoles = floor.rooms.map((room) => {
      const [[a, b], [c, d]] = room.bounds;
      return [{ x: Math.min(b, d), y: Math.min(a, c) }, { x: Math.max(b, d), y: Math.min(a, c) },
        { x: Math.max(b, d), y: Math.max(a, c) }, { x: Math.min(b, d), y: Math.max(a, c) }];
    });
  const holes = roomHoles;
  const minX = Math.floor(Math.min(...walkableRings.flat().map((p) => p.x)) / GRID_CELL_SIZE) - 1;
  const maxX = Math.ceil(Math.max(...walkableRings.flat().map((p) => p.x)) / GRID_CELL_SIZE) + 1;
  const minY = Math.floor(Math.min(...walkableRings.flat().map((p) => p.y)) / GRID_CELL_SIZE) - 1;
  const maxY = Math.ceil(Math.max(...walkableRings.flat().map((p) => p.y)) / GRID_CELL_SIZE) + 1;
  // 格子点ごとの歩行可否を一度だけ計算しておく。
  // 以前は判定のたびに全リングと全部屋を調べていたため、部屋が多いと非常に重かった。
  const cols = maxX - minX + 1, rows = maxY - minY + 1;
  const cells = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const point = { x: (gx + minX) * GRID_CELL_SIZE, y: (gy + minY) * GRID_CELL_SIZE };
      const inside = rings.length
        ? rings.reduce((sum, ring) => sum + windingNumber(point, ring), 0) !== 0
        : pointInRing(point, outer);
      if (inside) cells[gy * cols + gx] = 1;
    }
  }
  // 部屋（穴）は長方形なので、内側の格子点をまとめて消す
  for (const room of floor.rooms) {
    const [[a, b], [c, d]] = room.bounds;
    const north = Math.max(a, c), south = Math.min(a, c), west = Math.min(b, d), east = Math.max(b, d);
    const y0 = Math.max(minY, Math.floor(south / GRID_CELL_SIZE) + 1), y1 = Math.min(maxY, Math.ceil(north / GRID_CELL_SIZE) - 1);
    const x0 = Math.max(minX, Math.floor(west / GRID_CELL_SIZE) + 1), x1 = Math.min(maxX, Math.ceil(east / GRID_CELL_SIZE) - 1);
    for (let gy = y0; gy <= y1; gy++) cells.fill(0, (gy - minY) * cols + (x0 - minX), (gy - minY) * cols + (x1 - minX) + 1);
  }
  const cellAt = (gx: number, gy: number): boolean =>
    gx >= minX && gx <= maxX && gy >= minY && gy <= maxY && cells[(gy - minY) * cols + (gx - minX)] === 1;
  // 格子点以外の座標は、最も近い格子点で判定する
  const walkable = (x: number, y: number): boolean =>
    cellAt(Math.round(x / GRID_CELL_SIZE), Math.round(y / GRID_CELL_SIZE));

  const componentLabels = new Int32Array(cols * rows).fill(-1);
  const componentSizes: number[] = [];
  const grid: FloorGrid = {
    floor, outer, holes, minX, maxX, minY, maxY, walkable, cellAt,
    components: 0,
    componentSizes,
    componentAt: (x, y) => {
      if (x < minX || x > maxX || y < minY || y > maxY) return null;
      const label = componentLabels[(y - minY) * cols + (x - minX)];
      return label < 0 ? null : label;
    },
  };
  const queue = new Int32Array(cols * rows);
  for (let start = 0; start < cols * rows; start++) {
    if (!cells[start] || componentLabels[start] >= 0) continue;
    const component = grid.components++;
    let head = 0, tail = 0;
    queue[tail++] = start;
    componentLabels[start] = component;
    while (head < tail) {
      const i = queue[head++];
      const gx = i % cols, gy = (i - gx) / cols;
      for (const j of [gx > 0 ? i - 1 : -1, gx < cols - 1 ? i + 1 : -1, gy > 0 ? i - cols : -1, gy < rows - 1 ? i + cols : -1]) {
        if (j < 0 || !cells[j] || componentLabels[j] >= 0) continue;
        componentLabels[j] = component;
        queue[tail++] = j;
      }
    }
    componentSizes[component] = tail;
  }
  console.info("[route-grid] floor", floor.floorName, {
    cellSize: GRID_CELL_SIZE,
    scale: { x: sx, y: sy },
    svgViewBox: vb,
    components: grid.components,
    componentSizes,
  });
  if (debug) logGridDiagnostics(grid);
  floorGridCache.set(floor.floorName, grid);
  return grid;
}

/** 経路格子の調査用ログ（src/debug.ts の debug が true のときだけ） */
function logGridDiagnostics(grid: FloorGrid): void {
  const { floor, walkable } = grid;
  const traceName = globalThis.ROUTE_GRID_TRACE_ROOM ?? "2-6";
  const traceRoom = floor.rooms.find((room) => room.name === traceName);
  if (traceRoom) {
    const [[a, b], [c, d]] = traceRoom.bounds;
    const center = centerOf(traceRoom);
    const traceCell = {
      x: Math.round(center.lng / GRID_CELL_SIZE),
      y: Math.round(center.lat / GRID_CELL_SIZE),
    };
    console.info("[route-grid] raster trace", {
      room: traceRoom.name,
      roomSvgLikeBounds: traceRoom.bounds,
      roomCenter: { lat: center.lat, lng: center.lng },
      cell: traceCell,
      transformed: {
        x: traceCell.x * GRID_CELL_SIZE,
        y: traceCell.y * GRID_CELL_SIZE,
      },
      walkable: walkable(
        traceCell.x * GRID_CELL_SIZE,
        traceCell.y * GRID_CELL_SIZE,
      ),
      roomBoundsExtents: { north: a, west: b, south: c, east: d },
    });
  }
  const isolatedRooms = floor.rooms.map((room) => {
    try {
      const cell = nearestBoundaryCell(grid, centerOf(room), room);
      return {
        name: room.name,
        component: grid.componentAt(cell.x, cell.y),
        distancePx: cell.distance,
        grid: { x: cell.x, y: cell.y },
      };
    } catch (error) {
      return { name: room.name, component: null, reason: (error as Error).message };
    }
  }).filter(Boolean);
  console.info("[route-grid] room components", floor.floorName, isolatedRooms);
  const isolated = isolatedRooms.filter((room) => room.component === null);
  if (isolated.length) console.warn("[route-grid] isolated rooms", floor.floorName, isolated);
}

function nearestBoundaryCell(grid: FloorGrid, point: L.LatLng, room?: RoomInfo | null): BoundaryCell {
  const candidates: BoundaryCell[] = [];
  const mainComponent = grid.componentSizes.reduce(
    (largest, size, index) => size > (grid.componentSizes[largest] ?? 0) ? index : largest,
    0,
  );
  for (let y = grid.minY; y <= grid.maxY; y++) for (let x = grid.minX; x <= grid.maxX; x++) {
    const p = L.latLng(y * GRID_CELL_SIZE, x * GRID_CELL_SIZE);
    if (grid.walkable(p.lng, p.lat) && (!room || !roomContains(room, p))) {
      const distance = room ? roomBoundaryDistance(room, p) : p.distanceTo(point);
      candidates.push({
        x,
        y,
        distance,
        component: grid.componentAt(x, y),
        mainComponent: grid.componentAt(x, y) === mainComponent,
      });
    }
  }
  candidates.sort((a, b) =>
    Number(b.mainComponent) - Number(a.mainComponent) || a.distance - b.distance);
  if (!candidates[0]) {
    const bounds = room?.bounds ?? null;
    console.warn("[route-grid] no boundary cell", {
      floor: grid.floor.floorName,
      room: room?.name,
      searchCells: {
        x: grid.maxX - grid.minX + 1,
        y: grid.maxY - grid.minY + 1,
      },
      searchPixels: {
        x: (grid.maxX - grid.minX + 1) * GRID_CELL_SIZE,
        y: (grid.maxY - grid.minY + 1) * GRID_CELL_SIZE,
      },
      roomBounds: bounds,
    });
    throw new Error("接続できる歩行可能セルがありません");
  }
  console.debug("[route-grid] nearest boundary cell", {
    floor: grid.floor.floorName,
    room: room?.name,
    distancePx: candidates[0].distance,
    cell: candidates[0],
    transformed: {
      x: candidates[0].x * GRID_CELL_SIZE,
      y: candidates[0].y * GRID_CELL_SIZE,
    },
    walkable: grid.walkable(
      candidates[0].x * GRID_CELL_SIZE,
      candidates[0].y * GRID_CELL_SIZE,
    ),
  });
  return candidates[0];
}
function walkableLine(grid: FloorGrid, from: L.LatLng, to: L.LatLng, allowedRoom: RoomInfo | null = null): boolean {
  const distance = Math.max(Math.abs(to.lat - from.lat), Math.abs(to.lng - from.lng));
  const samples = Math.max(2, Math.ceil(distance * 4));
  for (let index = 0; index <= samples; index++) {
    const ratio = index / samples;
    const lat = from.lat + (to.lat - from.lat) * ratio;
    const lng = from.lng + (to.lng - from.lng) * ratio;
    const point = L.latLng(lat, lng);
    if (!grid.walkable(lng, lat) && !(allowedRoom && roomContainsWithTolerance(allowedRoom, point))) return false;
  }
  return true;
}
function orthogonalCandidates(from: L.LatLng, to: L.LatLng): L.LatLng[][] {
  const cornerA = L.latLng(from.lat, to.lng);
  const cornerB = L.latLng(to.lat, from.lng);
  return [
    [from, cornerA, to],
    [from, cornerB, to],
  ];
}
function validOrthogonalPath(grid: FloorGrid, points: L.LatLng[], startRoom: RoomInfo | null = null, goalRoom: RoomInfo | null = null): boolean {
  return points.every((point, index) => index === 0 || walkableLine(
    grid,
    points[index - 1],
    point,
    index === 1 ? startRoom : index === points.length - 1 ? goalRoom : null,
  ));
}
function simplifyOrthogonal(points: L.LatLng[]): L.LatLng[] {
  const result: L.LatLng[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    const beforePrevious = result[result.length - 2];
    if (previous && point.lat === previous.lat && point.lng === previous.lng) continue;
    if (beforePrevious && previous &&
      ((beforePrevious.lat === previous.lat && previous.lat === point.lat) ||
        (beforePrevious.lng === previous.lng && previous.lng === point.lng))) {
      result[result.length - 1] = point;
    } else result.push(point);
  }
  return result;
}
function gridPointCandidates(point: L.LatLng): GridCell[] {
  const x = point.lng / GRID_CELL_SIZE, y = point.lat / GRID_CELL_SIZE;
  return [...new Set([
    Math.floor(x), Math.ceil(x), Math.round(x),
  ])].flatMap((gridX) => [...new Set([
    Math.floor(y), Math.ceil(y), Math.round(y),
  ])].map((gridY) => ({ x: gridX, y: gridY })));
}
function connectPointToGrid(grid: FloorGrid, point: L.LatLng, room: RoomInfo | null): GridConnection[] {
  const nearbyCandidates: GridCell[] = [];
  const center = {
    x: Math.round(point.lng / GRID_CELL_SIZE),
    y: Math.round(point.lat / GRID_CELL_SIZE),
  };
  for (let y = center.y - 32; y <= center.y + 32; y++) {
    for (let x = center.x - 32; x <= center.x + 32; x++) {
      if (grid.cellAt(x, y)) nearbyCandidates.push({ x, y });
    }
  }
  // 近い格子点から順に調べ、最初につながったものを使う（全候補を調べると重い）
  nearbyCandidates.sort((a, b) =>
    Math.abs(a.x - center.x) + Math.abs(a.y - center.y) - (Math.abs(b.x - center.x) + Math.abs(b.y - center.y)));
  for (const candidate of nearbyCandidates) {
    const node = L.latLng(candidate.y * GRID_CELL_SIZE, candidate.x * GRID_CELL_SIZE);
    const path = orthogonalCandidates(point, node).find((p) => validOrthogonalPath(grid, p, room));
    if (path) return [{ node: candidate, path }];
  }
  return [];
}
function aStar(grid: FloorGrid, start: GridCell, goal: GridCell): L.LatLng[] | null {
  const cols = grid.maxX - grid.minX + 1, rows = grid.maxY - grid.minY + 1;
  const index = (x: number, y: number) => (y - grid.minY) * cols + (x - grid.minX);
  const cost = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  // 二分ヒープ（f 値の小さい順）
  const heapF: number[] = [], heapI: number[] = [];
  const push = (f: number, i: number) => {
    let k = heapF.push(f) - 1;
    heapI.push(i);
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (heapF[parent] <= heapF[k]) break;
      [heapF[parent], heapF[k]] = [heapF[k], heapF[parent]];
      [heapI[parent], heapI[k]] = [heapI[k], heapI[parent]];
      k = parent;
    }
  };
  const pop = (): number => {
    const top = heapI[0];
    const lastF = heapF.pop()!, lastI = heapI.pop()!;
    if (heapF.length) {
      heapF[0] = lastF;
      heapI[0] = lastI;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === k) break;
        [heapF[m], heapF[k]] = [heapF[k], heapF[m]];
        [heapI[m], heapI[k]] = [heapI[k], heapI[m]];
        k = m;
      }
    }
    return top;
  };
  if (!grid.cellAt(start.x, start.y) || !grid.cellAt(goal.x, goal.y)) return null;
  const startIndex = index(start.x, start.y), goalIndex = index(goal.x, goal.y);
  cost[startIndex] = 0;
  push(0, startIndex);
  while (heapF.length) {
    const current = pop();
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goalIndex) {
      const result: L.LatLng[] = [];
      for (let i = current; i >= 0; i = came[i]) {
        const x = (i % cols) + grid.minX, y = Math.floor(i / cols) + grid.minY;
        result.unshift(L.latLng(y * GRID_CELL_SIZE, x * GRID_CELL_SIZE));
      }
      return result;
    }
    const cx = (current % cols) + grid.minX, cy = Math.floor(current / cols) + grid.minY;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      // 隣り合う格子点どうしなので、両端が歩ければ間も歩ける
      if (!grid.cellAt(nx, ny)) continue;
      const next = index(nx, ny);
      const score = cost[current] + 1;
      if (score >= cost[next]) continue;
      came[next] = current;
      cost[next] = score;
      push(score + Math.abs(nx - goal.x) + Math.abs(ny - goal.y), next);
    }
  }
  return null;
}
function simplify(points: L.LatLng[]): L.LatLng[] {
  return points.filter((p, i) => i === 0 || i === points.length - 1 ||
    !(p.lat === points[i - 1].lat && p.lat === points[i + 1].lat) &&
    !(p.lng === points[i - 1].lng && p.lng === points[i + 1].lng));
}
async function calculateWalkablePath(floor: FloorInfo, start: L.LatLng, goal: L.LatLng, startRoom: RoomInfo | null, goalRoom: RoomInfo | null): Promise<L.LatLng[]> {
  const grid = await buildFloorGrid(floor);
  const startPoint = L.latLng(start), goalPoint = L.latLng(goal);
  const directPaths = orthogonalCandidates(startPoint, goalPoint)
    .filter((path) => validOrthogonalPath(grid, path, startRoom, goalRoom));
  if (directPaths.length) {
    return directPaths.sort((a, b) => a.length - b.length)[0];
  }
  const starts = connectPointToGrid(grid, startPoint, startRoom);
  const goals = connectPointToGrid(grid, goalPoint, goalRoom);
  const a = starts.sort((left, right) => left.path.length - right.path.length)[0];
  const b = goals.sort((left, right) => left.path.length - right.path.length)[0];
  if (!a || !b) {
    console.warn("[route] lineDot connector fallback", {
      floor: floor.floorName,
      start: startPoint,
      goal: goalPoint,
    });
    return orthogonalCandidates(startPoint, goalPoint)[0];
  }
  console.info("[route-grid] route endpoints", {
    floor: floor.floorName, start: { room: startRoom?.name, cell: a.node }, goal: { room: goalRoom?.name, cell: b.node },
  });
  const path = aStar(grid, a.node, b.node);
  if (!path) {
    console.warn("[route] grid path fallback", {
      floor: floor.floorName,
      start: startRoom?.name,
      goal: goalRoom?.name,
    });
    return orthogonalCandidates(startPoint, goalPoint)[0];
  }
  const gridPath = path.map((point) => L.latLng(point));
  return simplifyOrthogonal([...a.path, ...gridPath, ...b.path.slice().reverse()]);
}
function findStairPair(sourceFloor: FloorInfo, destinationFloor: FloorInfo, sourcePoint: L.LatLng, destinationPoint: L.LatLng) {
  const sourceStairs = sourceFloor.rooms.filter((room) => room.StairID);
  const destinationStairs = destinationFloor.rooms.filter((room) => room.StairID);
  return sourceStairs.flatMap((sourceRoom) => destinationStairs
    .filter((destinationRoom) => destinationRoom.StairID === sourceRoom.StairID)
    .map((destinationRoom) => ({
      source: { room: sourceRoom, point: L.latLng(sourceRoom.lineDot ?? centerOf(sourceRoom)) },
      destination: { room: destinationRoom, point: L.latLng(destinationRoom.lineDot ?? centerOf(destinationRoom)) },
      distance: L.latLng(sourceRoom.lineDot ?? centerOf(sourceRoom)).distanceTo(sourcePoint) +
        L.latLng(destinationRoom.lineDot ?? centerOf(destinationRoom)).distanceTo(destinationPoint),
    })))
    .sort((a, b) => a.distance - b.distance)[0];
}
export async function validateAllRoomPairs(): Promise<{ success: number; failure: number; outOfGrid: number }> {
  let success = 0, failure = 0, outOfGrid = 0;
  for (const floor of mapInfo.floors) {
    const grid = await buildFloorGrid(floor);
    for (const room of floor.rooms) for (const other of floor.rooms) {
      if (room === other) continue;
      try {
        const a = nearestBoundaryCell(grid, centerOf(room), room), b = nearestBoundaryCell(grid, centerOf(other), other);
        if (!grid.walkable(a.x * GRID_CELL_SIZE, a.y * GRID_CELL_SIZE) || !grid.walkable(b.x * GRID_CELL_SIZE, b.y * GRID_CELL_SIZE)) outOfGrid++;
        if (aStar(grid, a, b)) success++; else failure++;
      } catch { failure++; }
    }
  }
  console.info("[route-grid] validation", { success, failure, outOfGrid });
  return { success, failure, outOfGrid };
}
if (typeof window !== "undefined") window.validateRoomRoutes = validateAllRoomPairs;

const floorIndexOf = (name: string) => mapInfo.floors.findIndex((f) => f.floorName === name);

async function setRoute(): Promise<void> {
  if (!destinationLocation) return;
  const id = ++routeRequestId, destination = destinationLocation, definitions: RouteDefinition[] = [];
  const destinationPoint = destination.room.lineDot
    ? L.latLng(destination.room.lineDot)
    : centerOf(destination.room);
  const sourceFloor = mapInfo.floors.find((f) => f.floorName === currentLocation.floorName);
  if (!sourceFloor) throw new Error("現在地の階が見つかりません");
  const steps: RouteStep[] = [];
  /** 途中の階（通過するだけの階）に出す階段の目印 */
  const passMarkers = new Map<string, RouteMarker>();
  if (destination.floor.floorName === sourceFloor.floorName) {
    definitions.push({
      floor: destination.floor, start: L.latLng(currentLocation.point), goal: destinationPoint,
      startRoom: mapState.currentRoom, goalRoom: destination.room, startMarker: ["現在地", currentLocation.point, "#2980b9"], endMarker: [destination.room.name, destinationPoint, "#d35400"],
    });
    steps.push({ floorName: sourceFloor.floorName, icon: "directions_walk", text: `${destination.room.name}へ向かう`, focus: [] });
  } else {
    const pair = findStairPair(sourceFloor, destination.floor, L.latLng(currentLocation.point), destinationPoint);
    if (!pair) throw new Error("階段経由の経路を構築できません");
    const from = floorIndexOf(sourceFloor.floorName), to = floorIndexOf(destination.floor.floorName);
    const up = to > from;
    const arrow = up ? "↑" : "↓";
    const stairName = pair.source.room.name;
    // 通過する階（例: 1階→4階なら2階・3階）
    const passing = mapInfo.floors.slice(Math.min(from, to) + 1, Math.max(from, to));
    if (!up) passing.reverse();
    for (const floor of passing) {
      const stair = floor.rooms.find((room) => room.StairID === pair.source.room.StairID);
      if (stair) {
        passMarkers.set(floor.floorName, [`${stair.name}：通過 ${arrow} ${destination.floor.floorName}へ`, stair.lineDot ?? centerOf(stair), STAIR_COLOR]);
      }
    }
    definitions.push({
      floor: sourceFloor, start: L.latLng(currentLocation.point), goal: pair.source.point, startRoom: mapState.currentRoom, goalRoom: pair.source.room,
      startMarker: ["現在地", currentLocation.point, "#2980b9"],
      endMarker: [`${stairName} ${arrow} ${destination.floor.floorName}へ`, pair.source.point, STAIR_COLOR],
    });
    definitions.push({
      floor: destination.floor, start: pair.destination.point, goal: destinationPoint, startRoom: pair.destination.room, goalRoom: destination.room,
      startMarker: [`${pair.destination.room.name}（${sourceFloor.floorName}から）`, pair.destination.point, STAIR_COLOR],
      endMarker: [destination.room.name, destinationPoint, "#d35400"],
    });
    const floors = Math.abs(to - from);
    const via = passing.length ? `（${passing.map((f) => f.floorName).join("・")}を通過）` : "";
    steps.push(
      { floorName: sourceFloor.floorName, icon: "directions_walk", text: `${stairName}まで歩く`, focus: [] },
      {
        floorName: sourceFloor.floorName, icon: up ? "arrow_upward" : "arrow_downward",
        text: `${stairName}で${destination.floor.floorName}へ${up ? "上る" : "下りる"}（${floors}階分）${via}`,
        focus: [pair.source.point],
      },
      { floorName: destination.floor.floorName, icon: "flag", text: `${destination.room.name}へ向かう`, focus: [] },
    );
  }
  const next = new Map<string, { points: L.LatLng[]; startMarker: RouteMarker; endMarker: RouteMarker }>();
  try {
    for (const d of definitions) {
      const points = await calculateWalkablePath(d.floor, d.start, d.goal, d.startRoom, d.goalRoom);
      if (id !== routeRequestId) return;
      next.set(d.floor.floorName, { points, startMarker: d.startMarker, endMarker: d.endMarker });
    }
  } catch (error) {
    console.error("[route] no route", error);
    document.getElementById("route-error")?.replaceChildren(`経路を見つけられませんでした：${(error as Error).message}`);
    return;
  }
  // 歩く手順には、その階の経路全体を表示範囲として持たせる
  for (const step of steps) {
    if (!step.focus.length) step.focus = next.get(step.floorName)?.points ?? [];
  }
  routeSegments.clear();
  for (const [name, segment] of next) routeSegments.set(name, { layers: () => [
    L.polyline(segment.points, { color: "#d35400", weight: 5, dashArray: "10 8", className: "navigation-route" }),
    routeMarker(segment.startMarker, 9),
    routeMarker(segment.endMarker, 11),
  ] });
  for (const [name, marker] of passMarkers) routeSegments.set(name, { layers: () => [routeMarker(marker, 11)] });
  routeSteps = steps;
  document.getElementById("route-error")?.replaceChildren();
  updateNavigationBanner();
  // まずは現在地の階（最初の手順）を表示する
  goToStep(0);
}

/** 経路上の目印。階段は色を変え、ラベルを目立たせる */
function routeMarker([label, point, color]: RouteMarker, radius: number): L.CircleMarker {
  const stair = color === STAIR_COLOR;
  return L.circleMarker(point, { radius, color: "#fff", weight: 3, fillColor: color, fillOpacity: 1 })
    .bindTooltip(label, { permanent: true, className: stair ? "route-tooltip route-tooltip-stair" : "route-tooltip" });
}
function updateUrl(): void {
  const params = new URLSearchParams(window.location.search); params.set("current", currentLocation.name);
  if (destinationLocation) params.set("destination", destinationLocation.room.name);
  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
}
function selectSelection(selection: Selection): void {
  if (searchMode === "current") {
    currentLocation.name = selection.room.name; currentLocation.floorName = selection.floor.floorName;
    currentLocation.point = selection.room.lineDot ?? centerOf(selection.room);
    mapState.currentRoom = selection.room;
  } else { destinationLocation = selection; mapState.destinationRoom = selection.room; }
  refreshRoomHighlights(); updateNavigationBanner(); updateUrl(); void setRoute();
  document.getElementById("room-search-panel")!.hidden = true;
}
function renderResults(results: Selection[], pane: HTMLElement): void {
  pane.replaceChildren();
  if (!results.length) { pane.textContent = "該当する教室が見つかりません。"; return; }
  for (const result of results) {
    const button = document.createElement("button"); button.type = "button"; button.className = "room-result";
    const icon = document.createElement("span"); icon.className = "material-symbols-outlined"; icon.textContent = "meeting_room";
    const roomName = document.createElement("span"); roomName.textContent = result.room.name;
    const floorName = document.createElement("small"); floorName.textContent = result.floor.floorName;
    button.append(icon, roomName, floorName);
    button.addEventListener("click", () => selectSelection(result)); pane.append(button);
  }
}
export function bindRoomSearch(): void {
  const panel = document.getElementById("room-search-panel"), input = document.getElementById("room-search-input") as HTMLInputElement | null, currentInput = document.getElementById("current-room-search-input") as HTMLInputElement | null, results = document.getElementById("room-search-results");
  if (!panel || !input || !results) return;
  requireMap().on("baselayerchange", handleRouteFloorChange);
  const setMode = (mode: SearchMode) => { searchMode = mode; document.querySelectorAll<HTMLElement>("[data-search-mode]").forEach((b) => b.classList.toggle("active", b.dataset.searchMode === mode)); document.getElementById("current-search-field")!.hidden = mode !== "current"; document.getElementById("destination-search-field")!.hidden = mode !== "destination"; };
  const open = (mode: SearchMode) => { setMode(mode); panel.hidden = false; (mode === "current" ? currentInput : input)?.focus(); };
  document.querySelectorAll<HTMLElement>("[data-open-search]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      open(button.dataset.openSearch as SearchMode);
    });
  });
  document.getElementById("room-search-close")?.addEventListener("click", () => { panel.hidden = true; });
  panel.addEventListener("click", (e) => { if (e.target === panel) panel.hidden = true; });
  for (const field of [input, currentInput]) {
    field?.addEventListener("input", () => renderResults(getRoomMatches(field.value), results));
  }
  document.getElementById("room-search-submit")?.addEventListener("click", () => {
    setMode("destination");
    input.focus();
    renderResults(getRoomMatches(input.value), results);
  });
  document.getElementById("current-room-search-submit")?.addEventListener("click", () => {
    setMode("current");
    currentInput!.focus();
    renderResults(getRoomMatches(currentInput!.value), results);
  });
  document.querySelectorAll<HTMLElement>("[data-search-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.searchMode as SearchMode)));
  const params = new URLSearchParams(window.location.search);
  const deepLinks: [string, SearchMode, HTMLInputElement | null][] = [["current", "current", currentInput], ["destination", "destination", input]];
  for (const [key, mode, field] of deepLinks) {
    const found = getRoomMatches(params.get(key) ?? "")[0]; if (found) { field!.value = found.room.name; setMode(mode); selectSelection(found); }
  }
}
export function selectRoom(room: RoomInfo): void {
  const floor = mapInfo.floors.find((f) => f.rooms.includes(room)); if (floor) selectSelection({ room, floor });
}
