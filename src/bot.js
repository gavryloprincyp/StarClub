import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { fileURLToPath } from 'url';

 dotenv.config();

function normalizeUrl(value, fallback) {
  const raw = String(value || fallback || '').trim();
  return raw.replace(/\/$/, '');
}

export function createStarClubBot() {
  const token = process.env.BOT_TOKEN;
  const webAppUrl = 'https://web-production-83a01.up.railway.app';
  const adminUrl = `${webAppUrl}/admin`;
  const adminDesktopUrl = `${webAppUrl}/admin-desktop`;

  if (!token || token.startsWith('123456:')) {
    throw new Error('BOT_TOKEN is not configured. Add a real BOT_TOKEN to the environment.');
  }

  const bot = new Telegraf(token);

  bot.telegram.setMyCommands([
    { command: 'start', description: 'Відкрити Star Club' },
    { command: 'club', description: 'Клієнтський застосунок' },
    { command: 'admin', description: 'Адмін-панель' }
  ]).catch((error) => console.warn('Cannot set bot commands:', error.message || error));

  bot.start(async (ctx) => {
    await ctx.reply(
      'Вітаємо у Star Club ⭐\n\nВідкрийте застосунок, отримайте цифрову картку, накопичуйте зірки та користуйтеся клубними пропозиціями.',
      Markup.inlineKeyboard([
        [Markup.button.webApp('Відкрити Star Club', webAppUrl)]
      ])
    );
  });

  bot.command('club', async (ctx) => {
    await ctx.reply(
      'Відкрити клієнтський застосунок Star Club:',
      Markup.inlineKeyboard([[Markup.button.webApp('Відкрити застосунок', webAppUrl)]])
    );
  });

  bot.command('admin', async (ctx) => {
    await ctx.reply(
      'Адмін-панель Star Club\n\nДоступ буде надано лише Telegram ID, зазначеним як Owner або Admin.',
      Markup.inlineKeyboard([
        [Markup.button.webApp('Відкрити мобільну адмін-панель', adminUrl)],
        [Markup.button.url('Адмінка для ПК у браузері', adminDesktopUrl)]
      ])
    );
  });

  bot.catch((error, ctx) => {
    console.error(`Telegram bot error for update ${ctx?.update?.update_id || 'unknown'}:`, error);
  });

  return bot;
}

export async function startStarClubBot() {
  const bot = createStarClubBot();
  await bot.launch();
  console.log('Star Club Telegram bot launched');
  return bot;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startStarClubBot()
    .then((bot) => {
      process.once('SIGINT', () => bot.stop('SIGINT'));
      process.once('SIGTERM', () => bot.stop('SIGTERM'));
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}
