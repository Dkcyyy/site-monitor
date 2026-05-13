require('dotenv').config();

const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const TelegramBot = require('node-telegram-bot-api');
const sslChecker = require('ssl-checker').default;
const pino = require('pino');
const http = require('http');
const { URL } = require('url');

const {
  BOT_TOKEN,
  SITE_URL,
  CHECK_INTERVAL = '60000',
  USER_ID,
  ADMIN_ID,
  PORT = '10000'
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!SITE_URL) throw new Error('SITE_URL missing');

if (!USER_ID || isNaN(Number(USER_ID))) {
  throw new Error('USER_ID invalid');
}

if (!ADMIN_ID || isNaN(Number(ADMIN_ID))) {
  throw new Error('ADMIN_ID invalid');
}

const interval = Math.max(Number(CHECK_INTERVAL), 30000);

const parsedUrl = new URL(SITE_URL);

if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
  throw new Error('Only HTTP/HTTPS allowed');
}

const hostname = parsedUrl.hostname;

const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

const client = axios.create({
  timeout: 10000,
  maxRedirects: 3,
  maxContentLength: 1024 * 512,
  maxBodyLength: 1024 * 512,
  decompress: false,
  validateStatus: () => true,
  headers: {
    'User-Agent': 'render-monitor-bot/3.0'
  }
});

axiosRetry(client, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: error => {
    return (
      axiosRetry.isNetworkOrIdempotentRequestError(error) ||
      error.response?.status >= 500 ||
      error.response?.status === 429 ||
      error.response?.status === 408
    );
  }
});

const bot = new TelegramBot(BOT_TOKEN, {
  polling: false
});

let restartingPolling = false;
let shuttingDown = false;

async function startPolling() {
  try {
    await bot.startPolling({
      interval: 300,
      params: {
        timeout: 10
      }
    });

    logger.info('Polling started');
  } catch (err) {
    logger.error(err);
  }
}

bot.on('polling_error', async err => {
  logger.error(err);

  if (restartingPolling || shuttingDown) {
    return;
  }

  restartingPolling = true;

  try {
    await bot.stopPolling();
  } catch {}

  setTimeout(async () => {
    try {
      await startPolling();
    } catch (e) {
      logger.error(e);
    } finally {
      restartingPolling = false;
    }
  }, 5000);
});

const state = {
  checking: false,
  health: 'healthy',
  totalChecks: 0,
  successCount: 0,
  totalFailures: 0,
  consecutiveFailures: 0,
  downSince: null,
  lastStatusCode: null,
  lastResponseTime: null,
  lastError: null,
  sslDaysLeft: null,
  lastCheckTime: null,
  lastSlowAlertAt: 0,
  sslAlertSent: []
};

function now() {
  return new Date().toISOString();
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isOwner(chatId) {
  return chatId === Number(ADMIN_ID);
}

function isManager(chatId) {
  return chatId === Number(USER_ID);
}

function isAuthorized(chatId) {
  return isOwner(chatId) || isManager(chatId);
}

const managerKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: '📊 СТАТУС',
          callback_data: 'status'
        }
      ]
    ]
  }
};

const adminKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: '📊 СТАТУС',
          callback_data: 'status'
        },
        {
          text: '🔄 ПРОВЕРИТЬ',
          callback_data: 'check_now'
        }
      ],
      [
        {
          text: '📡 PING',
          callback_data: 'ping'
        },
        {
          text: '🔒 SSL',
          callback_data: 'ssl'
        }
      ]
    ]
  }
};

function getKeyboard(chatId) {
  return isOwner(chatId)
    ? adminKeyboard
    : managerKeyboard;
}

async function sendMessage(chatId, text) {
  if (!isAuthorized(chatId)) {
    logger.warn(`Unauthorized send attempt: ${chatId}`);
    return;
  }

  try {
    await Promise.race([
      bot.sendMessage(chatId, String(text).slice(0, 4000), {
        parse_mode: 'HTML',
        ...getKeyboard(chatId)
      }),

      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Telegram timeout'));
        }, 10000);
      })
    ]);
  } catch (err) {
    logger.error(err);
  }
}

async function notifyManager(text) {
  return sendMessage(Number(USER_ID), text);
}

async function notifyAdmin(text) {
  return sendMessage(Number(ADMIN_ID), text);
}

function getManagerStatusMessage() {
  return `
<b>🌐 Статус сайта</b>

<b>Состояние:</b>
${state.health === 'healthy'
  ? '🟢 Работает'
  : state.health === 'degraded'
    ? '🟡 Замедлен'
    : '🔴 Недоступен'}

<b>Последний ответ:</b>
${state.lastResponseTime || 'N/A'} ms

<b>SSL сертификат:</b>
${state.sslDaysLeft || 'N/A'} дней

<b>Последняя проверка:</b>
${state.lastCheckTime || 'N/A'}
`;
}

function getAdminStatusMessage() {
  const uptime = state.totalChecks > 0
    ? ((state.successCount / state.totalChecks) * 100).toFixed(2)
    : '0';

  return `
<b>🛠 ADMIN STATUS</b>

<b>STATE:</b>
${state.health}

<b>STATUS CODE:</b>
${state.lastStatusCode || 'N/A'}

<b>RESPONSE:</b>
${state.lastResponseTime || 'N/A'} ms

<b>SSL:</b>
${state.sslDaysLeft || 'N/A'} days

<b>UPTIME:</b>
${uptime}%

<b>TOTAL CHECKS:</b>
${state.totalChecks}

<b>TOTAL FAILURES:</b>
${state.totalFailures}

<b>CONSECUTIVE FAILURES:</b>
${state.consecutiveFailures}

<b>LAST ERROR:</b>
${escapeHtml(state.lastError || 'none')}

<b>LAST CHECK:</b>
${state.lastCheckTime || 'N/A'}
`;
}

async function checkSSL() {
  try {
    const ssl = await Promise.race([
      sslChecker(hostname),

      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('SSL timeout'));
        }, 10000);
      })
    ]);

    state.sslDaysLeft = ssl.daysRemaining;

    if (ssl.daysRemaining > 30) {
      state.sslAlertSent = [];
    }

    const warningDays = [30, 14, 7, 3, 1];

    if (
      warningDays.includes(ssl.daysRemaining) &&
      !state.sslAlertSent.includes(ssl.daysRemaining)
    ) {
      state.sslAlertSent.push(ssl.daysRemaining);

      await notifyManager(`
<b>⚠ Внимание</b>

SSL сертификат сайта скоро истекает.

<b>Осталось:</b>
${ssl.daysRemaining} дней
`);

      await notifyAdmin(`
<b>⚠ SSL EXPIRING</b>

<b>HOST:</b>
${escapeHtml(hostname)}

<b>DAYS LEFT:</b>
${ssl.daysRemaining}

<b>TIME:</b>
${now()}
`);
    }
  } catch (err) {
    logger.error(err);
  }
}

async function checkPing() {
  const started = Date.now();

  try {
    await client.head(SITE_URL, {
      timeout: 5000
    });

    return Date.now() - started;
  } catch {
    return 'N/A';
  }
}

async function checkSite() {
  if (state.checking) {
    return false;
  }

  state.checking = true;
  state.totalChecks++;

  try {
    const started = Date.now();

    const response = await client.get(SITE_URL);

    const duration = Date.now() - started;

    state.lastResponseTime = duration;
    state.lastStatusCode = response.status;
    state.lastCheckTime = now();

    if (!(response.status >= 200 && response.status < 400)) {
      throw new Error(`Bad status ${response.status}`);
    }

    state.successCount++;
    state.consecutiveFailures = 0;
    state.lastError = null;

    state.health = duration > 3000
      ? 'degraded'
      : 'healthy';

    if (
      duration > 3000 &&
      Date.now() - state.lastSlowAlertAt > 1800000
    ) {
      state.lastSlowAlertAt = Date.now();

      await notifyManager(`
<b>⚠ Сайт работает медленно</b>

Время ответа превышает норму.
`);

      await notifyAdmin(`
<b>⚠ SLOW RESPONSE</b>

<b>URL:</b>
${escapeHtml(SITE_URL)}

<b>RESPONSE TIME:</b>
${duration} ms

<b>TIME:</b>
${now()}
`);
    }

    if (state.downSince) {
      const downtime = Math.floor(
        (Date.now() - state.downSince) / 1000
      );

      state.downSince = null;

      await notifyManager(`
<b>✅ Сайт снова работает</b>

Работа сервиса восстановлена.
`);

      await notifyAdmin(`
<b>🟢 SITE RECOVERED</b>

<b>URL:</b>
${escapeHtml(SITE_URL)}

<b>DOWNTIME:</b>
${downtime} sec

<b>TIME:</b>
${now()}
`);
    }
  } catch (err) {
    state.totalFailures++;
    state.consecutiveFailures++;
    state.lastError = err.message;
    state.lastCheckTime = now();

    logger.error(err);

    if (
      state.consecutiveFailures >= 3 &&
      !state.downSince
    ) {
      state.downSince = Date.now();
      state.health = 'down';

      await notifyManager(`
<b>🚨 Сайт недоступен</b>

Сервис временно не отвечает.

Мы уже получили уведомление и проверяем проблему.
`);

      await notifyAdmin(`
<b>🚨 SITE DOWN</b>

<b>URL:</b>
${escapeHtml(SITE_URL)}

<b>ERROR:</b>
${escapeHtml(err.message)}

<b>FAILURES:</b>
${state.consecutiveFailures}

<b>TIME:</b>
${now()}
`);
    }
  } finally {
    state.checking = false;
  }

  return true;
}

async function scheduler() {
  try {
    await checkSite();
  } catch (err) {
    logger.error(err);
  }

  const jitter = Math.floor(Math.random() * 1000);

  if (!shuttingDown) {
    setTimeout(scheduler, interval + jitter);
  }
}

let lastReportDay = null;

async function reportScheduler() {
  try {
    const date = new Date();
    const day = date.toDateString();

    if (
      date.getHours() === 10 &&
      date.getMinutes() === 0 &&
      lastReportDay !== day
    ) {
      lastReportDay = day;

      await notifyManager(getManagerStatusMessage());
      await notifyAdmin(getAdminStatusMessage());
    }
  } catch (err) {
    logger.error(err);
  }

  if (!shuttingDown) {
    setTimeout(reportScheduler, 60000);
  }
}

bot.on('message', async msg => {
  const chatId = msg.chat.id;

  if (!isAuthorized(chatId)) {
    logger.warn(`Unauthorized access attempt: ${chatId}`);
    return;
  }
});

bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id;

  if (!isAuthorized(chatId)) {
    logger.warn(`Unauthorized /start: ${chatId}`);
    return;
  }

  await sendMessage(
    chatId,
    isOwner(chatId)
      ? '<b>🛠 ADMIN PANEL CONNECTED</b>'
      : '<b>📊 Мониторинг сайта подключен</b>'
  );
});

bot.onText(/\/id/, async msg => {
  const chatId = msg.chat.id;

  if (!isOwner(chatId)) {
    return;
  }

  await sendMessage(
    chatId,
    `<b>CHAT ID:</b>\n${chatId}`
  );
});

bot.on('callback_query', async query => {
  try {
    const chatId = query.message.chat.id;

    if (!isAuthorized(chatId)) {
      logger.warn(`Unauthorized callback: ${chatId}`);

      return bot.answerCallbackQuery(query.id, {
        text: 'Access denied'
      });
    }

    const action = query.data;

    if (action === 'status') {
      await sendMessage(
        chatId,
        isOwner(chatId)
          ? getAdminStatusMessage()
          : getManagerStatusMessage()
      );
    }

    if (action === 'check_now') {
      if (!isOwner(chatId)) {
        return sendMessage(
          chatId,
          '❌ Недостаточно прав'
        );
      }

      const executed = await checkSite();

      await sendMessage(
        chatId,
        executed
          ? '<b>✅ Проверка выполнена</b>'
          : '<b>⏳ Проверка уже выполняется</b>'
      );
    }

    if (action === 'ping') {
      if (!isOwner(chatId)) {
        return sendMessage(
          chatId,
          '❌ Недостаточно прав'
        );
      }

      const result = await checkPing();

      await sendMessage(
        chatId,
        `<b>📡 PING</b>\n\n${result} ms`
      );
    }

    if (action === 'ssl') {
      if (!isOwner(chatId)) {
        return sendMessage(
          chatId,
          '❌ Недостаточно прав'
        );
      }

      await sendMessage(
        chatId,
        `<b>🔒 SSL STATUS</b>

<b>DAYS LEFT:</b>
${state.sslDaysLeft || 'N/A'}

<b>HOST:</b>
${escapeHtml(hostname)}
`
      );
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    logger.error(err);
  }
});

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json'
    });

    return res.end(JSON.stringify({
      status: 'ok',
      health: state.health,
      uptime: process.uptime(),
      memory: process.memoryUsage().rss
    }));
  }

  res.writeHead(200);
  res.end('OK');
});

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  logger.info('Shutting down');

  try {
    await bot.stopPolling();
  } catch (err) {
    logger.error(err);
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', err => {
  logger.error(err);
});

process.on('uncaughtException', async err => {
  logger.fatal(err);

  try {
    await bot.stopPolling();
  } catch {}

  process.exit(1);
});

setInterval(() => {
  const used = Math.round(
    process.memoryUsage().rss / 1024 / 1024
  );

  if (used > 400) {
    logger.warn(`High memory usage: ${used} MB`);
  }
}, 60000);

(async () => {
  try {
    server.listen(Number(PORT), () => {
      logger.info(`Health server on ${PORT}`);
    });

    await startPolling();

    await notifyAdmin(`
<b>🚀 MONITOR STARTED</b>

<b>SITE:</b>
${escapeHtml(SITE_URL)}

<b>TIME:</b>
${now()}
`);

    await notifyManager(`
<b>📊 Мониторинг сайта запущен</b>

Система контроля доступности сайта активна.
`);

    await checkSSL();
    await checkSite();

    scheduler();
    reportScheduler();

    setInterval(async () => {
      try {
        await checkSSL();
      } catch (err) {
        logger.error(err);
      }
    }, 3 * 60 * 60 * 1000);

  } catch (err) {
    logger.fatal(err);
    process.exit(1);
  }
})();