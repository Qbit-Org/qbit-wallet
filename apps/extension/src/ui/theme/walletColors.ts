import { WALLET_COLOR_KEYS, WalletColorKey } from '@qbit/wallet-shared';

export interface WalletColorValue {
  /** The color in the light theme. */
  light: string;
  /** The color in the dark theme. */
  dark: string;
}

/**
 * The color of each wallet palette key, in the light and the dark theme.
 *
 * A wallet's avatar draws the wallet glyph over this color in the surface
 * color, `--qbit-paper` (white in the light theme, near black in the dark
 * one), so every value keeps at least 3:1 contrast with that token in its own
 * theme (WCAG 1.4.11). `walletColors.test.ts` checks this against the tokens
 * in `styles/global.less`.
 */
export const WALLET_COLOR_VALUES: Readonly<Record<WalletColorKey, WalletColorValue>> = {
  green: { light: '#0f813b', dark: '#4ccf85' },
  blue: { light: '#2563eb', dark: '#60a5fa' },
  orange: { light: '#c2410c', dark: '#fb923c' },
  violet: { light: '#7c3aed', dark: '#a78bfa' },
  teal: { light: '#0f766e', dark: '#2dd4bf' },
  pink: { light: '#be185d', dark: '#f472b6' },
  gold: { light: '#a16207', dark: '#facc15' },
  indigo: { light: '#4338ca', dark: '#818cf8' }
};

/** The locale key of each palette key's name, as swatches announce it. */
export const WALLET_COLOR_NAME_KEYS: Readonly<Record<WalletColorKey, string>> = {
  green: 'wallet_color_green',
  blue: 'wallet_color_blue',
  orange: 'wallet_color_orange',
  violet: 'wallet_color_violet',
  teal: 'wallet_color_teal',
  pink: 'wallet_color_pink',
  gold: 'wallet_color_gold',
  indigo: 'wallet_color_indigo'
};

/** The palette, in slot order. */
export const WALLET_PALETTE: readonly WalletColorKey[] = WALLET_COLOR_KEYS;
