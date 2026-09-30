/// <reference types="vite/client" />

import type { CanvasTTYApi } from "../../shared/contracts";

declare global {
  interface Window {
    canvasTTY: CanvasTTYApi;
  }
}
