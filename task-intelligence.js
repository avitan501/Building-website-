const fs = require('fs');
const path = require('path');

const TASK_ID_PREFIX = 'TASK-';
const DEFAULT_MONDAY_FILES = [
  '/root/assistant-hub/.env',
  '/root/.env',
  '/root/ai-system/.env'
];

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8') || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function resolveMondayConfig() {
  const env = {
    MONDAY_API_TOKEN: process.env.MONDAY_API_TOKEN || '',
    MONDAY_BOARD_ID: process.env.MONDAY_BOARD_ID || ''
  };

  let sourceFile = 'process.env';
  if (!env.MONDAY_API_TOKEN || !env.MONDAY_BOARD_ID) {
    for (const filePath of DEFAULT_MONDAY_FILES) {
      const parsed = parseEnvFile(filePath);
      if (!env.MONDAY_API_TOKEN && parsed.MONDAY_API_TOKEN) env.MONDAY_API_TOKEN = parsed.MONDAY_API_TOKEN;
      if (!env.MONDAY_BOARD_ID && parsed.MONDAY_BOARD_ID) env.MONDAY_BOARD_ID = parsed.MONDAY_BOARD_ID;
      if (parsed.MONDAY_API_TOKEN || parsed.MONDAY_BOARD_ID) sourceFile = filePath;
      if (env.MONDAY_API_TOKEN && env.MONDAY_BOARD_ID) break;
    }
  }

  return {
    token: env.MONDAY_API_TOKEN,
    boardId: env.MONDAY_BOARD_ID,
    sourceFile
  };
}

async function mondayRequest(query, variables = {}) {
  const cfg = resolveMondayConfig();
  if (!cfg.token || !cfg.boardId) {
    return { skipped: true, reason: 'missing monday configuration' };
  }

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      Authorization: cfg.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map(error => error.message).join('; ') || `monday request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload.data;
}

async function getMondayBoard() {
  const cfg = resolveMondayConfig();
  if (!cfg.token || !cfg.boardId) {
    return { ok: false, configured: false, sourceFile: cfg.sourceFile };
  }

  const query = `
    query ($boardIds: [ID!]) {
      boards(ids: $boardIds) {
        id
        name
        url
        groups {
          id
          title
        }
        columns {
          id
          title
          type
        }
      }
    }
  `;

  const data = await mondayRequest(query, { boardIds: [String(cfg.boardId)] });
  const board = data?.boards?.[0] || null;
  return {
    ok: Boolean(board),
    configured: true,
    sourceFile: cfg.sourceFile,
    board
  };
}

function normalizeTaskText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTitle(value) {
  return normalizeTaskText(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function inferDueDate(text) {
  const value = normalizeTaskText(text).toLowerCase();
  const now = new Date();
  const formatDate = (date) => date.toISOString().slice(0, 10);

  if (value.includes('today') || value.includes('היום')) return formatDate(now);
  if (value.includes('tomorrow') || value.includes('מחר')) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + 1);
    return formatDate(date);
  }

  const match = value.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (!match) return '';
  const day = String(Number(match[1])).padStart(2, '0');
  const month = String(Number(match[2])).padStart(2, '0');
  const year = match[3] ? String(match[3]).padStart(4, '20') : String(now.getUTCFullYear());
  return `${year}-${month}-${day}`;
}

function inferPriority(text) {
  const value = normalizeTaskText(text).toLowerCase();
  if (value.includes('urgent') || value.includes('asap') || value.includes('today') || value.includes('immediately') || value.includes('דחוף') || value.includes('היום') || value.includes('מיידי')) return 'high';
  if (value.includes('soon') || value.includes('follow up') || value.includes('מעקב') || value.includes('בהמשך') || value.includes('כשאפשר')) return 'normal';
  return 'normal';
}

function inferCategory(text) {
  const value = normalizeTaskText(text).toLowerCase();
  if (value.includes('payment') || value.includes('invoice') || value.includes('bill') || value.includes('גביה') || value.includes('תשלום') || value.includes('חשבונית')) return 'payment';
  if (value.includes('supplier') || value.includes('vendor') || value.includes('ספק')) return 'supplier';
  if (value.includes('follow up') || value.includes('callback') || value.includes('call back') || value.includes('לחזור') || value.includes('מעקב')) return 'follow-up';
  if (value.includes('client') || value.includes('customer') || value.includes('לקוח')) return 'client';
  if (value.includes('build') || value.includes('develop') || value.includes('design') || value.includes('site') || value.includes('website') || value.includes('פיתוח') || value.includes('עיצוב') || value.includes('אתר')) return 'development';
  if (value.includes('server') || value.includes('deploy') || value.includes('bug') || value.includes('fix') || value.includes('שרת') || value.includes('תיקון') || value.includes('דיבאג')) return 'technical';
  return 'general';
}

function inferSuggestedStatus(task) {
  if (task.status) return task.status;
  if (task.category === 'follow-up') return 'follow-up';
  return 'open';
}

function inferTaskFromText(text, overrides = {}) {
  const cleanText = normalizeTaskText(text);
  const firstLine = cleanText.split('\n')[0] || cleanText;
  const title = normalizeTitle(overrides.title || firstLine).slice(0, 120);

  return {
    title,
    description: normalizeTaskText(overrides.description || cleanText),
    source_text: cleanText,
    due_date: overrides.due_date || overrides.dueDate || inferDueDate(cleanText),
    priority: overrides.priority || inferPriority(cleanText),
    category: overrides.category || inferCategory(cleanText),
    status: overrides.status || inferSuggestedStatus(overrides),
    source: overrides.source || 'chat'
  };
}

function nextTaskId(tasks) {
  let maxNumber = 1000;
  for (const task of tasks) {
    const match = String(task.id || '').match(/^TASK-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }
  return `${TASK_ID_PREFIX}${maxNumber + 1}`;
}

function ensureTaskIds(tasks) {
  let changed = false;
  let maxNumber = 1000;

  for (const task of tasks) {
    const match = String(task.id || '').match(/^TASK-(\d+)$/i);
    if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
  }

  for (const task of tasks) {
    if (!task.id) {
      maxNumber += 1;
      task.id = `${TASK_ID_PREFIX}${maxNumber}`;
      changed = true;
    }
  }

  return { tasks, changed };
}

function normalizeTaskRecord(input = {}, base = {}, allTasks = []) {
  return {
    id: input.id || base.id || nextTaskId(allTasks),
    title: normalizeTitle(input.title || base.title || 'Untitled task'),
    description: normalizeTaskText(input.description || base.description || ''),
    source_text: normalizeTaskText(input.source_text || input.sourceText || base.source_text || ''),
    status: input.status || base.status || 'open',
    priority: input.priority || base.priority || 'normal',
    category: input.category || base.category || 'general',
    due_date: input.due_date || input.dueDate || base.due_date || '',
    source: input.source || base.source || 'manual',
    monday_item_id: input.monday_item_id || input.mondayItemId || base.monday_item_id || '',
    monday_board_id: input.monday_board_id || input.mondayBoardId || base.monday_board_id || '',
    monday_group_id: input.monday_group_id || input.mondayGroupId || base.monday_group_id || '',
    monday_board_name: input.monday_board_name || input.mondayBoardName || base.monday_board_name || '',
    monday_url: input.monday_url || input.mondayUrl || base.monday_url || '',
    created_at: base.created_at || input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function readTasks(tasksFile) {
  const rawTasks = readJsonArray(tasksFile);
  const { tasks, changed } = ensureTaskIds(rawTasks);
  if (changed) writeJsonArray(tasksFile, tasks);
  return tasks;
}

function writeTasks(tasksFile, tasks) {
  writeJsonArray(tasksFile, tasks);
}

function findDuplicateTask(tasks, taskCandidate) {
  const normalizedTitle = normalizeTitle(taskCandidate.title).toLowerCase();
  return tasks.find(task => {
    if (String(task.status || '').toLowerCase() === 'done') return false;
    return normalizeTitle(task.title).toLowerCase() === normalizedTitle;
  }) || null;
}

function chooseGroup(board, task) {
  const groups = Array.isArray(board?.groups) ? board.groups : [];
  if (!groups.length) return '';

  const byCategory = {
    payment: ['payment', 'finance', 'גביה', 'תשלום'],
    supplier: ['supplier', 'vendors', 'ספק'],
    client: ['client', 'sales', 'לקוחות', 'לקוח'],
    'follow-up': ['follow', 'pending', 'מעקב'],
    development: ['dev', 'build', 'product', 'פיתוח', 'אתר'],
    technical: ['tech', 'ops', 'server', 'שרת']
  };

  const wanted = byCategory[task.category] || [];
  const matched = groups.find(group => wanted.some(keyword => group.title.toLowerCase().includes(keyword)));
  return matched?.id || groups[0].id;
}

function buildColumnValues(board, task) {
  const columns = Array.isArray(board?.columns) ? board.columns : [];
  const values = {};

  const dateColumn = columns.find(column => column.type === 'date');
  if (dateColumn && task.due_date) {
    values[dateColumn.id] = { date: task.due_date };
  }

  const textColumn = columns.find(column => ['text', 'long_text'].includes(column.type) && /summary|description|notes|details|הערות|תיאור/i.test(column.title));
  if (textColumn && (task.description || task.source_text)) {
    values[textColumn.id] = String(task.description || task.source_text).slice(0, 1900);
  }

  return Object.keys(values).length ? values : null;
}

function buildMondayUpdateBody(task) {
  const lines = [
    `Priority: ${task.priority}`,
    `Category: ${task.category}`,
    `Status: ${task.status}`
  ];

  if (task.due_date) lines.push(`Due: ${task.due_date}`);
  if (task.description) lines.push('', 'Description:', task.description);
  if (task.source_text && task.source_text !== task.description) lines.push('', 'Source text:', task.source_text);

  return lines.join('\n').trim();
}

async function syncTaskToMonday(task) {
  const boardInfo = await getMondayBoard();
  if (!boardInfo.configured) {
    return { skipped: true, reason: 'missing monday configuration' };
  }
  if (!boardInfo.ok || !boardInfo.board) {
    return { skipped: true, reason: 'monday board not found' };
  }

  const board = boardInfo.board;
  const groupId = chooseGroup(board, task);
  const columnValues = buildColumnValues(board, task);

  const createMutation = `
    mutation ($boardId: ID!, $groupId: String, $itemName: String!, $columnValues: JSON) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;

  const createData = await mondayRequest(createMutation, {
    boardId: String(board.id),
    groupId: groupId || null,
    itemName: task.title,
    columnValues: columnValues ? JSON.stringify(columnValues) : null
  });

  const itemId = createData?.create_item?.id;
  if (!itemId) throw new Error('monday did not return item id');

  const updateBody = buildMondayUpdateBody(task);
  if (updateBody) {
    const updateMutation = `
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
        }
      }
    `;
    await mondayRequest(updateMutation, {
      itemId: String(itemId),
      body: updateBody
    });
  }

  return {
    ok: true,
    itemId: String(itemId),
    boardId: String(board.id),
    boardName: board.name,
    groupId: groupId || '',
    boardUrl: board.url || ''
  };
}

async function createTaskFromText(tasksFile, text, overrides = {}) {
  const tasks = readTasks(tasksFile);
  const inferred = inferTaskFromText(text, overrides);
  const duplicate = findDuplicateTask(tasks, inferred);
  if (duplicate) {
    return { ok: true, deduped: true, task: duplicate, monday: null };
  }

  const task = normalizeTaskRecord(inferred, {}, tasks);
  tasks.unshift(task);
  writeTasks(tasksFile, tasks);

  let monday = null;
  try {
    monday = await syncTaskToMonday(task);
    if (monday?.ok) {
      task.monday_item_id = monday.itemId;
      task.monday_board_id = monday.boardId;
      task.monday_board_name = monday.boardName;
      task.monday_group_id = monday.groupId;
      task.monday_url = monday.boardUrl;
      task.updated_at = new Date().toISOString();
      writeTasks(tasksFile, tasks);
    }
  } catch (error) {
    monday = { ok: false, error: error.message };
  }

  return { ok: true, deduped: false, task, monday };
}

async function syncExistingTaskToMonday(tasksFile, taskId) {
  const tasks = readTasks(tasksFile);
  const index = tasks.findIndex(task => task.id === taskId);
  if (index === -1) return { ok: false, error: 'task not found' };

  const monday = await syncTaskToMonday(tasks[index]);
  if (monday?.ok) {
    tasks[index].monday_item_id = monday.itemId;
    tasks[index].monday_board_id = monday.boardId;
    tasks[index].monday_board_name = monday.boardName;
    tasks[index].monday_group_id = monday.groupId;
    tasks[index].monday_url = monday.boardUrl;
    tasks[index].updated_at = new Date().toISOString();
    writeTasks(tasksFile, tasks);
  }

  return { ok: true, task: tasks[index], monday };
}

module.exports = {
  readTasks,
  writeTasks,
  createTaskFromText,
  syncExistingTaskToMonday,
  getMondayBoard,
  inferTaskFromText,
  normalizeTaskRecord
};
