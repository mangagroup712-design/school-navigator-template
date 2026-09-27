import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { SourcePage } from "./imageImport";

/**
 * PDF の各ページを画像にする（取り込みダイアログから必要なときだけ読み込む）。
 *
 * 全ページを同じ範囲（全ページの内容を囲む範囲）で切り抜くので、
 * 各ページを別々の階として取り込んだとき、階どうしの位置（階段など）がそろう。
 */

GlobalWorkerOptions.workerSrc = workerUrl;

/** 切り抜き前の描画サイズ（長辺 px）。切り抜き後に maxSize まで縮める */
const RENDER_SIZE = 3000;
const MARGIN = 8;

export async function renderPdf(file: Blob, maxSize: number): Promise<SourcePage[]> {
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  try {
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: RENDER_SIZE / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      canvases.push(canvas);
    }

    // 全ページの内容（白以外）を囲む範囲
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const canvas of canvases) {
      const { data, width, height } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) continue;
          if (x < box.x0) box.x0 = x;
          if (x > box.x1) box.x1 = x;
          if (y < box.y0) box.y0 = y;
          if (y > box.y1) box.y1 = y;
        }
      }
    }
    if (!Number.isFinite(box.x0)) throw new Error("PDF に図形がありません");
    const x0 = Math.max(0, box.x0 - MARGIN), y0 = Math.max(0, box.y0 - MARGIN);
    const cw = box.x1 + MARGIN - x0, ch = box.y1 + MARGIN - y0;
    const scale = Math.min(1, maxSize / Math.max(cw, ch));

    return await Promise.all(canvases.map(async (source) => {
      const out = document.createElement("canvas");
      out.width = Math.round(cw * scale);
      out.height = Math.round(ch * scale);
      const ctx = out.getContext("2d", { willReadFrequently: true })!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(source, x0, y0, cw, ch, 0, 0, out.width, out.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("画像に変換できません"))), "image/png"));
      return { data: ctx.getImageData(0, 0, out.width, out.height), blob };
    }));
  } finally {
    await task.destroy();
  }
}
