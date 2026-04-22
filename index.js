const express = require('express');
const fs = require('fs');
const { transcribeAudio, readDocument } = require('./order-intelligence');
const { syncWhatsAppOrders } = require('./whatsapp-order-sync');
const { readTasks, createTaskFromText, syncExistingTaskToMonday, getMondayBoard } = require('./task-intelligence');
const { syncMessageTasks } = require('./message-task-sync');
const { getStatus: getKimiLaneStatus, readConfig: readKimiLaneConfig, writeConfig: writeKimiLaneConfig, askWebsiteCoder } = require('./kimi-coder');
const app = express();

app.use(express.json({ limit: '1mb' }));

const messagesFile = '/root/mysite/messages.json';
const tasksFile = '/root/mysite/tasks.json';
const ordersFile = '/root/mysite/orders.json';
const siteConfigFile = '/root/mysite/site-config.json';

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8') || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeJsonArray(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readSiteConfig() {
  try {
    if (!fs.existsSync(siteConfigFile)) {
      return {
        title: 'Personal AI Dashboard',
        subtitle: 'האתר שלי מנוהל דרך טלגרם',
        bg: '#f5f5f5',
        text: '#333333',
        sections: [],
        pages: {}
      };
    }
    return JSON.parse(fs.readFileSync(siteConfigFile, 'utf8'));
  } catch {
    return {
      title: 'Personal AI Dashboard',
      subtitle: 'האתר שלי מנוהל דרך טלגרם',
      bg: '#f5f5f5',
      text: '#333333',
      sections: [],
      pages: {}
    };
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

function extractNamedField(text, patterns, fallback = '') {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return fallback;
}

function detectPaymentStatus(text) {
  const value = String(text || '').toLowerCase();
  if (/paid|payment received|שולם|שולמה/.test(value)) return 'paid';
  if (/not paid|unpaid|לא שולם/.test(value)) return 'unpaid';
  if (/pending payment|awaiting payment|ממתין לתשלום|טרם שולם/.test(value)) return 'pending';
  return 'unknown';
}

function detectStage(text) {
  const value = String(text || '').toLowerCase();
  if (/delivered|completed|נמסר|הושלם/.test(value)) return 'completed';
  if (/shipped|on the way|בדרך|נשלח/.test(value)) return 'shipping';
  if (/production|in progress|בטיפול|בביצוע|בייצור/.test(value)) return 'in-progress';
  if (/approved|confirmed|אושר|אושרה/.test(value)) return 'confirmed';
  return 'new';
}

function extractAmount(text) {
  const match = String(text || '').match(/(?:amount|total|sum|סה["׳']?כ|מחיר)\s*[:\-]?\s*([₪$€]?\s?\d+(?:[.,]\d{1,2})?)/i)
    || String(text || '').match(/([₪$€]\s?\d+(?:[.,]\d{1,2})?)/);
  return match?.[1]?.trim() || '';
}

function inferNextStep(stage, paymentStatus) {
  if (paymentStatus === 'unpaid' || paymentStatus === 'pending') return 'Collect payment';
  if (stage === 'new') return 'Confirm the order details';
  if (stage === 'confirmed') return 'Send the order to execution';
  if (stage === 'in-progress') return 'Follow up with supplier or customer';
  if (stage === 'shipping') return 'Track delivery and confirm arrival';
  return 'Close the order or follow up with the customer';
}

function summarizeStanding(order) {
  return `Order ${order.order_id} for ${order.customer_name || 'unknown customer'} is currently at stage "${order.current_stage || 'unknown'}". Payment status: ${order.payment_status || 'unknown'}. Next step: ${order.next_step || 'not set'}.`;
}

function nextOrderId(orders) {
  let maxNumber = 1000;
  for (const order of orders) {
    const match = String(order.order_id || '').match(/^ORDER-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return `ORDER-${maxNumber + 1}`;
}

function ensureOrderIds(orders) {
  let changed = false;
  let maxNumber = 1000;

  for (const order of orders) {
    const match = String(order.order_id || '').match(/^ORDER-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }

  for (const order of orders) {
    if (!order.order_id) {
      maxNumber += 1;
      order.order_id = `ORDER-${maxNumber}`;
      changed = true;
    }
  }

  return { orders, changed };
}

function readOrders() {
  const rawOrders = readJsonArray(ordersFile);
  const { orders, changed } = ensureOrderIds(rawOrders);
  if (changed) writeJsonArray(ordersFile, orders);
  return orders;
}

function extractOrderDataFromConversation(conversation, overrides = {}) {
  const text = String(conversation || '').trim();
  const isUpdate = overrides.__mode === 'update';
  const phoneMatch = text.match(/\+\d{7,15}/);
  const detectedPaymentStatus = detectPaymentStatus(text);
  const detectedStage = detectStage(text);
  const paymentStatus = overrides.payment_status || overrides.paymentStatus || (isUpdate && detectedPaymentStatus === 'unknown' ? '' : detectedPaymentStatus);
  const currentStage = overrides.current_stage || overrides.currentStage || (isUpdate && detectedStage === 'new' ? '' : detectedStage);

  const data = {
    customer_name: overrides.customer_name || overrides.customerName || extractNamedField(text, [
      /customer(?: name)?\s*[:\-]\s*(.+)/i,
      /לקוח(?:ה)?\s*[:\-]\s*(.+)/i,
      /שם לקוח\s*[:\-]\s*(.+)/i
    ], isUpdate ? '' : 'Unknown customer'),
    supplier_name: overrides.supplier_name || overrides.supplierName || extractNamedField(text, [
      /supplier(?: name)?\s*[:\-]\s*(.+)/i,
      /ספק\s*[:\-]\s*(.+)/i,
      /שם ספק\s*[:\-]\s*(.+)/i
    ], ''),
    whatsapp_number: overrides.whatsapp_number || overrides.whatsappNumber || extractNamedField(text, [
      /whatsapp(?: number)?\s*[:\-]\s*(.+)/i,
      /phone(?: number)?\s*[:\-]\s*(.+)/i,
      /טלפון\s*[:\-]\s*(.+)/i
    ], phoneMatch?.[0] || ''),
    order_summary: overrides.order_summary || overrides.orderSummary || extractNamedField(text, [
      /order(?: summary)?\s*[:\-]\s*(.+)/i,
      /summary\s*[:\-]\s*(.+)/i,
      /פרטי הזמנה\s*[:\-]\s*(.+)/i
    ], isUpdate ? '' : (text.slice(0, 160) || 'New order conversation')),
    amount: overrides.amount || extractAmount(text),
    payment_status: paymentStatus,
    current_stage: currentStage,
    next_step: overrides.next_step || overrides.nextStep || extractNamedField(text, [
      /next step\s*[:\-]\s*(.+)/i,
      /השלב הבא\s*[:\-]\s*(.+)/i,
      /next action\s*[:\-]\s*(.+)/i
    ], isUpdate ? '' : inferNextStep(currentStage, paymentStatus)),
    source: overrides.source || 'conversation'
  };

  if (isUpdate) {
    Object.keys(data).forEach(key => {
      if (data[key] === '') delete data[key];
    });
  }

  return data;
}

function normalizeOrderRecord(input = {}, base = {}, allOrders = []) {
  const customerName = input.customer_name ?? input.customerName ?? base.customer_name ?? '';
  const supplierName = input.supplier_name ?? input.supplierName ?? base.supplier_name ?? '';
  const whatsappNumber = normalizePhone(input.whatsapp_number ?? input.whatsappNumber ?? base.whatsapp_number ?? '');
  const orderSummary = input.order_summary ?? input.orderSummary ?? base.order_summary ?? '';
  const amount = input.amount ?? base.amount ?? '';
  const paymentStatus = input.payment_status ?? input.paymentStatus ?? base.payment_status ?? 'unknown';
  const currentStage = input.current_stage ?? input.currentStage ?? base.current_stage ?? 'new';
  const nextStep = input.next_step ?? input.nextStep ?? base.next_step ?? inferNextStep(currentStage, paymentStatus);
  const orderId = input.order_id ?? input.orderId ?? base.order_id ?? nextOrderId(allOrders);
  const lastCustomerMessage = input.last_customer_message ?? input.lastCustomerMessage ?? base.last_customer_message ?? '';
  const latestSourcePath = input.latest_source_path ?? input.latestSourcePath ?? base.latest_source_path ?? '';
  const activityLog = Array.isArray(base.activity_log) ? [...base.activity_log] : [];

  if (input.activity_entry && typeof input.activity_entry === 'object') {
    activityLog.unshift({
      timestamp: input.activity_entry.timestamp || new Date().toISOString(),
      media_type: input.activity_entry.media_type || '',
      source_path: input.activity_entry.source_path || '',
      body: input.activity_entry.body || ''
    });
  }

  const dedupedActivityLog = [];
  const seenActivity = new Set();
  for (const entry of activityLog) {
    const key = JSON.stringify([
      entry.timestamp || '',
      entry.media_type || '',
      entry.source_path || '',
      entry.body || ''
    ]);
    if (seenActivity.has(key)) continue;
    seenActivity.add(key);
    dedupedActivityLog.push(entry);
  }

  const record = {
    order_id: orderId,
    customer_name: customerName || 'Unknown customer',
    supplier_name: supplierName,
    whatsapp_number: whatsappNumber,
    order_summary: orderSummary || 'New order',
    amount,
    payment_status: paymentStatus,
    current_stage: currentStage,
    next_step: nextStep,
    last_customer_message: lastCustomerMessage,
    latest_source_path: latestSourcePath,
    activity_log: dedupedActivityLog.slice(0, 20),
    source: input.source ?? base.source ?? 'manual',
    created_at: base.created_at ?? input.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  record.standing_summary = summarizeStanding(record);
  return record;
}

function buildOrderFromConversation(conversation, overrides = {}, allOrders = []) {
  const data = extractOrderDataFromConversation(conversation, overrides);
  return normalizeOrderRecord(data, {}, allOrders);
}

function findMatchingOrders(orders, criteria = {}) {
  const customerName = String(criteria.customer_name || criteria.customerName || '').trim().toLowerCase();
  const whatsappNumber = normalizePhone(criteria.whatsapp_number || criteria.whatsappNumber || '');

  return orders.filter(order => {
    const customerMatch = customerName && String(order.customer_name || '').trim().toLowerCase() === customerName;
    const phoneMatch = whatsappNumber && normalizePhone(order.whatsapp_number) === whatsappNumber;
    return Boolean(customerMatch || phoneMatch);
  });
}

app.get('/', (req, res) => {
  const messages = readJsonArray(messagesFile);
  const tasks = readTasks(tasksFile);
  const orders = readOrders();
  const cfg = readSiteConfig();

  const sectionsHtml = (cfg.sections || []).map(sec => `
    <div class="box">
      <h2>${escapeHtml(sec.title)}</h2>
      <p>${escapeHtml(sec.content)}</p>
    </div>
  `).join('');

  const pagesLinks = cfg.pages && Object.keys(cfg.pages).length
    ? Object.keys(cfg.pages).map(slug => `<p><a href="/${slug}">/${slug}</a></p>`).join('')
    : '<p>No extra pages yet</p>';

  res.send(`
    <html>
      <head>
        <title>${escapeHtml(cfg.title || 'Personal AI Dashboard')}</title>
        <style>
          body { font-family: Arial; padding: 20px; background:${cfg.bg || '#f5f5f5'}; color:${cfg.text || '#333333'}; }
          h1 { color:${cfg.text || '#333333'}; }
          .box { background:white; padding:15px; margin:10px 0; border-radius:8px; }
          a { color:#0b57d0; text-decoration:none; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(cfg.title || 'Personal AI Dashboard')}</h1>
        <p>${escapeHtml(cfg.subtitle || '')}</p>

        ${sectionsHtml || '<p>No sections yet</p>'}

        <div class="box">
          <h2>📦 Orders</h2>
          <p>Total: ${orders.length}</p>
          <p><a href="/orders">Open orders</a></p>
        </div>

        <div class="box">
          <h2>📩 Messages</h2>
          <p>Total: ${messages.length}</p>
          <p><a href="/messages">Open messages</a></p>
        </div>

        <div class="box">
          <h2>✅ Tasks</h2>
          <p>Total: ${tasks.length}</p>
          <p><a href="/tasks">Open tasks</a></p>
        </div>

        <div class="box">
          <h2>📄 Extra Pages</h2>
          ${pagesLinks}
        </div>
      </body>
    </html>
  `);
});

app.get('/messages', (req, res) => {
  const messages = readJsonArray(messagesFile);
  const list = messages.map(m => {
    const value = typeof m === 'string' ? m : (m.text || JSON.stringify(m));
    return `<li>${escapeHtml(value)}</li>`;
  }).join('');

  res.send(`
    <html><body>
      <h1>Messages</h1>
      <ul>${list || '<li>No messages yet</li>'}</ul>
      <p><a href="/">Back</a></p>
    </body></html>
  `);
});

app.get('/tasks', (req, res) => {
  const tasks = readTasks(tasksFile);
  const list = tasks.map(t => {
    if (typeof t === 'string') return `<li>${escapeHtml(t)}</li>`;
    return `<li><strong>${escapeHtml(t.id || '-')}</strong> - <strong>${escapeHtml(t.title || 'Untitled task')}</strong> - ${escapeHtml(t.status || 'open')} - ${escapeHtml(t.priority || 'normal')}${t.monday_item_id ? ` - Monday ${escapeHtml(t.monday_item_id)}` : ''}</li>`;
  }).join('');

  res.send(`
    <html><body>
      <h1>Tasks</h1>
      <ul>${list || '<li>No tasks yet</li>'}</ul>
      <p><a href="/">Back</a></p>
    </body></html>
  `);
});

app.get('/orders', (req, res) => {
  const orders = readOrders();

  const list = orders.map((o, i) => `
    <div style="border:1px solid #ddd;padding:12px;margin:10px 0;border-radius:8px;">
      <h3>#${i + 1} - ${escapeHtml(o.order_id || '-')} - ${escapeHtml(o.customer_name || 'Unknown customer')}</h3>
      <p><strong>WhatsApp:</strong> ${escapeHtml(o.whatsapp_number || '-')}</p>
      <p><strong>Supplier:</strong> ${escapeHtml(o.supplier_name || '-')}</p>
      <p><strong>Summary:</strong> ${escapeHtml(o.order_summary || '-')}</p>
      <p><strong>Amount:</strong> ${escapeHtml(o.amount || '-')}</p>
      <p><strong>Payment:</strong> ${escapeHtml(o.payment_status || '-')}</p>
      <p><strong>Stage:</strong> ${escapeHtml(o.current_stage || '-')}</p>
      <p><strong>Next step:</strong> ${escapeHtml(o.next_step || '-')}</p>
      <p><strong>Standing:</strong> ${escapeHtml(o.standing_summary || '-')}</p>
      <p><strong>Source:</strong> ${escapeHtml(o.source || '-')}</p>
      <p><strong>Last customer message:</strong> ${escapeHtml(o.last_customer_message || '-')}</p>
      <p><strong>Updated:</strong> ${escapeHtml(o.updated_at || '-')}</p>
    </div>
  `).join('');

  res.send(`
    <html><body>
      <h1>Orders</h1>
      ${list || '<p>No orders yet</p>'}
      <p><a href="/">Back</a></p>
    </body></html>
  `);
});

app.get('/api/orders', (req, res) => {
  res.json(readOrders());
});

app.get('/api/tasks', (req, res) => {
  res.json(readTasks(tasksFile));
});

app.get('/api/monday/status', async (req, res) => {
  try {
    const status = await getMondayBoard();
    res.json(status);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' && req.body.text.trim()
      ? req.body.text
      : [req.body?.title || '', req.body?.description || ''].filter(Boolean).join('\n');

    if (!String(text || '').trim()) {
      res.status(400).json({ ok: false, error: 'text or title is required' });
      return;
    }

    const result = await createTaskFromText(tasksFile, text, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks/from-text', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) {
      res.status(400).json({ ok: false, error: 'text is required' });
      return;
    }

    const result = await createTaskFromText(tasksFile, text, req.body || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks/:taskId/sync-monday', async (req, res) => {
  try {
    const result = await syncExistingTaskToMonday(tasksFile, req.params.taskId);
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tasks/sync-messages', async (req, res) => {
  try {
    const result = await syncMessageTasks({
      tasksFile,
      backfill: Boolean(req.body?.backfill)
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/website-coder/status', (req, res) => {
  res.json(getKimiLaneStatus());
});

app.get('/api/website-coder/config', (req, res) => {
  res.json({ ok: true, config: readKimiLaneConfig() });
});

app.post('/api/website-coder/config', (req, res) => {
  const next = writeKimiLaneConfig({
    enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
    provider: typeof req.body?.provider === 'string' ? req.body.provider : undefined,
    model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    baseUrl: typeof req.body?.baseUrl === 'string' ? req.body.baseUrl : undefined,
    defaultMode: typeof req.body?.defaultMode === 'string' ? req.body.defaultMode : undefined,
    defaultLanguage: typeof req.body?.defaultLanguage === 'string' ? req.body.defaultLanguage : undefined,
    defaultStack: typeof req.body?.defaultStack === 'string' ? req.body.defaultStack : undefined
  });
  res.json({ ok: true, config: next });
});

app.post('/api/website-coder/ask', async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) {
      res.status(400).json({ ok: false, error: 'prompt is required' });
      return;
    }

    const result = await askWebsiteCoder({
      prompt,
      mode: typeof req.body?.mode === 'string' ? req.body.mode : undefined,
      language: typeof req.body?.language === 'string' ? req.body.language : undefined,
      stack: typeof req.body?.stack === 'string' ? req.body.stack : undefined
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, status: getKimiLaneStatus() });
  }
});

app.post('/api/tools/transcribe-audio', async (req, res) => {
  try {
    const filePath = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
    if (!filePath) {
      res.status(400).json({ ok: false, error: 'file is required' });
      return;
    }

    const result = await transcribeAudio(filePath, {
      language: typeof req.body?.language === 'string' ? req.body.language : 'he'
    });

    res.json({ ok: true, file: filePath, text: result.text, kind: result.kind, raw: result.raw });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/tools/read-document', async (req, res) => {
  try {
    const filePath = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
    if (!filePath) {
      res.status(400).json({ ok: false, error: 'file is required' });
      return;
    }

    const result = await readDocument(filePath, {
      mediaType: typeof req.body?.mediaType === 'string' ? req.body.mediaType : '',
      language: typeof req.body?.language === 'string' ? req.body.language : 'he'
    });

    res.json({ ok: true, file: filePath, text: result.text, kind: result.kind, raw: result.raw });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/orders', (req, res) => {
  const orders = readOrders();
  const record = normalizeOrderRecord(req.body || {}, {}, orders);
  orders.unshift(record);
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: record.order_id, order: record, total: orders.length });
});

app.post('/api/orders/from-conversation', (req, res) => {
  const conversation = typeof req.body?.conversation === 'string' ? req.body.conversation : '';
  if (!conversation.trim()) {
    res.status(400).json({ ok: false, error: 'conversation is required' });
    return;
  }

  const orders = readOrders();
  const record = buildOrderFromConversation(conversation, req.body || {}, orders);
  orders.unshift(record);
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: record.order_id, order: record, total: orders.length });
});

app.patch('/api/orders/:orderId', (req, res) => {
  const orders = readOrders();
  const index = orders.findIndex(order => order.order_id === req.params.orderId);

  if (index === -1) {
    res.status(404).json({ ok: false, error: 'order not found' });
    return;
  }

  const updated = normalizeOrderRecord(req.body || {}, orders[index], orders);
  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: updated.order_id, order: updated });
});

app.post('/api/orders/:orderId/summarize', (req, res) => {
  const orders = readOrders();
  const index = orders.findIndex(order => order.order_id === req.params.orderId);

  if (index === -1) {
    res.status(404).json({ ok: false, error: 'order not found' });
    return;
  }

  const updated = normalizeOrderRecord(req.body || {}, orders[index], orders);
  updated.standing_summary = summarizeStanding(updated);
  updated.updated_at = new Date().toISOString();
  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: updated.order_id, summary: updated.standing_summary, order: updated });
});

app.post('/api/orders/update-match', (req, res) => {
  const orders = readOrders();
  const matches = findMatchingOrders(orders, req.body || {});

  if (matches.length === 0) {
    res.status(404).json({ ok: false, error: 'no matching order found' });
    return;
  }

  if (matches.length > 1) {
    res.status(409).json({
      ok: false,
      error: 'multiple orders found, clarification required',
      matches: matches.map(order => ({
        order_id: order.order_id,
        customer_name: order.customer_name,
        whatsapp_number: order.whatsapp_number,
        current_stage: order.current_stage
      }))
    });
    return;
  }

  const match = matches[0];
  const index = orders.findIndex(order => order.order_id === match.order_id);
  const conversation = typeof req.body?.conversation === 'string' ? req.body.conversation : '';
  const updateData = conversation.trim()
    ? {
        last_customer_message: req.body?.last_customer_message,
        latest_source_path: req.body?.latest_source_path,
        activity_entry: req.body?.activity_entry,
        ...extractOrderDataFromConversation(conversation, { ...(req.body || {}), __mode: 'update' })
      }
    : (req.body || {});
  const updated = normalizeOrderRecord(updateData, orders[index], orders);

  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order_id: updated.order_id, order: updated });
});

app.post('/api/orders/sync-whatsapp', async (req, res) => {
  try {
    const result = await syncWhatsAppOrders({ port: Number(process.env.PORT || 3000) });
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const cfg = readSiteConfig();
Object.entries(cfg.pages || {}).forEach(([slug, page]) => {
  app.get('/' + slug, (req, res) => {
    res.send(`
      <html><body>
        <h1>${escapeHtml(page.title || slug)}</h1>
        <p>${escapeHtml(page.content || '')}</p>
        <p><a href="/">Back</a></p>
      </body></html>
    `);
  });
});

const port = Number(process.env.PORT || 3000);
let backgroundOrderSyncRunning = false;
let backgroundTaskSyncRunning = false;

async function runBackgroundOrderSync() {
  if (backgroundOrderSyncRunning) return;
  backgroundOrderSyncRunning = true;
  try {
    await syncWhatsAppOrders({ port });
  } catch (error) {
    console.error('WhatsApp order sync failed:', error.message);
  } finally {
    backgroundOrderSyncRunning = false;
  }
}

async function runBackgroundTaskSync() {
  if (backgroundTaskSyncRunning) return;
  backgroundTaskSyncRunning = true;
  try {
    await syncMessageTasks({ tasksFile });
  } catch (error) {
    console.error('Message task sync failed:', error.message);
  } finally {
    backgroundTaskSyncRunning = false;
  }
}

app.listen(port, () => {
  console.log(`Dashboard running on port ${port}`);
  setTimeout(runBackgroundOrderSync, 5000);
  setTimeout(runBackgroundTaskSync, 7000);
  setInterval(runBackgroundOrderSync, 45000);
  setInterval(runBackgroundTaskSync, 30000);
});
