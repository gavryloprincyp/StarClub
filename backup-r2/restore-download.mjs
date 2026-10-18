// Downloads and decrypts a backup to a local .dump file.
// This script deliberately does NOT connect to, drop or overwrite any database.
import { createWriteStream } from 'node:fs';
import { mkdtemp, stat, rm, rename } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { decryptFile, parseEncryptionKey, sha256File } from './crypto.mjs';
import { getR2Config } from './r2-client.mjs';

async function main() {
  const objectKey = process.argv[2];
  const output = process.argv[3];
  if (!objectKey || !output) throw new Error('Usage: node restore-download.mjs "starclub/postgres/FILE.dump.enc" "./restored.dump"');
  if (!objectKey.endsWith('.dump.enc') || objectKey.includes('..')) throw new Error('Invalid encrypted backup object key');
  const key = parseEncryptionKey();
  const { bucket, s3 } = getR2Config();
  const absoluteOutput = resolve(output);
  const tempDir = await mkdtemp(join(dirname(absoluteOutput), '.starclub-restore-'));
  try {
    const downloaded = join(tempDir, 'archive.enc');
    const decrypted = join(tempDir, 'archive.dump');
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    await pipeline(result.Body, createWriteStream(downloaded, { mode: 0o600 }));
    if (Number(head.ContentLength) !== (await stat(downloaded)).size) throw new Error('Downloaded object size differs from R2');
    if (!head.Metadata?.sha256) throw new Error('Missing encrypted file SHA256 in R2 object metadata');
    if ((await sha256File(downloaded)) !== head.Metadata.sha256) throw new Error('Downloaded encrypted backup SHA256 differs');
    await decryptFile(downloaded, decrypted, key); // Verifies the GCM authentication tag.
    // Exclusive create: never silently overwrite an existing local backup/restore file.
    const { copyFile, constants } = await import('node:fs/promises');
    await copyFile(decrypted, absoluteOutput, constants.COPYFILE_EXCL);
    console.log(`Backup downloaded and decrypted to ${absoluteOutput}`);
    console.log('This command did NOT modify any PostgreSQL database.');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    s3.destroy();
  }
}
main().catch((error) => { console.error(`[StarClub R2] RESTORE DOWNLOAD FAILED: ${error.message}`); process.exitCode = 1; });
