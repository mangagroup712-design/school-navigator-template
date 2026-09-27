export interface Point {
  x: number;
  y: number;
}

/**
 * Parse SVG path data into closed polygon rings.
 *
 * Routing uses an occupancy grid, but the SVG parser is kept independent so
 * compound walkable paths can still be rasterized without a geometry library.
 */
export function parseSvgPathRings(d: string): Point[][] {
  const tokens = d.match(/[a-z]|-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const rings: Point[][] = [];
  let ring: Point[] = [];
  let command = "";
  let index = 0;
  let x = 0;
  let y = 0;
  while (index < tokens.length) {
    if (/[a-z]/i.test(tokens[index])) command = tokens[index++];
    const lower = command.toLowerCase();
    const relative = command === lower;
    if (lower === "z") {
      if (ring.length >= 3) rings.push(ring);
      ring = [];
      command = "";
      continue;
    }
    if (lower === "m" || lower === "l") {
      const nextX = Number(tokens[index++]);
      const nextY = Number(tokens[index++]);
      if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) break;
      x = relative ? x + nextX : nextX;
      y = relative ? y + nextY : nextY;
      if (lower === "m" && ring.length >= 3) {
        rings.push(ring);
        ring = [];
      }
    } else if (lower === "h" || lower === "v") {
      const value = Number(tokens[index++]);
      if (!Number.isFinite(value)) break;
      if (lower === "h") x = relative ? x + value : value;
      else y = relative ? y + value : value;
    } else {
      index += lower === "c" ? 6 : lower === "s" || lower === "q" ? 4 : 2;
      continue;
    }
    ring.push({ x, y });
  }
  if (ring.length >= 3) rings.push(ring);
  return rings;
}
