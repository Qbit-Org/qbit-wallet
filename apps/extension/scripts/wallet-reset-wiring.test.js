/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const extensionDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionDir, '../..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const entrySource = read('apps/extension/src/ui/index.tsx');

function uiSources(directory) {
  return fs
    .readdirSync(path.join(repoRoot, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(directory, file));
}
const sources = [...uiSources('apps/extension/src/ui'), ...uiSources('packages/wallet-state/src')];

const DIALOG = 'apps/extension/src/ui/components/ResetWalletPopover/index.tsx';
// The names through which page code reaches the background's resetWallet:
// the call itself, the hook that makes it, and the page handler's request.
const RESET_NAMES = new Set(['resetWallet', 'useResetWallet', 'requestWalletReset']);

const parse = (file) =>
  ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

function visit(node, onNode) {
  onNode(node);
  ts.forEachChild(node, (child) => visit(child, onNode));
}

// The innermost named function around `node`: a function declaration, or a
// function or arrow assigned to a variable.
function enclosingFunction(node) {
  for (let at = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
    if (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      ts.isVariableDeclaration(at.parent) &&
      ts.isIdentifier(at.parent.name)
    ) {
      return at.parent.name.text;
    }
  }
  return '(module)';
}

// What a mention of one of RESET_NAMES does where it stands.
function role(node) {
  const parent = node.parent;
  if (ts.isStringLiteralLike(node)) return 'named in a string';
  if (
    (ts.isFunctionDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertySignature(parent)) &&
    parent.name === node
  ) {
    return 'declared';
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return `bound to ${parent.initializer ? parent.initializer.getText() : 'nothing'}`;
  }
  if (ts.isImportSpecifier(parent)) return 'imported';
  if (ts.isExportSpecifier(parent)) return 'exported';
  if (ts.isBindingElement(parent)) return 'destructured';
  return `used in ${enclosingFunction(node)}`;
}

// Every mention of RESET_NAMES in the non-test UI and wallet-state sources,
// comments aside, in any form: a call or optional call, a property, an
// import, a binding, or a string such as wallet['resetWallet'].
function resetMentions() {
  const found = [];
  for (const file of sources) {
    visit(parse(file), (node) => {
      if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && RESET_NAMES.has(node.text)) {
        found.push(`${file}: ${node.text} ${role(node)}`);
      }
    });
  }
  return found.sort();
}

test('the scan reads the UI and wallet-state sources', () => {
  assert.ok(sources.includes('apps/extension/src/ui/index.tsx'));
  assert.ok(sources.includes('packages/wallet-state/src/hooks/global.ts'));
  assert.ok(sources.includes(DIALOG));
});

test('every window installs the WALLET_RESET handler before it renders or listens to the port', () => {
  const store = entrySource.indexOf('const store = createAppStore();');
  const install = entrySource.indexOf('installPageWalletResetHandler(store);');
  const listen = entrySource.indexOf('setupEventBusListeners(portMessageChannel, {');
  const render = entrySource.indexOf('function renderApp()');
  assert.ok(store >= 0 && install > store, 'the handler is installed for the page store');
  assert.ok(listen > install, 'before the port feeds the event bus');
  assert.ok(render > install, 'before the first render');
  assert.match(entrySource, /<ToolsProvider>[\s\S]*<WalletResetNotice \/>[\s\S]*<\/ToolsProvider>/);
});

test('every window checks the id of the wallet it shows after a reconnection and at each unlock', () => {
  const listen = entrySource.indexOf('setupEventBusListeners(portMessageChannel, {');
  const watch = entrySource.indexOf('watchPortReconnects(');
  assert.ok(watch > listen, 'the channel is watched once it is set up');
  assert.match(
    entrySource,
    /const checkAfterReconnect = createReconnectReconcile\(\{[\s\S]*?shownWalletId: getShownWalletId,/
  );
  assert.match(entrySource, /watchPortReconnects\(portMessageChannel, checkAfterReconnect\);/);
  // A page that holds no id but shows wallet content is not taken for up to
  // date, after a reconnection nor at an unlock: what it shows, once started.
  // The one predicate (pageShowsWalletContent), for the checks and the proxy.
  assert.match(entrySource, /const showsWalletContent = \(\) => pageShowsWalletContent\(store\.getState\(\)\);/);
  assert.match(entrySource, /const checkAfterReconnect = createReconnectReconcile\(\{[\s\S]*?showsWalletContent,/);
  assert.match(entrySource, /unlockGate = createUnlockGate\(\{[\s\S]*?showsWalletContent,/);
  // Nor does such a page send a call without the id: the proxy holds it for
  // the id read under way, or refuses it in the -22 shape.
  assert.match(
    entrySource,
    /createWalletProxy\(portMessageChannel, \{[\s\S]*?showsWalletContent,\s*waitForWalletId: \(\) => waitForShownWalletId\(\),\s*refuseWithoutWalletId: \(\) => refuseWithoutWalletId\(i18nService\.translate\('wallet_page_out_of_date'\)\)\s*\}\)/
  );
  // The id is compared, not only whether some wallet is set up.
  for (const read of ['isBooted', 'getWalletId']) {
    assert.match(entrySource, new RegExp(`${read}: \\(\\) => wallet\\.${read}\\(\\)`), read);
  }
  // A background still starting cannot answer; the page waits for it, bounded,
  // and asks once more.
  assert.match(
    entrySource,
    /waitForStartup: \(\) =>\s*waitForBackgroundReady\(\s*wallet[^,]*,\s*RECONNECT_STARTUP_WAIT_MS\s*\)/
  );
  // An unlock answers only once the id is checked.
  assert.match(
    entrySource,
    /createWalletProxy\(portMessageChannel, \{\s*afterUnlock: async \(\) => unlockGate\?\.afterUnlock\(\),/
  );
  // Each call carries the id of the wallet shown; a -22 refusal reopens the
  // page at once, whatever the check is doing, not through it.
  assert.match(entrySource, /walletId: getShownWalletId,\s*onOutOfDate: reopenOutOfDatePage,/);
  assert.doesNotMatch(entrySource, /onOutOfDate: [^\n]*checkAfterReconnect/);
  // An unlock refused for that reason says so in the -22 words.
  assert.match(entrySource, /refusal: \(\) => i18nService\.translate\('wallet_page_out_of_date'\)/);
  // So does the unlock the background announces, this page's or another window's.
  assert.match(
    entrySource,
    /setupEventBusListeners\(portMessageChannel, \{\s*beforeUnlocked: async \(\) => unlockGate\?\.beforeUnlockedBroadcast\(\) \?\? true\s*\}\)/
  );
  assert.match(entrySource, /unlockGate = createUnlockGate\(\{[\s\S]*?onUnknown: checkAfterReconnect/);
  // Nothing sends the page to the unlock screen.
  assert.doesNotMatch(entrySource, /watchPageUnlocks|lockPage/);
});

test('every window notes, as its store loads, which wallet the stored keys belong to', () => {
  const store = entrySource.indexOf('const store = createAppStore();');
  const note = entrySource.indexOf('noteWalletDataOwnerAtLoad();');
  assert.ok(store >= 0 && note > store, 'noted right after the store loads its saved slice');
  assert.match(read('apps/extension/src/ui/components/PageStartup/index.tsx'), /reconcileStoredWalletData\(id\)/);
});

test('every window records the id of the wallet it shows as it starts', () => {
  const startup = read('apps/extension/src/ui/components/PageStartup/index.tsx');
  assert.match(startup, /id = await wallet\.getWalletId\(\);[\s\S]*?recordShownWalletId\(id\);/);
  assert.match(read('apps/extension/src/ui/pages/MainRoute.tsx'), /<PageStartup>/);
});

test('only the reset dialog confirm action reaches resetWallet', () => {
  assert.deepEqual(
    resetMentions(),
    [
      // The page-side declaration, the one call, and the hook that makes it.
      'packages/wallet-state/src/context/WalletContext.tsx: resetWallet declared',
      'packages/wallet-state/src/hooks/global.ts: resetWallet used in useResetWallet',
      'packages/wallet-state/src/hooks/global.ts: useResetWallet declared',
      // The page handler's request, which only carries a send it is given.
      'apps/extension/src/ui/utils/walletReset.ts: requestWalletReset declared',
      // The dialog takes the hook and sends from its confirm action, reset.
      `${DIALOG}: requestWalletReset imported`,
      `${DIALOG}: requestWalletReset used in reset`,
      `${DIALOG}: resetWallet bound to useResetWallet()`,
      `${DIALOG}: resetWallet used in reset`,
      `${DIALOG}: useResetWallet imported`,
      `${DIALOG}: useResetWallet used in ResetWalletPopover`
    ].sort()
  );
});

test('the confirm action runs only from the confirm button', () => {
  const source = parse(DIALOG);
  const outside = [];
  let declared = 0;
  visit(source, (node) => {
    if (!ts.isIdentifier(node) || node.text !== 'reset') return;
    if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) {
      declared += 1;
      return;
    }
    // The JSX element whose props hold this mention, if any.
    let element = node.parent;
    while (element && !ts.isJsxSelfClosingElement(element) && !ts.isJsxOpeningElement(element)) {
      element = element.parent;
    }
    const isConfirmButton =
      element &&
      element.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText() === 'data-testid' &&
          attribute.initializer &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === 'reset-wallet-confirm-button'
      );
    if (!isConfirmButton) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      outside.push(`${DIALOG}:${line + 1}`);
    }
  });
  assert.equal(declared, 1, 'the dialog declares its confirm action once');
  assert.deepEqual(outside, [], 'reset runs from somewhere other than the confirm button');
});

test('a wallet removal never falls through to a reset', () => {
  assert.doesNotMatch(
    read('apps/extension/src/ui/components/RemoveWalletPopover/index.tsx'),
    /resetWallet|ResetWallet|requestWalletReset/
  );
});
