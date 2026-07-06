import { defineConfig } from 'vitest/config';

// Client unit tests run as pure Node math (no WebGL/DOM): the camera-basis
// regression test only uses three.js math (PerspectiveCamera + projection) and
// the shared view-space transform. Kept out of the `src` tsconfig so it never
// affects the vite build or `tsc --noEmit` typecheck.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
