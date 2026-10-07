// Where a link's chip goes (UX audit PR 2, Н14): between the two cards it links, unless it would cover a card there —
// then under the pair, else above it. The chip is centred on the point (translate(-50%, -50%)). Pure: tested under node.
export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

const GAP = 10;
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const around = (c: Point, w: number, h: number): Rect => ({ x: c.x - w / 2, y: c.y - h / 2, width: w, height: h });

// ponytail: the chip's size is estimated from its label (the buttons beside it are about the same width in both
// languages); measure the element if a label ever outgrows the estimate.
export function chipSize(label: string, buttons: number, scale = 1): { width: number; height: number } {
  return { width: (label.length * 6.6 + buttons * 92 + 24) * scale, height: 26 * scale };
}

// from / to: the linked cards; cards: every card on the canvas (the two included); size: the chip's.
export function chipCenter(from: Rect, to: Rect, cards: readonly Rect[], size: { width: number; height: number }): Point {
  const mid = { x: (from.x + from.width + to.x) / 2, y: (from.y + from.height / 2 + to.y + to.height / 2) / 2 };
  const free = (c: Point) => !cards.some((r) => overlaps(around(c, size.width, size.height), r));
  if (free(mid)) return mid;
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x + from.width, to.x + to.width);
  const x = (left + right) / 2;
  const below = { x, y: Math.max(from.y + from.height, to.y + to.height) + GAP + size.height / 2 };
  if (free(below)) return below;
  const above = { x, y: Math.min(from.y, to.y) - GAP - size.height / 2 };
  return free(above) ? above : below;
}
