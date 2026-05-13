require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const sslChecker = require('ssl-checker').default;
const ping = require('ping');
const { URL } = require('url');

const token = process.env.BOT_TOKEN;
const siteUrl = process.env.SITE_URL;
const interval = parseInt(process.env.CHECK_INTERVAL);

const USER_ID = Number(process.env.USER_ID);
const ADMIN_ID = Number(process.env.ADMIN_ID);

const bot = new TelegramBot(token, {
    polling: true
});

let siteIsDown = false;
let failCount = 0;
let successCount = 0;
let totalChecks = 0;
let downSince = null;

let lastStatusCode = null;
let lastResponseTime = null;
let lastError = null;
let sslDaysLeft = null;
let lastCheckTime = null;

const hostname = new URL(siteUrl).hostname;

const keyboard = {
    reply_markup: {
        inline_keyboard: [
            [
                { text: 'STATUS', callback_data: 'status' },
                { text: 'CHECK NOW', callback_data: 'check_now' }
            ],
            [
                { text: 'PING', callback_data: 'ping' },
                { text: 'SSL', callback_data: 'ssl' }
            ],
            [
                { text: 'DEV STATS', callback_data: 'dev_stats' }
            ]
        ]
    }
};

async function sendMessage(userId, text) {
    try {
        await bot.sendMessage(userId, text, keyboard);
    } catch (err) {
        console.log('Telegram error:', err.message);
    }
}

function getStatusMessage() {

    const status = siteIsDown
        ? '🔴 Сайт временно недоступен'
        : '🟢 Сайт работает нормально';

    return (
        `${status}\n\n` +
        `🌐 Сайт:\n${siteUrl}\n\n` +
        `⏱ Скорость ответа:\n${lastResponseTime || 'N/A'} ms\n\n` +
        `🔒 SSL:\n${sslDaysLeft || 'N/A'} дней\n\n` +
        `🕓 Последняя проверка:\n${lastCheckTime || 'N/A'}`
    );
}

function getDevStats() {

    const uptimePercent = totalChecks > 0
        ? ((successCount / totalChecks) * 100).toFixed(2)
        : '0';

    return (
        `📊 DEV STATS\n\n` +
        `SITE: ${siteUrl}\n\n` +
        `STATUS CODE: ${lastStatusCode}\n` +
        `RESPONSE TIME: ${lastResponseTime} ms\n` +
        `SSL DAYS LEFT: ${sslDaysLeft}\n` +
        `LAST ERROR: ${lastError || 'none'}\n\n` +
        `TOTAL CHECKS: ${totalChecks}\n` +
        `SUCCESS CHECKS: ${successCount}\n` +
        `FAIL CHECKS: ${failCount}\n` +
        `UPTIME: ${uptimePercent}%\n\n` +
        `LAST CHECK: ${lastCheckTime}`
    );
}

async function checkSSL() {

    try {

        const ssl = await sslChecker(hostname);

        sslDaysLeft = ssl.daysRemaining;

        if (sslDaysLeft <= 7) {

            await sendMessage(
                USER_ID,
                `⚠ SSL сертификат скоро закончится\n\nОсталось дней: ${sslDaysLeft}`
            );
        }

    } catch (err) {
        console.log('SSL error:', err.message);
    }
}

async function checkPing() {

    try {

        const result = await ping.promise.probe(hostname);

        return result.time;

    } catch (err) {
        return 'N/A';
    }
}

async function checkSite() {

    totalChecks++;

    try {

        const start = Date.now();

        const response = await axios.get(siteUrl, {
            timeout: 10000
        });

        const end = Date.now();

        lastResponseTime = end - start;
        lastStatusCode = response.status;
        lastError = null;
        lastCheckTime = new Date().toLocaleString();

        successCount++;

        console.log(`[OK] ${response.status}`);

        if (lastResponseTime > 3000) {

            await sendMessage(
                USER_ID,
                `⚠ Сайт отвечает медленно\n\nСкорость ответа: ${lastResponseTime} ms`
            );
        }

        if (siteIsDown) {

            siteIsDown = false;

            const downtime = Math.floor((Date.now() - downSince) / 1000);

            await sendMessage(
                USER_ID,
                `🟢 Сайт снова работает\n\nВремя простоя: ${downtime} сек.`
            );
        }

    } catch (err) {

        failCount++;

        lastError = err.message;
        lastCheckTime = new Date().toLocaleString();

        console.log(`[DOWN] ${err.message}`);

        if (!siteIsDown && failCount >= 3) {

            siteIsDown = true;
            downSince = Date.now();

            await sendMessage(
                USER_ID,
                `🔴 Сайт временно недоступен\n\nМы уже проверяем проблему.\n\nСайт:\n${siteUrl}`
            );

            await sendMessage(
                ADMIN_ID,
                `🚨 DEV ALERT\n\nERROR:\n${err.message}`
            );
        }
    }
}

bot.on('callback_query', async (query) => {

    const chatId = query.message.chat.id;
    const action = query.data;

    if (action === 'status') {
        await sendMessage(chatId, getStatusMessage());
    }

    if (action === 'dev_stats') {

        if (chatId !== ADMIN_ID) {
            return sendMessage(chatId, 'Нет доступа');
        }

        await sendMessage(chatId, getDevStats());
    }

    if (action === 'ping') {

        const pingTime = await checkPing();

        await sendMessage(
            chatId,
            `⏱ Ping сайта:\n\n${pingTime} ms`
        );
    }

    if (action === 'ssl') {

        await sendMessage(
            chatId,
            `🔒 SSL сертификат\n\nОсталось дней:\n${sslDaysLeft}`
        );
    }

    if (action === 'check_now') {

        await checkSite();

        await sendMessage(
            chatId,
            '✅ Проверка выполнена'
        );
    }

    bot.answerCallbackQuery(query.id);
});

sendMessage(
    USER_ID,
    '🚀 Система мониторинга запущена'
);

checkSSL();
checkSite();

setInterval(checkSite, interval);
setInterval(checkSSL, 86400000);