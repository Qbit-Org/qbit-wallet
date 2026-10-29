var webpack = require('webpack');
var webpackConfigFunc = require('./webpack.config');
var gulp = require('gulp');
var zip = require('gulp-zip');
var clean = require('gulp-clean');
var jsoncombine = require('gulp-jsoncombine');
var minimist = require('minimist');
var path = require('path');
var packageConfig = require('./package.json');
var { getPackageArtifactName, removePackageArtifact } = require('./scripts/package-artifact-cleanup');
var { mergeExtensionManifest } = require('./scripts/manifest-build-flavors');
var {
  FIXED_ARCHIVE_MTIME,
  createDeterministicArchiveInput,
  writeArtifactManifests
} = require('./scripts/deterministic-package');
var createWebpackGulpCallback = require('./scripts/webpack-gulp-callback');
const { exit } = require('process');
const uglify = require('gulp-uglify');

//parse arguments
var knownOptions = {
  string: ['env', 'browser', 'manifest', 'channel', 'artifact-version'],
  default: {
    env: 'dev',
    browser: 'chrome',
    manifest: 'mv3',
    channel: 'store'
  }
};

var supported_envs = ['dev', 'pro'];
var supported_browsers = ['chrome', 'firefox', 'edge', 'brave'];
var supported_mvs = ['mv2', 'mv3'];
var supported_channels = ['store', 'github', 'e2e'];
var brandName = 'qbit';
var version = packageConfig.version;
var validVersion = version.split('-beta')[0];
var options = {
  env: knownOptions.default.env,
  browser: knownOptions.default.browser,
  manifest: knownOptions.default.manifest
};
options = minimist(process.argv.slice(2), knownOptions);
var artifactVersion = options['artifact-version'] || version;
if (!supported_envs.includes(options.env)) {
  console.error(`not supported env: [${options.env}]. It should be one of ${supported_envs.join(', ')}.`);
  exit(1);
}
if (!supported_browsers.includes(options.browser)) {
  console.error(`not supported browser: [${options.browser}]. It should be one of ${supported_browsers.join(', ')}.`);
  exit(1);
}
if (!supported_mvs.includes(options.manifest)) {
  console.error(`not supported manifest: [${options.manifest}]. It should be one of ${supported_mvs.join(', ')}.`);
  exit(1);
}
if (!supported_channels.includes(options.channel)) {
  console.error(`not supported channel: [${options.channel}]. It should be one of ${supported_channels.join(', ')}.`);
  exit(1);
}
if (artifactVersion !== validVersion && !artifactVersion.startsWith(`${validVersion}-`)) {
  console.error(
    `invalid artifact-version: [${artifactVersion}]. It should match ${validVersion} or start with ${validVersion}- .`
  );
  exit(1);
}

//tasks...
function getArtifactName() {
  return getPackageArtifactName({
    brandName,
    browser: options.browser,
    manifest: options.manifest,
    artifactVersion,
    channel: options.channel
  });
}

function task_clean() {
  if (options.env == 'pro') {
    removePackageArtifact(path.join(__dirname, 'dist', getArtifactName()));
  }
  return gulp.src(`dist/${options.browser}/*`, { read: false }).pipe(clean());
}

// Gulp 5 decodes file contents as UTF-8 unless `encoding: false` is set, which
// corrupts images, fonts and WebAssembly. Tasks that copy files read raw bytes.
function task_prepare() {
  return gulp.src('build/_raw/**/*', { encoding: false }).pipe(gulp.dest(`dist/${options.browser}`));
}

function task_merge_manifest() {
  let baseFile = '_base_v3';
  if (options.manifest == 'mv2') {
    baseFile = '_base_v2';
  }
  return gulp
    .src([
      `dist/${options.browser}/manifest/${baseFile}.json`,
      `dist/${options.browser}/manifest/${options.browser}.json`
    ])
    .pipe(
      jsoncombine('manifest.json', (data) => {
        const result = mergeExtensionManifest({
          baseManifest: data[baseFile],
          browserManifest: data[options.browser],
          version: validVersion,
          channel: options.channel
        });
        return Buffer.from(JSON.stringify(result));
      })
    )
    .pipe(gulp.dest(`dist/${options.browser}`));
}

function task_clean_tmps() {
  return gulp.src(`dist/${options.browser}/manifest`, { read: false }).pipe(clean());
}

function task_webpack(cb) {
  webpack(
    webpackConfigFunc({
      version: validVersion,
      config: options.env,
      browser: options.browser,
      manifest: options.manifest,
      channel: options.channel
    }),
    createWebpackGulpCallback(cb)
  );
}

function task_uglify(cb) {
  if (options.env == 'pro') {
    return gulp
      .src(`dist/${options.browser}/**/*.js`)
      .pipe(uglify())
      .pipe(gulp.dest(`dist/${options.browser}`));
  }
  cb();
}

function task_package(cb) {
  if (options.env == 'pro') {
    return gulp
      .src(`dist/${options.browser}/**/*`, { dot: true, nodir: true, encoding: false })
      .pipe(createDeterministicArchiveInput())
      .pipe(zip(getArtifactName(), { modifiedTime: FIXED_ARCHIVE_MTIME }))
      .pipe(gulp.dest('./dist'));
  }
  cb();
}

function task_write_package_manifests(cb) {
  if (options.env == 'pro') {
    writeArtifactManifests(
      path.join(__dirname, 'dist', getArtifactName()),
      path.join(__dirname, 'dist', options.browser)
    );
  }
  cb();
}

exports.build = gulp.series(
  task_clean,
  task_prepare,
  task_merge_manifest,
  task_clean_tmps,
  task_webpack,
  task_uglify,
  task_package,
  task_write_package_manifests
);
