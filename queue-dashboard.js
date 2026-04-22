const { readTasks, writeTasks, syncExistingTaskToMonday } = require('./task-intelligence');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function firstLine(value, limit = 180) {
  const text = normalizeText(value).split('\n').find(Boolean) || '';
  return text.length > limit ? text.slice(0, limit).trim() + '…' : text;
}

function inferCaptureMode(task = {}) {
  return task.capture_mode || (String(task.source || '') === 'task-hub' ? 'explicit-task' : 'conversation-derived');
}

function normalizeQueueState(task = {}) {
  const raw = String(task.queue_status || '').trim().toLowerCase();
  if (raw === 'queued') return 'queued';
  if (['running', 'processing', 'working', 'in-progress'].includes(raw)) return 'running';
  if (raw === 'archived') return 'archived';
  if (raw === 'done') return 'done';
  if (raw === 'error') return 'error';
  if (task.queue_error) return 'error';
  if (task.queue_enabled && task.status !== 'done') return 'queued';
  if (task.status === 'done') return 'done';
  return 'new';
}

function summarizeQueueTask(task = {}) {
  const queueState = normalizeQueueState(task);
  const preview = firstLine(task.queue_error || task.next_step || task.description || task.source_text || task.queue_result || task.queue_plan || '');
  return {
    id: task.id,
    title: task.title || 'Untitled task',
    status: task.status || 'open',
    priority: task.priority || 'normal',
    queue_state: queueState,
    queue_mode: task.queue_run_mode || '',
    brain: task.queue_brain || '',
    updated_at: task.updated_at || '',
    next_step: task.next_step || '',
    due_date: task.due_date || '',
    capture_mode: inferCaptureMode(task),
    monday_url: task.monday_url || '',
    description: task.description || '',
    source_text: task.source_text || '',
    queue_plan: task.queue_plan || '',
    queue_result: task.queue_result || '',
    queue_error: task.queue_error || '',
    preview,
    source: task.source || 'manual'
  };
}

function buildQueueSnapshot(tasksFile) {
  const tasks = readTasks(tasksFile).map(summarizeQueueTask);
  const counts = tasks.reduce((acc, task) => {
    acc[task.queue_state] = (acc[task.queue_state] || 0) + 1;
    return acc;
  }, {});

  const attention = tasks
    .filter(task => ['queued', 'running', 'error', 'new'].includes(task.queue_state))
    .sort((a, b) => {
      const priorityWeight = { urgent: 0, high: 1, normal: 2, low: 3 };
      const byState = { error: 0, queued: 1, running: 2, new: 3 };
      const stateDiff = (byState[a.queue_state] ?? 9) - (byState[b.queue_state] ?? 9);
      if (stateDiff !== 0) return stateDiff;
      const priorityDiff = (priorityWeight[a.priority] ?? 9) - (priorityWeight[b.priority] ?? 9);
      if (priorityDiff !== 0) return priorityDiff;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    })
    .slice(0, 5);

  return {
    ok: true,
    totals: {
      total: tasks.length,
      queued: counts.queued || 0,
      running: counts.running || 0,
      error: counts.error || 0,
      done: counts.done || 0,
      archived: counts.archived || 0
    },
    attention,
    tasks
  };
}

async function syncMirror(tasksFile, taskId) {
  try {
    return await syncExistingTaskToMonday(tasksFile, taskId);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function patchQueueTask(tasksFile, taskId, updater) {
  const tasks = readTasks(tasksFile);
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) return { ok: false, error: 'task not found' };
  const current = tasks[index];
  const next = updater({ ...current });
  next.updated_at = new Date().toISOString();
  tasks[index] = next;
  writeTasks(tasksFile, tasks);
  const monday = await syncMirror(tasksFile, taskId);
  return { ok: true, task: summarizeQueueTask(tasks[index]), monday };
}

async function markQueueTaskDone(tasksFile, taskId) {
  return patchQueueTask(tasksFile, taskId, task => ({
    ...task,
    status: 'done',
    queue_enabled: false,
    queue_status: 'done'
  }));
}

async function requeueQueueTask(tasksFile, taskId) {
  return patchQueueTask(tasksFile, taskId, task => ({
    ...task,
    status: task.status === 'done' ? 'open' : task.status,
    queue_enabled: true,
    queue_status: 'queued',
    queue_run_after: new Date().toISOString(),
    queue_error: ''
  }));
}

async function archiveQueueTask(tasksFile, taskId) {
  return patchQueueTask(tasksFile, taskId, task => ({
    ...task,
    queue_enabled: false,
    queue_status: 'archived'
  }));
}

function renderQueueDashboardPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Queue Board</title>
    <style>
      :root {
        --bg: #f8fbff;
        --panel: #ffffff;
        --line: #d9e3ef;
        --text: #0f172a;
        --muted: #607089;
        --accent: #2563eb;
        --warn: #d97706;
        --good: #059669;
        --danger: #dc2626;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, Arial, sans-serif; background: linear-gradient(180deg, #f8fbff, #eef6ff 35%, #f8fbff); color: var(--text); }
      a { color: var(--accent); text-decoration: none; }
      .shell { max-width: 1380px; margin: 0 auto; padding: 24px; }
      .top, .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      .top { justify-content: space-between; margin-bottom: 18px; }
      .muted { color: var(--muted); }
      .grid, .attention-grid, .board { display: grid; gap: 14px; }
      .grid { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 18px; }
      .attention-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 18px; }
      .board { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
      .card, .task-card, .column { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05); }
      .card, .column { padding: 16px; }
      .task-card { padding: 14px; }
      .pill { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; border: 1px solid var(--line); background: #f3f7ff; color: var(--text); padding: 6px 10px; font-size: 12px; }
      .pill.warn { background: #fff7ed; color: #b45309; border-color: rgba(217, 119, 6, 0.25); }
      .pill.good { background: #ecfdf5; color: #047857; border-color: rgba(5, 150, 105, 0.25); }
      .pill.danger { background: #fef2f2; color: #b91c1c; border-color: rgba(220, 38, 38, 0.25); }
      .toolbar { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin-bottom: 18px; }
      input, select, button { width: 100%; border-radius: 12px; border: 1px solid var(--line); background: #fff; color: var(--text); padding: 10px 12px; font: inherit; }
      button { width: auto; cursor: pointer; background: linear-gradient(180deg, #3b82f6, #2563eb); color: #fff; border: none; font-weight: 600; }
      button.secondary { background: #f8fbff; color: var(--text); border: 1px solid var(--line); }
      .column h2 { margin: 0 0 10px; font-size: 18px; }
      .task-title { margin: 0; font-size: 18px; }
      .task-card p { margin: 8px 0 0; color: #334155; }
      .task-stack { display: grid; gap: 10px; }
      details { margin-top: 10px; }
      summary { cursor: pointer; color: var(--accent); }
      pre { white-space: pre-wrap; word-break: break-word; background: #f8fbff; border: 1px solid var(--line); padding: 10px; border-radius: 12px; }
      .empty { border: 1px dashed var(--line); border-radius: 12px; padding: 18px; color: var(--muted); text-align: center; }
      .mini-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .mini-actions button, .mini-actions a { font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1 style="margin:0;">Queue Board</h1>
          <div class="muted">Short, sweet, clear, and work-ready. This page should help you decide, not drown you in logs.</div>
        </div>
        <div class="row">
          <a class="pill" href="/ops">Ops</a>
          <a class="pill" href="/task-hub">Task Hub</a>
        </div>
      </div>

      <div class="row" style="margin-bottom:16px;">
        <button id="processNextBtn">Process next queued task</button>
      </div>

      <div id="stats" class="grid"></div>
      <div id="attention" class="attention-grid"></div>

      <div class="toolbar">
        <input id="searchInput" type="search" placeholder="Search title or summary" />
        <select id="stateFilter">
          <option value="all">All states</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="error">Error</option>
          <option value="done">Done</option>
          <option value="archived">Archived</option>
          <option value="new">New</option>
        </select>
        <select id="priorityFilter">
          <option value="all">All priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <select id="captureFilter">
          <option value="all">All intake types</option>
          <option value="explicit-task">Explicit task</option>
          <option value="conversation-derived">Derived from conversation</option>
        </select>
      </div>

      <div id="board" class="board"></div>
    </div>

    <script>
      const state = { tasks: [], attention: [], filter: '', stateFilter: 'all', priorityFilter: 'all', captureFilter: 'all' };

      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      function formatTime(value) {
        if (!value) return 'No update yet';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toISOString().slice(0, 16).replace('T', ' ');
      }

      function pillClass(stateName) {
        if (stateName === 'error') return 'danger';
        if (stateName === 'queued') return 'warn';
        if (stateName === 'done') return 'good';
        return '';
      }

      async function getJson(url, options) {
        const response = await fetch(url, options || {});
        const payload = await response.json();
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Request failed');
        return payload;
      }

      function getVisibleTasks() {
        return (state.tasks || []).filter(function(task) {
          if (state.filter) {
            const haystack = [task.title, task.preview, task.next_step, task.description, task.queue_result, task.queue_error].join(' ').toLowerCase();
            if (!haystack.includes(state.filter)) return false;
          }
          if (state.stateFilter !== 'all' && task.queue_state !== state.stateFilter) return false;
          if (state.priorityFilter !== 'all' && task.priority !== state.priorityFilter) return false;
          if (state.captureFilter !== 'all' && task.capture_mode !== state.captureFilter) return false;
          return true;
        });
      }

      function renderStats(snapshot) {
        const stats = [
          ['Total', snapshot.totals.total],
          ['Queued', snapshot.totals.queued],
          ['Running', snapshot.totals.running],
          ['Errors', snapshot.totals.error],
          ['Done', snapshot.totals.done],
          ['Archived', snapshot.totals.archived]
        ];
        return stats.map(function(entry) {
          return '<div class="card"><div class="muted">' + escapeHtml(entry[0]) + '</div><div style="font-size:28px;font-weight:700;">' + escapeHtml(entry[1]) + '</div></div>';
        }).join('');
      }

      function renderAttention(attention) {
        if (!attention.length) return '<div class="empty">No urgent queue items right now.</div>';
        return attention.map(function(task) {
          return '<div class="task-card">'
            + '<div class="row"><span class="pill ' + pillClass(task.queue_state) + '">' + escapeHtml(task.queue_state) + '</span><span class="pill">' + escapeHtml(task.priority) + '</span></div>'
            + '<h3 class="task-title">' + escapeHtml(task.title) + '</h3>'
            + '<p>' + escapeHtml(task.preview || 'Needs review') + '</p>'
            + (task.next_step ? '<div class="muted" style="margin-top:8px;">Next: ' + escapeHtml(task.next_step) + '</div>' : '')
            + '</div>';
        }).join('');
      }

      function renderTaskCard(task) {
        return '<div class="task-card">'
          + '<div class="row"><span class="pill ' + pillClass(task.queue_state) + '">' + escapeHtml(task.queue_state) + '</span><span class="pill">' + escapeHtml(task.priority) + '</span><span class="pill">' + escapeHtml(task.capture_mode) + '</span>' + (task.brain ? '<span class="pill">' + escapeHtml(task.brain) + '</span>' : '') + '</div>'
          + '<h3 class="task-title">' + escapeHtml(task.title) + '</h3>'
          + '<p>' + escapeHtml(task.preview || 'No short summary yet.') + '</p>'
          + '<div class="muted" style="margin-top:8px;">Updated: ' + escapeHtml(formatTime(task.updated_at)) + (task.due_date ? ' • Follow-up: ' + escapeHtml(task.due_date) : '') + '</div>'
          + (task.next_step ? '<div class="muted" style="margin-top:6px;">Next action: ' + escapeHtml(task.next_step) + '</div>' : '')
          + '<div class="mini-actions">'
          + '<button class="secondary" data-action="done" data-id="' + escapeHtml(task.id) + '">Mark done</button>'
          + '<button class="secondary" data-action="requeue" data-id="' + escapeHtml(task.id) + '">Requeue</button>'
          + '<button class="secondary" data-action="archive" data-id="' + escapeHtml(task.id) + '">Archive</button>'
          + '<a class="pill" href="/task-hub">Task Hub</a>'
          + (task.monday_url ? '<a class="pill" href="' + escapeHtml(task.monday_url) + '" target="_blank" rel="noreferrer">Monday</a>' : '')
          + '</div>'
          + '<details><summary>Show details</summary>'
          + (task.description ? '<div><strong>Description</strong><pre>' + escapeHtml(task.description) + '</pre></div>' : '')
          + (task.source_text ? '<div><strong>Conversation</strong><pre>' + escapeHtml(task.source_text) + '</pre></div>' : '')
          + (task.queue_plan ? '<div><strong>Plan</strong><pre>' + escapeHtml(task.queue_plan) + '</pre></div>' : '')
          + (task.queue_result ? '<div><strong>Result</strong><pre>' + escapeHtml(task.queue_result) + '</pre></div>' : '')
          + (task.queue_error ? '<div><strong>Error</strong><pre>' + escapeHtml(task.queue_error) + '</pre></div>' : '')
          + '</details>'
          + '</div>';
      }

      function renderColumns(tasks) {
        const groups = [
          { key: 'queued', title: 'Needs action' },
          { key: 'running', title: 'Working now' },
          { key: 'done', title: 'Recently done' },
          { key: 'archived', title: 'Archived' }
        ];
        return groups.map(function(group) {
          const items = tasks.filter(function(task) { return task.queue_state === group.key; });
          return '<div class="column"><h2>' + escapeHtml(group.title) + '</h2><div class="task-stack">' + (items.length ? items.map(renderTaskCard).join('') : '<div class="empty">Nothing here</div>') + '</div></div>';
        }).join('');
      }

      function render(snapshot) {
        const visibleTasks = getVisibleTasks();
        document.getElementById('stats').innerHTML = renderStats(snapshot);
        document.getElementById('attention').innerHTML = renderAttention(snapshot.attention || []);
        document.getElementById('board').innerHTML = renderColumns(visibleTasks);
      }

      async function load() {
        const snapshot = await getJson('/api/queue-dashboard');
        state.tasks = snapshot.tasks || [];
        state.attention = snapshot.attention || [];
        render(snapshot);
      }

      document.getElementById('searchInput').addEventListener('input', function(event) {
        state.filter = String(event.target.value || '').trim().toLowerCase();
        load();
      });
      document.getElementById('stateFilter').addEventListener('change', function(event) { state.stateFilter = event.target.value || 'all'; load(); });
      document.getElementById('priorityFilter').addEventListener('change', function(event) { state.priorityFilter = event.target.value || 'all'; load(); });
      document.getElementById('captureFilter').addEventListener('change', function(event) { state.captureFilter = event.target.value || 'all'; load(); });
      document.getElementById('processNextBtn').addEventListener('click', async function() {
        try {
          await getJson('/api/agent-queue/process-next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });
      document.addEventListener('click', async function(event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const action = target.dataset.action;
        const taskId = target.dataset.id;
        if (!action || !taskId) return;
        try {
          await getJson('/api/queue-dashboard/tasks/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(action), { method: 'POST' });
          await load();
        } catch (error) {
          alert(error.message);
        }
      });

      load();
      setInterval(load, 30000);
    </script>
  </body>
</html>`;
}

module.exports = {
  buildQueueSnapshot,
  markQueueTaskDone,
  requeueQueueTask,
  archiveQueueTask,
  renderQueueDashboardPage
};
