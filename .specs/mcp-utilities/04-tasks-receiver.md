# Spec: MCP Tasks Receiver (Server-to-Client)

## Metadata

| Field                | Value                                   |
| -------------------- | --------------------------------------- |
| **ID**               | `MCP-TASK-002`                          |
| **Title**            | Task-Augmented Requests (Receiver-Side) |
| **Status**           | ⚠️ VALIDATED (Blocker)                  |
| **Priority**         | P2                                      |
| **Dependencies**     | `03-tasks-core.md`                      |
| **Estimated Effort** | Large (6-8 hours)                       |
| **Spec Version**     | 1.0.0                                   |
| **Validated**        | 2026-01-17                              |
| **Codebase Status**  | 94% NOVEL, 6% PARTIAL                   |
| **Blockers**         | B-1: task.ask() AbortSignal support     |

## Overview

### Problem Statement

When servers send sampling/createMessage or elicitation/create requests to the client, they may want to use task augmentation for the same reasons clients do: non-blocking execution, status polling, and proper lifecycle management. Currently, we handle these requests synchronously—the server blocks waiting for the response.

### Solution Summary

Implement receiver-side task support for sampling and elicitation:

1. **Capability Declaration**: Declare `tasks.requests.sampling.createMessage` and `tasks.requests.elicitation.create`
2. **Task State Machine**: Create `TaskManager` to track task lifecycle
3. **Handler Modification**: When request includes `task` param, return `CreateTaskResult` immediately
4. **Request Handlers**: Implement `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` as request handlers
5. **Status Notifications**: Send `notifications/tasks/status` on state changes

### Success Criteria

- [ ] SC-1: Server can send task-augmented sampling request
- [ ] SC-2: Client returns CreateTaskResult immediately
- [ ] SC-3: Server can poll with tasks/get
- [ ] SC-4: Server gets actual result via tasks/result
- [ ] SC-5: Status notifications sent on state changes

## Architecture

### Task State Machine (Client as Receiver)

```
SERVER SENDS                           CLIENT HANDLES
sampling/createMessage                       │
+ task param                                 ▼
        │                             ┌──────────────┐
        │                             │   working    │
        └────────────────────────────►│              │
                                      └──────┬───────┘
                                             │
                                    ┌────────┴────────┐
                                    │                 │
                                    ▼                 ▼
                            ┌──────────────┐  ┌──────────────┐
                            │input_required│  │   (error)    │
                            │              │  │              │
                            │ (showing UI) │  │   failed     │
                            └──────┬───────┘  └──────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
                    ▼              ▼              ▼
            ┌──────────────┐ ┌──────────┐ ┌──────────────┐
            │  completed   │ │cancelled │ │   failed     │
            │              │ │          │ │              │
            │ (user approved)│ (cancelled)│ (user denied) │
            └──────────────┘ └──────────┘ └──────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           McpHub.ts                                  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │                     TaskManager (NEW)                           ││
│  │                                                                  ││
│  │  Manages lifecycle of tasks where WE are the receiver           ││
│  │                                                                  ││
│  │  - tasks: Map<taskId, ManagedTask>                              ││
│  │  - createTask(request) → taskId                                 ││
│  │  - updateStatus(taskId, status)                                 ││
│  │  - getTask(taskId) → Task                                       ││
│  │  - getResult(taskId) → Promise<result>                          ││
│  │  - setResult(taskId, result)                                    ││
│  │  - cancelTask(taskId)                                           ││
│  │  - listTasks() → Task[]                                         ││
│  │  - cleanup(taskId)                                              ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │              Modified Request Handlers                          ││
│  │                                                                  ││
│  │  sampling/createMessage:                                        ││
│  │    IF request has task param:                                   ││
│  │      → Create task, return CreateTaskResult                     ││
│  │      → Process async, update status                             ││
│  │    ELSE:                                                        ││
│  │      → Existing synchronous behavior                            ││
│  │                                                                  ││
│  │  elicitation/create: (same pattern)                             ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │              New Request Handlers (from server)                 ││
│  │                                                                  ││
│  │  tasks/get     → TaskManager.getTask(taskId)                   ││
│  │  tasks/result  → TaskManager.getResult(taskId) (may block)     ││
│  │  tasks/list    → TaskManager.listTasks()                       ││
│  │  tasks/cancel  → TaskManager.cancelTask(taskId)                ││
│  └──────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Protocol Flow (Server-to-Client Task)

```
SERVER (Requestor)                      CLIENT (Receiver)
       │                                      │
       │──sampling/createMessage + task──────►│
       │                                      │ TaskManager.createTask()
       │◄──CreateTaskResult (status: working)─│
       │                                      │
       │                                      │ (async) Show UI
       │                                      │ updateStatus("input_required")
       │                                      │
       │◄──notifications/tasks/status─────────│
       │                                      │
       │──tasks/get───────────────────────────►│
       │◄──Task (status: input_required)──────│
       │                                      │
       │──tasks/result────────────────────────►│ (blocks)
       │                                      │
       │                                      │ User approves
       │                                      │ setResult(samplingResult)
       │                                      │
       │◄──CreateMessageResult────────────────│
```

## Requirements

### Functional Requirements

| ID    | Requirement                                                               | Priority | Acceptance Criteria                   |
| ----- | ------------------------------------------------------------------------- | -------- | ------------------------------------- |
| FR-1  | Declare tasks.requests.sampling.createMessage capability                  | MUST     | Capability present in initialization  |
| FR-2  | Declare tasks.requests.elicitation.create capability                      | MUST     | Capability present in initialization  |
| FR-3  | Detect task param in sampling/elicitation requests                        | MUST     | Check `request.params.task`           |
| FR-4  | Generate unique task IDs                                                  | MUST     | Cryptographically secure, per spec    |
| FR-5  | Return CreateTaskResult for task-augmented requests                       | MUST     | Immediate response with taskId        |
| FR-6  | Process request asynchronously after task creation                        | MUST     | Don't block on user interaction       |
| FR-7  | Track task status (working, input_required, completed, failed, cancelled) | MUST     | State machine enforced                |
| FR-8  | Implement tasks/get handler                                               | MUST     | Returns current Task state            |
| FR-9  | Implement tasks/result handler                                            | MUST     | Blocks until terminal, returns result |
| FR-10 | Implement tasks/list handler                                              | SHOULD   | Paginated list of tasks               |
| FR-11 | Implement tasks/cancel handler                                            | MUST     | Moves task to cancelled, returns Task |
| FR-12 | Send notifications/tasks/status on state changes                          | SHOULD   | Per spec, optional but helpful        |
| FR-13 | Include io.modelcontextprotocol/related-task in results                   | MUST     | Link response to task                 |
| FR-14 | Respect TTL for task cleanup                                              | MUST     | Delete after TTL expires              |
| FR-15 | Reject cancel for terminal tasks with -32602                              | MUST     | Per spec error code                   |

### Non-Functional Requirements

| ID    | Requirement                                      | Priority | Metric                   |
| ----- | ------------------------------------------------ | -------- | ------------------------ |
| NFR-1 | Task ID must be cryptographically secure         | MUST     | Prevent guessing attacks |
| NFR-2 | Result retrieval must not leak to other contexts | MUST     | Task isolation           |
| NFR-3 | Memory cleanup for expired tasks                 | MUST     | No unbounded growth      |

## Technical Design

### Type Definitions

```typescript
// packages/types/src/mcp.ts - ADD

// Internal task management
export interface ManagedTask {
	taskId: string
	method: "sampling/createMessage" | "elicitation/create"
	status: TaskStatus
	statusMessage?: string
	createdAt: Date
	lastUpdatedAt: Date
	ttl: number | null
	pollInterval: number

	// Original request for replay/context
	originalRequest: unknown

	// Result storage (set when complete)
	result?: unknown
	error?: Error

	// Promise for tasks/result blocking
	resultPromise: Promise<unknown>
	resultResolve: (value: unknown) => void
	resultReject: (error: Error) => void

	// For cancellation
	abortController: AbortController
}
```

### TaskManager Class

```typescript
// src/services/mcp/TaskManager.ts - NEW

import { randomUUID } from "crypto"
import type { Task, TaskStatus, ManagedTask } from "@roo-code/types"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"

export class TaskManager {
	private tasks = new Map<string, ManagedTask>()
	private cleanupTimers = new Map<string, NodeJS.Timeout>()
	private sendNotification: (taskId: string, task: Task) => Promise<void>

	constructor(sendNotification: (taskId: string, task: Task) => Promise<void>) {
		this.sendNotification = sendNotification
	}

	/**
	 * Create a new task for an incoming request
	 */
	createTask(
		method: "sampling/createMessage" | "elicitation/create",
		originalRequest: unknown,
		requestedTtl?: number,
	): { taskId: string; task: Task } {
		const taskId = randomUUID()
		const now = new Date()
		const ttl = requestedTtl ?? 60000 // Default 1 minute
		const pollInterval = 2000 // 2 seconds

		let resultResolve!: (value: unknown) => void
		let resultReject!: (error: Error) => void
		const resultPromise = new Promise<unknown>((resolve, reject) => {
			resultResolve = resolve
			resultReject = reject
		})

		const managedTask: ManagedTask = {
			taskId,
			method,
			status: "working",
			createdAt: now,
			lastUpdatedAt: now,
			ttl,
			pollInterval,
			originalRequest,
			resultPromise,
			resultResolve,
			resultReject,
			abortController: new AbortController(),
		}

		this.tasks.set(taskId, managedTask)

		// Schedule TTL cleanup
		this.scheduleTtlCleanup(taskId, ttl)

		const task = this.toTask(managedTask)
		return { taskId, task }
	}

	/**
	 * Update task status
	 */
	async updateStatus(taskId: string, status: TaskStatus, statusMessage?: string): Promise<void> {
		const managed = this.tasks.get(taskId)
		if (!managed) return

		// Validate transition
		if (this.isTerminal(managed.status)) {
			throw new Error(`Cannot transition from terminal status ${managed.status}`)
		}

		managed.status = status
		managed.statusMessage = statusMessage
		managed.lastUpdatedAt = new Date()

		// Send notification
		await this.sendNotification(taskId, this.toTask(managed))
	}

	/**
	 * Set task result (moves to completed)
	 */
	async setResult(taskId: string, result: unknown): Promise<void> {
		const managed = this.tasks.get(taskId)
		if (!managed) return

		managed.status = "completed"
		managed.result = result
		managed.lastUpdatedAt = new Date()
		managed.resultResolve(result)

		await this.sendNotification(taskId, this.toTask(managed))
	}

	/**
	 * Set task error (moves to failed)
	 */
	async setError(taskId: string, error: Error): Promise<void> {
		const managed = this.tasks.get(taskId)
		if (!managed) return

		managed.status = "failed"
		managed.statusMessage = error.message
		managed.error = error
		managed.lastUpdatedAt = new Date()
		managed.resultReject(error)

		await this.sendNotification(taskId, this.toTask(managed))
	}

	/**
	 * Get task (for tasks/get handler)
	 */
	getTask(taskId: string): Task {
		const managed = this.tasks.get(taskId)
		if (!managed) {
			throw new McpError(ErrorCode.InvalidParams, "Task not found")
		}
		return this.toTask(managed)
	}

	/**
	 * Get task result (for tasks/result handler)
	 * Blocks until terminal status
	 */
	async getResult(taskId: string): Promise<unknown> {
		const managed = this.tasks.get(taskId)
		if (!managed) {
			throw new McpError(ErrorCode.InvalidParams, "Task not found")
		}

		// If already terminal, return immediately
		if (this.isTerminal(managed.status)) {
			if (managed.error) {
				throw managed.error
			}
			return managed.result
		}

		// Block until result available
		return managed.resultPromise
	}

	/**
	 * List all tasks (for tasks/list handler)
	 */
	listTasks(cursor?: string): { tasks: Task[]; nextCursor?: string } {
		// Simple implementation - no real pagination needed for few tasks
		const allTasks = Array.from(this.tasks.values()).map(this.toTask)
		return { tasks: allTasks }
	}

	/**
	 * Cancel task (for tasks/cancel handler)
	 */
	async cancelTask(taskId: string): Promise<Task> {
		const managed = this.tasks.get(taskId)
		if (!managed) {
			throw new McpError(ErrorCode.InvalidParams, "Task not found")
		}

		if (this.isTerminal(managed.status)) {
			throw new McpError(
				ErrorCode.InvalidParams,
				`Cannot cancel task: already in terminal status '${managed.status}'`,
			)
		}

		managed.status = "cancelled"
		managed.statusMessage = "Task cancelled by server"
		managed.lastUpdatedAt = new Date()
		managed.abortController.abort("Cancelled")
		managed.resultReject(new Error("Task cancelled"))

		await this.sendNotification(taskId, this.toTask(managed))
		return this.toTask(managed)
	}

	/**
	 * Get abort signal for task (used in handlers)
	 */
	getAbortSignal(taskId: string): AbortSignal | undefined {
		return this.tasks.get(taskId)?.abortController.signal
	}

	/**
	 * Clean up task
	 */
	cleanup(taskId: string): void {
		this.tasks.delete(taskId)
		const timer = this.cleanupTimers.get(taskId)
		if (timer) {
			clearTimeout(timer)
			this.cleanupTimers.delete(taskId)
		}
	}

	private scheduleTtlCleanup(taskId: string, ttl: number): void {
		const timer = setTimeout(() => {
			this.cleanup(taskId)
		}, ttl)
		this.cleanupTimers.set(taskId, timer)
	}

	private isTerminal(status: TaskStatus): boolean {
		return status === "completed" || status === "failed" || status === "cancelled"
	}

	private toTask(managed: ManagedTask): Task {
		return {
			taskId: managed.taskId,
			status: managed.status,
			statusMessage: managed.statusMessage,
			createdAt: managed.createdAt.toISOString(),
			lastUpdatedAt: managed.lastUpdatedAt.toISOString(),
			ttl: managed.ttl,
			pollInterval: managed.pollInterval,
		}
	}
}
```

### Modified Sampling Handler

```typescript
// In connectToServer(), modify sampling handler:

client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
  const provider = this.providerRef?.deref()
  if (!provider) {
    throw new McpError(ErrorCode.InternalError, "No active provider")
  }

  const task = provider.getCurrentTask()
  if (!task) {
    throw new McpError(ErrorCode.InternalError, "No active task")
  }

  // Check if this is a task-augmented request
  const taskParams = request.params.task
  if (taskParams) {
    // Create task and return immediately
    const { taskId, task: taskState } = this.taskManager.createTask(
      "sampling/createMessage",
      request.params,
      taskParams.ttl
    )

    // Process asynchronously
    this.processSamplingAsync(
      taskId,
      name,
      request.params,
      task,
      provider
    ).catch(err => {
      this.taskManager.setError(taskId, err)
    })

    // Return CreateTaskResult
    return { task: taskState }
  }

  // Existing synchronous handling...
  // (current implementation)
})

private async processSamplingAsync(
  taskId: string,
  serverName: string,
  params: CreateMessageRequest["params"],
  rooTask: Task,
  provider: ClineProvider
): Promise<void> {
  const abortSignal = this.taskManager.getAbortSignal(taskId)

  // Update status to input_required (showing UI)
  await this.taskManager.updateStatus(taskId, "input_required", "Awaiting user approval")

  // Build request for UI
  const samplingRequest: McpSamplingRequest = {
    // ... build from params
  }

  const askData: ClineAskUseMcpServer = {
    type: "mcp_sampling",
    serverName,
    samplingRequest,
  }

  try {
    const { response, text } = await rooTask.ask(
      "use_mcp_server",
      JSON.stringify(askData),
      { signal: abortSignal }
    )

    if (response === "noButtonClicked") {
      await this.taskManager.setError(taskId, new Error("User declined sampling request"))
      return
    }

    // Build result
    const result = {
      role: "assistant" as const,
      content: { type: "text" as const, text: "..." },
      model: "...",
      stopReason: "endTurn" as const,
      _meta: {
        [RELATED_TASK_META_KEY]: { taskId }
      }
    }

    await this.taskManager.setResult(taskId, result)
  } catch (error) {
    if (error.name === "AbortError") {
      // Cancelled - already handled
      return
    }
    await this.taskManager.setError(taskId, error)
  }
}
```

### Task Request Handlers

```typescript
// In connectToServer(), add task handlers:

// tasks/get handler
client.setRequestHandler(GetTaskRequestSchema, async (request) => {
	return this.taskManager.getTask(request.params.taskId)
})

// tasks/result handler
client.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
	const result = await this.taskManager.getResult(request.params.taskId)
	return {
		...result,
		_meta: {
			[RELATED_TASK_META_KEY]: { taskId: request.params.taskId },
		},
	}
})

// tasks/list handler
client.setRequestHandler(ListTasksRequestSchema, async (request) => {
	return this.taskManager.listTasks(request.params.cursor)
})

// tasks/cancel handler
client.setRequestHandler(CancelTaskRequestSchema, async (request) => {
	return this.taskManager.cancelTask(request.params.taskId)
})
```

### Capability Declaration Update

```typescript
// Update capabilities to include receiver-side task support:

capabilities: {
  roots: { listChanged: true },
  sampling: {},
  elicitation: { form: {} },
  tasks: {
    list: {},
    cancel: {},
    requests: {
      tools: { call: {} },
      sampling: { createMessage: {} },  // NEW: We accept task-augmented sampling
      elicitation: { create: {} }       // NEW: We accept task-augmented elicitation
    }
  }
}
```

## Test Plan

### Unit Tests

| Test ID | Description                                           | Expected Result          |
| ------- | ----------------------------------------------------- | ------------------------ |
| UT-1    | TaskManager.createTask() generates unique IDs         | 1000 IDs all unique      |
| UT-2    | TaskManager.updateStatus() enforces valid transitions | Error on invalid         |
| UT-3    | TaskManager.setResult() resolves resultPromise        | Promise resolves         |
| UT-4    | TaskManager.cancelTask() aborts signal                | AbortSignal.aborted true |
| UT-5    | TaskManager.cancelTask() rejects terminal             | McpError thrown          |
| UT-6    | TTL cleanup removes task                              | Task not found after TTL |

### Integration Tests

| Test ID | Description                                      | Expected Result              |
| ------- | ------------------------------------------------ | ---------------------------- |
| IT-1    | Task-augmented sampling returns CreateTaskResult | Immediate response           |
| IT-2    | tasks/get returns current status                 | Correct Task object          |
| IT-3    | tasks/result blocks until completion             | Returns after user action    |
| IT-4    | tasks/cancel aborts UI flow                      | Task cancelled, UI dismissed |

### Test Scenario

```javascript
// From test server perspective:

// 1. Send task-augmented sampling
const createResult = await client.request({
	method: "sampling/createMessage",
	params: {
		messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
		maxTokens: 100,
		task: { ttl: 60000 },
	},
})
console.log("Task created:", createResult.task.taskId)

// 2. Poll for status
let task = createResult.task
while (task.status === "working" || task.status === "input_required") {
	await sleep(task.pollInterval)
	task = await client.request({
		method: "tasks/get",
		params: { taskId: task.taskId },
	})
	console.log("Status:", task.status)
}

// 3. Get result
if (task.status === "completed") {
	const result = await client.request({
		method: "tasks/result",
		params: { taskId: task.taskId },
	})
	console.log("Result:", result)
}
```

## Implementation Checklist

- [ ] Update capability declaration with tasks.requests.sampling/elicitation
- [ ] Create `TaskManager` class in `src/services/mcp/TaskManager.ts`
- [ ] Add `taskManager` instance to `McpHub`
- [ ] Modify sampling handler for task detection
- [ ] Add `processSamplingAsync` method
- [ ] Modify elicitation handler for task detection
- [ ] Add `processElicitationAsync` method
- [ ] Register `tasks/get` handler
- [ ] Register `tasks/result` handler
- [ ] Register `tasks/list` handler
- [ ] Register `tasks/cancel` handler
- [ ] Add status notification sending
- [ ] Implement TTL cleanup
- [ ] Write unit tests for `TaskManager`
- [ ] Run `pnpm check-types` - exit 0
- [ ] Run `pnpm lint` - no new warnings

## Risks and Mitigations

| Risk                                    | Likelihood | Impact | Mitigation                 |
| --------------------------------------- | ---------- | ------ | -------------------------- |
| task.ask() doesn't support abort signal | High       | High   | Need to verify/add support |
| Memory leak from long-lived tasks       | Medium     | Medium | Strict TTL enforcement     |
| Race between cancel and completion      | Medium     | Low    | State machine validation   |

## References

- [MCP Tasks Spec](ai_docs/mcp-2025-11-25/modelcontextprotocol.io_specification_2025-11-25_basic_utilities_tasks.md)
- [Tasks Core Spec](./03-tasks-core.md) (dependency)
- [Implementation State](.claude/mcp-implementation-state.json)
