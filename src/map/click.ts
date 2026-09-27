import L from "leaflet";
import mapInfo from "../../env/mapinfo.js";
import { debug } from "../debug";
import { mapState, requireMap } from "./state";

let debugBounds: [number, number] | null = null;
let debugPopup: L.Popup | null = null;

let onRoomClick: ((room: RoomInfo) => void) | null = null;

function handleDebugBoundsClick(e: L.LeafletMouseEvent): void {
  const map = requireMap();
  if (!debugBounds && !debugPopup) {
    const coord = e.latlng;
    debugBounds = [coord.lat, coord.lng];
    debugPopup = L.popup({
      closeButton: false,
      autoClose: false,
      closeOnClick: false,
      className: "fade-popup",
    })
      .setLatLng(coord)
      .setContent("右下")
      .openOn(map);
    return;
  }

  if (!debugBounds) return;

  const coord = e.latlng;
  const lastBounds = [coord.lat, coord.lng];
  navigator.clipboard.writeText(`
        {
          name: "",
          bounds: [
            [${debugBounds}],
            [${lastBounds}],
          ],
        },`);
  const lastPopup = L.popup({
    closeButton: false,
    autoClose: false,
    closeOnClick: false,
    className: "fade-popup",
  })
    .setLatLng(coord)
    .setContent("左上")
    .openOn(map);
  setTimeout(function () {
    map.closePopup(lastPopup);
    if (debugPopup) map.closePopup(debugPopup);
    debugBounds = null;
    debugPopup = null;
  }, 500);
}

function handleDebugLineDotClick(e: L.LeafletMouseEvent): void {
  const coord = [e.latlng.lat, e.latlng.lng];
  navigator.clipboard.writeText(`lineDot: [${coord}],`);
  L.popup({
    closeButton: false,
    autoClose: true,
    closeOnClick: true,
    className: "fade-popup",
  })
    .setLatLng(e.latlng)
    .setContent("lineDot をコピーしました")
    .openOn(requireMap());
}

function findRoomAt(latlng: L.LatLng): RoomInfo | undefined {
  const floor = mapInfo.floors.find(
    (f) => f.floorName === mapState.nowBaseLayerName,
  );
  if (!floor) return;
  return floor.rooms.find(
    (r) =>
      r.bounds[0][0] < latlng.lat &&
      r.bounds[0][1] > latlng.lng &&
      r.bounds[1][0] > latlng.lat &&
      r.bounds[1][1] < latlng.lng,
  );
}

export function bindMapClicks(
  map: L.Map,
  roomClick: ((room: RoomInfo) => void) | null = null,
): void {
  onRoomClick = roomClick;
  map.on("click", function (e: L.LeafletMouseEvent) {
    if (debug && e.originalEvent.altKey) {
      handleDebugLineDotClick(e);
      return;
    }
    if (debug && e.originalEvent.shiftKey) {
      handleDebugBoundsClick(e);
      return;
    }

    const room = findRoomAt(e.latlng);
    if (!room) return;
    onRoomClick?.(room);
  });
}
