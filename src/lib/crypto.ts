/**
 * Encryption for secrets at rest.
 *
 * OAuth refresh tokens grant standing access to a mailbox, and the SQLite file
 * sits on a VPS volume that gets copied around in backups. They are therefore
 * stored as AES-256-GCM ciphertext under TOKEN_ENCRYPTION_KEY. Losing the key
 * only means reconnecting the accounts; it never exposes anything.
 *
 * Built on Web Crypto so the module compiles for every Next.js runtime.
 * Wire format: `v1.<iv>.<ciphertext+tag>` with each part base64url-encoded.
 */

import { env } from '@/lib/env';

const VERSION = 'v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesOf(binary: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  return bytesOf(atob(padded));
}

function fromStandardBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    return bytesOf(atob(value));
  } catch {
    return null;
  }
}

/**
 * A freshly generated `openssl rand -base64 32` decodes to exactly 32 bytes and
 * is used verbatim. Anything else (a passphrase, a longer string) is hashed
 * down to 32 bytes so the key material is always the right length.
 */
export async function deriveKey(raw: string): Promise<Uint8Array<ArrayBuffer>> {
  const decoded = fromStandardBase64(raw);
  if (decoded && decoded.length === 32) return decoded;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)));
}

export function isEncryptionConfigured(): boolean {
  return Boolean(env.tokenEncryptionKey);
}

async function cryptoKey(): Promise<CryptoKey> {
  const raw = env.tokenEncryptionKey;
  if (!raw) {
    throw new Error('TOKEN_ENCRYPTION_KEY is not configured; refusing to store a secret.');
  }
  return crypto.subtle.importKey('raw', await deriveKey(raw), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await cryptoKey();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain));
  return [VERSION, toBase64Url(iv), toBase64Url(new Uint8Array(ciphertext))].join('.');
}

export async function decryptSecret(encoded: string): Promise<string> {
  const [version, ivPart, dataPart] = encoded.split('.');
  if (version !== VERSION || !ivPart || !dataPart) {
    throw new Error('Stored secret has an unrecognised format.');
  }
  const key = await cryptoKey();
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64Url(ivPart) },
      key,
      fromBase64Url(dataPart),
    );
  } catch {
    throw new Error('Stored secret could not be decrypted (wrong key or tampered data).');
  }
  return decoder.decode(plain);
}

/** Random bytes as base64url, for OAuth state and PKCE verifiers. */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64Url(value: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
