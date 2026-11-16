import { createAction } from '@reduxjs/toolkit'

// fired once when the app reloads but before the app renders
// allows any updates to be applied to store data loaded from localStorage
export const updateVersion = createAction<void>('global/updateVersion')

/**
 * The background erased every wallet, the password and the wallet data it
 * stores (its BUS_METHODS.WALLET_RESET). Every slice handles this one action,
 * so the whole store returns to its first-run state in a single dispatch: no
 * render shows one slice reset and another still holding the erased wallets,
 * and a persisted slice is saved only as it is after the reset. The store
 * stays ready, and the settings keep the language and the theme, which the
 * background keeps too.
 */
export const resetWalletState = createAction<void>('global/resetWalletState')
