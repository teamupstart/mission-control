import { createLogger, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { BASE_URL } from "./src/shared/harness-runtime.mjs";
import { createDaemonProxy } from "./scripts/vite-daemon-proxy.ts";

const backend = BASE_URL;

// Vite comes up seconds before the daemon under `npm run dev`, so requests proxied in that
// window fail. This collapses the resulting per-request stacks into one line per
// reachability change and answers the browser 503 - see scripts/vite-daemon-proxy.ts.
const daemon = createDaemonProxy(backend, createLogger());

// The web app lives in src/web and is built into dist/web, which the daemon
// serves in production. In dev, Vite serves it on 5173 and proxies API + SSE
// traffic to the daemon so there is a single origin from the browser's view.
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  plugins: [react()],
  customLogger: daemon.logger,
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true, configure: daemon.configure },
      // SSE endpoint: proxy must not buffer.
      "/events": { target: backend, changeOrigin: true, configure: daemon.configure },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
});
