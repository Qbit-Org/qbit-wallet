import { Icon, Row, Text } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { spacing } from '@/ui/theme/spacing';
import { useI18n } from '@qbit/wallet-state';

import './WebsiteCheckWarning.less';

export type WebsiteCheckWarningTestIdPrefix = '' | 'psbt-' | 'message-';

export interface WebsiteCheckWarningProps {
  /** Verdict-specific copy; falls back to the generic check-failed message. */
  warning?: string;
  /**
   * Restarts website safety checking. Retry never acknowledges trust and never
   * enables an approval; the footer acknowledgement stays the only gate.
   */
  onRetry: () => void;
  /**
   * Surface-specific `data-testid` prefix ('' for Connect, 'psbt-' for
   * SignPsbt, 'message-' for SignMessage) so the existing
   * `<prefix>website-check-warning|error|retry-button` ids are preserved.
   */
  testIdPrefix?: WebsiteCheckWarningTestIdPrefix;
}

/**
 * Compact unverified-site warning shared by the approval surfaces.
 *
 * It keeps the amber treatment and the complete warning copy above the fold
 * while staying visually secondary to the payload being authorized: a small
 * bold title with an alert glyph, secondary-size body copy and a text-style
 * Retry action instead of a full-width button. It is never collapsible,
 * dismissible or hidden.
 */
export default function WebsiteCheckWarning({ warning, onRetry, testIdPrefix = '' }: WebsiteCheckWarningProps) {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      className="approval-website-check-warning"
      style={{
        backgroundColor: colors.warning_bg,
        border: `1px solid ${colors.warning_content}`,
        padding: `${spacing.extraSmall}px ${spacing.small}px`
      }}
      data-testid={`${testIdPrefix}website-check-warning`}
    >
      <Row itemsCenter gap="sm">
        <Icon icon="alert" color="warning" size={16} />
        <Text text={t('warning')} preset="bold" color="warning" />
      </Row>
      <Text
        text={warning || t('website_check_failed')}
        size="xs"
        wrap
        data-testid={`${testIdPrefix}website-check-error`}
      />
      <button
        type="button"
        className="approval-website-check-retry"
        onClick={onRetry}
        data-testid={`${testIdPrefix}website-check-retry-button`}
      >
        {t('try_again')}
      </button>
    </div>
  );
}
