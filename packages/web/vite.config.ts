import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.QM_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/ws": { target: api.replace(/^http/, "ws"), ws: true, changeOrigin: true },
    },
  },
});
