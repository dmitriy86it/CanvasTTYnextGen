import type { Point, SessionBounds, Size } from "../../../../shared/contracts";

export const SNAP_GRID = 10;
export const SNAP_THRESHOLD = 10;
export const SNAP_GAP = 20;
export const MIN_TERMINAL_SIZE: Size = { width: 420, height: 260 };
export const MAX_TERMINAL_SIZE: Size = { width: 1_600, height: 1_100 };

export type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface ResizeSizeLimits {
  min: Size;
  max: Size;
}

export function snapMove(position: Point, size: Size, targets: readonly SessionBounds[]): Point {
  const xCandidates: number[] = [];
  const yCandidates: number[] = [];

  for (const target of targets) {
    const right = target.position.x + target.size.width;
    const bottom = target.position.y + target.size.height;
    xCandidates.push(
      target.position.x,
      right - size.width,
      target.position.x + (target.size.width - size.width) / 2,
      right + SNAP_GAP,
      target.position.x - size.width - SNAP_GAP
    );
    yCandidates.push(
      target.position.y,
      bottom - size.height,
      target.position.y + (target.size.height - size.height) / 2,
      bottom + SNAP_GAP,
      target.position.y - size.height - SNAP_GAP
    );
  }

  return {
    x: snapCoordinate(position.x, xCandidates),
    y: snapCoordinate(position.y, yCandidates)
  };
}

export function snapResize(
  bounds: SessionBounds,
  direction: ResizeDirection,
  targets: readonly SessionBounds[],
  limits: ResizeSizeLimits = { min: MIN_TERMINAL_SIZE, max: MAX_TERMINAL_SIZE }
): SessionBounds {
  let left = bounds.position.x;
  let top = bounds.position.y;
  let right = left + bounds.size.width;
  let bottom = top + bounds.size.height;
  const xEdges = targets.flatMap((target) => [
    target.position.x,
    target.position.x + target.size.width
  ]);
  const yEdges = targets.flatMap((target) => [
    target.position.y,
    target.position.y + target.size.height
  ]);

  if (direction.includes("w")) left = snapCoordinate(left, xEdges);
  if (direction.includes("e")) right = snapCoordinate(right, xEdges);
  if (direction.includes("n")) top = snapCoordinate(top, yEdges);
  if (direction.includes("s")) bottom = snapCoordinate(bottom, yEdges);

  let width = clamp(right - left, limits.min.width, limits.max.width);
  let height = clamp(bottom - top, limits.min.height, limits.max.height);

  if (direction.includes("w")) left = right - width;
  else right = left + width;
  if (direction.includes("n")) top = bottom - height;
  else bottom = top + height;

  width = right - left;
  height = bottom - top;
  return { position: { x: left, y: top }, size: { width, height } };
}

export function constrainResize(
  bounds: SessionBounds,
  direction: ResizeDirection,
  limits: ResizeSizeLimits = { min: MIN_TERMINAL_SIZE, max: MAX_TERMINAL_SIZE }
): SessionBounds {
  const right = bounds.position.x + bounds.size.width;
  const bottom = bounds.position.y + bounds.size.height;
  const width = clamp(bounds.size.width, limits.min.width, limits.max.width);
  const height = clamp(bounds.size.height, limits.min.height, limits.max.height);
  return {
    position: {
      x: direction.includes("w") ? right - width : bounds.position.x,
      y: direction.includes("n") ? bottom - height : bounds.position.y
    },
    size: { width, height }
  };
}

function snapCoordinate(value: number, preferred: readonly number[]): number {
  let closest = value;
  let distance = SNAP_THRESHOLD + 1;
  for (const candidate of preferred) {
    const candidateDistance = Math.abs(candidate - value);
    if (candidateDistance < distance) {
      closest = candidate;
      distance = candidateDistance;
    }
  }
  return distance <= SNAP_THRESHOLD ? closest : Math.round(value / SNAP_GRID) * SNAP_GRID;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
