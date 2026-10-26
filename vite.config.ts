import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Strict CSP, injected only into the production build (the dev server needs
// inline HMR helpers). There are no inline scripts or styles in the build.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self' wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'unanimous-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
        );
      },
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [cspPlugin()],
  build: {
    target: ['es2020', 'safari16', 'chrome107', 'firefox104', 'edge107'],
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
