# PostgreSQL 18 pg_dump supports dumps from PostgreSQL servers <= version 18.
# Separate Railway cron service: NOT used for the main Star Club web service.
FROM postgres:18-alpine

RUN apk add --no-cache nodejs npm
WORKDIR /opt/starclub-backup
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY backup.mjs crypto.mjs r2-client.mjs restore-download.mjs ./

# Does a single backup then exits. Railway Cron Schedule controls recurrence.
ENTRYPOINT ["node", "backup.mjs"]
USER postgres
