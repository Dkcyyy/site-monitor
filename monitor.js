require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const siteUrl = process.env.SITE_URL;
const interval = parseInt(process.env.CHECK_INTERVAL);

const bot = new TelegramBot(token);

const USER_ID = 8353164707;

let siteIsDown = false;

// Отправка сообщения
async function sendAlert(message) {
    try {
        await bot.sendMessage(USER_ID, message);
        console.log('Сообщение отправлено');
    } catch (err) {
        console.log('Ошибка Telegram:', err.message);
    }
}

// Проверка сайта
async function checkSite() {

    try {

        const response = await axios.get(siteUrl, {
            timeout: 10000
        });

        console.log(`[OK] ${response.status}`);

        if (siteIsDown) {

            siteIsDown = false;

            await sendAlert(
                `✅ Сайт снова работает\n${siteUrl}`
            );
        }

    } catch (err) {

        console.log(`[DOWN] ${err.message}`);

        if (!siteIsDown) {

            siteIsDown = true;

            await sendAlert(
                `🚨 Сайт недоступен!\n\n` +
                `Сайт: ${siteUrl}\n` +
                `Ошибка: ${err.message}\n` +
                `Время: ${new Date().toLocaleString()}`
            );
        }
    }
}

// Первая проверка
checkSite();

// Интервал
setInterval(checkSite, interval);