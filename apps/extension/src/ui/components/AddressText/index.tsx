import { useMemo, useState } from 'react';

import { shortAddress } from '@/ui/utils';

import { AddressDetailPopover } from '../AddressDetailPopover';
import { Column } from '../Column';
import { Icon } from '../Icon';
import { Row } from '../Row';
import { Text } from '../Text';
import { AddressTextProps } from './interface';

export const AddressText = (props: AddressTextProps) => {
  const [popoverVisible, setPopoverVisible] = useState(false);
  const address = useMemo(() => {
    if (props.address) {
      return props.address;
    }
    if (props.addressInfo) {
      return props.addressInfo.address;
    }
    return '';
  }, []);
  return (
    <Column>
      <Row
        gap="sm"
        itemsCenter
        onClick={() => {
          setPopoverVisible(true);
        }}>
        <Text text={shortAddress(address)} preset={props.bold ? 'bold' : undefined} color={props.color || 'text'} />
        {props.showEye && <Icon icon="eye" size={14} color="textDim" data-testid="address-eye" />}
      </Row>
      {popoverVisible && (
        <AddressDetailPopover
          address={address}
          onClose={() => {
            setPopoverVisible(false);
          }}
          // inputInfo={props.inputInfo}
        />
      )}
    </Column>
  );
};
