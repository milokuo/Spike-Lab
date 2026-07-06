import { defineConfig } from 'vite';

// Dev server binds 0.0.0.0:5173 so LAN peers can join (see docs/m2_plan.md §7).
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
