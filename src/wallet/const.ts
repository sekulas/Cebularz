export const HASH_ID_ALGO = 'sha256';
export const AES_GCM_ALGO = 'aes-256-gcm';
export const AES_GCM_IV_LENGTH = 12;

export const BASE64 = 'base64';
export const HEX = 'hex';
export const UTF8 = 'utf8';

export const KEY_LENGTH_BYTES = 32;
export const DEFAULT_SCRYPT_PARAMS = { N: 1 << 14, r: 8, p: 1, dkLen: KEY_LENGTH_BYTES } as const;
export const MASTER_SALT_LENGTH = 16;
export const SENTINEL_SECRET_BYTES = 32;
