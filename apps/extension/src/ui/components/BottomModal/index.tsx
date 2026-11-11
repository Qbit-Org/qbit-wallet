import React, { CSSProperties, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { colors } from '@/ui/theme/colors';

interface BottomModalProps {
  children: React.ReactNode;
  onClose?: () => void;
  bodyStyle?: CSSProperties;
  /**
   * The widest the sheet gets. In a wider window it is centered, with the
   * dimmed page on both sides; without it the sheet spans the window.
   */
  maxWidth?: number;
}

const CLOSE_ANIMATION_MS = 300;

interface BottomModalControls {
  /**
   * Slides the sheet out and then calls the modal's `onClose`, as a tap on the
   * overlay does. Does nothing for a modal without `onClose`, or once closing.
   */
  requestClose: () => void;
  /**
   * Whether the sheet has begun to close, by `requestClose` or by a tap on the
   * overlay. It stays true while the sheet slides out, so its content can
   * ignore taps meanwhile.
   */
  closing: boolean;
}

const BottomModalContext = createContext<BottomModalControls>({ requestClose: () => undefined, closing: false });

/** The controls of the BottomModal the calling component is rendered in. */
export const useBottomModal = () => useContext(BottomModalContext);

export const BottomModal = ({ children, onClose, bodyStyle, maxWidth }: BottomModalProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setPortalReady(true);
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 50);
    return () => {
      clearTimeout(timer);
      clearTimeout(closeTimerRef.current);
    };
  }, []);

  const handleClose = useCallback(() => {
    if (!onCloseRef.current || closeTimerRef.current !== undefined) return;

    setIsVisible(false);
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      onCloseRef.current?.();
    }, CLOSE_ANIMATION_MS);
  }, []);

  const controls = useMemo<BottomModalControls>(() => ({ requestClose: handleClose, closing }), [handleClose, closing]);

  const resolvedBodyStyle = Object.assign(
    {
      width: '100%',
      padding: 20,
      boxSizing: 'border-box',
      minHeight: 0,
      overflowY: 'auto'
    } as CSSProperties,
    bodyStyle
  );

  if (!portalReady || typeof document === 'undefined' || !document.body) {
    return null;
  }

  return createPortal(
    <div
      className="popover-container"
      style={{
        backgroundColor: colors.overlay,
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-end',
        transition: 'background-color 0.3s ease',
        opacity: isVisible ? 1 : 0
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) {
          handleClose();
        }
      }}
    >
      <div
        style={{
          backgroundColor: colors.surface,
          width: '100%',
          // Both edges pinned and auto margins: centered once narrower than the window.
          ...(maxWidth === undefined ? {} : { maxWidth, left: 0, right: 0, marginLeft: 'auto', marginRight: 'auto' }),
          borderRadius: 0,
          borderTop: `1px solid ${colors.border}`,
          boxShadow: `0 -8px 24px ${colors.shadow}`,
          position: 'fixed',
          bottom: 0,
          maxHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 0.3s ease-out',
          overflow: 'hidden'
        }}
      >
        <BottomModalContext.Provider value={controls}>
          <div style={resolvedBodyStyle}>{children}</div>
        </BottomModalContext.Provider>
      </div>
    </div>,
    document.body
  );
};
