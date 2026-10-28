import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate as useNavigateOrigin } from 'react-router-dom';

import { NavigationContext, NavigationContextType, RouteTypes, useChain } from '@qbit/wallet-state';
import { getExplorerUrl } from '@qbit/wallet-shared';

import { routes } from '../pages/MainRoute';
import { openExtensionInTab } from '../web/tabs';

export function useNavigate() {
  const navigate = useNavigateOrigin();
  const navigatingRef = useRef(false);

  return useCallback(
    (routKey: RouteTypes | '#back' | '/', state?: any, pathState?: any, options?: { replace?: boolean }) => {
      if (navigatingRef.current) {
        return;
      }

      navigatingRef.current = true;
      const replace = options?.replace === true;

      if (routKey.startsWith('/')) {
        navigate(routKey, { state, replace });
        navigatingRef.current = false;
        return;
      }

      if (routKey === '#back') {
        window.history.back();
        navigatingRef.current = false;
        return;
      }

      if (!routes[routKey]) {
        navigatingRef.current = false;
        return;
      }

      const route: any = routes[routKey];
      if (route.getDynamicPath) {
        const path = route.getDynamicPath(pathState);
        navigate(path, { replace, state });
        navigatingRef.current = false;
        return;
      }

      navigate(
        {
          pathname: route.path
        },
        { replace, state }
      );

      navigatingRef.current = false;
    },
    [navigate]
  );
}

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();

  const chain = useChain();
  const value = useMemo<NavigationContextType>(
    () => ({
      navigate: (screenName: RouteTypes, state?: any) => {
        navigate(screenName, state);
      },
      poptotop() {
        //   navigation.dispatch(StackActions.popToTop())
      },
      goBack: () => {
        window.history.go(-1);
      },
      replace: (screenName: RouteTypes, state?: any) => {
        navigate(screenName, state, undefined, { replace: true });
      },
      navToTab: () => {
        navigate('MainScreen');
      },
      navToLock: (params?: any) => {
        navigate('UnlockScreen', params);
      },
      navToWelcome: () => {
        // todo
      },
      getRouteState<T>(): T {
        return (location.state || {}) as T;
      },

      navToUtxoTools: () => {
        window.open(`${chain.websiteUrl}/utxo?tab=all`);
      },

      navToUrl: (url: string) => {
        window.open(url);
      },

      navToExplorerTx: (txid: string) => {
        const url = getExplorerUrl(chain, 'tx', txid);
        if (url) {
          window.open(url);
        }
      },

      navToExplorerAddress: (address: string) => {
        const url = getExplorerUrl(chain, 'address', address);
        if (url) {
          window.open(url);
        }
      },

      navToMarketPlace() {
        const url = `${chain.websiteUrl}/market`;
        window.open(url);
      },
      navToTest: () => {
        // todo
      },
      navToRootHome: () => {
        navigate('/');
      },
      openExtensionInTab: async () => {
        await openExtensionInTab('index.html', {});
        window.close();
      }
    }),
    [navigate, chain, location.state]
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}
