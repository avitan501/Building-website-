const express = require('express');
const fs = require('fs');
const app = express();

const messagesFile = '/root/mysite/messages.json';
const tasksFile = '/root/mysite/tasks.json';
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

function readSiteConfig() {
  const parsed = readJson(siteConfigFile, {});
  return {
    title: typeof parsed.title === 'string' ? parsed.title : 'Personal AI Dashboard',
    subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : 'האתר שלי מנוהל דרך טלגרם',
    bg: typeof parsed.bg === 'string' ? parsed.bg : '#111111',
    text: typeof parsed.text === 'string' ? parsed.text : '#f5f5f5',
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

function renderLayout(pageTitle, body, siteConfig) {
  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(pageTitle)}</title>
        <style>
          :root {
            --bg: ${escapeHtml(siteConfig.bg)};
            --text: ${escapeHtml(siteConfig.text)};
            --card: rgba(15, 23, 42, 0.78);
            --border: rgba(148, 163, 184, 0.18);
            --accent: #8b5cf6;
            --accent-soft: rgba(139, 92, 246, 0.18);
          }
          * {
            box-sizing: border-box;
          }
          body {
            margin: 0;
            font-family: Inter, Arial, sans-serif;
            padding: 32px 20px;
            background:
              radial-gradient(circle at top, rgba(139, 92, 246, 0.22), transparent 30%),
              linear-gradient(180deg, #111827 0%, var(--bg) 55%, #050816 100%);
            color: var(--text);
            min-height: 100vh;
          }
          .container {
            width: 100%;
            max-width: 920px;
            margin: 0 auto;
          }
          h1, h2 {
            color: var(--text);
            margin-top: 0;
          }
          h1 {
            font-size: clamp(2.2rem, 5vw, 3.4rem);
            margin-bottom: 10px;
          }
          h2 {
            font-size: 1.1rem;
            margin-bottom: 10px;
          }
          p, li {
            line-height: 1.7;
          }
          .subtitle {
            color: rgba(229, 231, 235, 0.78);
            margin-top: -2px;
            margin-bottom: 26px;
            font-size: 1.05rem;
          }
          .box {
            background: var(--card);
            border: 1px solid var(--border);
            backdrop-filter: blur(14px);
            padding: 20px;
            margin: 14px 0;
            border-radius: 18px;
            box-shadow: 0 18px 45px rgba(0, 0, 0, 0.28);
          }
          a {
            color: #c4b5fd;
            text-decoration: none;
          }
          a:hover {
            color: #ddd6fe;
          }
          ul {
            padding-inline-start: 20px;
          }
          .box p:last-child,
          .box ul:last-child {
            margin-bottom: 0;
          }
          .pill {
            display: inline-block;
            padding: 6px 10px;
            border-radius: 999px;
            background: var(--accent-soft);
            color: #ddd6fe;
            font-size: 0.88rem;
            margin-bottom: 14px;
          }
        </style>
      </head>
      <body>
        <main class="container">
          ${body}
        </main>
      </body>
    </html>
  `;
}

app.get('/', (req, res) => {
  const siteConfig = readSiteConfig();
  const messages = readJsonArray(messagesFile);
  const tasks = readJsonArray(tasksFile);

  const sectionsHtml = siteConfig.sections.map(section => {
    if (typeof section === 'string') {
      return `<div class="box"><h2>${escapeHtml(section)}</h2></div>`;
    }

    const title = escapeHtml(section.title || 'Section');
    const content = escapeHtml(section.content || '');
    const slug = typeof section.slug === 'string' ? section.slug : normalizeSlug(section.title);
    const pageLink = slug && siteConfig.pages[slug]
      ? `<p><a href="/${encodeURIComponent(slug)}">Open page</a></p>`
      : '';

    return `
      <div class="box">
        <h2>${title}</h2>
        <p>${content}</p>
        ${pageLink}
      </div>
    `;
  }).join('');

  res.send(renderLayout(siteConfig.title, `
    <h1>${escapeHtml(siteConfig.title)}</h1>
    <p class="subtitle">${escapeHtml(siteConfig.subtitle)}</p>

    ${sectionsHtml || '<div class="box"><p>No sections yet</p></div>'}

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
  `, siteConfig));
});

app.get('/messages', (req, res) => {
  const siteConfig = readSiteConfig();
  const messages = readJsonArray(messagesFile);
  const list = messages.map(m => `<li>${escapeHtml(m)}</li>`).join('');

  res.send(renderLayout('Messages', `
    <h1>Messages</h1>
    <div class="box">
      <ul>${list || '<li>No messages yet</li>'}</ul>
    </div>
    <p><a href="/">Back</a></p>
  `, siteConfig));
});

app.get('/tasks', (req, res) => {
  const siteConfig = readSiteConfig();
  const tasks = readJsonArray(tasksFile);
  const list = tasks.map(t => {
    if (typeof t === 'string') {
      return `<li>${escapeHtml(t)}</li>`;
    }
    return `<li><strong>${escapeHtml(t.title || 'Untitled task')}</strong> - ${escapeHtml(t.status || 'open')}</li>`;
  }).join('');

  res.send(renderLayout('Tasks', `
    <h1>Tasks</h1>
    <div class="box">
      <ul>${list || '<li>No tasks yet</li>'}</ul>
    </div>
    <p><a href="/">Back</a></p>
  `, siteConfig));
});

app.get('/:slug', (req, res) => {
  const siteConfig = readSiteConfig();
  const slug = req.params.slug;
  const page = siteConfig.pages[slug];

  if (!page || typeof page !== 'object') {
    res.status(404).send(renderLayout('Page not found', `
      <h1>Page not found</h1>
      <p><a href="/">Back to homepage</a></p>
    `, siteConfig));
    return;
  }

  const title = page.title || slug;
  const content = escapeHtml(page.content || '').replace(/\n/g, '<br>');

  res.send(renderLayout(title, `
    <h1>${escapeHtml(title)}</h1>
    <div class="box">
      <p>${content}</p>
    </div>
    <p><a href="/">Back</a></p>
  `, siteConfig));
});

app.listen(3000, () => {
  console.log('Dashboard running on port 3000');
});
