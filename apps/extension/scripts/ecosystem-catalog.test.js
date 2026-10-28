/* eslint-env node */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');
const repositoryDir = path.resolve(extensionDir, '../..');
const discoverSource = fs.readFileSync(path.join(extensionDir, 'src/ui/pages/Main/DiscoverTabScreen.tsx'), 'utf8');
const navigationSource = fs.readFileSync(path.join(extensionDir, 'src/ui/pages/Main/ecosystemNavigation.ts'), 'utf8');
const catalogSource = fs.readFileSync(
  path.join(repositoryDir, 'packages/wallet-shared/src/constants/ecosystem.ts'),
  'utf8'
);
const mainRouteSource = fs.readFileSync(path.join(extensionDir, 'src/ui/pages/MainRoute.tsx'), 'utf8');
const navTabBarSource = fs.readFileSync(path.join(extensionDir, 'src/ui/components/NavTabBar/index.tsx'), 'utf8');
const warningModalSource = fs.readFileSync(
  path.join(extensionDir, 'src/ui/pages/Main/EcosystemWarningModal.tsx'),
  'utf8'
);
const ecosystemButtonSource = discoverSource.slice(
  discoverSource.indexOf('function EcosystemAppButton'),
  discoverSource.indexOf('export default function DiscoverTabScreen')
);

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (['build', 'dist', 'lib', 'node_modules'].includes(entry.name)) {
        return [];
      }
      return listSourceFiles(entryPath);
    }
    return /\.(?:cjs|js|jsx|json|mjs|ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function listWorkspaceSourceRoots(collectionDirectory) {
  return fs.readdirSync(collectionDirectory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }

    const sourceDirectory = path.join(collectionDirectory, entry.name, 'src');
    return fs.existsSync(sourceDirectory) ? [sourceDirectory] : [];
  });
}

test('Discover renders the local catalog with chain and community context', () => {
  assert.match(discoverSource, /getEcosystemEntriesForChain\(chainType\)/);
  assert.match(discoverSource, /ecosystemEntries\.map/);
  assert.match(discoverSource, /ecosystem-empty-state/);
  assert.match(ecosystemButtonSource, /boxSizing: ['"]border-box['"]/);
  assert.doesNotMatch(discoverSource, /useWallet|window\.open|getAppList|getAppExtra|getBannerList/);
  assert.doesNotMatch(discoverSource, /Carousel|SearchBar/);
});

test('the community warning lives only in the acknowledgement modal', () => {
  assert.match(warningModalSource, /t\('ecosystem_community_warning'\)/);
  assert.match(warningModalSource, /ECOSYSTEM_WARNING_ACK_STORAGE_KEY/);
  assert.match(discoverSource, /EcosystemWarningModal/);
  assert.match(discoverSource, /readEcosystemWarningAcknowledged/);
  // The screen body must not duplicate the warning copy.
  assert.doesNotMatch(discoverSource, /ecosystem_community_warning/);
});

test('the opener accepts an entry ID and creates an isolated browser tab', () => {
  assert.match(navigationSource, /entryId: EcosystemEntryId/);
  assert.match(navigationSource, /getEcosystemNavigationUrl\(entryId\)/);
  assert.match(navigationSource, /openTab\(\{ url, active: true \}\)/);
  assert.doesNotMatch(navigationSource, /window\.open|openerTabId/);
});

test('the app route redirects to the local Discover catalog', () => {
  assert.match(mainRouteSource, /AppTabScreen:\s*\{[\s\S]*?path: ['"]\/app['"]/);
  assert.match(mainRouteSource, /<Navigate to=['"]\/discover['"] replace \/>/);
  assert.equal(fs.existsSync(path.join(extensionDir, 'src/ui/pages/Main/AppTabScreen.tsx')), false);
});

test('Discover navigation has no remote-feed badge', () => {
  assert.doesNotMatch(navTabBarSource, /useHasNewBanner|\bhasNewBanner\b/);
});

test('every purpose-specific ecosystem image is bundled locally', () => {
  const assets = {
    'build/_raw/images/ecosystem/qbit-testnet-faucet.svg':
      '5b6e41dd6dddc82534c398d8edf1fd8821054db8575e8fe2b6a5f75b4fba6b3a',
    'build/_raw/images/ecosystem/prism-testnet-pool.svg':
      '4af9841e1a6601352737e192b05fa4c55fabba025c9d7a4a37acca4440b1f8f9',
    'build/_raw/images/ecosystem/qbit-block-visualizer.svg':
      '9132b1702bcaebbafb2eecf0127e1ab71c03bb614d6161c91e9b2fad4048314d',
    'build/_raw/images/ecosystem/qbit-rich-list.svg':
      '99d157572ae534c252f4e787717627fa85f60674c2ff0725e6ebad509133125e'
  };

  for (const [asset, expectedSha256] of Object.entries(assets)) {
    const source = fs.readFileSync(path.join(extensionDir, asset), 'utf8');
    const actualSha256 = crypto.createHash('sha256').update(source).digest('hex');

    assert.equal(actualSha256, expectedSha256, `${asset} changed without an integrity review`);
    assert.match(source, /<svg\b/);
    const elementNames = [...source.matchAll(/<\s*\/?\s*([a-z][\w:-]*)/gi)].map((match) => match[1]);
    assert.ok(elementNames.every((elementName) => ['circle', 'g', 'path', 'rect', 'svg'].includes(elementName)));
    assert.doesNotMatch(source, /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i);
    assert.doesNotMatch(source, /\bon[a-z]+\s*=/i);
    assert.doesNotMatch(source, /\b(?:href|src|style|xlink:href)\s*=/i);
    assert.doesNotMatch(source, /@import|\burl\s*\(/i);
  }

  assert.match(discoverSource, /\/images\/ecosystem\/qbit-testnet-faucet\.svg/);
  assert.match(discoverSource, /\/images\/ecosystem\/prism-testnet-pool\.svg/);
  assert.match(discoverSource, /\/images\/ecosystem\/qbit-block-visualizer\.svg/);
  assert.match(discoverSource, /\/images\/ecosystem\/qbit-rich-list\.svg/);
  assert.doesNotMatch(catalogSource, /logoUrl|imageUrl|artworkUrl/);
});

test('all shipped app and package source contains no remote discovery or app-summary endpoints', () => {
  const sourceRoots = [
    ...listWorkspaceSourceRoots(path.join(repositoryDir, 'apps')),
    ...listWorkspaceSourceRoots(path.join(repositoryDir, 'packages'))
  ];
  const forbiddenPaths = [
    '/v5/discovery/app-list',
    '/v5/discovery/app-extra',
    '/v5/discovery/banner-list',
    '/v5/default/app-list',
    '/v5/default/banner-list',
    '/v5/default/app-summary-v2'
  ];

  for (const filePath of sourceRoots.flatMap(listSourceFiles)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const forbiddenPath of forbiddenPaths) {
      assert.equal(source.includes(forbiddenPath), false, `${forbiddenPath} remains in ${filePath}`);
    }
  }
});
