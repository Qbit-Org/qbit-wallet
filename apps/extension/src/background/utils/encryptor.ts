import * as browserPassworder from '@metamask/browser-passworder';

// Decrypts the earlier format when keyMetadata is absent and writes the current
// 900,000-round PBKDF2 format.

async function encrypt(password: string, data: any): Promise<string> {
  return await browserPassworder.encrypt(password, data);
}

async function decrypt(password: string, encryptedData: string): Promise<any> {
  return await browserPassworder.decrypt(password, encryptedData);
}

export const encryptor = {
  encrypt,
  decrypt,
  isVaultUpdated: browserPassworder.isVaultUpdated,
  updateVault: browserPassworder.updateVault
};
