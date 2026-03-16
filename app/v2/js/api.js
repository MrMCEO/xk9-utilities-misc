/**
 * api.js — HTTP-клиент для всех запросов к серверу.
 * Все запросы уходят методом POST с заголовком X-Init-Data (Telegram initData).
 */

const getApiUrl = () => window.API_URL || '';

// Маппинг серверных кодов ошибок на читаемые пользовательские сообщения.
// Скрывает внутренние детали реализации от пользователя.
const ERROR_MAP = {
    'insufficient_funds': 'Недостаточно средств',
    'invalid_stake':      'Неверная ставка',
    'invalid_multiplier': 'Неверный множитель',
    'session_not_found':  'Сессия не найдена',
    'forbidden':          'Доступ запрещён',
    'unauthorized':       'Необходима авторизация',
    'rate_limited':       'Слишком много запросов',
    'banned':             'Аккаунт заблокирован',
    'maintenance':        'Казино на обслуживании',
    'not_found':          'Ресурс не найден',
    'too_large':          'Слишком большой запрос',
    'invalid_params':     'Неверные параметры',
};

/**
 * Выполнить POST-запрос к серверному API.
 * @param {string} path   — путь, например '/api/rocket/start'
 * @param {object} body   — тело запроса (будет сериализовано в JSON)
 * @returns {Promise<object>} — распарсенный JSON-ответ
 * @throws {Error} — если статус ответа не 2xx (с пользовательским сообщением)
 */
export async function fetchAPI(path, body = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 сек
    try {
        const res = await fetch(`${getApiUrl()}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Init-Data': window.Telegram?.WebApp?.initData || ''
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            // Показываем пользовательское сообщение, не сырой серверный ответ
            const userMsg = ERROR_MAP[e.error] || 'Ошибка сервера';
            throw new Error(userMsg);
        }
        return res.json();
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error('Таймаут соединения');
        throw err;
    }
}
