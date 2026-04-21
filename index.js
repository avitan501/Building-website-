const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.json({ limit: '1mb' }));

const messagesFile = '/root/mysite/messages.json';
const tasksFile = '/root/mysite/tasks.json';
const ordersFile = '/root/mysite/orders.json';
const siteConfigFile = '/root/mysite/site-config.json';

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function readJsonArray(filePath) {
  const parsed = readJson(filePath, []);
  return Array.isArray(parsed) ? parsed : [];
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readSiteConfig() {
  const parsed = readJson(siteConfigFile, {});
  return {
    title: typeof parsed.title === 'string' ? parsed.title : 'Personal AI Dashboard',
    subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : 'האתר שלי מנוהל דרך טלגרם',
    bg: typeof parsed.bg === 'string' ? parsed.bg : '#0b1020',
    text: typeof parsed.text === 'string' ? parsed.text : '#e5e7eb',
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    pages: parsed.pages && typeof parsed.pages === 'object' ? parsed.pages : {}
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatMultiline(value) {
  return escapeHtml(value || '').replace(/\n/g, '<br>');
}

function getPageEntries(siteConfig) {
  return Object.entries(siteConfig.pages || {}).map(([slug, page]) => ({
    slug,
    title: typeof page?.title === 'string' ? page.title : slug,
    content: typeof page?.content === 'string' ? page.content : ''
  }));
}

function extractNamedField(text, patterns, fallback = '') {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return fallback;
}

function detectPaymentStatus(text) {
  const value = text.toLowerCase();
  if (/paid|payment received|שולם|שולמה/.test(value)) return 'paid';
  if (/not paid|unpaid|לא שולם|לא שולם עדיין/.test(value)) return 'unpaid';
  if (/pending payment|awaiting payment|ממתין לתשלום|טרם שולם/.test(value)) return 'pending';
  return 'unknown';
}

function detectStage(text) {
  const value = text.toLowerCase();
  if (/delivered|completed|נמסר|הושלם/.test(value)) return 'completed';
  if (/shipped|on the way|בדרך|נשלח/.test(value)) return 'shipping';
  if (/production|in progress|בטיפול|בביצוע|בייצור/.test(value)) return 'in-progress';
  if (/approved|confirmed|אושר|אושרה/.test(value)) return 'confirmed';
  return 'new';
}

function extractAmount(text) {
  const match = text.match(/(?:amount|total|sum|סה["׳']?כ|מחיר)\s*[:\-]?\s*([₪$€]?\s?\d+(?:[.,]\d{1,2})?)/i)
    || text.match(/([₪$€]\s?\d+(?:[.,]\d{1,2})?)/);
  return match?.[1]?.trim() || '';
}

function inferNextStep(stage, paymentStatus) {
  if (paymentStatus === 'unpaid' || paymentStatus === 'pending') return 'Collect payment';
  if (stage === 'new') return 'Confirm the order details';
  if (stage === 'confirmed') return 'Send the order to execution';
  if (stage === 'in-progress') return 'Follow up with the supplier/customer';
  if (stage === 'shipping') return 'Track delivery and confirm arrival';
  return 'Follow up with the customer';
}

function buildOrderRecordFromConversation(conversation, overrides = {}) {
  const text = String(conversation || '').trim();
  const customerName = overrides.customerName || extractNamedField(text, [
    /customer(?: name)?\s*[:\-]\s*(.+)/i,
    /לקוח(?:ה)?\s*[:\-]\s*(.+)/i,
    /שם לקוח\s*[:\-]\s*(.+)/i
  ], 'Unknown customer');
  const supplierName = overrides.supplierName || extractNamedField(text, [
    /supplier(?: name)?\s*[:\-]\s*(.+)/i,
    /ספק\s*[:\-]\s*(.+)/i,
    /שם ספק\s*[:\-]\s*(.+)/i
  ], '');
  const orderSummary = overrides.orderSummary || extractNamedField(text, [
    /order(?: summary)?\s*[:\-]\s*(.+)/i,
    /summary\s*[:\-]\s*(.+)/i,
    /מוצרים?\s*[:\-]\s*(.+)/i,
    /פרטי הזמנה\s*[:\-]\s*(.+)/i
  ], text.slice(0, 160) || 'New order conversation');
  const amount = overrides.amount || extractAmount(text);
  const paymentStatus = overrides.paymentStatus || detectPaymentStatus(text);
  const currentStage = overrides.currentStage || detectStage(text);
  const nextStep = overrides.nextStep || extractNamedField(text, [
    /next step\s*[:\-]\s*(.+)/i,
    /השלב הבא\s*[:\-]\s*(.+)/i,
    /next action\s*[:\-]\s*(.+)/i
  ], inferNextStep(currentStage, paymentStatus));

  return {
    customerName,
    supplierName,
    orderSummary,
    amount,
    paymentStatus,
    currentStage,
    nextStep,
    createdAt: new Date().toISOString()
  };
}

function renderNav(siteConfig) {
  const pageLinks = getPageEntries(siteConfig)
    .slice(0, 4)
    .map(page => `<a href="/${encodeURIComponent(page.slug)}">${escapeHtml(page.title)}</a>`)
    .join('');

  return `
    <header class="topbar">
      <a class="brand" href="/">
        <span class="brand-mark">✦</span>
        <span>${escapeHtml(siteConfig.title)}</span>
      </a>
      <nav class="nav">
        <a href="/">Home</a>
        ${pageLinks}
        <a href="/orders">Orders</a>
        <a href="/messages">Messages</a>
        <a href="/tasks">Tasks</a>
      </nav>
    </header>
  `;
}

function renderLayout(pageTitle, body, siteConfig) {
  return `
    <html lang="he">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(pageTitle)}</title>
        <style>
          :root {
            --bg: ${escapeHtml(siteConfig.bg)};
            --text: ${escapeHtml(siteConfig.text)};
            --card: rgba(15, 23, 42, 0.82);
            --card-strong: rgba(15, 23, 42, 0.94);
            --border: rgba(148, 163, 184, 0.18);
            --accent: #8b5cf6;
            --accent-strong: #7c3aed;
            --accent-soft: rgba(139, 92, 246, 0.18);
            --muted: rgba(226, 232, 240, 0.72);
            --shadow: 0 20px 60px rgba(2, 6, 23, 0.42);
          }
          * {
            box-sizing: border-box;
          }
          html {
            scroll-behavior: smooth;
          }
          body {
            margin: 0;
            font-family: Inter, Arial, sans-serif;
            background:
              radial-gradient(circle at top, rgba(139, 92, 246, 0.22), transparent 28%),
              linear-gradient(180deg, #111827 0%, var(--bg) 55%, #050816 100%);
            color: var(--text);
            min-height: 100vh;
          }
          a {
            color: inherit;
            text-decoration: none;
          }
          .container {
            width: min(1120px, calc(100% - 32px));
            margin: 0 auto;
            padding: 24px 0 40px;
          }
          .topbar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding: 14px 18px;
            border: 1px solid var(--border);
            border-radius: 20px;
            background: rgba(15, 23, 42, 0.72);
            backdrop-filter: blur(16px);
            box-shadow: var(--shadow);
            margin-bottom: 22px;
            position: sticky;
            top: 16px;
            z-index: 20;
          }
          .brand {
            display: inline-flex;
            align-items: center;
            gap: 10px;
            font-weight: 700;
            letter-spacing: 0.02em;
          }
          .brand-mark {
            display: inline-grid;
            place-items: center;
            width: 30px;
            height: 30px;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--accent), #22d3ee);
            color: white;
            box-shadow: 0 12px 30px rgba(124, 58, 237, 0.35);
          }
          .nav {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 10px;
          }
          .nav a {
            color: var(--muted);
            padding: 9px 12px;
            border-radius: 999px;
            transition: 0.2s ease;
          }
          .nav a:hover {
            color: var(--text);
            background: rgba(148, 163, 184, 0.12);
          }
          .hero {
            padding: 36px;
            margin-bottom: 22px;
            background:
              linear-gradient(135deg, rgba(124, 58, 237, 0.22), rgba(34, 211, 238, 0.08)),
              var(--card-strong);
          }
          .eyebrow {
            display: inline-block;
            padding: 7px 12px;
            border-radius: 999px;
            background: var(--accent-soft);
            color: #ddd6fe;
            font-size: 0.88rem;
            margin-bottom: 14px;
          }
          .hero h1,
          .page-header h1 {
            margin: 0 0 10px;
            font-size: clamp(2.2rem, 4vw, 4rem);
            line-height: 1.05;
          }
          .subtitle,
          .lead,
          .muted {
            color: var(--muted);
          }
          .lead {
            max-width: 760px;
            font-size: 1.05rem;
            line-height: 1.8;
          }
          .hero-actions,
          .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 24px;
          }
          .btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 12px 18px;
            border-radius: 14px;
            border: 1px solid transparent;
            font-weight: 600;
            transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
          }
          .btn:hover {
            transform: translateY(-1px);
          }
          .btn-primary {
            background: linear-gradient(135deg, var(--accent), var(--accent-strong));
            color: white;
            box-shadow: 0 18px 35px rgba(124, 58, 237, 0.28);
          }
          .btn-secondary {
            background: rgba(148, 163, 184, 0.1);
            border-color: var(--border);
            color: var(--text);
          }
          .grid,
          .stats-grid,
          .page-grid {
            display: grid;
            gap: 16px;
          }
          .stats-grid {
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            margin-bottom: 22px;
          }
          .grid,
          .page-grid {
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          }
          .section-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            margin: 30px 0 14px;
          }
          .section-title h2 {
            margin: 0;
            font-size: 1.25rem;
          }
          .box,
          .stat-card,
          .page-card,
          .list-card {
            background: var(--card);
            border: 1px solid var(--border);
            border-radius: 22px;
            padding: 22px;
            box-shadow: var(--shadow);
            backdrop-filter: blur(14px);
          }
          .stat-card strong {
            display: block;
            font-size: 2rem;
            margin-bottom: 6px;
          }
          .page-card h3,
          .box h3,
          .list-card h3 {
            margin-top: 0;
            margin-bottom: 10px;
            font-size: 1.08rem;
          }
          .page-card p,
          .box p,
          .list-card p,
          li {
            line-height: 1.75;
          }
          .list-clean {
            list-style: none;
            padding: 0;
            margin: 0;
            display: grid;
            gap: 12px;
          }
          .list-item {
            padding: 14px 16px;
            border-radius: 16px;
            background: rgba(148, 163, 184, 0.08);
            border: 1px solid rgba(148, 163, 184, 0.08);
          }
          .footer {
            margin-top: 28px;
            padding: 22px 0 10px;
            color: rgba(226, 232, 240, 0.56);
            font-size: 0.95rem;
          }
          .empty {
            color: var(--muted);
          }
          @media (max-width: 760px) {
            .topbar {
              position: static;
              padding: 16px;
            }
            .container {
              width: min(100% - 20px, 1120px);
              padding-top: 18px;
            }
            .hero,
            .box,
            .stat-card,
            .page-card,
            .list-card {
              padding: 18px;
            }
          }
        </style>
      </head>
      <body>
        <main class="container">
          ${renderNav(siteConfig)}
          ${body}
          <footer class="footer">Built with OpenClaw and deployed from Telegram.</footer>
        </main>
      </body>
    </html>
  `;
}

function renderSections(siteConfig) {
  const sections = siteConfig.sections || [];
  if (!sections.length) {
    return '<div class="box empty">אין עדיין אזורים בעמוד הראשי.</div>';
  }

  return `<div class="grid">${sections.map(section => {
    if (typeof section === 'string') {
      return `<article class="box"><h3>${escapeHtml(section)}</h3></article>`;
    }

    const title = escapeHtml(section.title || 'Section');
    const content = formatMultiline(section.content || '');
    const slug = typeof section.slug === 'string' ? section.slug : normalizeSlug(section.title);
    const pageLink = slug && siteConfig.pages[slug]
      ? `<div class="actions"><a class="btn btn-secondary" href="/${encodeURIComponent(slug)}">Open page</a></div>`
      : '';

    return `
      <article class="box">
        <h3>${title}</h3>
        <p class="muted">${content}</p>
        ${pageLink}
      </article>
    `;
  }).join('')}</div>`;
}

function renderPageCards(siteConfig) {
  const pages = getPageEntries(siteConfig);
  if (!pages.length) return '';

  return `
    <section>
      <div class="section-title">
        <h2>Pages</h2>
        <span class="muted">${pages.length} available</span>
      </div>
      <div class="page-grid">
        ${pages.map(page => `
          <article class="page-card">
            <h3>${escapeHtml(page.title)}</h3>
            <p class="muted">${formatMultiline(page.content.slice(0, 140))}</p>
            <div class="actions">
              <a class="btn btn-secondary" href="/${encodeURIComponent(page.slug)}">Open page</a>
            </div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

app.get('/', (req, res) => {
  const siteConfig = readSiteConfig();
  const messages = readJsonArray(messagesFile);
  const tasks = readJsonArray(tasksFile);
  const orders = readJsonArray(ordersFile);
  const pages = getPageEntries(siteConfig);
  const secondaryPage = pages[0];

  res.send(renderLayout(siteConfig.title, `
    <section class="box hero">
      <span class="eyebrow">Professional website</span>
      <h1>${escapeHtml(siteConfig.title)}</h1>
      <p class="subtitle">${escapeHtml(siteConfig.subtitle)}</p>
      <p class="lead">אתר מקצועי, מהיר ונקי עם עמודים דינמיים, ניהול דרך טלגרם, ויכולת להפוך שיחות הזמנה בוואטסאפ לרשומות order מסודרות.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="/orders">Open orders</a>
        ${secondaryPage ? `<a class="btn btn-secondary" href="/${encodeURIComponent(secondaryPage.slug)}">${escapeHtml(secondaryPage.title)}</a>` : '<a class="btn btn-secondary" href="/messages">Open dashboard</a>'}
      </div>
    </section>

    <section class="stats-grid">
      <article class="stat-card">
        <span class="muted">Orders</span>
        <strong>${orders.length}</strong>
        <span class="muted">Structured order records</span>
      </article>
      <article class="stat-card">
        <span class="muted">Pages</span>
        <strong>${pages.length}</strong>
        <span class="muted">Live site pages</span>
      </article>
      <article class="stat-card">
        <span class="muted">Sections</span>
        <strong>${siteConfig.sections.length}</strong>
        <span class="muted">Homepage content blocks</span>
      </article>
      <article class="stat-card">
        <span class="muted">Messages</span>
        <strong>${messages.length}</strong>
        <span class="muted">Incoming items</span>
      </article>
      <article class="stat-card">
        <span class="muted">Tasks</span>
        <strong>${tasks.length}</strong>
        <span class="muted">Tracked actions</span>
      </article>
    </section>

    <section>
      <div class="section-title">
        <h2>Homepage sections</h2>
        <span class="muted">Curated content blocks</span>
      </div>
      ${renderSections(siteConfig)}
    </section>

    ${renderPageCards(siteConfig)}
  `, siteConfig));
});

app.get('/orders', (req, res) => {
  const siteConfig = readSiteConfig();
  const orders = readJsonArray(ordersFile);
  const listHtml = orders.length
    ? orders.map(order => `
        <article class="page-card">
          <h3>${escapeHtml(order.customerName || 'Unknown customer')}</h3>
          <p class="muted">${escapeHtml(order.orderSummary || 'No summary')}</p>
          <p><strong>Supplier:</strong> ${escapeHtml(order.supplierName || '-')}</p>
          <p><strong>Amount:</strong> ${escapeHtml(order.amount || '-')}</p>
          <p><strong>Payment:</strong> ${escapeHtml(order.paymentStatus || 'unknown')}</p>
          <p><strong>Stage:</strong> ${escapeHtml(order.currentStage || 'new')}</p>
          <p><strong>Next step:</strong> ${escapeHtml(order.nextStep || '-')}</p>
        </article>
      `).join('')
    : '<div class="box empty">No order records yet</div>';

  res.send(renderLayout('Orders', `
    <section class="box page-header">
      <span class="eyebrow">Orders</span>
      <h1>Order records</h1>
      <p class="lead">כל שיחת הזמנה יכולה להפוך לרשומת order ברורה עם לקוח, ספק, סכום, סטטוס ותעדוף המשך.</p>
    </section>
    <section class="page-grid">${listHtml}</section>
  `, siteConfig));
});

app.post('/api/orders/from-conversation', (req, res) => {
  const conversation = typeof req.body?.conversation === 'string' ? req.body.conversation : '';
  const overrides = {
    customerName: req.body?.customerName,
    supplierName: req.body?.supplierName,
    orderSummary: req.body?.orderSummary,
    amount: req.body?.amount,
    paymentStatus: req.body?.paymentStatus,
    currentStage: req.body?.currentStage,
    nextStep: req.body?.nextStep
  };

  if (!conversation.trim() && !overrides.orderSummary) {
    res.status(400).json({ ok: false, error: 'conversation or orderSummary is required' });
    return;
  }

  const record = buildOrderRecordFromConversation(conversation, overrides);
  const orders = readJsonArray(ordersFile);
  orders.unshift(record);
  writeJson(ordersFile, orders);

  res.json({ ok: true, order: record, total: orders.length });
});

app.get('/messages', (req, res) => {
  const siteConfig = readSiteConfig();
  const messages = readJsonArray(messagesFile);
  const listHtml = messages.length
    ? messages.map(message => `<li class="list-item">${escapeHtml(message)}</li>`).join('')
    : '<li class="list-item empty">No messages yet</li>';

  res.send(renderLayout('Messages', `
    <section class="box page-header">
      <span class="eyebrow">Inbox</span>
      <h1>Messages</h1>
      <p class="lead">תצוגה מרוכזת של הודעות שנשמרו באתר.</p>
    </section>
    <section class="list-card">
      <ul class="list-clean">${listHtml}</ul>
    </section>
  `, siteConfig));
});

app.get('/tasks', (req, res) => {
  const siteConfig = readSiteConfig();
  const tasks = readJsonArray(tasksFile);
  const listHtml = tasks.length
    ? tasks.map(task => {
        if (typeof task === 'string') {
          return `<li class="list-item">${escapeHtml(task)}</li>`;
        }
        return `
          <li class="list-item">
            <strong>${escapeHtml(task.title || 'Untitled task')}</strong><br>
            <span class="muted">Status: ${escapeHtml(task.status || 'open')}</span>
          </li>
        `;
      }).join('')
    : '<li class="list-item empty">No tasks yet</li>';

  res.send(renderLayout('Tasks', `
    <section class="box page-header">
      <span class="eyebrow">Workflow</span>
      <h1>Tasks</h1>
      <p class="lead">רשימת המשימות המעודכנת של האתר.</p>
    </section>
    <section class="list-card">
      <ul class="list-clean">${listHtml}</ul>
    </section>
  `, siteConfig));
});

app.get('/:slug', (req, res) => {
  const siteConfig = readSiteConfig();
  const slug = req.params.slug;
  const page = siteConfig.pages[slug];

  if (!page || typeof page !== 'object') {
    res.status(404).send(renderLayout('Page not found', `
      <section class="box page-header">
        <span class="eyebrow">404</span>
        <h1>Page not found</h1>
        <p class="lead">העמוד שביקשת לא קיים כרגע באתר.</p>
        <div class="actions">
          <a class="btn btn-primary" href="/">Back to homepage</a>
        </div>
      </section>
    `, siteConfig));
    return;
  }

  const title = page.title || slug;
  const content = formatMultiline(page.content || '');

  res.send(renderLayout(title, `
    <section class="box page-header">
      <span class="eyebrow">Website page</span>
      <h1>${escapeHtml(title)}</h1>
      <p class="lead">תוכן עמוד דינמי שמנוהל דרך קובץ הקונפיג של האתר.</p>
    </section>
    <section class="list-card">
      <p>${content}</p>
    </section>
  `, siteConfig));
});

app.listen(3000, () => {
  console.log('Dashboard running on port 3000');
});
