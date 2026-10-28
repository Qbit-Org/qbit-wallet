/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');
const contentSource = fs.readFileSync(path.join(extensionDir, 'src/ui/components/Content/index.tsx'), 'utf8');
const iconSource = fs.readFileSync(path.join(extensionDir, 'src/ui/components/Icon/index.tsx'), 'utf8');
const navSource = fs.readFileSync(path.join(extensionDir, 'src/ui/components/NavTabBar/index.tsx'), 'utf8');
const phishingSource = fs.readFileSync(path.join(extensionDir, 'src/ui/pages/Phishing/PhishingScreen.tsx'), 'utf8');
const settingsSource = fs.readFileSync(
  path.join(extensionDir, 'src/ui/pages/Main/SettingsTabScreen/index.tsx'),
  'utf8'
);
const settingsLogicSource = fs.readFileSync(
  path.join(extensionDir, '../../packages/wallet-state/src/ui-hooks/useSettingsTabScreenLogic.ts'),
  'utf8'
);
const sharedConstantsSource = fs.readFileSync(
  path.join(extensionDir, '../../packages/wallet-shared/src/constants/common.ts'),
  'utf8'
);
const qbitWalletIcon = fs.readFileSync(path.join(extensionDir, 'build/_raw/images/icons/tab/qbit-wallet.svg'), 'utf8');

function listSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(entryPath);
    }
    return /\.(?:css|js|json|ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

test('the wallet home tab uses the background-free Qbit Wallet glyph', () => {
  assert.match(iconSource, /qbitWallet: ['"]\/images\/icons\/tab\/qbit-wallet\.svg['"]/);
  assert.match(navSource, /tabName="home"[\s\S]*?icon="qbitWallet"[\s\S]*?iconSize=\{26\.45\}/);
  assert.match(navSource, /iconSize = 20/);
  assert.match(navSource, /<Icon size=\{iconSize\}/);
  assert.doesNotMatch(navSource, /tabName="home" icon="(?!qbitWallet")/);
  assert.match(qbitWalletIcon, /<svg\b/);
  assert.doesNotMatch(qbitWalletIcon, /<(?:rect|image)\b/i);
});

test('shared extension content includes the standard top inset', () => {
  const largePreset = contentSource.slice(contentSource.indexOf('large:'), contentSource.indexOf('middle:'));

  assert.match(largePreset, /padding: spacing\.medium/);
  assert.doesNotMatch(largePreset, /paddingTop:\s*0/);
});

test('settings navigation rows use one even vertical gap', () => {
  assert.match(settingsSource, /<Column fullX style=\{\{ gap: spacing\.extraSmall \}\}>/);
  assert.match(
    settingsSource,
    /renderGroup\(\[\s*settings_connectedSites,\s*settings_switchNetwork,\s*settings_addressBook,\s*settings_addressType,\s*settings_appearance,\s*settings_advanced,\s*settings_lockwallet,\s*settings_aboutus\s*\]\)/
  );
  assert.doesNotMatch(settingsSource, /<Divider|function Divider/);
});

test('settings no longer exposes the Expand View action', () => {
  assert.doesNotMatch(settingsSource, /settings_expandview/);
  assert.doesNotMatch(settingsLogicSource, /settings_expandview|openExtensionInTab/);
});

test('Lock Wallet uses the same navigation-row renderer as the other settings', () => {
  const lockItemSource = settingsLogicSource.slice(
    settingsLogicSource.indexOf('const settings_lockwallet'),
    settingsLogicSource.indexOf('return {\n    settings_connectedSites')
  );

  assert.match(lockItemSource, /label: t\(['"]lock_wallet['"]\)/);
  assert.match(lockItemSource, /icon: ['"]lock['"]/);
  assert.match(lockItemSource, /right: false/);
  assert.doesNotMatch(settingsSource, /renderButtons|<Button/);
});

test('the extension contains no links to the GitHub repository', () => {
  const extensionFiles = [...listSourceFiles(path.join(extensionDir, 'src')), path.join(extensionDir, 'package.json')];
  const repositoryUrl = /github\.com\/Qbit-Org\/qbit-wallet/i;

  for (const filePath of extensionFiles) {
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), repositoryUrl, filePath);
  }

  assert.doesNotMatch(settingsSource, /GITHUB_URL|icon="github"/);
  assert.doesNotMatch(sharedConstantsSource, /GITHUB_URL|github\.com\/Qbit-Org\/qbit-wallet/i);
  assert.match(phishingSource, /href=\{FEEDBACK_URL\}/);
});
