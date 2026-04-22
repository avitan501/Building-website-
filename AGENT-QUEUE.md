# Agent Queue

This is the multi-brain queue for `/root/mysite`.

## Architecture
- Local task store (`tasks.json`) is the source of truth.
- Monday.com is a live mirror for visibility.
- Cheap router brain decides which worker should handle a queued task.
- Smart worker executes the task and writes the result back onto the task.
- Night runner processes tasks marked with `queue_run_mode: "night"` during the configured UTC window.

## Why not make Monday the queue source?
Monday is great for visibility, status, and updates, but it is a weaker source of truth for retries, locks, run windows, background execution state, and model outputs. The safer design is:
- Local queue = truth
- Monday = mirror/dashboard

## API
- `GET /api/agent-queue/status`
- `GET /api/agent-queue/config`
- `POST /api/agent-queue/config`
- `GET /api/agent-queue/tasks`
- `POST /api/agent-queue/enqueue`
- `POST /api/agent-queue/process-next`
- `POST /api/agent-queue/run-night`

## Enqueue example
```json
{
  "text": "Plan and build a premium homepage for a construction company",
  "queue_run_mode": "night",
  "priority": "high",
  "category": "development"
}
```

## Notes
- Website-related queued work uses the isolated website-coder lane first.
- If Kimi fails inside the website-coder lane, it can still fall back to OpenAI.
- General queued work uses OpenAI directly.
