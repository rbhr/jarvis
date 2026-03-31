import { defineConfig } from "vite";
import fs from "fs";
import path from "path";

const certDir = path.resolve(__dirname, "..");

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    https: {
      key: fs.readFileSync(path.join(certDir, "key.pem")),
      cert: fs.readFileSync(path.join(certDir, "cert.pem")),
    },
    proxy: {
      "/ws": {
        target: "https://100.108.53.137:8340",
        ws: true,
        secure: false,
      },
      "/api": {
        target: "https://100.108.53.137:8340",
        secure: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
