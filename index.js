const express = require('express');
const fs = require('fs');
const app = express();

const messagesFile = '/root/mysite/messages.json';
const tasksFile = '/root/mysite/tasks.json';

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

app.get('/', (req, res) => {
  const messages = readJsonArray(messagesFile);
  const tasks = readJsonArray(tasksFile);

  res.send(`
    <html>
      <head>
        <title>Dashboard</title>
        <style>
          body { font-family: Arial; padding: 20px; background:#f5f5f5; }
          h1 { color:#333; }
          .box { background:white; padding:15px; margin:10px 0; border-radius:8px; }
          a { color:#0b57d0; text-decoration:none; }
        </style>
      </head>
      <body>
        <h1>🚀 Personal AI Dashboard</h1>

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
          <h2>📁 Projects</h2>
          <p>No projects yet</p>
        </div>

        <div class="box">
          <h2>🤖 Recommendations</h2>
          <p>Next step: start saving tasks from Telegram.</p>
        </div>
      </body>
    </html>
  `);
});

app.get('/messages', (req, res) => {
  const messages = readJsonArray(messagesFile);
  const list = messages.map(m => `<li>${String(m)}</li>`).join('');

  res.send(`
    <html>
      <body>
        <h1>Messages</h1>
        <ul>${list || '<li>No messages yet</li>'}</ul>
        <p><a href="/">Back</a></p>
      </body>
    </html>
  `);
});

app.get('/tasks', (req, res) => {
  const tasks = readJsonArray(tasksFile);
  const list = tasks.map(t => {
    if (typeof t === 'string') {
      return `<li>${t}</li>`;
    }
    return `<li><strong>${t.title || 'Untitled task'}</strong> - ${t.status || 'open'}</li>`;
  }).join('');

  res.send(`
    <html>
      <body>
        <h1>Tasks</h1>
        <ul>${list || '<li>No tasks yet</li>'}</ul>
        <p><a href="/">Back</a></p>
      </body>
    </html>
  `);
});

app.listen(3000, () => {
  console.log('Dashboard running on port 3000');
});
