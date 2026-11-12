import { Circle, CircleCheck, Copy, Ellipsis, Key, KeyRound, Palette, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import React, { CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { BottomModal, useBottomModal } from '@/ui/components/BottomModal';
import { Button } from '@/ui/components/Button';
import { RemoveWalletPopover } from '@/ui/components/RemoveWalletPopover';
import { WalletAvatar, WalletTags, walletTagsFor } from '@/ui/components/WalletIdentity';
import { shortAddress, walletErrorMessage } from '@/ui/utils';
import { activateOnKey, keepTabInside } from '@/ui/utils/keyboard';
import { Account, KeyringType, WalletColorKey, WalletKeyring } from '@qbit/wallet-shared';
import {
  accountActions,
  keyringsActions,
  useAppDispatch,
  useCurrentAccount,
  useI18n,
  useKeyrings,
  useNavigation,
  useReloadAccounts,
  useTools,
  useWallet
} from '@qbit/wallet-state';

import { ActionMenu, ActionMenuItem } from './ActionMenu';
import { NameEditDialog, NewAccountDialog, WalletColorPicker } from './SwitcherDialogs';
import { accountCountLabel } from './accountCount';
import './index.less';

/** Wallets that can derive another account: the ones with a recovery phrase. */
const ACCOUNT_CREATABLE_KEYRING_TYPES: string[] = [KeyringType.HdKeyring, KeyringType.QbitHdKeyring];
/** Wallets whose recovery phrase can be shown. */
const MNEMONIC_BACKED_KEYRING_TYPES: string[] = [KeyringType.HdKeyring, KeyringType.QbitHdKeyring];
/** Accounts whose private key can be exported. */
const PRIVATE_KEY_EXPORTABLE_ACCOUNT_TYPES: string[] = [KeyringType.HdKeyring, KeyringType.SimpleKeyring];

// A sheet over the home screen, the same in the popup, the side panel and a
// tab: it leaves the top of the screen in view and scrolls inside. In a window
// wider than the sheet, it is a centered column over the dimmed page.
const SHEET_MAX_HEIGHT = 'min(560px, calc(100vh - 40px))';
const SHEET_MAX_WIDTH = 560;
const SHEET_BODY_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxHeight: SHEET_MAX_HEIGHT,
  padding: 0,
  overflow: 'hidden'
};

function isCorruptedWallet(keyring: WalletKeyring): boolean {
  return (keyring as WalletKeyring & { isCorrupted?: boolean }).isCorrupted === true || keyring.accounts.length === 0;
}

type MenuTarget = { kind: 'wallet'; keyringKey: string } | { kind: 'account'; keyringKey: string; accountKey: string };
type MenuState = MenuTarget & { anchor: HTMLElement };

type DialogState =
  | { kind: 'rename-wallet'; keyringKey: string }
  | { kind: 'rename-account'; keyringKey: string; accountKey: string }
  | { kind: 'color'; keyringKey: string }
  | { kind: 'remove'; keyringKey: string }
  | { kind: 'new-account'; keyringKey: string };

interface WalletGroup {
  keyring: WalletKeyring;
  corrupted: boolean;
  /** The accounts the search leaves, all of them without a search. */
  accounts: Account[];
}

/**
 * Every account of every wallet, grouped under its wallet; one tap on an
 * account switches to its wallet and the account together.
 */
export function AccountSwitcherSheet({ onClose }: { onClose: () => void }) {
  return (
    <BottomModal onClose={onClose} bodyStyle={SHEET_BODY_STYLE} maxWidth={SHEET_MAX_WIDTH}>
      <AccountSwitcherContent />
    </BottomModal>
  );
}

function AccountSwitcherContent() {
  const { requestClose, closing } = useBottomModal();
  const wallet = useWallet();
  const dispatch = useAppDispatch();
  const tools = useTools();
  const nav = useNavigation();
  const reloadAccounts = useReloadAccounts();
  const { t, locale } = useI18n();
  const keyrings = useKeyrings();
  const currentAccount = useCurrentAccount();

  const titleId = useId();
  const listId = useId();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialogState] = useState<DialogState | null>(null);
  const [pendingAccountKey, setPendingAccountKey] = useState<string | null>(null);
  const [lockedHeight, setLockedHeight] = useState(0);

  const mountedRef = useRef(false);
  const closingRef = useRef(false);
  const switchingRef = useRef(false);
  // Every keyrings read gets the next generation; a result is shown only while
  // its generation is the latest, so a read overtaken by a newer read or by a
  // change made here, or one that settles after the sheet closed, is dropped.
  const keyringsGenerationRef = useRef(0);
  // Where focus goes back to when a menu or dialog closes.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The dialog on screen, so a save that settles later can tell whether its
  // own dialog is still the open one.
  const dialogRef = useRef<DialogState | null>(null);
  const setDialog = useCallback((next: DialogState | null) => {
    dialogRef.current = next;
    setDialogState(next);
  }, []);
  const scrolledToCurrentRef = useRef(false);

  // Reads the wallets and shows them, unless a newer read or a change made
  // here overtook this read, or the sheet began to close meanwhile. Resolves
  // with the wallets read, or undefined when the read failed.
  const readKeyrings = useCallback(async (): Promise<WalletKeyring[] | undefined> => {
    const generation = ++keyringsGenerationRef.current;
    let fresh: WalletKeyring[];
    try {
      fresh = await wallet.getKeyrings();
    } catch {
      // Keep the wallets the store has; the next open reads them again.
      return undefined;
    }
    if (mountedRef.current && !closingRef.current && generation === keyringsGenerationRef.current) {
      dispatch(keyringsActions.setKeyrings(fresh));
    }
    return fresh;
  }, [wallet, dispatch]);

  const refreshKeyrings = useCallback(() => {
    void readKeyrings();
  }, [readKeyrings]);

  const dropPendingKeyringsRead = () => {
    keyringsGenerationRef.current += 1;
  };

  // The store's wallets carry the recovery state of their last read, which a
  // recovery step leaves stale, so read them again each time the sheet opens.
  useEffect(() => {
    mountedRef.current = true;
    refreshKeyrings();
    return () => {
      mountedRef.current = false;
      keyringsGenerationRef.current += 1;
    };
  }, [refreshKeyrings]);

  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  // The state every way of closing (a row, the X, Escape, a tap on the dimmed
  // page around the sheet) leaves the sheet in while it slides away: a row
  // tapped meanwhile switches nothing, and a wallets read that settles later
  // is dropped. False when the sheet was already closing.
  const beginClosing = useCallback(() => {
    if (closingRef.current) return false;
    closingRef.current = true;
    keyringsGenerationRef.current += 1;
    return true;
  }, []);

  const close = useCallback(() => {
    if (beginClosing()) requestClose();
  }, [beginClosing, requestClose]);

  // A tap on the dimmed page closes the sheet in the modal, which says so.
  useLayoutEffect(() => {
    if (closing) beginClosing();
  }, [closing, beginClosing]);

  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo<WalletGroup[]>(() => {
    const result: WalletGroup[] = [];
    for (const keyring of keyrings) {
      const corrupted = isCorruptedWallet(keyring);
      const walletMatches = !normalizedQuery || (keyring.alianName ?? '').toLowerCase().includes(normalizedQuery);
      const accounts = corrupted
        ? []
        : walletMatches
          ? keyring.accounts
          : keyring.accounts.filter(
              (account) =>
                (account.alianName ?? '').toLowerCase().includes(normalizedQuery) ||
                account.address.toLowerCase().includes(normalizedQuery)
            );
      if (walletMatches || accounts.length > 0) {
        result.push({ keyring, corrupted, accounts });
      }
    }
    return result;
  }, [keyrings, normalizedQuery]);

  // Open with the current account in the middle of the list, below the wallet
  // header stuck at its top (the list's scroll padding).
  useLayoutEffect(() => {
    if (scrolledToCurrentRef.current) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !row) return;
    scrolledToCurrentRef.current = true;
    const headerHeight = parseFloat(getComputedStyle(list).scrollPaddingTop) || 0;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    list.scrollTop += rowRect.top - listRect.top - headerHeight - (listRect.height - headerHeight - rowRect.height) / 2;
  });

  // A search never shrinks the open sheet, so its top edge stays put. The
  // height it keeps is capped where the sheet is (see the root's style), so a
  // window made shorter while the sheet is open still shows the footer.
  useLayoutEffect(() => {
    if (normalizedQuery) return;
    const height = rootRef.current?.offsetHeight ?? 0;
    if (height > lockedHeight) setLockedHeight(height);
  }, [normalizedQuery, groups, lockedHeight]);

  const findKeyring = useCallback(
    (keyringKey: string) => keyrings.find((keyring) => keyring.key === keyringKey),
    [keyrings]
  );
  const findAccount = useCallback(
    (keyringKey: string, accountKey: string) =>
      findKeyring(keyringKey)?.accounts.find((account) => account.key === accountKey),
    [findKeyring]
  );

  // Focus to `target` while it is on screen, else to the search field, so it
  // never drops to the page behind the sheet.
  const focusInSheet = useCallback((target: HTMLElement | null) => {
    (target && target.isConnected ? target : searchRef.current)?.focus({ preventScroll: true });
  }, []);

  const restoreFocus = useCallback(() => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    focusInSheet(target);
  }, [focusInSheet]);

  const closeMenu = (refocus = true) => {
    const anchor = menu?.anchor ?? null;
    setMenu(null);
    if (refocus) anchor?.focus({ preventScroll: true });
  };

  // Whether the sheet is leaving: a switch is under way, which takes the sheet
  // away once it settles with whatever is open on it, or the sheet already
  // slides away. Nothing on it opens or acts then.
  const isLeaving = () => switchingRef.current || closingRef.current;

  // `action`, unless the sheet is leaving: then it only closes an open menu.
  const unlessLeaving = (action: () => void) => () => {
    if (isLeaving()) {
      closeMenu();
      return;
    }
    action();
  };

  // Every way to a dialog, the "+" and the menu items, keeps to unlessLeaving.
  const openDialog = (next: DialogState) => {
    returnFocusRef.current = menu?.anchor ?? (document.activeElement as HTMLElement | null);
    setMenu(null);
    setDialog(next);
  };

  const closeDialog = () => {
    setDialog(null);
    restoreFocus();
  };

  // A save can settle after its dialog was dismissed. The dialog open by then,
  // if any, is another one: it stays open and keeps the focus.
  const closeDialogIfOpen = (started: DialogState | null) => {
    if (started && dialogRef.current === started) closeDialog();
  };

  // A menu or dialog whose wallet or account is gone (removed here or
  // elsewhere) closes; a removal ends that way once the store has the wallets
  // the background has after it. Focus, gone with the menu's items or the
  // dialog, comes back to the sheet: to the button that opened it if that is
  // still there, else to the search field.
  useEffect(() => {
    if (menu) {
      const menuGone =
        menu.kind === 'account' ? !findAccount(menu.keyringKey, menu.accountKey) : !findKeyring(menu.keyringKey);
      if (menuGone) {
        setMenu(null);
        focusInSheet(menu.anchor);
      }
    }
    if (!dialog) return;
    const gone =
      dialog.kind === 'rename-account'
        ? !findAccount(dialog.keyringKey, dialog.accountKey)
        : !findKeyring(dialog.keyringKey);
    if (gone) {
      setDialog(null);
      restoreFocus();
    }
  }, [menu, dialog, findKeyring, findAccount, focusInSheet, restoreFocus, setDialog]);

  // The background refuses a change to a wallet that is gone or changed since
  // the sheet read it, as when another window removed it. The wallets read
  // again show only what is there, and a menu or dialog of a wallet that is
  // gone closes with it. For a wallet that is gone the refusal says so in the
  // user's language; any other refusal keeps the background's message.
  const explainRefusal = async (keyring: WalletKeyring, error: unknown): Promise<unknown> => {
    const fresh = await readKeyrings();
    const walletGone =
      fresh !== undefined && !fresh.some((listed) => listed.key === keyring.key && listed.type === keyring.type);
    return walletGone ? new Error(t('account_switcher_wallet_unavailable')) : error;
  };

  const selectAccount = async (keyring: WalletKeyring, account: Account) => {
    if (isLeaving()) return;
    if (account.key === currentAccount.key) {
      close();
      return;
    }
    // The account's place in its wallet, from the wallet as listed: an index
    // the port could not carry would select the first account instead.
    const accountIndex = keyring.accounts.findIndex((candidate) => candidate.key === account.key);
    if (accountIndex < 0) return;
    switchingRef.current = true;
    setPendingAccountKey(account.key);
    dropPendingKeyringsRead();
    try {
      await wallet.changeKeyring(keyring, accountIndex);
    } catch (error) {
      switchingRef.current = false;
      if (mountedRef.current) setPendingAccountKey(null);
      tools.toastError(walletErrorMessage(await explainRefusal(keyring, error), t('unknown_error')));
      return;
    }
    // The background switched, so the store follows even if the sheet is gone.
    dispatch(keyringsActions.setCurrent(keyring));
    let selected: Account = keyring.accounts[accountIndex] ?? account;
    try {
      selected = await wallet.getCurrentAccount();
    } catch {
      // changeKeyring selected exactly this account; show it.
    }
    dispatch(accountActions.setCurrent(selected));
    close();
  };

  // The New account dialog, over the sheet, for the wallet of the "+" or menu;
  // never in place of another dialog, which could be one still deriving.
  const addAccount = (keyring: WalletKeyring) => {
    if (dialogRef.current) return;
    openDialog({ kind: 'new-account', keyringKey: keyring.key });
  };

  // Derives one more account on the wallet the dialog shows, as the sheet
  // lists it; the background selects it. The dialog never offers Create again,
  // since a derive that fails may still have created the account: it closes
  // when the derive settles, whatever the outcome, and the store reads the
  // wallets and the selection back from the background even once the sheet is
  // gone. Without a name the background names the account as it derives it.
  const createAccount = async (keyring: WalletKeyring, name?: string) => {
    const started = dialogRef.current;
    let created = false;
    try {
      const result = await (name
        ? wallet.deriveNewAccountFromMnemonic(keyring, name)
        : wallet.deriveNewAccountFromMnemonic(keyring));
      created = true;
      if (result?.floorScanPending) {
        // The account exists and is selected, but the restored wallet's
        // signature-counter scan did not complete, so signing stays locked
        // until a later scan succeeds.
        tools.toastWarning(t('qbit_restore_floors_incomplete_warning'));
      } else {
        tools.toastSuccess(t('account_created'));
      }
    } catch (error) {
      // A restored wallet commits the account before its floor scan, and a
      // request the port dropped can still complete in the background, so the
      // account may exist all the same. The wallets read again show what is
      // there; one another window removed reads as gone, in the user's
      // language, and its dialog closes with it.
      tools.toastError(walletErrorMessage(await explainRefusal(keyring, error), t('unknown_error')));
    }
    // A wallets read still pending, such as the one made on opening, must
    // not replace what the reload reads after it.
    dropPendingKeyringsRead();
    try {
      await reloadAccounts();
    } catch {
      // The home screen keeps the last synced account until the next reload.
    }
    // Once its dialog is gone (its wallet went, or the sheet closed and is
    // gone too), nothing closes: not another dialog opened since, nor the
    // sheet under it. The sheet cannot begin to close while the dialog is open:
    // the dialog covers it and takes Escape.
    if (!mountedRef.current || started === null || dialogRef.current !== started) return;
    closeDialog();
    // The new account is selected: the home screen shows it.
    if (created) close();
  };

  const removeWallet = (keyring: WalletKeyring) => {
    // A usable wallet must stay, as the background requires: a corrupted one
    // cannot be opened, so it does not count. The background checks again,
    // against the wallets as they are when the removal runs.
    if (!keyrings.some((other) => other.key !== keyring.key && !isCorruptedWallet(other))) {
      closeMenu();
      tools.toastError(t('removing_the_last_wallet_is_not_allowed'));
      return;
    }
    dropPendingKeyringsRead();
    openDialog({ kind: 'remove', keyringKey: keyring.key });
  };

  const walletMenuItems = (keyring: WalletKeyring): ActionMenuItem[] => {
    const corrupted = isCorruptedWallet(keyring);
    const items: ActionMenuItem[] = [];
    if (!corrupted && ACCOUNT_CREATABLE_KEYRING_TYPES.includes(keyring.type)) {
      items.push({
        label: t('wallet_menu_add_account'),
        icon: <Plus size={14} />,
        onSelect: () => addAccount(keyring),
        'data-testid': 'wallet-menu-add-account'
      });
    }
    items.push({
      label: t('wallet_menu_rename'),
      icon: <Pencil size={14} />,
      onSelect: () => openDialog({ kind: 'rename-wallet', keyringKey: keyring.key }),
      'data-testid': 'wallet-menu-rename'
    });
    if (!corrupted) {
      items.push({
        label: t('wallet_menu_change_color'),
        icon: <Palette size={14} />,
        onSelect: () => openDialog({ kind: 'color', keyringKey: keyring.key }),
        'data-testid': 'wallet-menu-change-color'
      });
    }
    // Corrupted wallets included: their phrase is still in the vault, and the
    // "Invalid" note asks for removal, so it must stay reachable for a backup.
    if (MNEMONIC_BACKED_KEYRING_TYPES.includes(keyring.type)) {
      items.push({
        label: t('wallet_menu_backup_seed_phrase'),
        icon: <KeyRound size={14} />,
        onSelect: () => {
          setMenu(null);
          nav.navigate('ExportMnemonicsScreen', { keyring });
        },
        'data-testid': 'wallet-menu-show-phrase'
      });
    }
    items.push({
      label: t('remove_wallet'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => removeWallet(keyring),
      'data-testid': 'wallet-menu-remove'
    });
    return items;
  };

  const accountMenuItems = (keyring: WalletKeyring, account: Account): ActionMenuItem[] => {
    const items: ActionMenuItem[] = [
      {
        label: t('edit_name'),
        icon: <Pencil size={14} />,
        onSelect: () => openDialog({ kind: 'rename-account', keyringKey: keyring.key, accountKey: account.key }),
        'data-testid': 'account-menu-edit-name'
      },
      {
        label: t('copy_address'),
        icon: <Copy size={14} />,
        onSelect: () => {
          closeMenu();
          tools.copyToClipboard(account.address);
        },
        'data-testid': 'account-menu-copy-address'
      }
    ];
    if (PRIVATE_KEY_EXPORTABLE_ACCOUNT_TYPES.includes(account.type)) {
      items.push({
        label: t('export_private_key'),
        icon: <Key size={14} />,
        onSelect: () => {
          setMenu(null);
          nav.navigate('ExportPrivateKeyScreen', { account });
        },
        'data-testid': 'account-menu-export-key'
      });
    }
    return items;
  };

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, target: MenuTarget) => {
    if (isLeaving()) {
      closeMenu();
      return;
    }
    const anchor = event.currentTarget;
    setMenu((open) => (open && open.anchor === anchor ? null : { ...target, anchor }));
  };

  const saveWalletName = async (keyring: WalletKeyring, name: string) => {
    const started = dialogRef.current;
    let renamed: WalletKeyring;
    try {
      renamed = await wallet.setKeyringAlianName(keyring, name);
    } catch (error) {
      throw await explainRefusal(keyring, error);
    }
    dropPendingKeyringsRead();
    dispatch(keyringsActions.updateKeyringName(renamed));
    closeDialogIfOpen(started);
    refreshKeyrings();
  };

  const saveAccountName = async (account: Account, name: string) => {
    const started = dialogRef.current;
    const renamed = await wallet.setAccountAlianName(account, name);
    dropPendingKeyringsRead();
    dispatch(keyringsActions.updateAccountName(renamed));
    dispatch(accountActions.updateAccountName(renamed));
    closeDialogIfOpen(started);
    refreshKeyrings();
  };

  const saveWalletColor = async (keyring: WalletKeyring, color: WalletColorKey) => {
    const started = dialogRef.current;
    let recolored: WalletKeyring;
    try {
      recolored = await wallet.setKeyringColor(keyring, color);
    } catch (error) {
      throw await explainRefusal(keyring, error);
    }
    dropPendingKeyringsRead();
    dispatch(keyringsActions.updateKeyringColor(recolored));
    closeDialogIfOpen(started);
    refreshKeyrings();
  };

  const addOrImportWallet = unlessLeaving(() => nav.navigate('AddKeyringScreen'));

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keys from a dialog over the sheet are the dialog's.
    if (dialog || !rootRef.current?.contains(event.target as Node)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    keepTabInside(event, rootRef.current);
  };

  const menuKeyring = menu ? findKeyring(menu.keyringKey) : undefined;
  const menuAccount = menu?.kind === 'account' ? findAccount(menu.keyringKey, menu.accountKey) : undefined;
  const dialogKeyring = dialog ? findKeyring(dialog.keyringKey) : undefined;
  const dialogAccount = dialog?.kind === 'rename-account' ? findAccount(dialog.keyringKey, dialog.accountKey) : undefined;
  const searching = normalizedQuery.length > 0;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="switcher"
      style={{ minHeight: lockedHeight ? `min(${lockedHeight}px, ${SHEET_MAX_HEIGHT})` : undefined }}
      onKeyDown={onKeyDown}
      data-testid="switch-account-sheet"
    >
      <div ref={headerRef} className="switcher__header">
        <h2 id={titleId} className="switcher__title">
          {t('switch_account')}
        </h2>
        <button
          type="button"
          className="switcher-icon-button"
          aria-label={t('close')}
          onClick={close}
          data-testid="switch-account-close"
        >
          <X size={16} aria-hidden="true" focusable="false" />
        </button>
      </div>

      <div className="switcher__search">
        <Search size={15} className="switcher__search-icon" aria-hidden="true" focusable="false" />
        <input
          ref={searchRef}
          type="text"
          className="switcher__search-input"
          value={query}
          placeholder={t('account_switcher_search_placeholder')}
          aria-label={t('account_switcher_search_placeholder')}
          aria-controls={listId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="switch-account-search"
        />
      </div>

      <div ref={listRef} id={listId} className="switcher__list">
        {groups.map(({ keyring, corrupted, accounts }) => {
          const nameId = `${listId}-${keyring.key}`;
          const tags = walletTagsFor(keyring);
          const canAddAccount = !corrupted && ACCOUNT_CREATABLE_KEYRING_TYPES.includes(keyring.type);
          const walletMenuOpen = menu?.kind === 'wallet' && menu.keyringKey === keyring.key;
          return (
            <div
              key={keyring.key}
              role="group"
              aria-labelledby={nameId}
              className="switcher-group"
              data-testid={`wallet-group-${keyring.key}`}
            >
              <div className="switcher-group__header">
                <WalletAvatar keyring={keyring} size={28} data-testid={`wallet-tile-${keyring.key}`} />
                <div className="switcher-group__titles">
                  <div className="switcher-group__name-line">
                    <span
                      id={nameId}
                      className="switcher-group__name"
                      title={keyring.alianName}
                      data-testid={`wallet-name-${keyring.key}`}
                    >
                      {keyring.alianName}
                    </span>
                    <WalletTags tags={tags} testIdFor={(tag) => `wallet-tag-${tag}-${keyring.key}`} />
                  </div>
                  {!corrupted && (
                    <span className="switcher-group__count">
                      {accountCountLabel(t, locale, keyring.accounts.length)}
                    </span>
                  )}
                </div>
                <div className="switcher-group__actions">
                  {canAddAccount && (
                    <button
                      type="button"
                      className="switcher-icon-button switcher-icon-button--accent"
                      aria-label={t('account_switcher_add_account_label', [keyring.alianName])}
                      onClick={unlessLeaving(() => addAccount(keyring))}
                      data-testid={`wallet-add-account-${keyring.key}`}
                    >
                      <Plus size={17} aria-hidden="true" focusable="false" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="switcher-icon-button"
                    aria-label={t('account_switcher_wallet_options_label', [keyring.alianName])}
                    aria-haspopup="menu"
                    aria-expanded={walletMenuOpen}
                    aria-controls={walletMenuOpen ? menuId : undefined}
                    onClick={(event) => openMenu(event, { kind: 'wallet', keyringKey: keyring.key })}
                    data-testid={`wallet-menu-${keyring.key}`}
                  >
                    <Ellipsis size={17} aria-hidden="true" focusable="false" />
                  </button>
                </div>
              </div>

              {corrupted ? (
                <button
                  type="button"
                  className="switcher-invalid"
                  onClick={unlessLeaving(() => tools.toastError(t('invalid_wallet_please_remove_it_and_add_new_one')))}
                  data-testid={`wallet-invalid-${keyring.key}`}
                >
                  {t('wallet_invalid_note')}
                </button>
              ) : (
                <ul className="switcher-group__accounts">
                  {accounts.map((account) => {
                    const current = account.key === currentAccount.key;
                    const accountName = account.alianName ?? '';
                    const address = shortAddress(account.address);
                    const accountMenuOpen = menu?.kind === 'account' && menu.accountKey === account.key;
                    const rowClass = [
                      'switcher-row',
                      current ? 'switcher-row--current' : '',
                      pendingAccountKey === account.key ? 'switcher-row--pending' : ''
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <li key={account.key} className={rowClass}>
                        <button
                          type="button"
                          className="switcher-row__select"
                          aria-current={current ? 'true' : undefined}
                          aria-label={t('account_switcher_account_label', [accountName, keyring.alianName, address])}
                          onClick={() => void selectAccount(keyring, account)}
                          data-testid={`account-row-${account.address}`}
                        >
                          <span className="switcher-row__mark" aria-hidden="true">
                            {current ? <CircleCheck size={16} focusable="false" /> : <Circle size={16} focusable="false" />}
                          </span>
                          <span className="switcher-row__text">
                            <span className="switcher-row__name" title={accountName}>
                              {accountName}
                            </span>
                            <span className="switcher-row__address">{address}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="switcher-icon-button switcher-icon-button--muted"
                          aria-label={t('account_switcher_account_options_label', [accountName, keyring.alianName])}
                          aria-haspopup="menu"
                          aria-expanded={accountMenuOpen}
                          aria-controls={accountMenuOpen ? menuId : undefined}
                          onClick={(event) =>
                            openMenu(event, { kind: 'account', keyringKey: keyring.key, accountKey: account.key })
                          }
                          data-testid={`account-menu-${account.address}`}
                        >
                          <Ellipsis size={16} aria-hidden="true" focusable="false" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}

        {searching && groups.length === 0 && (
          <div className="switcher__empty" role="status" data-testid="switch-account-empty">
            <Search size={22} aria-hidden="true" focusable="false" />
            <span className="switcher__empty-title">{t('account_switcher_no_results')}</span>
            <span className="switcher__empty-hint">{t('account_switcher_no_results_hint')}</span>
          </div>
        )}
      </div>

      <div className="switcher__footer">
        <Button
          preset="default"
          text={t('account_switcher_add_or_import_wallet')}
          LeftAccessory={<Plus size={16} aria-hidden="true" focusable="false" />}
          role="button"
          tabIndex={0}
          onClick={addOrImportWallet}
          onKeyDown={activateOnKey(addOrImportWallet)}
          style={{ minHeight: 44 }}
          data-testid="add-wallet-button"
        />
      </div>

      {menu && menuKeyring && rootRef.current && (
        <ActionMenu
          id={menuId}
          anchor={menu.anchor}
          container={rootRef.current}
          clearOf={headerRef.current}
          label={
            menu.kind === 'wallet'
              ? t('account_switcher_wallet_options_label', [menuKeyring.alianName])
              : t('account_switcher_account_options_label', [menuAccount?.alianName ?? '', menuKeyring.alianName])
          }
          items={(menu.kind === 'wallet'
            ? walletMenuItems(menuKeyring)
            : menuAccount
              ? accountMenuItems(menuKeyring, menuAccount)
              : []
          ).map((item) => ({ ...item, onSelect: unlessLeaving(item.onSelect) }))}
          onDismiss={() => closeMenu()}
        />
      )}

      {dialog?.kind === 'rename-wallet' && dialogKeyring && (
        <NameEditDialog
          title={t('change_wallet_name')}
          initialName={dialogKeyring.alianName}
          onSave={(name) => saveWalletName(dialogKeyring, name)}
          onDismiss={closeDialog}
        />
      )}
      {dialog?.kind === 'rename-account' && dialogAccount && (
        <NameEditDialog
          title={t('change_account_name')}
          initialName={dialogAccount.alianName ?? ''}
          onSave={(name) => saveAccountName(dialogAccount, name)}
          onDismiss={closeDialog}
        />
      )}
      {dialog?.kind === 'color' && dialogKeyring && (
        <WalletColorPicker
          keyring={dialogKeyring}
          onPick={(color) => saveWalletColor(dialogKeyring, color)}
          onDismiss={closeDialog}
        />
      )}
      {dialog?.kind === 'new-account' && dialogKeyring && (
        <NewAccountDialog
          keyring={dialogKeyring}
          onCreate={(name) => createAccount(dialogKeyring, name)}
          onDismiss={closeDialog}
        />
      )}
      {dialog?.kind === 'remove' &&
        dialogKeyring &&
        createPortal(
          <RemoveWalletPopover
            keyring={dialogKeyring}
            onClose={() => {
              closeDialog();
              refreshKeyrings();
            }}
          />,
          document.body
        )}
    </div>
  );
}
