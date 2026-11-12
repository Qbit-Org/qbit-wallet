---
'@qbit/wallet-state': major
---

Remove the wallet and account rename screen hooks, which the account switcher replaced (#177): the extension renames a wallet or an account in a dialog over the switcher, calling `setKeyringAlianName` and `setAccountAlianName` and dispatching `keyringsActions.updateKeyringName`, `keyringsActions.updateAccountName` and `accountActions.updateAccountName` itself. `useEditWalletNameScreenLogic` and `useEditAccountNameScreenLogic` are no longer exported, and `RouteParamList` drops `EditWalletNameScreen`, `EditAccountNameScreen` and `SwitchAccountScreen`, whose screens are gone.

`useExportMnemonicsScreenLogic` returns `hdPath`, the path `getMnemonics` returns with the phrase (empty when it returns none), and works out `pathName` from it rather than from the listed keyring, whose path is empty when the wallet is corrupted. An answer without a phrase fails on the password step, with an error, instead of reaching the phrase step.

`useExportMnemonicsScreenLogic` and `useExportPrivateKeyScreenLogic` return `handleOnKeyDown` in place of `handleOnKeyUp`: Enter submits the password on its keydown in the field, never on a keyup, a held key's repeats or the Enter that ends an input method's composition, so the Enter that opens either screen from the account switcher submits nothing. Both now follow `isEnterPressedInField(event)`, which the package exports for any field that submits on Enter: true for an Enter pressed in the field, false for a held key's repeats and for the Enter that ends an input method's composition.
