import logging
import json
import random
from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.filters import Command
from aiogram.types import (
    Message, 
    CallbackQuery, 
    InlineKeyboardMarkup, 
    InlineKeyboardButton, 
    WebAppInfo,
    MenuButtonWebApp
)
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton
from aiogram.utils.keyboard import InlineKeyboardBuilder, ReplyKeyboardBuilder
from config import BOT_TOKEN, ADMIN_IDS, DEFAULT_BALANCE, WEB_APP_URL, DB_PATH
from database import (
    init_db,
    get_or_create_user, 
    get_user_balance, 
    update_balance, 
    set_balance,
    add_game,
    get_user_games,
    get_user_stats,
    get_all_users,
    get_recent_games
)

# Настройка логирования
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Инициализация бота и диспетчера
bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
dp = Dispatcher()

# Инициализация БД при старте
init_db()


# === Клавиатуры ===

def get_main_keyboard() -> ReplyKeyboardMarkup:
    """Основная клавиатура с кнопкой Web App"""
    builder = ReplyKeyboardBuilder()
    builder.button(text="🎮 Запустить приложение", web_app=WebAppInfo(url=WEB_APP_URL))
    builder.button(text="🎰 Казино")
    builder.button(text="📊 Моя статистика")
    builder.button(text="💰 Баланс")
    builder.button(text="📜 История игр")
    builder.button(text="❓ Помощь")
    builder.adjust(1, 2, 2, 1)
    return builder.as_markup(resize_keyboard=True)


def get_admin_keyboard() -> InlineKeyboardMarkup:
    """Админ панель"""
    builder = InlineKeyboardBuilder()
    builder.button(text="👥 Все пользователи", callback_data="admin_users")
    builder.button(text="📈 Общая статистика", callback_data="admin_stats")
    builder.button(text="💵 Изменить баланс", callback_data="admin_balance")
    return builder.as_markup()


# === Команды ===

@dp.message(Command("start"))
async def cmd_start(message: Message):
    """Команда /start - приветствие и авторизация"""
    user = get_or_create_user(
        telegram_id=message.from_user.id,
        username=message.from_user.username,
        first_name=message.from_user.first_name,
        last_name=message.from_user.last_name
    )

    await message.answer(
        f"🎰 <b>Добро пожаловать в BFG Casino!</b>\n\n"
        f"👤 {message.from_user.first_name}, ваш баланс: <b>${user['balance']:,.2f}</b>\n\n"
        f"🚀 Запускайте игру и испытайте удачу!\n"
        f"Нажмите кнопку ниже 👇",
        reply_markup=get_main_keyboard(),
    )


@dp.message(Command("play"))
@dp.message(Command("game"))
async def cmd_play(message: Message):
    """Команда /play - открыть игру"""
    await message.answer(
        "🎮 <b>BFG Casino — Web App</b>\n\n"
        "🚀 Ракета · 💣 Сапер\n"
        "Выбирай игру и испытай удачу!",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🎮 Открыть приложение", web_app=WebAppInfo(url=WEB_APP_URL))]
        ])
    )


@dp.message(Command("help"))
@dp.message(F.text == "❓ Помощь")
async def cmd_help(message: Message):
    """Команда /help - справка"""
    help_text = (
        "📖 <b>Справка по BFG Casino</b>\n\n"
        "🎮 <b>Игры в приложении:</b>\n"
        "🚀 <b>Ракета</b> — забирай выигрыш до краша, множитель растёт\n"
        "💣 <b>Сапер</b> — открывай ячейки, избегай мин, множитель растёт\n"
        "🎰 <b>Казино</b> — быстрая игра прямо в боте\n\n"
        "💰 <b>Команды:</b>\n"
        "/start - Запустить бота\n"
        "/play - Открыть игровое приложение\n"
        "/casino - Игра в казино (<ставка>)\n"
        "/balance - Проверить баланс\n"
        "/stats - Моя статистика\n"
        "/history - История игр\n"
        "/help - Эта справка\n\n"
        "🔧 <b>Админ:</b>\n"
        "/admin - Панель администратора\n"
        "/setbalance - Изменить баланс"
    )
    await message.answer(help_text)


@dp.message(F.text == "💰 Баланс")
async def cmd_balance(message: Message):
    """Показать баланс"""
    balance = get_user_balance(message.from_user.id)
    await message.answer(f"💰 <b>Ваш баланс:</b> ${balance:,.2f}")


@dp.message(F.text == "📊 Моя статистика")
async def cmd_stats(message: Message):
    """Показать статистику пользователя"""
    stats = get_user_stats(message.from_user.id)

    if stats['total_games'] == 0:
        await message.answer("📊 У вас пока нет игр. Испытайте удачу! 🎮")
        return

    stats_text = (
        f"📊 <b>Ваша статистика:</b>\n\n"
        f"🎮 Игр сыграно: <b>{stats['total_games']}</b>\n"
        f"✅ Побед: <b>{stats['wins']}</b>\n"
        f"❌ Поражений: <b>{stats['losses']}</b>\n"
        f"📈 Win Rate: <b>{stats['win_rate']:.1f}%</b>\n\n" 
        f"💵 Всего поставлено: <b>${stats['total_staked']:,.2f}</b>\n"
        f"💰 Всего выиграно: <b>${stats['total_winnings']:,.2f}</b>\n"
        f"{'🟢' if stats['profit'] >= 0 else '🔴'} Профит: <b>${stats['profit']:,.2f}</b>"
    )

    await message.answer(stats_text)


@dp.message(F.text == "📜 История игр")
async def cmd_history(message: Message):
    """Показать историю игр"""
    games = get_user_games(message.from_user.id, limit=15)

    if not games:
        await message.answer("📜 У вас пока нет игр в истории.")
        return

    history_text = "📜 <b>Последние игры:</b>\n\n"
    for i, game in enumerate(games, 1):
        emoji = "✅" if game['result'] == 'win' else "❌"
        history_text += (
            f"{i}. {emoji} <b>{game['game_type']}</b> | "
            f"Ставка: ${game['stake']:.2f} | "
            f"Выигрыш: ${game['winnings']:.2f}\n"
        )

    await message.answer(history_text)


# === Обработка данных от Web App ===

@dp.message(F.web_app_data)
async def handle_webapp_data(message: Message):
    """Обработка данных от Web App (результаты игр)"""
    try:
        data = json.loads(message.web_app_data.data)
        
        if data.get('type') == 'game_result':
            telegram_id = message.from_user.id
            game_type = data.get('game', 'rocket')
            stake = float(data.get('stake', 0))
            won = data.get('won', False)
            totalWinnings = float(data.get('winnings', 0))
            profit = data.get('profit', 0)
            multiplier = data.get('multiplier', 1.0)
            
            add_game(
                telegram_id=telegram_id,
                game_type=game_type,
                stake=stake,
                result='win' if won else 'lose',
                winnings=totalWinnings,
                multiplier=multiplier
            )
            
            if won:
                update_balance(telegram_id, profit)
            else:
                update_balance(telegram_id, -stake)
            
            logger.info(
                f"Игра: {game_type}, User: {telegram_id}, "
                f"Ставка: {stake}, Выигрыш: {totalWinnings}, Win: {won}"
            )
            
    except json.JSONDecodeError as e:
        logger.error(f"Ошибка парсинга данных от Web App: {e}")
    except Exception as e:
        logger.error(f"Ошибка обработки данных Web App: {e}")


# === Команда Казино ===

@dp.message(Command("casino"))
@dp.message(F.text == "🎰 Казино")
async def cmd_casino(message: Message):
    """
    Команда /casino - игра в казино
    Использование: /casino <ставка>
    """
    try:
        args = message.text.split()
        
        if len(args) < 2 and message.text == "🎰 Казино":
            await message.answer(
                "❌ <b>Казино</b>\n\n"
                "Использование: <code>/casino <ставка></code>\n"
                "Пример: <code>/casino 100</code>\n\n"
                "🎰 Множители:\n"
                "❌ x0, x0.25, x0.5, x0.75\n"
                "✅ x1, x1.25, x1.5, x2, x5, x10, x15, x100"
            )
            return
        
        if len(args) < 2:
            await message.answer("❌ Укажите ставку: /casino <сумма>")
            return

        stake = float(args[1])
        
        if stake <= 0:
            await message.answer("❌ Ставка должна быть больше 0")
            return

        balance = get_user_balance(message.from_user.id)
        
        if stake > balance:
            await message.answer(f"❌ Недостаточно средств. Ваш баланс: ${balance:,.2f}")
            return

        # Множители с весами
        multipliers = [
            (0, 0.25),
            (0.25, 0.15),
            (0.5, 0.15),
            (0.75, 0.10),
            (1, 0.10),
            (1.25, 0.08),
            (1.5, 0.07),
            (2, 0.05),
            (5, 0.03),
            (10, 0.015),
            (15, 0.005),
            (100, 0.0005)
        ]
        
        total_weight = sum(w for _, w in multipliers)
        rand = random.uniform(0, total_weight)
        
        cumulative = 0
        multiplier = 0
        for mult, weight in multipliers:
            cumulative += weight
            if rand <= cumulative:
                multiplier = mult
                break

        winnings = stake * multiplier
        profit = winnings - stake

        update_balance(message.from_user.id, -stake)
        
        if winnings > 0:
            update_balance(message.from_user.id, winnings)

        add_game(
            telegram_id=message.from_user.id,
            game_type='casino',
            stake=stake,
            result='win' if profit > 0 else 'lose',
            winnings=winnings,
            multiplier=multiplier
        )

        if multiplier >= 2:
            emoji = "🎉"
        elif multiplier >= 1:
            emoji = "😐"
        else:
            emoji = "💀"

        result_text = (
            f"🎰 <b>Казино</b>\n\n"
            f"{emoji} Множитель: <b>x{multiplier}</b>\n\n"
            f"Ставка: ${stake:,.2f}\n"
            f"Выигрыш: ${winnings:,.2f}\n"
            f"{'✅' if profit >= 0 else '❌'} Профит: <b>${profit:,.2f}</b>"
        )

        await message.answer(result_text)

    except ValueError:
        await message.answer("❌ Неверный формат ставки. Используйте число.")
    except Exception as e:
        logger.error(f"Ошибка в казино: {e}")
        await message.answer("❌ Произошла ошибка. Попробуйте позже.")


# === Админ команды ===

@dp.message(Command("admin"))
async def cmd_admin(message: Message):
    """Админ панель"""
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("❌ У вас нет прав администратора.")
        return

    await message.answer(
        "🔧 <b>Панель администратора</b>",
        reply_markup=get_admin_keyboard()
    )


@dp.callback_query(F.data == "admin_users")
async def cb_admin_users(callback_query: CallbackQuery):
    """Показать всех пользователей"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    users = get_all_users()

    if not users:
        await callback_query.message.answer("👥 Пока нет пользователей.")
        return

    users_text = "👥 <b>Пользователи:</b>\n\n"
    for user in users:
        users_text += (
            f"🆔 <code>{user['telegram_id']}</code> | "
            f"{user['first_name']} | "
            f"${user['balance']:,.2f}\n"
        )

    await callback_query.message.answer(users_text)
    await callback_query.answer()


@dp.callback_query(F.data == "admin_stats")
async def cb_admin_stats(callback_query: CallbackQuery):
    """Общая статистика"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    users = get_all_users()
    recent_games = get_recent_games(10)

    total_balance = sum(u['balance'] for u in users)
    total_users = len(users)

    stats_text = (
        f"📈 <b>Общая статистика:</b>\n\n"
        f"👥 Пользователей: <b>{total_users}</b>\n"
        f"💰 Общий баланс: <b>${total_balance:,.2f}</b>\n\n"
        f"🎮 <b>Последние игры:</b>\n"
    )

    for game in recent_games:
        emoji = "✅" if game['result'] == 'win' else "❌"
        stats_text += (
            f"{emoji} {game.get('first_name', 'Unknown')} | "
            f"{game['game_type']} | "
            f"${game['stake']:.2f} → ${game['winnings']:.2f}\n"
        )

    await callback_query.message.answer(stats_text)
    await callback_query.answer()


@dp.callback_query(F.data == "admin_balance")
async def cb_admin_balance(callback_query: CallbackQuery):
    """Изменить баланс пользователя"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    await callback_query.message.answer(
        "💵 <b>Изменение баланса</b>\n\n"
        "Используйте команду:\n"
        "<code>/setbalance &lt;user_id&gt; &lt;amount&gt;</code>\n\n"
        "Пример: <code>/setbalance 123456789 50000</code>"
    )
    await callback_query.answer()


@dp.message(Command("setbalance"))
async def cmd_setbalance(message: Message):
    """Установить баланс пользователю (админ)"""
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("❌ У вас нет прав администратора.")
        return

    try:
        args = message.text.split()
        if len(args) != 3:
            await message.answer("❌ Использование: /setbalance <user_id> <amount>")
            return

        user_id = int(args[1])
        amount = float(args[2])

        new_balance = set_balance(user_id, amount)
        await message.answer(f"✅ Баланс пользователя {user_id} установлен на ${new_balance:,.2f}")

    except (ValueError, IndexError):
        await message.answer("❌ Ошибка. Используйте: /setbalance <user_id> <amount>")


# === Запуск бота ===

async def on_startup():
    """При запуске бота"""
    logger.info("✅ Бот запущен!")
    logger.info(f"💾 База данных: {DB_PATH}")
    
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(
            text="🎮 Играть",
            web_app=WebAppInfo(url=WEB_APP_URL)
        )
    )


async def on_shutdown():
    """При остановке бота"""
    logger.info("👋 Бот остановлен!")


if __name__ == "__main__":
    dp.startup.register(on_startup)
    dp.shutdown.register(on_shutdown)
    try:
        dp.run_polling(bot)
    except KeyboardInterrupt:
        logger.info("Бот остановлен пользователем")
