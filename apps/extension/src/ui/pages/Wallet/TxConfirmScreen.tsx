import { Header } from '@/ui/components';
import { useTxConfirmScreenLogic } from '@qbit/wallet-state';
import { SignPsbt } from '../Approval/components';

export default function TxConfirmScreen() {
  const {
    // data
    signPsbtParams,

    // actions
    onClickBack,
    onClickCancel,
    onClickConfirm
  } = useTxConfirmScreenLogic();
  return (
    <SignPsbt
      header={<Header onBack={onClickBack} />}
      params={signPsbtParams}
      handleCancel={onClickCancel}
      handleConfirm={onClickConfirm}
    />
  );
}
