import { Check, X } from 'lucide-react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/ui/components/Button';
import { Input } from '@/ui/components/Input';
import { Popover } from '@/ui/components/Popover';
import { WalletAvatar } from '@/ui/components/WalletIdentity';
import { WALLET_COLOR_NAME_KEYS, WALLET_PALETTE } from '@/ui/theme/walletColors';
import { walletErrorMessage } from '@/ui/utils';
import { activateOnKey, keepTabInside, tabbableElements } from '@/ui/utils/keyboard';
import { MAX_ALIAS_NAME_LENGTH, WalletColorKey, WalletKeyring, resolveWalletColor } from '@qbit/wallet-shared';
import { isEnterPressedInField, useI18n, useTools, useWallet } from '@qbit/wallet-state';

/**
 * A modal dialog over the account switcher: rendered into document.body so it
 * stacks above the sheet, it takes focus, keeps Tab inside and closes on
 * Escape.
 */
function SwitcherDialog({
  labelledBy,
  busy,
  onDismiss,
  children,
  'data-testid': dataTestId
}: {
  labelledBy: string;
  /** Marks the dialog busy while its action runs. */
  busy?: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
  'data-testid': string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    // A field or button with autoFocus already took focus.
    if (node && !node.contains(document.activeElement)) {
      (tabbableElements(node)[0] ?? node).focus({ preventScroll: true });
    }
  }, []);

  return createPortal(
    <Popover>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className="switcher-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
            return;
          }
          keepTabInside(event, ref.current);
        }}
        data-testid={dataTestId}
      >
        {children}
      </div>
    </Popover>,
    document.body
  );
}

/** A dialog button: the app's `Button`, reachable with Tab and Enter/Space. */
function DialogButton({
  text,
  preset,
  disabled,
  loading,
  onActivate,
  'data-testid': dataTestId
}: {
  text: string;
  preset?: 'primary';
  disabled?: boolean;
  loading?: boolean;
  onActivate: () => void;
  'data-testid': string;
}) {
  return (
    <Button
      text={text}
      preset={preset}
      full
      disabled={disabled}
      loading={loading}
      role="button"
      tabIndex={disabled || loading ? -1 : 0}
      aria-disabled={disabled || loading ? true : undefined}
      onClick={onActivate}
      onKeyDown={activateOnKey(onActivate)}
      style={{ minHeight: 40 }}
      data-testid={dataTestId}
    />
  );
}

/**
 * Edits a wallet or account name. Saving trims the name; an empty name cannot
 * be saved, and an unchanged one closes without saving.
 */
export function NameEditDialog({
  title,
  initialName,
  onSave,
  onDismiss
}: {
  title: string;
  initialName: string;
  /** Saves the trimmed name; the dialog shows the error when it rejects. */
  onSave: (name: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const tools = useTools();
  const titleId = useId();
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const trimmed = name.trim();

  const save = async () => {
    if (savingRef.current || !trimmed) return;
    if (trimmed === initialName) {
      onDismiss();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSave(trimmed);
    } catch (error) {
      tools.toastError(walletErrorMessage(error, t('unknown_error')));
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <SwitcherDialog labelledBy={titleId} onDismiss={onDismiss} data-testid="name-edit-dialog">
      <form
        className="switcher-dialog__body"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={titleId} className="switcher-dialog__title">
          {title}
        </h2>
        <div className="switcher-dialog__field">
          <Input
            preset="text"
            value={name}
            autoFocus
            maxLength={MAX_ALIAS_NAME_LENGTH}
            aria-label={t('name_label')}
            onFocus={(event) => event.target.select()}
            onChange={(event) => setName(event.target.value)}
            data-testid="name-edit-input"
          />
        </div>
        <div className="switcher-dialog__actions">
          <DialogButton text={t('cancel')} onActivate={onDismiss} data-testid="name-edit-cancel" />
          <DialogButton
            text={t('save')}
            preset="primary"
            disabled={!trimmed}
            loading={saving}
            onActivate={() => void save()}
            data-testid="name-edit-save"
          />
        </div>
      </form>
    </SwitcherDialog>
  );
}

/**
 * Names one more account of a wallet and asks the switcher to derive it. The
 * field suggests the name the background would give; a typed name is sent
 * trimmed, and an empty one not at all, so the background names the account.
 * Once the derive is asked for, the dialog never offers Create again and
 * cannot be dismissed: the derive cannot be cancelled, and one that fails may
 * still have created the account, so a second try could create another. The
 * switcher closes the dialog when the derive settles.
 */
export function NewAccountDialog({
  keyring,
  onCreate,
  onDismiss
}: {
  /** The wallet that gets the account, as the switcher lists it. */
  keyring: WalletKeyring;
  /**
   * Derives the account with the name given, or with none for the background
   * to name it; the switcher reports how it went and closes the dialog.
   */
  onCreate: (name: string | undefined) => Promise<void>;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const wallet = useWallet();
  const titleId = useId();
  const walletNameId = useId();
  const nameAreaRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [suggestedName, setSuggestedName] = useState('');
  // The derive can take many seconds when the wallet was restored, so the
  // ref refuses a second Create at once, before the busy state is on screen.
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);

  // The name the background would give the account, as a hint, read again
  // whenever the sheet's copy of the wallet changes (its opening read lands,
  // or a later read brings an account added in another window). It follows
  // that copy, so it can still differ from the name Create gives when another
  // window adds an account after the sheet's last read: the background names
  // the account when it derives it. An answer to an older read is dropped;
  // while the account is created nothing is read. Without an answer the field
  // suggests nothing.
  useEffect(() => {
    if (creatingRef.current) return;
    let current = true;
    wallet
      .getNextAlianName(keyring)
      .then((next) => {
        if (current) setSuggestedName(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [wallet, keyring]);

  const create = () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    // While busy the buttons leave the tab order, so focus goes to the name
    // field, which stays focusable: Tab cannot walk out of the dialog.
    nameAreaRef.current?.querySelector('input')?.focus({ preventScroll: true });
    // Without a name the background names the account when it derives it,
    // from the accounts it has then: one added elsewhere meanwhile cannot
    // leave two accounts with the suggested name.
    void onCreate(name.trim() || undefined);
  };

  const dismiss = () => {
    if (!creatingRef.current) onDismiss();
  };

  return (
    <SwitcherDialog labelledBy={titleId} busy={creating} onDismiss={dismiss} data-testid="new-account-dialog">
      <div className="switcher-dialog__body">
        <div className="switcher-dialog__title-row">
          <h2 id={titleId} className="switcher-dialog__title">
            {t('new_account')}
          </h2>
          <button
            type="button"
            className="switcher-icon-button"
            aria-label={t('close')}
            aria-disabled={creating || undefined}
            tabIndex={creating ? -1 : undefined}
            onClick={dismiss}
            data-testid="create-account-close-button"
          >
            <X size={16} aria-hidden="true" focusable="false" />
          </button>
        </div>
        {/* The new account's name under the wallet it goes to, as the sheet
            lists an account under its wallet's header. */}
        <div ref={nameAreaRef}>
          <div className="create-account-wallet">
            <WalletAvatar keyring={keyring} size={28} data-testid="create-account-wallet-tile" />
            <span
              id={walletNameId}
              className="create-account-wallet__name"
              title={keyring.alianName}
              data-testid="create-account-wallet-name"
            >
              {keyring.alianName}
            </span>
          </div>
          <div className="switcher-dialog__field">
            <Input
              preset="text"
              value={name}
              placeholder={suggestedName}
              maxLength={MAX_ALIAS_NAME_LENGTH}
              readOnly={creating}
              autoFocus
              aria-label={t('name_label')}
              // The field takes focus first, so it names the wallet too.
              aria-describedby={walletNameId}
              onChange={(event) => setName(event.target.value)}
              // On the keydown of an Enter pressed in the field only: "+" and
              // Add Account open the dialog on an Enter's keydown, and that
              // key's keyup or repeats must not create an account.
              onKeyDown={(event) => {
                if (isEnterPressedInField(event)) create();
              }}
              data-testid="create-account-name-input"
            />
          </div>
        </div>
        <div className="switcher-dialog__actions">
          <DialogButton
            text={t('cancel')}
            disabled={creating}
            onActivate={dismiss}
            data-testid="create-account-cancel-button"
          />
          <DialogButton
            text={t('create')}
            preset="primary"
            loading={creating}
            onActivate={create}
            data-testid="create-account-confirm-button"
          />
        </div>
      </div>
    </SwitcherDialog>
  );
}

/**
 * The palette as swatches, the wallet's color marked. A tap saves the color
 * at once; the current one only closes the picker.
 */
export function WalletColorPicker({
  keyring,
  onPick,
  onDismiss
}: {
  keyring: WalletKeyring;
  /** Saves the color; the picker shows the error when it rejects. */
  onPick: (color: WalletColorKey) => Promise<void>;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const tools = useTools();
  const titleId = useId();
  const current = resolveWalletColor(keyring.color, keyring.index);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const pick = async (color: WalletColorKey) => {
    if (savingRef.current) return;
    if (color === current) {
      onDismiss();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onPick(color);
    } catch (error) {
      tools.toastError(walletErrorMessage(error, t('unknown_error')));
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <SwitcherDialog labelledBy={titleId} onDismiss={onDismiss} data-testid="wallet-color-picker">
      <div className="switcher-dialog__body">
        <div>
          <h2 id={titleId} className="switcher-dialog__title">
            {t('wallet_menu_change_color')}
          </h2>
          <div className="switcher-dialog__subtitle" title={keyring.alianName}>
            {keyring.alianName}
          </div>
        </div>
        <div className="wallet-color-grid" aria-busy={saving || undefined}>
          {WALLET_PALETTE.map((color) => {
            const selected = color === current;
            return (
              <button
                key={color}
                type="button"
                className={selected ? 'wallet-color-swatch wallet-color-swatch--current' : 'wallet-color-swatch'}
                aria-pressed={selected}
                aria-label={t(WALLET_COLOR_NAME_KEYS[color])}
                aria-disabled={saving || undefined}
                autoFocus={selected}
                onClick={() => void pick(color)}
                data-testid={`wallet-color-swatch-${color}`}
              >
                <WalletAvatar keyring={{ color, index: keyring.index }} size={44} />
                {selected && (
                  <span className="wallet-color-swatch__check" aria-hidden="true">
                    <Check size={12} strokeWidth={3} focusable="false" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="switcher-dialog__actions">
          <DialogButton text={t('cancel')} onActivate={onDismiss} data-testid="wallet-color-cancel" />
        </div>
      </div>
    </SwitcherDialog>
  );
}
