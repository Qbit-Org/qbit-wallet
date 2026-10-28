import { WordsType } from '@qbit/wallet-shared';
import { AddressType } from '@qbit/wallet-types';

export enum TabType {
  SET_PASSWORD = 'SET_PASSWORD',
  CREATE_WORDS = 'CREATE_WORDS',
  VERIFY_WORDS = 'VERIFY_WORDS',
  IMPORT_WORDS = 'IMPORT_WORDS',
  CHOOSE_ADDRESS_TYPE = 'CHOOSE_ADDRESS_TYPE'
}

export interface ContextData {
  mnemonics: string;
  hdPath: string;
  passphrase: string;
  addressType: AddressType;
  step1CreateWordsCompleted: boolean;
  tabType: TabType;
  isRestore: boolean;
  isCustom: boolean;
  customHdPath: string;
  addressTypeIndex: number;
  wordsType: WordsType;
  // True while the restore chain scan is in flight; the parent screen locks
  // header/tab navigation on it. Optional because other screens reuse this
  // shape without ever entering the scanning phase.
  restoreScanning?: boolean;
}

export interface UpdateContextDataParams {
  mnemonics?: string;
  hdPath?: string;
  passphrase?: string;
  addressType?: AddressType;
  step1CreateWordsCompleted?: boolean;
  tabType?: TabType;
  isCustom?: boolean;
  customHdPath?: string;
  addressTypeIndex?: number;
  wordsType?: WordsType;
  restoreScanning?: boolean;
}
