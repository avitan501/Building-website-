const express = require('express');
const fs = require('fs');
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

function makeOrderId() {
  return `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractNamedField(text, patterns, fallback = '') {
  for (const pattern of patterns) {
    const match = text.match(pattern);
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
  return `Order for ${order.customer_name || 'unknown customer'} is currently at stage "${order.current_stage || 'unknown'}". Payment status: ${order.payment_status || 'unknown'}. Next step: ${order.next_step || 'not set'}.`;
}

function normalizeOrderRecord(input = {}, base = {}) {
  const customerName = input.customer_name ?? input.customerName ?? base.customer_name ?? '';
  const supplierName = input.supplier_name ?? input.supplierName ?? base.supplier_name ?? '';
  const orderSummary = input.order_summary ?? input.orderSummary ?? base.order_summary ?? '';
  const amount = input.amount ?? base.amount ?? '';
  const paymentStatus = input.payment_status ?? input.paymentStatus ?? base.payment_status ?? 'unknown';
  const currentStage = input.current_stage ?? input.currentStage ?? base.current_stage ?? 'new';
  const nextStep = input.next_step ?? input.nextStep ?? base.next_step ?? inferNextStep(currentStage, paymentStatus);

  const record = {
    id: input.id ?? base.id ?? makeOrderId(),
    customer_name: customerName || 'Unknown customer',
    supplier_name: supplierName,
    order_summary: orderSummary || 'New order',
    amount,
    payment_status: paymentStatus,
    current_stage: currentStage,
    next_step: nextStep,
    source: input.source ?? base.source ?? 'manual',
    created_at: base.created_at ?? input.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  record.standing_summary = summarizeStanding(record);
  return record;
}

function buildOrderFromConversation(conversation, overrides = {}) {
  const text = String(conversation || '').trim();
  const customerName = overrides.customer_name || overrides.customerName || extractNamedField(text, [
    /customer(?: name)?\s*[:\-]\s*(.+)/i,
    /לקוח(?:ה)?\s*[:\-]\s*(.+)/i,
    /שם לקוח\s*[:\-]\s*(.+)/i
  ], 'Unknown customer');
  const supplierName = overrides.supplier_name || overrides.supplierName || extractNamedField(text, [
    /supplier(?: name)?\s*[:\-]\s*(.+)/i,
    /ספק\s*[:\-]\s*(.+)/i,
    /שם ספק\s*[:\-]\s*(.+)/i
  ], '');
  const orderSummary = overrides.order_summary || overrides.orderSummary || extractNamedField(text, [
    /order(?: summary)?\s*[:\-]\s*(.+)/i,
    /summary\s*[:\-]\s*(.+)/i,
    /פרטי הזמנה\s*[:\-]\s*(.+)/i
  ], text.slice(0, 160) || 'New order conversation');
  const amount = overrides.amount || extractAmount(text);
  const paymentStatus = overrides.payment_status || overrides.paymentStatus || detectPaymentStatus(text);
  const currentStage = overrides.current_stage || overrides.currentStage || detectStage(text);
  const nextStep = overrides.next_step || overrides.nextStep || extractNamedField(text, [
    /next step\s*[:\-]\s*(.+)/i,
    /השלב הבא\s*[:\-]\s*(.+)/i,
    /next action\s*[:\-]\s*(.+)/i
  ], inferNextStep(currentStage, paymentStatus));

  return normalizeOrderRecord({
    customer_name: customerName,
    supplier_name: supplierName,
    order_summary: orderSummary,
    amount,
    payment_status: paymentStatus,
    current_stage: currentStage,
    next_step: nextStep,
    source: 'conversation'
  });
}

app.get('/', (req, res) => {
  const messages = readJsonArray(messagesFile);
  const tasks = readJsonArray(tasksFile);
  const orders = readJsonArray(ordersFile);
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
  const tasks = readJsonArray(tasksFile);
  const list = tasks.map(t => {
    if (typeof t === 'string') return `<li>${escapeHtml(t)}</li>`;
    return `<li><strong>${escapeHtml(t.title || 'Untitled task')}</strong> - ${escapeHtml(t.status || 'open')}</li>`;
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
  const orders = readJsonArray(ordersFile);

  const list = orders.map((o, i) => `
    <div style="border:1px solid #ddd;padding:12px;margin:10px 0;border-radius:8px;">
      <h3>#${i + 1} - ${escapeHtml(o.customer_name || 'Unknown customer')}</h3>
      <p><strong>ID:</strong> ${escapeHtml(o.id || '-')}</p>
      <p><strong>Supplier:</strong> ${escapeHtml(o.supplier_name || '-')}</p>
      <p><strong>Summary:</strong> ${escapeHtml(o.order_summary || '-')}</p>
      <p><strong>Amount:</strong> ${escapeHtml(o.amount || '-')}</p>
      <p><strong>Payment:</strong> ${escapeHtml(o.payment_status || '-')}</p>
      <p><strong>Stage:</strong> ${escapeHtml(o.current_stage || '-')}</p>
      <p><strong>Next step:</strong> ${escapeHtml(o.next_step || '-')}</p>
      <p><strong>Standing:</strong> ${escapeHtml(o.standing_summary || '-')}</p>
      <p><strong>Source:</strong> ${escapeHtml(o.source || '-')}</p>
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
  res.json(readJsonArray(ordersFile));
});

app.post('/api/orders', (req, res) => {
  const orders = readJsonArray(ordersFile);
  const record = normalizeOrderRecord(req.body || {});
  orders.unshift(record);
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order: record, total: orders.length });
});

app.post('/api/orders/from-conversation', (req, res) => {
  const conversation = typeof req.body?.conversation === 'string' ? req.body.conversation : '';
  if (!conversation.trim()) {
    res.status(400).json({ ok: false, error: 'conversation is required' });
    return;
  }

  const orders = readJsonArray(ordersFile);
  const record = buildOrderFromConversation(conversation, req.body || {});
  orders.unshift(record);
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order: record, total: orders.length });
});

app.patch('/api/orders/:id', (req, res) => {
  const orders = readJsonArray(ordersFile);
  const index = orders.findIndex(order => order.id === req.params.id);

  if (index === -1) {
    res.status(404).json({ ok: false, error: 'order not found' });
    return;
  }

  const updated = normalizeOrderRecord(req.body || {}, orders[index]);
  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, order: updated });
});

app.post('/api/orders/:id/summarize', (req, res) => {
  const orders = readJsonArray(ordersFile);
  const index = orders.findIndex(order => order.id === req.params.id);

  if (index === -1) {
    res.status(404).json({ ok: false, error: 'order not found' });
    return;
  }

  const updated = normalizeOrderRecord(req.body || {}, orders[index]);
  updated.standing_summary = summarizeStanding(updated);
  updated.updated_at = new Date().toISOString();
  orders[index] = updated;
  writeJsonArray(ordersFile, orders);
  res.json({ ok: true, summary: updated.standing_summary, order: updated });
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

app.listen(3000, () => {
  console.log('Dashboard running on port 3000');
});
