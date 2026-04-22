const crypto = require('crypto');
const {
  createTaskFromText,
  readTasks,
  writeTasks,
  normalizeTaskRecord,
  syncExistingTaskToMonday
} = require('./task-intelligence');

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

function toComparableTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function nextLocalId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

function summarizeContact(contact = {}) {
  const latestActivity = Array.isArray(contact.activities) && contact.activities.length ? contact.activities[0] : null;
  return {
    id: contact.id,
    name: contact.name || '',
    phone: contact.phone || '',
    company: contact.company || '',
    role: contact.role || '',
    relation: contact.relation || '',
    status: contact.status || 'to-call',
    notes: contact.notes || '',
    progress_summary: contact.progress_summary || '',
    proposal_summary: contact.proposal_summary || '',
    next_step: contact.next_step || '',
    last_contact_at: contact.last_contact_at || '',
    updated_at: contact.updated_at || '',
    activities: (Array.isArray(contact.activities) ? contact.activities : []).slice(0, 12),
    latest_activity: latestActivity
  };
}

function summarizeTask(task = {}) {
  const contacts = (Array.isArray(task.contacts) ? task.contacts : [])
    .map(summarizeContact)
    .sort((a, b) => {
      const diff = toComparableTimestamp(b.last_contact_at) - toComparableTimestamp(a.last_contact_at);
      if (diff !== 0) return diff;
      return toComparableTimestamp(b.updated_at) - toComparableTimestamp(a.updated_at);
    });

  const contactStatuses = contacts.reduce((acc, contact) => {
    const key = String(contact.status || 'unknown');
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    id: task.id,
    title: task.title || 'Untitled task',
    description: task.description || '',
    status: task.status || 'open',
    priority: task.priority || 'normal',
    next_step: task.next_step || '',
    due_date: task.due_date || '',
    task_type: task.task_type || 'task',
    capture_mode: task.capture_mode || ((task.source || '') === 'task-hub' ? 'explicit-task' : 'conversation-derived'),
    source_text: task.source_text || '',
    task_notes: task.task_notes || '',
    last_contact_at: task.last_contact_at || '',
    last_message_at: task.last_message_at || '',
    updated_at: task.updated_at || '',
    monday_url: task.monday_url || '',
    monday_item_id: task.monday_item_id || '',
    queue_status: task.queue_status || '',
    contact_summary: task.contact_summary || '',
    contacts,
    stats: {
      contacts: contacts.length,
      contacted: contacts.filter(contact => ['reached', 'in-touch', 'progress', 'waiting', 'interested', 'done'].includes(String(contact.status || '').toLowerCase())).length,
      pending: contacts.filter(contact => ['to-call', 'new'].includes(String(contact.status || '').toLowerCase())).length,
      byStatus: contactStatuses
    }
  };
}

function buildTaskHubSnapshot(tasksFile) {
  const tasks = readTasks(tasksFile)
    .map(summarizeTask)
    .sort((a, b) => {
      const recentA = Math.max(toComparableTimestamp(a.last_contact_at), toComparableTimestamp(a.updated_at));
      const recentB = Math.max(toComparableTimestamp(b.last_contact_at), toComparableTimestamp(b.updated_at));
      return recentB - recentA;
    });

  const totals = tasks.reduce((acc, task) => {
    acc.tasks += 1;
    acc.contacts += task.stats.contacts;
    if (!['done', 'closed'].includes(String(task.status || '').toLowerCase())) acc.openTasks += 1;
    if (task.stats.pending) acc.tasksWithPendingCalls += 1;
    return acc;
  }, { tasks: 0, contacts: 0, openTasks: 0, tasksWithPendingCalls: 0 });

  return {
    ok: true,
    totals,
    tasks
  };
}

async function syncMirror(tasksFile, taskId, options = {}) {
  if (options.skipMondaySync) return { ok: true, skipped: true };
  try {
    return await syncExistingTaskToMonday(tasksFile, taskId);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function createTaskHubTask(tasksFile, input = {}, options = {}) {
  const title = normalizeText(input.title);
  const description = normalizeText(input.description);
  const text = normalizeText(input.text || [title, description].filter(Boolean).join('\n'));
  if (!text) return { ok: false, error: 'title or text is required' };

  const result = await createTaskFromText(tasksFile, text, {
    title: title || undefined,
    description: description || undefined,
    next_step: normalizeText(input.next_step || input.nextStep),
    due_date: normalizeText(input.due_date || input.follow_up_at || input.followUpAt),
    task_type: normalizeText(input.task_type || input.taskType) || 'task',
    priority: normalizeText(input.priority) || 'normal',
    status: normalizeText(input.status) || 'open',
    task_notes: normalizeText(input.task_notes || input.taskNotes),
    source: normalizeText(input.source) || 'task-hub',
    queue_enabled: false,
    queue_status: '',
    queue_run_mode: 'manual',
    queue_plan: '',
    queue_result: '',
    queue_error: ''
  });

  return {
    ok: true,
    task: summarizeTask(result.task),
    monday: result.monday || { skipped: true }
  };
}

async function updateTaskHubTask(tasksFile, taskId, patch = {}, options = {}) {
  const tasks = readTasks(tasksFile);
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) return { ok: false, error: 'task not found' };

  const next = {
    ...tasks[index],
    title: normalizeText(patch.title) || tasks[index].title,
    description: Object.prototype.hasOwnProperty.call(patch, 'description') ? normalizeText(patch.description) : tasks[index].description,
    status: normalizeText(patch.status) || tasks[index].status,
    priority: normalizeText(patch.priority) || tasks[index].priority,
    next_step: Object.prototype.hasOwnProperty.call(patch, 'next_step') || Object.prototype.hasOwnProperty.call(patch, 'nextStep')
      ? normalizeText(patch.next_step || patch.nextStep)
      : tasks[index].next_step,
    due_date: Object.prototype.hasOwnProperty.call(patch, 'due_date') || Object.prototype.hasOwnProperty.call(patch, 'follow_up_at') || Object.prototype.hasOwnProperty.call(patch, 'followUpAt')
      ? normalizeText(patch.due_date || patch.follow_up_at || patch.followUpAt)
      : tasks[index].due_date,
    task_type: Object.prototype.hasOwnProperty.call(patch, 'task_type') || Object.prototype.hasOwnProperty.call(patch, 'taskType')
      ? normalizeText(patch.task_type || patch.taskType)
      : tasks[index].task_type,
    task_notes: Object.prototype.hasOwnProperty.call(patch, 'task_notes') || Object.prototype.hasOwnProperty.call(patch, 'taskNotes')
      ? normalizeText(patch.task_notes || patch.taskNotes)
      : tasks[index].task_notes
  };

  tasks[index] = normalizeTaskRecord(next, tasks[index], tasks);
  writeTasks(tasksFile, tasks);
  const monday = await syncMirror(tasksFile, taskId, options);
  return { ok: true, task: summarizeTask(tasks[index]), monday };
}

async function addTaskContact(tasksFile, taskId, input = {}, options = {}) {
  const tasks = readTasks(tasksFile);
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) return { ok: false, error: 'task not found' };

  const contact = {
    id: input.id || nextLocalId('CONTACT'),
    name: normalizeText(input.name),
    phone: normalizeText(input.phone),
    company: normalizeText(input.company),
    role: normalizeText(input.role),
    relation: normalizeText(input.relation),
    status: normalizeText(input.status) || 'to-call',
    notes: normalizeText(input.notes),
    progress_summary: normalizeText(input.progress_summary || input.progressSummary),
    proposal_summary: normalizeText(input.proposal_summary || input.proposalSummary),
    next_step: normalizeText(input.next_step || input.nextStep),
    last_contact_at: normalizeText(input.last_contact_at || input.lastContactAt),
    activities: []
  };

  if (!contact.name && !contact.phone) {
    return { ok: false, error: 'contact name or phone is required' };
  }

  const currentContacts = Array.isArray(tasks[index].contacts) ? tasks[index].contacts : [];
  const duplicate = currentContacts.find(existing => {
    const sameId = existing.id && contact.id && existing.id === contact.id;
    const samePhone = existing.phone && contact.phone && existing.phone === contact.phone;
    const sameName = existing.name && contact.name && existing.name.toLowerCase() === contact.name.toLowerCase();
    return sameId || samePhone || sameName;
  });

  if (duplicate) {
    return updateTaskContact(tasksFile, taskId, duplicate.id, contact, options);
  }

  tasks[index] = normalizeTaskRecord({
    ...tasks[index],
    contacts: [...currentContacts, contact]
  }, tasks[index], tasks);
  writeTasks(tasksFile, tasks);
  const monday = await syncMirror(tasksFile, taskId, options);
  return { ok: true, task: summarizeTask(tasks[index]), contact: summarizeContact(tasks[index].contacts[0]), monday };
}

async function updateTaskContact(tasksFile, taskId, contactId, patch = {}, options = {}) {
  const tasks = readTasks(tasksFile);
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) return { ok: false, error: 'task not found' };

  const currentContacts = Array.isArray(tasks[index].contacts) ? tasks[index].contacts : [];
  const contactIndex = currentContacts.findIndex(contact => contact.id === contactId);
  if (contactIndex === -1) return { ok: false, error: 'contact not found' };

  const current = currentContacts[contactIndex];
  const mergedContact = {
    ...current,
    name: Object.prototype.hasOwnProperty.call(patch, 'name') ? normalizeText(patch.name) : current.name,
    phone: Object.prototype.hasOwnProperty.call(patch, 'phone') ? normalizeText(patch.phone) : current.phone,
    company: Object.prototype.hasOwnProperty.call(patch, 'company') ? normalizeText(patch.company) : current.company,
    role: Object.prototype.hasOwnProperty.call(patch, 'role') ? normalizeText(patch.role) : current.role,
    relation: Object.prototype.hasOwnProperty.call(patch, 'relation') ? normalizeText(patch.relation) : current.relation,
    status: Object.prototype.hasOwnProperty.call(patch, 'status') ? normalizeText(patch.status) : current.status,
    notes: Object.prototype.hasOwnProperty.call(patch, 'notes') ? normalizeText(patch.notes) : current.notes,
    progress_summary: Object.prototype.hasOwnProperty.call(patch, 'progress_summary') || Object.prototype.hasOwnProperty.call(patch, 'progressSummary')
      ? normalizeText(patch.progress_summary || patch.progressSummary)
      : current.progress_summary,
    proposal_summary: Object.prototype.hasOwnProperty.call(patch, 'proposal_summary') || Object.prototype.hasOwnProperty.call(patch, 'proposalSummary')
      ? normalizeText(patch.proposal_summary || patch.proposalSummary)
      : current.proposal_summary,
    next_step: Object.prototype.hasOwnProperty.call(patch, 'next_step') || Object.prototype.hasOwnProperty.call(patch, 'nextStep')
      ? normalizeText(patch.next_step || patch.nextStep)
      : current.next_step,
    last_contact_at: Object.prototype.hasOwnProperty.call(patch, 'last_contact_at') || Object.prototype.hasOwnProperty.call(patch, 'lastContactAt')
      ? normalizeText(patch.last_contact_at || patch.lastContactAt)
      : current.last_contact_at,
    activities: Array.isArray(patch.activities) ? patch.activities : current.activities
  };

  const contacts = currentContacts.map(contact => contact.id === contactId ? mergedContact : contact);
  tasks[index] = normalizeTaskRecord({ ...tasks[index], contacts }, tasks[index], tasks);
  writeTasks(tasksFile, tasks);
  const monday = await syncMirror(tasksFile, taskId, options);
  const updatedContact = (tasks[index].contacts || []).find(contact => contact.id === contactId) || null;
  return { ok: true, task: summarizeTask(tasks[index]), contact: updatedContact ? summarizeContact(updatedContact) : null, monday };
}

async function addTaskContactActivity(tasksFile, taskId, contactId, input = {}, options = {}) {
  const tasks = readTasks(tasksFile);
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) return { ok: false, error: 'task not found' };

  const currentContacts = Array.isArray(tasks[index].contacts) ? tasks[index].contacts : [];
  const contactIndex = currentContacts.findIndex(contact => contact.id === contactId);
  if (contactIndex === -1) return { ok: false, error: 'contact not found' };

  const summary = normalizeText(input.summary || input.note);
  const proposal = normalizeText(input.proposal || input.suggestion);
  const nextStep = normalizeText(input.next_step || input.nextStep);
  const outcome = normalizeText(input.outcome);
  if (!summary && !proposal && !nextStep && !outcome) {
    return { ok: false, error: 'activity details are required' };
  }

  const activity = {
    id: input.id || nextLocalId('ACT'),
    timestamp: normalizeText(input.timestamp) || new Date().toISOString(),
    type: normalizeText(input.type) || 'call',
    summary,
    proposal,
    next_step: nextStep,
    outcome,
    status_after: normalizeText(input.status_after || input.statusAfter)
  };

  const current = currentContacts[contactIndex];
  const contacts = currentContacts.map(contact => {
    if (contact.id !== contactId) return contact;
    return {
      ...contact,
      status: activity.status_after || contact.status,
      progress_summary: activity.summary || contact.progress_summary,
      proposal_summary: activity.proposal || contact.proposal_summary,
      next_step: activity.next_step || contact.next_step,
      last_contact_at: activity.timestamp,
      activities: [activity, ...(Array.isArray(contact.activities) ? contact.activities : [])]
    };
  });

  tasks[index] = normalizeTaskRecord({ ...tasks[index], contacts }, tasks[index], tasks);
  writeTasks(tasksFile, tasks);
  const monday = await syncMirror(tasksFile, taskId, options);
  const updatedContact = (tasks[index].contacts || []).find(contact => contact.id === contactId) || current;
  return { ok: true, task: summarizeTask(tasks[index]), contact: summarizeContact(updatedContact), activity, monday };
}

function renderTaskHubPage() {
  return `<!doctype html>
<html lang="he">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Task Hub</title>
    <style>
      :root {
        --bg: #f8fbff;
        --panel: #ffffff;
        --panel-2: #f3f7fb;
        --line: #d9e3ef;
        --text: #0f172a;
        --muted: #5b6b80;
        --accent: #0ea5e9;
        --good: #059669;
        --warn: #d97706;
      }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, Arial, sans-serif; background: linear-gradient(180deg, #f8fbff, #eef6ff 35%, #f8fbff 100%); color: var(--text); }
      a { color: #2563eb; text-decoration: none; }
      .shell { max-width: 1320px; margin: 0 auto; padding: 24px; }
      .top { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 20px; }
      .title { margin: 0; font-size: 32px; }
      .muted { color: var(--muted); }
      .stats, .task-grid, .contact-grid, .focus-grid { display: grid; gap: 14px; }
      .stats { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); margin: 18px 0; }
      .focus-grid { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin: 0 0 18px; }
      .focus-card { background: #ffffff; border: 1px solid rgba(14, 165, 233, 0.28); border-radius: 16px; padding: 14px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05); }
      .task-grid { grid-template-columns: 1fr; }
      .contact-grid { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
      .card, .task-card, .contact-card { background: #ffffff; border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05); }
      .card { padding: 16px; }
      .task-card { padding: 18px; }
      .contact-card { padding: 14px; margin-top: 12px; }
      .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .row.spread { justify-content: space-between; }
      .pill { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; border: 1px solid var(--line); background: #f3f7ff; color: var(--text); padding: 6px 10px; font-size: 12px; }
      .pill.good { border-color: rgba(5, 150, 105, 0.25); color: #047857; background: #ecfdf5; }
      .pill.warn { border-color: rgba(217, 119, 6, 0.25); color: #b45309; background: #fff7ed; }
      form { margin: 0; }
      input, textarea, select, button {
        width: 100%; border-radius: 12px; border: 1px solid var(--line); background: #ffffff; color: var(--text);
        padding: 11px 12px; font: inherit;
      }
      textarea { min-height: 90px; resize: vertical; }
      button { width: auto; cursor: pointer; background: linear-gradient(180deg, #3b82f6, #2563eb); border: none; color: #ffffff; font-weight: 600; }
      button.secondary { background: #f8fbff; border: 1px solid var(--line); color: var(--text); }
      .form-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
      .task-title { font-size: 22px; margin: 0; }
      .task-desc { color: #334155; white-space: pre-wrap; }
      .expandable { margin-top: 8px; border: 1px solid var(--line); background: #ffffff; border-radius: 12px; overflow: hidden; }
      .expandable summary { list-style: none; display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 10px 12px; }
      .expandable summary::-webkit-details-marker { display: none; }
      .expandable .preview { color: #334155; white-space: pre-wrap; }
      .expandable .expand-body { border-top: 1px solid var(--line); padding: 12px; color: #334155; white-space: pre-wrap; }
      .section-title { margin: 18px 0 10px; font-size: 16px; }
      .timeline { display: grid; gap: 8px; }
      .timeline-item { border: 1px solid var(--line); background: #ffffff; border-radius: 12px; padding: 10px; }
      .empty { border: 1px dashed var(--line); border-radius: 16px; padding: 24px; text-align: center; color: var(--muted); background: #ffffff; }
      .tiny { font-size: 12px; color: var(--muted); }
      .search { max-width: 340px; }
      .notice { margin: 10px 0 0; color: #1d4ed8; }
      .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .toggle-pill { display: inline-flex; align-items: center; gap: 8px; }
      .toggle-pill input { width: auto; }
      details { margin-top: 10px; }
      summary { cursor: pointer; color: #2563eb; }
      body.compact-mode .card,
      body.compact-mode .task-card,
      body.compact-mode .contact-card { border-radius: 12px; }
      body.compact-mode .card { padding: 12px; }
      body.compact-mode .task-card { padding: 12px; }
      body.compact-mode .contact-card { padding: 10px; }
      body.compact-mode .task-title { font-size: 18px; }
      body.compact-mode .section-title { margin: 12px 0 8px; font-size: 14px; }
      body.compact-mode .row { gap: 8px; }
      body.compact-mode .pill { padding: 5px 8px; font-size: 11px; }
      body.compact-mode .timeline-item { padding: 8px; }
      body.compact-mode .focus-card { padding: 10px; border-radius: 12px; }
      @media (max-width: 720px) {
        .shell { padding: 16px; }
        .title { font-size: 26px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="top">
        <div>
          <h1 class="title">Task Hub</h1>
          <div class="muted">כל משימה במקום אחד, עם אנשים לקדם מולם, לוג שיחות, הצעות, וצעד הבא. האתר הוא מקור האמת, Monday נשאר מראה למעקב.</div>
          <div class="notice">קיצור דרך לשימוש איתי בצ'אט: שלח "משימה: ..." ואז "איש קשר: ..." ואני אמלא את זה כאן.</div>
        </div>
        <div class="row">
          <a class="pill" href="/ops">Ops</a>
          <a class="pill" href="/ops/queue">Queue</a>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div class="row spread" style="margin-bottom:12px;">
          <strong>משימה חדשה</strong>
          <div class="toolbar">
            <label class="pill toggle-pill"><input id="compactToggle" type="checkbox" checked /> compact</label>
            <input id="searchInput" class="search" type="search" placeholder="חפש משימה או איש קשר" />
          </div>
        </div>
        <form id="createTaskForm">
          <div class="form-grid">
            <input name="title" placeholder="שם המשימה" required />
            <select name="status">
              <option value="open">open</option>
              <option value="follow-up">follow-up</option>
              <option value="waiting">waiting</option>
              <option value="blocked">blocked</option>
              <option value="done">done</option>
            </select>
            <select name="priority">
              <option value="normal">normal</option>
              <option value="high">high</option>
              <option value="urgent">urgent</option>
              <option value="low">low</option>
            </select>
            <input name="next_step" placeholder="צעד הבא" />
            <input type="date" name="due_date" placeholder="תאריך follow-up" />
            <select name="task_type">
              <option value="ask-ai">לבקש ממני / AI</option>
              <option value="remember">לזכור / לשמור</option>
              <option value="task">כללי</option>
            </select>
          </div>
          <div style="margin-top:10px;"><textarea name="description" placeholder="תיאור קצר של המשימה"></textarea></div>
          <div style="margin-top:10px;"><button type="submit">הוסף משימה</button></div>
        </form>
        <div class="form-grid" style="margin-top:14px;">
          <select id="statusFilter">
            <option value="all">כל הסטטוסים</option>
            <option value="active" selected>רק פעילות</option>
            <option value="open">open</option>
            <option value="follow-up">follow-up</option>
            <option value="waiting">waiting</option>
            <option value="blocked">blocked</option>
            <option value="done">done</option>
          </select>
          <select id="priorityFilter">
            <option value="all">כל הדחיפויות</option>
            <option value="urgent">urgent</option>
            <option value="high">high</option>
            <option value="normal">normal</option>
            <option value="low">low</option>
          </select>
          <select id="contactFilter">
            <option value="all">כל המשימות</option>
            <option value="with-contacts">עם אנשי קשר</option>
            <option value="without-contacts">בלי אנשי קשר</option>
            <option value="pending">עם שיחות ממתינות</option>
            <option value="contacted">עם אנשי קשר שטופלו</option>
          </select>
          <select id="typeFilter">
            <option value="all">כל הסוגים</option>
            <option value="ask-ai">משימות לבקש ממני / AI</option>
            <option value="remember">משימות לזכור / לשמור</option>
            <option value="task">כללי</option>
          </select>
          <select id="captureFilter">
            <option value="all">כל דרכי הכניסה</option>
            <option value="explicit-task">נוסף כמשימה מפורשת</option>
            <option value="conversation-derived">נלקח מתוך שיחה</option>
          </select>
        </div>
        <div class="tiny" style="margin-top:8px;">המשימות הפעילות עולות אוטומטית למעלה.</div>
      </div>

      <div id="stats" class="stats"></div>
      <div id="focus"></div>
      <div id="tasks" class="task-grid"></div>
    </div>

    <script>
      const state = { tasks: [], filter: '', compactMode: true, filters: { status: 'active', priority: 'all', contacts: 'all', type: 'all', capture: 'all' } };

      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function formatTime(value) {
        if (!value) return 'עוד לא עודכן';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'עוד לא עודכן';
        return date.toISOString().slice(0, 16).replace('T', ' ');
      }

      function formToObject(form) {
        const data = new FormData(form);
        const out = {};
        data.forEach((value, key) => { out[key] = typeof value === 'string' ? value.trim() : value; });
        return out;
      }

      async function postJson(url, method, body) {
        const response = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        });
        const payload = await response.json().catch(() => ({ ok: false, error: 'bad response' }));
        if (!response.ok || payload.ok === false) throw new Error(payload.error || 'request failed');
        return payload;
      }

      function renderStats(tasks) {
        const contacts = tasks.reduce((sum, task) => sum + (task.stats ? task.stats.contacts : 0), 0);
        const openTasks = tasks.filter(task => !['done', 'closed'].includes(String(task.status || '').toLowerCase())).length;
        const pendingCalls = tasks.filter(task => task.stats && task.stats.pending).length;
        const values = [
          ['סה"כ משימות', tasks.length],
          ['פתוחות', openTasks],
          ['אנשי קשר', contacts],
          ['משימות עם שיחות ממתינות', pendingCalls]
        ];
        return values.map(function(item) {
          return '<div class="card"><div class="tiny">' + escapeHtml(item[0]) + '</div><div style="font-size:28px;font-weight:700;">' + escapeHtml(item[1]) + '</div></div>';
        }).join('');
      }

      function renderExpandableText(text, previewLength, label) {
        const value = String(text || '').trim();
        if (!value) return '';
        if (value.length <= previewLength) {
          return '<div class="task-desc">' + escapeHtml(value) + '</div>';
        }
        return '<details class="expandable">'
          + '<summary><span class="preview">' + escapeHtml(value.slice(0, previewLength)) + '...</span><span class="tiny">' + escapeHtml(label || 'הצג יותר') + '</span></summary>'
          + '<div class="expand-body">' + escapeHtml(value) + '</div>'
          + '</details>';
      }

      function renderActivities(activities) {
        if (!activities || !activities.length) return '<div class="tiny">אין עדיין היסטוריה</div>';
        return activities.map(function(activity) {
          const bits = [];
          if (activity.type) bits.push(activity.type);
          if (activity.status_after) bits.push('status: ' + activity.status_after);
          if (activity.next_step) bits.push('next: ' + activity.next_step);
          return '<div class="timeline-item">'
            + '<div class="tiny">' + escapeHtml(formatTime(activity.timestamp)) + (bits.length ? ' • ' + escapeHtml(bits.join(' | ')) : '') + '</div>'
            + renderExpandableText(activity.summary, 150, 'הצג יותר')
            + (activity.proposal ? renderExpandableText('Proposal: ' + activity.proposal, 140, 'הצעה מלאה') : '')
            + (activity.outcome ? renderExpandableText('Outcome: ' + activity.outcome, 120, 'תוצאה מלאה') : '')
            + '</div>';
        }).join('');
      }

      function isActiveTask(task) {
        return !['done', 'closed'].includes(String(task.status || '').toLowerCase());
      }

      function getVisibleTasks() {
        return (state.tasks || [])
          .slice()
          .sort(function(a, b) {
            const activeDiff = Number(isActiveTask(b)) - Number(isActiveTask(a));
            if (activeDiff !== 0) return activeDiff;
            const pendingDiff = Number(Boolean(b.stats && b.stats.pending)) - Number(Boolean(a.stats && a.stats.pending));
            if (pendingDiff !== 0) return pendingDiff;
            const aRecent = Math.max(Date.parse(a.last_contact_at || 0) || 0, Date.parse(a.updated_at || 0) || 0);
            const bRecent = Math.max(Date.parse(b.last_contact_at || 0) || 0, Date.parse(b.updated_at || 0) || 0);
            return bRecent - aRecent;
          })
          .filter(function(task) {
            const statusFilter = state.filters.status;
            const priorityFilter = state.filters.priority;
            const contactFilter = state.filters.contacts;
            const typeFilter = state.filters.type;
            const captureFilter = state.filters.capture;
            if (state.filter) {
              const searchable = [task.title, task.description, task.next_step, task.task_notes]
                .concat((task.contacts || []).map(function(contact) {
                  return [contact.name, contact.company, contact.phone, contact.progress_summary, contact.proposal_summary].join(' ');
                }))
                .join(' ')
                .toLowerCase();
              if (!searchable.includes(state.filter)) return false;
            }
            if (statusFilter === 'active' && !isActiveTask(task)) return false;
            if (statusFilter !== 'all' && statusFilter !== 'active' && String(task.status || '') !== statusFilter) return false;
            if (priorityFilter !== 'all' && String(task.priority || '') !== priorityFilter) return false;
            if (contactFilter === 'with-contacts' && !(task.stats && task.stats.contacts > 0)) return false;
            if (contactFilter === 'without-contacts' && task.stats && task.stats.contacts > 0) return false;
            if (contactFilter === 'pending' && !(task.stats && task.stats.pending > 0)) return false;
            if (contactFilter === 'contacted' && !(task.stats && task.stats.contacted > 0)) return false;
            if (typeFilter !== 'all' && String(task.task_type || 'task') !== typeFilter) return false;
            if (captureFilter !== 'all' && String(task.capture_mode || 'conversation-derived') !== captureFilter) return false;
            return true;
          });
      }

      function dueDateInfo(task) {
        const raw = String(task.due_date || '').trim();
        if (!raw) return null;
        const due = new Date(raw + 'T00:00:00Z');
        if (Number.isNaN(due.getTime())) return { label: raw, rank: 4 };
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
        if (diffDays < 0) return { label: 'Overdue', rank: 0, className: 'warn' };
        if (diffDays === 0) return { label: 'Today', rank: 1, className: 'good' };
        if (diffDays === 1) return { label: 'Tomorrow', rank: 2, className: '' };
        return { label: 'Follow-up ' + raw, rank: 3, className: '' };
      }

      function getFocusTasks(tasks) {
        return (tasks || [])
          .filter(function(task) { return isActiveTask(task); })
          .slice()
          .sort(function(a, b) {
            const dueDiff = (dueDateInfo(a)?.rank ?? 5) - (dueDateInfo(b)?.rank ?? 5);
            if (dueDiff !== 0) return dueDiff;
            const priorityWeight = { urgent: 0, high: 1, normal: 2, low: 3 };
            const priorityDiff = (priorityWeight[a.priority] ?? 9) - (priorityWeight[b.priority] ?? 9);
            if (priorityDiff !== 0) return priorityDiff;
            const pendingDiff = Number(Boolean(b.stats && b.stats.pending)) - Number(Boolean(a.stats && a.stats.pending));
            if (pendingDiff !== 0) return pendingDiff;
            const aRecent = Math.max(Date.parse(a.last_contact_at || 0) || 0, Date.parse(a.updated_at || 0) || 0);
            const bRecent = Math.max(Date.parse(b.last_contact_at || 0) || 0, Date.parse(b.updated_at || 0) || 0);
            return bRecent - aRecent;
          })
          .slice(0, 5);
      }

      function renderFocusSection(tasks) {
        const focusTasks = getFocusTasks(tasks);
        if (!focusTasks.length) return '';
        return '<div class="section-title">היום הכי חשוב</div>'
          + '<div class="focus-grid">'
          + focusTasks.map(function(task) {
            const due = dueDateInfo(task);
            return '<div class="focus-card">'
              + '<div class="tiny">' + escapeHtml(task.id) + '</div>'
              + '<strong>' + escapeHtml(task.title) + '</strong>'
              + '<div class="row" style="margin-top:8px;">'
              + '<span class="pill">' + escapeHtml(task.priority) + '</span>'
              + '<span class="pill">' + escapeHtml(task.status) + '</span>'
              + (due ? '<span class="pill ' + escapeHtml(due.className || '') + '">' + escapeHtml(due.label) + '</span>' : '')
              + '</div>'
              + (task.next_step ? '<div class="tiny" style="margin-top:8px;">Next: ' + escapeHtml(task.next_step) + '</div>' : '')
              + (task.stats && task.stats.pending ? '<div class="tiny" style="margin-top:6px;">יש שיחות ממתינות</div>' : '')
              + '</div>';
          }).join('')
          + '</div>';
      }

      function renderContact(task, contact) {
        return '<div class="contact-card">'
          + '<div class="row spread"><strong>' + escapeHtml(contact.name || 'Unnamed contact') + '</strong>'
          + '<span class="pill ' + (['to-call', 'new'].includes(String(contact.status || '').toLowerCase()) ? 'warn' : 'good') + '">' + escapeHtml(contact.status || 'to-call') + '</span></div>'
          + '<div class="tiny">' + escapeHtml(contact.phone || 'No phone') + (contact.company ? ' • ' + escapeHtml(contact.company) : '') + (contact.role ? ' • ' + escapeHtml(contact.role) : '') + '</div>'
          + (contact.progress_summary ? renderExpandableText(contact.progress_summary, 140, 'התקדמות מלאה') : '<div style="margin-top:8px;"><span class="tiny">אין עדיין התקדמות מתועדת</span></div>')
          + (contact.proposal_summary ? renderExpandableText('Proposal: ' + contact.proposal_summary, 120, 'הצעה מלאה') : '')
          + (contact.next_step ? '<div class="tiny" style="margin-top:6px;">Next: ' + escapeHtml(contact.next_step) + '</div>' : '')
          + '<div class="tiny" style="margin-top:6px;">Last contact: ' + escapeHtml(formatTime(contact.last_contact_at)) + '</div>'
          + '<details><summary>עדכון איש קשר</summary>'
          + '<form class="contact-update-form" data-task-id="' + escapeHtml(task.id) + '" data-contact-id="' + escapeHtml(contact.id) + '" style="margin-top:10px;">'
          + '<div class="form-grid">'
          + '<input name="name" value="' + escapeHtml(contact.name) + '" placeholder="שם" />'
          + '<input name="phone" value="' + escapeHtml(contact.phone) + '" placeholder="טלפון" />'
          + '<input name="company" value="' + escapeHtml(contact.company) + '" placeholder="חברה" />'
          + '<input name="role" value="' + escapeHtml(contact.role) + '" placeholder="תפקיד" />'
          + '<input name="relation" value="' + escapeHtml(contact.relation) + '" placeholder="קשר למשימה" />'
          + '<select name="status">'
          + ['to-call','reached','in-touch','waiting','interested','blocked','done'].map(function(option) {
              return '<option value="' + option + '"' + (String(contact.status) === option ? ' selected' : '') + '>' + option + '</option>';
            }).join('')
          + '</select>'
          + '</div>'
          + '<div style="margin-top:10px;"><textarea name="progress_summary" placeholder="איך התקדמתם">' + escapeHtml(contact.progress_summary || '') + '</textarea></div>'
          + '<div style="margin-top:10px;"><textarea name="proposal_summary" placeholder="מה הוא מציע">' + escapeHtml(contact.proposal_summary || '') + '</textarea></div>'
          + '<div style="margin-top:10px;"><textarea name="notes" placeholder="הערות">' + escapeHtml(contact.notes || '') + '</textarea></div>'
          + '<div style="margin-top:10px;"><input name="next_step" value="' + escapeHtml(contact.next_step || '') + '" placeholder="צעד הבא מולו" /></div>'
          + '<div style="margin-top:10px;"><button type="submit" class="secondary">שמור איש קשר</button></div>'
          + '</form>'
          + '</details>'
          + '<details><summary>לוג שיחה / פגישה</summary>'
          + '<form class="activity-form" data-task-id="' + escapeHtml(task.id) + '" data-contact-id="' + escapeHtml(contact.id) + '" style="margin-top:10px;">'
          + '<div class="form-grid">'
          + '<select name="type"><option value="call">call</option><option value="meeting">meeting</option><option value="message">message</option><option value="note">note</option></select>'
          + '<select name="status_after"><option value="">status after</option><option value="to-call">to-call</option><option value="reached">reached</option><option value="in-touch">in-touch</option><option value="waiting">waiting</option><option value="interested">interested</option><option value="blocked">blocked</option><option value="done">done</option></select>'
          + '<input name="next_step" placeholder="צעד הבא" />'
          + '</div>'
          + '<div style="margin-top:10px;"><textarea name="summary" placeholder="מה קרה בשיחה"></textarea></div>'
          + '<div style="margin-top:10px;"><textarea name="proposal" placeholder="מה הוא הציע"></textarea></div>'
          + '<div style="margin-top:10px;"><input name="outcome" placeholder="תוצאה / החלטה" /></div>'
          + '<div style="margin-top:10px;"><button type="submit">הוסף לוג</button></div>'
          + '</form>'
          + '</details>'
          + '<div class="section-title">היסטוריה</div>'
          + '<div class="timeline">' + renderActivities(contact.activities || []) + '</div>'
          + '</div>';
      }

      function renderTask(task) {
        const contactHtml = task.contacts && task.contacts.length
          ? task.contacts.map(function(contact) { return renderContact(task, contact); }).join('')
          : '<div class="empty">אין עדיין אנשי קשר למשימה הזאת</div>';

        return '<div class="task-card">'
          + '<div class="row spread">'
          + '<div><div class="tiny">' + escapeHtml(task.id) + '</div><h2 class="task-title">' + escapeHtml(task.title) + '</h2></div>'
          + '<div class="row">'
          + '<span class="pill">' + escapeHtml(task.status) + '</span>'
          + '<span class="pill">' + escapeHtml(task.priority) + '</span>'
          + '<span class="pill">' + escapeHtml(task.task_type || 'task') + '</span>'
          + '<span class="pill">' + escapeHtml(task.capture_mode || 'conversation-derived') + '</span>'
          + '<span class="pill ' + (task.stats && task.stats.pending ? 'warn' : 'good') + '">' + escapeHtml((task.stats && task.stats.contacts) || 0) + ' contacts</span>'
          + (task.monday_url ? '<a class="pill" href="' + escapeHtml(task.monday_url) + '" target="_blank" rel="noreferrer">Monday</a>' : '')
          + '</div></div>'
          + (task.description ? renderExpandableText(task.description, 220, 'תיאור מלא') : '')
          + ((task.capture_mode === 'conversation-derived' && task.source_text) ? renderExpandableText(task.source_text, 240, 'שיחה מלאה') : '')
          + (task.task_notes ? renderExpandableText('Notes: ' + task.task_notes, 160, 'הערות מלאות') : '')
          + '<div class="row">'
          + (task.next_step ? '<span class="pill warn">Next: ' + escapeHtml(task.next_step) + '</span>' : '')
          + (task.due_date ? '<span class="pill">Follow-up: ' + escapeHtml(task.due_date) + '</span>' : '')
          + '<span class="pill">Updated: ' + escapeHtml(formatTime(task.updated_at)) + '</span>'
          + (task.last_contact_at ? '<span class="pill good">Last contact: ' + escapeHtml(formatTime(task.last_contact_at)) + '</span>' : '')
          + '</div>'
          + '<details style="margin-top:14px;"><summary>עדכון משימה</summary>'
          + '<form class="task-update-form" data-task-id="' + escapeHtml(task.id) + '" style="margin-top:10px;">'
          + '<div class="form-grid">'
          + '<select name="status">'
          + ['open','follow-up','waiting','blocked','done'].map(function(option) {
              return '<option value="' + option + '"' + (String(task.status) === option ? ' selected' : '') + '>' + option + '</option>';
            }).join('')
          + '</select>'
          + '<select name="priority">'
          + ['low','normal','high','urgent'].map(function(option) {
              return '<option value="' + option + '"' + (String(task.priority) === option ? ' selected' : '') + '>' + option + '</option>';
            }).join('')
          + '</select>'
          + '<input name="next_step" value="' + escapeHtml(task.next_step || '') + '" placeholder="צעד הבא" />'
          + '<input type="date" name="due_date" value="' + escapeHtml(task.due_date || '') + '" placeholder="תאריך follow-up" />'
          + '<select name="task_type">'
          + ['ask-ai','remember','task'].map(function(option) {
              return '<option value="' + option + '"' + (String(task.task_type || 'task') === option ? ' selected' : '') + '>' + option + '</option>';
            }).join('')
          + '</select>'
          + '</div>
          + '<div style="margin-top:10px;"><textarea name="task_notes" placeholder="הערות על המשימה">' + escapeHtml(task.task_notes || '') + '</textarea></div>'
          + '<div style="margin-top:10px;"><button type="submit" class="secondary">שמור משימה</button></div>'
          + '</form>'
          + '</details>'
          + '<div class="section-title">הוסף איש קשר</div>'
          + '<form class="contact-add-form" data-task-id="' + escapeHtml(task.id) + '">'
          + '<div class="form-grid">'
          + '<input name="name" placeholder="שם" required />'
          + '<input name="phone" placeholder="טלפון" />'
          + '<input name="company" placeholder="חברה" />'
          + '<input name="role" placeholder="תפקיד" />'
          + '<input name="relation" placeholder="איך הוא קשור למשימה" />'
          + '<select name="status"><option value="to-call">to-call</option><option value="reached">reached</option><option value="waiting">waiting</option><option value="interested">interested</option></select>'
          + '</div>'
          + '<div style="margin-top:10px;"><input name="next_step" placeholder="מה תרצה לעשות מולו" /></div>'
          + '<div style="margin-top:10px;"><textarea name="notes" placeholder="הערות ראשוניות"></textarea></div>'
          + '<div style="margin-top:10px;"><button type="submit">הוסף איש קשר</button></div>'
          + '</form>'
          + '<div class="section-title">אנשים במשימה</div>'
          + '<div class="contact-grid">' + contactHtml + '</div>'
          + '</div>';
      }

      function applyCompactMode() {
        document.body.classList.toggle('compact-mode', Boolean(state.compactMode));
      }

      function render() {
        const visibleTasks = getVisibleTasks();
        document.getElementById('stats').innerHTML = renderStats(visibleTasks);
        document.getElementById('focus').innerHTML = renderFocusSection(visibleTasks);
        const html = visibleTasks.map(renderTask).filter(Boolean).join('');
        document.getElementById('tasks').innerHTML = html || '<div class="empty">אין עדיין משימות תואמות</div>';
        applyCompactMode();
      }

      async function load() {
        const response = await fetch('/api/task-hub');
        const payload = await response.json();
        state.tasks = payload.tasks || [];
        render();
      }

      document.getElementById('searchInput').addEventListener('input', function(event) {
        state.filter = String(event.target.value || '').trim().toLowerCase();
        render();
      });

      document.getElementById('statusFilter').addEventListener('change', function(event) {
        state.filters.status = String(event.target.value || 'all');
        render();
      });

      document.getElementById('priorityFilter').addEventListener('change', function(event) {
        state.filters.priority = String(event.target.value || 'all');
        render();
      });

      document.getElementById('contactFilter').addEventListener('change', function(event) {
        state.filters.contacts = String(event.target.value || 'all');
        render();
      });

      document.getElementById('typeFilter').addEventListener('change', function(event) {
        state.filters.type = String(event.target.value || 'all');
        render();
      });

      document.getElementById('captureFilter').addEventListener('change', function(event) {
        state.filters.capture = String(event.target.value || 'all');
        render();
      });

      document.getElementById('compactToggle').addEventListener('change', function(event) {
        state.compactMode = Boolean(event.target.checked);
        render();
      });

      document.getElementById('createTaskForm').addEventListener('submit', async function(event) {
        event.preventDefault();
        const form = event.currentTarget;
        try {
          await postJson('/api/task-hub/tasks', 'POST', formToObject(form));
          form.reset();
          await load();
        } catch (error) {
          alert(error.message);
        }
      });

      document.addEventListener('submit', async function(event) {
        const form = event.target;
        if (!(form instanceof HTMLFormElement)) return;
        try {
          if (form.classList.contains('task-update-form')) {
            event.preventDefault();
            await postJson('/api/task-hub/tasks/' + encodeURIComponent(form.dataset.taskId), 'PATCH', formToObject(form));
            await load();
          }
          if (form.classList.contains('contact-add-form')) {
            event.preventDefault();
            await postJson('/api/task-hub/tasks/' + encodeURIComponent(form.dataset.taskId) + '/contacts', 'POST', formToObject(form));
            form.reset();
            await load();
          }
          if (form.classList.contains('contact-update-form')) {
            event.preventDefault();
            await postJson('/api/task-hub/tasks/' + encodeURIComponent(form.dataset.taskId) + '/contacts/' + encodeURIComponent(form.dataset.contactId), 'PATCH', formToObject(form));
            await load();
          }
          if (form.classList.contains('activity-form')) {
            event.preventDefault();
            await postJson('/api/task-hub/tasks/' + encodeURIComponent(form.dataset.taskId) + '/contacts/' + encodeURIComponent(form.dataset.contactId) + '/activity', 'POST', formToObject(form));
            form.reset();
            await load();
          }
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
  buildTaskHubSnapshot,
  createTaskHubTask,
  updateTaskHubTask,
  addTaskContact,
  updateTaskContact,
  addTaskContactActivity,
  renderTaskHubPage
};
