// Fixed build.mjs: Externalized @bitauth/libauth to avoid top-level await bundle error; no watch
import esbuild from 'esbuild';
import copy from 'esbuild-plugin-copy';
import { sassPlugin } from 'esbuild-sass-plugin';

const isProd = process.argv[2] === 'prod';

esbuild.build({
  entryPoints: [
    'extension/background.js',
    'extension/content-script.js',
    'extension/nostr-provider.js',
    'extension/options.jsx',
    'extension/popup.jsx',
    'extension/prompt.jsx',
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
    'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
  },
  external: ['child_process', 'fs', 'path', 'crypto', 'events', '@bitauth/libauth'],
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: isProd,
  sourcemap: !isProd,
  treeShaking: true,
  metafile: true,
}).catch(() => process.exit(1));