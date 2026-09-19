import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  decryptSecret,
  deriveKey,
  encryptSecret,
  fromBase64Url,
  isEncryptionConfigured,
  randomToken,
  sha256Base64Url,
  toBase64Url,
} from '@/lib/crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');
let previous: string | undefined;

beforeAll(() => {
  previous = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
});

afterAll(() => {
  if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = previous;
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips and never repeats ciphertext', async () => {
    expect(isEncryptionConfigured()).toBe(true);
    const a = await encryptSecret('1//refresh-token');
    const b = await encryptSecret('1//refresh-token');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(await decryptSecret(a)).toBe('1//refresh-token');
    expect(await decryptSecret(b)).toBe('1//refresh-token');
  });

  it('rejects tampered ciphertext and the wrong key', async () => {
    const encoded = await encryptSecret('secret');
    const parts = encoded.split('.');
    const bytes = fromBase64Url(parts[2]);
    bytes[0] ^= 0xff;
    parts[2] = toBase64Url(bytes);
    await expect(decryptSecret(parts.join('.'))).rejects.toThrow(/could not be decrypted/);
    await expect(decryptSecret('nonsense')).rejects.toThrow(/unrecognised format/);

    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    await expect(decryptSecret(encoded)).rejects.toThrow(/could not be decrypted/);
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });

  it('refuses to work without a key', async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    await expect(encryptSecret('x')).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
    process.env.TOKEN_ENCRYPTION_KEY = KEY;
  });
});

describe('deriveKey', () => {
  it('uses a 32-byte base64 key verbatim and hashes anything else', async () => {
    expect(Buffer.from(await deriveKey(KEY))).toEqual(Buffer.alloc(32, 7));
    const derived = await deriveKey('a passphrase instead');
    expect(derived).toHaveLength(32);
    expect(Buffer.from(derived)).toEqual(Buffer.from(await deriveKey('a passphrase instead')));
  });
});

describe('helpers', () => {
  it('produces url-safe tokens and S256 challenges', async () => {
    const token = randomToken(48);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    // RFC 7636 appendix B test vector.
    expect(await sha256Base64Url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
