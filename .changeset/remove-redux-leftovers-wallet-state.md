---
'@qbit/wallet-state': patch
---

Remove store state and hooks left from the fork that nothing wrote, read or called:

- `global`: everything but `isUnlocked`, `isReady`, `isBooted` and `switchChainModalVisible` (tabs, screen state, refresh counters, infinite-list and scroll state, biometrics flags, the lock overlay), with `useTab`, `useSetTabCallback`, `useScreenState`, `useUpdateScreenStateCallback`, the `use*Refresh` hooks, `useLayerState`, `useUnlockRead`, `useInfiniteListScrollOffset`, `useInfiniteListScrollState`, `useIsScrollViewTop`, `useIsScrollViewBot`, `useIsBiometricsSupported`, `useHasBiometricsKey`, `useLockedOverlayVisible`, `useSetLockedOverlayVisibleCallback` and `useLockCallback`. `TabOption` no longer has `'app'`.
- `accounts`: `addressSummary`, `model` and `loading`, with `setAddressSummary`, `pendingLogin`, `rejectLogin`, `expireHistory`, `setCurrentAccountName`, `useAddressSummary` and `useAccountBalanceStatus`.
- `transactions`: `qbitTx` (`updateQbitTx`, `useQbitTx`) and `spendUnavailableUtxos` (`setSpendUnavailableUtxos`, `useSpendUnavailableUtxos`, `useSetSpendUnavailableUtxosCallback`), with `useSafeBalance`, `useUtxosChain` and `getQbitP2mrSpendableSatoshis`. A broadcast that succeeds still reads the balance again.
- `ui`: `addressInput`, `amountInput`, `navigationSource` (with `NavigationSource` and `setNavigationSource`) and the fee bar's `enableLowFeeRate`, with their actions and hooks, `useThrottle` and `useIsInExpandView`. A ui state saved by 1.0.5 to 1.0.8 that holds them still loads: only the two display preferences are read from it, as before.
- `settings`: `networkType`, with `useNetworkType`, `useChangeNetworkTypeCallback`, `useLocale`, `useChangeLocaleCallback`, `useIsMainnetChain`, `useGetTxExplorerUrlCallback` and `useAddressExplorerUrl`.
- `DeviceContext` and `useDevice`, and `useAmountInputLogic`.
- The `updateVersion` handlers of the slices that are never saved (`global`, `accounts`, `keyrings`, `settings`, `transactions`). The saved `ui` slice keeps its own.
