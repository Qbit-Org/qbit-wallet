import { useMemo, useState } from 'react';

import { Button, Card, Column, Input, Row, Text } from '@/ui/components';
import { FooterButtonContainer } from '@/ui/components/FooterButtonContainer';
import { ContextData, TabType, UpdateContextDataParams } from '@/ui/pages/Account/createHDWalletComponents/types';
import { spacingGap } from '@/ui/theme/spacing';
import { useI18n } from '@qbit/wallet-state';

export function Step1_Confirm({
  contextData,
  updateContextData
}: {
  contextData: ContextData;
  updateContextData: (params: UpdateContextDataParams) => void;
}) {
  const words = contextData.mnemonics.split(' ');
  const { t } = useI18n();
  const challengeIndexes = useMemo(() => {
    const last = Math.max(words.length - 1, 0);
    return [Math.min(2, last), Math.min(7, last)];
  }, [words.length]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const verified = challengeIndexes.every(
    (index) => answers[index]?.trim().toLowerCase() === words[index]?.toLowerCase()
  );

  const btnClick = () => {
    updateContextData({
      step1CreateWordsCompleted: true,
      tabType: TabType.CHOOSE_ADDRESS_TYPE
    });
  };

  return (
    <Column gap="xl">
      <Text text={t('verify_recovery_phrase')} preset="title-bold" textCenter />
      <Text text={t('enter_requested_recovery_phrase_words')} color="warning" textCenter />
      <Row justifyCenter>
        <Column gap="lg">
          {challengeIndexes.map((index, position) => {
            return (
              <Row key={index} itemsCenter>
                <Card
                  preset="style2"
                  gap="zero"
                  style={{ width: 200, paddingLeft: spacingGap.sm }}
                  onClick={(event) => {
                    event.currentTarget.querySelector('input')?.focus();
                  }}
                  data-testid={`mnemonic-confirm-word-container-${index}`}
                >
                  <Text text={`${index + 1}. `} style={{ width: 25 }} textEnd color="textDim" />
                  <Input
                    preset="password"
                    containerStyle={{ flex: 1, minWidth: 0, border: 'none', boxShadow: 'none' }}
                    autoFocus={position === 0}
                    value={answers[index] || ''}
                    onChange={(e) => {
                      setAnswers({
                        ...answers,
                        [index]: e.target.value
                      });
                    }}
                    onKeyUp={(event) => {
                      if (event.key === 'Enter' && verified) {
                        btnClick();
                      }
                    }}
                    data-testid={`mnemonic-confirm-word-${index}`}
                  />
                </Card>
              </Row>
            );
          })}
        </Column>
      </Row>
      <FooterButtonContainer>
        <Button
          disabled={!verified}
          text={t('continue')}
          preset="primary"
          onClick={btnClick}
          data-testid="mnemonic-confirm-continue-button"
        />
      </FooterButtonContainer>
    </Column>
  );
}
