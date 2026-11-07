import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface TranscriptKeyProvider {
  activeVersion(): string;
  keyFor(version: string): Buffer | undefined;
}
export interface TranscriptRecordBinding {
  readonly recordId: string;
  readonly purpose: string;
  readonly meetingId: string;
  readonly botSessionId: string;
}
export interface TranscriptCiphertext {
  readonly version: 1;
  readonly keyVersion: string;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
  readonly wrapNonce: string;
  readonly wrapTag: string;
  readonly wrappedKey: string;
}

export class TranscriptEnvelope {
  constructor(private readonly keys: TranscriptKeyProvider) {}

  seal(
    plaintext: string,
    binding: TranscriptRecordBinding,
  ): TranscriptCiphertext {
    const version = this.keys.activeVersion();
    const kek = this.keys.keyFor(version);
    if (!version || !Buffer.isBuffer(kek) || kek.length !== 32)
      throw new Error('Transcript encryption key unavailable');
    const dek = randomBytes(32);
    try {
      const data = encrypt(
        Buffer.from(plaintext, 'utf8'),
        dek,
        aad(binding, version, 'data'),
      );
      const wrapped = encrypt(dek, kek, aad(binding, version, 'key'));
      return Object.freeze({
        version: 1,
        keyVersion: version,
        ...data,
        wrapNonce: wrapped.nonce,
        wrapTag: wrapped.tag,
        wrappedKey: wrapped.ciphertext,
      });
    } finally {
      dek.fill(0);
    }
  }

  open(input: unknown, binding: TranscriptRecordBinding): string {
    let dek: Buffer | undefined;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error();
      const value = input as Record<string, unknown>;
      if (value.version !== 1 || typeof value.keyVersion !== 'string')
        throw new Error();
      const kek = this.keys.keyFor(value.keyVersion);
      if (!Buffer.isBuffer(kek) || kek.length !== 32) throw new Error();
      dek = decrypt(
        value.wrappedKey,
        value.wrapNonce,
        value.wrapTag,
        kek,
        aad(binding, value.keyVersion, 'key'),
      );
      if (dek.length !== 32) throw new Error();
      return decrypt(
        value.ciphertext,
        value.nonce,
        value.tag,
        dek,
        aad(binding, value.keyVersion, 'data'),
      ).toString('utf8');
    } catch {
      throw new Error('Transcript encrypted record unavailable');
    } finally {
      dek?.fill(0);
    }
  }
}
function aad(
  binding: TranscriptRecordBinding,
  version: string,
  layer: string,
): Buffer {
  if (
    !binding.recordId ||
    !binding.purpose ||
    !binding.meetingId ||
    !binding.botSessionId
  )
    throw new Error('Transcript encryption binding unavailable');

  return Buffer.from(
    JSON.stringify([
      'meetwise-transcript',
      1,
      layer === 'key' ? version : null,
      binding.recordId,
      binding.purpose,
      binding.meetingId,
      binding.botSessionId,
      layer,
    ]),
  );
}
function encrypt(plaintext: Buffer, key: Buffer, associated: Buffer) {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
function decode(value: unknown, size?: number): Buffer {
  if (typeof value !== 'string') throw new Error();
  const result = Buffer.from(value, 'base64');
  if (
    result.toString('base64') !== value ||
    (size !== undefined && result.length !== size)
  )
    throw new Error();
  return result;
}
function decrypt(
  content: unknown,
  nonce: unknown,
  tag: unknown,
  key: Buffer,
  associated: Buffer,
): Buffer {
  const cipher = createDecipheriv('aes-256-gcm', key, decode(nonce, 12));
  cipher.setAAD(associated);
  cipher.setAuthTag(decode(tag, 16));
  return Buffer.concat([cipher.update(decode(content)), cipher.final()]);
}
