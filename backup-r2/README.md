# Star Club -> Cloudflare R2 backups

A standalone Railway Cron job. Backs up the entire PostgreSQL database (including `starclub_database_state.db_data`), encrypts it using AES-256-GCM and uploads to a private R2 bucket. The Star Club web process remains unchanged.

**Full Ukrainian step-by-step setup:** `../docs/railway-r2-backups.md`.

## Environment variables

See `.env.example`. Set secrets through Railway's **backup service**, not the main web service.

## Run on Railway

- New service from the same repo, Root Directory: `/backup-r2`.
- Dockerfile: `/backup-r2/Dockerfile`.
- Cron Schedule: `0 2 * * *` (02:00 UTC daily).
- Database ref: `DATABASE_URL=${{Postgres.DATABASE_URL}}` (adjust Postgres service name).
- Do not use root `railway.json` on backup service; root config belongs to the web app.

`backup.mjs` runs once and exits 0 on verified upload, nonzero on error.

## Tests

`node --test crypto.test.mjs` validates encryption/decryption, tamper rejection and key validation. Live R2/PG integration requires real secrets and credentials and is intentionally not run in tests.

## Restore test

`node restore-download.mjs "full/R2/object/key.dump.enc" "./restored.dump"` downloads, verifies, decrypts and **does not modify a database**.
Use `pg_restore --list restored.dump` and then restore into a NEW empty test database.
