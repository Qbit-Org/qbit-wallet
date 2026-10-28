/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function loadHttpClient() {
  const file = path.resolve(__dirname, '../src/background/utils/http-client/httpClient.ts');
  const source = fs.readFileSync(file, 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    },
    fileName: file
  }).outputText;
  const loadedModule = { exports: {} };

  const requireDependency = (specifier) => {
    if (specifier === '@qbit/wallet-background') {
      return { preferenceService: { getChainType: () => 'test' } };
    }
    if (specifier === '@qbit/wallet-shared') {
      return {
        CHAINS_MAP: { test: { endpoints: ['https://api.example.test/api'] } },
        normalizeChainType: (chainType) => chainType
      };
    }
    if (specifier === './errors') {
      class RequestError extends Error {}
      return {
        ApiClientError: RequestError,
        HttpError: RequestError,
        NetworkError: RequestError,
        ParseError: RequestError,
        RateLimitError: RequestError,
        ServiceUnavailableError: RequestError,
        TimeoutError: RequestError,
        getRetryDelay: () => 0,
        isRetryableError: () => false
      };
    }
    throw new Error(`Unexpected dependency: ${specifier}`);
  };

  const execute = new Function('exports', 'require', 'module', '__filename', '__dirname', javascript);
  execute(loadedModule.exports, requireDependency, loadedModule, file, path.dirname(file));
  return loadedModule.exports.HttpClient;
}

test('HttpClient omits identifying defaults and preserves setHeaders behavior', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(init);
    return {
      headers: { get: () => null },
      json: async () => ({ ok: true }),
      ok: true,
      status: 200,
      statusText: 'OK'
    };
  };

  const HttpClient = loadHttpClient();
  const defaultClient = new HttpClient();
  await defaultClient.get('/default');

  assert.deepEqual(requests[0].headers, { 'Content-Type': 'application/json' });

  const configuredClient = new HttpClient({
    apiKey: 'explicit-api-key',
    headers: { 'X-Caller': 'configured' },
    userAgent: 'Explicit Caller/2.0'
  });
  configuredClient.setHeaders({ 'X-Stale': 'first' });
  await configuredClient.get('/first');

  configuredClient.setHeaders({ 'X-Current': 'second' });
  await configuredClient.get('/second', { headers: { 'X-Caller': 'request' } });

  assert.deepEqual(requests[1].headers, {
    'Content-Type': 'application/json',
    'User-Agent': 'Explicit Caller/2.0',
    'X-Caller': 'configured',
    Authorization: 'Bearer explicit-api-key',
    'X-Stale': 'first'
  });
  assert.deepEqual(requests[2].headers, {
    'Content-Type': 'application/json',
    'User-Agent': 'Explicit Caller/2.0',
    'X-Caller': 'request',
    Authorization: 'Bearer explicit-api-key',
    'X-Stale': 'first',
    'X-Current': 'second'
  });

  await assert.rejects(
    defaultClient.get('https://tracker.example/collect'),
    /must stay within the configured chain endpoint/
  );
  await assert.rejects(defaultClient.get('../outside'), /must stay within the configured chain endpoint/);
  assert.equal(requests.length, 3, 'rejected paths must not reach fetch');
});
