import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { WALLET_COLOR_KEYS } from '@qbit/wallet-shared';

import { WALLET_COLOR_NAME_KEYS, WALLET_COLOR_VALUES } from './walletColors';

// The theme tokens as the app ships them, not copies of their values.
const globalStyles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../styles/global.less'), 'utf8');

function themeBlock(selector: string): string {
  const start = globalStyles.indexOf(`${selector} {`);
  expect(start, `global.less declares a ${selector} block`).toBeGreaterThanOrEqual(0);
  return globalStyles.slice(start, globalStyles.indexOf('}', start));
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'));
  expect(match, `--${name} is a six-digit hex color`).not.toBeNull();
  return (match as RegExpMatchArray)[1];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio. */
function contrast(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const themes = [
  { name: 'light', selector: ':root' },
  { name: 'dark', selector: '[data-theme=\'dark\']' }
] as const;

describe('wallet palette', () => {
  it('measures contrast the way WCAG does', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
  });

  it('gives every palette key a light and a dark value, and nothing else', () => {
    expect(Object.keys(WALLET_COLOR_VALUES).sort()).toEqual([...WALLET_COLOR_KEYS].sort());
    expect(Object.keys(WALLET_COLOR_NAME_KEYS).sort()).toEqual([...WALLET_COLOR_KEYS].sort());
    for (const key of WALLET_COLOR_KEYS) {
      expect(WALLET_COLOR_VALUES[key].light).toMatch(/^#[0-9a-f]{6}$/i);
      expect(WALLET_COLOR_VALUES[key].dark).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(themes)('keeps at least 3:1 against the glyph color (--qbit-paper) in the $name theme', ({ name, selector }) => {
    const glyph = token(themeBlock(selector), 'qbit-paper');
    for (const key of WALLET_COLOR_KEYS) {
      const value = WALLET_COLOR_VALUES[key][name];
      const ratio = contrast(value, glyph);
      expect(ratio, `${key} ${value} on ${glyph} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it('reads two different glyph colors for the two themes', () => {
    const light = token(themeBlock(':root'), 'qbit-paper');
    const dark = token(themeBlock('[data-theme=\'dark\']'), 'qbit-paper');
    expect(light).not.toBe(dark);
  });
});
