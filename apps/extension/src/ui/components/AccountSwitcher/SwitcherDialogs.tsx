import { Check } from 'lucide-react';
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
import { useI18n, useTools } from '@qbit/wallet-state';

/**
 * A modal dialog over the account switcher: rendered into document.body so it
 * stacks above the sheet, it takes focus, keeps Tab inside and closes on
 * Escape.
 */
function SwitcherDialog({
  labelledBy,
  onDismiss,
  children,
  'data-testid': dataTestId
}: {
  labelledBy: string;
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
