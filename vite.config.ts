import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";
import { BASE_URL } from "./src/shared/harness-runtime.mjs";
import { createDaemonProxy } from "./scripts/vite-daemon-proxy.ts";

const backend = BASE_URL;

// Vite comes up seconds before the daemon under `npm run dev`, so requests proxied in that
// window fail. This collapses the resulting per-request stacks into one line per
// reachability change and answers the browser 503 - see scripts/vite-daemon-proxy.ts.
const daemon = createDaemonProxy(backend);
const quietDaemonProxyErrors: Plugin = {
  name: "mission-control:quiet-daemon-proxy-errors",
  apply: "serve",
  configResolved(config) {
    daemon.installLogger(config.logger);
  },
};

const MERMAID_RENDERER_ASSET = "assets/mermaid-renderer.js";
const MERMAID_RENDERER_MARKER = "<!-- mission-mermaid-classic-script -->";
const MERMAID_RENDERER_NONCE = "mission-mermaid-v1";
const mermaidBundlePath = fileURLToPath(new URL("./node_modules/mermaid/dist/mermaid.min.js", import.meta.url));
const mermaidBridgePath = fileURLToPath(new URL("./src/web/mermaid-renderer.ts", import.meta.url));
const mermaidHtmlPath = fileURLToPath(new URL("./src/web/mermaid-renderer.html", import.meta.url));

/**
 * Build one classic script for the renderer iframe.
 *
 * The iframe intentionally has an opaque origin (`sandbox="allow-scripts"`). Browsers apply
 * CORS to module scripts before evaluating them there, so a normal Vite module entry cannot
 * run. Mermaid publishes a self-contained classic build; appending our import-free bridge to
 * it keeps the renderer isolated without relaxing the sandbox to `allow-same-origin`.
 */
function classicMermaidRenderer(): Plugin {
  let sourcePromise: Promise<string> | undefined;
  const bundle = () => sourcePromise ??= Promise.all([
    readFile(mermaidBundlePath, "utf8"),
    readFile(mermaidBridgePath, "utf8"),
  ]).then(([mermaidSource, bridgeSource]) => {
    const result = ts.transpileModule(bridgeSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.None,
        removeComments: true,
      },
      fileName: mermaidBridgePath,
      reportDiagnostics: true,
    });
    const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) {
      throw new Error(ts.formatDiagnostics(errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }));
    }
    return `${mermaidSource}\n${result.outputText}`;
  });

  const scriptTag = `<script nonce="${MERMAID_RENDERER_NONCE}" defer src="/${MERMAID_RENDERER_ASSET}"></script>`;
  const rendererHtml = async () => {
    const html = await readFile(mermaidHtmlPath, "utf8");
    if (!html.includes(MERMAID_RENDERER_MARKER)) {
      throw new Error("Mermaid renderer HTML is missing its classic-script marker");
    }
    return html.replace(MERMAID_RENDERER_MARKER, scriptTag);
  };
  return {
    name: "mission-control:classic-mermaid-renderer",
    enforce: "post",
    configureServer(server) {
      // Serve this document before Vite's HTML transform. The dev client injects inline and
      // networked module scripts ahead of author metadata, which would violate this page's
      // CSP ordering and no-network contract even though the dashboard needs those scripts.
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/mermaid-renderer.html") {
          next();
          return;
        }
        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache");
          response.end(await rendererHtml());
        } catch (error) {
          next(error as Error);
        }
      });
      server.middlewares.use(`/${MERMAID_RENDERER_ASSET}`, async (_request, response, next) => {
        try {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache");
          response.end(await bundle());
        } catch (error) {
          next(error as Error);
        }
      });
      server.watcher.on("change", (path) => {
        if (path === mermaidBridgePath || path === mermaidBundlePath) sourcePromise = undefined;
      });
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!context.filename.endsWith("mermaid-renderer.html")) return html;
        if (!html.includes(MERMAID_RENDERER_MARKER)) {
          throw new Error("Mermaid renderer HTML is missing its classic-script marker");
        }
        return html.replace(MERMAID_RENDERER_MARKER, scriptTag);
      },
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: MERMAID_RENDERER_ASSET,
        source: await bundle(),
      });
    },
  };
}

// The web app lives in src/web and is built into dist/web, which the daemon
// serves in production. In dev, Vite serves it on 5173 and proxies API + SSE
// traffic to the daemon so there is a single origin from the browser's view.
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  plugins: [react(), quietDaemonProxyErrors, classicMermaidRenderer()],
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
    manifest: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("./src/web/index.html", import.meta.url)),
        "mermaid-renderer": fileURLToPath(new URL("./src/web/mermaid-renderer.html", import.meta.url)),
      },
    },
  },
});
