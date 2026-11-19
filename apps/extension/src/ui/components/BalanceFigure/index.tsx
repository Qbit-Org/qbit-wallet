import { CSSProperties, ReactNode } from 'react';

// Text for a screen reader only: it takes no room on screen.
const $visuallyHidden: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  border: 0,
  whiteSpace: 'nowrap'
};

/**
 * A balance as a screen shows it (`children`: five decimals at most), with
 * the exact amount (`exact`: all eight decimals and the unit) on hover and,
 * in the shown figure's place, for a screen reader. Without `exact`, as for
 * a hidden or an unknown balance, `children` alone, which reveal nothing more.
 */
export function BalanceFigure({
  exact,
  children,
  'data-testid': dataTestId
}: {
  exact?: string;
  children: ReactNode;
  /** The shown figure's, present only while it shows an amount. */
  'data-testid'?: string;
}) {
  if (!exact) return <>{children}</>;
  return (
    <>
      <span aria-hidden="true" title={exact} style={{ display: 'inline-flex' }} data-testid={dataTestId}>
        {children}
      </span>
      <span style={$visuallyHidden}>{exact}</span>
    </>
  );
}
