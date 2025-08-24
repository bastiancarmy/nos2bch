// Updated build.mjs: Use context for watch mode; bundle libauth; external only Node builtins
import esbuild from 'esbuild';
import copy from 'esbuild-plugin-copy';
import { sassPlugin } from 'esbuild-sass-plugin';

const isProd = process.argv[2] === 'prod';
const isWatch = process.argv[3] === 'watch';

const config = {
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
  external: ['child_process', 'fs', 'path', 'crypto', 'events'],  // Only Node builtins; bundle libauth/noble
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: isProd,
  sourcemap: !isProd,
  treeShaking: true,
  metafile: true,
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(config);
  }
}

main().catch(() => process.exit(1));