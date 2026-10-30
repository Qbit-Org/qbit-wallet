/**
 * Mobile web bundle. Reuses the extension's webpack config (loaders, aliases,
 * WASM handling, defines) and swaps the entry points, the HTML pages and the
 * output folder.
 *
 * The extension config resolves its paths from the working directory, so this
 * must run with apps/extension as the cwd. `pnpm build:web` does that.
 */
const fs = require('fs');
const path = require('path');

const extensionDir = path.resolve(__dirname, '../extension');
if (fs.realpathSync(process.cwd()) !== fs.realpathSync(extensionDir)) {
  throw new Error('Run the mobile webpack build from apps/extension (use `pnpm build:web` in apps/mobile).');
}

const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const ESLintWebpackPlugin = require('eslint-webpack-plugin');
const { merge } = require('webpack-merge');

const commonConfig = require('../extension/build/webpack.common.config');
const modeConfigs = {
  dev: require('../extension/build/webpack.dev.config'),
  pro: require('../extension/build/webpack.pro.config')
};

const mobileSrc = path.resolve(__dirname, 'src');
const outputDir = path.resolve(__dirname, 'www');

/** Lets babel-loader compile apps/mobile/src alongside the extension sources. */
function includeMobileSources(rules, appSrc) {
  for (const rule of rules) {
    if (!rule) continue;
    if (Array.isArray(rule.oneOf)) includeMobileSources(rule.oneOf, appSrc);
    if (rule.include === appSrc) rule.include = [appSrc, mobileSrc];
  }
}

module.exports = (env = {}) => {
  const mode = env.config === 'dev' ? 'dev' : 'pro';
  process.env.NODE_ENV = mode === 'dev' ? 'development' : 'production';
  process.env.BABEL_ENV = process.env.NODE_ENV;
  process.env.TAILWIND_MODE = mode === 'dev' ? 'watch' : 'build';

  const base = commonConfig({ ...env, browser: 'mobile', manifest: 'mv3', channel: env.channel || 'mobile' });
  includeMobileSources(base.module.rules, path.resolve(extensionDir, 'src'));

  base.entry = { mobile: path.join(mobileSrc, 'index.ts') };
  base.output = { ...base.output, path: outputDir, clean: true };
  // Extension pages and the extension lint pass are not part of the app bundle.
  base.plugins = base.plugins.filter(
    (plugin) => !(plugin instanceof HtmlWebpackPlugin) && !(plugin instanceof ESLintWebpackPlugin)
  );
  base.resolve.modules = [...base.resolve.modules, path.resolve(__dirname, 'node_modules')];

  const pages = ['index.html', 'sidepanel.html'].map(
    (filename) =>
      new HtmlWebpackPlugin({
        inject: true,
        template: path.join(mobileSrc, 'index.html'),
        chunks: ['mobile'],
        filename
      })
  );

  const modeConfig = { ...modeConfigs[mode] };
  // Development builds must not use eval-based source maps: the app CSP
  // forbids eval, and watch mode is driven by `pnpm dev:web` instead.
  if (mode === 'dev') {
    modeConfig.devtool = 'cheap-module-source-map';
    modeConfig.watch = Boolean(env.watch);
  }

  return merge(base, modeConfig, {
    plugins: [
      ...pages,
      new CopyWebpackPlugin({
        patterns: [
          { from: path.join(extensionDir, 'build/_raw/theme-init.js'), to: 'theme-init.js' },
          { from: path.join(extensionDir, 'build/_raw/images'), to: 'images' },
          { from: path.join(mobileSrc, 'mobile.css'), to: 'mobile.css' }
        ]
      })
    ]
  });
};
