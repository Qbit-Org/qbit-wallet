import { useEffect, useState } from 'react';

import { Content } from '../Content';
import { Spin } from '../Spin';

/**
 * How long a page waits blank before it shows a spinner. A page that opens as
 * it should shows its first screen within it, so no spinner flashes at each
 * open.
 */
export const WAITING_PAGE_SPINNER_DELAY_MS = 1_000;

// The wait on screen: when it began, and how many WaitingPages show it. While
// the page opens, its wait began with its load, the origin of
// performance.now(). The steps of one wait hand over to each other in a
// single commit, so a wait ends only when a microtask after its last
// WaitingPage went finds none: a screen with content has taken its place.
let waitStartedAt: number | undefined = 0;
let waitingPages = 0;

/**
 * The whole page, blank while the wallet waits to show a screen: as a page
 * opens, while it loads its locale, runs its start-up reads and picks its
 * first screen, and while a screen it is sent to later reads what it shows.
 * A spinner shows once the wait, counted across those steps, has lasted
 * WAITING_PAGE_SPINNER_DELAY_MS.
 */
export function WaitingPage() {
  const [spinnerDue, setSpinnerDue] = useState(
    () => waitStartedAt !== undefined && performance.now() - waitStartedAt >= WAITING_PAGE_SPINNER_DELAY_MS
  );

  useEffect(() => {
    waitingPages++;
    if (waitStartedAt === undefined) {
      waitStartedAt = performance.now();
    }
    const timer = setTimeout(
      () => setSpinnerDue(true),
      waitStartedAt + WAITING_PAGE_SPINNER_DELAY_MS - performance.now()
    );
    return () => {
      clearTimeout(timer);
      waitingPages--;
      queueMicrotask(() => {
        if (waitingPages === 0) {
          waitStartedAt = undefined;
        }
      });
    };
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100vw',
        height: '100vh',
        overflowY: 'auto',
        overflowX: 'hidden'
      }}
    >
      <Content justifyCenter itemsCenter>
        {spinnerDue && <Spin size="large" />}
      </Content>
    </div>
  );
}
