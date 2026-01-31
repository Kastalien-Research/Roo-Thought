# Spec: MCP Progress Tracking

## Metadata

| Field                | Value                                         |
| -------------------- | --------------------------------------------- |
| **ID**               | `MCP-PROG-001`                                |
| **Title**            | Progress Tracking for Long-Running Operations |
| **Status**           | ✅ VALIDATED                                  |
| **Priority**         | P0 (Foundation)                               |
| **Dependencies**     | None                                          |
| **Estimated Effort** | Medium (2-4 hours)                            |
| **Spec Version**     | 1.0.0                                         |
| **Validated**        | 2026-01-17                                    |
| **Codebase Status**  | 100% NOVEL                                    |
| **Blockers**         | None                                          |

## Overview

### Problem Statement

Long-running MCP operations (tool calls, resource reads, sampling, elicitation) provide no visibility into their progress. Users see a blank wait state with no indication of whether the operation is progressing, stalled, or how much remains.

### Solution Summary

Implement bidirectional progress notification support per MCP 2025-11-25 spec:

1. **Sending**: Include `progressToken` in outgoing requests to receive updates
2. **Receiving**: Handle `notifications/progress` from servers
3. **Emitting**: Send progress notifications when handling server requests (sampling/elicitation)

### Success Criteria

- [ ] SC-1: Tool calls can include optional progressToken and receive progress updates
- [ ] SC-2: Progress notifications display in chat UI with progress bar
- [ ] SC-3: Sampling/elicitation handlers emit progress for each phase
- [ ] SC-4: Type-safe integration using SDK schemas

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           McpHub.ts                                  │
│                                                                      │
│  ┌─────────────────────────┐    ┌─────────────────────────────────┐│
│  │    ProgressTracker      │    │      Request Methods            ││
│  │    (new class)          │    │                                 ││
│  │                         │    │  callTool(name, args, opts?)    ││
│  │  - activeTokens: Map    │◄───│    opts.progressToken?          ││
│  │  - generateToken()      │    │                                 ││
│  │  - registerRequest()    │    │  readResource(uri, opts?)       ││
│  │  - handleProgress()     │    │    opts.progressToken?          ││
│  │  - cleanup()            │    │                                 ││
│  └──────────┬──────────────┘    └─────────────────────────────────┘│
│             │                                                        │
│             ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Notification Handler: "notifications/progress"                 ││
│  │                                                                  ││
│  │  client.setNotificationHandler(ProgressNotificationSchema, ...) ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         WebView UI                                   │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  ProgressIndicator.tsx                                          ││
│  │                                                                  ││
│  │  interface McpProgressUpdate {                                  ││
│  │    progressToken: string | number;                              ││
│  │    progress: number;                                            ││
│  │    total?: number;                                              ││
│  │    message?: string;                                            ││
│  │  }                                                              ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
OUTGOING REQUEST WITH PROGRESS:
  1. callTool("slow_operation", args, { progressToken: "tok-123" })
  2. ProgressTracker.registerRequest("tok-123", requestContext)
  3. Send request with _meta.progressToken
  4. Server sends notifications/progress
  5. Notification handler updates UI via ClineProvider
  6. On response: ProgressTracker.cleanup("tok-123")

INCOMING REQUEST WITH PROGRESS (sampling/elicitation):
  1. Server sends sampling/createMessage with _meta.progressToken
  2. Handler extracts progressToken
  3. Handler calls client.notification("notifications/progress", ...)
  4. At each phase: showing UI, awaiting approval, processing
  5. Final response sent
```

## Requirements

### Functional Requirements

| ID    | Requirement                                                | Priority | Acceptance Criteria                               |
| ----- | ---------------------------------------------------------- | -------- | ------------------------------------------------- |
| FR-1  | Generate unique progress tokens for outgoing requests      | MUST     | Tokens unique across session, string or integer   |
| FR-2  | Include progressToken in request `_meta` field             | MUST     | SDK's `_meta.progressToken` field populated       |
| FR-3  | Register notification handler for `notifications/progress` | MUST     | Handler receives progress, total, message         |
| FR-4  | Track active progress tokens in memory                     | MUST     | Map<token, requestContext> maintained             |
| FR-5  | Clean up token tracking on request completion              | MUST     | No memory leaks, tokens removed on response/error |
| FR-6  | Forward progress updates to webview                        | SHOULD   | ClineProvider.postMessage with progress data      |
| FR-7  | Emit progress for sampling handler phases                  | SHOULD   | "Awaiting approval", "Processing" states          |
| FR-8  | Emit progress for elicitation handler phases               | SHOULD   | "Displaying form", "Awaiting input" states        |
| FR-9  | Support floating-point progress values                     | MUST     | Per spec, progress/total MAY be float             |
| FR-10 | Validate progress is monotonically increasing              | SHOULD   | Log warning if progress decreases                 |

### Non-Functional Requirements

| ID    | Requirement                                      | Priority | Metric                          |
| ----- | ------------------------------------------------ | -------- | ------------------------------- |
| NFR-1 | Progress updates must not block request handling | MUST     | Async notification handling     |
| NFR-2 | Rate limit progress forwarding to UI             | SHOULD   | Max 10 updates/second per token |
| NFR-3 | Token generation must be fast                    | MUST     | < 1ms per token                 |

## Technical Design

### Type Definitions

```typescript
// packages/types/src/mcp.ts - ADD

import {
	ProgressNotificationSchema,
	ProgressNotificationParams,
	ProgressTokenSchema,
} from "@modelcontextprotocol/sdk/types.js"

export type { ProgressNotificationParams }
export type ProgressToken = z.infer<typeof ProgressTokenSchema>

// For webview IPC
export interface McpProgressUpdate {
	serverName: string
	progressToken: string | number
	progress: number
	total?: number
	message?: string
	timestamp: number
}
```

### ProgressTracker Class

```typescript
// src/services/mcp/ProgressTracker.ts - NEW

interface TrackedRequest {
	serverName: string
	method: string
	startedAt: number
	lastProgress: number
	onProgress?: (update: ProgressNotificationParams) => void
}

export class ProgressTracker {
	private activeTokens = new Map<string | number, TrackedRequest>()
	private tokenCounter = 0

	generateToken(): string {
		return `prog-${Date.now()}-${++this.tokenCounter}`
	}

	registerRequest(
		token: string | number,
		serverName: string,
		method: string,
		onProgress?: (update: ProgressNotificationParams) => void,
	): void {
		this.activeTokens.set(token, {
			serverName,
			method,
			startedAt: Date.now(),
			lastProgress: 0,
			onProgress,
		})
	}

	handleProgress(params: ProgressNotificationParams): void {
		const tracked = this.activeTokens.get(params.progressToken)
		if (!tracked) {
			// Unknown token - server sent unsolicited progress
			return
		}

		// Validate monotonic increase
		if (params.progress < tracked.lastProgress) {
			console.warn(
				`Progress decreased for token ${params.progressToken}: ` +
					`${tracked.lastProgress} -> ${params.progress}`,
			)
		}
		tracked.lastProgress = params.progress

		// Forward to callback
		tracked.onProgress?.(params)
	}

	cleanup(token: string | number): void {
		this.activeTokens.delete(token)
	}

	getActiveCount(): number {
		return this.activeTokens.size
	}
}
```

### McpHub Integration

```typescript
// src/services/mcp/McpHub.ts - MODIFY

// In connectToServer(), after creating client:

// Register progress notification handler
client.setNotificationHandler(
  ProgressNotificationSchema,
  async (notification) => {
    this.progressTracker.handleProgress(notification.params)

    // Forward to webview
    const provider = this.providerRef?.deref()
    if (provider) {
      const tracked = this.progressTracker.getTracked(notification.params.progressToken)
      provider.postMessageToWebview({
        type: "mcpProgress",
        payload: {
          serverName: tracked?.serverName ?? name,
          ...notification.params,
          timestamp: Date.now(),
        }
      })
    }
  }
)

// Modify callTool to accept options:
async callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  source: McpServerSource,
  options?: { progressToken?: string | number }
): Promise<CallToolResult> {
  // ... existing code ...

  const requestParams: CallToolRequest["params"] = {
    name: toolName,
    arguments: args,
  }

  if (options?.progressToken) {
    requestParams._meta = {
      progressToken: options.progressToken
    }
    this.progressTracker.registerRequest(
      options.progressToken,
      serverName,
      "tools/call",
      // Optional callback for internal handling
    )
  }

  try {
    const result = await client.callTool(requestParams)
    return result
  } finally {
    if (options?.progressToken) {
      this.progressTracker.cleanup(options.progressToken)
    }
  }
}
```

### UI Component

```tsx
// webview-ui/src/components/chat/ProgressIndicator.tsx - NEW

import { memo } from "react"
import type { McpProgressUpdate } from "@roo-code/types"

interface ProgressIndicatorProps {
	update: McpProgressUpdate
}

export const ProgressIndicator = memo(({ update }: ProgressIndicatorProps) => {
	const percentage = update.total ? Math.min(100, (update.progress / update.total) * 100) : null

	return (
		<div className="flex flex-col gap-1 text-sm">
			{update.message && <div className="text-vscode-descriptionForeground">{update.message}</div>}

			{percentage !== null ? (
				<div className="h-2 bg-vscode-input-background rounded-full overflow-hidden">
					<div
						className="h-full bg-vscode-progressBar-background transition-all duration-200"
						style={{ width: `${percentage}%` }}
					/>
				</div>
			) : (
				<div className="flex items-center gap-2">
					<div className="animate-spin h-4 w-4 border-2 border-vscode-progressBar-background border-t-transparent rounded-full" />
					<span>Progress: {update.progress}</span>
				</div>
			)}
		</div>
	)
})
```

## Test Plan

### Unit Tests

| Test ID | Description                                         | Expected Result            |
| ------- | --------------------------------------------------- | -------------------------- |
| UT-1    | ProgressTracker.generateToken() uniqueness          | 1000 tokens all unique     |
| UT-2    | ProgressTracker.handleProgress() with unknown token | No error, silently ignored |
| UT-3    | ProgressTracker.handleProgress() monotonic warning  | Console.warn on decrease   |
| UT-4    | ProgressTracker.cleanup() removes token             | Map size decreases         |

### Integration Tests

| Test ID | Description                                        | Expected Result                       |
| ------- | -------------------------------------------------- | ------------------------------------- |
| IT-1    | callTool with progressToken receives notifications | Progress callback invoked             |
| IT-2    | Progress forwarded to webview                      | postMessage called with correct shape |
| IT-3    | Cleanup on request error                           | Token removed from map                |

### Test Server

```javascript
// test-progress-server.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const server = new McpServer({ name: "test-progress", version: "1.0.0" })

server.tool("slow_operation", "Demonstrates progress", {}, async (args, extra) => {
	const token = extra._meta?.progressToken

	for (let i = 1; i <= 5; i++) {
		await new Promise((r) => setTimeout(r, 500))
		if (token) {
			await extra.sendProgress({
				progressToken: token,
				progress: i,
				total: 5,
				message: `Step ${i} of 5`,
			})
		}
	}

	return { content: [{ type: "text", text: "Done!" }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

## Implementation Checklist

- [ ] Create `ProgressTracker` class in `src/services/mcp/ProgressTracker.ts`
- [ ] Add type exports to `packages/types/src/mcp.ts`
- [ ] Add `progressTracker` instance to `McpHub`
- [ ] Register `notifications/progress` handler in `connectToServer`
- [ ] Modify `callTool` to accept `options.progressToken`
- [ ] Modify `readResource` to accept `options.progressToken`
- [ ] Add progress forwarding to webview via `postMessage`
- [ ] Create `ProgressIndicator.tsx` component
- [ ] Integrate `ProgressIndicator` into `ChatRow.tsx`
- [ ] Add IPC message type for progress updates
- [ ] Write unit tests for `ProgressTracker`
- [ ] Create test server for manual testing
- [ ] Run `pnpm check-types` - exit 0
- [ ] Run `pnpm lint` - no new warnings

## Risks and Mitigations

| Risk                              | Likelihood | Impact | Mitigation               |
| --------------------------------- | ---------- | ------ | ------------------------ |
| High-frequency updates flood UI   | Medium     | Low    | Rate limiting in tracker |
| Memory leak from uncleaned tokens | Low        | Medium | Timeout-based cleanup    |
| SDK schema mismatch               | Low        | High   | Use SDK types directly   |

## References

- [MCP Progress Spec](ai_docs/mcp-2025-11-25/modelcontextprotocol.io_specification_2025-11-25_basic_utilities_progress.md)
- [SDK Types](node_modules/.pnpm/@modelcontextprotocol+sdk@1.25.2_hono@4.11.4_zod@3.25.61/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts)
- [Implementation State](.claude/mcp-implementation-state.json)
