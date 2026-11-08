import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // avr8js + React Flow in one chunk is ~600 kB; splitting comes with the worker (M1).
  build: { chunkSizeWarningLimit: 1000 },
});
