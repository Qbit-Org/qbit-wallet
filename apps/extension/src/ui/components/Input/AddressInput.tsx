import React, { useEffect, useState } from 'react';

import { Icon, Row, Text } from '@/ui/components';
import { isValidAddress } from '@/ui/utils/qbit-utils';
import { QbitUriParseError, parseQbitUri } from '@qbit/wallet-shared';
import { useChain, useI18n } from '@qbit/wallet-state';

import { $baseContainerStyle, $baseTextareaStyle, InputProps } from '.';
import { ContactsModal } from '../ContactsModal';

export const AddressInput = (props: InputProps) => {
  const { t } = useI18n();
  const {
    placeholder,
    onAddressInputChange,
    onAmountInputChange,
    addressInputData,
    style: $inputStyleOverride,
    networkType: propsNetworkType,
    recipientLabel,
    ...rest
  } = props;

  const [showContactsModal, setShowContactsModal] = useState(false);
  const [validAddress, setValidAddress] = useState(addressInputData?.address || '');
  const [formatError, setFormatError] = useState('');
  const [inputVal, setInputVal] = useState(addressInputData?.address || '');

  const chain = useChain();
  const networkType = propsNetworkType || chain.enum;

  const inputAddressPlaceholder = props.addressPlaceholder || 'Qbit address';

  useEffect(() => {
    // Mirror the render guard below: an inactive input renders a placeholder
    // and must not report an address to its parent.
    if (!addressInputData || !onAddressInputChange) {
      return;
    }
    onAddressInputChange({ address: validAddress });
  }, [validAddress]);

  if (!addressInputData || !onAddressInputChange) {
    return <div />;
  }

  const resetState = () => {
    if (formatError) {
      setFormatError('');
    }

    if (validAddress) {
      setValidAddress('');
    }

  };

  const getQbitUriErrorMessage = (error: unknown) => {
    if (error instanceof QbitUriParseError) {
      if (error.code === 'UNSUPPORTED_SCHEME') {
        return t('qbit_uri_invalid');
      }
      if (error.code === 'INVALID_AMOUNT') {
        return t('qbit_uri_amount_invalid');
      }
    }
    return t('qbit_uri_invalid');
  };

  const handleInputAddress = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const inputAddress = e.target.value.trim();
    setInputVal(inputAddress);

    resetState();

    try {
      const qbitUri = parseQbitUri(inputAddress);
      if (qbitUri) {
        const isValid = isValidAddress(qbitUri.address);
        if (!isValid) {
          return;
        }

        setInputVal(qbitUri.address);
        setValidAddress(qbitUri.address);
        if (qbitUri.amount && onAmountInputChange) {
          onAmountInputChange(qbitUri.amount);
        }
        return;
      }
    } catch (error) {
      if (
        error instanceof QbitUriParseError &&
        error.code === 'INVALID_URI' &&
        inputAddress.toLowerCase() === 'qbit:'
      ) {
        return;
      }
      setFormatError(getQbitUriErrorMessage(error));
      return;
    }

    if (!inputAddress) {
      return;
    }
    if (isValidAddress(inputAddress)) {
      setValidAddress(inputAddress);
    }
  };

  const onAddressBlur = () => {
    setFormatError('');
    const inputAddress = inputVal;
    if (inputAddress == '') return;

    if (!validAddress) {
      setFormatError(t('recipient_address_is_invalid'));
    }
  };

  return (
    <div style={{ alignSelf: 'stretch' }}>
      <Row justifyBetween itemsCenter style={{ marginTop: 20, marginBottom: 12 }}>
        {recipientLabel || <Text text={t('recipient')} preset="regular" />}
        <Row itemsCenter clickable onClick={() => setShowContactsModal(true)} style={{ cursor: 'pointer', gap: 0 }}>
          <Text text={t('address_book_placeholder')} color="yellow" style={{ fontSize: '14px' }} />
          <Icon icon="right" color="yellow" size={16} style={{ marginLeft: 4 }} />
        </Row>
      </Row>
      <div
        style={Object.assign({}, $baseContainerStyle, {
          flexDirection: 'column'
        })}
      >
        <Row full itemsCenter>
          <textarea
            placeholder={inputAddressPlaceholder}
            style={Object.assign({}, $baseTextareaStyle, $inputStyleOverride)}
            onChange={handleInputAddress}
            onBlur={onAddressBlur}
            value={inputVal}
            rows={inputVal && inputVal.length > 50 ? 2 : 1}
            {...rest}
          />
        </Row>

      </div>

      <Text text={formatError} preset="regular" color="dangerText" />

      {showContactsModal && (
        <ContactsModal
          onClose={() => setShowContactsModal(false)}
          onSelect={(contact) => {
            setInputVal(contact.address);
            resetState();
            const addressValue = contact.address.trim();

            if (isValidAddress(addressValue)) {
              setValidAddress(addressValue);
            } else {
              setFormatError(t('recipient_address_is_invalid'));
            }

            setShowContactsModal(false);
          }}
          selectedNetworkFilter={networkType}
        />
      )}
    </div>
  );
};
