import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = Number(process.env.OBSERVATORY_PORT ?? 4317);
const webPort = Number(process.env.OBSERVATORY_WEB_PORT ?? 4318);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/ws": {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
    },
  },
  preview: {
    port: webPort,
    strictPort: true,
  },
});
