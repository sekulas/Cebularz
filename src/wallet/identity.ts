import { generateKeyPairSync, randomBytes, scryptSync, createCipheriv, createDecipheriv, createHash } from 'crypto';

export const HASH_ID_ALGO = 'sha1';
export const SALT_LENGTH = 16;
export const AES_GCM_IV_LENGTH = 12;
export const BASE_64 = 'base64';

export interface KdfParams { N: number; r: number; p: number; dkLen: number }

// N lowered from 2^15 to 2^14 due to observed memory limit in runtime environment.
export const KDF_DEFAULT: Readonly<KdfParams> = Object.freeze({ N: 1 << 14, r: 8, p: 1, dkLen: 32 });

export interface EncryptedPrivateKey {
  ct: string;      
  iv: string;      
  salt: string;    
  tag: string;    
  kdf: 'scrypt';
  params: { N: number; r: number; p: number; dkLen: number };
}

export interface IdentityRecord {
  id: string;
  label: string;
  publicKeyPem: string;
  encPriv: EncryptedPrivateKey;
}

export function generateIdentity(label: string, password: string): IdentityRecord {
  // 1. Generate Ed25519 key pair as PEM strings via helper (avoids unsafe casting).
  const { publicKey, privateKey } = generateEd25519PemPair();
  const id = computeIdentityId(publicKey);
  const encPriv = encryptPrivateKey(privateKey, password);
  return { id, label, publicKeyPem: publicKey, encPriv };
}

export function encryptPrivateKey(privateKeyPem: string, password: string): EncryptedPrivateKey {
  const { N, r, p, dkLen } = KDF_DEFAULT;
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = randomBytes(AES_GCM_IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ct: ciphertext.toString(BASE_64),
    iv: iv.toString(BASE_64),
    salt: salt.toString(BASE_64),
    tag: tag.toString(BASE_64),
    kdf: 'scrypt',
    params: { N, r, p, dkLen }
  };
}

export function decryptPrivateKey(enc: EncryptedPrivateKey, password: string): string {
  const { ct, iv, salt, tag, params } = enc;
  const key = deriveKey(password, Buffer.from(salt, BASE_64), params as KdfParams);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, BASE_64));
  decipher.setAuthTag(Buffer.from(tag, BASE_64));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ct, BASE_64)),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

export function computeIdentityId(publicKeyPem: string): string {
  return createHash(HASH_ID_ALGO).update(publicKeyPem).digest('hex');
}

export function deriveKey(password: string, salt: Buffer, params: KdfParams = KDF_DEFAULT): Buffer {
  return scryptSync(password, salt, params.dkLen, { N: params.N, r: params.r, p: params.p });
}

export function generateEd25519PemPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}