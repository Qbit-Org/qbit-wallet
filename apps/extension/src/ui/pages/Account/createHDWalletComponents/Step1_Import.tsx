import { useState } from 'react';

import { Button, Card, Column, Grid, Input, Radio, RadioGroup, Row, Text } from '@/ui/components';
import { FooterButtonContainer } from '@/ui/components/FooterButtonContainer';
import { ContextData, UpdateContextDataParams } from '@/ui/pages/Account/createHDWalletComponents/types';
import { colors } from '@/ui/theme/colors';
import { spacingGap } from '@/ui/theme/spacing';
import { useCreateWalletLogicImportWordsStep } from '@qbit/wallet-state';

export function Step1_Import(params: {
  contextData: ContextData;
  updateContextData: (params: UpdateContextDataParams) => void;
}) {
  const { contextData } = params;

  const [curInputIndex, setCurInputIndex] = useState(0);

  const {
    wordsItems,
    t,
    onHandleEventPaste,
    inputWords,
    inputWordsInvalid,
    inputWordsError,
    onClickNext,
    onClickWordsItem,
    onInputWordsChange,
    disabled
  } = useCreateWalletLogicImportWordsStep(params as any);

  const handleOnKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!disabled && 'Enter' == e.key) {
      onClickNext();
    }
  };

  return (
    <Column gap="lg">
      <Text text={t('secret_recovery_phrase')} preset="title-bold" textCenter />
      <Text text={t('import_an_existing_wallet_with_your_secret_recover')} preset="sub" textCenter />

      {wordsItems.length > 1 ? (
        <Row justifyCenter>
          <RadioGroup
            onChange={(value) => {
              onClickWordsItem(wordsItems[value]);
            }}
            value={contextData.wordsType}
          >
            {wordsItems.map((v) => (
              <Radio key={v.key} value={v.key}>
                {v.label}
              </Radio>
            ))}
          </RadioGroup>
        </Row>
      ) : null}

      <Row justifyCenter>
        <Grid columns={2}>
          {inputWords.map((_, index) => {
            // Flag a word outside the list only once the user has left its input.
            const invalid = inputWordsInvalid[index] && index !== curInputIndex;
            return (
              <Row key={index}>
                <Card
                  gap="zero"
                  style={
                    invalid
                      ? { paddingLeft: spacingGap.sm, border: `1px solid ${colors.dangerText}` }
                      : { paddingLeft: spacingGap.sm }
                  }
                  onClick={(event) => {
                    event.currentTarget.querySelector('input')?.focus();
                  }}
                  data-testid={`mnemonic-import-word-container-${index}`}
                >
                  <Text text={`${index + 1}. `} style={{ width: 25 }} textEnd color="textDim" />
                  <Input
                    containerStyle={{
                      width: 100,
                      minHeight: 25,
                      height: 25,
                      padding: 0,
                      border: 'none',
                      boxShadow: 'none'
                    }}
                    style={{ padding: '0 4px' }}
                    value={_}
                    onPaste={(e) => {
                      onHandleEventPaste(e, index);
                    }}
                    onChange={(e) => {
                      onInputWordsChange(e, index);
                    }}
                    onFocus={(e) => {
                      setCurInputIndex(index);
                    }}
                    onBlur={(e) => {
                      setCurInputIndex(999);
                    }}
                    onKeyUp={(e) => handleOnKeyUp(e as React.KeyboardEvent<HTMLInputElement>)}
                    autoFocus={index == curInputIndex}
                    preset={'password'}
                    placeholder=""
                    aria-invalid={invalid}
                    data-invalid={invalid}
                    data-testid={`mnemonic-import-word-${index}`}
                  />
                </Card>
              </Row>
            );
          })}
        </Grid>
      </Row>

      {inputWordsError ? (
        <Text
          text={t('recovery_phrase_is_not_valid')}
          color="dangerText"
          size="xs"
          textCenter
          data-testid="mnemonic-import-invalid-phrase"
        />
      ) : null}

      <FooterButtonContainer>
        <Button
          disabled={disabled}
          text={t('continue')}
          preset="primary"
          onClick={() => {
            onClickNext();
          }}
          data-testid="mnemonic-import-continue-button"
        />
      </FooterButtonContainer>
    </Column>
  );
}
