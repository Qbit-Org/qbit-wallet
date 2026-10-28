import React, { CSSProperties, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { colors } from '@/ui/theme/colors';

interface BottomModalProps {
  children: React.ReactNode;
  onClose?: () => void;
  bodyStyle?: CSSProperties;
}

export const BottomModal = ({ children, onClose, bodyStyle }: BottomModalProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [portalReady, setPortalReady] = useState(false);

  useEffect(() => {
    setPortalReady(true);
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    if (!onClose) return;

    setIsVisible(false);
    setTimeout(() => {
      onClose();
    }, 300);
  };

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
        <div style={resolvedBodyStyle}>{children}</div>
      </div>
    </div>,
    document.body
  );
};
