import { generateKeyPairFromSeed, sign, verify } from '@stablelib/ed25519';
import { PublicKey, PrivateKey, Signature, HexString } from './types';
import { IStorage } from './storage';

export interface IKeyManager {
  getPublicKey(): PublicKey;
  getPublicKeyHex(): HexString;
  sign(data: Uint8Array): Signature;
  verify(publicKey: PublicKey, data: Uint8Array, signature: Signature): boolean;
  exportKeys(): { publicKey: string; privateKey: string }; // base64
  importKeys(publicKey: string, privateKey: string): Promise<void>;
  load(): Promise<void>;
}

function arrayToBase64(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr));
}

function base64ToArray(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

export class Ed25519KeyManager implements IKeyManager {
  private privateKey: PrivateKey | null = null;
  private publicKey: PublicKey | null = null;
  private readonly storagePrefix: string;

  constructor(private storage: IStorage, storagePrefix = 'sdk') {
    this.storagePrefix = storagePrefix;
  }

  async load(): Promise<void> {
    const [savedPrivateKey, savedPublicKey] = await Promise.all([
      this.storage.getItem(`${this.storagePrefix}:privateKey`),
      this.storage.getItem(`${this.storagePrefix}:publicKey`)
    ]);

    if (savedPrivateKey && savedPublicKey) {
      this.privateKey = new Uint8Array(JSON.parse(savedPrivateKey));
      this.publicKey = new Uint8Array(JSON.parse(savedPublicKey));
    } else {
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const keyPair = generateKeyPairFromSeed(seed);
      this.privateKey = keyPair.secretKey;
      this.publicKey = keyPair.publicKey;

      await Promise.all([
        this.storage.setItem(`${this.storagePrefix}:privateKey`, JSON.stringify(Array.from(this.privateKey))),
        this.storage.setItem(`${this.storagePrefix}:publicKey`, JSON.stringify(Array.from(this.publicKey)))
      ]);
    }
  }

  getPublicKey(): PublicKey {
    if (!this.publicKey) throw new Error('KeyManager not loaded');
    return this.publicKey.slice();
  }

  getPublicKeyHex(): HexString {
    if (!this.publicKey) throw new Error('KeyManager not loaded');
    return Array.from(this.publicKey).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  sign(data: Uint8Array): Signature {
    if (!this.privateKey) throw new Error('KeyManager not loaded');
    return sign(this.privateKey, data);
  }

  verify(publicKey: PublicKey, data: Uint8Array, signature: Signature): boolean {
    try {
      return verify(publicKey, data, signature);
    } catch {
      return false;
    }
  }

  exportKeys(): { publicKey: string; privateKey: string } {
    if (!this.publicKey || !this.privateKey) throw new Error('KeyManager not loaded');
    return {
      publicKey: arrayToBase64(this.publicKey),
      privateKey: arrayToBase64(this.privateKey)
    };
  }

  async importKeys(publicKeyBase64: string, privateKeyBase64: string): Promise<void> {
    const publicKey = base64ToArray(publicKeyBase64);
    const privateKey = base64ToArray(privateKeyBase64);
    if (publicKey.length !== 32 || privateKey.length !== 64) {
      throw new Error('Invalid key length');
    }
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    await Promise.all([
      this.storage.setItem(`${this.storagePrefix}:privateKey`, JSON.stringify(Array.from(privateKey))),
      this.storage.setItem(`${this.storagePrefix}:publicKey`, JSON.stringify(Array.from(publicKey)))
    ]);
  }
}