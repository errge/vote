import { defineConfig } from 'vitest/config';

// Live tests against the real public relays (network required, not run in CI):
//   npm run test:live
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
