import QRCode from 'qrcode.react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, Card, Column, Row, Spin, Text } from '@/ui/components';
import {
  createMessageDecoder,
  encodeSignRequest,
  getSignTypeDisplayName,
  normalizeSignType,
  type MsgSignRequest,
  type MsgSignResult
} from '@/shared/animatedQr';
import { useI18n, useWallet } from '@qbit/wallet-state';

import MultiQRDisplay from '../MultiQRDisplay';
import ColdWalletScan from './Scan';

enum SignMessageTab {
  DETAILS = 'details',
  QRCODE = 'qrcode',
  SCAN = 'scan'
}

interface ColdWalletSignMessageProps {
  messages: { text: string; type: string }[];
  onSuccess: (signatures: string[]) => void;
  onCancel: () => void;
  header?: React.ReactNode;
  origin?: string;
}

export default function ColdWalletSignMessage({
  messages,
  onSuccess,
  onCancel,
  header,
  origin
}: ColdWalletSignMessageProps) {
  const { t } = useI18n();
  const wallet = useWallet();

  // Tab state using enum
  const [activeTab, setActiveTab] = useState<SignMessageTab>(SignMessageTab.DETAILS);
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const [signatures, setSignatures] = useState<string[]>([]);
  const [qrData, setQrData] = useState<{ qrParts: string[]; isMultiPart: boolean } | null>(null);
  const [messageDecoder] = useState(() => createMessageDecoder());

  const currentMessage = messages[currentMessageIndex];
  const currentSignature = signatures[currentMessageIndex];
  const isCurrentMessageSigned = !!currentSignature;

  const requestId = useMemo(() => {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${currentMessageIndex}`;
  }, [currentMessageIndex]);

  const generateQRCode = useCallback(async () => {
    if (!currentMessage || isCurrentMessageSigned) return;

    try {
      const currentAccount = await wallet.getCurrentAccount();
      if (!currentAccount) throw new Error('No current account');

      const msgSignRequest: MsgSignRequest = {
        type: 'MSG_SIGN',
        message: currentMessage.text,
        expectedSignerPubkey: currentAccount.pubkey,
        signType: normalizeSignType(currentMessage.type),
        // The origin of the request being signed, from the screen that
        // rendered it, not the pending approval's: another may have replaced it.
        origin,
        timestamp: Date.now(),
        requestId
      };

      const encoded = encodeSignRequest(msgSignRequest, {
        maxQRSize: 300,
        compression: true
      });

      setQrData({
        qrParts: encoded.qrParts,
        isMultiPart: encoded.isMultiPart
      });
    } catch (error) {
      console.error('Failed to generate QR code:', error);
      setQrData(null);
    }
  }, [currentMessage, isCurrentMessageSigned, wallet, origin, requestId]);

  useEffect(() => {
    if (activeTab === SignMessageTab.QRCODE) {
      generateQRCode();
    }
  }, [activeTab, generateQRCode]);

  useEffect(() => {
    if (activeTab === SignMessageTab.SCAN && !qrData) {
      setActiveTab(SignMessageTab.QRCODE);
    }
  }, [activeTab, qrData]);

  const handleScanSuccess = useCallback(
    async (data: string | MsgSignResult) => {
      try {
        let result: MsgSignResult;

        if (typeof data === 'object' && data.type === 'MSG_SIGN_RESULT') {
          result = data as MsgSignResult;
        } else if (typeof data === 'string') {
          const decodeResult = messageDecoder.addPart(data);
          if (decodeResult?.isComplete && decodeResult.data?.type === 'MSG_SIGN_RESULT') {
            result = decodeResult.data as MsgSignResult;
          } else {
            return; // Not complete or invalid
          }
        } else {
          return; // Invalid data
        }

        // Verify the signature was created by the expected account
        const currentAccount = await wallet.getCurrentAccount();
        if (result.publicKey && result.publicKey !== currentAccount.pubkey) {
          throw new Error('Signature was created with wrong account');
        }

        // Update signature for current message
        const newSignatures = [...signatures];
        newSignatures[currentMessageIndex] = result.signature;
        setSignatures(newSignatures);

        // Check if all messages are signed
        if (newSignatures.length === messages.length && newSignatures.every((sig) => sig)) {
          onSuccess(newSignatures);
          return;
        }

        // Move to next unsigned message
        const nextIndex = newSignatures.findIndex((sig) => !sig);
        if (nextIndex !== -1) {
          setCurrentMessageIndex(nextIndex);
          setActiveTab(SignMessageTab.DETAILS);
        }
      } catch (error) {
        console.error('Failed to parse scan result:', error);
      }
    },
    [signatures, messages.length, currentMessageIndex, onSuccess, messageDecoder]
  );

  const handleScanResult = useCallback(
    (data: string | MsgSignResult | any) => {
      if (typeof data === 'string' || (typeof data === 'object' && data?.type === 'MSG_SIGN_RESULT')) {
        handleScanSuccess(data as string | MsgSignResult).catch((error) => {
          console.error('Failed to handle scan success:', error);
        });
      }
    },
    [handleScanSuccess]
  );

  const getPrimaryButtonConfig = () => {
    if (isCurrentMessageSigned) {
      return {
        text: t('completed'),
        onClick: undefined,
        disabled: false
      };
    }

    // Tab-specific button configurations
    const tabConfigs = {
      [SignMessageTab.DETAILS]: {
        text: t('msg_generate_qr'),
        onClick: () => setActiveTab(SignMessageTab.QRCODE),
        disabled: false
      },
      [SignMessageTab.QRCODE]: {
        text: qrData ? t('msg_scan_sign') : t('generating'),
        onClick: () => qrData && setActiveTab(SignMessageTab.SCAN),
        disabled: !qrData
      },
      [SignMessageTab.SCAN]: {
        text: t('msg_waiting_sign'),
        onClick: undefined,
        disabled: false
      }
    };

    return (
      tabConfigs[activeTab] || {
        text: t('msg_start_sign'),
        onClick: undefined,
        disabled: false
      }
    );
  };

  const handlePrevMessage = () => {
    if (currentMessageIndex > 0) {
      setCurrentMessageIndex(currentMessageIndex - 1);
      setActiveTab(SignMessageTab.DETAILS);
    }
  };

  const handleNextMessage = () => {
    if (currentMessageIndex < messages.length - 1) {
      setCurrentMessageIndex(currentMessageIndex + 1);
      setActiveTab(SignMessageTab.DETAILS);
    }
  };

  const renderDetailsTab = () => (
    <Column>
      <Card>
        <Column>
          <Text text={t('msg_content')} preset="title-bold" color="textDim" />
          <Card style={{ backgroundColor: 'var(--qbit-canvas)', padding: 12, marginTop: 8 }}>
            <Text
              text={currentMessage?.text || ''}
              preset="regular"
              style={{
                fontFamily: 'monospace',
                fontSize: 12,
                wordBreak: 'break-all',
                maxHeight: 200,
                overflow: 'auto'
              }}
            />
          </Card>

          <Row mt="md">
            <Column style={{ flex: 1 }}>
              <Text text={t('msg_sign_type')} preset="sub" color="textDim" />
              <Text text={getSignTypeDisplayName(normalizeSignType(currentMessage?.type))} preset="regular" />
            </Column>
            <Column style={{ flex: 1 }}>
              <Text text={t('msg_status')} preset="sub" color="textDim" />
              <Text
                text={isCurrentMessageSigned ? t('msg_signed') : t('msg_pending')}
                preset="regular"
                color={isCurrentMessageSigned ? 'green' : 'warning'}
              />
            </Column>
          </Row>

          {origin && (
            <Row mt="sm">
              <Text text={t('msg_origin')} preset="sub" color="textDim" />
              <Text text={origin} preset="regular" />
            </Row>
          )}
        </Column>
      </Card>
    </Column>
  );

  const renderQRCodeTab = () => (
    <Column>
      <Card
        style={{
          textAlign: 'center',
          minHeight: '300px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center'
        }}
      >
        {isCurrentMessageSigned ? (
          <Column style={{ alignItems: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
            <Text text={t('msg_already_signed')} preset="sub" color="green" />
          </Column>
        ) : qrData ? (
          <Column style={{ alignItems: 'center' }}>
            <Text text={t('msg_scan_qr_code')} preset="sub" color="textDim" style={{ marginBottom: '16px' }} />
            {qrData.isMultiPart ? (
              <MultiQRDisplay parts={qrData.qrParts} size={280} autoPlay={true} interval={1000} showControls={true} />
            ) : (
              <QRCode
                value={qrData.qrParts[0]}
                size={280}
                level="L"
                includeMargin={true}
                bgColor="#FFFFFF"
                fgColor="#000000"
              />
            )}
          </Column>
        ) : (
          <Column style={{ alignItems: 'center' }}>
            <Spin size="large" style={{ marginBottom: '16px' }} />
            <Text text={t('msg_generating_qr')} preset="sub" color="textDim" />
          </Column>
        )}
      </Card>
    </Column>
  );

  const renderScanTab = () => (
    <Column full>
      <ColdWalletScan onSucceed={handleScanResult} size={256} />
    </Column>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        position: 'relative'
      }}
    >
      {header}

      {/* Scrollable Content Area */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          paddingBottom: '80px'
        }}
      >
        <Card>
          <Column>
            <Text text={t('msg_sign')} preset="title-bold" color="textDim" />
            <Text
              text={`${t('msg_message')} ${currentMessageIndex + 1} / ${messages.length}`}
              preset="sub"
              color="textDim"
            />
          </Column>
        </Card>

        {/* Tab Navigation */}
        <Card style={{ padding: 0, marginBottom: 16 }}>
          <Row style={{ borderBottom: '1px solid var(--qbit-line)' }}>
            <div
              onClick={() => setActiveTab(SignMessageTab.DETAILS)}
              style={{
                flex: 1,
                padding: '12px 4px',
                textAlign: 'center',
                cursor: 'pointer',
                borderBottom:
                  activeTab === SignMessageTab.DETAILS ? '2px solid var(--qbit-accent)' : '2px solid transparent',
                color: activeTab === SignMessageTab.DETAILS ? 'var(--qbit-accent-dark)' : 'var(--qbit-muted)',
                fontSize: 12,
                fontWeight: activeTab === SignMessageTab.DETAILS ? '600' : '400',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap'
              }}
            >
              1. {t('msg_detail')}
            </div>
            <div
              onClick={() => setActiveTab(SignMessageTab.QRCODE)}
              style={{
                flex: 1,
                padding: '12px 4px',
                textAlign: 'center',
                cursor: 'pointer',
                borderBottom:
                  activeTab === SignMessageTab.QRCODE ? '2px solid var(--qbit-accent)' : '2px solid transparent',
                color: activeTab === SignMessageTab.QRCODE ? 'var(--qbit-accent-dark)' : 'var(--qbit-muted)',
                fontSize: 12,
                fontWeight: activeTab === SignMessageTab.QRCODE ? '600' : '400',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap'
              }}
            >
              2. {t('msg_generate_sign')}
            </div>
            <div
              onClick={() => (!qrData ? null : setActiveTab(SignMessageTab.SCAN))}
              style={{
                flex: 1,
                padding: '12px 4px',
                textAlign: 'center',
                cursor: !qrData ? 'not-allowed' : 'pointer',
                borderBottom:
                  activeTab === SignMessageTab.SCAN ? '2px solid var(--qbit-accent)' : '2px solid transparent',
                color: !qrData
                  ? 'rgba(79, 96, 86, 0.45)'
                  : activeTab === SignMessageTab.SCAN
                  ? 'var(--qbit-accent-dark)'
                  : 'var(--qbit-muted)',
                fontSize: 12,
                fontWeight: activeTab === SignMessageTab.SCAN ? '600' : '400',
                transition: 'all 0.2s ease',
                whiteSpace: 'nowrap',
                opacity: !qrData ? 0.5 : 1
              }}
            >
              3. {t('msg_scan_result')}
            </div>
          </Row>
        </Card>

        {/* Tab Content */}
        {activeTab === SignMessageTab.DETAILS && renderDetailsTab()}
        {activeTab === SignMessageTab.QRCODE && renderQRCodeTab()}
        {activeTab === SignMessageTab.SCAN && renderScanTab()}
      </div>

      {/* Fixed Bottom Actions */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'linear-gradient(to top, var(--qbit-canvas) 0%, var(--qbit-canvas) 65%, transparent 100%)',
          padding: '16px',
          paddingTop: '24px'
        }}
      >
        <Row>
          <Button text={t('cancel')} preset="default" onClick={onCancel} style={{ flex: 1, marginRight: 8 }} />

          {messages.length > 1 && (
            <>
              <Button
                text={t('previous')}
                preset="default"
                onClick={handlePrevMessage}
                disabled={currentMessageIndex === 0}
                style={{ marginRight: 8 }}
              />
              <Button
                text={t('next')}
                preset="default"
                onClick={handleNextMessage}
                disabled={currentMessageIndex === messages.length - 1}
                style={{ marginRight: 8 }}
              />
            </>
          )}

          <Button
            text={getPrimaryButtonConfig().text}
            preset="primary"
            onClick={getPrimaryButtonConfig().onClick}
            disabled={getPrimaryButtonConfig().disabled}
            style={{ flex: 1 }}
          />
        </Row>
      </div>
    </div>
  );
}
