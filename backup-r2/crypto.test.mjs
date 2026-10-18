import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptFile, decryptFile, parseEncryptionKey } from './crypto.mjs';

test('encrypted backup can round-trip; corruption is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'starclub-r2-test-'));
  const key = randomBytes(32);
  try {
    const src = join(dir, 'input');
    const encrypted = join(dir, 'encrypted');
    const restored = join(dir, 'restored');
    await writeFile(src, randomBytes(1024 * 32));
    const uploadInfo = await encryptFile(src, encrypted, key);
    assert.equal(uploadInfo.size, 1024 * 32 + 22 + 12 + 16);
    await decryptFile(encrypted, restored, key);
    assert.deepEqual(await readFile(restored), await readFile(src));
    const bytes = await readFile(encrypted);
    bytes[100] ^= 0x01;
    await writeFile(join(dir, 'tampered'), bytes);
    await assert.rejects(decryptFile(join(dir, 'tampered'), join(dir, 'nope'), key), /decrypt\/verify/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('key input validation', () => {
  const key = randomBytes(32);
  assert.deepEqual(parseEncryptionKey(key.toString('base64')), key);
  assert.throws(() => parseEncryptionKey('short'));
  assert.throws(() => parseEncryptionKey('a'.repeat(44)));
});
