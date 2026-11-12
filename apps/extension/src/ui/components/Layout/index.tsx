import React, { CSSProperties, useEffect, useRef } from 'react';
import { useStore } from 'react-redux';

import { routes } from '@/ui/pages/MainRoute';
import { colors } from '@/ui/theme/colors';
import { noteRedirectToUnlock } from '@/ui/utils/sendFormReturn';
import { type AppState, useBooted, useIsUnlocked } from '@qbit/wallet-state';

import './index.less';

export interface LayoutProps {
  children?: React.ReactNode;
  style?: CSSProperties;
}
export function Layout(props: LayoutProps) {
  const isBooted = useBooted();
  const isUnlocked = useIsUnlocked();
  const store = useStore<AppState>();
  // Whether this screen has been shown with the wallet unlocked. One that
  // mounted locked never was: a page loaded or restored while locked, one
  // that did not know yet it was unlocked, a form reached by Back from the
  // unlock screen.
  const shownUnlockedRef = useRef(false);

  useEffect(() => {
    if (isUnlocked) {
      shownUnlockedRef.current = true;
    }
    if (isBooted && !isUnlocked && location.href.includes(routes.UnlockScreen.path) === false) {
      // Whether the unlock may return here: only to a send form shown unlocked.
      noteRedirectToUnlock(routes.TxCreateScreen.path, store.getState(), shownUnlockedRef.current);
      const basePath = location.href.split('#')[0];
      location.href = `${basePath}#${routes.UnlockScreen.path}`;
      return;
    }
  }, [isBooted, isUnlocked, store]);

  const { children, style: $styleBase } = props;
  return (
    <div
      className="layout"
      style={Object.assign(
        {
          display: 'flex',
          flexDirection: 'column',
          width: '100vw',
          height: '100vh',
          backgroundColor: colors.background,
          color: colors.text,
          overflowY: 'auto',
          overflowX: 'hidden'
        },
        $styleBase
      )}
    >
      {children}
    </div>
  );
}
