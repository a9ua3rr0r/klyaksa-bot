// server.js - Встроенный HTTP-сервер для верификации и активации лицензий klyaksa PRO
const http = require('node:http');
const crypto = require('node:crypto');
const db = require('./db.js');
const fs = require('node:fs');
const path = require('node:path');

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

// Загрузка конфигурации. Environment variables have priority over config.json.
function loadConfig() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (err) {
    console.error('[Server] Ошибка чтения config.json:', err.message);
  }

  const env = process.env;
  if (env.KLYAKSA_BOT_TOKEN?.trim()) config.bot_token = env.KLYAKSA_BOT_TOKEN.trim();
  if (env.ADMIN_ID?.trim()) config.admin_id = parsePositiveInteger(env.ADMIN_ID, config.admin_id);
  if (env.SERVER_PORT?.trim() || env.PORT?.trim()) config.server_port = parsePositiveInteger(env.SERVER_PORT || env.PORT, config.server_port || 3782);
  if (env.SERVER_HOST?.trim()) config.server_host = env.SERVER_HOST.trim();
  if (env.CORS_ORIGINS?.trim()) config.cors_origins = env.CORS_ORIGINS.trim();
  return config;
}

function getCorsOrigins(config) {
  const value = config.cors_origins || process.env.CORS_ORIGINS || '';
  return String(value).split(',').map(origin => origin.trim()).filter(Boolean);
}

function getRequestOrigin(req) {
  return typeof req.headers.origin === 'string' ? req.headers.origin : '';
}

function isTelegramInitDataValid(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(receivedHash, 'hex'), Buffer.from(expectedHash, 'hex'))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
  try {
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}

function getTelegramAuth(req, config) {
  const header = req.headers['x-telegram-init-data'] || req.headers.authorization || '';
  const initData = String(header).replace(/^tma\s+/i, '').trim();
  return isTelegramInitDataValid(initData, config.bot_token);
}

function getClientAddress(req) {
  return String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function createRateLimiter({ limit, windowMs }) {
  const requests = new Map();
  let lastCleanup = 0;

  return (key, now = Date.now()) => {
    const windowStart = now - windowMs;
    const timestamps = requests.get(key) || [];
    const recent = timestamps.filter(timestamp => timestamp > windowStart);
    if (recent.length >= limit) {
      requests.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) };
    }
    recent.push(now);
    requests.set(key, recent);

    if (now - lastCleanup > windowMs) {
      for (const [entryKey, entry] of requests) {
        if (!entry.some(timestamp => timestamp > windowStart)) requests.delete(entryKey);
      }
      lastCleanup = now;
    }
    return { allowed: true };
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Читает JSON тело запроса
 */
function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      reject(Object.assign(new Error(`Размер тела запроса превысил допустимый лимит (${maxBytes} байт).`), { code: 'PAYLOAD_TOO_LARGE' }));
      return;
    }

    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error(`Размер тела запроса превысил допустимый лимит (${maxBytes} байт).`), { code: 'PAYLOAD_TOO_LARGE' }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Некорректный JSON в теле запроса.'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Отправляет JSON ответ с CORS-заголовками
 */
function sendJson(res, statusCode, data, corsOrigin = res.__corsOrigin || '') {
  const payload = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Telegram-Init-Data',
    'Content-Length': Buffer.byteLength(payload)
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers.Vary = 'Origin';
  }
  res.writeHead(statusCode, headers);
  res.end(payload);
}

/**
 * Создаёт и запускает HTTP-сервер
 * @param {Function} onActivationNotification Callback при успешной активации (для отправки в Telegram)
 */
function startServer(onActivationNotification = null) {
  const config = loadConfig();
  const port = parsePositiveInteger(process.env.PORT || config.server_port, 3782);
  const host = (process.env.PORT || process.env.NODE_ENV === 'production' || process.env.RENDER) ? '0.0.0.0' : (config.server_host || '127.0.0.1');
  const corsOrigins = getCorsOrigins(config);
  const rateLimiters = {
    activate: createRateLimiter({ limit: 10, windowMs: 60 * 1000 }),
    verify: createRateLimiter({ limit: 60, windowMs: 60 * 1000 }),
    supportTicket: createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 })
  };
  const bodyLimits = {
    activate: 64 * 1024,
    verify: 64 * 1024,
    supportTicket: 10 * 1024 * 1024
  };

  const server = http.createServer(async (req, res) => {
    const requestOrigin = getRequestOrigin(req);
    const corsOrigin = corsOrigins.includes('*') ? '*' : (corsOrigins.includes(requestOrigin) ? requestOrigin : '');
    res.__corsOrigin = corsOrigin;
    // Обработка Preflight CORS
    if (req.method === 'OPTIONS') {
      if (!corsOrigin) return sendJson(res, 403, { success: false, error: 'Origin не разрешён.' });
      res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Telegram-Init-Data',
        Vary: 'Origin'
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.toLowerCase();

    try {
      // 1. Проверка статуса сервера
      if (req.method === 'GET' && (pathname === '/api/status' || pathname === '/')) {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'klyaksa-licensing-server',
          version: '1.0.0',
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString()
        });
      }

      // 1.1. Проверка статуса лицензий пользователя по Telegram ID (для Mini App)
      if (req.method === 'GET' && pathname === '/api/user-status') {
        const telegramUser = getTelegramAuth(req, config);
        if (!telegramUser || !telegramUser.id) {
          return sendJson(res, 401, { success: false, error: 'Требуется действительная авторизация Telegram Web App.' });
        }
        const requestedUserId = url.searchParams.get('user_id');
        const userId = requestedUserId || String(telegramUser.id);
        if (!/^\d{1,20}$/.test(userId) || Number(userId) <= 0 || Number(userId) !== Number(telegramUser.id)) {
          return sendJson(res, 403, { success: false, error: 'Нельзя запросить статус другого пользователя.' });
        }
        const userLicenses = await db.getUserLicenses(Number(userId));
        return sendJson(res, 200, {
          success: true,
          user_id: Number(userId),
          is_pro: userLicenses.some(l => l.status === 'activated' || l.status === 'available'),
          licenses: userLicenses.map(l => ({
            key: l.key,
            tier: l.tier,
            status: l.status,
            activated_at: l.activated_at
          }))
        });
      }

      // 2. Активация ключа klyaksa PRO (поддерживает /api/activate и fallback на /)
      if (req.method === 'POST' && (pathname === '/api/activate' || pathname === '/')) {
        const rate = rateLimiters.activate(`${getClientAddress(req)}:activate`);
        if (!rate.allowed) {
          res.setHeader('Retry-After', rate.retryAfterSeconds);
          return sendJson(res, 429, { success: false, error: 'Слишком много запросов на активацию. Повторите позже.' });
        }
        const body = await readJsonBody(req, bodyLimits.activate);
        const { key, hwid, user } = body;

        if (!key || !hwid) {
          return sendJson(res, 400, {
            success: false,
            error: 'Поля key и hwid обязательны для активации.'
          });
        }

        const result = await db.activateLicense(key, hwid, user);

        if (result.success) {
          // Если это первичная активация на новом ПК — уведомляем Telegram
          if (!result.isReactivation && typeof onActivationNotification === 'function') {
            try {
              onActivationNotification({
                key: result.license.key,
                hwid,
                tier: result.tier,
                claimedBy: result.license.claimed_by,
                activatedAt: result.license.activated_at
              });
            } catch (notifyErr) {
              console.error('[Server] Ошибка отправки уведомления в Telegram:', notifyErr.message);
            }
          }

          return sendJson(res, 200, {
            success: true,
            tier: result.tier,
            message: result.message,
            key: result.license.key,
            hwid: result.license.activated_hwid
          });
        } else {
          return sendJson(res, 200, {
            success: false,
            error: result.error
          });
        }
      }

      // 2b. Деактивация / отвязка ключа klyaksa PRO от устройства
      if (req.method === 'POST' && pathname === '/api/deactivate') {
        const rate = rateLimiters.activate(`${getClientAddress(req)}:deactivate`);
        if (!rate.allowed) {
          res.setHeader('Retry-After', rate.retryAfterSeconds);
          return sendJson(res, 429, { success: false, error: 'Слишком много запросов. Повторите позже.' });
        }
        const body = await readJsonBody(req, bodyLimits.activate);
        const { key, hwid } = body;

        if (!key || !hwid) {
          return sendJson(res, 400, {
            success: false,
            error: 'Поля key и hwid обязательны для деактивации.'
          });
        }

        const result = await db.deactivateLicense(key, hwid);
        return sendJson(res, 200, result);
      }

      // 3. Быстрая проверка валидности ключа без смены статуса
      if (req.method === 'POST' && pathname === '/api/verify') {
        const rate = rateLimiters.verify(`${getClientAddress(req)}:verify`);
        if (!rate.allowed) {
          res.setHeader('Retry-After', rate.retryAfterSeconds);
          return sendJson(res, 429, { success: false, error: 'Слишком много запросов на проверку. Повторите позже.' });
        }
        const body = await readJsonBody(req, bodyLimits.verify);
        const { key, hwid } = body;

        if (!key) {
          return sendJson(res, 400, { success: false, error: 'Поле key обязательно.' });
        }

        const lic = await db.getLicense(key);
        if (!lic) {
          return sendJson(res, 200, { success: false, error: 'Лицензионный ключ не существует.' });
        }

        if (lic.status === 'revoked') {
          return sendJson(res, 200, { success: false, error: 'Лицензионный ключ аннулирован.' });
        }

        if (lic.status === 'activated') {
          const match = hwid && lic.activated_hwid && lic.activated_hwid.toUpperCase() === String(hwid).trim().toUpperCase();
          return sendJson(res, 200, {
            success: true,
            valid: true,
            tier: lic.tier,
            status: 'activated',
            matchesHwid: !!match
          });
        }

        return sendJson(res, 200, {
          success: true,
          valid: true,
          tier: lic.tier,
          status: 'available'
        });
      }

      // 4. Отправка обращения / баг-репорта со скриншотом разработчику aqua в Telegram
      if (req.method === 'POST' && pathname === '/api/support-ticket') {
        const rate = rateLimiters.supportTicket(`${getClientAddress(req)}:support-ticket`);
        if (!rate.allowed) {
          res.setHeader('Retry-After', rate.retryAfterSeconds);
          return sendJson(res, 429, { success: false, error: 'Слишком много обращений. Повторите позже.' });
        }
        const body = await readJsonBody(req, bodyLimits.supportTicket);
        const { topic, text, imageBase64, senderName, senderContact } = body;
        const trimmedText = typeof text === 'string' ? text.trim() : '';
        const trimmedImage = typeof imageBase64 === 'string' ? imageBase64.trim() : '';

        if (!trimmedText && !trimmedImage) {
          return sendJson(res, 400, { success: false, error: 'Текст или скриншот обязателен.' });
        }

        const botConfig = loadConfig();
        if (botConfig.admin_id && Number(botConfig.admin_id) > 0 && botConfig.bot_token) {
          const caption = `📩 <b>Новое обращение (Баг-репорт / Предложение)!</b>\n\n` +
            `• От: <b>${escapeHtml(senderName || 'Пользователь')}</b>\n` +
            `• Контакт: <code>${escapeHtml(senderContact || 'не указан')}</code>\n` +
            `• Категория: <b>${escapeHtml(topic || 'Общий вопрос')}</b>\n` +
            `• Дата: <code>${new Date().toLocaleString('ru-RU')}</code>\n\n` +
            `<b>Текст:</b>\n${escapeHtml(text || '(Прикреплён скриншот без текста)')}`;

          const token = botConfig.bot_token;
          let sent = false;

          if (trimmedImage && trimmedImage.includes('base64,')) {
            try {
              const base64Data = trimmedImage.split('base64,')[1];
              const buffer = Buffer.from(base64Data, 'base64');
              if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
                throw new Error('Размер изображения должен быть от 1 байта до 5 MB.');
              }
              const form = new FormData();
              form.append('chat_id', botConfig.admin_id);
              form.append('caption', caption);
              form.append('parse_mode', 'HTML');
              form.append('photo', new Blob([buffer], { type: 'image/png' }), 'screenshot.png');

              const photoRes = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
                method: 'POST',
                body: form
              });
              const photoData = await photoRes.json();
              sent = photoData.ok;
            } catch (pErr) {
              console.error('[Server] Сбой отправки фото:', pErr.message);
            }
          }

          if (!sent && trimmedText) {
            const messageRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: botConfig.admin_id,
                text: caption,
                parse_mode: 'HTML'
              })
            });
            const messageData = await messageRes.json();
            sent = messageRes.ok && messageData.ok;
          }
          if (sent) {
            return sendJson(res, 200, {
              success: true,
              message: '✓ Ваше обращение успешно доставлено разработчику aqua!'
            });
          }
        }

        return sendJson(res, 502, { success: false, error: 'Не удалось доставить обращение.' });
      }

      // 404
      return sendJson(res, 404, { error: 'Эндпоинт не найден' });
    } catch (err) {
      if (err.code === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 413, { success: false, error: err.message });
      }
      console.error('[Server] Внутренняя ошибка сервера:', err);
      return sendJson(res, 500, {
        success: false,
        error: 'Внутренняя ошибка сервера лицензирования.'
      });
    }
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] Получен ${signal}, корректно закрываем HTTP-сервер.`);
    server.close(error => {
      if (error) {
        console.error('[Server] Ошибка graceful shutdown:', error.message);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  server.listen(port, host, () => {
    console.log(`[Server] Сервер лицензирования klyaksa запущен на ${host}:${port}`);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Ошибка: Порт ${port} уже занят другим приложением.`);
    } else {
      console.error('[Server] Ошибка сервера:', err.message);
    }
  });

  return server;
}

// Запуск напрямую, если вызван через `node server.js`
if (require.main === module) {
  startServer(event => {
    console.log(`[Notification] Лицензия ${event.key} активирована на ПК HWID=${event.hwid}`);
  });
}

module.exports = { startServer };
