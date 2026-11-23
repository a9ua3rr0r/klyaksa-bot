// bot.js - Telegram-бот для продажи и управления лицензиями klyaksa PRO
// Чистый Node.js 26 (native fetch, node:sqlite, node:http) без внешних npm зависимостей.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.js');
const { startServer } = require('./server.js');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Загрузка конфигурации
function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Bot] Ошибка чтения config.json:', err.message);
    return {
      bot_token: 'YOUR_TELEGRAM_BOT_TOKEN',
      admin_id: 0,
      server_port: 3782
    };
  }
}

const config = loadConfig();

// Переменная окружения имеет приоритет над legacy-полем config.json.
const envToken = process.env.KLYAKSA_BOT_TOKEN?.trim();
if (envToken) {
  config.bot_token = envToken;
}

function saveConfig(updated) {
  try {
    const persisted = { ...updated };
    if (envToken) {
      const original = loadConfig();
      if (Object.hasOwn(original, 'bot_token')) persisted.bot_token = original.bot_token;
      else delete persisted.bot_token;
    }
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(persisted, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[Bot] Ошибка сохранения config.json:', err.message);
    return false;
  }
}

const TOKEN = config.bot_token || '';
const API_BASE = `https://api.telegram.org/bot${TOKEN}`;

// Защита от аварийных завершений процесса
process.on('uncaughtException', err => {
  console.error('[Bot:UncaughtException]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Bot:UnhandledRejection]', reason);
});

// Состояния диалогов пользователей (в памяти)
const userStates = new Map();
// Привязка ID пересланного сообщения админу -> ID клиента (для ответов через Reply)
const supportTicketMapping = new Map();

/**
 * Проверка прав администратора
 */
function isAdmin(userId) {
  return Number(userId) === Number(config.admin_id) && config.admin_id > 0;
}

/**
 * Вызов метода Telegram Bot API с безопасным парсингом и защитой от не-JSON ответов
 */
async function apiCall(method, payload = {}) {
  if (!TOKEN || TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') {
    throw new Error('Токен бота не настроен. Укажите KLYAKSA_BOT_TOKEN или legacy-поле bot_token в config.json.');
  }

  const url = `${API_BASE}/${method}`;
  let res;
  try {
    const timeoutMs = payload.timeout ? (payload.timeout + 10) * 1000 : 25000;
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (netErr) {
    const causeMsg = netErr.cause?.message || netErr.cause?.code || netErr.message;
    throw new Error(`Telegram API сеть [${method}]: ${causeMsg}`);
  }

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(`Telegram API [${method}] вернул не-JSON (HTTP ${res.status}): ${rawText.slice(0, 100)}`);
  }

  if (!data.ok) {
    throw new Error(`Telegram API Error [${method}]: ${data.description || 'Unknown error'}`);
  }
  return data.result;
}

/**
 * Отправка текстового сообщения
 */
async function sendMessage(chatId, text, options = {}) {
  try {
    return await apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode || 'HTML',
      reply_markup: options.reply_markup,
      disable_web_page_preview: options.disable_web_page_preview ?? true
    });
  } catch (err) {
    console.error(`[Bot] Ошибка sendMessage в ${chatId}:`, err.message);
  }
}

/**
 * Редактирование текста сообщения
 */
async function editMessageText(chatId, messageId, text, options = {}) {
  try {
    return await apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parse_mode || 'HTML',
      reply_markup: options.reply_markup,
      disable_web_page_preview: options.disable_web_page_preview ?? true
    });
  } catch (err) {
    console.error(`[Bot] Ошибка editMessageText в ${chatId}:`, err.message);
  }
}

/**
 * Ответ на callback_query (всплывающее уведомление)
 */
async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  try {
    return await apiCall('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert
    });
  } catch (err) {
    console.error('[Bot] Ошибка answerCallbackQuery:', err.message);
  }
}

/**
 * Ответ на pre_checkout_query (Stars)
 */
async function answerPreCheckoutQuery(preCheckoutQueryId, ok = true, errorMessage = '') {
  try {
    return await apiCall('answerPreCheckoutQuery', {
      pre_checkout_query_id: preCheckoutQueryId,
      ok,
      error_message: errorMessage
    });
  } catch (err) {
    console.error('[Bot] Ошибка answerPreCheckoutQuery:', err.message);
  }
}

/**
 * Пересылка фото/документа чека админу
 */
async function sendPhoto(chatId, fileId, caption = '', options = {}) {
  try {
    return await apiCall('sendPhoto', {
      chat_id: chatId,
      photo: fileId,
      caption,
      parse_mode: options.parse_mode || 'HTML',
      reply_markup: options.reply_markup
    });
  } catch (err) {
    console.error(`[Bot] Ошибка sendPhoto в ${chatId}:`, err.message);
  }
}

async function sendDocument(chatId, fileId, caption = '', options = {}) {
  try {
    return await apiCall('sendDocument', {
      chat_id: chatId,
      document: fileId,
      caption,
      parse_mode: options.parse_mode || 'HTML',
      reply_markup: options.reply_markup
    });
  } catch (err) {
    console.error(`[Bot] Ошибка sendDocument в ${chatId}:`, err.message);
  }
}

/**
 * Отправка инвойса на оплату Stars
 */
async function sendStarsInvoice(chatId, title, description, payload, starsAmount) {
  try {
    return await apiCall('sendInvoice', {
      chat_id: chatId,
      title,
      description,
      payload,
      currency: 'XTR',
      prices: [{ label: title, amount: starsAmount }]
    });
  } catch (err) {
    console.error(`[Bot] Ошибка sendStarsInvoice в ${chatId}:`, err.message);
    throw err;
  }
}

// ==========================================
// ГЕНЕРАТОРЫ ИНТЕРФЕЙСА (ТЕКСТ И КНОПКИ)
// ==========================================

function getMainWelcomeMessage(userId = null) {
  const plan = config.plans?.lifetime || { price_rub: 269, price_stars: 249 };
  let msg = `✨ <b>klyaksa PRO by aqua</b>\n` +
    `<i>Живой адаптивный островок для Windows 10/11</i>\n\n` +
    `<b>klyaksa</b> — это системный «островок» с реалистичной физикой органической жидкости, мониторингом датчиков, плеером и умными виджетами от разработчика <b>aqua</b>.\n\n` +
    `<b>✦ Что даёт постоянная лицензия klyaksa PRO:</b>\n` +
    `• 🖤 <b>OLED True Black</b> (0 nits) — абсолютный чёрный для безрамочных мониторов\n` +
    `• 🍷 <b>Алый (Crimson Velvet)</b> — глубокий рубиновый бархат с неоновым кантом\n` +
    `• 👀 <b>4 уникальных стиля глаз</b>: Кошачьи ✦, Мультяшные ✦, Хитринка ✦, Сердечки ✦\n` +
    `• 🏝 <b>Режим «Полуостров»</b> — бесшовное слияние с верхней кромкой экрана (0px)\n` +
    `• 🚀 <b>Расширенный мониторинг GPU</b> (видеопамять, температура, частоты)\n` +
    `• ♾️ <b>Пожизненный доступ</b> без подписок + все будущие PRO-обновления!\n\n` +
    `💎 <b>Тариф Lifetime (Бессрочно):</b> <code>${plan.price_stars} ⭐️</code> Telegram Stars\n` +
    `💳 <i>Оплата в рублях (${plan.price_rub} ₽) — скоро!</i>\n` +
    `👨‍💻 <b>Разработчик:</b> aqua`;

  if ((!config.admin_id || Number(config.admin_id) === 0) && userId) {
    msg += `\n\n━━━━━━━━━━━━━━━━━━━━━\n` +
      `👑 <b>Настройка владельца бота:</b>\n` +
      `Владелец ещё не привязан.\n` +
      `Ваш Telegram ID: <code>${userId}</code>\n\n` +
      `Нажмите кнопку ниже или отправьте <code>/claimadmin</code>, чтобы назначить себя владельцем и открыть админ-панель.`;
  }

  return msg;
}

function getMainKeyboard(userId) {
  const plan = config.plans?.lifetime || { price_rub: 269, price_stars: 249 };
  const siteUrl = config.website_url || 'https://klyaksabyaqua.netlify.app/';
  const appUrl = `${siteUrl.replace(/\/$/, '')}/app.html`;
  const keyboard = [];

  // Кнопка открытия полнофункционального Telegram Mini App
  keyboard.push([
    { text: '✦ Открыть Mini App', web_app: { url: appUrl } }
  ]);

  // Если владелец бота ещё не привязан — предлагаем занять статус первой кнопкой
  if (!config.admin_id || Number(config.admin_id) === 0) {
    keyboard.push([
      { text: '👑 Назначить меня владельцем бота', callback_data: 'claim_admin' }
    ]);
  }

  keyboard.push(
    [
      { text: `⭐️ Оплатить Stars (${plan.price_stars} ⭐️)`, callback_data: 'buy_stars' }
    ],
    [
      { text: `💳 Оплата в рублях (${plan.price_rub} ₽) — Скоро`, callback_data: 'buy_sbp' }
    ],
    [
      { text: '🔑 Мой ключ / Проверить', callback_data: 'my_keys' },
      { text: 'ℹ️ О программе', callback_data: 'about_app' }
    ],
    [
      { text: '🌐 Официальный сайт', url: siteUrl },
      { text: '💬 Написать в поддержку', callback_data: 'support_start' }
    ]
  );

  if (isAdmin(userId)) {
    keyboard.push([{ text: '👑 Панель администратора', callback_data: 'admin_dashboard' }]);
  }

  return { inline_keyboard: keyboard };
}

function getSbpPaymentMessage() {
  const pay = config.payment_details || {};
  const plan = config.plans?.lifetime || { price_rub: 269 };
  return `💳 <b>Оплата klyaksa PRO через СБП / Карту</b>\n\n` +
    `<b>Сумма к переводу:</b> <code>${plan.price_rub}</code> ₽\n\n` +
    `<b>Реквизиты для оплаты:</b>\n` +
    `🏦 <b>Банк:</b> ${pay.bank_name || 'Т-Банк / Сбер'}\n` +
    `📱 <b>Номер / Карта:</b> <code>${pay.phone_or_card || '+7 (900) 000-00-00'}</code>\n` +
    `👤 <b>Получатель:</b> ${pay.recipient_name || 'Владелец'}\n` +
    `💬 <b>Комментарий:</b> <code>${pay.comment_instruction || 'Укажите ваш Telegram-ник'}</code>\n\n` +
    `📸 <b>После оплаты:</b>\n` +
    `Отправьте в этот диалог <b>скриншот или квитанцию</b> перевода (фотографией или файлом).\n` +
    `Администратор моментально проверит платёж, и бот сразу выдаст вам персональный лицензионный ключ!`;
}

async function getAdminDashboardMessage() {
  const stats = await db.getStats();
  return `👑 <b>Панель управления klyaksa PRO</b>\n\n` +
    `📊 <b>Статистика:</b>\n` +
    `• Всего сгенерировано ключей: <b>${stats.totalLicenses}</b>\n` +
    `• Активировано на компьютерах: <b>${stats.activatedLicenses}</b>\n` +
    `• Доступно свободных ключей: <b>${stats.availableLicenses}</b>\n` +
    `• Заказов: <b>${stats.totalOrders}</b> (Оплачено: <b>${stats.paidOrders}</b>)\n` +
    `• Выручка: <b>${stats.revenueRub}</b> ₽ | <b>${stats.revenueStars}</b> ⭐️\n\n` +
    `🛠 <b>Команды управления ключами:</b>\n` +
    `• <code>/revoke &lt;КЛЮЧ&gt;</code> — заблокировать ключ навсегда\n` +
    `• <code>/reset &lt;КЛЮЧ&gt;</code> — сбросить привязку HWID (перенос на другой ПК)\n\n` +
    `Выберите действие ниже:`;
}

function getAdminKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '➕ Выпустить 1 ключ', callback_data: 'admin_gen_1' },
        { text: '📦 Выпустить 5 ключей', callback_data: 'admin_gen_5' }
      ],
      [
        { text: '📋 Свободные ключи', callback_data: 'admin_list_keys' },
        { text: '⏳ Ожидающие чеки', callback_data: 'admin_pending_orders' }
      ],
      [
        { text: '🔄 Обновить статистику', callback_data: 'admin_dashboard' },
        { text: '⬅️ В главное меню', callback_data: 'main_menu' }
      ]
    ]
  };
}

// ==========================================
// ОБРАБОТКА ВХОДЯЩИХ ОБНОВЛЕНИЙ TELEGRAM
// ==========================================

async function handleUpdate(update) {
  // 1. PreCheckoutQuery (Подтверждение оплаты Telegram Stars)
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query;
    await answerPreCheckoutQuery(pcq.id, true);
    return;
  }

  // 2. CallbackQuery (Нажатия inline-кнопок)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  // 3. Сообщения
  if (update.message) {
    await handleMessage(update.message);
  }
}

/**
 * Обработка текстовых сообщений, команд и чеков
 */
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || '').trim();
  console.log(`[Bot] Сообщение от @${msg.from.username || 'unknown'} (ID: ${userId}): "${text || '[нет текста]'}"`);

  // Обработка данных из Telegram Mini App (Web App)
  if (msg.web_app_data) {
    try {
      const data = JSON.parse(msg.web_app_data.data);
      if (data.action === 'buy_stars') {
        const plan = config.plans?.lifetime || { price_rub: 269, price_stars: 249 };
        await sendStarsInvoice(
          chatId,
          plan.name || 'klyaksa PRO Lifetime by aqua',
          plan.description || 'Пожизненный доступ к klyaksa PRO от aqua.',
          `stars_order_${userId}_${Date.now()}`,
          plan.price_stars || 249
        );
        return;
      }
      if (data.action === 'support_msg' && data.text) {
        await sendMessage(chatId, `📨 <b>Ваше обращение принято:</b>\n\n<i>${escapeHtml(data.text)}</i>\n\nРазработчик aqua получил уведомление и ответит вам прямо в этот диалог.`);
        if (config.admin_id && Number(config.admin_id) > 0) {
          await sendMessage(
            config.admin_id,
            `📩 <b>Новое обращение из Mini App:</b>\n` +
            `• От: @${msg.from.username || msg.from.first_name} (ID: <code>${userId}</code>)\n` +
            `• Текст: <i>${escapeHtml(data.text)}</i>\n\n` +
            `Чтобы ответить, используйте Reply на это сообщение или <code>/reply ${userId} &lt;текст&gt;</code>`
          );
        }
        return;
      }
    } catch (err) {
      console.error('[Bot] Ошибка обработки web_app_data:', err.message);
    }
  }

  // Успешная оплата через Telegram Stars
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    console.log(`[Stars] Получена оплата от userId=${userId}, сумма: ${sp.total_amount} XTR`);

    const paidOrder = await db.fulfillStarsPayment({
      userId,
      username: msg.from.username || msg.from.first_name,
      amount: sp.total_amount,
      currency: sp.currency,
      proofFileId: sp.telegram_payment_charge_id
    });
    const lic = await db.getLicense(paidOrder.license_key);

    // Отправляем ключ покупателю
    const reply = `🎉 <b>Оплата ${sp.total_amount} Stars успешно подтверждена!</b>\n\n` +
      `Ваш персональный лицензионный ключ <b>klyaksa PRO by aqua (Lifetime)</b>:\n` +
      `<code>${lic.key}</code>\n\n` +
      `📋 <b>Инструкция по активации:</b>\n` +
      `1. Скопируйте ключ выше (нажмите на него)\n` +
      `2. Откройте приложение klyaksa на ПК\n` +
      `3. Перейдите в <b>Настройки ➔ CARD 0: klyaksa PRO</b>\n` +
      `4. Вставьте ключ и нажмите «Активировать».`;

    await sendMessage(chatId, reply, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
          [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
        ]
      }
    });

    // Уведомление администратору
    if (config.admin_id && config.admin_id > 0) {
      await sendMessage(
        config.admin_id,
        `⭐️ <b>Новая покупка klyaksa PRO by aqua за Stars!</b>\n` +
        `• Покупатель: @${msg.from.username || 'unknown'} (ID: <code>${userId}</code>)\n` +
        `• Сумма: <b>${sp.total_amount} XTR</b>\n` +
        `• Выдан ключ: <code>${lic.key}</code>`
      );
    }
    return;
  }

  // Если сообщение выглядит как лицензионный ключ формата KLYA-PRO-XXXX-XXXX
  const keyMatch = text.match(/KLYA[-_]PRO[-_][A-Z0-9]{4}[-_][A-Z0-9]{4}/i);
  if (keyMatch) {
    const rawFoundKey = keyMatch[0].toUpperCase().replace(/_/g, '-');
    const licInfo = await db.getLicense(rawFoundKey);
    const statusText = licInfo
      ? (licInfo.status === 'activated'
          ? `✅ <b>Лицензия активна</b> (Привязана к HWID: <code>${licInfo.activated_hwid || 'ПК'}</code>)`
          : `🟢 <b>Ключ действителен и готов к активации!</b>`)
      : `ℹ️ <b>Формат ключа распознан.</b>`;

    await sendMessage(chatId,
      `🔑 <b>Лицензионный ключ klyaksa PRO:</b>\n<code>${rawFoundKey}</code>\n\n` +
      `${statusText}\n\n` +
      `📋 <b>Инструкция по активации в приложении на компьютере:</b>\n` +
      `1. Скопируйте ключ выше (нажмите на него)\n` +
      `2. Откройте приложение <b>klyaksa</b> на ПК\n` +
      `3. Перейдите в <b>Настройки ➔ CARD 0: klyaksa PRO</b>\n` +
      `4. Вставьте ключ и нажмите кнопку <b>«Активировать»</b>.`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
            [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
          ]
        }
      }
    );
    return;
  }

  // Команда /start
  if (text.startsWith('/start')) {
    userStates.delete(userId);
    await sendMessage(chatId, getMainWelcomeMessage(userId), {
      reply_markup: getMainKeyboard(userId)
    });
    return;
  }

  // Команда /app (Открыть Mini App)
  if (text === '/app' || text.startsWith('/app ')) {
    const siteUrl = config.website_url || 'https://klyaksabyaqua.netlify.app/';
    const appUrl = `${siteUrl.replace(/\/$/, '')}/app.html`;
    await sendMessage(chatId, `✦ <b>Telegram Mini App klyaksa</b>\n\nНажмите кнопку ниже, чтобы открыть интерактивное приложение:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✦ Открыть klyaksa App', web_app: { url: appUrl } }],
          [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Команда /keys (Мои лицензионные ключи)
  if (text === '/keys' || text.startsWith('/keys ')) {
    await showUserKeys(chatId, userId);
    return;
  }

  // Команда /buy (Купить klyaksa PRO)
  if (text === '/buy' || text.startsWith('/buy ')) {
    const plan = config.plans?.lifetime || { price_rub: 269, price_stars: 249 };
    const buyMsg = `💎 <b>Приобрести лицензию klyaksa PRO Lifetime</b>\n\n` +
      `• Доступ ко всем скинам и темам (OLED True Black, Crimson Velvet)\n` +
      `• 4 стиля глаз: Кошачьи ✦, Мультяшные ✦, Хитринка ✦, Сердечки ✦\n` +
      `• Режим «Полуостров» (0px бесшовная кромка)\n` +
      `• Расширенный GPU-мониторинг и бессрочные обновления\n\n` +
      `Выберите удобный способ оплаты:`;
    await sendMessage(chatId, buyMsg, {
      reply_markup: {
        inline_keyboard: [
          [{ text: `⭐️ Оплатить Stars (${plan.price_stars} ⭐️)`, callback_data: 'buy_stars' }],
          [{ text: `💳 Оплата в рублях (${plan.price_rub} ₽) — Скоро`, callback_data: 'buy_sbp' }],
          [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Команда /support (Поддержка)
  if (text === '/support' || text.startsWith('/support ')) {
    userStates.set(userId, 'waiting_support_message');
    await sendMessage(chatId, `💬 <b>Служба поддержки klyaksa</b>\n\nНапишите ваш вопрос, отзыв или отчёт об ошибке прямо в этот диалог. Разработчик aqua сразу получит уведомление!`, {
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'main_menu' }]]
      }
    });
    return;
  }

  // Команда /about (О приложении)
  if (text === '/about' || text.startsWith('/about ') || text === '/help') {
    const siteUrl = config.website_url || 'https://klyaksabyaqua.netlify.app/';
    const aboutMsg = `ℹ️ <b>О приложении klyaksa</b>\n\n` +
      `<b>klyaksa</b> — это системный «живой» островок нового поколения для Windows 10/11 от разработчика <b>aqua</b>.\n\n` +
      `• <b>Платформа:</b> Windows 10 / Windows 11 (64-bit)\n` +
      `• <b>Официальный сайт:</b> <a href="${siteUrl}">${siteUrl}</a>\n` +
      `• <b>Команды бота:</b>\n` +
      `  /start — Главное меню\n` +
      `  /app — Открыть Telegram Mini App\n` +
      `  /keys — Ваши лицензионные ключи\n` +
      `  /buy — Оформить постоянную лицензию PRO\n` +
      `  /support — Связаться с разработчиком\n` +
      `  /about — Справка о программе`;
    await sendMessage(chatId, aboutMsg, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌐 Официальный сайт', url: siteUrl }],
          [{ text: '💬 Написать в поддержку', callback_data: 'support_start' }],
          [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Команда /claimadmin
  if (text === '/claimadmin') {
    if (config.admin_id && Number(config.admin_id) > 0) {
      if (isAdmin(userId)) {
        await sendMessage(chatId, '👑 Вы уже являетесь владельцем этого бота!', {
          reply_markup: getAdminKeyboard()
        });
      } else {
        await sendMessage(chatId, '⛔ У этого бота уже назначен владелец.');
      }
      return;
    }

    config.admin_id = Number(userId);
    saveConfig(config);
    console.log(`[Bot] Пользователь ${userId} назначен владельцем бота (admin_id сохранён в config.json)`);

    await sendMessage(
      chatId,
      `🎉 <b>Поздравляем! Вы успешно назначены владельцем бота klyaksa!</b>\n\n` +
      `Ваш Telegram ID: <code>${userId}</code> сохранён в <code>config.json</code>.\n` +
      `Вам открыт полный доступ к управлению лицензиями, статистике и модерации чеков.`,
      { reply_markup: getAdminKeyboard() }
    );
    return;
  }

  // Команда /admin
  if (text === '/admin') {
    if (!isAdmin(userId)) {
      await sendMessage(chatId, '⛔ Доступ запрещён. У вас нет прав администратора.');
      return;
    }
    await sendMessage(chatId, await getAdminDashboardMessage(), {
      reply_markup: getAdminKeyboard()
    });
    return;
  }

  // Если пользователь находится в режиме ожидания отправки чека СБП
  const isWaitingProof = userStates.get(userId) === 'waiting_receipt';
  const hasMedia = msg.photo || msg.document;

  if (isWaitingProof && hasMedia) {
    userStates.delete(userId);

    const fileId = msg.photo
      ? msg.photo[msg.photo.length - 1].file_id
      : msg.document.file_id;

    const plan = config.plans?.lifetime || { price_rub: 269 };
    const orderId = await db.createOrder({
      userId,
      username: msg.from.username || msg.from.first_name,
      method: 'sbp',
      amount: plan.price_rub,
      currency: 'RUB',
      proofFileId: fileId
    });

    await sendMessage(
      chatId,
      `✅ <b>Чек успешно получен! (Заявка #${orderId})</b>\n\n` +
      `Квитанция передана администратору на подтверждение.\n` +
      `Обычно проверка занимает от 2 до 15 минут. Как только перевод будет сверен, бот сразу пришлёт ваш лицензионный ключ klyaksa PRO прямо в этот чат!`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]]
        }
      }
    );

    // Пересылка чека администратору с кнопками подтверждения
    if (config.admin_id && config.admin_id > 0) {
      const adminCaption = `💳 <b>Новая заявка на оплату СБП #${orderId}!</b>\n\n` +
        `• Клиент: @${msg.from.username || 'unknown'} (ID: <code>${userId}</code>)\n` +
        `• Сумма: <b>${plan.price_rub} ₽</b>\n` +
        `• Дата: <code>${new Date().toLocaleString('ru-RU')}</code>`;

      const adminKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Подтвердить и выдать ключ', callback_data: `admin_approve:${orderId}` },
            { text: '❌ Отклонить', callback_data: `admin_decline:${orderId}` }
          ]
        ]
      };

      if (msg.photo) {
        await sendPhoto(config.admin_id, fileId, adminCaption, { reply_markup: adminKeyboard });
      } else {
        await sendDocument(config.admin_id, fileId, adminCaption, { reply_markup: adminKeyboard });
      }
    }
    return;
  }

  // Обычное текстовое сообщение в режиме СБП
  if (isWaitingProof && !hasMedia) {
    await sendMessage(
      chatId,
      '📸 Пожалуйста, прикрепите <b>скриншот или PDF-квитанцию</b> об оплате, либо нажмите «Отмена».',
      {
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'main_menu' }]]
        }
      }
    );
    return;
  }

  // 1. Команда админа /reply <userId> <текст ответа>
  if (isAdmin(userId) && text.startsWith('/reply')) {
    const match = text.match(/^\/reply\s+(\d+)\s+([\s\S]+)$/i);
    if (!match) {
      await sendMessage(chatId, '⚠️ Формат команды: <code>/reply &lt;ID_пользователя&gt; &lt;текст ответа&gt;</code>');
      return;
    }

    const targetUserId = match[1];
    const replyText = match[2].trim();

    try {
      await sendMessage(
        targetUserId,
        `💬 <b>Ответ службы поддержки klyaksa:</b>\n\n${replyText}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Ответить в поддержку', callback_data: 'support_start' }],
              [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
            ]
          }
        }
      );
      await sendMessage(chatId, `✅ <b>Ответ успешно доставлен пользователю!</b> (ID: <code>${targetUserId}</code>)`);
    } catch (err) {
      await sendMessage(chatId, `❌ Ошибка отправки ответа пользователю <code>${targetUserId}</code>: ${err.message}`);
    }
    return;
  }

  // Команда админа /revoke <KEY> - аннулирование / блокировка ключа
  if (isAdmin(userId) && text.startsWith('/revoke')) {
    const match = text.match(/^\/revoke\s+(\S+)$/i);
    if (!match) {
      await sendMessage(chatId, '⚠️ <b>Формат команды:</b> <code>/revoke &lt;КЛЮЧ&gt;</code>\nПример: <code>/revoke KLYA-PRO-ABCD-EFGH</code>\n\nБлокирует ключ навсегда.');
      return;
    }
    const keyToRevoke = match[1].trim();
    const res = await db.revokeLicense(keyToRevoke);
    if (res.success) {
      await sendMessage(chatId, `🚫 <b>Ключ аннулирован!</b>\nКлюч <code>${escapeHtml(keyToRevoke)}</code> заблокирован администратором. Активация на устройствах больше невозможна.`);
    } else {
      await sendMessage(chatId, `❌ Ошибка: ${escapeHtml(res.error)}`);
    }
    return;
  }

  // Команда админа /reset <KEY> - сброс привязки HWID ключа (отвязать от устройства)
  if (isAdmin(userId) && text.startsWith('/reset')) {
    const match = text.match(/^\/reset\s+(\S+)$/i);
    if (!match) {
      await sendMessage(chatId, '⚠️ <b>Формат команды:</b> <code>/reset &lt;КЛЮЧ&gt;</code>\nПример: <code>/reset KLYA-PRO-ABCD-EFGH</code>\n\nСбрасывает привязку к HWID, позволяя активировать ключ на другом ПК.');
      return;
    }
    const keyToReset = match[1].trim();
    const res = await db.resetLicenseHwid(keyToReset);
    if (res.success) {
      await sendMessage(chatId, `🔄 <b>Привязка сброшена!</b>\nКлюч <code>${escapeHtml(keyToReset)}</code> отвязан от устройства и снова доступен для повторной активации.`);
    } else {
      await sendMessage(chatId, `❌ Ошибка: ${escapeHtml(res.error)}`);
    }
    return;
  }

  // 2. Если администратор находится в режиме ответа через кнопку «✍️ Ответить»
  const adminState = userStates.get(userId);
  if (isAdmin(userId) && adminState && typeof adminState === 'object' && adminState.state === 'waiting_admin_reply') {
    const targetUserId = adminState.targetUserId;
    userStates.delete(userId);

    const replyText = (msg.text || msg.caption || '').trim();
    if (!replyText) {
      await sendMessage(chatId, '⚠️ Текст ответа не может быть пустым. Отправка отменена.');
      return;
    }

    try {
      await sendMessage(
        targetUserId,
        `💬 <b>Ответ службы поддержки klyaksa:</b>\n\n${replyText}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Ответить в поддержку', callback_data: 'support_start' }],
              [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
            ]
          }
        }
      );
      await sendMessage(chatId, `✅ <b>Ответ успешно доставлен пользователю!</b> (ID: <code>${targetUserId}</code>)`);
    } catch (err) {
      await sendMessage(chatId, `❌ Ошибка отправки ответа пользователю <code>${targetUserId}</code>: ${err.message}`);
    }
    return;
  }

  // 3. Если администратор делает обычный Reply (Ответить) в Telegram на сообщение тикета
  if (isAdmin(userId) && msg.reply_to_message) {
    const replyMsg = msg.reply_to_message;
    let targetUserId = supportTicketMapping.get(replyMsg.message_id);

    // Если нет в Map (например, после перезапуска) — извлекаем ID из текста сообщения
    if (!targetUserId) {
      const sourceContent = replyMsg.text || replyMsg.caption || '';
      const idMatch = sourceContent.match(/ID:\s*<code>(\d+)<\/code>/i) || sourceContent.match(/ID:\s*(\d+)/i);
      if (idMatch) {
        targetUserId = idMatch[1];
      }
    }

    if (targetUserId) {
      const replyText = (msg.text || msg.caption || '').trim();
      if (!replyText) {
        await sendMessage(chatId, '⚠️ Текст ответа не может быть пустым.');
        return;
      }

      try {
        await sendMessage(
          targetUserId,
          `💬 <b>Ответ службы поддержки klyaksa:</b>\n\n${replyText}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💬 Ответить в поддержку', callback_data: 'support_start' }],
                [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
              ]
            }
          }
        );
        await sendMessage(chatId, `✅ <b>Ответ успешно доставлен пользователю!</b> (ID: <code>${targetUserId}</code>)`);
      } catch (err) {
        await sendMessage(chatId, `❌ Ошибка отправки ответа пользователю <code>${targetUserId}</code>: ${err.message}`);
      }
      return;
    }
  }

  // 4. Если пользователь находится в режиме отправки обращения в поддержку
  if (userStates.get(userId) === 'waiting_support_message') {
    userStates.delete(userId);

    const fromUser = msg.from;
    const username = fromUser.username ? `@${fromUser.username}` : 'без юзернейма';
    const firstName = fromUser.first_name || 'Пользователь';
    const messageContent = (msg.text || msg.caption || '(Медиа-вложение без описания)').trim();

    // Подтверждение клиенту
    await sendMessage(
      chatId,
      `✅ <b>Ваше обращение передано разработчику aqua!</b>\n\n` +
      `Ответ придёт прямо в этот чат, как только разработчик его рассмотрит.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]]
        }
      }
    );

    // Пересылка администратору
    if (config.admin_id && config.admin_id > 0) {
      const adminCaption = `📩 <b>Новое обращение в поддержку!</b>\n\n` +
        `• От: ${username} (ID: <code>${userId}</code>, Имя: ${firstName})\n` +
        `• Дата: <code>${new Date().toLocaleString('ru-RU')}</code>\n\n` +
        `<b>Текст:</b>\n${messageContent}`;

      const replyKeyboard = {
        inline_keyboard: [
          [{ text: '✍️ Ответить', callback_data: `admin_reply_${userId}` }]
        ]
      };

      let sentMsg = null;
      if (msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        sentMsg = await sendPhoto(config.admin_id, fileId, adminCaption, { reply_markup: replyKeyboard });
      } else if (msg.document) {
        sentMsg = await sendDocument(config.admin_id, msg.document.file_id, adminCaption, { reply_markup: replyKeyboard });
      } else {
        sentMsg = await sendMessage(config.admin_id, adminCaption, { reply_markup: replyKeyboard });
      }

      if (sentMsg && sentMsg.message_id) {
        supportTicketMapping.set(sentMsg.message_id, userId);
      }
    }
    return;
  }

  // Дефолтный ответ
  await sendMessage(chatId, getMainWelcomeMessage(userId), {
    reply_markup: getMainKeyboard(userId)
  });
}

async function showUserKeys(chatId, userId, messageId = null) {
  const userLics = await db.getUserLicenses(userId);

  if (userLics.length === 0) {
    const msg = `🔍 <b>У вас пока нет активных лицензий klyaksa PRO.</b>\n\n` +
      `Вы можете приобрести постоянную лицензию через Stars или СБП по кнопкам ниже.`;
    if (messageId) {
      await editMessageText(chatId, messageId, msg, { reply_markup: getMainKeyboard(userId) });
    } else {
      await sendMessage(chatId, msg, { reply_markup: getMainKeyboard(userId) });
    }
    return;
  }

  let text = `🔑 <b>Ваши лицензионные ключи klyaksa PRO:</b>\n\n`;
  userLics.forEach((l, idx) => {
    const statusIcon = l.status === 'activated' ? '✅ Активирован на ПК' : '🟢 Готов к активации';
    const hwidInfo = l.activated_hwid ? `\n   Устройство: <code>${l.activated_hwid}</code>` : '';
    text += `${idx + 1}. <code>${l.key}</code>\n` +
      `   Статус: <b>${statusIcon}</b>${hwidInfo}\n\n`;
  });

  text += `📋 <i>Инструкция по активации:</i>\n` +
    `Скопируйте ключ (нажмите на него) и вставьте в приложении:\n` +
    `<b>Настройки ➔ CARD 0: klyaksa PRO ➔ Активировать</b>.`;

  const buttons = [[{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]];

  if (messageId) {
    await editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: buttons } });
  } else {
    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
  }
}

/**
 * Обработка нажатий Inline-кнопок
 */
async function handleCallbackQuery(cb) {
  const data = cb.data;
  const userId = cb.from.id;
  const chatId = cb.message ? cb.message.chat.id : userId;
  const messageId = cb.message ? cb.message.message_id : null;

  // 0. Назначение владельца бота
  if (data === 'claim_admin') {
    if (config.admin_id && Number(config.admin_id) > 0) {
      if (isAdmin(userId)) {
        await answerCallbackQuery(cb.id, 'Вы уже являетесь владельцем!', false);
      } else {
        await answerCallbackQuery(cb.id, 'У бота уже назначен владелец!', true);
      }
      return;
    }

    config.admin_id = Number(userId);
    saveConfig(config);
    console.log(`[Bot] Пользователь ${userId} назначен владельцем бота (admin_id сохранён в config.json)`);

    await answerCallbackQuery(cb.id, '🎉 Вы успешно стали владельцем бота!', false);

    const welcomeAdmin = `🎉 <b>Поздравляем! Вы назначены владельцем бота klyaksa PRO!</b>\n\n` +
      `Ваш Telegram ID: <code>${userId}</code> успешно привязан и сохранён в <code>config.json</code>.\n\n` +
      (await getAdminDashboardMessage());

    if (messageId) {
      await editMessageText(chatId, messageId, welcomeAdmin, {
        reply_markup: getAdminKeyboard()
      });
    } else {
      await sendMessage(chatId, welcomeAdmin, { reply_markup: getAdminKeyboard() });
    }
    return;
  }

  // 1. Главное меню
  if (data === 'main_menu') {
    userStates.delete(userId);
    await answerCallbackQuery(cb.id);
    if (messageId) {
      await editMessageText(chatId, messageId, getMainWelcomeMessage(userId), {
        reply_markup: getMainKeyboard(userId)
      });
    } else {
      await sendMessage(chatId, getMainWelcomeMessage(userId), { reply_markup: getMainKeyboard(userId) });
    }
    return;
  }

  // Обращение в поддержку от пользователя
  if (data === 'support_start') {
    userStates.set(userId, 'waiting_support_message');
    await answerCallbackQuery(cb.id);
    const supportPrompt = `💬 <b>Служба поддержки klyaksa</b>\n\n` +
      `Напишите ваш вопрос или опишите возникшую проблему прямо сюда ответным сообщением (можно отправить текст, скриншот или файл).\n\n` +
      `Ваше сообщение будет мгновенно передано разработчику aqua, а ответ придёт прямо в этот чат!`;

    const cancelKb = {
      inline_keyboard: [
        [{ text: '❌ Отмена', callback_data: 'main_menu' }]
      ]
    };

    if (messageId) {
      await editMessageText(chatId, messageId, supportPrompt, { reply_markup: cancelKb });
    } else {
      await sendMessage(chatId, supportPrompt, { reply_markup: cancelKb });
    }
    return;
  }

  // Ответ администратора на тикет через инлайн-кнопку «✍️ Ответить»
  if (data.startsWith('admin_reply_')) {
    if (!isAdmin(userId)) {
      await answerCallbackQuery(cb.id, '⛔ Нет доступа', true);
      return;
    }
    const targetUserId = data.replace('admin_reply_', '');
    userStates.set(userId, { state: 'waiting_admin_reply', targetUserId });
    await answerCallbackQuery(cb.id);
    await sendMessage(
      chatId,
      `✍️ <b>Режим ответа клиенту <code>${targetUserId}</code>:</b>\n\n` +
      `Напишите текст ответа следующим сообщением прямо в этот чат (или воспользуйтесь командой <code>/reply ${targetUserId} текст ответа</code>).\n\n` +
      `Для отмены нажмите кнопку ниже:`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Отменить ответ', callback_data: 'main_menu' }]]
        }
      }
    );
    return;
  }

  // 2. Покупка через Telegram Stars
  if (data === 'buy_stars') {
    await answerCallbackQuery(cb.id);
    const plan = config.plans?.lifetime || { price_stars: 249 };
    try {
      await sendStarsInvoice(
        chatId,
        'klyaksa PRO Lifetime by aqua',
        'Пожизненная лицензия klyaksa PRO для Windows 10/11 от aqua (все темы, стили глаз и режим Полуостров)',
        JSON.stringify({ userId, method: 'stars', ts: Date.now() }),
        plan.price_stars
      );
    } catch (err) {
      await sendMessage(
        chatId,
        '⚠️ Не удалось сформировать счёт Telegram Stars. Убедитесь, что бот настроен в @BotFather для приёма платежей.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'main_menu' }]]
          }
        }
      );
    }
    return;
  }

  // 3. Покупка через СБП / рубли (временно недоступна)
  if (data === 'buy_sbp') {
    const plan = config.plans?.lifetime || { price_rub: 269, price_stars: 249 };
    await answerCallbackQuery(
      cb.id,
      `Оплата картами и СБП (${plan.price_rub} ₽) временно настраивается и откроется в ближайшее время. Сейчас доступна моментальная оплата в 1 клик через Telegram Stars (${plan.price_stars} ⭐️)!`,
      true
    );
    return;
  }

  // 4. Мои ключи
  if (data === 'my_keys') {
    await answerCallbackQuery(cb.id);
    await showUserKeys(chatId, userId, messageId);
    return;
  }

  // 5. О программе
  if (data === 'about_app') {
    await answerCallbackQuery(cb.id);
    const siteUrl = config.website_url || 'https://klyaksabyaqua.netlify.app/';
    const text = `ℹ️ <b>О приложении klyaksa</b>\n\n` +
      `<b>klyaksa</b> — это системный «живой» островок нового поколения для Windows 10/11, сочетающий минимализм Dynamic Island и органическую физику жидкости.\n\n` +
      `• <b>Продукт:</b> klyaksa PRO by aqua\n` +
      `• <b>Разработчик:</b> aqua\n` +
      `• <b>Платформа:</b> Windows 10 / Windows 11 (64-bit)\n` +
      `• <b>Официальный сайт:</b> <a href="${siteUrl}">${siteUrl}</a>\n` +
      `• <b>Поддержка:</b> ${config.support_contact || '@klyaksa_payment_bot'} или кнопка «💬 Написать в поддержку»\n` +
      `• <b>Протокол быстрой активации:</b> <code>klyaksa://activate?key=...</code>\n\n` +
      `Скачать последнюю версию приложения всегда можно на нашем официальном сайте!`;

    const aboutKeyboard = {
      inline_keyboard: [
        [{ text: '🌐 Официальный сайт', url: siteUrl }],
        [{ text: '💬 Написать в поддержку', callback_data: 'support_start' }],
        [{ text: '⬅️ Назад', callback_data: 'main_menu' }]
      ]
    };

    if (messageId) {
      await editMessageText(chatId, messageId, text, { reply_markup: aboutKeyboard });
    } else {
      await sendMessage(chatId, text, { reply_markup: aboutKeyboard });
    }
    return;
  }

  // ==========================================
  // АДМИНИСТРАТИВНЫЕ ДЕЙСТВИЯ
  // ==========================================

  if (!isAdmin(userId)) {
    await answerCallbackQuery(cb.id, '⛔ Нет доступа', true);
    return;
  }

  // Панель админа
  if (data === 'admin_dashboard') {
    await answerCallbackQuery(cb.id);
    if (messageId) {
      await editMessageText(chatId, messageId, await getAdminDashboardMessage(), {
        reply_markup: getAdminKeyboard()
      });
    } else {
      await sendMessage(chatId, await getAdminDashboardMessage(), { reply_markup: getAdminKeyboard() });
    }
    return;
  }

  // Генерация 1 ключа
  if (data === 'admin_gen_1') {
    const lic = await db.createLicense('admin_panel', 'ProLifetime');
    await answerCallbackQuery(cb.id, 'Ключ успешно создан!', false);
    const text = `✅ <b>Выпущен 1 ключ klyaksa PRO:</b>\n\n` +
      `<code>${lic.key}</code>\n\n` +
      `Скопируйте ключ и введите в klyaksa: Настройки ➔ CARD 0: klyaksa PRO.`;

    await sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Ещё 1 ключ', callback_data: 'admin_gen_1' }],
          [{ text: '⬅️ В админку', callback_data: 'admin_dashboard' }]
        ]
      }
    });
    return;
  }

  // Генерация 5 ключей
  if (data === 'admin_gen_5') {
    const keys = await db.createBatchLicenses(5, 'admin_panel', 'ProLifetime');
    await answerCallbackQuery(cb.id, '5 ключей сгенерировано!', false);
    let text = `📦 <b>Выпущена пачка из 5 ключей klyaksa PRO:</b>\n\n`;
    keys.forEach((k, idx) => {
      text += `${idx + 1}. <code>${k}</code>\n`;
    });

    await sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ В админку', callback_data: 'admin_dashboard' }]]
      }
    });
    return;
  }

  // Список свободных ключей
  if (data === 'admin_list_keys') {
    await answerCallbackQuery(cb.id);
    const available = await db.getAvailableKeys(10);
    if (available.length === 0) {
      await sendMessage(chatId, '📋 Нет свободных ключей. Нажмите «Выпустить», чтобы создать новые.', {
        reply_markup: getAdminKeyboard()
      });
      return;
    }

    let text = `📋 <b>Свободные ключи в базе (до 10 шт.):</b>\n\n`;
    available.forEach((l, idx) => {
      text += `${idx + 1}. <code>${l.key}</code> (${new Date(l.created_at).toLocaleDateString()})\n`;
    });

    await sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ В админку', callback_data: 'admin_dashboard' }]]
      }
    });
    return;
  }

  // Список ожидающих заказов СБП
  if (data === 'admin_pending_orders') {
    await answerCallbackQuery(cb.id);
    const pending = await db.getPendingOrders();
    if (pending.length === 0) {
      await sendMessage(chatId, '✅ Нет ожидающих заявок. Все чеки обработаны!', {
        reply_markup: getAdminKeyboard()
      });
      return;
    }

    let text = `⏳ <b>Ожидающие заявки на подтверждение (${pending.length}):</b>\n\n`;
    const buttons = [];
    pending.forEach((o, idx) => {
      text += `Заявка #${o.id} | @${o.username || 'unknown'} | ${o.amount} ₽ | ${new Date(o.created_at).toLocaleTimeString()}\n`;
      buttons.push([
        { text: `✅ Одобрить #${o.id}`, callback_data: `admin_approve:${o.id}` },
        { text: `❌ Отклонить #${o.id}`, callback_data: `admin_decline:${o.id}` }
      ]);
    });
    buttons.push([{ text: '⬅️ В админку', callback_data: 'admin_dashboard' }]);

    await sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
    return;
  }

  // Подтверждение заявки админом
  if (data.startsWith('admin_approve:')) {
    const orderId = parseInt(data.split(':')[1], 10);
    const order = await db.getOrder(orderId);

    if (!order) {
      await answerCallbackQuery(cb.id, 'Заказ не найден', true);
      return;
    }

    if (order.status !== 'pending') {
      await answerCallbackQuery(cb.id, `Заказ уже обработан (статус: ${order.status})`, true);
      return;
    }

    const approval = await db.approveOrder(orderId);
    if (approval.alreadyProcessed || !approval.license) {
      await answerCallbackQuery(cb.id, `Заказ уже обработан (статус: ${approval.order?.status || 'unknown'})`, true);
      return;
    }
    const lic = approval.license;

    await answerCallbackQuery(cb.id, `Заказ #${orderId} одобрен! Ключ отправлен.`, false);

    // Обновляем сообщение у админа
    if (messageId) {
      await editMessageText(
        chatId,
        messageId,
        `✅ <b>Заявка #${orderId} подтверждена!</b>\n` +
        `• Покупатель: @${order.username} (ID: <code>${order.user_id}</code>)\n` +
        `• Выдан ключ: <code>${lic.key}</code>\n` +
        `• Время: <code>${new Date().toLocaleTimeString()}</code>`
      );
    }

    // Отправляем ключ клиенту
    const clientMsg = `🎉 <b>Ваш платёж подтверждён администратором!</b>\n\n` +
      `Ваш персональный лицензионный ключ <b>klyaksa PRO Lifetime</b>:\n` +
      `<code>${lic.key}</code>\n\n` +
      `📋 <b>Инструкция по активации:</b>\n` +
      `1. Скопируйте ключ выше (нажмите на него)\n` +
      `2. Откройте приложение klyaksa на ПК\n` +
      `3. Перейдите в <b>Настройки ➔ CARD 0: klyaksa PRO</b>\n` +
      `4. Вставьте ключ и нажмите «Активировать».`;

    await sendMessage(order.user_id, clientMsg, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔑 Мои ключи', callback_data: 'my_keys' }],
          [{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]
        ]
      }
    });
    return;
  }

  // Отклонение заявки админом
  if (data.startsWith('admin_decline:')) {
    const orderId = parseInt(data.split(':')[1], 10);
    const order = await db.getOrder(orderId);

    if (!order) {
      await answerCallbackQuery(cb.id, 'Заказ не найден', true);
      return;
    }

    if (order.status !== 'pending') {
      await answerCallbackQuery(cb.id, `Заказ уже обработан (статус: ${order.status})`, true);
      return;
    }

    await db.declineOrder(orderId);
    await answerCallbackQuery(cb.id, `Заказ #${orderId} отклонён.`, false);

    if (messageId) {
      await editMessageText(
        chatId,
        messageId,
        `❌ <b>Заявка #${orderId} отклонена.</b>\n` +
        `• Покупатель: @${order.username} (ID: <code>${order.user_id}</code>)\n` +
        `• Время: <code>${new Date().toLocaleTimeString()}</code>`
      );
    }

    // Уведомление клиенту
    await sendMessage(
      order.user_id,
      `❌ <b>Ваш платёж по заявке #${orderId} не был подтверждён.</b>\n\n` +
      `Если произошла ошибка или вы отправили не ту квитанцию, пожалуйста, свяжитесь с поддержкой: ${config.support_contact || '@support'}.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ В главное меню', callback_data: 'main_menu' }]]
        }
      }
    );
  }
}

// ==========================================
// TELEGRAM BOT LONG POLLING ЦИКЛ
// ==========================================

/**
 * Автоматическая настройка профиля бота в Telegram:
 * Имя: klyaksa PRO ✦ aqua
 * Краткое описание: Официальный бот покупки klyaksa PRO от aqua. Быстрая активация в 1 клик.
 * Полное описание до старта: детальное описание островочка, функций PRO и автора aqua.
 */
async function updateBotProfile() {
  try {
    // Примечание: Имя бота задаётся вручную в @BotFather (/setname),
    // чтобы не срабатывал лимит Telegram API 429 (смена имени разрешена не чаще 1-2 раз в сутки).
    await apiCall('setMyShortDescription', {
      short_description: 'Официальный бот покупки klyaksa PRO от aqua. Мгновенная выдача лицензии.'
    });
    await apiCall('setMyDescription', {
      description: '✨ klyaksa PRO by aqua\n\n' +
        'Живой адаптивный островок для Windows 10/11 с органической физикой жидкости, мониторингом CPU/GPU, плеером и умными виджетами.\n\n' +
        '✦ Возможности PRO:\n' +
        '• 🖤 OLED True Black (0 nits)\n' +
        '• 🍷 Crimson Velvet (Алый бархат)\n' +
        '• 👀 4 стиля глаз: Кошачьи ✦, Мультяшные ✦, Хитринка ✦, Сердечки ✦\n' +
        '• 🏝 Режим «Полуостров» (0px кромка)\n' +
        '• 🚀 Мониторинг GPU и температур\n' +
        '• ♾️ Пожизненная лицензия Lifetime\n\n' +
        '💎 Стоимость: 249 ⭐️ Telegram Stars\n' +
        '👨‍💻 Разработчик: aqua\n\n' +
        'Нажмите Start для мгновенной активации!'
    });
    console.log('[Bot] Профиль бота успешно синхронизирован с Telegram API (klyaksa PRO ✦ aqua)');
  } catch (err) {
    console.error('[Bot] Ошибка обновления профиля бота:', err.message);
  }
}

let isPolling = false;
let updateOffset = 0;

async function startPolling() {
  if (!TOKEN || TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') {
    console.log('='.repeat(65));
    console.log('  [Notice] Токен бота не настроен.');
    console.log('  [Notice] Telegram-бот переведён в режим ожидания токена.');
    console.log('  [Notice] Встроенный HTTP-сервер лицензий работает на порту ' + (config.server_port || 3782));
    console.log('  [Notice] Задайте пользовательскую переменную KLYAKSA_BOT_TOKEN и перезапустите бот.');
    console.log('='.repeat(65));
    return;
  }

  isPolling = true;
  console.log(`[Bot] Запущен Long Polling Telegram API для бота...`);

  // Проверка соединения getMe и синхронизация профиля бота
  try {
    const me = await apiCall('getMe');
    console.log(`[Bot] Авторизован как @${me.username} (ID: ${me.id})`);
    await updateBotProfile();

    // Регистрация команд бота
    try {
      await apiCall('setMyCommands', {
        commands: [
          { command: 'start', description: 'Главное меню / Каталог' },
          { command: 'app', description: 'Открыть klyaksa Mini App' },
          { command: 'keys', description: 'Мои лицензионные ключи' },
          { command: 'buy', description: 'Приобрести klyaksa PRO' },
          { command: 'support', description: 'Служба поддержки' },
          { command: 'about', description: 'О возможностях klyaksa' }
        ]
      });
      console.log('[Bot] Команды чата успешно зарегистрированы в Telegram');
    } catch (cmdErr) {
      console.error('[Bot] Ошибка настройки setMyCommands:', cmdErr.message);
    }

    // Восстановление стандартного меню команд чата
    try {
      await apiCall('setChatMenuButton', {
        menu_button: { type: 'default' }
      });
      console.log('[Bot] Меню команд чата установлено по умолчанию');
    } catch (menuErr) {
      console.error('[Bot] Ошибка настройки setChatMenuButton:', menuErr.message);
    }
  } catch (err) {
    console.error('[Bot] Ошибка авторизации getMe:', err.message);
  }

  while (isPolling) {
    try {
      const updates = await apiCall('getUpdates', {
        offset: updateOffset,
        timeout: 15,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query']
      });

      if (Array.isArray(updates)) {
        for (const update of updates) {
          updateOffset = update.update_id + 1;
          handleUpdate(update).catch(err => {
            console.error('[Bot] Ошибка при обработке update:', err);
          });
        }
      }
    } catch (err) {
      const errMsg = err.message || '';
      if (errMsg.includes('ETIMEDOUT') || errMsg.includes('TimeoutError') || errMsg.includes('сеть')) {
        // Обычный таймаут или сетевая пауза long polling, пробуем снова
        continue;
      }
      console.error('[Bot] Сбой в цикле polling (повтор через 3 сек):', errMsg);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ==========================================
// ИНИЦИАЛИЗАЦИЯ И СВЯЗЬ С HTTP-СЕРВЕРОМ
// ==========================================

// Запуск встроенного HTTP-сервера для верификации приложением klyaksa
startServer(event => {
  console.log(`[Server -> Bot] Лицензия ${event.key} активирована на ПК HWID=${event.hwid}`);

  // Если настроен admin_id, присылаем уведомление в Telegram об активации
  if (config.admin_id && config.admin_id > 0) {
    const msg = `💻 <b>Лицензия klyaksa PRO активирована на ПК!</b>\n\n` +
      `• Ключ: <code>${event.key}</code>\n` +
      `• Устройство (HWID): <code>${event.hwid}</code>\n` +
      `• Тариф: <b>${event.tier}</b>\n` +
      `• Время: <code>${new Date().toLocaleString('ru-RU')}</code>`;

    sendMessage(config.admin_id, msg).catch(() => {});
  }
});

// Запуск Telegram polling с автоматическим перезапуском при сбоях
async function runBot() {
  while (true) {
    try {
      await startPolling();
      return;
    } catch (err) {
      console.error('[Bot] Сбой polling, повторный перезапуск через 5 сек:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

runBot().catch(err => {
  console.error('[Bot] Критическая ошибка в runBot:', err);
});
