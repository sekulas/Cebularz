import { readFile, writeFile, access } from 'fs/promises';
import { generateIdentity, decryptWithKey, encryptWithKey, type IdentityRecord, type EncryptedWithKey } from './identity.js';
import { randomBytes, scryptSync, createHash } from 'crypto';
import { DEFAULT_SCRYPT_PARAMS, MASTER_SALT_LENGTH, SENTINEL_SECRET_BYTES, BASE64, HEX, HASH_ID_ALGO, KEY_LENGTH_BYTES, UTF8 } from './const.js';
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'crypto';

export interface WalletFile {
  identities: IdentityRecord[];
  master?: {
    salt: string;
    params: { N: number; r: number; p: number; dkLen: number };
    sentinel?: EncryptedWithKey;
    sentinelHash?: string;
  };
}

export class Wallet {
  private path: string;
  private data: WalletFile;

  constructor(path: string, data: WalletFile) {
    this.path = path;
    this.data = data;
  }

  static async create(path: string): Promise<Wallet> {
    const data: WalletFile = {
      identities: []
    };
    await writeFile(path, JSON.stringify(data, null, 2));
    return new Wallet(path, data);
  }

  initializeMaster(password: string): void {
    if (this.data.master) throw new Error('Master already initialized');
    const salt = randomBytes(MASTER_SALT_LENGTH).toString(BASE64);
    this.data.master = {
      salt,
      params: { ...DEFAULT_SCRYPT_PARAMS },
    };
    const masterKey = this.deriveMasterKey(password);
    const sentinelPlain = randomBytes(SENTINEL_SECRET_BYTES).toString(HEX);
    const encSentinel = encryptWithKey(sentinelPlain, masterKey);
    this.data.master.sentinel = encSentinel;
    this.data.master.sentinelHash = createHash(HASH_ID_ALGO).update(sentinelPlain, UTF8).digest(HEX);
  }

  private deriveMasterKey(password: string): Buffer {
    if (!this.data.master) throw new Error('Master password not set');
    const { salt, params } = this.data.master;
    const key = scryptSync(password, Buffer.from(salt, BASE64), params.dkLen, { N: params.N, r: params.r, p: params.p });
    if (this.data.master.sentinel && this.data.master.sentinelHash) {
      try {
        const pt = decryptWithKey(this.data.master.sentinel, key);
        const hash = createHash(HASH_ID_ALGO).update(pt, UTF8).digest(HEX);
        if (hash !== this.data.master.sentinelHash) throw new Error('mismatch');
      } catch {
        throw new Error('Incorrect master password');
      }
    }
    return key;
  }

  static async open(path: string): Promise<Wallet> {
    const raw = await readFile(path, UTF8);
    const parsed: WalletFile = JSON.parse(raw);
    return new Wallet(path, parsed);
  }

  static async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  addIdentity(label: string, masterPassword: string): IdentityRecord {
    const masterKey = this.deriveMasterKey(masterPassword);
    const identity = generateIdentity(label, masterKey);
    this.data.identities.push(identity);
    return identity;
  }

  listIdentities(): { id: string; label: string }[] {
    return this.data.identities.map(i => ({ id: i.id, label: i.label }));
  }

  getPublicKey(id: string): string | undefined {
    return this.data.identities.find(i => i.id === id)?.publicKeyPem;
  }

  decryptPrivateKey(id: string, masterPassword: string): string {
    const identity = this.data.identities.find(i => i.id === id);
    if (!identity) throw new Error('Identity not found');
    if (!this.data.master) throw new Error('Master password not initialized');
    const masterKey = this.deriveMasterKey(masterPassword);
    return decryptWithKey(identity.encPrivMaster, masterKey);
  }

  signMessage(id: string, masterPassword: string, message: string): string {
    const privPem = this.decryptPrivateKey(id, masterPassword);
    const keyObj = createPrivateKey(privPem);
    const signature = edSign(null, Buffer.from(message, UTF8), keyObj);
    return signature.toString(BASE64);
  }

  verifyMessage(id: string, message: string, signatureB64: string): boolean {
    const pubPem = this.getPublicKey(id);
    if (!pubPem) throw new Error('Identity not found');
    const keyObj = createPublicKey(pubPem);
    const signature = Buffer.from(signatureB64, BASE64);
    return edVerify(null, Buffer.from(message, UTF8), keyObj, signature);
  }

  async save(): Promise<void> {
    await writeFile(this.path, JSON.stringify(this.data, null, 2));
  }
}