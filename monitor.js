require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const sslChecker = require('ssl-checker').default;
const ping = require('ping');
const { URL } = require('url');
const fs = require('fs/promises');
const path = require('path');

const {
    BOT_TOKEN,
    SITE_URL,
    CHECK_INTERVAL,
    USER_ID,
    ADMIN_ID
} = process.env;

if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN missing');
}

if (!SITE_URL) {
    throw new Error('SITE_URL missing');
}

if (!CHECK_INTERVAL || isNaN(Number(CHECK_INTERVAL))) {
    throw new Error('CHECK_INTERVAL invalid');
}

if (!USER_ID || isNaN(Number(USER_ID))) {
    throw new Error('USER_ID invalid');
}

if (!ADMIN_ID || isNaN(Number(ADMIN_ID))) {
    throw new Error('ADMIN_ID invalid');
}

let hostname;

try {

    hostname =
        new URL(SITE_URL).hostname;

} catch {

    throw new Error('SITE_URL invalid');
}

const interval =
    Number(CHECK_INTERVAL);

const LOGS_DIR =
    path.join(__dirname, 'logs');

const STATS_FILE =
    path.join(__dirname, 'stats.json');


const bot = new TelegramBot(
    BOT_TOKEN,
    {
        polling: true
    }
);

bot.on(
    'polling_error',
    async (err) => {

        await writeErrorLog(
            `Polling error: ${err.message}`
        );
    }
);

const state = {

    siteIsDown: false,

    consecutiveFailures: 0,

    totalFailures: 0,

    successCount: 0,

    totalChecks: 0,

    downSince: null,

    lastStatusCode: null,

    lastResponseTime: null,

    lastError: null,

    sslDaysLeft: null,

    lastCheckTime: null,

    sslAlertSent: [],

    checking: false,

    lastSlowAlertAt: 0
};

function now() {

    return new Date()
        .toLocaleString('ru-RU');
}

function escapeHtml(str = '') {

    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isAuthorized(chatId) {

    return (
        chatId === Number(USER_ID)
        ||
        chatId === Number(ADMIN_ID)
    );
}

async function init() {

    try {

        await fs.mkdir(
            LOGS_DIR,
            {
                recursive: true
            }
        );

    } catch (err) {

        console.error(err);
    }

    await loadStats();
}

async function writeLog(
    file,
    message
) {

    const line =
        `[${now()}] ${message}\n`;

    try {

        await fs.appendFile(
            path.join(LOGS_DIR, file),
            line
        );

    } catch (err) {

        console.error(
            'Log write error:',
            err.message
        );
    }
}

async function writeUptimeLog(message) {

    await writeLog(
        'uptime.log',
        message
    );
}

async function writeErrorLog(message) {

    await writeLog(
        'errors.log',
        message
    );
}

async function loadStats() {

    try {

        const raw =
            await fs.readFile(
                STATS_FILE,
                'utf8'
            );

        const stats =
            JSON.parse(raw);

        Object.assign(
            state,
            stats
        );

    } catch (err) {

        await writeErrorLog(
            `Stats load failed: ${err.message}`
        );
    }
}

async function saveStats() {

    try {

        await fs.writeFile(
            STATS_FILE,
            JSON.stringify(
                state,
                null,
                2
            )
        );

    } catch (err) {

        await writeErrorLog(
            `Stats save failed: ${err.message}`
        );
    }
}

const keyboard = {

    reply_markup: {

        inline_keyboard: [

            [
                {
                    text: 'STATUS',
                    callback_data: 'status'
                },

                {
                    text: 'CHECK NOW',
                    callback_data: 'check_now'
                }
            ],

            [
                {
                    text: 'PING',
                    callback_data: 'ping'
                },

                {
                    text: 'SSL',
                    callback_data: 'ssl'
                }
            ],

            [
                {
                    text: 'DEV STATS',
                    callback_data: 'dev_stats'
                }
            ]
        ]
    }
};

async function sendMessage(
    userId,
    text
) {

    try {

        await bot.sendMessage(
            userId,
            text,
            {
                parse_mode: 'HTML',
                ...keyboard
            }
        );

    } catch (err) {

        await writeErrorLog(
            `Telegram error: ${err.message}`
        );
    }
}

function getStatusMessage(chatId) {

    const isAdmin =
        chatId === Number(ADMIN_ID);


    if (isAdmin) {

        const uptime =
            state.totalChecks > 0

                ? (
                    (
                        state.successCount
                        / state.totalChecks
                    ) * 100
                ).toFixed(2)

                : '0';

        return `

<b>📊 DEV STATS</b>

<b>SITE:</b>
${escapeHtml(SITE_URL)}

<b>STATUS CODE:</b>
${state.lastStatusCode || 'N/A'}

<b>RESPONSE TIME:</b>
${state.lastResponseTime || 'N/A'} ms

<b>SSL DAYS LEFT:</b>
${state.sslDaysLeft || 'N/A'}

<b>LAST ERROR:</b>
${escapeHtml(
    state.lastError || 'none'
)}

<b>TOTAL CHECKS:</b>
${state.totalChecks}

<b>SUCCESS CHECKS:</b>
${state.successCount}

<b>FAIL CHECKS:</b>
${state.totalFailures}

<b>UPTIME:</b>
${uptime}%

<b>LAST CHECK:</b>
${state.lastCheckTime || 'N/A'}
`;
    }

    const status =
        state.siteIsDown

            ? '🔴 Есть проблемы'

            : '🟢 Всё работает нормально';

    return `

<b>${status}</b>

<b>🌐 Сайт:</b>
${escapeHtml(SITE_URL)}

<b>📡 Статус:</b>
${state.lastStatusCode || 'N/A'}

<b>⏱ Скорость ответа:</b>
${state.lastResponseTime || 'N/A'} ms

<b>🕓 Последняя проверка:</b>
${state.lastCheckTime || 'N/A'}
`;
}

async function checkSSL() {

    try {

        const ssl =
            await Promise.race([

                sslChecker(hostname),

                new Promise(
                    (_, reject) =>

                        setTimeout(
                            () => reject(
                                new Error('SSL timeout')
                            ),
                            10000
                        )
                )
            ]);

        state.sslDaysLeft =
            ssl.daysRemaining;

        const warningDays = [
            30,
            14,
            7,
            3,
            1
        ];

        if (

            warningDays.includes(
                state.sslDaysLeft
            )

            &&

            !state.sslAlertSent.includes(
                state.sslDaysLeft
            )

        ) {

            state.sslAlertSent.push(
                state.sslDaysLeft
            );

            await sendMessage(

                Number(USER_ID),

                `
<b>⚠ SSL СЕРТИФИКАТ ЗАКАНЧИВАЕТСЯ</b>

<b>🌐 Сайт:</b>
${escapeHtml(SITE_URL)}

<b>🔒 Осталось:</b>
${state.sslDaysLeft} дней
`
            );

            await sendMessage(

                Number(ADMIN_ID),

                `
<b>⚠ SSL EXPIRING</b>

<b>SITE:</b>
${escapeHtml(SITE_URL)}

<b>DAYS LEFT:</b>
${state.sslDaysLeft}
`
            );
        }

    } catch (err) {

        await writeErrorLog(
            `SSL error: ${err.message}`
        );
    }
}

async function checkPing() {

    try {

        const result =
            await ping.promise.probe(
                hostname
            );

        return result.time;

    } catch (err) {

        await writeErrorLog(
            `Ping error: ${err.message}`
        );

        return 'N/A';
    }
}

async function checkSite() {

    if (state.checking) {
        return;
    }

    state.checking = true;

    state.totalChecks++;

    try {

        const start =
            Date.now();

        const response =
            await axios.get(
                SITE_URL,
                {
                    timeout: 10000,
                    validateStatus: () => true
                }
            );

        const end =
            Date.now();

        state.lastResponseTime =
            end - start;

        state.lastStatusCode =
            response.status;

        state.lastCheckTime =
            now();

        const healthy =

            response.status >= 200

            &&

            response.status < 400;

        if (!healthy) {

            throw new Error(
                `Bad status: ${response.status}`
            );
        }

        state.successCount++;

        state.consecutiveFailures = 0;

        state.lastError = null;

        await writeUptimeLog(
            `OK ${response.status}`
        );

        const cooldown =
            30 * 60 * 1000;

        if (

            state.lastResponseTime > 3000

            &&

            Date.now()
            - state.lastSlowAlertAt
            > cooldown

        ) {

            state.lastSlowAlertAt =
                Date.now();

            await sendMessage(

                Number(USER_ID),

                `
<b>⚠ САЙТ РАБОТАЕТ МЕДЛЕННО</b>

<b>🌐 Сайт:</b>
${escapeHtml(SITE_URL)}

<b>⏱ Скорость ответа:</b>
${state.lastResponseTime} ms
`
            );

            await sendMessage(

                Number(ADMIN_ID),

                `
<b>⚠ SLOW RESPONSE</b>

<b>SITE:</b>
${escapeHtml(SITE_URL)}

<b>STATUS:</b>
${state.lastStatusCode}

<b>RESPONSE TIME:</b>
${state.lastResponseTime} ms
`
            );
        }

        if (state.siteIsDown) {

            state.siteIsDown = false;

            const downtime =
                Math.floor(
                    (
                        Date.now()
                        - state.downSince
                    ) / 1000
                );

            await sendMessage(

                Number(USER_ID),

                `
<b>🟢 САЙТ ВОССТАНОВЛЕН</b>

Сайт снова доступен.

<b>⏱ Время простоя:</b>
${downtime} сек.
`
            );

            await sendMessage(

                Number(ADMIN_ID),

                `
<b>🟢 SITE RECOVERED</b>

<b>DOWNTIME:</b>
${downtime} sec

<b>STATUS:</b>
${state.lastStatusCode}

<b>RESPONSE:</b>
${state.lastResponseTime} ms
`
            );

            await writeUptimeLog(
                'SITE RECOVERED'
            );
        }

    } catch (err) {

        state.totalFailures++;

        state.consecutiveFailures++;

        state.lastError =
            err.message;

        state.lastCheckTime =
            now();

        await writeErrorLog(
            `DOWN ${err.message}`
        );

        if (

            !state.siteIsDown

            &&

            state.consecutiveFailures >= 3

        ) {

            state.siteIsDown = true;

            state.downSince =
                Date.now();

            await sendMessage(

                Number(USER_ID),

                `
<b>🔴 ПРОБЛЕМА С САЙТОМ</b>

Сайт временно недоступен.

<b>🌐 Сайт:</b>
${escapeHtml(SITE_URL)}

Мы уже проверяем проблему.
`
            );

            // ADMIN ALERT

            await sendMessage(

                Number(ADMIN_ID),

                `
<b>🚨 SITE DOWN</b>

<b>SITE:</b>
${escapeHtml(SITE_URL)}

<b>ERROR:</b>
${escapeHtml(err.message)}

<b>FAILURES:</b>
${state.consecutiveFailures}
`
            );
        }

    } finally {

        state.checking = false;

        await saveStats();
    }
}

async function sendDailyReport() {

    const uptime =
        state.totalChecks > 0

            ? (
                (
                    state.successCount
                    / state.totalChecks
                ) * 100
            ).toFixed(2)

            : '0';

    await sendMessage(

        Number(USER_ID),

        `
<b>📊 ЕЖЕДНЕВНЫЙ ОТЧЁТ</b>

<b>🌐 Сайт:</b>
${escapeHtml(SITE_URL)}

<b>📈 Стабильность:</b>
${uptime}%

<b>⏱ Последний ответ:</b>
${state.lastResponseTime || 'N/A'} ms

<b>🕓 Последняя проверка:</b>
${state.lastCheckTime || 'N/A'}

<b>🔒 SSL сертификат:</b>
${state.sslDaysLeft || 'N/A'} дней
`
    );

    await sendMessage(

        Number(ADMIN_ID),

        `
<b>📊 DEV DAILY REPORT</b>

<b>SITE:</b>
${escapeHtml(SITE_URL)}

<b>STATUS CODE:</b>
${state.lastStatusCode || 'N/A'}

<b>RESPONSE TIME:</b>
${state.lastResponseTime || 'N/A'} ms

<b>SSL DAYS LEFT:</b>
${state.sslDaysLeft || 'N/A'}

<b>LAST ERROR:</b>
${escapeHtml(
    state.lastError || 'none'
)}

<b>TOTAL CHECKS:</b>
${state.totalChecks}

<b>SUCCESS CHECKS:</b>
${state.successCount}

<b>FAIL CHECKS:</b>
${state.totalFailures}

<b>UPTIME:</b>
${uptime}%

<b>LAST CHECK:</b>
${state.lastCheckTime || 'N/A'}
`
    );
}

bot.on(
    'callback_query',
    async (query) => {

        try {

            const chatId =
                query.message.chat.id;

            if (!isAuthorized(chatId)) {

                return bot.answerCallbackQuery(
                    query.id,
                    {
                        text: 'Access denied'
                    }
                );
            }

            const action =
                query.data;

            if (
                action === 'status'
            ) {

                await sendMessage(
                    chatId,
                    getStatusMessage(chatId)
                );
            }

            if (
                action === 'dev_stats'
            ) {

                if (
                    chatId !== Number(ADMIN_ID)
                ) {

                    return sendMessage(
                        chatId,
                        'Нет доступа'
                    );
                }

                await sendMessage(
                    chatId,
                    getStatusMessage(chatId)
                );
            }

            if (
                action === 'ping'
            ) {

                const pingTime =
                    await checkPing();

                await sendMessage(

                    chatId,

                    `
<b>⏱ PING</b>

${pingTime} ms
`
                );
            }

            if (
                action === 'ssl'
            ) {

                await sendMessage(

                    chatId,

                    `
<b>🔒 SSL</b>

${state.sslDaysLeft || 'N/A'} days
`
                );
            }

            if (
                action === 'check_now'
            ) {

                await checkSite();

                await sendMessage(

                    chatId,

                    `
<b>✅ ПРОВЕРКА ВЫПОЛНЕНА</b>
`
                );
            }

            await bot.answerCallbackQuery(
                query.id
            );

        } catch (err) {

            await writeErrorLog(
                `Callback error: ${err.message}`
            );
        }
    }
);

process.on(
    'unhandledRejection',
    async (err) => {

        await writeErrorLog(
            `Unhandled rejection: ${err}`
        );
    }
);

process.on(
    'uncaughtException',
    async (err) => {

        await writeErrorLog(
            `Uncaught exception: ${err.stack}`
        );
    }
);

async function shutdown() {

    await writeUptimeLog(
        'Application shutdown'
    );

    await saveStats();

    process.exit(0);
}

process.on(
    'SIGINT',
    shutdown
);

process.on(
    'SIGTERM',
    shutdown
);

(async () => {

    await init();

    await sendMessage(

        Number(USER_ID),

        `
<b>🚀 СИСТЕМА МОНИТОРИНГА ЗАПУЩЕНА</b>

<b>🌐 Сайт:</b>
${escapeHtml(SITE_URL)}

Мониторинг активен.
`
    );

    await sendMessage(

        Number(ADMIN_ID),

        `
<b>🚀 DEV MONITOR STARTED</b>

<b>SITE:</b>
${escapeHtml(SITE_URL)}

<b>CHECK INTERVAL:</b>
${interval} ms
`
    );

    await checkSSL();

    await checkSite();

    setInterval(
        checkSite,
        interval
    );

    setInterval(
        checkSSL,
        86400000
    );

    let lastReportDay = null;

    setInterval(async () => {

        const nowDate =
            new Date();

        const day =
            nowDate.toDateString();

        if (

            nowDate.getHours() === 10

            &&

            nowDate.getMinutes() === 0

            &&

            lastReportDay !== day

        ) {

            lastReportDay = day;

            await sendDailyReport();
        }

    }, 60000);

})();