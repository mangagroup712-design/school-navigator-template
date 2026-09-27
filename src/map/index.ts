import mapInfo from "../../env/mapinfo.js";
import { bindMapClicks } from "./click";
import { buildMapDisplay } from "./display";
import { addFloorControl, createMap } from "./init";
import { bindMapDisplayUpdates, showFloor } from "./update";

/**
 * マップの初期化・表示構築・更新・クリック処理をまとめて起動する。
 */
export function initMap(
  options: { onRoomClick?: ((room: RoomInfo) => void) | null } = {},
): void {
  const map = createMap();
  buildMapDisplay();
  bindMapDisplayUpdates(map);
  bindMapClicks(map, options.onRoomClick ?? null);
  addFloorControl(map);

  const initialFloor = mapInfo.floors[0]?.floorName;
  if (!initialFloor) {
    throw new Error("initMap: mapinfo has no floors");
  }
  showFloor(initialFloor);

  map.setZoom(1);
}
