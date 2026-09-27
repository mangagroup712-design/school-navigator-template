interface MapInfo {
  floors: FloorInfo[];
  attribution?: string;
}
interface FloorInfo {
  floorFile: string;
  floorName: string;
  rooms: RoomInfo[];
}
interface RoomInfo {
  /** "トイレ"だとトイレ表示に、"階段"だと階段表示になる。 */
  name: string;
  bounds: [[number, number], [number, number]];
  lineDot?: [number, number];
  StairID?: string;
  /** Search aliases retained for room lookup and deep links. */
  searchTerms?: string[];
  /** @deprecated searchTerms の旧名。検索時のフォールバックとして参照される。 */
  aliases?: string[];
  eventIds?: string[];
}
