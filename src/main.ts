import "./style.css";
import { initMap } from "./map/index";
import { bindRoomSearch, selectRoom } from "./map/search";

initMap({ onRoomClick: selectRoom });
bindRoomSearch();

// 地図エディタ (editor.html) で env/ が保存されたら再読み込みする（開発時のみ）
import.meta.hot?.on("map-editor:env-changed", () => location.reload());
