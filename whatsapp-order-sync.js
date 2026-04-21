const fs = require('fs');
const path = require('path');
const { readDocument, normalizeExtractedText } = require('./order-intelligence');

const LOG_DIR = '/tmp/openclaw';
const DEFAULT_LOG_FILE = path.join(LOG_DIR, `openclaw-${new Date().toISOString().slice(0, 10)}.log`);
const STATE_FILE = '/root/mysite/data/order_sync_state.json';
const DEFAULT_PORT = Number(process.env.PORT || 3000);

function ensureStateDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function loadState() {
  ensureStateDir();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { offsets: {} };
  }
}

function saveState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function readNewLogChunk(logFile, state) {
  if (!fs.existsSync(logFile)) {
    return { chunk: '', nextOffset: 0 };
  }

  const stats = fs.statSync(logFile);
  const previousOffset = Math.min(Number(state.offsets?.[logFile] || 0), stats.size);
  const chunk = fs.readFileSync(logFile, 'utf8').slice(previousOffset);
  return {
    chunk,
    nextOffset: stats.size
  };
}

function parseInboundEntry(line) {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    const payload = parsed?.['1'];
    const label = parsed?.['2'];
    if (!payload || label !== 'inbound message') return null;
    if (!payload.from) return null;
    return {
      from: String(payload.from || '').trim(),
      body: String(payload.body || '').trim(),
      timestamp: payload.timestamp || parsed?._meta?.date || new Date().toISOString(),
      mediaPath: payload.mediaPath || '',
      mediaType: payload.mediaType || '',
      raw: payload
    };
  } catch {
    return null;
  }
}

async function extractConversationText(entry) {
  const mediaPath = String(entry.mediaPath || '').trim();
  const mediaType = String(entry.mediaType || '').trim();
  const body = normalizeExtractedText(entry.body || '');

  if (mediaPath) {
    const extracted = await readDocument(mediaPath, { mediaType, language: 'he' });
    const prefix = mediaType ? `[${mediaType}]` : '[media]';
    const parts = [prefix];
    if (body && !/^<media:/i.test(body)) parts.push(body);
    if (extracted.text) parts.push(extracted.text);
    return normalizeExtractedText(parts.join('\n\n'));
  }

  if (!body || /^<media:/i.test(body)) return '';
  return body;
}

async function postUpdate(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/orders/update-match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  return {
    status: response.status,
    ok: response.ok,
    data
  };
}

async function syncWhatsAppOrders(options = {}) {
  const logFile = options.logFile || DEFAULT_LOG_FILE;
  const port = Number(options.port || DEFAULT_PORT);
  const state = loadState();
  const { chunk, nextOffset } = readNewLogChunk(logFile, state);
  const lines = chunk.split(/\n/).filter(Boolean);

  const summary = {
    ok: true,
    logFile,
    scanned_lines: lines.length,
    processed_messages: 0,
    updated_orders: 0,
    skipped_messages: 0,
    errors: []
  };

  for (const line of lines) {
    const entry = parseInboundEntry(line);
    if (!entry) continue;

    summary.processed_messages += 1;

    try {
      const conversation = await extractConversationText(entry);
      if (!conversation) {
        summary.skipped_messages += 1;
        continue;
      }

      const updatePayload = {
        whatsapp_number: entry.from,
        conversation,
        source: 'whatsapp-auto-sync',
        last_customer_message: conversation,
        latest_source_path: entry.mediaPath || '',
        activity_entry: {
          timestamp: new Date(entry.timestamp || Date.now()).toISOString(),
          media_type: entry.mediaType || '',
          source_path: entry.mediaPath || '',
          body: entry.body || ''
        }
      };

      const result = await postUpdate(port, updatePayload);
      if (result.ok) {
        summary.updated_orders += 1;
      } else if (result.status === 404) {
        summary.skipped_messages += 1;
      } else {
        summary.errors.push({
          from: entry.from,
          status: result.status,
          error: result.data?.error || 'unknown error'
        });
      }
    } catch (error) {
      summary.errors.push({
        from: entry.from,
        error: error.message
      });
    }
  }

  state.offsets = state.offsets || {};
  state.offsets[logFile] = nextOffset;
  state.updated_at = new Date().toISOString();
  saveState(state);

  summary.ok = summary.errors.length === 0;
  return summary;
}

module.exports = {
  syncWhatsAppOrders,
  STATE_FILE
};

if (require.main === module) {
  syncWhatsAppOrders()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
      process.exit(1);
    });
}
