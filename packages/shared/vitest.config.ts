import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/quality/**', 'src/ballistics/**', 'src/intent/**', 'src/kinematics/**', 'src/physics/**'],
    },
  },
});
