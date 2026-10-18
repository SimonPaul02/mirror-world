import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3000, open: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    // Cesium is a single huge ESM bundle; let esbuild pre-bundle it once.
    include: ["cesium"],
  },
});
