# Spec: MCP Tasks Core (Client-Side)

## Metadata

| Field                | Value                                   |
| -------------------- | --------------------------------------- |
| **ID**               | `MCP-TASK-001`                          |
| **Title**            | Task-Augmented Requests (Client-Side)   |
| **Status**           | ✅ VALIDATED                            |
| **Priority**         | P1                                      |
| **Dependencies**     | `01-progress.md`, `02-cancellation.md`  |
| **Estimated Effort** | Large (6-8 hours)                       |
| **Spec Version**     | 1.0.0                                   |
| **Validated**        | 2026-01-17                              |
| **Codebase Status**  | 100% NOVEL                              |
| **Blockers**         | None (depends on 02 blocker resolution) |

## Overview

### Problem Statement

Some MCP tool calls represent expensive computations or batch operations that don't return immediately. Currently, these operations block the entire flow—the client waits synchronously for potentially minutes. There's no way to:

- Check on the status of a long-running operation
- Continue other work while waiting
- Get partial progress updates
- Cancel a running operation properly

### Solution Summary

Implement task-augmented request support per MCP 2025-11-25 spec:

1. **Task Creation**: Send `tools/call` with `task` param, receive `CreateTaskResult`
2. **Polling**: Use `tasks/get` to check status (working, input_required, completed, failed, cancelled)
3. **Result Retrieval**: Use `tasks/result` to get final result when complete
4. **Management**: Support `tasks/list` and `tasks/cancel`
5. **Notifications**: Handle `notifications/tasks/status` for push updates

### Success Criteria

- [ ] SC-1: Tool calls can be task-augmented when server supports it
- [ ] SC-2: Client polls for task status respecting pollInterval
- [ ] SC-3: Results retrieved via tasks/result when task completes
- [ ] SC-4: UI shows task status and allows cancellation
- [ ] SC-5: Capability negotiation respects server's execution.taskSupport

## Architecture

### Task Lifecycle State Machine

```
                    ┌─────────────┐
                    │   (start)   │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
        ┌──────────│   working   │──────────┐
        │          └──────┬──────┘          │
        │                 │                 │
        │     ┌───────────┴───────────┐     │
        │     │                       │     │
        ▼     ▼                       ▼     ▼
┌──────────────────┐           ┌──────────────────┐
│  input_required  │◄─────────►│    (terminal)    │
└──────────────────┘           │                  │
        │                      │  • completed     │
        │                      │  • failed        │
        └─────────────────────►│  • cancelled     │
                               └──────────────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           McpHub.ts                                  │
│                                                                      │
│  ┌─────────────────────────┐    ┌─────────────────────────────────┐│
│  │    TaskPoller           │    │      Task API Methods           ││
│  │    (new class)          │    │                                 ││
│  │                         │    │  callToolAsTask(...)            ││
│  │  - activeTasks: Map     │◄───│  getTask(taskId)                ││
│  │  - pollTask()           │    │  getTaskResult(taskId)          ││
│  │  - startPolling()       │    │  listTasks()                    ││
│  │  - stopPolling()        │    │  cancelTask(taskId)             ││
│  │  - handleNotification() │    │                                 ││
│  └──────────┬──────────────┘    └─────────────────────────────────┘│
│             │                                                        │
│             ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Notification Handler: "notifications/tasks/status"            ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         WebView UI                                   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  TaskStatusIndicator.tsx                                        ││
│  │                                                                  ││
│  │  Shows: status, statusMessage, progress, cancel button          ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Protocol Flow

```
CLIENT                              SERVER
   │                                   │
   │───tools/call + task param────────►│
   │                                   │ (creates task)
   │◄──CreateTaskResult (taskId, status: working)──│
   │                                   │
   │  ┌─────── POLLING LOOP ───────┐  │
   │  │                             │  │
   │──┼──tasks/get (taskId)────────►│──┤
   │◄─┼──Task (status: working)────│──┤
   │  │     (wait pollInterval)     │  │
   │──┼──tasks/get (taskId)────────►│──┤
   │◄─┼──Task (status: completed)──│──┤
   │  │                             │  │
   │  └─────────────────────────────┘  │
   │                                   │
   │───tasks/result (taskId)──────────►│
   │◄──CallToolResult (actual result)──│
```

## Requirements

### Functional Requirements

| ID    | Requirement                                               | Priority | Acceptance Criteria                                             |
| ----- | --------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| FR-1  | Declare tasks capability during initialization            | MUST     | `capabilities.tasks` includes list, cancel, requests.tools.call |
| FR-2  | Check server's tasks capability before task-augmenting    | MUST     | Only send task param if server supports it                      |
| FR-3  | Check tool's execution.taskSupport before task-augmenting | MUST     | Respect required/optional/forbidden                             |
| FR-4  | Send task-augmented tools/call with optional TTL          | MUST     | `params.task: { ttl?: number }`                                 |
| FR-5  | Handle CreateTaskResult response                          | MUST     | Extract taskId, status, pollInterval                            |
| FR-6  | Implement tasks/get polling                               | MUST     | Respect pollInterval, poll until terminal                       |
| FR-7  | Implement tasks/result retrieval                          | MUST     | Block until terminal, return actual result                      |
| FR-8  | Handle input_required status                              | MUST     | Call tasks/result to get pending requests                       |
| FR-9  | Implement tasks/list with pagination                      | SHOULD   | Cursor-based, return all active tasks                           |
| FR-10 | Implement tasks/cancel                                    | MUST     | Move task to cancelled status                                   |
| FR-11 | Handle notifications/tasks/status                         | SHOULD   | Update local state, skip polling                                |
| FR-12 | Include io.modelcontextprotocol/related-task in requests  | MUST     | Link sub-requests to parent task                                |
| FR-13 | Continue using progressToken throughout task lifetime     | MUST     | Per spec, token valid for entire task                           |

### Non-Functional Requirements

| ID    | Requirement                        | Priority | Metric                                  |
| ----- | ---------------------------------- | -------- | --------------------------------------- |
| NFR-1 | Polling must not block main thread | MUST     | Async with proper scheduling            |
| NFR-2 | Memory cleanup for completed tasks | MUST     | Remove from activeTasks after retrieval |
| NFR-3 | Handle task expiry gracefully      | MUST     | Task not found error after TTL          |

## Technical Design

### Type Definitions

```typescript
// packages/types/src/mcp.ts - ADD

import {
	TaskSchema,
	TaskStatusSchema,
	CreateTaskResultSchema,
	GetTaskRequestSchema,
	GetTaskResultSchema,
	GetTaskPayloadRequestSchema,
	GetTaskPayloadResultSchema,
	ListTasksRequestSchema,
	ListTasksResultSchema,
	CancelTaskRequestSchema,
	CancelTaskResultSchema,
	TaskStatusNotificationSchema,
	TaskAugmentedRequestParamsSchema,
	ClientTasksCapabilitySchema,
	ServerTasksCapabilitySchema,
	RELATED_TASK_META_KEY,
} from "@modelcontextprotocol/sdk/types.js"

export type Task = z.infer<typeof TaskSchema>
export type TaskStatus = z.infer<typeof TaskStatusSchema>
export type CreateTaskResult = z.infer<typeof CreateTaskResultSchema>
export { RELATED_TASK_META_KEY }

// Local tracking
export interface ActiveTask {
	taskId: string
	serverName: string
	method: string
	status: TaskStatus
	statusMessage?: string
	createdAt: string
	lastUpdatedAt: string
	ttl: number | null
	pollInterval?: number
	progressToken?: string | number
	onStatusChange?: (task: Task) => void
}

// For webview IPC
export interface McpTaskUpdate {
	serverName: string
	taskId: string
	status: TaskStatus
	statusMessage?: string
	progress?: number
	total?: number
}
```

### Capability Declaration

```typescript
// In connectToServer(), modify client initialization:

const client = new Client(
	{
		name: "Roo Code",
		version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0",
	},
	{
		capabilities: {
			roots: { listChanged: true },
			sampling: {},
			elicitation: { form: {} },
			// NEW: Declare tasks capability
			tasks: {
				list: {},
				cancel: {},
				requests: {
					tools: { call: {} }, // We support task-augmented tool calls
					// sampling and elicitation as receiver handled in separate spec
				},
			},
		},
	},
)
```

### TaskPoller Class

```typescript
// src/services/mcp/TaskPoller.ts - NEW

import type { Task, TaskStatus, ActiveTask } from "@roo-code/types"

export class TaskPoller {
	private activeTasks = new Map<string, ActiveTask>()
	private pollingTimers = new Map<string, NodeJS.Timeout>()

	/**
	 * Register a new task for polling
	 */
	registerTask(
		taskId: string,
		serverName: string,
		method: string,
		createResult: CreateTaskResult,
		progressToken?: string | number,
		onStatusChange?: (task: Task) => void,
	): void {
		const task = createResult.task

		this.activeTasks.set(taskId, {
			taskId,
			serverName,
			method,
			status: task.status,
			statusMessage: task.statusMessage,
			createdAt: task.createdAt,
			lastUpdatedAt: task.lastUpdatedAt,
			ttl: task.ttl,
			pollInterval: task.pollInterval,
			progressToken,
			onStatusChange,
		})

		// Start polling if not in terminal status
		if (!this.isTerminal(task.status)) {
			this.startPolling(taskId, task.pollInterval ?? 5000)
		}
	}

	/**
	 * Handle status notification (may skip polling)
	 */
	handleStatusNotification(notification: TaskStatusNotification): void {
		const taskId = notification.params.taskId
		const active = this.activeTasks.get(taskId)

		if (!active) return

		// Update local state
		active.status = notification.params.status
		active.statusMessage = notification.params.statusMessage
		active.lastUpdatedAt = notification.params.lastUpdatedAt

		// Notify listener
		active.onStatusChange?.(notification.params)

		// Stop polling if terminal
		if (this.isTerminal(notification.params.status)) {
			this.stopPolling(taskId)
		}
	}

	/**
	 * Start polling for task status
	 */
	private startPolling(taskId: string, intervalMs: number): void {
		// Clear any existing timer
		this.stopPolling(taskId)

		const timer = setInterval(async () => {
			const active = this.activeTasks.get(taskId)
			if (!active) {
				this.stopPolling(taskId)
				return
			}

			// Poll implementation is injected (see McpHub integration)
			// This class just manages timing
		}, intervalMs)

		this.pollingTimers.set(taskId, timer)
	}

	/**
	 * Stop polling for task
	 */
	stopPolling(taskId: string): void {
		const timer = this.pollingTimers.get(taskId)
		if (timer) {
			clearInterval(timer)
			this.pollingTimers.delete(taskId)
		}
	}

	/**
	 * Check if status is terminal
	 */
	isTerminal(status: TaskStatus): boolean {
		return status === "completed" || status === "failed" || status === "cancelled"
	}

	/**
	 * Get active task
	 */
	getTask(taskId: string): ActiveTask | undefined {
		return this.activeTasks.get(taskId)
	}

	/**
	 * Remove task from tracking
	 */
	cleanup(taskId: string): void {
		this.stopPolling(taskId)
		this.activeTasks.delete(taskId)
	}

	/**
	 * Get all active tasks
	 */
	getAllTasks(): ActiveTask[] {
		return Array.from(this.activeTasks.values())
	}
}
```

### McpHub Task Methods

```typescript
// src/services/mcp/McpHub.ts - ADD

/**
 * Call a tool as a task (for long-running operations)
 */
async callToolAsTask(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  source: McpServerSource,
  options?: {
    ttl?: number
    progressToken?: string | number
    onStatusChange?: (task: Task) => void
  }
): Promise<{ taskId: string; immediateResponse?: string }> {
  const connection = this.getConnection(serverName, source)
  if (!connection?.client) {
    throw new Error(`No connection to ${serverName}`)
  }

  // Verify server supports task-augmented tools/call
  const serverCaps = connection.client.getServerCapabilities()
  if (!serverCaps?.tasks?.requests?.tools?.call) {
    throw new Error(`Server ${serverName} does not support task-augmented tool calls`)
  }

  // Check tool's execution.taskSupport
  const tool = connection.server.tools?.find(t => t.name === toolName)
  if (tool?.execution?.taskSupport === "forbidden") {
    throw new Error(`Tool ${toolName} does not support task execution`)
  }

  // Send task-augmented request
  const requestParams = {
    name: toolName,
    arguments: args,
    task: {
      ttl: options?.ttl,
    },
    _meta: options?.progressToken ? {
      progressToken: options.progressToken,
    } : undefined,
  }

  const result = await connection.client.request(
    { method: "tools/call", params: requestParams },
    CreateTaskResultSchema
  )

  // Register for polling
  this.taskPoller.registerTask(
    result.task.taskId,
    serverName,
    "tools/call",
    result,
    options?.progressToken,
    options?.onStatusChange
  )

  return {
    taskId: result.task.taskId,
    immediateResponse: result._meta?.["io.modelcontextprotocol/model-immediate-response"],
  }
}

/**
 * Get current task status
 */
async getTask(
  serverName: string,
  source: McpServerSource,
  taskId: string
): Promise<Task> {
  const connection = this.getConnection(serverName, source)
  if (!connection?.client) {
    throw new Error(`No connection to ${serverName}`)
  }

  const result = await connection.client.request(
    { method: "tasks/get", params: { taskId } },
    GetTaskResultSchema
  )

  return result
}

/**
 * Get task result (blocks until terminal)
 */
async getTaskResult(
  serverName: string,
  source: McpServerSource,
  taskId: string
): Promise<CallToolResult> {
  const connection = this.getConnection(serverName, source)
  if (!connection?.client) {
    throw new Error(`No connection to ${serverName}`)
  }

  const result = await connection.client.request(
    { method: "tasks/result", params: { taskId } },
    GetTaskPayloadResultSchema
  )

  // Clean up local tracking
  this.taskPoller.cleanup(taskId)

  return result
}

/**
 * List all tasks
 */
async listTasks(
  serverName: string,
  source: McpServerSource,
  cursor?: string
): Promise<{ tasks: Task[]; nextCursor?: string }> {
  const connection = this.getConnection(serverName, source)
  if (!connection?.client) {
    throw new Error(`No connection to ${serverName}`)
  }

  const result = await connection.client.request(
    { method: "tasks/list", params: { cursor } },
    ListTasksResultSchema
  )

  return result
}

/**
 * Cancel a task
 */
async cancelTask(
  serverName: string,
  source: McpServerSource,
  taskId: string
): Promise<Task> {
  const connection = this.getConnection(serverName, source)
  if (!connection?.client) {
    throw new Error(`No connection to ${serverName}`)
  }

  const result = await connection.client.request(
    { method: "tasks/cancel", params: { taskId } },
    CancelTaskResultSchema
  )

  // Clean up local tracking
  this.taskPoller.cleanup(taskId)

  return result
}
```

### Notification Handler

```typescript
// In connectToServer(), register task status handler:

client.setNotificationHandler(TaskStatusNotificationSchema, async (notification) => {
	this.taskPoller.handleStatusNotification(notification)

	// Forward to webview
	const provider = this.providerRef?.deref()
	provider?.postMessageToWebview({
		type: "mcpTaskStatus",
		payload: {
			serverName: name,
			taskId: notification.params.taskId,
			status: notification.params.status,
			statusMessage: notification.params.statusMessage,
		},
	})
})
```

### UI Component

```tsx
// webview-ui/src/components/chat/TaskStatusIndicator.tsx - NEW

import { memo } from "react"
import { Loader2, CheckCircle, XCircle, AlertCircle, Pause } from "lucide-react"
import type { TaskStatus } from "@roo-code/types"
import { Button } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

interface TaskStatusIndicatorProps {
	serverName: string
	taskId: string
	status: TaskStatus
	statusMessage?: string
	onCancel?: () => void
}

const StatusIcon = ({ status }: { status: TaskStatus }) => {
	switch (status) {
		case "working":
			return <Loader2 className="animate-spin" size={16} />
		case "input_required":
			return <Pause size={16} className="text-vscode-notificationsWarningIcon-foreground" />
		case "completed":
			return <CheckCircle size={16} className="text-vscode-testing-iconPassed" />
		case "failed":
			return <XCircle size={16} className="text-vscode-testing-iconFailed" />
		case "cancelled":
			return <AlertCircle size={16} className="text-vscode-descriptionForeground" />
	}
}

export const TaskStatusIndicator = memo(
	({ serverName, taskId, status, statusMessage, onCancel }: TaskStatusIndicatorProps) => {
		const isTerminal = ["completed", "failed", "cancelled"].includes(status)

		const handleCancel = () => {
			vscode.postMessage({
				type: "cancelMcpTask",
				payload: { serverName, taskId },
			})
			onCancel?.()
		}

		return (
			<div className="flex items-center gap-2 text-sm">
				<StatusIcon status={status} />
				<span className="font-medium capitalize">{status.replace("_", " ")}</span>
				{statusMessage && <span className="text-vscode-descriptionForeground">— {statusMessage}</span>}
				{!isTerminal && (
					<Button
						variant="ghost"
						size="sm"
						onClick={handleCancel}
						className="ml-2 text-vscode-errorForeground">
						Cancel
					</Button>
				)}
			</div>
		)
	},
)
```

## Test Plan

### Unit Tests

| Test ID | Description                                         | Expected Result                     |
| ------- | --------------------------------------------------- | ----------------------------------- |
| UT-1    | TaskPoller.registerTask() starts polling            | Timer created                       |
| UT-2    | TaskPoller.isTerminal() correctly identifies states | true for completed/failed/cancelled |
| UT-3    | TaskPoller.handleStatusNotification() updates state | Local status updated                |
| UT-4    | TaskPoller.cleanup() stops polling                  | Timer cleared                       |

### Integration Tests

| Test ID | Description                              | Expected Result           |
| ------- | ---------------------------------------- | ------------------------- |
| IT-1    | callToolAsTask receives CreateTaskResult | taskId returned           |
| IT-2    | Polling respects pollInterval            | Requests spaced correctly |
| IT-3    | getTaskResult blocks until complete      | Returns actual result     |
| IT-4    | cancelTask moves to cancelled status     | Task status is cancelled  |

### Test Server

```javascript
// test-tasks-server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

const server = new McpServer({
	name: "test-tasks",
	version: "1.0.0",
	capabilities: {
		tasks: {
			list: {},
			cancel: {},
			requests: { tools: { call: {} } },
		},
	},
})

const tasks = new Map()

server.tool(
	"long_running_task",
	"Simulates a long operation",
	{ duration: { type: "number", description: "Duration in seconds" } },
	async (args, extra) => {
		// This tool requires task augmentation
		if (!extra.task) {
			return { content: [{ type: "text", text: "Use task mode for this operation" }] }
		}

		const taskId = extra.task.taskId
		tasks.set(taskId, { status: "working", startedAt: Date.now() })

		// Simulate work
		await new Promise((r) => setTimeout(r, args.duration * 1000))

		tasks.set(taskId, { status: "completed" })

		return {
			content: [{ type: "text", text: `Completed after ${args.duration}s` }],
		}
	},
	{ execution: { taskSupport: "required" } },
)
```

## Implementation Checklist

- [ ] Add Task type exports to `packages/types/src/mcp.ts`
- [ ] Create `TaskPoller` class in `src/services/mcp/TaskPoller.ts`
- [ ] Update client capabilities with `tasks`
- [ ] Add `taskPoller` instance to `McpHub`
- [ ] Implement `callToolAsTask` method
- [ ] Implement `getTask` method
- [ ] Implement `getTaskResult` method
- [ ] Implement `listTasks` method
- [ ] Implement `cancelTask` method
- [ ] Register `notifications/tasks/status` handler
- [ ] Add IPC handlers for task operations
- [ ] Create `TaskStatusIndicator.tsx` component
- [ ] Integrate into `ChatRow.tsx`
- [ ] Write unit tests for `TaskPoller`
- [ ] Create test server
- [ ] Run `pnpm check-types` - exit 0
- [ ] Run `pnpm lint` - no new warnings

## Risks and Mitigations

| Risk                              | Likelihood | Impact | Mitigation                                 |
| --------------------------------- | ---------- | ------ | ------------------------------------------ |
| Polling floods server             | Medium     | Medium | Respect pollInterval, stop on notification |
| Task expires before retrieval     | Low        | Medium | Monitor TTL, warn before expiry            |
| Server doesn't send notifications | Medium     | Low    | Polling is the fallback                    |

## References

- [MCP Tasks Spec](ai_docs/mcp-2025-11-25/modelcontextprotocol.io_specification_2025-11-25_basic_utilities_tasks.md)
- [Progress Spec](./01-progress.md) (dependency)
- [Cancellation Spec](./02-cancellation.md) (dependency)
- [Implementation State](.claude/mcp-implementation-state.json)
