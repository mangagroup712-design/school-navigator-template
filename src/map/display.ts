import L from "leaflet";
import stairsIconUrl from "../../Stairs.svg";
import mapInfo from "../../env/mapinfo.js";
import { debug } from "../debug";
import { multiSelect } from "../util";
import { ROOM_COLOR_DEBUG, ROOM_COLOR_STAIR, ROOM_COLOR_TOILET, mapBounds } from "./constants";
import { mapState } from "./state";

/**
 * 階層画像・部屋の矩形・部屋名ラベルを生成して state に載せる。
 */
export function buildMapDisplay(): void {
  // 部屋の四角は数が多いので、SVG 要素ではなく1枚の Canvas にまとめて描く
  const roomRenderer = L.canvas({ padding: 0.5 });
  for (const floor of mapInfo.floors) {
    const imgOverlay = L.imageOverlay(`/env/${floor.floorFile}`, mapBounds, {
      attribution: mapInfo.attribution,
    });
    mapState.imageOverlays.push(imgOverlay);
    mapState.baseLayers[floor.floorName] = imgOverlay;

    const layerGroup = L.layerGroup();
    const roomLabelLayerGroup = L.layerGroup();

    for (const room of floor.rooms) {
      const bounds = L.latLngBounds(
        L.latLng(...room.bounds[0]),
        L.latLng(...room.bounds[1]),
      );

      const color: string | undefined = multiSelect(
        room.name !== "トイレ" && !room.name.includes("階段"),
        "#3388ff",
        room.name === "トイレ",
        ROOM_COLOR_TOILET,
        room.StairID || room.name.includes("階段") || room.name.includes("階;段") || room.name.includes("階＆段"),
        ROOM_COLOR_STAIR,
        debug,
        ROOM_COLOR_DEBUG,
      );

      if (typeof color !== "undefined") {
        const defaultStyle: L.PolylineOptions = {
          className: "map-room-selectable",
          renderer: roomRenderer,
          color,
          weight: 3,
          fillColor: color,
          fillOpacity: 0.2,
        };
        const rectangle = L.rectangle(bounds, defaultStyle).addTo(layerGroup);
        mapState.roomLayers.set(room, rectangle);
      }

      if (room.StairID || room.name.includes("階段") || room.name.includes("階;段") || room.name.includes("階＆段")) {
        const stairIcon = L.icon({
          iconUrl: stairsIconUrl,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        L.marker(bounds.getCenter(), { icon: stairIcon, title: room.name })
          .addTo(roomLabelLayerGroup);
      } else {
        const label = document.createElement("span");
        label.textContent = room.name;
        const textIcon = L.divIcon({ className: "map-room-text", html: label });
        const marker = L.marker(bounds.getCenter(), { icon: textIcon });
        marker.addTo(roomLabelLayerGroup);
        mapState.roomLabelBounds.set(marker, bounds);
      }
    }

    mapState.layerGroups.set(floor.floorName, layerGroup);
    mapState.roomLabelLayerGroups.set(floor.floorName, roomLabelLayerGroup);
  }
}
