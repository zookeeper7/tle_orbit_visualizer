import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

// Public base path. Defaults to '/' for the self-hosted server build.
// The GitHub Pages demo workflow overrides this to './' so every asset
// URL is page-relative — that way the demo works under any sub-path
// (e.g. https://<user>.github.io/<repo>/) without rebuilding, and it
// also dodges vite-plugin-cesium's behaviour of duplicating an absolute
// base into the output directory tree.
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  plugins: [cesium()],
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
  },
});
