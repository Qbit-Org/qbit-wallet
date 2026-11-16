import type { ReactNode } from 'react';

import { Card, Column, Icon, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { SettingsItemType } from '@qbit/wallet-state';

interface SettingsItemRowProps {
  item: SettingsItemType;
  /** The row's test id, for a row whose id is older than this look; the item's key otherwise. */
  testId?: string;
  /** What the setting is set to, shown before the chevron. */
  status?: string;
  /** A control at the row's end, such as a switch. */
  control?: ReactNode;
}

/**
 * One settings row: icon, label, optional badge, then what the row ends with:
 * the setting's status, a control, the chevron. A danger row, such as Reset
 * Wallet, is red, as Remove Wallet is in the account switcher's wallet menu.
 * A label too long for one line wraps, and the row grows with it.
 */
export function SettingsItemRow({ item, testId, status, control }: SettingsItemRowProps) {
  return (
    <Card
      data-testid={testId ?? item.key}
      onClick={item.onClick ? () => item.onClick?.() : undefined}
      style={{
        // 64px with the padding, the height every one-line row has.
        minHeight: '44px',
        flexShrink: 0,
        borderRadius: 0,
        background: colors.surface,
        borderColor: colors.border,
        padding: '10px 16px',
        margin: 0
      }}
    >
      <Row full justifyBetween style={{ alignItems: 'center' }}>
        <Row style={{ minWidth: 0, alignItems: 'center' }}>
          <Icon icon={item.icon as any} size={fontSizes.iconMiddle} color={item.danger ? 'dangerText' : 'textDim'} />
          <Column style={{ gap: spacing.tiny, minWidth: 0, flex: 1, marginLeft: spacing.tiny }}>
            <Row justifyBetween>
              <Text
                text={item.label || item.desc}
                preset="regular"
                size="sm"
                style={{ color: item.danger ? colors.dangerText : colors.text }}
              />
              {item.badge && (
                <Text
                  text={item.badge}
                  preset="badge"
                  style={{
                    marginLeft: '6px'
                  }}
                />
              )}
            </Row>
          </Column>
        </Row>
        <Row style={{ alignItems: 'center', gap: spacing.small, flexShrink: 0 }}>
          {status && <Text text={status} color="gold" size="sm" />}
          {control}
          {item.right && <Icon icon="right" size={fontSizes.lg} color="textDim" />}
        </Row>
      </Row>
    </Card>
  );
}
