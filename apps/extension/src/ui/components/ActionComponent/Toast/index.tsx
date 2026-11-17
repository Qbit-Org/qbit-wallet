import { CSSProperties, useCallback, useEffect, useRef } from 'react';

import { colors } from '@/ui/theme/colors';
import { useI18n } from '@qbit/wallet-state';

import { Text } from '../../Text';
import './index.less';

export type ToastPresets = keyof typeof $viewPresets;
export interface ToastProps {
  preset: ToastPresets;
  content: string;
  onClose: () => void;
  /**
   * Shown for LASTING_TOAST_DURATION_MS, long enough to read a warning the
   * user must not miss, with a control that closes it sooner, and announced
   * as an alert, as an error is. Only a toast that asks for it is.
   */
  lasting?: boolean;
}

const DEFAULT_TOAST_DURATION_MS = 2000;
const ERROR_TOAST_DURATION_MS = 8_000;
const LASTING_TOAST_DURATION_MS = 15_000;

type ToastStyle = CSSProperties & {
  '--toast-duration': string;
};

const $baseViewStyle = {
  padding: 4,
  borderRadius: 0,
  paddingLeft: 8,
  paddingRight: 8,
  marginLeft: 16,
  marginRight: 16
} as CSSProperties;

const $viewPresets = {
  info: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.surface,
    border: `1px solid ${colors.border}`
  }) as CSSProperties,

  success: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.primary
  }) as CSSProperties,

  error: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.danger,
    borderRadius: 6,
    padding: 12,
    paddingLeft: 16,
    paddingRight: 44,
    position: 'relative'
  }) as CSSProperties,

  warning: Object.assign({}, $baseViewStyle, {
    backgroundColor: colors.warningFill
  }) as CSSProperties
};

/** A lasting toast keeps its preset's colours, with room for its control, laid out as an error. */
const $lastingViewStyle = {
  borderRadius: 6,
  padding: 12,
  paddingLeft: 16,
  paddingRight: 44,
  position: 'relative'
} as CSSProperties;

export function Toast(props: ToastProps) {
  const { preset, content, onClose, lasting = false } = props;
  const { t } = useI18n();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = useRef(false);
  const isError = preset === 'error';
  // An error, and a lasting toast, are alerts with a control that closes them.
  const isAlert = isError || lasting;
  const duration = lasting ? LASTING_TOAST_DURATION_MS : isError ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS;
  const textColor = preset === 'info' || preset === 'warning' ? 'text' : 'onPrimary';

  const closeToast = useCallback(() => {
    if (closedRef.current) return;

    closedRef.current = true;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    const timeout = setTimeout(closeToast, duration);
    timeoutRef.current = timeout;

    return () => {
      clearTimeout(timeout);
      if (timeoutRef.current === timeout) {
        timeoutRef.current = null;
      }
    };
  }, [closeToast, duration]);

  const toastStyle = {
    ...$viewPresets[preset],
    ...(lasting ? $lastingViewStyle : {}),
    '--toast-duration': `${duration}ms`
  } as ToastStyle;

  return (
    <div
      className={`toast${isError ? ' toast--error' : ''}${lasting ? ' toast--lasting' : ''}`}
      style={toastStyle}
      role={isAlert ? 'alert' : undefined}
      aria-atomic={isAlert ? 'true' : undefined}
    >
      <Text text={content} preset={isError ? 'regular-bold' : 'regular'} color={textColor} textCenter />
      {isAlert && (
        <button
          type="button"
          className="toast__dismiss"
          style={{ color: colors[textColor] }}
          aria-label={t('close')}
          onClick={closeToast}
        >
          <svg
            className="toast__countdown"
            data-testid="error-toast-countdown"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle className="toast__countdown-track" cx="12" cy="12" r="10" pathLength="100" />
            <circle className="toast__countdown-progress" cx="12" cy="12" r="10" pathLength="100" />
          </svg>
          <svg
            className="toast__dismiss-icon"
            data-testid="error-toast-close-icon"
            width={8.8}
            height={8.8}
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
