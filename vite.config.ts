/**
 * \author Toximik
 * Vite config: relative base so the build also works from a GitHub Pages sub path.
 */
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: { host: "localhost", port: 5173 },
});
