import L from "leaflet";

export const SVG_WIDTH = 700;
export const SVG_HEIGHT = 800;
export const ZOOM_THRESHOLD = 1;

export const mapBounds: L.LatLngBounds = L.latLngBounds(
  L.latLng(0, 0),
  L.latLng(SVG_HEIGHT, SVG_WIDTH),
);

export const ROOM_COLOR_BOOTH = "#3388ff";
export const ROOM_COLOR_HAS_EVENT = "#aaff33";
export const ROOM_COLOR_TOILET = "#a0fff7";
export const ROOM_COLOR_STAIR = "#b8a2a2";
export const ROOM_COLOR_DEBUG = "#a3a300";
