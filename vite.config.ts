import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const HARNESS_PORT = process.env.HARNESS_PORT ?? "7317";
const backend = `http://127.0.0.1:${HARNESS_PORT}`;

// The web app lives in src/web and is built into dist/web, which the daemon
// serves in production. In dev, Vite serves it on 5173 and proxies API + SSE
// traffic to the daemon so there is a single origin from the browser's view.
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      // SSE endpoint: proxy must not buffer.
      "/events": { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
});
