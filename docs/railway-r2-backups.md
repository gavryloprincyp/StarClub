# Star Club: автоматичний бекап Railway PostgreSQL -> Cloudflare R2

## Що саме копіюється

У цьому проєкті `src/db.js` використовує SQLite (`sql.js`) у пам'яті застосунку, але **при наявності `DATABASE_URL` зберігає повний SQLite-знімок** у PostgreSQL (`starclub_database_state.db_data`) та паралельно синхронізує реляційні таблиці PostgreSQL. Тому тут правильний бекап — **повний `pg_dump` з PostgreSQL**, а не окремі таблиці й не локальний `data/star-club.sqlite` з архіву.

`backup-r2` — самостійний Railway Cron-сервіс. Він не змінює основний `src/db.js`, не видаляє клієнтів, історію, ціни, фотографії та не перезаписує поточну БД. Один запуск створює `pg_dump` у custom-форматі, шифрує AES-256-GCM, завантажує окремий файл до приватного Cloudflare R2 bucket, перевіряє розмір та контрольну суму в метаданих об'єкта, а потім видаляє тимчасові локальні файли. Резервні копії НЕ видаляються скриптом автоматично.

> Важливо: це не онлайн-реплікація та не гарантія нульової втрати даних. При щоденному бекапі відновлення — до стану останнього успішного запуску. Запис стану застосунку в PostgreSQL виконується асинхронно. Для справжнього відновлення потрібне періодичне тестове відновлення на окремій базі.

## 1. Налаштування Cloudflare R2

1. У https://dash.cloudflare.com/ вибери **Storage & databases -> R2 -> Overview**, активуй R2, якщо він ще не активований.
2. Натисни **Create bucket**, наприклад `starclub-backups`. Не вмикай публічну видачу та не налаштовуй публічний домен для цього bucket.
3. У R2 Overview натисни **Manage R2 API Tokens** -> **Create API Token**. Потрібні **Object Read & Write** з обмеженням **тільки на цей bucket**.
4. Збережи секретно `Access Key ID`, `Secret Access Key`. `Account ID` (32 шістнадцяткові символи) знайдеш у Cloudflare Overview. **Це не Global API Key.**
5. Не включай `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `BACKUP_ENCRYPTION_KEY`, `DATABASE_URL` у Git та архів, який публічно надсилаєш.

## 2. Додати окремий сервіс Railway

Працюй в **тому самому Railway project/environment**, де є поточний Star Club backend і PostgreSQL. Нічого не змінюй у налаштуваннях основного Star Club-сервісу.

1. Опублікуй цю версію вихідного коду у **приватному GitHub repo**, який використовує Railway.
2. Railway -> твій Project -> **+ New -> GitHub Repo** -> той самий репозиторій -> перейменуй новий сервіс на `starclub-r2-backup`.
3. У новому сервісі -> **Settings -> Root Directory** встанови **`/backup-r2`**. Build method: Dockerfile з `/backup-r2/Dockerfile` (якщо Railway не знайшов його автоматично, вкажи Dockerfile path вручну). Не використовуй основний `railway.json` цього сайту як конфігурацію backup-сервісу — він містить `npm start` і створений для вебсервісу.
4. **Start Command** залиш відповідним Dockerfile (`node backup.mjs` через ENTRYPOINT); не став `npm start` із кореня основного проєкту. **Публічний домен не потрібен**, Volume для backup-сервісу не потрібен.
5. У backup-сервісі відкрий **Variables** і додай:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (через Railway reference variable, заміни `Postgres` на точну назву твоєї БД) |
| `R2_ACCOUNT_ID` | 32-символьний Account ID Cloudflare |
| `R2_ACCESS_KEY_ID` | Access Key ID з R2 API token |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key з R2 API token |
| `R2_BUCKET` | `starclub-backups` (точна назва створеного bucket) |
| `R2_PREFIX` | `starclub/postgres` |
| `BACKUP_ENCRYPTION_KEY` | випадковий 32-байтовий ключ у Base64 (див. нижче) |

Згенеруй **разово** `BACKUP_ENCRYPTION_KEY` у PowerShell / Terminal з Node.js:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Збережи його **поза Railway**, наприклад у менеджері паролів: без нього не можна розшифрувати бекапи. Не змінюй ключ без окремого плану ротації — старі бекапи лишаться зашифрованими старим ключем.

6. У **Settings -> Cron Schedule** введи **`0 2 * * *`** — щодня о **02:00 UTC** (в Україні 04:00 взимку / 05:00 влітку). Розклад Railway Cron задається в UTC. Збережи й застосуй зміни (**Deploy**).
7. Для першого тесту можна викликати запуск через **Railway Cron Runs -> Run**, якщо відповідна кнопка доступна, або Railway CLI: `railway cron run --service starclub-r2-backup` з уже прив'язаного до правильного проєкту CLI.
8. Переглянь **Logs** нового сервісу. Успішний запуск закінчується рядком **`[StarClub R2] SUCCESS bucket=... key=...`**. Переконайся, що сервіс завершився й не висить Active. У Cloudflare R2 -> bucket -> Objects перевір новий об'єкт у `starclub/postgres/`.

Якщо PostgreSQL-сервіс має іншу назву, у посиланні `DATABASE_URL` використовуй саме її. Не потрібно відкривати PostgreSQL у публічний інтернет, якщо backup-сервіс знаходиться в тому самому Railway-проєкті.

## 3. Зберігання та витрати

Кожен бекап створюється як **новий** `.dump.enc` файл з унікальною міткою часу; наявні об'єкти код **не перезаписує**. Рекомендується налаштувати у **R2 -> bucket -> Settings -> Object Lifecycles** правило зберігання, наприклад **90 днів**, із застосуванням тільки до префікса `starclub/postgres/`. Якщо бажаєш тримати їх довше, не встановлюй видалення. R2 тарифікує обсяг і операції відповідно до твого тарифу.

Тимчасовий простір Cron-контейнера має вміщувати **приблизно удвічі більше**, ніж розмір custom-архіву (`.dump` та його зашифрована копія), плюс запас. Якщо база виросте до гігабайтів, налаштування тимчасового сховища може знадобитися змінити.

## 4. Як перевірити відновлення (спочатку ТІЛЬКИ на новій тестовій PostgreSQL)

1. Завантаж на комп'ютер каталог `backup-r2` та встанови Node.js. Зсередини каталогу виконай `npm install` (або `npm ci`, якщо додаси lock-файл). Встанови `pg_restore` з PostgreSQL 18 client tools.
2. Локально задай **ті самі** `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `BACKUP_ENCRYPTION_KEY`, що й у backup-сервісі (не завантажуй їх у Git).
3. Скопіюй повний ключ файлу зі списку Objects bucket, наприклад `starclub/postgres/2026-10-18T02-00-00.000Z-a1b2c3d4.dump.enc`.
4. У каталозі `backup-r2` виконай:

```sh
node restore-download.mjs "starclub/postgres/НАЗВА_ФАЙЛУ.dump.enc" "./restored-starclub.dump"
pg_restore --list ./restored-starclub.dump
```

Скрипт завантажує копію, звіряє SHA-256, перевіряє AES-GCM та створює **локальний файл**. Він **не підключається до живого PostgreSQL** і нічого не видаляє. Якщо файл із такою назвою вже існує, скрипт відмовиться його перезаписувати.

5. Створи **новий порожній тестовий PostgreSQL** і тільки після цього віднови dump у нього:

```sh
pg_restore --dbname="postgresql://USER:PASSWORD@TEST_HOST:5432/TEST_DATABASE" --no-owner --no-acl ./restored-starclub.dump
```

НІКОЛИ не запускай `pg_restore --clean` на живій базі без повного плану міграції. Не перемикай робочий Star Club на відновлену БД, поки не перевіриш `starclub_database_state` і реальні дані у тестовому середовищі. Під час запланованого відновлення production треба зупиняти або ізолювати робочий backend, щоб його дані в пам'яті не перезаписали відновлений snapshot.

## 5. Типові помилки

- `PostgreSQL connection ...`: перевір `DATABASE_URL` і доступ до PostgreSQL. Встанови Railway reference на **тому самому environment**.
- `R2 Account ID`: скопійовано не Account ID Cloudflare, а інше значення. Очікується 32 hex-символи.
- `AccessDenied` / `403`: R2 API token не має Object Read & Write для вибраного bucket, або переплутано key/secret.
- `SignatureDoesNotMatch`: неправильні S3 credentials або Account ID.
- `pg_dump: server version mismatch`: образ використовує PostgreSQL 18 client. Якщо сервер оновився до версії 19+, онови PostgreSQL-клієнт у Dockerfile.
- `BACKUP_ENCRYPTION_KEY`: ключ має містити рівно 32 випадкових байти, закодованих у Base64.
- `Cron пропускає запуски`: задача повинна завершуватись після виконання. Перевір, що в Logs є SUCCESS або BACKUP FAILED і завершення процесу.

**Перший успішний бекап у R2 та успішне тестове відновлення — дві різні перевірки.** Рекомендується регулярно робити тестове відновлення й налаштувати сповіщення про невдалі cron runs.

### Якщо немає підключеного GitHub

Можна розгорнути **тільки** каталог `backup-r2` як окремий сервіс через Railway CLI. Створи новий порожній сервіс `starclub-r2-backup`, авторизуйся через `railway login`, обери правильний проєкт через `railway link`, потім із кореня розпакованого сайту виконай:

```sh
railway up ./backup-r2 --path-as-root
```

Важливо: під час вибору deployment target обери **`starclub-r2-backup`**, а не основний `Star Club`. У новому сервісі так само встанови змінні та Cron Schedule.
