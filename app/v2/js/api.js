/**
 * api.js — HTTP-клиент для всех запросов к серверу.
 * Все запросы уходят методом POST с заголовком X-Init-Data (Telegram initData).
 */

const getApiUrl = () => window.API_URL || '';

/**
 * Выполнить POST-запрос к серверному API.
 * @param {string} path   — путь, например '/api/rocket/start'
 * @param {object} body   — тело запроса (будет сериализовано в JSON)
 * @returns {Promise<object>} — распарсенный JSON-ответ
 * @throws {Error} — если статус ответа не 2xx
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
            throw new Error(e.error || `API ${res.status}`);
        }
        return res.json();
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error('Таймаут соединения');
        throw err;
    }
}
