// A card's frame on the canvas: moved by its header, resized by eight handles, snapped as a terminal card is. The
// agent cards and the task board share it (stage-b-board.md §6: «the same handles, selection, zoom»). The bounds shown
// follow the pointer; the caller is told once, at the end of a gesture.
import { useEffect, useRef, useState } from "react";
import type { Point, SessionBounds } from "../../../../shared/contracts";
import { constrainResize, snapMove, snapResize, type ResizeDirection } from "../workspace/snap";

export const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

export function useCardFrame({ bounds: given, zoom, snapEnabled, snapTargets, limits, onMoved, onResized }: {
  bounds: SessionBounds;
  zoom: number;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  limits: Parameters<typeof constrainResize>[2];
  onMoved(next: SessionBounds): void;
  onResized(next: SessionBounds): void;
}) {
  const drag = useRef<{ pointerId: number; start: Point; startPos: Point } | null>(null);
  const resizing = useRef<{ pointerId: number; direction: ResizeDirection; start: Point; startBounds: SessionBounds } | null>(null);
  const [bounds, setBounds] = useState<SessionBounds>(given);
  const live = useRef<SessionBounds>(given);
  useEffect(() => {
    live.current = given;
    setBounds(given);
  }, [given]);
  const apply = (next: SessionBounds): void => { live.current = next; setBounds(next); };

  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, startPos: live.current.position };
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId || event.buttons === 0) return;
    const raw = { x: d.startPos.x + (event.clientX - d.start.x) / zoom, y: d.startPos.y + (event.clientY - d.start.y) / zoom };
    apply({ position: snapEnabled ? snapMove(raw, live.current.size, snapTargets) : raw, size: live.current.size });
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const moved = live.current.position.x !== drag.current.startPos.x || live.current.position.y !== drag.current.startPos.y;
    drag.current = null;
    if (moved) onMoved(live.current);
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>, direction: ResizeDirection): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizing.current = { pointerId: event.pointerId, direction, start: { x: event.clientX, y: event.clientY }, startBounds: live.current };
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const r = resizing.current;
    if (!r || r.pointerId !== event.pointerId || event.buttons === 0) return; // a buttonless move is a hover
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - r.start.x) / zoom;
    const dy = (event.clientY - r.start.y) / zoom;
    const b = r.startBounds;
    const constrained = constrainResize({
      position: { x: b.position.x + (r.direction.includes("w") ? dx : 0), y: b.position.y + (r.direction.includes("n") ? dy : 0) },
      size: { width: b.size.width + (r.direction.includes("e") ? dx : 0) - (r.direction.includes("w") ? dx : 0),
        height: b.size.height + (r.direction.includes("s") ? dy : 0) - (r.direction.includes("n") ? dy : 0) }
    }, r.direction, limits);
    apply(snapEnabled ? snapResize(constrained, r.direction, snapTargets, limits) : constrained);
  };
  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resizing.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    resizing.current = null;
    onResized(live.current);
  };
  const header = { onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: () => { drag.current = null; } };
  const handle = (direction: ResizeDirection) => ({
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => startResize(event, direction), onPointerMove: resize, onPointerUp: endResize,
    onPointerCancel: endResize, onLostPointerCapture: () => { resizing.current = null; }
  });
  return { bounds, live, apply, header, handle };
}
