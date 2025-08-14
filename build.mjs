// Updated build.mjs: Added treeShaking: true for smaller bundles; externalized more Node builtins if needed; ensured JSX loader for all; added metafile: true for bundle analysis (check dist/esbuild-metafile.json after build for issues)
import esbuild from 'esbuild';
import copy from 'esbuild-plugin-copy';
import { sassPlugin } from 'esbuild-sass-plugin';
import { polyfillNode } from 'esbuild-plugin-polyfill-node';

esbuild.build({
  entryPoints: [
    'extension/background.js',
    'extension/content-script.js',
    'extension/nostr-provider.js',
    'extension/options.jsx',
    'extension/popup.jsx',
    'extension/prompt.jsx',
    // Add 'extension/styles.css' if it's a standalone CSS entry, otherwise if imported, it's fine
  ],
  bundle: true,
  outdir: 'dist',
  loader: {
    '.js': 'jsx',
    '.jsx': 'jsx',
    '.css': 'css',
  },
  plugins: [
    sassPlugin(),
    polyfillNode({
      polyfills: {
        crypto: true
      },
      globals: {
        buffer: false,
        process: false
      }
    }),
    copy({
      assets: [
        { from: ['./extension/manifest.json'], to: ['.'] },
        { from: ['./extension/icons/*'], to: ['icons'] },
        { from: ['./extension/*.html'], to: ['.'] },
        { from: ['./extension/*.css'], to: ['.'] }
      ]
    }),
  ],
  define: {
    'process.env.NODE_ENV': '"development"', // Or 'production' based on mode
  },
  external: ['child_process', 'fs', 'path', 'crypto', 'events'], // Externalize more if causing issues (browser provides some)
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: false, // Already set for dev
  sourcemap: true, // Already set
  treeShaking: true, // New: Reduce bundle size by removing unused code
  metafile: true, // New: Output dist/metafile.json for analyzing bundle (e.g., why huge)
}).catch(() => process.exit(1));