#!/usr/bin/env python3
import os
import re
import sys
import time
import logging

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
VENDOR_DIR = os.path.join(BASE_DIR, 'vendor')
if os.path.isdir(VENDOR_DIR) and VENDOR_DIR not in sys.path:
    sys.path.insert(0, VENDOR_DIR)


def load_env_file(path: str):
    if not os.path.exists(path):
        return
    with open(path, 'r', encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


load_env_file(os.path.join(BASE_DIR, '.env'))

import requests
import telebot

TELEGRAM_TOKEN = os.environ.get('TELEGRAM_TOKEN', '').strip()
OPENROUTER_KEY = os.environ.get('OPENROUTER_KEY', '').strip()
OPENROUTER_MODEL = os.environ.get('OPENROUTER_MODEL', 'moonshotai/kimi-k2.6').strip()
OPENROUTER_REFERER = os.environ.get('OPENROUTER_REFERER', 'https://t.me').strip() or 'https://t.me'
OPENROUTER_TITLE = os.environ.get('OPENROUTER_TITLE', 'Telegram Kimi Bot').strip() or 'Telegram Kimi Bot'
REQUEST_TIMEOUT = int(os.environ.get('REQUEST_TIMEOUT', '60'))
PRIMARY_HANDOFF_BOT = os.environ.get('PRIMARY_HANDOFF_BOT', '@Openclawnewwbot').strip() or '@Openclawnewwbot'
ALLOW_PRIVATE_CHATS = os.environ.get('ALLOW_PRIVATE_CHATS', 'false').strip().lower() in {'1', 'true', 'yes', 'on'}
GROUP_PREFIXES = ['kimi ', 'kimi:', '/kimi ', '/kimi:']
BOT_USERNAME_CACHE = None

if not TELEGRAM_TOKEN:
    raise SystemExit('Missing TELEGRAM_TOKEN')
if not OPENROUTER_KEY:
    raise SystemExit('Missing OPENROUTER_KEY')

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger('kimi-bot')

bot = telebot.TeleBot(TELEGRAM_TOKEN, parse_mode=None)

ROLE_SYSTEM_PROMPT = (
    'You are Kimi inside a shared Telegram group. '
    'Your lane is ideas, brainstorming, website direction, UX, layout, copy, planning, naming, messaging, and product thinking. '
    'Be concise, practical, and collaborative. '
    'Do not handle deployment, server work, code execution, tokens, secrets, routing, infrastructure changes, shell commands, or final sensitive actions. '
    f'If the request is mainly coding, deployment, infrastructure, credentials, or sensitive ops, say briefly that {PRIMARY_HANDOFF_BOT} should handle that part. '
    'When the request is in Hebrew, answer in Hebrew unless asked otherwise.'
)


def get_bot_username() -> str:
    global BOT_USERNAME_CACHE
    if BOT_USERNAME_CACHE:
        return BOT_USERNAME_CACHE
    me = bot.get_me()
    BOT_USERNAME_CACHE = f"@{getattr(me, 'username', '')}".strip()
    return BOT_USERNAME_CACHE


def safe_reply(message, text: str):
    try:
        return bot.reply_to(message, text)
    except Exception:
        logger.exception('reply_to failed, falling back to send_message')
        return bot.send_message(message.chat.id, text)


def normalize_group_text(text: str) -> str:
    clean = text.strip()
    bot_username = get_bot_username().lower()
    clean = re.sub(re.escape(bot_username), '', clean, flags=re.IGNORECASE).strip()
    for prefix in GROUP_PREFIXES:
        if clean.lower().startswith(prefix):
            clean = clean[len(prefix):].strip()
            break
    return clean.strip(' :-\n\t')


def should_answer(message):
    text = (message.text or '').strip()
    if not text:
        return False, ''

    chat_type = getattr(message.chat, 'type', '')
    if chat_type == 'private':
        return (ALLOW_PRIVATE_CHATS, text if ALLOW_PRIVATE_CHATS else '')
    if chat_type not in {'group', 'supergroup'}:
        return False, ''

    lower = text.lower()
    bot_username = get_bot_username().lower()
    if bot_username in lower:
        return True, normalize_group_text(text) or 'מה צריך ממני?'

    for prefix in GROUP_PREFIXES:
        if lower.startswith(prefix):
            return True, normalize_group_text(text)

    reply_to = getattr(message, 'reply_to_message', None)
    reply_user = getattr(reply_to, 'from_user', None) if reply_to else None
    if reply_user and getattr(reply_user, 'username', '').lower() == bot_username.lstrip('@'):
        return True, text

    return False, ''


def ask_kimi(text: str) -> str:
    response = requests.post(
        'https://openrouter.ai/api/v1/chat/completions',
        headers={
            'Authorization': f'Bearer {OPENROUTER_KEY}',
            'Content-Type': 'application/json',
            'HTTP-Referer': OPENROUTER_REFERER,
            'X-Title': OPENROUTER_TITLE,
        },
        json={
            'model': OPENROUTER_MODEL,
            'messages': [
                {'role': 'system', 'content': ROLE_SYSTEM_PROMPT},
                {'role': 'user', 'content': text},
            ],
        },
        timeout=REQUEST_TIMEOUT,
    )

    if response.status_code >= 400:
        body = response.text[:1000]
        raise RuntimeError(f'OpenRouter HTTP {response.status_code}: {body}')

    data = response.json()
    choices = data.get('choices') or []
    if not choices:
        raise RuntimeError(f'No choices in OpenRouter response: {data}')

    message = choices[0].get('message') or {}
    content = message.get('content')
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                parts.append(item.get('text', ''))
            elif isinstance(item, str):
                parts.append(item)
        content = ''.join(parts).strip()
    if not content:
        raise RuntimeError(f'Empty content in OpenRouter response: {data}')
    return str(content).strip()


@bot.message_handler(content_types=['text'])
def handle_text(message):
    should_respond, text = should_answer(message)
    if not should_respond:
        return

    try:
        if not text:
            safe_reply(message, 'תכתוב לי מה אתה רוצה שאחשוב עליו.')
            return

        try:
            bot.send_chat_action(message.chat.id, 'typing')
        except Exception:
            logger.exception('send_chat_action failed, continuing anyway')
        reply = ask_kimi(text)
        if len(reply) <= 4000:
            safe_reply(message, reply)
            return

        for i in range(0, len(reply), 4000):
            chunk = reply[i:i + 4000]
            if i == 0:
                safe_reply(message, chunk)
            else:
                bot.send_message(message.chat.id, chunk)
    except Exception as e:
        logger.exception('Failed handling message')
        msg = str(e)
        if 'HTTP 402' in msg or 'Insufficient credits' in msg:
            safe_reply(message, 'הבוט מחובר, אבל ל־OpenRouter אין כרגע credits פעילים עבור Kimi. ברגע שיהיה key/credits תקינים זה יעבוד.')
        else:
            safe_reply(message, f'שגיאה: {e}')


@bot.message_handler(func=lambda m: True, content_types=['photo', 'document', 'audio', 'video', 'voice', 'sticker', 'location', 'contact'])
def handle_other(message):
    should_respond, _ = should_answer(message)
    if should_respond:
        safe_reply(message, 'כרגע אני תומך רק בטקסט.')


def main():
    me = bot.get_me()
    logger.info('Starting Kimi bot as @%s (%s)', getattr(me, 'username', None), getattr(me, 'first_name', None))
    while True:
        try:
            bot.infinity_polling(timeout=30, long_polling_timeout=30, skip_pending=True)
        except KeyboardInterrupt:
            raise
        except Exception:
            logger.exception('Polling crashed, restarting in 3s')
            time.sleep(3)


if __name__ == '__main__':
    main()
