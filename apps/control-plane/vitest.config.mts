import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app's tsconfig sets jsx: "preserve" because Next.js compiles the JSX
  // itself. Vitest has no such downstream step, so a test that imports a
  // component file would be handed JSX it cannot parse. Transform it here,
  // and only here: the build keeps preserving.
  oxc: { jsx: { runtime: 'automatic' } },
});
