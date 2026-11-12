import { defineConfig } from "vite";

// Relative base so the build works from any static host path (e.g. GitHub Pages /CIRCUIT/).
// Empty PostCSS config: never inherit a PostCSS/Tailwind config from a parent directory.
export default defineConfig({ base: "./", build: { target: "es2022" }, css: { postcss: { plugins: [] } } });
