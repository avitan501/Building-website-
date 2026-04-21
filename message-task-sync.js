const fs = require('fs');
const path = require('path');
const { createTaskFromText } = require('./task-intelligence');

const LOG_DIR = '/tmp/openclaw';
const TODAY_LOG = path.join(LOG_DIR, `openclaw-${new Date().toISOString().slice(0, 10)}.log`);
const SESSIONS_DIR = '/root/.openclaw/agents/main/sessions';
const STATE_FILE = '/root/mysite/data/message_task_sync_state.json';

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function loadState() {
  ensureStateDir();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { logOffsets: {}, sessionOffsets: {} };
  }
}

function saveState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readChunk(filePath, previousOffset) {
  if (!fs.existsSync(filePath)) return { content: '', nextOffset: 0 };
  const stats = fs.statSync(filePath);
  const safeOffset = Math.min(Number(previousOffset || 0), stats.size);
  const buffer = fs.readFileSync(filePath);
  return {
    content: buffer.slice(safeOffset).toString('utf8'),
    nextOffset: stats.size
  };
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanupSourceText(value) {
  return normalizeText(String(value || '')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/^Conversation info \(untrusted metadata\):[\s\S]*?```\s*/i, '')
    .replace(/^Sender \(untrusted metadata\):[\s\S]*?```\s*/i, '')
    .replace(/```/g, ''));
}

function looksLikeTask(text, source = 'generic') {
  const value = normalizeText(text).toLowerCase();
  if (!value) return false;
  if (value.length < 4) return false;

  const negativePhrases = [
    'חח', 'חחח', 'lol', 'ok', 'okay', 'correct?', 'crazy ai', 'is it ai?', 'no problem', 'thats crazy', "that's crazy"
  ];
  if (negativePhrases.some(phrase => value === phrase || value.startsWith(`${phrase}\n`))) return false;

  const explicitTaskSignals = [
    'task:', 'todo', 'need to', 'צריך', 'חייב', 'לבדוק', 'לחזור', 'להתקשר', 'לשלוח', 'להכין', 'לעדכן', 'לסגור', 'follow up', 'call ', 'send ', 'check ', 'fix ', 'build '
  ];
  if (explicitTaskSignals.some(signal => value.includes(signal))) return true;

  const customerActionSignals = [
    'תשלום', 'payment', 'invoice', 'bill', 'how much', 'price', 'quote', 'wire', 'owe money', 'where are', 'problem', 'issue', 'order', 'הזמנה', 'מחיר', 'בעיה', 'לחזור', 'מעקב', 'deliver', 'shipment', 'supplier', 'client', 'customer'
  ];

  if (source === 'whatsapp' && customerActionSignals.some(signal => value.includes(signal))) return true;
  if (source === 'telegram' && customerActionSignals.some(signal => value.includes(signal))) return true;

  return false;
}

function buildTaskText(entry) {
  const header = entry.source === 'whatsapp'
    ? `[WhatsApp ${entry.from} ${new Date(entry.timestamp).toISOString()}]`
    : `[Telegram ${entry.chatId || entry.sessionFile || 'direct'} ${entry.timestamp || new Date().toISOString()}]`;
  return normalizeText(`${header}\n${entry.body}`);
}

function buildTaskOverrides(entry) {
  const cleanBody = cleanupSourceText(entry.body);
  return {
    source: entry.source,
    title: cleanBody.slice(0, 120),
    description: cleanBody,
    source_text: buildTaskText(entry)
  };
}

function parseWhatsAppLine(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed?.['2'] !== 'inbound web message') return null;
    const moduleInfo = JSON.parse(parsed?.['0'] || '{}');
    if (moduleInfo.module !== 'web-auto-reply') return null;
    const payload = parsed?.['1'];
    if (!payload?.from || !payload?.body) return null;
    return {
      source: 'whatsapp',
      from: payload.from,
      body: payload.body,
      mediaType: payload.mediaType || '',
      mediaPath: payload.mediaPath || '',
      timestamp: parsed?.time || parsed?._meta?.date || new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function parseTelegramSessionLine(line, sessionFile) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    if (parsed.type !== 'message') return null;
    const message = parsed.message;
    if (message?.role !== 'user') return null;
    const textPart = Array.isArray(message.content) ? message.content.find(part => part.type === 'text') : null;
    const text = textPart?.text || '';
    if (!text.includes('chat_id": "telegram:')) return null;
    const cleanBody = cleanupSourceText(text);
    if (!cleanBody) return null;
    const chatIdMatch = text.match(/"chat_id":\s*"([^"]+)"/);
    return {
      source: 'telegram',
      sessionFile,
      chatId: chatIdMatch?.[1] || '',
      body: cleanBody,
      timestamp: parsed.timestamp || message.timestamp || new Date().toISOString()
    };
  } catch {
    return null;
  }
}

async function syncMessageTasks({ tasksFile, logFile = TODAY_LOG, backfill = false } = {}) {
  if (!tasksFile) throw new Error('tasksFile is required');

  const state = loadState();
  const summary = {
    ok: true,
    primed: false,
    whatsapp_seen: 0,
    telegram_seen: 0,
    created: 0,
    deduped: 0,
    skipped: 0,
    errors: []
  };

  const firstRun = !state.updated_at;

  if (firstRun && !backfill) {
    state.logOffsets = state.logOffsets || {};
    if (fs.existsSync(logFile)) state.logOffsets[logFile] = fs.statSync(logFile).size;
    const sessionFiles = fs.existsSync(SESSIONS_DIR)
      ? fs.readdirSync(SESSIONS_DIR).filter(name => name.endsWith('.jsonl')).map(name => path.join(SESSIONS_DIR, name))
      : [];
    state.sessionOffsets = state.sessionOffsets || {};
    for (const sessionFile of sessionFiles) {
      state.sessionOffsets[sessionFile] = fs.statSync(sessionFile).size;
    }
    state.updated_at = new Date().toISOString();
    saveState(state);
    summary.primed = true;
    return summary;
  }

  const logChunk = readChunk(logFile, state.logOffsets?.[logFile]);
  const logLines = logChunk.content.split(/\n/).filter(Boolean);
  for (const line of logLines) {
    const entry = parseWhatsAppLine(line);
    if (!entry) continue;
    summary.whatsapp_seen += 1;
    const cleanBody = cleanupSourceText(entry.body);
    if (!looksLikeTask(cleanBody, 'whatsapp')) {
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await createTaskFromText(tasksFile, cleanBody, buildTaskOverrides(entry));
      if (result.deduped) summary.deduped += 1;
      else summary.created += 1;
    } catch (error) {
      summary.errors.push({ source: 'whatsapp', error: error.message, body: cleanBody.slice(0, 120) });
    }
  }
  state.logOffsets = state.logOffsets || {};
  state.logOffsets[logFile] = logChunk.nextOffset;

  const sessionFiles = fs.existsSync(SESSIONS_DIR)
    ? fs.readdirSync(SESSIONS_DIR).filter(name => name.endsWith('.jsonl')).map(name => path.join(SESSIONS_DIR, name))
    : [];

  state.sessionOffsets = state.sessionOffsets || {};
  for (const sessionFile of sessionFiles) {
    const chunk = readChunk(sessionFile, state.sessionOffsets[sessionFile]);
    const lines = chunk.content.split(/\n/).filter(Boolean);
    for (const line of lines) {
      const entry = parseTelegramSessionLine(line, sessionFile);
      if (!entry) continue;
      summary.telegram_seen += 1;
      if (!looksLikeTask(entry.body, 'telegram')) {
        summary.skipped += 1;
        continue;
      }
      try {
        const result = await createTaskFromText(tasksFile, entry.body, buildTaskOverrides(entry));
        if (result.deduped) summary.deduped += 1;
        else summary.created += 1;
      } catch (error) {
        summary.errors.push({ source: 'telegram', error: error.message, body: entry.body.slice(0, 120) });
      }
    }
    state.sessionOffsets[sessionFile] = chunk.nextOffset;
  }

  state.updated_at = new Date().toISOString();
  saveState(state);
  summary.ok = summary.errors.length === 0;
  return summary;
}

module.exports = {
  syncMessageTasks,
  STATE_FILE
};
