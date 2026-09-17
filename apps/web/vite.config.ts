import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist", assetsDir: "." },
  worker: { rollupOptions: { output: { entryFileNames: "[name]-[hash].js", chunkFileNames: "[name]-[hash].js" } } },
});
