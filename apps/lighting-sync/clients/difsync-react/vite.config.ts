import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Electron/WebView need relative assets; Vercel web deploy needs root assets.
  base: mode === "web" ? "/" : "./",
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
}));
