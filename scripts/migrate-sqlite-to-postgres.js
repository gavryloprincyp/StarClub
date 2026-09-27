import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import postgres from 'postgres';

dotenv.config();

const databaseFile = path.resolve(process.cwd(), process.env.DATABASE_FILE || './data/star-club.sqlite');
const connectionString = String(
  process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || process.env.POSTGRES_URL || ''
).trim();

if (!connectionString) {
  throw new Error('Set DATABASE_URL (or DATABASE_PUBLIC_URL) to the Railway PostgreSQL connection string.');
}
if (!fs.existsSync(databaseFile) || fs.statSync(databaseFile).size === 0) {
  throw new Error(`SQLite database was not found or is empty: ${databaseFile}`);
}

const data = fs.readFileSync(databaseFile);
const checksum = crypto.createHash('sha256').update(data).digest('hex');
const sql = postgres(connectionString, { max: 1, prepare: false });

try {
  await sql`SELECT 1`;
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS starclub_database_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      db_data BYTEA NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sql.unsafe(`
    INSERT INTO starclub_database_state(id, db_data, checksum_sha256, updated_at)
    VALUES(1, $1, $2, NOW())
    ON CONFLICT (id) DO UPDATE SET
      db_data = EXCLUDED.db_data,
      checksum_sha256 = EXCLUDED.checksum_sha256,
      updated_at = NOW()
  `, [data, checksum]);

  const rows = await sql.unsafe(`
    SELECT octet_length(db_data) AS bytes, checksum_sha256, updated_at
    FROM starclub_database_state
    WHERE id = 1
  `);
  const row = rows[0];
  if (!row || row.checksum_sha256 !== checksum || Number(row.bytes) !== data.length) {
    throw new Error('PostgreSQL verification failed after upload.');
  }

  console.log(`Star Club SQLite state migrated to PostgreSQL: ${data.length} bytes`);
  console.log(`Checksum: ${checksum}`);
  console.log(`Updated at: ${row.updated_at}`);
} finally {
  await sql.end({ timeout: 5 });
}
