import {
  analyzeImage, loadSource, toHex, toMapData,
  type AnalyzeOptions, type Analysis, type ImportedFloor, type RGB, type SourcePage,
} from "./imageImport";

/**
 * 「画像・PDFから取り込む」ダイアログ。
 * 検出結果を画像に重ねてプレビューし、確定すると onImport に地図座標のデータを渡す。
 * PDF は各ページを1つの階として扱い、全ページをまとめて取り込むこともできる。
 */

export interface ImportedPage extends ImportedFloor {
  /** 下絵に使う画像 */
  image: Blob;
  width: number;
  height: number;
}

export interface ImportRequest {
  /** 今の階から順に取り込むページ */
  pages: ImportedPage[];
  replace: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function setupImportDialog(onImport: (request: ImportRequest) => void): (file?: File) => void {
  const dialog = $<HTMLDialogElement>("import-dialog");
  const canvas = $<HTMLCanvasElement>("import-canvas");
  const ctx = canvas.getContext("2d")!;
  const tolerance = $<HTMLInputElement>("import-tolerance");
  const closeRadius = $<HTMLInputElement>("import-close");
  const minRoom = $<HTMLInputElement>("import-min-room");
  const swatch = $("import-walk-color");
  const summary = $("import-summary");
  const pageNav = $("import-pages");
  const pageLabel = $("import-page-label");
  const allPages = $<HTMLInputElement>("import-all-pages");
  const checks = {
    walk: $<HTMLInputElement>("import-walk"),
    rooms: $<HTMLInputElement>("import-rooms"),
    dots: $<HTMLInputElement>("import-dots"),
    stairs: $<HTMLInputElement>("import-stairs"),
  };

  let pages: SourcePage[] = [];
  let pageIndex = 0;
  let bitmap: ImageBitmap | null = null;
  let walkColor: RGB | null = null;
  let analysis: Analysis | null = null;
  let pending = 0;

  const page = (): SourcePage | undefined => pages[pageIndex];
  const options = (): AnalyzeOptions => ({
    walkColor,
    tolerance: Number(tolerance.value),
    closeRadius: Number(closeRadius.value),
    minRoomRatio: Number(minRoom.value) / 10000,
    detectStairs: checks.stairs.checked,
  });
  const include = () => ({ walk: checks.walk.checked, rooms: checks.rooms.checked, dots: checks.dots.checked });

  function run(): void {
    if (!page()) return;
    clearTimeout(pending);
    summary.textContent = "解析中…";
    // スライダー操作中に何度も走らないよう少し待つ
    pending = window.setTimeout(() => {
      analysis = analyzeImage(page()!.data, options());
      draw();
    }, 60);
  }

  function draw(): void {
    if (!analysis || !bitmap) return;
    canvas.width = analysis.width;
    canvas.height = analysis.height;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const px = Math.max(1, analysis.width / 800);
    if (checks.walk.checked) {
      ctx.fillStyle = "rgba(19, 174, 103, 0.45)";
      ctx.strokeStyle = "rgba(19, 174, 103, 0.9)";
      ctx.lineWidth = px;
      for (const r of analysis.walkRects) {
        ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      }
    }
    if (checks.rooms.checked) {
      ctx.font = `bold ${Math.round(11 * px)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let number = 0;
      analysis.rooms.forEach((r) => {
        ctx.strokeStyle = r.stair ? "#6d4c41" : "#f57c00";
        ctx.lineWidth = 2 * px;
        if (r.stair) {
          ctx.fillStyle = "rgba(141, 110, 99, 0.35)";
          ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
        }
        ctx.strokeRect(r.x0 + px, r.y0 + px, r.x1 - r.x0 - 2 * px, r.y1 - r.y0 - 2 * px);
        ctx.fillStyle = r.stair ? "#4e342e" : "#b34d00";
        ctx.fillText(r.stair ? "階段" : String(++number), (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
        if (checks.dots.checked && r.dot) {
          ctx.fillStyle = "#e53935";
          ctx.beginPath();
          ctx.arc(r.dot[0], r.dot[1], 3 * px, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }
    swatch.style.background = toHex(analysis.walkColor);
    swatch.title = toHex(analysis.walkColor);
    const noDot = analysis.rooms.filter((r) => !r.dot).length;
    const stairs = analysis.rooms.filter((r) => r.stair).length;
    summary.textContent = `部屋 ${analysis.rooms.length - stairs} 室 / 階段 ${stairs} か所` +
      (checks.dots.checked && noDot ? `（lineDot を置けなかった部屋 ${noDot} 個）` : "");
  }

  async function showPage(index: number): Promise<void> {
    pageIndex = Math.max(0, Math.min(pages.length - 1, index));
    bitmap?.close();
    bitmap = await createImageBitmap(page()!.data);
    pageNav.hidden = pages.length < 2;
    pageLabel.textContent = `ページ ${pageIndex + 1} / ${pages.length}`;
    $("import-all-pages-label").hidden = pages.length < 2;
    run();
  }

  // 画像をクリックすると、その色を歩行エリアの色にする（全ページ共通）
  canvas.addEventListener("click", (e) => {
    const image = page()?.data;
    if (!image) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * image.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * image.height);
    const i = (y * image.width + x) * 4;
    walkColor = [image.data[i], image.data[i + 1], image.data[i + 2]];
    run();
  });
  $("import-walk-auto").addEventListener("click", () => {
    walkColor = null;
    run();
  });
  $("import-prev").addEventListener("click", () => void showPage(pageIndex - 1));
  $("import-next").addEventListener("click", () => void showPage(pageIndex + 1));
  for (const input of [tolerance, closeRadius, minRoom]) input.addEventListener("input", run);
  for (const input of [checks.walk, checks.rooms, checks.dots]) input.addEventListener("change", draw);
  checks.stairs.addEventListener("change", run);

  dialog.querySelectorAll<HTMLInputElement>(".import-file").forEach((el) => {
    el.addEventListener("change", () => {
      const picked = el.files?.[0];
      el.value = "";
      if (picked) void load(picked);
    });
  });

  async function load(picked: File): Promise<void> {
    summary.textContent = "読み込み中…";
    try {
      pages = await loadSource(picked);
      walkColor = null;
      allPages.checked = pages.length > 1;
      $("import-empty").hidden = true;
      canvas.hidden = false;
      await showPage(0);
    } catch (error) {
      summary.textContent = `読み込めません: ${error}`;
    }
  }

  $("import-cancel").addEventListener("click", () => dialog.close());
  $("import-apply").addEventListener("click", () => {
    if (!analysis || !page()) return;
    // 全ページを取り込む場合は、表示中のページと同じ設定・同じ通路の色で各ページを解析する
    const targets = allPages.checked && pages.length > 1 ? pages : [page()!];
    const result: ImportedPage[] = targets.map((source) => {
      const a = source === page()
        ? analysis!
        : analyzeImage(source.data, { ...options(), walkColor: walkColor ?? analysis!.walkColor });
      return { ...toMapData(a, include()), image: source.blob, width: a.width, height: a.height };
    });
    onImport({ pages: result, replace: $<HTMLInputElement>("import-replace").checked });
    dialog.close();
  });

  return (initial?: File) => {
    dialog.showModal();
    if (initial) void load(initial);
  };
}
