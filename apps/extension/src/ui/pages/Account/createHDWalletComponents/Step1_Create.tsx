import { CheckboxChangeEvent } from 'antd/lib/checkbox';
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, Checkbox, Column, Grid, Radio, RadioGroup, Row, Text } from '@/ui/components';
import { FooterButtonContainer } from '@/ui/components/FooterButtonContainer';
import { ContextData, TabType, UpdateContextDataParams } from '@/ui/pages/Account/createHDWalletComponents/types';
import { fontSizes } from '@/ui/theme/font';
import { WordsType } from '@qbit/wallet-shared';
import { useI18n, useWallet } from '@qbit/wallet-state';

export function Step1_Create({
  contextData,
  updateContextData
}: {
  contextData: ContextData;
  updateContextData: (params: UpdateContextDataParams) => void;
}) {
  const [checked, setChecked] = useState(false);
  const { t } = useI18n();
  const wallet = useWallet();
  const mnemonicStrength = useMemo(() => (contextData.wordsType === WordsType.WORDS_24 ? 256 : 128), [contextData.wordsType]);
  const mnemonicWordCount = contextData.mnemonics.trim() ? contextData.mnemonics.trim().split(/\s+/).length : 0;
  const expectedWordCount = mnemonicStrength === 256 ? 24 : 12;
  const mnemonicReady = mnemonicWordCount === expectedWordCount;

  useEffect(() => {
    let active = true;

    const init = async () => {
      // This step remounts when the user returns from verification. Reuse the
      // phrase held by the parent wizard unless the selected word count changed.
      if (mnemonicReady) {
        return;
      }
      setChecked(false);
      const _mnemonics = await wallet.generatePreMnemonic(mnemonicStrength);
      if (!active) {
        return;
      }
      updateContextData({
        mnemonics: _mnemonics,
        step1CreateWordsCompleted: false
      });
    };

    init();
    return () => {
      active = false;
    };
  }, [mnemonicStrength, mnemonicWordCount]);

  const onChange = (e: CheckboxChangeEvent) => {
    const val = e.target.checked;
    setChecked(val);
    updateContextData({ step1CreateWordsCompleted: false });
  };

  const btnClick = () => {
    updateContextData({
      tabType: TabType.VERIFY_WORDS
    });
  };

  const words = contextData.mnemonics.split(' ');
  return (
    <Column gap="xl">
      <Text text={t('secret_recovery_phrase')} preset="title-bold" textCenter data-testid="mnemonic-title" />
      <Text text={t('this_phrase_is_the_only_way_to_recover_your_wallet')} color="warning" textCenter />
      <Row justifyCenter>
        <RadioGroup
          onChange={(value) => {
            updateContextData({ wordsType: value });
          }}
          value={contextData.wordsType}>
          <Radio value={WordsType.WORDS_12}>{t('mnemonics_12_words')}</Radio>
          <Radio value={WordsType.WORDS_24}>{t('mnemonics_24_words')}</Radio>
        </RadioGroup>
      </Row>

      <Row justifyCenter>
        <Grid columns={2}>
          {words.map((v, index) => {
            return (
              <Row key={index}>
                <Text text={`${index + 1}. `} style={{ width: 40 }} />
                <Card preset="style2" style={{ width: 200 }} data-index={index} data-testid={`mnemonic-word-${index}`}>
                  <Text text={v} selectText disableTranslate />
                </Card>
              </Row>
            );
          })}
        </Grid>
      </Row>

      <Row justifyCenter>
        <Checkbox
          disabled={!mnemonicReady}
          onChange={onChange}
          checked={checked}
          style={{ fontSize: fontSizes.sm }}
          data-testid="mnemonic-saved-checkbox">
          <Text text={t('i_saved_my_secret_recovery_phrase')} />
        </Checkbox>
      </Row>

      <FooterButtonContainer>
        <Button
          disabled={!checked || !mnemonicReady}
          text={t('continue')}
          preset="primary"
          onClick={btnClick}
          data-testid="mnemonic-continue-button"
        />
      </FooterButtonContainer>
    </Column>
  );
}
