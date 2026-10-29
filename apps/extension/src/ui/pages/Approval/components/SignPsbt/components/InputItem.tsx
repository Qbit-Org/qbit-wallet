import { useState } from 'react';

import { Column, Icon, Row, Text } from '@/ui/components';
import { AddressText } from '@/ui/components/AddressText';
import { colors } from '@/ui/theme/colors';
import { numUtils } from '@qbit/base-utils';
import {
  DecodedPsbt,
  DecodedPsbtInput,
  DecodedPsbtOpReturnOutput,
  DecodedPsbtOutput,
  ToSignData
} from '@qbit/wallet-shared';
import { useCurrentAddress, useI18n, useQbitUnit } from '@qbit/wallet-state';

function OpReturnOutputItem({
  index,
  outputInfo,
  qbitUnit
}: {
  index: number;
  outputInfo: DecodedPsbtOpReturnOutput;
  qbitUnit: string;
}) {
  const { opReturn } = outputInfo;

  return (
    <Row
      data-testid={`psbt-op-return-output-${index}`}
      style={index === 0 ? {} : { borderColor: colors.border, borderTopWidth: 1, paddingTop: 10 }}
      itemsCenter
    >
      <Column fullX>
        <Row fullX mb="md">
          <Icon icon="psbt_opreturn" size={28} />

          <Column fullX style={{ minWidth: 0 }}>
            <Row justifyBetween fullX>
              <Text text="OP_RETURN / Public data" color="ticker_color2" preset="bold" />
              <Text text={`${numUtils.satoshisToAmount(outputInfo.value)} ${qbitUnit}`} preset="bold" color="text" />
            </Row>

            <Column fullX gap="sm">
              <Text text="Raw script (hex)" color="textDim" size="xs" />
              <Text
                data-testid="op-return-script-hex"
                text={opReturn.scriptPubKeyHex}
                color="text"
                size="xs"
                selectText
                wrap
                disableTranslate
              />

              {opReturn.chunks.map((chunk, chunkIndex) => (
                <Column key={chunkIndex} fullX gap="zero" data-testid={`op-return-chunk-${chunkIndex}`}>
                  <Text
                    text={`Chunk ${chunkIndex + 1}: push header ${chunk.pushHeaderHex}; data bytes [${chunk.dataStartByte}, ${chunk.dataEndByte}); ${chunk.dataByteLength} bytes`}
                    color="textDim"
                    size="xs"
                  />
                  <Text
                    data-testid={`op-return-chunk-${chunkIndex}-hex`}
                    text={chunk.dataHex || '(empty)'}
                    color="text"
                    size="xs"
                    selectText
                    wrap
                    disableTranslate
                  />
                  {chunk.utf8Preview !== undefined && (
                    <Text
                      data-testid={`op-return-chunk-${chunkIndex}-preview`}
                      text={`UTF-8 preview (supplemental): ${JSON.stringify(chunk.utf8Preview)}`}
                      color="textDim"
                      size="xs"
                    />
                  )}
                </Column>
              ))}

              {opReturn.decodeWarning && (
                <Text
                  data-testid="op-return-decode-warning"
                  text="Decode warning: unable to fully decode this OP_RETURN script. Review the raw script hex above."
                  color="dangerText"
                  size="xs"
                  wrap
                />
              )}

              <Text
                data-testid="op-return-public-warning"
                text="If broadcast, this data will be public and permanently recorded."
                color="dangerText"
                size="xs"
                wrap
              />
            </Column>
          </Column>
        </Row>
      </Column>
    </Row>
  );
}

export function InputItem(props: {
  index: number;
  inputInfo?: DecodedPsbtInput;
  outputInfo?: DecodedPsbtOutput;
  decodedPsbt: DecodedPsbt;
  toSignData?: ToSignData;
}) {
  const { index, inputInfo, outputInfo, decodedPsbt, toSignData } = props;
  const currentAddress = useCurrentAddress();
  const itemInfo = (inputInfo || outputInfo)!;
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const isToSign = inputInfo && toSignData?.toSignInputs.find((input) => input.index === index);
  const signingKeyCount = inputInfo
    ? (toSignData?.qbitP2mrSigningKeys || []).filter((key) => key.inputIndex === index).length
    : 0;
  const isMyAddress = itemInfo.address === currentAddress;
  // Neither the wallet's nor the recipient the request named, as the background classified it.
  const isUnrecognised = !!outputInfo && decodedPsbt.spendSummary?.outputRoles[index] === 'unrecognised';
  // Change or another of the wallet's accounts, from the scripts the background derives for them.
  const outputOwner = outputInfo ? decodedPsbt.outputOwners?.[index] : undefined;
  const isChange = outputOwner === 'change';
  const isOtherAccount = outputOwner === 'other_account';
  const qbitUnit = useQbitUnit();
  const { t } = useI18n();

  if (outputInfo?.type === 'op_return') {
    return <OpReturnOutputItem index={index} outputInfo={outputInfo} qbitUnit={qbitUnit} />;
  }

  return (
    <Row
      data-testid={inputInfo ? `psbt-input-item-${index}` : `psbt-output-item-${index}`}
      style={index === 0 ? {} : { borderColor: colors.border, borderTopWidth: 1, paddingTop: 10 }}
      itemsCenter
    >
      <Column fullX>
        <Row fullX mb="md">
          {inputInfo && <Icon icon="psbt_input" size={28} />}
          {outputInfo &&
            (outputInfo.address.startsWith('OP') ? (
              <Icon icon="psbt_opreturn" size={28} />
            ) : (
              <Icon icon="psbt_output" size={28} />
            ))}

          <Column fullX style={{ minWidth: 0 }}>
            <Row justifyBetween itemsCenter fullX>
              <Text text={`${numUtils.satoshisToAmount(itemInfo.value)} ${qbitUnit}`} preset="bold" color="text" />
              {(inputInfo || outputInfo?.scriptPubKeyHex) && (
                <Row
                  itemsCenter
                  gap="sm"
                  onClick={() => setDetailsExpanded(!detailsExpanded)}
                  data-testid={`psbt-${inputInfo ? 'input' : 'output'}-details-toggle-${index}`}
                >
                  <Text text={t('details')} size="xs" color="textDim" />
                  <Icon icon={detailsExpanded ? 'up' : 'down'} color="textDim" size={12} />
                </Row>
              )}
            </Row>

            <Row justifyBetween itemsCenter fullX>
              <AddressText address={itemInfo.address} color="accentDark" bold showEye />
              {isChange ? (
                <Row
                  style={{ padding: '2px 8px', backgroundColor: colors.accent, borderRadius: 8 }}
                  data-testid={`psbt-output-change-${index}`}
                >
                  <Text text={t('psbt_output_change')} color="pureWhite" size="xxs" />
                </Row>
              ) : (
                isMyAddress && (
                  <Row style={{ padding: '2px 8px', backgroundColor: colors.accent, borderRadius: 8 }}>
                    <Text text={t('my_address')} color="pureWhite" size="xxs" />
                  </Row>
                )
              )}
              {isOtherAccount && (
                <Row
                  style={{ padding: '2px 8px', border: `1px solid ${colors.accent}`, borderRadius: 8 }}
                  data-testid={`psbt-output-other-account-${index}`}
                >
                  <Text text={t('psbt_output_other_account')} color="accent" size="xxs" />
                </Row>
              )}
              {isUnrecognised && (
                <Row
                  style={{ padding: '2px 8px', border: `1px solid ${colors.warning}`, borderRadius: 8 }}
                  data-testid={`psbt-output-unrecognised-${index}`}
                >
                  <Text text={t('unrecognised_output')} color="warning" size="xxs" />
                </Row>
              )}
            </Row>

            {isToSign && (
              <Row itemsCenter>
                <Row style={{ borderWidth: 1, borderColor: colors.accent, borderRadius: 8, padding: '2px 8px' }}>
                  <Text
                    text={
                      signingKeyCount > 0
                        ? `Signs with ${signingKeyCount} P2MR ${signingKeyCount === 1 ? 'key' : 'keys'}`
                        : t('to_sign')
                    }
                    color="gold"
                    size="xxs"
                  />
                </Row>
              </Row>
            )}

            {detailsExpanded && inputInfo && (
              <Column fullX gap="sm" mt="sm">
                <Column fullX gap="zero">
                  <Text text="PREVOUT" preset="bold" size="xs" color="textDim" />
                  <Text
                    data-testid={`psbt-input-outpoint-${index}`}
                    text={`${inputInfo.txid}:${inputInfo.vout}`}
                    color="textDim"
                    size="xs"
                    selectText
                    wrap
                    disableTranslate
                  />
                </Column>
                {inputInfo.witnessUtxoScriptHex && (
                  <Column fullX gap="zero">
                    <Text text="WITNESS SCRIPT" preset="bold" size="xs" color="textDim" />
                    <Text
                      data-testid={`psbt-input-script-${index}`}
                      text={inputInfo.witnessUtxoScriptHex}
                      color="textDim"
                      size="xs"
                      selectText
                      wrap
                      disableTranslate
                    />
                  </Column>
                )}
                {inputInfo.sequence !== undefined && (
                  <Column fullX gap="zero">
                    <Text text="SEQUENCE" preset="bold" size="xs" color="textDim" />
                    <Text
                      data-testid={`psbt-input-sequence-${index}`}
                      text={`${inputInfo.sequence}`}
                      color="textDim"
                      size="xs"
                      selectText
                      disableTranslate
                    />
                  </Column>
                )}
              </Column>
            )}

            {detailsExpanded && outputInfo?.scriptPubKeyHex && (
              <Column fullX gap="zero" mt="sm">
                <Text text="OUTPUT SCRIPT" preset="bold" size="xs" color="textDim" />
                <Text
                  data-testid={`psbt-output-script-${index}`}
                  text={outputInfo.scriptPubKeyHex}
                  color="textDim"
                  size="xs"
                  selectText
                  wrap
                  disableTranslate
                />
              </Column>
            )}
          </Column>
        </Row>
      </Column>
    </Row>
  );
}
