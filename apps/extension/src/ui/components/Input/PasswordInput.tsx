import { isNull } from 'lodash';
import { useState } from 'react';

import { Icon } from '@/ui/components';
import { spacing } from '@/ui/theme/spacing';
import { useI18n } from '@qbit/wallet-state';

import { $baseContainerStyle, $baseInputStyle, InputProps } from '.';

export function PasswordInput(props: InputProps) {
  const { placeholder, containerStyle, style: $inputStyleOverride, ...rest } = props;
  const { t } = useI18n();
  const [type, setType] = useState<'password' | 'text'>('password');
  const $style = Object.assign(
    {},
    $baseInputStyle,
    { padding: `${spacing.extraSmall}px 0 ${spacing.extraSmall}px ${spacing.medium}px` },
    $inputStyleOverride
  );
  return (
    <div style={Object.assign({}, $baseContainerStyle, containerStyle)}>
      <input placeholder={isNull(placeholder) ? t('password') : placeholder} type={type} style={$style} {...rest} />
      {type === 'password' && (
        <Icon
          icon="eye-slash"
          containerStyle={{ marginLeft: spacing.tiny, marginRight: spacing.extraSmall }}
          onClick={() => setType('text')}
          color="textDim"
        />
      )}
      {type === 'text' && (
        <Icon
          icon="eye"
          containerStyle={{ marginLeft: spacing.tiny, marginRight: spacing.extraSmall }}
          onClick={() => setType('password')}
        />
      )}
    </div>
  );
}
