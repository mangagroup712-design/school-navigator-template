import type L from "leaflet";

export interface MapState {
  map: L.Map | null;
  imageOverlays: L.ImageOverlay[];
  baseLayers: { [floorName: string]: L.ImageOverlay };
  layerGroups: Map<string, L.LayerGroup>;
  roomLabelLayerGroups: Map<string, L.LayerGroup>;
  roomLabelBounds: Map<L.Marker, L.LatLngBounds>;
  roomLayers: Map<RoomInfo, L.Rectangle>;
  currentRoom: RoomInfo | null;
  destinationRoom: RoomInfo | null;
  nowBaseLayerName: string;
}

export const mapState: MapState = {
  map: null,
  imageOverlays: [],
  baseLayers: {},
  layerGroups: new Map(),
  roomLabelLayerGroups: new Map(),
  roomLabelBounds: new Map(),
  roomLayers: new Map(),
  currentRoom: null,
  destinationRoom: null,
  nowBaseLayerName: "",
};

export function refreshRoomHighlights(): void {
  for (const [room, layer] of mapState.roomLayers) {
    const selected =
      room === mapState.currentRoom || room === mapState.destinationRoom;
    layer.setStyle({
      color: selected ? "#d35400" : "#3388ff",
      fillColor: selected ? "#d35400" : "#3388ff",
    });
  }
}

export function requireMap(): L.Map {
  if (!mapState.map) {
    throw new Error("map is not initialized");
  }
  return mapState.map;
}
