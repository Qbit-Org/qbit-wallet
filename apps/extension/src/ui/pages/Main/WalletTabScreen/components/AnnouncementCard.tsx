import { Card, Column, Icon, Image, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { shortDesc } from '@/ui/utils';
import { AnnouncementLinkType } from '@qbit/wallet-shared';
import { useAnnouncementCardLogic, useI18n } from '@qbit/wallet-state';

const CARD_HEIGHT = 130;

export function AnnouncementCard() {
  const { t } = useI18n();
  const { loading, validAnnouncements, current, activeIndex, handleDotClick, handleDismissAll, isLinkable } =
    useAnnouncementCardLogic();

  const handleViewDetails = () => {
    if (!current || !isLinkable(current)) return;
    switch (current.linkType) {
      case AnnouncementLinkType.EXTERNAL_LINK:
      case AnnouncementLinkType.INTERNAL_LINK:
        window.open(current.link);
        break;
      default:
        break;
    }
  };

  if (loading || validAnnouncements.length === 0) return null;

  return (
    <Column justifyCenter>
      <Column
        style={{
          position: 'relative',
          borderRadius: 0,
          border: `1px solid ${colors.border}`,
          background: colors.surface,
          boxShadow: `0 8px 24px ${colors.shadow}`,
          padding: 12,
          gap: 8,
          height: CARD_HEIGHT,
          overflow: 'hidden'
        }}
      >
        {/* Close button */}
        <div
          onClick={handleDismissAll}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            width: 20,
            height: 20,
            borderRadius: 0,
            background: colors.accentWash,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            zIndex: 10
          }}
        >
          <Icon icon="close" size={10} color="accentDark" />
        </div>

        <Image
          src={'./images/icons/artifacts/announcement_art.png'}
          size={64}
          style={{ position: 'absolute', top: 15, right: 15 }}
        />

        {/* Header badge */}
        <Row
          style={{
            display: 'inline-flex',
            background: colors.accentWash,
            borderRadius: 0,
            padding: '2px 8px',
            alignSelf: 'flex-start'
          }}
        >
          <Text text={`📣 ${t('announcement')}`} size="xs" />
        </Row>

        {/* Title & description */}
        <Column style={{ flex: 1, gap: 2 }}>
          <Column
            style={{ maxHeight: isLinkable(current) ? CARD_HEIGHT - 80 : '100%', overflow: 'hidden' }}
            overflowY
            gap={'xs'}
          >
            <Text text={current.title} size="xs" />
            <Text text={shortDesc(current.description, 100)} size="xs" color="textDim" />
          </Column>

          {isLinkable(current) && (
            <Card
              preset="style2"
              style={{ height: 32, backgroundColor: colors.accentWash, marginTop: 'auto' }}
              fullX
              onClick={() => {
                handleViewDetails();
              }}
              data-testid="wallet-management-entry"
            >
              <Text text={t('view_detail')} size="xxs" />
            </Card>
          )}
        </Column>
      </Column>
      {/* Footer: dots  */}
      <Row fullX justifyCenter itemsCenter style={{ marginTop: 'auto' }}>
        <Row style={{ gap: 4 }}>
          {validAnnouncements.length > 1 &&
            validAnnouncements.map((_, i) => (
              <div
                key={i}
                onClick={() => handleDotClick(i)}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 0,
                  background: i === activeIndex ? colors.accent : colors.line,
                  cursor: 'pointer'
                }}
              />
            ))}
        </Row>
      </Row>
    </Column>
  );
}
