// build.js (updated)
const esbuild = require('esbuild')
const { sassPlugin } = require('esbuild-sass-plugin')
const { copy } = require('esbuild-plugin-copy')
const { argv } = process
const isDev = argv[2] !== 'prod'

const baseConfig = {
  entryPoints: [
    'extension/background.js',
    'extension/content-script.js',
    'extension/nostr-provider.js',
    'extension/popup.jsx',
    'extension/options.jsx',
    'extension/prompt.jsx',
    'extension/manifest.json',
    'extension/styles.css'
  ],
  bundle: true,
  minify: !isDev,
  sourcemap: isDev,
  target: ['chrome100', 'es2022'], // Ensure ES2022+ for top-level await support
  outdir: 'extension/dist',
  format: 'esm', // Key fix: Use ESM format to support top-level await
  platform: 'browser', // Explicitly set for browser env
  loader: {
    '.js': 'jsx',
    '.png': 'file',
    '.svg': 'file',
    '.json': 'copy',
    '.html': 'copy'
  },
  plugins: [
    sassPlugin(),
    copy({
      assets: [
        { from: './extension/icons/**/*', to: './icons' },
        { from: './extension/*.html', to: './' }
      ]
    })
  ],
  allowOverwrite: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
    global: 'window',
  },
  resolveExtensions: ['.js', '.jsx'],
  external: ['browser'],
}

if (isDev) {
  esbuild.context(baseConfig).then(ctx => ctx.watch())
} else {
  esbuild.build(baseConfig)
}
