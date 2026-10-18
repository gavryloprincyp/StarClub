import { S3Client } from '@aws-sdk/client-s3';

export function getR2Config(env = process.env) {
  const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  const missing = required.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`Missing R2 settings: ${missing.join(', ')}`);
  const accountId = String(env.R2_ACCOUNT_ID).trim();
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('R2_ACCOUNT_ID must be the 32-character Cloudflare Account ID');
  const bucket = String(env.R2_BUCKET).trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid R2_BUCKET');
  const prefix = String(env.R2_PREFIX ?? 'starclub/postgres').trim().replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.includes('..') || prefix.includes('\\') || prefix.startsWith('/')) {
    throw new Error('R2_PREFIX must be a safe nonempty prefix');
  }
  return { bucket, prefix, accountId,
    s3: new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
        secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim()
      },
      maxAttempts: 4
    })
  };
}
