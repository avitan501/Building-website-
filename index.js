const express = require('express');
const fs = require('fs');
const app = express();

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
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
      <p><strong>Supplier:</strong> ${escapeHtml(o.supplier_name || '-')}</p>
      <p><strong>Summary:</strong> ${escapeHtml(o.order_summary || '-')}</p>
      <p><strong>Amount:</strong> ${escapeHtml(o.amount || '-')}</p>
      <p><strong>Payment:</strong> ${escapeHtml(o.payment_status || '-')}</p>
      <p><strong>Stage:</strong> ${escapeHtml(o.current_stage || '-')}</p>
      <p><strong>Next step:</strong> ${escapeHtml(o.next_step || '-')}</p>
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

