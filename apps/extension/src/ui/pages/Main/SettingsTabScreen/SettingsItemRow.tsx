import { Card, Column, Icon, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { fontSizes } from '@/ui/theme/font';
import { spacing } from '@/ui/theme/spacing';
import { SettingsItemType } from '@qbit/wallet-state';

/**
 * One settings navigation row: icon, label, optional badge and the chevron.
 * A danger row, such as Reset Wallet, is red, as Remove Wallet is in the
 * account switcher's wallet menu.
 */
export function SettingsItemRow({ item }: { item: SettingsItemType }) {
  return (
    <Card
      data-testid={item.key}
      onClick={() => item.onClick && item.onClick()}
      style={{
        height: '64px',
        flexShrink: 0,
        borderRadius: 0,
        background: colors.surface,
        borderColor: colors.border,
        padding: '0 16px',
        margin: 0
      }}
    >
      <Row full justifyBetween style={{ height: '100%', alignItems: 'center' }}>
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
        <Row style={{ alignItems: 'center', gap: spacing.small }}>
          {item.right && <Icon icon="right" size={fontSizes.lg} color="textDim" />}
        </Row>
      </Row>
    </Card>
  );
}
