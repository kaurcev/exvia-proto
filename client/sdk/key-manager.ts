import { generateKeyPairFromSeed, sign, verify } from '@stablelib/ed25519';
import { PublicKey, PrivateKey, Signature, HexString } from './types';
import { IStorage } from './storage';

export interface IKeyManager {
  getPublicKey(): PublicKey;
  getPublicKeyHex(): HexString;
  sign(data: Uint8Array): Signature;
  verify(publicKey: PublicKey, data: Uint8Array, signature: Signature): boolean;
}

export class Ed25519KeyManager implements IKeyManager {
  private privateKey: PrivateKey;
  private publicKey: PublicKey;

  constructor(storage: IStorage, storagePrefix = 'sdk') {
    const savedPrivateKey = storage.getItem(`${storagePrefix}:privateKey`);
    const savedPublicKey = storage.getItem(`${storagePrefix}:publicKey`);

    if (savedPrivateKey && savedPublicKey) {
      this.privateKey = new Uint8Array(JSON.parse(savedPrivateKey));
      this.publicKey = new Uint8Array(JSON.parse(savedPublicKey));
    } else {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const keyPair = generateKeyPairFromSeed(seed);
      this.privateKey = keyPair.secretKey;
      this.publicKey = keyPair.publicKey;

      storage.setItem(`${storagePrefix}:privateKey`, JSON.stringify(Array.from(this.privateKey)));
      storage.setItem(`${storagePrefix}:publicKey`, JSON.stringify(Array.from(this.publicKey)));
    }
  }

  getPublicKey(): PublicKey {
    return this.publicKey.slice();
  }

  getPublicKeyHex(): HexString {
    return Array.from(this.publicKey).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  sign(data: Uint8Array): Signature {
    return sign(this.privateKey, data);
  }

  verify(publicKey: PublicKey, data: Uint8Array, signature: Signature): boolean {
    try {
      return verify(publicKey, data, signature);
    } catch {
      return false;
    }
  }
}