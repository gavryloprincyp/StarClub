import { randomBytes } from 'node:crypto';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Upload } from '@aws-sdk/lib-storage';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { encryptFile, parseEncryptionKey } from './crypto.mjs';
import { getR2Config } from './r2-client.mjs';

// Ensure local pg_dump files and temporary archives are accessible only by this OS user.
process.umask(0o077);

function requireDbUrl() {
  const value = String(process.env.DATABASE_URL || '').trim();
  if (!/^postgres(ql)?:\/\//i.test(value)) throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  return value;
}

function execDump(dbUrl, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--dbname', dbUrl, '--format=custom', '--no-owner', '--no-acl', '--file', destination], {
      env: { ...process.env, PGCONNECT_TIMEOUT: '30' },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString().slice(0, 1024); stderr = stderr.slice(-4000); });
    child.on('error', (error) => reject(new Error(`Could not start pg_dump: ${error.message}`)));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`pg_dump failed (exit ${code}): ${stderr.replaceAll(dbUrl, '[DATABASE_URL]')}`)));
  });
}

async function main() {
  const keyBytes = parseEncryptionKey();
  const databaseUrl = requireDbUrl();
  const { bucket, prefix, s3 } = getR2Config();
  const tempDir = await mkdtemp(join(tmpdir(), 'starclub-r2-'));
  try {
    const dumpPath = join(tempDir, 'backup.dump');
    const encryptedPath = join(tempDir, 'backup.dump.enc');
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const objectKey = `${prefix}/${stamp}-${randomBytes(4).toString('hex')}.dump.enc`;
    console.log('[StarClub R2] Creating consistent PostgreSQL pg_dump...');
    await execDump(databaseUrl, dumpPath);
    const dumpSize = (await stat(dumpPath)).size;
    if (dumpSize < 1024) throw new Error('pg_dump archive unexpectedly small; refusing upload');
    console.log(`[StarClub R2] PostgreSQL dump complete (${dumpSize} bytes)`);
    const encrypted = await encryptFile(dumpPath, encryptedPath, keyBytes);
    const remote = { sha256: encrypted.sha256, format: 'pgdump-custom-aes256gcm-v1' };
    console.log(`[StarClub R2] Uploading encrypted archive (${encrypted.size} bytes)...`);
    try {
      const task = new Upload({
        client: s3,
        params: {
          Bucket: bucket,
          Key: objectKey,
          Body: createReadStream(encryptedPath),
          ContentType: 'application/octet-stream',
          Metadata: remote
        },
        queueSize: 2,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false
      });
      await task.done();
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
      if (Number(head.ContentLength) !== encrypted.size || head.Metadata?.sha256 !== encrypted.sha256) {
        throw new Error('R2 upload verification failed (size/SHA metadata mismatch)');
      }
      console.log(`[StarClub R2] SUCCESS bucket=${bucket} key=${objectKey} bytes=${encrypted.size} sha256=${encrypted.sha256}`);
    } catch (error) {
      console.error(`[StarClub R2] Upload or verification failed for ${objectKey}; inspect/delete any incomplete object manually.`);
      throw error;
    } finally {
      s3.destroy();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[StarClub R2] BACKUP FAILED: ${error.message}`);
  process.exitCode = 1;
});
