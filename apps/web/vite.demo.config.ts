import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve(import.meta.dirname, "demo"),
  base: "/voice-action-lab/",
  publicDir: false,
  plugins: [react(), {
    name: "isolate-public-demo",
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const path = id.replaceAll("\\", "/");
        if (path.includes("/apps/server/") || path.includes("/packages/experiments/")
          || /\/apps\/web\/src\/(?!LabPanels\.tsx(?:\?|$)|styles\.css(?:\?|$))/.test(path)) {
          this.error(`Private application module entered the public demo: ${path}`);
        }
      }
    },
  }],
  build: {
    outDir: resolve(import.meta.dirname, "dist", "demo"),
    emptyOutDir: true,
    assetsDir: "static",
    sourcemap: false,
    modulePreload: false,
  },
  preview: { host: "127.0.0.1", port: 5176, strictPort: true },
});
