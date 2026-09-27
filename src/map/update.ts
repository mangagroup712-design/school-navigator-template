import L from "leaflet";
import { ZOOM_THRESHOLD } from "./constants";
import { mapState, requireMap } from "./state";

/**
 * 現在のズームを基準に Bound のピクセルサイズを取る。
 */
function calcBoundsWidthHeightPixel(bounds: L.LatLngBounds): {
  width: number;
  height: number;
} {
  const map = requireMap();
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const swPoint = map.latLngToContainerPoint(sw);
  const nePoint = map.latLngToContainerPoint(ne);
  return {
    width: Math.abs(nePoint.x - swPoint.x),
    height: Math.abs(nePoint.y - swPoint.y),
  };
}

/**
 * 階層画像の切り替えに合わせて部屋レイヤーを差し替える。
 */
export function changeLayerGroups(newBaseLayerName: string): void {
  const map = requireMap();
  mapState.layerGroups.get(mapState.nowBaseLayerName)?.remove();
  mapState.layerGroups.get(newBaseLayerName)?.addTo(map);
  mapState.nowBaseLayerName = newBaseLayerName;
}

/**
 * ズーム量を見て部屋名ラベルの表示／非表示を切り替える。
 */
export function recheckRoomLabelShowStatus(): void {
  const currentZoom = requireMap().getZoom();
  const layerGroup = mapState.layerGroups.get(mapState.nowBaseLayerName);
  const roomLabelLayerGroup = mapState.roomLabelLayerGroups.get(
    mapState.nowBaseLayerName,
  );
  if (!layerGroup || !roomLabelLayerGroup) {
    throw new Error(
      `recheckRoomLabelShowStatus: layer group not found (floorName: ${mapState.nowBaseLayerName})`,
    );
  }
  if (currentZoom < ZOOM_THRESHOLD) roomLabelLayerGroup.remove();
  else roomLabelLayerGroup.addTo(layerGroup);
}

/**
 * ズームに合わせて部屋名ラベルのサイズを更新する。
 */
export function calculateRoomLabelArea(): void {
  const roomLabelLayerGroup = mapState.roomLabelLayerGroups.get(
    mapState.nowBaseLayerName,
  );
  if (!roomLabelLayerGroup) {
    throw new Error(
      `calculateRoomLabelArea: layer group not found (floorName: ${mapState.nowBaseLayerName})`,
    );
  }
  roomLabelLayerGroup.eachLayer((label) => {
    if (!(label instanceof L.Marker)) return;
    const bounds = mapState.roomLabelBounds.get(label);
    const element = label.getElement();
    if (!bounds || !element) return;
    const { width, height } = calcBoundsWidthHeightPixel(bounds);
    // setIcon でアイコンを作り直すと部屋が多いときに重いので、既存の要素の大きさだけ変える
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.style.marginLeft = `${-width / 2}px`;
    element.style.marginTop = `${-height / 2}px`;
  });
}

export function refreshCurrentFloorDisplay(): void {
  recheckRoomLabelShowStatus();
  calculateRoomLabelArea();
}

/**
 * 階層変更・ズームに応じた表示更新をマップへ接続する。
 */
export function bindMapDisplayUpdates(map: L.Map): void {
  map.on("baselayerchange", function (e: L.LayersControlEvent) {
    changeLayerGroups(e.name);
    refreshCurrentFloorDisplay();
  });

  map.on("zoomend", function () {
    refreshCurrentFloorDisplay();
  });
}

/**
 * 指定した階層の画像と部屋レイヤーを表示する。
 */
export function showFloor(floorName: string): void {
  const overlay = mapState.baseLayers[floorName];
  if (!overlay) {
    throw new Error(`showFloor: unknown floor (${floorName})`);
  }
  const map = requireMap();
  for (const otherOverlay of Object.values(mapState.baseLayers)) {
    if (otherOverlay !== overlay) map.removeLayer(otherOverlay);
  }
  overlay.addTo(requireMap());
  changeLayerGroups(floorName);
}
