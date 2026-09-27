import initSqlJs from 'sql.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import postgres from 'postgres';
import { createRequire } from 'module';

dotenv.config();

const require = createRequire(import.meta.url);
const dbFile = process.env.DATABASE_FILE || './data/star-club.sqlite';
const resolvedDbFile = path.resolve(process.cwd(), dbFile);
fs.mkdirSync(path.dirname(resolvedDbFile), { recursive: true });

let innerDb = null;
let initialized = false;
let transactionDepth = 0;
let postgresClient = null;
let postgresPersistenceReady = false;
let pendingPostgresSnapshot = null;
let postgresPersistWorker = null;
let lastPostgresPersistError = null;

const POSTGRES_STATE_TABLE = 'starclub_database_state';
const POSTGRES_SYNC_META_TABLE = 'starclub_sync_meta';

function quotePgIdentifier(value) {
  return `\"${String(value).replace(/\"/g, '\"\"')}\"`;
}

function quoteSqliteIdentifier(value) {
  return `\"${String(value).replace(/\"/g, '\"\"')}\"`;
}

function mapSqliteTypeToPostgres(sqliteType) {
  const type = String(sqliteType || '').trim().toUpperCase();
  if (type.includes('BLOB')) return 'BYTEA';
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'DOUBLE PRECISION';
  if (type.includes('INT')) return 'BIGINT';
  if (type.includes('NUM') || type.includes('DEC')) return 'NUMERIC';
  return 'TEXT';
}

function normalizePgValue(value) {
  if (value === undefined) return null;
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
  return value;
}

function buildRelationalSnapshot() {
  ensureDb();
  const tableListResult = innerDb.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tableNames = (tableListResult?.[0]?.values || []).map((row) => String(row[0]));
  const tables = [];

  for (const tableName of tableNames) {
    const tableIdent = quoteSqliteIdentifier(tableName);
    const info = innerDb.exec(`PRAGMA table_info(${tableIdent})`);
    const columns = (info?.[0]?.values || []).map((row) => ({
      name: String(row[1]),
      sqliteType: String(row[2] || ''),
      pgType: mapSqliteTypeToPostgres(row[2])
    }));
    if (!columns.length) continue;

    const selected = innerDb.exec(`SELECT * FROM ${tableIdent}`);
    const rows = (selected?.[0]?.values || []).map((row) => row.map(normalizePgValue));
    tables.push({ name: tableName, columns, rows });
  }

  return tables;
}

async function syncRelationalTablesToPostgres(sql, tables, checksum) {
  for (const table of tables) {
    const tableIdent = quotePgIdentifier(table.name);
    const columnDefs = table.columns
      .map((column) => `${quotePgIdentifier(column.name)} ${column.pgType}`)
      .join(', ');

    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${tableIdent} (${columnDefs})`);

    for (const column of table.columns) {
      await sql.unsafe(
        `ALTER TABLE ${tableIdent} ADD COLUMN IF NOT EXISTS ${quotePgIdentifier(column.name)} ${column.pgType}`
      );
    }

    await sql.unsafe(`TRUNCATE TABLE ${tableIdent}`);

    if (!table.rows.length) continue;

    const columnList = table.columns.map((column) => quotePgIdentifier(column.name)).join(', ');
    const columnCount = table.columns.length;
    const batchSize = Math.max(1, Math.min(250, Math.floor(60000 / Math.max(1, columnCount))));

    for (let offset = 0; offset < table.rows.length; offset += batchSize) {
      const batch = table.rows.slice(offset, offset + batchSize);
      const params = [];
      const valueGroups = batch.map((row) => {
        const placeholders = row.map((value) => {
          params.push(normalizePgValue(value));
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await sql.unsafe(
        `INSERT INTO ${tableIdent} (${columnList}) VALUES ${valueGroups.join(', ')}`,
        params
      );
    }
  }

  const counts = Object.fromEntries(tables.map((table) => [table.name, table.rows.length]));
  await sql.unsafe(`
    INSERT INTO ${POSTGRES_SYNC_META_TABLE}(id, sqlite_checksum_sha256, table_counts_json, synced_at)
    VALUES(1, $1, $2::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET
      sqlite_checksum_sha256 = EXCLUDED.sqlite_checksum_sha256,
      table_counts_json = EXCLUDED.table_counts_json,
      synced_at = NOW()
  `, [checksum, JSON.stringify(counts)]);
}


function getPostgresUrl() {
  return String(process.env.DATABASE_URL || process.env.POSTGRES_URL || '').trim();
}

async function connectPostgresPersistence() {
  const connectionString = getPostgresUrl();
  if (!connectionString) return null;

  postgresClient = postgres(connectionString, {
    max: Number(process.env.PG_POOL_MAX || 2),
    prepare: false
  });

  await postgresClient`SELECT 1`;
  await postgresClient.unsafe(`
    CREATE TABLE IF NOT EXISTS ${POSTGRES_STATE_TABLE} (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      db_data BYTEA NOT NULL,
      checksum_sha256 TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await postgresClient.unsafe(`
    CREATE TABLE IF NOT EXISTS ${POSTGRES_SYNC_META_TABLE} (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      sqlite_checksum_sha256 TEXT NOT NULL,
      table_counts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await postgresClient.unsafe(
    `SELECT db_data, checksum_sha256, updated_at FROM ${POSTGRES_STATE_TABLE} WHERE id = 1`
  );
  if (!result.length || !result[0].db_data) return null;

  const data = Buffer.from(result[0].db_data);
  const actualChecksum = crypto.createHash('sha256').update(data).digest('hex');
  if (result[0].checksum_sha256 && result[0].checksum_sha256 !== actualChecksum) {
    throw new Error('PostgreSQL Star Club snapshot checksum mismatch');
  }
  return data;
}

function queuePostgresSnapshot(data) {
  if (!postgresClient || !postgresPersistenceReady) return;
  pendingPostgresSnapshot = {
    data: Buffer.from(data),
    tables: buildRelationalSnapshot()
  };
  if (postgresPersistWorker) return;

  postgresPersistWorker = (async () => {
    while (pendingPostgresSnapshot) {
      const snapshot = pendingPostgresSnapshot;
      pendingPostgresSnapshot = null;
      const checksum = crypto.createHash('sha256').update(snapshot.data).digest('hex');
      try {
        await postgresClient.begin(async (sql) => {
          await sql.unsafe(`
            INSERT INTO ${POSTGRES_STATE_TABLE}(id, db_data, checksum_sha256, updated_at)
            VALUES(1, $1, $2, NOW())
            ON CONFLICT (id) DO UPDATE SET
              db_data = EXCLUDED.db_data,
              checksum_sha256 = EXCLUDED.checksum_sha256,
              updated_at = NOW()
          `, [snapshot.data, checksum]);

          await syncRelationalTablesToPostgres(sql, snapshot.tables, checksum);
        });
        lastPostgresPersistError = null;
      } catch (error) {
        lastPostgresPersistError = error;
        if (!pendingPostgresSnapshot) pendingPostgresSnapshot = snapshot;
        console.error('Star Club PostgreSQL persistence failed:', error.message || error);
        break;
      }
    }
  })().finally(() => {
    postgresPersistWorker = null;
  });
}

function ensureDb() {
  if (!innerDb) throw new Error('Database is not initialized. Call await initDb() first.');
}

function normalizeParams(args, sql = '') {
  if (args.length === 1 && Array.isArray(args[0])) return args[0].map((value) => value === undefined ? null : value);

  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Date)) {
    const source = args[0];
    const placeholders = Array.from(sql.matchAll(/([:@$][A-Za-z_][A-Za-z0-9_]*)/g)).map((m) => m[1]);

    if (!placeholders.length) return source;

    const bound = {};
    for (const placeholder of new Set(placeholders)) {
      const plain = placeholder.slice(1);
      if (Object.prototype.hasOwnProperty.call(source, placeholder)) bound[placeholder] = source[placeholder];
      else if (Object.prototype.hasOwnProperty.call(source, plain)) bound[placeholder] = source[plain];
    }
    for (const key of Object.keys(bound)) if (bound[key] === undefined) bound[key] = null;
    return bound;
  }

  return args.map((value) => value === undefined ? null : value);
}

function convertRow(row = {}) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = value;
  return out;
}

function saveDb() {
  ensureDb();
  const data = Buffer.from(innerDb.export());
  fs.writeFileSync(resolvedDbFile, data);
  queuePostgresSnapshot(data);
}

class StatementWrapper {
  constructor(sql) {
    this.sql = sql;
  }

  _makeStatement(args) {
    ensureDb();
    const stmt = innerDb.prepare(this.sql);
    const params = normalizeParams(args, this.sql);
    if (Array.isArray(params)) {
      if (params.length) stmt.bind(params);
    } else if (params && typeof params === 'object') {
      stmt.bind(params);
    }
    return stmt;
  }

  run(...args) {
    const stmt = this._makeStatement(args);
    try {
      while (stmt.step()) {}
      const rows = innerDb.exec('SELECT last_insert_rowid() AS id');
      const lastInsertRowid = rows?.[0]?.values?.[0]?.[0] ?? 0;
      const changes = innerDb.getRowsModified();
      if (transactionDepth === 0) saveDb();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  get(...args) {
    const stmt = this._makeStatement(args);
    try {
      if (!stmt.step()) return undefined;
      return convertRow(stmt.getAsObject());
    } finally {
      stmt.free();
    }
  }

  all(...args) {
    const stmt = this._makeStatement(args);
    try {
      const rows = [];
      while (stmt.step()) rows.push(convertRow(stmt.getAsObject()));
      return rows;
    } finally {
      stmt.free();
    }
  }
}

export const db = {
  exec(sql) {
    ensureDb();
    const result = innerDb.exec(sql);
    if (transactionDepth === 0) saveDb();
    return result;
  },
  prepare(sql) {
    return new StatementWrapper(sql);
  },
   transaction(fn) {
    return (...args) => {
      ensureDb();
      const isOuterTransaction = transactionDepth === 0;
      if (isOuterTransaction) innerDb.exec('BEGIN TRANSACTION');
      transactionDepth += 1;
      try {
        const result = fn(...args);
        transactionDepth -= 1;
        if (isOuterTransaction) {
          innerDb.exec('COMMIT');
          saveDb();
        }
        return result;
      } catch (error) {
        transactionDepth -= 1;
        if (isOuterTransaction) {
          try { innerDb.exec('ROLLBACK'); } catch {}
          saveDb();
        }
        throw error;
      }
    };
  }

};

export function nowIso() {
  return new Date().toISOString();
}

export function randomToken(prefix = '') {
  return prefix + crypto.randomBytes(18).toString('hex');
}

export function hashPassword(password) {
  const text = String(password || '');
  if (text.length < 6) throw new Error('Password must contain at least 6 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 120000;
  const hash = crypto.pbkdf2Sync(text, salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2_sha256$${iterations}$${salt}$${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!password || !storedHash) return false;
  const parts = String(storedHash).split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  const actual = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256').toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

export function generateCardNumber() {
  const tail = Array.from({ length: 10 }, () => Math.floor(Math.random() * 10)).join('');
  return `SC ${tail.slice(0, 4)} ${tail.slice(4, 8)} ${tail.slice(8)}`;
}

export function normalizePhone(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');

  // Ukrainian phone numbers only for the MVP.
  // Accepted formats: +380XXXXXXXXX, 380XXXXXXXXX, 0XXXXXXXXX.
  if (/^380\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+38${digits}`;

  return null;
}

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE,
      phone TEXT UNIQUE,
      name TEXT,
      birth_date TEXT,
      favorite_store TEXT,
      email TEXT,
      marketing_allowed INTEGER DEFAULT 1,
      consent_rules_at TEXT,
      consent_personal_data_at TEXT,
      consent_phone_at TEXT,
      consent_version TEXT,
      preferences TEXT,
      card_number TEXT UNIQUE NOT NULL,
      card_token TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      password_set_at TEXT,
      stars_balance INTEGER DEFAULT 0,
      profile_bonus_awarded INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      registered_at TEXT NOT NULL,
      last_purchase_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      name TEXT NOT NULL,
      address TEXT,
      work_hours TEXT,
      phone TEXT,
      image_url TEXT,
      source TEXT DEFAULT 'manual',
      synced_at TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      external_id TEXT UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      group_external_id TEXT,
      group_name TEXT,
      group_path_json TEXT,
      image_url TEXT,
      price_cents INTEGER DEFAULT 0,
      is_alcohol INTEGER DEFAULT 0,
      is_tobacco INTEGER DEFAULT 0,
      is_min_margin INTEGER DEFAULT 0,
      no_star_accrual INTEGER DEFAULT 0,
      no_redeem INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_store_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
      synced_price_cents INTEGER NOT NULL DEFAULT 0,
      manual_price_cents INTEGER,
      use_manual_price INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(product_id, store_id)
    );

    CREATE TABLE IF NOT EXISTS product_barcodes (
      barcode TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS star_accrual_exclusions (
      product_external_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS star_accrual_group_exclusions (
      group_external_id TEXT PRIMARY KEY,
      group_name TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS star_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      source TEXT,
      receipt_id TEXT,
      reward_qr_id INTEGER,
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS change_accrual_operations (
      id TEXT PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      card_token TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      stars_amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      operation_type TEXT NOT NULL DEFAULT 'change',
      receipt_id TEXT,
      receipt_number TEXT,
      fiscal_receipt_number TEXT,
      store_id TEXT,
      store_name TEXT,
      cash_register TEXT,
      cashier TEXT,
      cancel_reason TEXT,
      ledger_id INTEGER REFERENCES star_ledger(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      cancelled_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      fiscal_number TEXT,
      client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      store_id TEXT,
      cash_register TEXT,
      cashier TEXT,
      total_cents INTEGER NOT NULL,
      eligible_cents INTEGER NOT NULL,
      excluded_cents INTEGER NOT NULL,
      stars_accrued INTEGER DEFAULT 0,
      stars_spent INTEGER DEFAULT 0,
      club_conditions_json TEXT,
      is_return INTEGER DEFAULT 0,
      original_receipt_id TEXT,
      purchased_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS receipt_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
      product_id TEXT,
      external_product_id TEXT,
      name TEXT NOT NULL,
      category TEXT,
      qty REAL NOT NULL,
      price_cents INTEGER NOT NULL,
      line_total_cents INTEGER NOT NULL,
      is_alcohol INTEGER DEFAULT 0,
      is_tobacco INTEGER DEFAULT 0,
      is_min_margin INTEGER DEFAULT 0,
      no_star_accrual INTEGER DEFAULT 0,
      no_redeem INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reward_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_external_id TEXT,
      name TEXT NOT NULL,
      image_url TEXT,
      stars_price INTEGER NOT NULL,
      store_id TEXT,
      active_from TEXT,
      active_to TEXT,
      total_limit INTEGER,
      per_client_limit INTEGER DEFAULT 1,
      issued_count INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      conditions TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reward_qrs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      reward_product_id INTEGER NOT NULL REFERENCES reward_products(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL,
      stars_reserved INTEGER NOT NULL,
      source_type TEXT DEFAULT 'stars',
      program_id INTEGER,
      receipt_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      canceled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      product_external_id TEXT,
      category TEXT,
      target_type TEXT,
      target_value TEXT,
      price_mode TEXT,
      price_value REAL,
      priority INTEGER DEFAULT 100,
      parent_offer_id INTEGER,
      visible_in_app INTEGER DEFAULT 1,
      rounding_mode TEXT DEFAULT 'kopeck',
      club_price_cents INTEGER,
      old_price_cents INTEGER,
      calculated_old_price_cents INTEGER,
      calculated_new_price_cents INTEGER,
      manual_old_price_cents INTEGER,
      use_manual_old_price INTEGER DEFAULT 0,
      manual_new_price_cents INTEGER,
      use_manual_new_price INTEGER DEFAULT 0,
      stars_multiplier REAL,
      tiers_json TEXT,
      store_id TEXT,
      audience TEXT DEFAULT 'all',
      active_from TEXT,
      active_to TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promo_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      current_price_cents INTEGER,
      old_price_cents INTEGER,
      badge TEXT,
      store_id TEXT DEFAULT 'all',
      active_from TEXT,
      active_to TEXT,
      is_active INTEGER DEFAULT 1,
      source_offer_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stamp_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      target_type TEXT DEFAULT 'group',
      target_value TEXT,
      target_name TEXT,
      required_qty INTEGER NOT NULL,
      reward_stars INTEGER NOT NULL,
      is_repeatable INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_stamp_progress (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      program_id INTEGER NOT NULL REFERENCES stamp_programs(id) ON DELETE CASCADE,
      progress INTEGER DEFAULT 0,
      completed_count INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (client_id, program_id)
    );

    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      required_visits INTEGER NOT NULL,
      min_total_cents INTEGER DEFAULT 0,
      reward_stars INTEGER NOT NULL,
      period_type TEXT DEFAULT 'week',
      store_id TEXT,
      category TEXT,
      is_repeatable INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      active_from TEXT,
      active_to TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_challenge_days (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      receipt_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (client_id, challenge_id, day)
    );

    CREATE TABLE IF NOT EXISTS client_challenge_rewards (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
      period_key TEXT NOT NULL,
      awarded_at TEXT NOT NULL,
      PRIMARY KEY (client_id, challenge_id, period_key)
    );

    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      image_url TEXT,
      tag TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS home_banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      text TEXT,
      image_url TEXT,
      tag TEXT,
      source_type TEXT DEFAULT 'custom',
      source_id INTEGER,
      link_route TEXT DEFAULT 'offers',
      sort_order INTEGER DEFAULT 100,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      name TEXT,
      username TEXT,
      role TEXT NOT NULL DEFAULT 'admin',
      permissions_json TEXT,
      login TEXT UNIQUE,
      password_hash TEXT,
      password_set_at TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      assigned_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL,
      sender_id TEXT,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS personal_coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      code TEXT UNIQUE NOT NULL,
      product_external_id TEXT,
      product_name TEXT,
      discount_percent INTEGER NOT NULL,
      max_units INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT,
      created_by_admin_id INTEGER,
      banner_title TEXT,
      banner_text TEXT,
      banner_image_url TEXT,
      show_as_banner INTEGER DEFAULT 0,
      notified_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const clientInfo = innerDb.exec('PRAGMA table_info(clients)');
  const clientColumns = new Set((clientInfo?.[0]?.values || []).map((row) => row[1]));
  if (!clientColumns.has('password_hash')) innerDb.run('ALTER TABLE clients ADD COLUMN password_hash TEXT');
  if (!clientColumns.has('password_set_at')) innerDb.run('ALTER TABLE clients ADD COLUMN password_set_at TEXT');

  const storeInfo = innerDb.exec('PRAGMA table_info(stores)');
  const storeColumns = new Set((storeInfo?.[0]?.values || []).map((row) => row[1]));
  if (!storeColumns.has('external_id')) innerDb.run('ALTER TABLE stores ADD COLUMN external_id TEXT');
  if (!storeColumns.has('image_url')) innerDb.run('ALTER TABLE stores ADD COLUMN image_url TEXT');
  if (!storeColumns.has('source')) innerDb.run("ALTER TABLE stores ADD COLUMN source TEXT DEFAULT 'manual'");
  if (!storeColumns.has('synced_at')) innerDb.run('ALTER TABLE stores ADD COLUMN synced_at TEXT');
  if (!storeColumns.has('is_active')) innerDb.run('ALTER TABLE stores ADD COLUMN is_active INTEGER DEFAULT 1');
  if (!storeColumns.has('created_at')) innerDb.run('ALTER TABLE stores ADD COLUMN created_at TEXT');
  if (!storeColumns.has('updated_at')) innerDb.run('ALTER TABLE stores ADD COLUMN updated_at TEXT');
  innerDb.run("UPDATE stores SET external_id = id WHERE external_id IS NULL OR external_id = ''");
  innerDb.run("UPDATE stores SET source = 'manual' WHERE source IS NULL OR source = ''");
  innerDb.run('UPDATE stores SET is_active = 1 WHERE is_active IS NULL');
  innerDb.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_external_id ON stores(external_id)');

  if (!clientColumns.has('consent_rules_at')) innerDb.run('ALTER TABLE clients ADD COLUMN consent_rules_at TEXT');
  if (!clientColumns.has('consent_personal_data_at')) innerDb.run('ALTER TABLE clients ADD COLUMN consent_personal_data_at TEXT');
  if (!clientColumns.has('consent_phone_at')) innerDb.run('ALTER TABLE clients ADD COLUMN consent_phone_at TEXT');
  if (!clientColumns.has('consent_version')) innerDb.run('ALTER TABLE clients ADD COLUMN consent_version TEXT');

  const stampInfo = innerDb.exec('PRAGMA table_info(stamp_programs)');
  const stampColumns = new Set((stampInfo?.[0]?.values || []).map((row) => row[1]));
  if (!stampColumns.has('target_type')) innerDb.run("ALTER TABLE stamp_programs ADD COLUMN target_type TEXT DEFAULT 'group'");
  if (!stampColumns.has('target_value')) innerDb.run('ALTER TABLE stamp_programs ADD COLUMN target_value TEXT');
  if (!stampColumns.has('target_name')) innerDb.run('ALTER TABLE stamp_programs ADD COLUMN target_name TEXT');
  innerDb.run("UPDATE stamp_programs SET target_value = category WHERE target_value IS NULL OR target_value = ''");
  innerDb.run("UPDATE stamp_programs SET target_type = 'group' WHERE target_type IS NULL OR target_type = ''");

  const adminInfo = innerDb.exec('PRAGMA table_info(admin_users)');
  const adminColumns = new Set((adminInfo?.[0]?.values || []).map((row) => row[1]));
  if (!adminColumns.has('login')) innerDb.run('ALTER TABLE admin_users ADD COLUMN login TEXT');
  if (!adminColumns.has('password_hash')) innerDb.run('ALTER TABLE admin_users ADD COLUMN password_hash TEXT');
  if (!adminColumns.has('password_set_at')) innerDb.run('ALTER TABLE admin_users ADD COLUMN password_set_at TEXT');

  const couponInfo = innerDb.exec('PRAGMA table_info(personal_coupons)');
  const couponColumns = new Set((couponInfo?.[0]?.values || []).map((row) => row[1]));
  if (!couponColumns.has('banner_title')) innerDb.run('ALTER TABLE personal_coupons ADD COLUMN banner_title TEXT');
  if (!couponColumns.has('banner_text')) innerDb.run('ALTER TABLE personal_coupons ADD COLUMN banner_text TEXT');
  if (!couponColumns.has('banner_image_url')) innerDb.run('ALTER TABLE personal_coupons ADD COLUMN banner_image_url TEXT');
  if (!couponColumns.has('show_as_banner')) innerDb.run('ALTER TABLE personal_coupons ADD COLUMN show_as_banner INTEGER DEFAULT 0');
  if (!couponColumns.has('notified_at')) innerDb.run('ALTER TABLE personal_coupons ADD COLUMN notified_at TEXT');
  if (!couponColumns.has('max_units')) innerDb.run('ALTER TABLE personal_coupons ADD COLUMN max_units INTEGER NOT NULL DEFAULT 1');
  innerDb.run('UPDATE personal_coupons SET max_units = 1 WHERE max_units IS NULL OR max_units < 1');

  const changeAccrualInfo = innerDb.exec('PRAGMA table_info(change_accrual_operations)');
  const changeAccrualColumns = new Set((changeAccrualInfo?.[0]?.values || []).map((row) => row[1]));
  if (!changeAccrualColumns.has('operation_type')) {
    innerDb.run("ALTER TABLE change_accrual_operations ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'change'");
  }
  innerDb.run("UPDATE change_accrual_operations SET operation_type = 'change' WHERE operation_type IS NULL OR operation_type = ''");

  const rewardQrInfo = innerDb.exec('PRAGMA table_info(reward_qrs)');
  const rewardQrColumns = new Set((rewardQrInfo?.[0]?.values || []).map((row) => row[1]));
  if (!rewardQrColumns.has('source_type')) innerDb.run("ALTER TABLE reward_qrs ADD COLUMN source_type TEXT DEFAULT 'stars'");
  if (!rewardQrColumns.has('program_id')) innerDb.run('ALTER TABLE reward_qrs ADD COLUMN program_id INTEGER');
  innerDb.run("UPDATE reward_qrs SET source_type = 'stars' WHERE source_type IS NULL");

  // Internal program rewards are redeemable only through a client's earned QR.
  const rewardProductInfo = innerDb.exec('PRAGMA table_info(reward_products)');
  const rewardProductColumns = new Set((rewardProductInfo?.[0]?.values || []).map((row) => row[1]));
  if (!rewardProductColumns.has('is_program_reward')) {
    innerDb.run('ALTER TABLE reward_products ADD COLUMN is_program_reward INTEGER NOT NULL DEFAULT 0');
    // Identify only legacy auto-created rewards; keep ordinary catalog gifts unchanged.
    innerDb.run(`UPDATE reward_products SET is_program_reward = 1
      WHERE stars_price = 0
        AND conditions LIKE 'Безкоштовний код за накопичувальною програмою «%»'
        AND EXISTS (SELECT 1 FROM reward_qrs q WHERE q.reward_product_id = reward_products.id
          AND q.source_type = 'stamp_program')`);
  }



  const productPricingInfo = innerDb.exec('PRAGMA table_info(products)');
  const productPricingColumns = new Set((productPricingInfo?.[0]?.values || []).map((row) => row[1]));
  if (!productPricingColumns.has('group_external_id')) innerDb.run('ALTER TABLE products ADD COLUMN group_external_id TEXT');
  if (!productPricingColumns.has('group_name')) innerDb.run('ALTER TABLE products ADD COLUMN group_name TEXT');
  if (!productPricingColumns.has('group_path_json')) innerDb.run('ALTER TABLE products ADD COLUMN group_path_json TEXT');

  const offerPricingInfo = innerDb.exec('PRAGMA table_info(offers)');
  const offerPricingColumns = new Set((offerPricingInfo?.[0]?.values || []).map((row) => row[1]));
  if (!offerPricingColumns.has('target_type')) innerDb.run('ALTER TABLE offers ADD COLUMN target_type TEXT');
  if (!offerPricingColumns.has('target_value')) innerDb.run('ALTER TABLE offers ADD COLUMN target_value TEXT');
  if (!offerPricingColumns.has('price_mode')) innerDb.run('ALTER TABLE offers ADD COLUMN price_mode TEXT');
  if (!offerPricingColumns.has('price_value')) innerDb.run('ALTER TABLE offers ADD COLUMN price_value REAL');
  if (!offerPricingColumns.has('priority')) innerDb.run('ALTER TABLE offers ADD COLUMN priority INTEGER DEFAULT 100');
  if (!offerPricingColumns.has('parent_offer_id')) innerDb.run('ALTER TABLE offers ADD COLUMN parent_offer_id INTEGER');
  if (!offerPricingColumns.has('visible_in_app')) innerDb.run('ALTER TABLE offers ADD COLUMN visible_in_app INTEGER DEFAULT 1');
  if (!offerPricingColumns.has('rounding_mode')) innerDb.run("ALTER TABLE offers ADD COLUMN rounding_mode TEXT DEFAULT 'kopeck'");
  if (!offerPricingColumns.has('calculated_old_price_cents')) innerDb.run('ALTER TABLE offers ADD COLUMN calculated_old_price_cents INTEGER');
  if (!offerPricingColumns.has('calculated_new_price_cents')) innerDb.run('ALTER TABLE offers ADD COLUMN calculated_new_price_cents INTEGER');
  if (!offerPricingColumns.has('manual_old_price_cents')) innerDb.run('ALTER TABLE offers ADD COLUMN manual_old_price_cents INTEGER');
  if (!offerPricingColumns.has('use_manual_old_price')) innerDb.run('ALTER TABLE offers ADD COLUMN use_manual_old_price INTEGER DEFAULT 0');
  if (!offerPricingColumns.has('manual_new_price_cents')) innerDb.run('ALTER TABLE offers ADD COLUMN manual_new_price_cents INTEGER');
  if (!offerPricingColumns.has('use_manual_new_price')) innerDb.run('ALTER TABLE offers ADD COLUMN use_manual_new_price INTEGER DEFAULT 0');

  innerDb.run(`
    UPDATE offers
    SET target_type = CASE
      WHEN product_external_id IS NOT NULL AND product_external_id <> '' THEN 'product'
      WHEN category IS NOT NULL AND category <> '' THEN 'group'
      ELSE 'none'
    END
    WHERE target_type IS NULL OR target_type = ''
  `);
  innerDb.run(`
    UPDATE offers
    SET target_value = COALESCE(product_external_id, category)
    WHERE target_value IS NULL
  `);
  innerDb.run(`
    UPDATE offers
    SET price_mode = 'fixed', price_value = club_price_cents
    WHERE type = 'club'
      AND club_price_cents IS NOT NULL
      AND (price_mode IS NULL OR price_mode = '')
  `);
  innerDb.run(`
    UPDATE offers
    SET priority = CASE
      WHEN type = 'wholesale' AND target_type = 'product' THEN 450
      WHEN type = 'wholesale' THEN 400
      WHEN type = 'club' AND target_type = 'product' THEN 300
      WHEN type = 'club' THEN 200
      ELSE 100
    END
    WHERE priority IS NULL OR priority = 100
  `);
  innerDb.run('UPDATE offers SET visible_in_app = 1 WHERE visible_in_app IS NULL');
  innerDb.run("UPDATE offers SET rounding_mode = 'kopeck' WHERE rounding_mode IS NULL OR rounding_mode = ''");
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_products_group_external_id ON products(group_external_id)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_receipts_client_date ON receipts(client_id, purchased_at DESC)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt ON receipt_items(receipt_id)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_ledger_client_date ON star_ledger(client_id, created_at DESC)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_date ON support_messages(ticket_id, created_at)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_support_tickets_client_date ON support_tickets(client_id, updated_at DESC)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_product_store_prices_store ON product_store_prices(store_id, product_id)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_product_store_prices_product ON product_store_prices(product_id, store_id)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id, barcode)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_offers_target ON offers(target_type, target_value)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_promo_offers_active ON promo_offers(type, is_active)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_home_banners_active ON home_banners(is_active, sort_order, id)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_change_accrual_status ON change_accrual_operations(status, created_at)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_change_accrual_client ON change_accrual_operations(client_id, created_at)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_change_accrual_receipt ON change_accrual_operations(receipt_id)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_star_group_exclusions ON star_accrual_group_exclusions(group_external_id)');
  innerDb.run('CREATE INDEX IF NOT EXISTS idx_personal_coupons_client_status ON personal_coupons(client_id, status, expires_at)');

  // Одноразово переносимо старі видимі клубні/оптові картки у нову статичну вітрину.
  // Реальні правила ціни залишаються в offers і продовжують працювати окремо.
  innerDb.run(`
    INSERT INTO promo_offers(
      type, name, description, image_url, current_price_cents, old_price_cents,
      badge, store_id, active_from, active_to, is_active, source_offer_id, created_at, updated_at
    )
    SELECT
      o.type, o.name, o.description, o.image_url,
      CASE
        WHEN o.type = 'club' AND COALESCE(o.price_mode, '') = 'fixed' THEN CAST(o.price_value AS INTEGER)
        WHEN o.type = 'club' THEN o.club_price_cents
        ELSE NULL
      END,
      o.old_price_cents,
      CASE WHEN o.type = 'wholesale' THEN 'ОПТОВА ПРОПОЗИЦІЯ' ELSE 'КЛУБНА ЦІНА' END,
      COALESCE(o.store_id, 'all'), o.active_from, o.active_to, o.is_active, o.id, o.created_at, o.updated_at
    FROM offers o
    WHERE o.type IN ('club', 'wholesale')
      AND COALESCE(o.visible_in_app, 1) = 1
      AND NOT EXISTS (SELECT 1 FROM promo_offers p WHERE p.source_offer_id = o.id)
  `);
}


function setDefaultSetting(key, value) {
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)').run(key, JSON.stringify(value));
}

export function seed() {
  const t = nowIso();
  setDefaultSetting('profile_bonus', {
    enabled: true,
    stars: 500,
    grantWhen: 'immediately',
    requiredFields: ['phone', 'name', 'birth_date', 'favorite_store']
  });
  setDefaultSetting('stars_rules', {
    accrual: '1 UAH = 1 star',
    showMoneyEquivalentToClient: false
  });
  setDefaultSetting('home_banners', { enabled: true });
  setDefaultSetting('client_cleanup', {
    enabled: true,
    deletePositiveBalance: true,
    positiveInactiveDays: 183,
    positiveMinBalance: 1,
    positiveMaxBalance: null,
    deleteZeroBalance: true,
    zeroInactiveDays: 183,
    lastRunAt: null,
    lastDeletedCount: 0
  });

  // Default browser Owner for the desktop admin panel.
  // Login: owner / Password: StarClub2026!
  // Change it from the Owner section after the first launch.
  const ownerLogin = process.env.DEFAULT_OWNER_LOGIN || 'owner';
  const ownerPassword = process.env.DEFAULT_OWNER_PASSWORD || 'StarClub2026!';
  const existingOwnerLogin = db.prepare('SELECT id FROM admin_users WHERE login = ?').get(ownerLogin);
  const existingOwnerRole = db.prepare("SELECT id FROM admin_users WHERE role = 'owner' AND login IS NOT NULL LIMIT 1").get();
  if (!existingOwnerLogin && !existingOwnerRole) {
    db.prepare(`INSERT INTO admin_users(telegram_id, name, username, role, permissions_json, login, password_hash, password_set_at, is_active, created_at, updated_at)
      VALUES(?, ?, ?, 'owner', '[]', ?, ?, ?, 1, ?, ?)`)
      .run('owner-web', 'Owner', null, ownerLogin, hashPassword(ownerPassword), t, t, t);
  }

  const stores = [
    ['star-center', 'Star Центр', 'вул. Центральна, 10', '08:00–22:00', '+380000000001'],
    ['star-market', 'Star Маркет', 'вул. Шевченка, 24', '08:00–22:00', '+380000000002'],
    ['star-bakery', 'Star Bakery', 'вул. Миру, 5', '07:30–21:30', '+380000000003']
  ];
  const insertStore = db.prepare(`INSERT OR IGNORE INTO stores(
    id, external_id, name, address, work_hours, phone, image_url, source, synced_at, is_active, created_at, updated_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, 'seed', NULL, 1, ?, ?)`);
  stores.forEach((s) => insertStore.run(s[0], s[0], s[1], s[2], s[3], s[4], '/assets/star.svg', t, t));

  const rewardsCount = db.prepare('SELECT COUNT(*) AS c FROM reward_products').get().c;
  if (!rewardsCount) {
    const insertReward = db.prepare(`
      INSERT INTO reward_products(name, image_url, stars_price, store_id, active_from, active_to, total_limit, per_client_limit, conditions, created_at, updated_at)
      VALUES(@name, @image_url, @stars_price, @store_id, @active_from, @active_to, @total_limit, @per_client_limit, @conditions, @created_at, @updated_at)
    `);
    [
      ['Кава', '/assets/coffee.svg', 3000, 'all', 'Доступно у магазинах з кавовим апаратом'],
      ['Багет', '/assets/baguette.svg', 2500, 'all', 'Товар видається за наявності на полиці'],
      ['Круасан', '/assets/croissant.svg', 2000, 'all', 'Один товар на клієнта за один QR'],
      ['Вода 0,5 л', '/assets/water.svg', 1500, 'all', 'Не сумується з іншими умовами']
    ].forEach(([name, image_url, stars_price, store_id, conditions]) => insertReward.run({
      name, image_url, stars_price, store_id, conditions,
      active_from: t, active_to: null, total_limit: null, per_client_limit: 3, created_at: t, updated_at: t
    }));
  }

  const offersCount = db.prepare('SELECT COUNT(*) AS c FROM offers').get().c;
  if (!offersCount) {
    const insertOffer = db.prepare(`
      INSERT INTO offers(type, name, description, image_url, club_price_cents, old_price_cents, stars_multiplier, tiers_json, store_id, audience, active_from, active_to, created_at, updated_at)
      VALUES(@type, @name, @description, @image_url, @club_price_cents, @old_price_cents, @stars_multiplier, @tiers_json, @store_id, @audience, @active_from, @active_to, @created_at, @updated_at)
    `);
    [
      { type: 'club', name: 'Ароматна кава', description: 'Клубна ціна для учасників Star Club', image_url: '/assets/coffee.svg', club_price_cents: 3500, old_price_cents: 4500, stars_multiplier: null, tiers_json: null },
      { type: 'club', name: 'Круасан вершковий', description: 'Свіжа випічка щодня', image_url: '/assets/croissant.svg', club_price_cents: 4200, old_price_cents: 5500, stars_multiplier: null, tiers_json: null },
      { type: 'club', name: 'Подвійні зірки на випічку', description: 'Отримуйте x2 зірки за покупки у категорії Випічка', image_url: '/assets/star.svg', club_price_cents: null, old_price_cents: null, stars_multiplier: 2, tiers_json: null },
      { type: 'wholesale', name: 'Кава зернова 1 кг', description: 'Вигідні умови для оптових покупок', image_url: '/assets/coffee-bag.svg', club_price_cents: null, old_price_cents: null, stars_multiplier: null, tiers_json: JSON.stringify([{ qty: 1, price: 45 }, { qty: 2, price: 39 }, { qty: 3, price: 36 }]) },
      { type: 'wholesale', name: 'Вода негазована 0,5 л', description: 'Чим більше — тим вигідніше', image_url: '/assets/water.svg', club_price_cents: null, old_price_cents: null, stars_multiplier: null, tiers_json: JSON.stringify([{ qty: 1, price: 15 }, { qty: 2, price: 13 }, { qty: 3, price: 12 }]) }
    ].forEach((o) => insertOffer.run({ ...o, store_id: 'all', audience: 'all', active_from: t, active_to: null, created_at: t, updated_at: t }));
  }

  const stampCount = db.prepare('SELECT COUNT(*) AS c FROM stamp_programs').get().c;
  if (!stampCount) {
    const insert = db.prepare('INSERT INTO stamp_programs(code, name, category, required_qty, reward_stars, is_repeatable, is_active, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('coffee-10', '10-та кава', 'coffee', 9, 0, 1, 1, t);
    insert.run('baguette-10', '10-й багет', 'bakery', 9, 0, 1, 1, t);
  }

  db.prepare("UPDATE stamp_programs SET required_qty = 9, reward_stars = 0 WHERE code IN ('coffee-10', 'baguette-10') AND required_qty = 10").run();

  const challengeCount = db.prepare('SELECT COUNT(*) AS c FROM challenges').get().c;
  if (!challengeCount) {
    const insert = db.prepare(`INSERT INTO challenges(code, name, description, required_visits, min_total_cents, reward_stars, period_type, store_id, category, is_repeatable, is_active, active_from, active_to, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('7-days-star', '7 днів зі Star', 'Купуйте у Star 7 різних днів протягом тижня та отримайте бонус', 7, 5000, 1000, 'week', 'all', null, 1, 1, t, null, t);
    insert.run('5-purchases-week', '5 покупок цього тижня', 'Здійсніть 5 покупок у різні дні', 5, 10000, 750, 'week', 'all', null, 1, 1, t, null, t);
  }

  const newsCount = db.prepare('SELECT COUNT(*) AS c FROM news').get().c;
  if (!newsCount) {
    const insert = db.prepare('INSERT INTO news(title, text, image_url, tag, is_active, created_at) VALUES(?, ?, ?, ?, ?, ?)');
    insert.run('Сезонний раф «Карамельний горіх»', 'Спробуйте новий смак цієї осені.', '/assets/coffee.svg', 'Новинка', 1, t);
    insert.run('Свіжа випічка щодня', 'Щойно з печі — для вас.', '/assets/croissant.svg', 'У магазинах', 1, t);
    insert.run('Подвійні зірки на вихідних', 'Отримуйте більше зірок за кожну покупку.', '/assets/star.svg', 'Star Club', 1, t);
  }

  const bannersInitialized = db.prepare("SELECT value FROM settings WHERE key = 'home_banners_initialized'").get();
  if (!bannersInitialized) {
    const insertBanner = db.prepare(`INSERT INTO home_banners(
      title, text, image_url, tag, source_type, source_id, link_route, sort_order, is_active, created_at, updated_at
    ) VALUES(?, ?, ?, ?, 'custom', NULL, 'news', ?, 1, ?, ?)`);
    db.prepare('SELECT * FROM news WHERE is_active = 1 ORDER BY created_at DESC LIMIT 4').all()
      .forEach((item, index) => insertBanner.run(item.title, item.text, item.image_url || '/assets/star.svg', item.tag || 'STAR CLUB', (index + 1) * 10, t, t));
    db.prepare("INSERT INTO settings(key, value) VALUES('home_banners_initialized', 'true')").run();
  }

  // У production/MVP за замовчуванням НЕ створюємо фейкових клієнтів, чеків, відвідувань або прогресу.
  // Система стартує з реальних довідників, правил і каталогів, а клієнтські показники зʼявляються
  // тільки після реєстрації та чеків, які прийшли з 1С через API.
  if (String(process.env.ENABLE_DEMO_ACCOUNT || 'false') === 'true') {
    const clientCount = db.prepare('SELECT COUNT(*) AS c FROM clients').get().c;
    if (!clientCount) {
      const cardNumber = 'SC 0000 0000 0001';
      const cardToken = randomToken('card_');
      db.prepare(`
        INSERT INTO clients(telegram_id, phone, name, birth_date, favorite_store, email, marketing_allowed, card_number, card_token, password_hash, password_set_at, stars_balance, profile_bonus_awarded, registered_at, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('111111111', '+380501112233', 'Тестовий клієнт', '1995-05-17', 'star-center', null, 1, cardNumber, cardToken, hashPassword('123456'), t, 0, 0, t, t, t);
    }
  }
}

export async function initDb() {
  if (initialized) return;

  const postgresUrl = getPostgresUrl();
  const isRailway = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID
  );
  if (isRailway && !postgresUrl) {
    throw new Error(
      'PostgreSQL is not connected. Add DATABASE_URL=${{Postgres.DATABASE_URL}} to this backend service in Railway Variables.'
    );
  }
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });

  let postgresSnapshot = null;
  if (postgresUrl) {
    try {
      postgresSnapshot = await connectPostgresPersistence();
    } catch (error) {
      try { await postgresClient?.end({ timeout: 2 }); } catch {}
      postgresClient = null;
      throw new Error(`PostgreSQL is configured but unavailable: ${error.message || error}`);
    }
  }

  if (postgresSnapshot?.length) {
    innerDb = new SQL.Database(postgresSnapshot);
    console.log('Star Club database: restored persistent state from PostgreSQL');
  } else if (fs.existsSync(resolvedDbFile) && fs.statSync(resolvedDbFile).size > 0) {
    innerDb = new SQL.Database(fs.readFileSync(resolvedDbFile));
    console.log(postgresClient
      ? 'Star Club database: importing bundled SQLite state into PostgreSQL'
      : `Star Club database: using local SQLite file ${resolvedDbFile}`);
  } else {
    innerDb = new SQL.Database();
    console.log(postgresClient
      ? 'Star Club database: creating a new database and persisting it to PostgreSQL'
      : 'Star Club database: creating a new local SQLite database');
  }

  migrate();
  seed();
  initialized = true;
  postgresPersistenceReady = Boolean(postgresClient);
  saveDb();
  await flushDbPersistence();

  if (postgresClient) {
    const tableCount = buildRelationalSnapshot().length;
    console.log(`Star Club database: PostgreSQL persistence is ready (${tableCount} relational tables synchronized)`);
  }
}

export async function flushDbPersistence() {
  if (pendingPostgresSnapshot && !postgresPersistWorker && postgresClient && postgresPersistenceReady) {
    const snapshot = pendingPostgresSnapshot;
    pendingPostgresSnapshot = null;
    queuePostgresSnapshot(snapshot.data);
  }
  if (postgresPersistWorker) await postgresPersistWorker;
  if (lastPostgresPersistError) throw lastPostgresPersistError;
}

export async function closeDb() {
  if (innerDb) saveDb();
  try {
    await flushDbPersistence();
  } finally {
    if (postgresClient) {
      await postgresClient.end({ timeout: 5 });
      postgresClient = null;
      postgresPersistenceReady = false;
    }
  }
}

export function logAudit({ actorType, actorId, action, entityType, entityId, payload }) {
  db.prepare(`INSERT INTO audit_logs(actor_type, actor_id, action, entity_type, entity_id, payload_json, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)`).run(actorType, actorId || null, action, entityType || null, entityId || null, payload ? JSON.stringify(payload) : null, nowIso());
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function awardStars(clientId, type, amount, source, description, receiptId = null, rewardQrId = null) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new Error('Client not found');
  const balanceAfter = Number(client.stars_balance || 0) + Number(amount);
  db.prepare('UPDATE clients SET stars_balance = ?, updated_at = ? WHERE id = ?').run(balanceAfter, nowIso(), clientId);
  db.prepare(`INSERT INTO star_ledger(client_id, type, amount, balance_after, source, receipt_id, reward_qr_id, description, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(clientId, type, amount, balanceAfter, source, receiptId, rewardQrId, description, nowIso());
  return balanceAfter;
}

export function getReservedStars(clientId) {
  const row = db.prepare(`SELECT COALESCE(SUM(stars_reserved), 0) AS reserved FROM reward_qrs WHERE client_id = ? AND status = 'reserved' AND expires_at > ?`).get(clientId, nowIso());
  return Number(row?.reserved || 0);
}

export function getClientAvailableStars(clientId) {
  const client = db.prepare('SELECT stars_balance FROM clients WHERE id = ?').get(clientId);
  if (!client) return 0;
  return Math.max(0, Number(client.stars_balance || 0) - getReservedStars(clientId));
}

export function getOrCreateClientFromTelegram(telegramUser = {}) {
  const telegramId = String(telegramUser.id || telegramUser.telegram_id || '').trim();
  if (!telegramId) throw new Error('Telegram ID is required');
  const t = nowIso();
  const existing = db.prepare('SELECT * FROM clients WHERE telegram_id = ?').get(telegramId);
  if (existing) return existing;
  const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ') || telegramUser.username || null;
  const phone = normalizePhone(telegramUser.phone_number || telegramUser.phone || '');
  const cardNumber = generateCardNumber();
  const cardToken = randomToken('card_');
  const res = db.prepare(`INSERT INTO clients(telegram_id, phone, name, card_number, card_token, registered_at, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(telegramId, phone, displayName, cardNumber, cardToken, t, t, t);
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(res.lastInsertRowid);
}

export function createSession(clientId) {
  const token = randomToken('sess_');
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString();
  db.prepare('INSERT INTO sessions(token, client_id, created_at, expires_at) VALUES(?, ?, ?, ?)').run(token, clientId, nowIso(), expires);
  return { token, expires_at: expires };
}

export function getClientBySession(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT c.* FROM sessions s JOIN clients c ON c.id = s.client_id WHERE s.token = ? AND s.expires_at > ?`).get(token, nowIso());
  return row || null;
}
