import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Public base path. Defaults to '/' for the self-hosted server build.
// The GitHub Pages demo workflow overrides this to './' so every asset
// URL is page-relative — that way the demo works under any sub-path
// (e.g. https://<user>.github.io/<repo>/) without rebuilding, and it
// also dodges vite-plugin-cesium's behaviour of duplicating an absolute
// base into the output directory tree.
const base = process.env.VITE_BASE || '/';

// vite-plugin-cesium injects <link href="cesium/..."> and
// <script src="cesium/..."> into EVERY HTML entry with the same
// root-relative path, ignoring the entry's location. The mobile entry
// lives at /m/index.html, so those relative paths would resolve to
// /m/cesium/... and 404. This post plugin rewrites them to '../cesium/...'
// for the mobile entry only, so both entries share a single dist/cesium/
// directory without duplication.
function mobileCesiumRewrite() {
  return {
    name: 'mobile-cesium-rewrite',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const path = ctx.path || ctx.filename || '';
        const isMobileEntry = path.includes('/m/') || path.endsWith('m/index.html');
        if (!isMobileEntry) return html;
        return html
          .replace(/(href|src)="cesium\//g, '$1="../cesium/');
      },
    },
  };
}

export default defineConfig({
  base,
  plugins: [cesium(), mobileCesiumRewrite()],
  server: {
    open: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    target: 'esnext',
    minify: 'esbuild',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        mobile: resolve(__dirname, 'm/index.html'),
      },
    },
  },
});
