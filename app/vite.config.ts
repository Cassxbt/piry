import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // The app reads ../deployments/<network>.json directly, which sits outside this package.
  server: { port: 5173, host: "127.0.0.1", fs: { allow: [".."] } },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable vendor chunks cache across deploys; the app chunk stays small.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (/node_modules\/(viem|ox|abitype|@noble|@scure)\//.test(id)) return "viem";
          if (/node_modules\/(wagmi|@wagmi|@tanstack)\//.test(id)) return "wagmi";
          return undefined;
        },
      },
    },
  },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"], css: false },
});
