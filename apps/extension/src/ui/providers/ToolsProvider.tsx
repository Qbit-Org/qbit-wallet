/* eslint-disable indent */
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { ToolsContext, ToolsContextType, useI18n } from '@qbit/wallet-state';
import { Loading } from '../components/ActionComponent/Loading';
import { Tip } from '../components/ActionComponent/Tip';
import { Toast, ToastPresets, ToastProps } from '../components/ActionComponent/Toast';
import { copyToClipboard } from '../utils';

type ToastFunction = (content: string) => void;
type LoadingFunction = (visible: boolean, content?: string) => void;

/**
 * Hosts the toast stack above every other layer of the UI.
 *
 * Popovers, bottom sheets and tooltips all render `position: fixed` at
 * z-index 1000, and `BottomModal` portals into `document.body`. A toast overlay
 * rendered inside `#root` at the same z-index therefore loses on DOM order and
 * disappears behind e.g. the network switcher. The overlay is portaled into
 * `document.body` and stacked above those layers by its own z-index (see
 * `Toast/index.less`), and where the Popover API is available it is also
 * promoted to the browser's top layer, which no z-index can paint over.
 */
function ToastOverlay({ children }: { children: React.ReactNode }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || typeof overlay.showPopover !== 'function') {
      return;
    }
    // `popover` is applied here rather than in JSX so browsers without the API
    // never see it and stay on the z-index fallback.
    overlay.setAttribute('popover', 'manual');
    try {
      overlay.showPopover();
    } catch {
      // Some engines throw instead of ignoring an ineligible element; the
      // z-index fallback still keeps the stack visible.
    }
  }, []);

  return createPortal(
    <div ref={overlayRef} className="toast-overlay">
      {children}
    </div>,
    document.body
  );
}

function ToastContainer({ handler }: { handler: ToolsContextType }) {
  const [toasts, setToasts] = useState<{ key: string; props: ToastProps }[]>([]);

  const selfRef = useRef<{ toasts: { key: string; props: ToastProps }[] }>({
    toasts: []
  });
  const self = selfRef.current;
  const basicToast = useCallback(
    (content: string, preset?: ToastPresets) => {
      const resolvedPreset: ToastPresets = preset || 'info';
      const key = 'Toast_' + Math.random();
      const toast = {
        key,
        props: {
          preset: resolvedPreset,
          content,
          onClose: () => {
            self.toasts = self.toasts.filter((v) => v.key !== key);
            setToasts(self.toasts.map((v) => v));
          }
        }
      };
      // Only one error toast may be active: the fresh key remounts it so the
      // countdown restarts instead of stacking duplicate dismiss controls.
      const others = resolvedPreset === 'error' ? self.toasts.filter((v) => v.props.preset !== 'error') : self.toasts;
      self.toasts = [...others, toast];
      setToasts(self.toasts.map((v) => v));
    },
    [self]
  );

  handler.toast = useCallback(
    (content: string) => {
      basicToast(content);
    },
    [basicToast]
  );

  handler.toastSuccess = useCallback(
    (content: string) => {
      basicToast(content, 'success');
    },
    [basicToast]
  );

  handler.toastError = useCallback(
    (content: string) => {
      basicToast(content, 'error');
    },
    [basicToast]
  );

  handler.toastWarning = useCallback(
    (content: string) => {
      basicToast(content, 'warning');
    },
    [basicToast]
  );

  if (toasts.length === 0) {
    return null;
  }
  return (
    <ToastOverlay>
      {toasts.map(({ key, props }) => (
        <Toast key={key} {...props} />
      ))}
    </ToastOverlay>
  );
}

function LoadingContainer({ handler }: { handler: ToolsContextType }) {
  const [loadingInfo, setLoadingInfo] = useState<{ visible: boolean; content?: string }>({
    visible: false,
    content: ''
  });
  handler.showLoading = useCallback((visible: boolean, content?: string) => {
    setLoadingInfo({ visible, content });
  }, []);
  if (loadingInfo.visible) {
    return <Loading text={loadingInfo.content} />;
  } else {
    return <div />;
  }
}

function TipContainer({ handler }: { handler: ToolsContextType }) {
  const [tipData, setTipData] = useState<{ visible: boolean; content: string }>({
    visible: false,
    content: ''
  });
  handler.showTip = useCallback((content: string) => {
    setTipData({ content, visible: true });
  }, []);
  if (tipData.visible) {
    return (
      <Tip
        text={tipData.content}
        onClose={() => {
          setTipData({ visible: false, content: '' });
        }}
      />
    );
  } else {
    return <div />;
  }
}

function CopyContainer({ handler }: { handler: ToolsContextType }) {
  const { t } = useI18n();
  handler.copyToClipboard = useCallback((text: string) => {
    copyToClipboard(text).then(() => {
      handler.toastSuccess(t('copied'));
    });
  }, []);
  return <div />;
}

const initContext = {
  toast: (content: string) => {
    // todo
  },
  toastSuccess: (content: string) => {
    // todo
  },
  toastError: (content: string) => {
    // todo
  },
  toastWarning: (content: string) => {
    // todo
  },
  showLoading: () => {
    // todo
  },
  showTip: (content: string) => {
    // todo
  },
  copyToClipboard: (text: string) => {
    // todo
  },
  openUrl: (url: string) => {
    window.open(url);
  }
};

export function ToolsProvider({ children }: { children: React.ReactNode }) {
  const selfRef = useRef<ToolsContextType>(initContext);
  const self = selfRef.current;

  return (
    <ToolsContext.Provider value={self}>
      {children}
      <ToastContainer handler={self} />
      <LoadingContainer handler={self} />
      <TipContainer handler={self} />
      <CopyContainer handler={self} />
    </ToolsContext.Provider>
  );
}
