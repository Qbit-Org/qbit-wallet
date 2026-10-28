import { VersionDetail } from '@qbit/wallet-shared';

import { colors } from '@/ui/theme/colors';
import { Button } from '../Button';
import { Column } from '../Column';
import { Popover } from '../Popover';

interface VersionNoticeProps {
  notice: VersionDetail;
  onClose: () => void;
}

export const VersionNotice = ({ notice, onClose }: VersionNoticeProps) => {
  const { version, notice: noticeText } = notice;

  const lines = noticeText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !!line);

  const features = lines;

  return (
    <Popover
      contentStyle={{
        width: 270,
        flexShrink: 0,
        borderRadius: 0,
        background: colors.surface,
        color: colors.text,
        border: `1px solid ${colors.border}`,
        boxShadow: '0 24px 54px rgba(7, 17, 11, 0.14)',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 0
      }}
    >
      <Column style={{ flex: 1, justifyContent: 'flex-start', alignItems: 'center' }} gap="md">
        <div
          style={{
            display: 'flex',
            height: 24,
            flexDirection: 'column',
            justifyContent: 'center',
            flexShrink: 0,
            color: colors.text,
            textAlign: 'center',
            fontFamily: 'Inter-Regular',
            fontSize: 16,
            fontStyle: 'normal',
            fontWeight: 500,
            lineHeight: 'normal',
            margin: '24px auto 0 auto'
          }}
        >
          {`Version ${version} Updates`}
        </div>
        <Column
          gap="sm"
          style={{ width: '100%', margin: '16px 0 24px 0', alignItems: 'center', height: 72, overflowY: 'auto' }}
        >
          {features.map((f, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'flex-start',
                width: 220,
                minHeight: 24,
                color: colors.textDim,
                fontFamily: 'Inter-Regular',
                fontSize: 12,
                fontStyle: 'normal',
                fontWeight: 400,
                lineHeight: '20px',
                textAlign: 'left',
                margin: '0 auto'
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: 0,
                  background: colors.accent,
                  marginTop: 7,
                  marginRight: 8,
                  flexShrink: 0
                }}
              />
              <span style={{ flex: 1 }}>{f}</span>
            </div>
          ))}
        </Column>
      </Column>
      <div style={{ padding: '0 16px 24px 16px', width: '100%', boxSizing: 'border-box' }}>
        <Button text="Continue" full preset="defaultV2" onClick={onClose} />
      </div>
    </Popover>
  );
};
