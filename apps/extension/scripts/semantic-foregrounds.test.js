/* eslint-env node */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.resolve(__dirname, '..');
const colorsPath = path.join(extensionDir, 'src/ui/theme/colors.ts');
const colorsSource = fs.readFileSync(colorsPath, 'utf8');
const globalStylesSource = fs.readFileSync(path.join(extensionDir, 'src/ui/styles/global.less'), 'utf8');
const contactsSource = fs.readFileSync(path.join(extensionDir, 'src/ui/pages/Settings/ContactsScreen.tsx'), 'utf8');
const infoCardSource = fs.readFileSync(
  path.join(extensionDir, 'src/ui/pages/Approval/components/SignPsbt/components/InfoCard.tsx'),
  'utf8'
);

function extractHex(property) {
  const match = colorsSource.match(new RegExp(`${property}:\\s*['"](#[0-9a-f]{6})['"]`, 'i'));
  assert.ok(match, `expected ${property} to be a six-digit hex color`);
  return match[1];
}

function extractThemeBlock(selector) {
  const start = globalStylesSource.indexOf(`${selector} {`);
  assert.ok(start >= 0, `expected global.less to declare a ${selector} block`);
  const end = globalStylesSource.indexOf('}', start);
  return globalStylesSource.slice(start, end);
}

function extractCustomProperty(block, property) {
  const match = block.match(new RegExp(`--${property}:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `expected --${property} to be a six-digit hex color`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((channel) => parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

test('semantic warning and danger foregrounds remain readable on both theme surfaces', () => {
  // The semantic layer in colors.ts must route the guarded foregrounds through
  // the theme-aware custom properties.
  assert.match(colorsSource, /dangerText:\s*palette\.red_dark/);
  assert.match(colorsSource, /error:\s*palette\.red_dark/);
  assert.match(colorsSource, /red_dark:\s*'var\(--qbit-danger-text\)'/);
  assert.match(colorsSource, /orange_dark:\s*'var\(--qbit-warning\)'/);
  assert.match(colorsSource, /muted:\s*'var\(--qbit-muted\)'/);

  // The qbitColors reference palette stays in lockstep with the light theme.
  const lightBlock = extractThemeBlock(':root');
  for (const [tsKey, cssKey] of [
    ['accent', 'qbit-accent'],
    ['ink', 'qbit-ink'],
    ['muted', 'qbit-muted'],
    ['paper', 'qbit-paper'],
    ['canvas', 'qbit-canvas'],
    ['accentWash', 'qbit-accent-wash']
  ]) {
    assert.equal(
      extractHex(tsKey).toLowerCase(),
      extractCustomProperty(lightBlock, cssKey).toLowerCase(),
      `qbitColors.${tsKey} must match --${cssKey} in the light theme`
    );
  }

  for (const theme of [':root', "[data-theme='dark']"]) {
    const block = extractThemeBlock(theme);
    const dangerText = extractCustomProperty(block, 'qbit-danger-text');
    const warning = extractCustomProperty(block, 'qbit-warning');
    const warningHover = extractCustomProperty(block, 'qbit-warning-hover');
    const muted = extractCustomProperty(block, 'qbit-muted');
    const accent = extractCustomProperty(block, 'qbit-accent');
    const onAccent = extractCustomProperty(block, 'qbit-on-accent');
    const surfaces = ['qbit-paper', 'qbit-canvas', 'qbit-accent-wash'].map((name) =>
      extractCustomProperty(block, name)
    );

    assert.ok(contrast(onAccent, accent) >= 4.5, `${theme}: ${onAccent} must meet 4.5:1 on ${accent}`);

    // The danger hover fill reuses the danger-text token (Button preset
    // 'danger'), so its label color must stay readable on it per theme.
    const onDanger = extractCustomProperty(block, 'qbit-on-danger');
    assert.ok(
      contrast(onDanger, dangerText) >= 4.5,
      `${theme}: ${onDanger} must meet 4.5:1 on ${dangerText}`
    );

    // The warning Toast renders ink text over the warning fill.
    const ink = extractCustomProperty(block, 'qbit-ink');
    const warningFill = extractCustomProperty(block, 'qbit-warning-fill');
    assert.ok(
      contrast(ink, warningFill) >= 4.5,
      `${theme}: ${ink} must meet 4.5:1 on ${warningFill}`
    );

    for (const surface of surfaces) {
      for (const foreground of [dangerText, warning, warningHover, muted]) {
        assert.ok(
          contrast(foreground, surface) >= 4.5,
          `${theme}: ${foreground} must meet 4.5:1 on ${surface}`
        );
      }
    }
  }
});

test('theme-init.js pre-paint background matches the dark canvas token', () => {
  const themeInitSource = fs.readFileSync(path.join(extensionDir, 'build/_raw/theme-init.js'), 'utf8');
  const match = themeInitSource.match(/backgroundColor\s*=\s*'(#[0-9a-f]{6})'/i);
  assert.ok(match, 'expected theme-init.js to set a six-digit hex dark background');
  const darkCanvas = extractCustomProperty(extractThemeBlock("[data-theme='dark']"), 'qbit-canvas');
  assert.equal(match[1].toLowerCase(), darkCanvas.toLowerCase());
});

test('contact deletion preview keeps muted copy on a light semantic surface', () => {
  assert.match(contactsSource, /backgroundColor:\s*colors\.surfaceMuted/);
  assert.doesNotMatch(contactsSource, /backgroundColor:\s*colors\.black_muted/);
});

test('InfoCard status icons pass semantic token names to Icon', () => {
  assert.match(infoCardSource, /iconColor:\s*ColorTypes/);
  assert.match(infoCardSource, /iconColor:\s*'success'/);
  assert.match(infoCardSource, /iconColor:\s*'warning'/);
  assert.match(infoCardSource, /iconColor:\s*'dangerText'/);
  assert.doesNotMatch(infoCardSource, /iconColor:\s*colors\./);
});

test('foreground callsites use semantic colors instead of danger fill colors', () => {
  const offenders = sourceFiles(path.join(extensionDir, 'src'))
    .map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }))
    .filter(({ source }) =>
      [
        /color=["'](?:red|danger)["']/,
        /color=\{[^}\n]*["'](?:red|danger)["']/,
        /color=["'](?:black_muted|white_muted)["']/,
        /color=\{[^}\n]*["'](?:black_muted|white_muted)["']/,
        /color=\{?\s*["']black_65["']/,
        /\bcolor\s*:\s*colors\.(?:red|danger)\b/,
        /\b(?:color|subPartColor)\s*:\s*["']rgba\(0,\s*0,\s*0,\s*0\.(?:5|55|65)\)["']/,
        /LoadingOutlined[\s\S]{0,160}\bcolor\s*:\s*colors\.accent\b/,
        /\bcolor\s*:\s*["'](?:red|danger)["']/,
        /\bcolor\s*=\s*["'](?:red|danger)["']/,
        /\bcolor\s*:\s*["']#f55454["']/i,
        /\bcolor\s*:\s*["']#2588eb["']/i
      ].some((pattern) => pattern.test(source))
    )
    .map(({ file }) => path.relative(extensionDir, file));

  assert.deepEqual(offenders, []);
});
