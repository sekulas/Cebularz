import { readFile, writeFile, access } from 'fs/promises';
import { generateIdentity, decryptPrivateKey, type IdentityRecord } from './identity.js';

export interface WalletFile {
  version: 1;
  createdAt: string;
  identities: IdentityRecord[];
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
      version: 1,
      createdAt: new Date().toISOString(),
      identities: []
    };
    await writeFile(path, JSON.stringify(data, null, 2));
    return new Wallet(path, data);
  }

  static async open(path: string): Promise<Wallet> {
    const raw = await readFile(path, 'utf8');
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

  addIdentity(label: string, password: string): IdentityRecord {
    const identity = generateIdentity(label, password);
    this.data.identities.push(identity);
    return identity;
  }

  listIdentities(): { id: string; label: string }[] {
    return this.data.identities.map(i => ({ id: i.id, label: i.label }));
  }

  getPublicKey(id: string): string | undefined {
    return this.data.identities.find(i => i.id === id)?.publicKeyPem;
  }

  decryptPrivateKey(id: string, password: string): string {
    const identity = this.data.identities.find(i => i.id === id);
    if (!identity) throw new Error('Identity not found');
    return decryptPrivateKey(identity.encPriv, password);
  }

  async save(): Promise<void> {
    await writeFile(this.path, JSON.stringify(this.data, null, 2));
  }
}