// Diagnostics of the link gesture for the UI drivers (scripts/real-autopilot-series.mjs --diag-link). Inert unless a
// driver has put an array at window.__canvasTTYLinkTrace before the gesture: it only appends, never changes handling.
export function linkTrace(step: string, data: Record<string, unknown> = {}): void {
  const trace = (window as { __canvasTTYLinkTrace?: unknown }).__canvasTTYLinkTrace;
  if (Array.isArray(trace) && trace.length < 500) trace.push({ t: Math.round(performance.now()), step, ...data });
}
