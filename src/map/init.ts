import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { debug } from "../debug";
import { SVG_HEIGHT, mapBounds } from "./constants";
import { mapState } from "./state";

// ピンの再バインド
L.Icon.Default.imagePath = "/leaflet/";

/**
 * Leaflet の土台とズームコントロールだけを作る。
 */
export function createMap(): L.Map {
  const map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: debug ? 6 : 3,
    zoomSnap: 0.5,
    maxBounds: mapBounds,
    maxBoundsViscosity: 1,
    zoomControl: false,
  }).fitBounds(mapBounds);

  L.control
    .zoom({
      position: "bottomright",
    })
    .addTo(map);

  map.setView(L.latLng(SVG_HEIGHT, 0));
  mapState.map = map;
  return map;
}

/**
 * 階層切り替えコントロールを画面左下に置く。
 */
export function addFloorControl(map: L.Map): void {
  L.control
    .layers(mapState.baseLayers, undefined, {
      position: "topright",
      collapsed: false,
    })
    .addTo(map);
}
