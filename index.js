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
        <title>${escapeHtml(pageTitle)}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 20px;
            background: ${escapeHtml(siteConfig.bg)};
            color: ${escapeHtml(siteConfig.text)};
          }
          h1, h2 {
            color: ${escapeHtml(siteConfig.text)};
          }
          .subtitle {
            opacity: 0.85;
            margin-top: -5px;
            margin-bottom: 24px;
          }
          .box {
            background: rgba(255, 255, 255, 0.08);
            padding: 15px;
            margin: 10px 0;
            border-radius: 10px;
          }
          a {
            color: ${escapeHtml(siteConfig.text)};
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        ${body}
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
