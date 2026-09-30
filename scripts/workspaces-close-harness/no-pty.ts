// The harness never starts a real process: every PTY comes from the fake factory in main.ts.
export function spawn(): never {
  throw new Error("the harness has no real PTY");
}
