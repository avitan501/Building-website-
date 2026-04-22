const fs = require('fs');
const path = require('path');
const { writeTasks, normalizeTaskRecord } = require('./task-intelligence');
const {
  buildTaskHubSnapshot,
  updateTaskHubTask,
  addTaskContact,
  addTaskContactActivity,
  renderTaskHubPage
} = require('./task-hub');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const testDir = path.join(__dirname, 'data', 'test-artifacts-task-hub');
  fs.mkdirSync(testDir, { recursive: true });
  const tasksFile = path.join(testDir, 'tasks.json');

  const baseTask = normalizeTaskRecord({
    id: 'TASK-2001',
    title: 'Call suppliers for concrete',
    description: 'Need 3 supplier options and next best step',
    status: 'open',
    priority: 'high',
    source: 'test',
    queue_enabled: false
  }, {}, []);

  writeTasks(tasksFile, [baseTask]);

  const updatedTask = await updateTaskHubTask(tasksFile, 'TASK-2001', {
    next_step: 'Call 3 suppliers today',
    task_notes: 'Focus on price and delivery speed'
  }, { skipMondaySync: true });
  assert(updatedTask.ok, 'task update failed');
  assert(updatedTask.task.next_step === 'Call 3 suppliers today', 'task next step did not update');

  const addedContact = await addTaskContact(tasksFile, 'TASK-2001', {
    name: 'Yossi Cohen',
    phone: '+972501112233',
    company: 'Concrete Fast',
    role: 'sales',
    status: 'to-call',
    next_step: 'Ask for quote'
  }, { skipMondaySync: true });
  assert(addedContact.ok, 'contact add failed');
  const contactId = addedContact.contact.id;
  assert(contactId, 'contact id missing');

  const activity = await addTaskContactActivity(tasksFile, 'TASK-2001', contactId, {
    type: 'call',
    summary: 'Spoke with Yossi, he can deliver tomorrow.',
    proposal: 'Offered a better price for bulk order.',
    next_step: 'Send quantities tonight',
    status_after: 'waiting',
    outcome: 'Promising lead'
  }, { skipMondaySync: true });
  assert(activity.ok, 'activity add failed');

  const snapshot = buildTaskHubSnapshot(tasksFile);
  assert(snapshot.ok, 'snapshot failed');
  assert(snapshot.totals.tasks === 1, 'snapshot task count incorrect');
  assert(snapshot.totals.contacts === 1, 'snapshot contact count incorrect');
  assert(snapshot.tasks[0].contacts[0].proposal_summary.includes('better price'), 'proposal summary missing');
  assert(snapshot.tasks[0].contacts[0].status === 'waiting', 'contact status not updated from activity');
  assert(renderTaskHubPage().includes('/api/task-hub'), 'task hub page missing api wiring');

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, task: snapshot.tasks[0] }, null, 2));
}

main().catch(error => {
  console.error(error.message || String(error));
  process.exit(1);
});
