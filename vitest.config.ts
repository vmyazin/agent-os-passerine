import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The control-plane's tsconfig preserves JSX for Next.js to compile. A test
  // has no such downstream step, so a component file it imports has to be
  // transformed here instead of arriving as unparseable JSX.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['**/src/**/*.test.ts'],
  },
});
