import { generateKeyPairSync, randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { HASH_ID_ALGO, AES_GCM_IV_LENGTH, AES_GCM_ALGO, BASE64, KEY_LENGTH_BYTES, UTF8, HEX } from './const.js';

export interface IdentityRecord {
  id: string;
  label: string;
  publicKeyPem: string;
  encPrivMaster: EncryptedWithKey;
}

export function generateIdentity(label: string, masterKey: Buffer): IdentityRecord {
  const { publicKey, privateKey } = generateEd25519PemPair();
  const id = computeIdentityId(publicKey);
  const encPrivMaster = encryptWithKey(privateKey, masterKey);
  return { id, label, publicKeyPem: publicKey, encPrivMaster };
}

export interface EncryptedWithKey {
  ct: string;
  iv: string;
  tag: string;
  algo: typeof AES_GCM_ALGO;
}

export function encryptWithKey(plaintext: string, key: Buffer): EncryptedWithKey {
  if (key.length !== KEY_LENGTH_BYTES) throw new Error(`Key must be ${KEY_LENGTH_BYTES} bytes`);
  const iv = randomBytes(AES_GCM_IV_LENGTH);
  const cipher = createCipheriv(AES_GCM_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, UTF8), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct: ct.toString(BASE64), iv: iv.toString(BASE64), tag: tag.toString(BASE64), algo: AES_GCM_ALGO };
}

export function decryptWithKey(enc: EncryptedWithKey, key: Buffer): string {
  if (key.length !== KEY_LENGTH_BYTES) throw new Error(`Key must be ${KEY_LENGTH_BYTES} bytes`);
  const decipher = createDecipheriv(AES_GCM_ALGO, key, Buffer.from(enc.iv, BASE64));
  decipher.setAuthTag(Buffer.from(enc.tag, BASE64));
  const pt = Buffer.concat([decipher.update(Buffer.from(enc.ct, BASE64)), decipher.final()]);
  return pt.toString(UTF8);
}

export function computeIdentityId(publicKeyPem: string): string {
  return createHash(HASH_ID_ALGO).update(publicKeyPem).digest(HEX);
}

export function generateEd25519PemPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}