import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Tauri expects a fixed dev port and drives its own reload cycle.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Never watch the Rust build tree — cargo creates thousands of files
      // during `tauri dev` and exhausts inotify watches (ENOSPC).
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 800,
  },
});
