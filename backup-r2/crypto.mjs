import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, stat, appendFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

// Stable on-disk format: MAGIC (ASCII) | 12-byte IV | ciphertext | 16-byte GCM tag.
export const MAGIC = Buffer.from('STARCLUB-R2-AESGCM-v1\n', 'ascii');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function parseEncryptionKey(base64 = process.env.BACKUP_ENCRYPTION_KEY) {
  const raw = String(base64 || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be exactly 32 random bytes encoded in Base64');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new Error('BACKUP_ENCRYPTION_KEY is not a valid Base64-encoded 32-byte key');
  }
  return key;
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function encryptFile(input, output, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  await writeFile(output, Buffer.concat([MAGIC, iv]), { flag: 'wx', mode: 0o600 });
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: 'a', mode: 0o600 }));
  await appendFile(output, cipher.getAuthTag());
  return { size: (await stat(output)).size, sha256: await sha256File(output) };
}

export async function decryptFile(input, output, key) {
  const file = await open(input, 'r');
  let iv;
  let tag;
  let total;
  try {
    total = (await file.stat()).size;
    if (total <= MAGIC.length + IV_LENGTH + TAG_LENGTH) throw new Error('Encrypted backup is too small');
    const prefix = Buffer.alloc(MAGIC.length + IV_LENGTH);
    await file.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid Star Club backup header');
    iv = prefix.subarray(MAGIC.length);
    tag = Buffer.alloc(TAG_LENGTH);
    await file.read(tag, 0, TAG_LENGTH, total - TAG_LENGTH);
  } finally {
    await file.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(input, { start: MAGIC.length + IV_LENGTH, end: total - TAG_LENGTH - 1 }),
      decipher,
      createWriteStream(output, { flags: 'wx', mode: 0o600 })
    );
  } catch (error) {
    const { unlink } = await import('node:fs/promises');
    await unlink(output).catch(() => {});
    throw new Error(`Could not decrypt/verify backup: ${error.message}`);
  }
  return { size: (await stat(output)).size, sha256: await sha256File(output) };
}
