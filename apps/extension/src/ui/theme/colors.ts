export const qbitColors = {
  accent: '#1AB453',
  accentHover: '#20C760',
  accentDark: '#0F813B',
  accentWash: '#E8F8EE',
  canvas: '#F6FAF7',
  paper: '#FFFFFF',
  ink: '#101412',
  muted: '#4F6056',
  line: '#DCE7E0',
  darkPanel: '#071007'
} as const;

// Shared palette aliases resolve through the CSS custom properties declared in
// styles/global.less, so every consumer follows the active data-theme
// (light/dark) without threading a theme object through call sites.
const palette = {
  white: 'var(--qbit-paper)',
  pureWhite: '#FFFFFF',
  white_muted: 'var(--qbit-muted-soft)',
  white_muted2: 'var(--qbit-ink-soft)',
  white_muted3: 'var(--qbit-ink)',
  black: 'var(--qbit-ink)',
  black_muted: 'var(--qbit-muted-soft)',
  black_muted2: 'rgba(16, 20, 18, 0)',
  black_65: 'var(--qbit-ink-65)',

  dark: 'var(--qbit-ink)',
  grey: 'var(--qbit-muted)',
  light: 'var(--qbit-line)',

  black_dark: 'var(--qbit-paper)',

  green_dark2: 'var(--qbit-accent-deep)',
  green_dark: 'var(--qbit-accent-dark)',
  green: 'var(--qbit-accent-dark)',
  green_light: 'var(--qbit-accent-hover)',

  yellow_dark: 'var(--qbit-accent-dark)',
  yellow: 'var(--qbit-accent-dark)',
  yellow_light: 'var(--qbit-accent-hover)',

  red_dark: 'var(--qbit-danger-text)',
  red: '#ED334B',
  red_light: '#f05266',
  red_light2: '#f55454',

  blue_dark: '#1461d1',
  blue: '#1872F6',
  blue_light: '#c6dcfd',

  orange_dark: 'var(--qbit-warning)',
  orange: '#FF7B21',
  orange_light: '#ff8f42',
  orange_light2: '#FF7C2A',

  gold: 'var(--qbit-accent-dark)'
};

export const colors = Object.assign({}, palette, {
  transparent: 'rgba(0, 0, 0, 0)',

  text: 'var(--qbit-ink)',
  textWhite: palette.white_muted2,

  textDim: 'var(--qbit-muted)',
  /** Fainter than textDim (the placeholder tone): secondary detail under a label. */
  textFaint: 'var(--qbit-muted-soft)',

  background: 'var(--qbit-canvas)',
  surface: 'var(--qbit-paper)',
  surfaceMuted: 'var(--qbit-canvas)',
  surfaceStrong: 'var(--qbit-accent-wash)',
  ink: 'var(--qbit-ink)',
  muted: 'var(--qbit-muted)',
  accent: 'var(--qbit-accent)',
  accentHover: 'var(--qbit-accent-hover)',
  accentDark: 'var(--qbit-accent-dark)',
  accentWash: 'var(--qbit-accent-wash)',
  onPrimary: 'var(--qbit-on-accent)',
  onDark: '#FFFFFF',
  onDanger: 'var(--qbit-on-danger)',
  overlay: 'var(--qbit-overlay)',
  shadow: 'var(--qbit-shadow)',

  dangerText: palette.red_dark,
  error: palette.red_dark,

  danger: 'rgba(245, 84, 84, 0.90)',

  card: 'var(--qbit-paper)',
  warning: palette.orange_dark,
  warningFill: 'var(--qbit-warning-fill)',
  primary: 'var(--qbit-accent)',

  bg2: 'var(--qbit-paper)',
  bg3: 'var(--qbit-accent-wash)',
  bg4: 'var(--qbit-surface-tint)',
  search_bar_bg: 'var(--qbit-paper)',

  border: 'var(--qbit-line)',
  border2: 'var(--qbit-border-soft)',

  icon_yellow: 'var(--qbit-accent)',

  value_up_color: 'var(--qbit-value-up)',
  value_down_color: 'var(--qbit-value-down)',

  ticker_color: 'var(--qbit-accent)',
  ticker_color2: 'var(--qbit-ink-soft)',

  success: 'var(--qbit-accent-dark)',

  txid_color: 'var(--qbit-accent-dark)',

  warning_content: '#F4B62CD9',

  warning_bg: '#F4B62C59',
  line: 'var(--qbit-line)',
  line2: 'var(--qbit-line-strong)'
});

export type ColorTypes = keyof typeof colors;
