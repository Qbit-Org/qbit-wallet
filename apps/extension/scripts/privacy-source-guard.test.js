/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { formatPrivacyViolations, getProductionSourceRoots, scanPrivacySources } = require('./privacy-source-guard');

const repoRoot = path.resolve(__dirname, '../../..');

test('production source contains no forbidden privacy or remote-policy dependencies', () => {
  const violations = scanPrivacySources(getProductionSourceRoots(repoRoot));

  assert.equal(
    violations.length,
    0,
    `Forbidden privacy or remote-policy dependency found:\n${formatPrivacyViolations(violations, repoRoot)}`
  );
});

test('privacy guard detects a nested mixed-case seeded violation', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-privacy-guard-'));
  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

  const nestedDir = path.join(fixtureRoot, 'nested');
  const fixtureFile = path.join(nestedDir, 'violation.ts');
  fs.mkdirSync(nestedDir);
  fs.writeFileSync(fixtureFile, "const headers = { 'X-uDiD2': 'seeded-violation' };\n");

  const violations = scanPrivacySources([fixtureRoot]);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    file: fixtureFile,
    line: 1,
    column: 20,
    rule: 'telemetry-header',
    token: 'X-uDiD2'
  });
  assert.match(formatPrivacyViolations(violations, fixtureRoot), /^nested\/violation\.ts:1:20 /);
});

test('privacy guard covers every forbidden identifier family', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-privacy-vocabulary-'));
  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

  const fixtureFile = path.join(fixtureRoot, 'identifiers.tsx');
  fs.writeFileSync(
    fixtureFile,
    [
      "'X-AdDrEsS'",
      "'x-ChAnNeL'",
      "'X-cLiEnT'",
      "'x-UdId'",
      "'X-uDiD2'",
      "'x-VeRsIoN'",
      "'deviceId'",
      "'device_uuid'",
      "'preloadDeviceUUID'",
      "'uDiD'"
    ].join('\n')
  );

  const violations = scanPrivacySources([fixtureRoot]);
  assert.deepEqual(
    violations.map(({ rule, token }) => ({ rule, token })),
    [
      { rule: 'telemetry-header', token: 'X-AdDrEsS' },
      { rule: 'telemetry-header', token: 'x-ChAnNeL' },
      { rule: 'telemetry-header', token: 'X-cLiEnT' },
      { rule: 'telemetry-header', token: 'x-UdId' },
      { rule: 'telemetry-header', token: 'X-uDiD2' },
      { rule: 'telemetry-header', token: 'x-VeRsIoN' },
      { rule: 'generated-device-id', token: 'deviceId' },
      { rule: 'generated-device-id', token: 'device_uuid' },
      { rule: 'generated-device-id', token: 'DeviceUUID' },
      { rule: 'device-identifier', token: 'uDiD' }
    ]
  );
});

test('privacy guard covers wallet service routes and remote phishing dependencies', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qbit-privacy-network-vocabulary-'));
  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

  const fixtureFile = path.join(fixtureRoot, 'network.ts');
  fs.writeFileSync(
    fixtureFile,
    [
      "'/v5/default/check-website'",
      "'/v5/default/config'",
      "'/v5/version/detail'",
      "'/v5/announcement/list'",
      "'/v5/notification/list'",
      "'/v5/notification/read'",
      "'/v5/notification/read-all'",
      "'raw.githubusercontent.com'",
      "'cdn.jsdelivr.net'",
      "'metamask.github.io'",
      "'/v5/phishing-detect/hotlist'",
      'session.icon'
    ].join('\n')
  );

  const violations = scanPrivacySources([fixtureRoot]);
  assert.deepEqual(
    violations.map(({ rule, token }) => ({ rule, token })),
    [
      { rule: 'wallet-service-route', token: '/v5/default/check-website' },
      { rule: 'wallet-service-route', token: '/v5/default/config' },
      { rule: 'remote-wallet-content-route', token: '/v5/version/detail' },
      { rule: 'remote-wallet-content-route', token: '/v5/announcement/list' },
      { rule: 'remote-wallet-content-route', token: '/v5/notification/list' },
      { rule: 'remote-wallet-content-route', token: '/v5/notification/read' },
      { rule: 'remote-wallet-content-route', token: '/v5/notification/read-all' },
      { rule: 'remote-phishing-host', token: 'raw.githubusercontent.com' },
      { rule: 'remote-phishing-host', token: 'cdn.jsdelivr.net' },
      { rule: 'remote-phishing-host', token: 'metamask.github.io' },
      { rule: 'remote-phishing-path', token: '/v5/phishing-detect/hotlist' },
      { rule: 'remote-session-icon', token: 'session.icon' }
    ]
  );
});

test('content script does not observe page fetch or XHR failures', () => {
  const entrypoint = fs.readFileSync(path.join(repoRoot, 'apps/extension/src/content-script/index.ts'), 'utf8');

  assert.doesNotMatch(entrypoint, /monitoring\/network|setupNetworkMonitoring|REPORT_NETWORK_ERROR/);
});
