/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');
const addressTypeCardSource = fs.readFileSync(
  path.join(extensionDir, 'src/ui/components/AddressTypeCard/index.tsx'),
  'utf8'
);
const addressTypeCard2Source = addressTypeCardSource.slice(
  addressTypeCardSource.indexOf('export function AddressTypeCard2')
);
const contactChainModalSource = fs.readFileSync(
  path.join(extensionDir, 'src/ui/pages/Settings/ContactChainModal.tsx'),
  'utf8'
);

test('address balances use the active Qbit chain icon', () => {
  assert.match(addressTypeCard2Source, /const chain = useChain\(\)/);
  assert.match(addressTypeCard2Source, /<Image src=\{IMAGE_SOURCE_MAP\[chain\.icon\]\}/);
  assert.doesNotMatch(addressTypeCard2Source, /<Icon icon=["']qbt["']/);
});

test('the all-networks contact filter uses the aggregate Qbit icon', () => {
  assert.match(contactChainModalSource, /<Image src=\{IMAGE_SOURCE_MAP\[['"]testnet-all['"]\]\}/);
});
