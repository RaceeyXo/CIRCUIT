import { resolve } from "node:path";

import { defineConfig } from "vite";

// Two pages: the landing page (index.html) and the live console (app.html).
// Relative base so the build works from any static host path (e.g. GitHub Pages /CIRCUIT/).
// Empty PostCSS config: never inherit a PostCSS/Tailwind config from a parent directory.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: { input: { index: resolve(__dirname, "index.html"), app: resolve(__dirname, "app.html") } },
  },
  css: { postcss: { plugins: [] } },
});
