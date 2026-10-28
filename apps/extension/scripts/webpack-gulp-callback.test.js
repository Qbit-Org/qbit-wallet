/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const createWebpackGulpCallback = require('./webpack-gulp-callback');

const gulpfileSource = fs.readFileSync(path.resolve(__dirname, '../gulpfile.js'), 'utf8');

test('the Gulp Webpack task uses the fail-closed callback adapter', () => {
  const taskWebpack = gulpfileSource.match(/function task_webpack\(cb\) \{([\s\S]*?)\n\}/);

  assert.ok(taskWebpack, 'task_webpack must remain present');
  assert.match(taskWebpack[1], /createWebpackGulpCallback\(cb\)/);
});

test('passes fatal Webpack errors to Gulp unchanged', () => {
  const fatalError = new Error('configuration failed');
  const calls = [];
  const callback = createWebpackGulpCallback((error) => calls.push(error));

  callback(fatalError);

  assert.deepEqual(calls, [fatalError]);
});

test('fails when Webpack does not return compilation stats', () => {
  const calls = [];
  const callback = createWebpackGulpCallback((error) => calls.push(error));

  callback(null, undefined);

  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /without compilation stats/);
});

test('fails with formatted diagnostics when compilation stats contain errors', () => {
  const calls = [];
  const statsOptions = [];
  const callback = createWebpackGulpCallback((error) => calls.push(error));
  const stats = {
    hasErrors: () => true,
    toString: (options) => {
      statsOptions.push(options);
      return 'ERROR in ./src/background.ts\nModule build failed';
    }
  };

  callback(null, stats);

  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /Webpack compilation failed/);
  assert.match(calls[0].message, /ERROR in \.\/src\/background\.ts/);
  assert.match(calls[0].message, /Module build failed/);
  assert.deepEqual(statsOptions, [
    {
      all: false,
      colors: false,
      errorDetails: true,
      errors: true,
      moduleTrace: true
    }
  ]);
});

test('fails clearly when erroneous stats have no formatted diagnostics', () => {
  const calls = [];
  const callback = createWebpackGulpCallback((error) => calls.push(error));
  const stats = {
    hasErrors: () => true,
    toString: () => '  '
  };

  callback(null, stats);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, 'Webpack compilation failed with no diagnostics.');
});

test('calls Gulp without an error only after a successful compilation', () => {
  const calls = [];
  const stats = {
    hasErrors: () => false,
    toString: () => {
      throw new Error('successful stats should not be formatted');
    }
  };
  const callback = createWebpackGulpCallback((error) => calls.push(error));

  callback(null, stats);

  assert.deepEqual(calls, [undefined]);
});
