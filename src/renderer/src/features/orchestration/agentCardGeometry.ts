import { MAX_TERMINAL_SIZE, type ResizeSizeLimits } from "../workspace/snap.ts";

// 1.5.13: the card is resized like a terminal's. Its compact size (the size it was before) is the smallest; the largest
// is a terminal's. "Expand" returns to the size it had last time it was larger (canvas store, card.expanded).
export const AGENT_CARD_SIZE = { width: 300, height: 222 };
export const AGENT_CARD_EXPANDED = { width: 460, height: 560 };
export const AGENT_CARD_LIMITS: ResizeSizeLimits = { min: AGENT_CARD_SIZE, max: MAX_TERMINAL_SIZE };
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
export const agentCardSize = (s: { width: number; height: number }): { width: number; height: number } =>
  ({ width: clamp(s.width, AGENT_CARD_LIMITS.min.width, AGENT_CARD_LIMITS.max.width), height: clamp(s.height, AGENT_CARD_LIMITS.min.height, AGENT_CARD_LIMITS.max.height) });
export const isCompact = (s: { width: number; height: number }): boolean => s.width <= AGENT_CARD_SIZE.width && s.height <= AGENT_CARD_SIZE.height;
// The live feed shows only what the card's own lines do: a path under a home folder is said from "~"
export const withoutHome = (text: string): string => text.replace(/\/(?:Users|home)\/[^/\s"'`]+/g, "~");
