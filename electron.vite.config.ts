import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    define: {
      __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__: JSON.stringify(
        process.env.GITHUB_OAUTH_CLIENT_ID?.trim()
          || process.env.CANVASTTY_GITHUB_CLIENT_ID?.trim()
          || ""
      )
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          browser: resolve("src/preload/browser.ts"),
          plugin: resolve("src/preload/plugin.ts")
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [
      react(),
      {
        // ws: exists only for the dev server's hot reload; the packaged renderer opens no sockets.
        name: "canvastty-production-csp",
        apply: "build",
        transformIndexHtml: (html) => {
          const next = html.replace("connect-src 'self' ws:;", "connect-src 'self';");
          if (next === html) throw new Error("Renderer CSP connect-src was not found.");
          return next;
        }
      }
    ]
  }
});
