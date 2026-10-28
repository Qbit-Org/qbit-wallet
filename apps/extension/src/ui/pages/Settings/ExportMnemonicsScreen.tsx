import type { KeyboardEvent } from 'react';
import { useState } from 'react';

import { Button, Card, Column, Content, Grid, Header, Icon, Input, Layout, Row, Text, TextArea } from '@/ui/components';
import { colors } from '@/ui/theme/colors';
import { useExportMnemonicsScreenLogic } from '@qbit/wallet-state';

const $copyableTextAreaStyle = { border: `1px solid ${colors.border}` };

export default function ExportMnemonicsScreen() {
  const {
    words,
    pathName,
    t,
    setPassword,
    disabled,
    btnClick,
    handleOnKeyUp,
    mnemonic,
    passphrase,
    p2mrDescriptors,
    importDescriptorsJson,
    isP2mrKeyring,
    error,
    copy,
    keyring,
    onClickBack
  } = useExportMnemonicsScreenLogic();

  const [showRecoveryDescriptors, setShowRecoveryDescriptors] = useState(false);
  const [showImportDescriptorsJson, setShowImportDescriptorsJson] = useState(false);

  const downloadImportDescriptors = () => {
    if (!importDescriptorsJson || !p2mrDescriptors) {
      return;
    }
    const blob = new Blob([importDescriptorsJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `qbit-p2mr-importdescriptors-${p2mrDescriptors.network}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Layout>
      <Header onBack={onClickBack} title={t('secret_recovery_phrase')} />

      <Content>
        {mnemonic == '' ? (
          <Column>
            <Card>
              <Column gap="lg">
                <Text
                  text={t('if_you_lose_your_secret_recovery_phrase_your_asset')}
                  preset="title-bold"
                  size="sm"
                  color="dangerText"
                />

                <Text
                  text={t('if_you_share_the_secret_recovery_phrase_to_others_')}
                  preset="title-bold"
                  size="sm"
                  color="dangerText"
                />

                <Text
                  text={t('secret_recovery_phrase_is_only_stored_in_your_brow')}
                  preset="title-bold"
                  size="sm"
                  color="dangerText"
                />
              </Column>
            </Card>

            <Text
              text={t('please_make_sure_you_have_read_the_security_tips_a')}
              preset="title"
              size="sm"
              color="warning"
              textCenter
              my="xl"
            />
            <Input
              preset="password"
              placeholder={t('enter_password')}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              onKeyUp={(e: KeyboardEvent<HTMLInputElement>) => handleOnKeyUp(e)}
              autoFocus={true}
            />
            {error && <Text text={error} preset="regular" color="dangerText" />}

            <Button disabled={disabled} text={t('show_secret_recovery_phrase')} preset="primary" onClick={btnClick} />
          </Column>
        ) : (
          <Column>
            <Text
              text={t('this_phrase_is_the_only_way_to_recover_your_wallet')}
              color="warning"
              textCenter
              mt="xl"
              mb="xl"
            />

            <Row justifyCenter>
              <Grid columns={2}>
                {words.map((v, index) => {
                  return (
                    <Row key={index}>
                      <Text text={`${index + 1}. `} style={{ width: 40 }} />
                      <Card preset="style2" style={{ width: 200 }}>
                        <Text text={v} selectText disableTranslate />
                      </Card>
                    </Row>
                  );
                })}
              </Grid>
            </Row>
            <Card>
              <Column>
                <Text text={t('advance_options')} />
                <Text
                  text={`${t('derivation_path')}: ${keyring.hdPath}/0 (${pathName})`}
                  preset="sub"
                  onClick={() => {
                    copy(keyring.hdPath);
                  }}
                  disableTranslate
                />
                {passphrase && <Text text={`${t('passphrase')}: ${passphrase}`} preset="sub" disableTranslate />}
              </Column>
            </Card>
            {isP2mrKeyring && p2mrDescriptors && (
              <>
                <Card>
                  <Column fullX style={{ minWidth: 0 }}>
                    <Row
                      fullX
                      justifyBetween
                      itemsCenter
                      onClick={() => {
                        setShowRecoveryDescriptors(!showRecoveryDescriptors);
                      }}
                    >
                      <Text text={t('qbit_core_recovery_descriptors')} preset="bold" />
                      <Icon icon={showRecoveryDescriptors ? 'up' : 'down'} />
                    </Row>
                    {showRecoveryDescriptors && (
                      <Column fullX gap="lg">
                        <Text text={t('qbit_core_descriptor_counter_warning')} color="warning" />
                        <Text
                          text={t('qbit_core_network_value', p2mrDescriptors.network)}
                          preset="sub"
                          disableTranslate
                        />
                        <Column fullX gap="sm">
                          <Text
                            text={t('qbit_core_receive_path_value', p2mrDescriptors.external.path)}
                            preset="sub"
                            disableTranslate
                          />
                          <TextArea
                            text={p2mrDescriptors.external.descriptor}
                            classname="visible-scrollbar"
                            style={$copyableTextAreaStyle}
                          />
                          <Button
                            text={t('qbit_core_copy_receive_descriptor')}
                            preset="default"
                            onClick={() => {
                              copy(p2mrDescriptors.external.descriptor);
                            }}
                          />
                        </Column>
                        <Column fullX gap="sm">
                          <Text
                            text={t('qbit_core_change_path_value', p2mrDescriptors.internal.path)}
                            preset="sub"
                            disableTranslate
                          />
                          <TextArea
                            text={p2mrDescriptors.internal.descriptor}
                            classname="visible-scrollbar"
                            style={$copyableTextAreaStyle}
                          />
                          <Button
                            text={t('qbit_core_copy_change_descriptor')}
                            preset="default"
                            onClick={() => {
                              copy(p2mrDescriptors.internal.descriptor);
                            }}
                          />
                        </Column>
                      </Column>
                    )}
                  </Column>
                </Card>
                <Card>
                  <Column fullX style={{ minWidth: 0 }}>
                    <Row
                      fullX
                      justifyBetween
                      itemsCenter
                      onClick={() => {
                        setShowImportDescriptorsJson(!showImportDescriptorsJson);
                      }}
                    >
                      <Text text={t('qbit_core_importdescriptors_json')} preset="bold" />
                      <Icon icon={showImportDescriptorsJson ? 'up' : 'down'} />
                    </Row>
                    {showImportDescriptorsJson && (
                      <Column fullX gap="sm">
                        <TextArea
                          text={importDescriptorsJson}
                          classname="visible-scrollbar"
                          style={{ ...$copyableTextAreaStyle, maxHeight: 120 }}
                        />
                        <Row fullX>
                          <Button
                            text={t('qbit_core_copy_json')}
                            preset="default"
                            full
                            onClick={() => {
                              copy(importDescriptorsJson);
                            }}
                          />
                          <Button
                            text={t('qbit_core_download_json')}
                            preset="default"
                            full
                            onClick={downloadImportDescriptors}
                          />
                        </Row>
                        <Text
                          text={`Provenance: ${p2mrDescriptors.coreProvenance.repository}@${p2mrDescriptors.coreProvenance.commit} ${p2mrDescriptors.coreProvenance.source}`}
                          preset="sub"
                          wrap
                          disableTranslate
                        />
                      </Column>
                    )}
                  </Column>
                </Card>
              </>
            )}
          </Column>
        )}
      </Content>
    </Layout>
  );
}
