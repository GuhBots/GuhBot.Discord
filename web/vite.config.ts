import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the website into build/web, which the bot's web listener serves.
// Asset links are relative: the server adds a <base> tag for the path the
// website lives under, such as /archivist, so one build works anywhere.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../build/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
