# Spec: MCP Request Cancellation

## Metadata

| Field                | Value                                  |
| -------------------- | -------------------------------------- |
| **ID**               | `MCP-CANCEL-001`                       |
| **Title**            | Request Cancellation via Notifications |
| **Status**           | ⚠️ VALIDATED (Blocker)                 |
| **Priority**         | P0 (Foundation)                        |
| **Dependencies**     | None                                   |
| **Estimated Effort** | Medium (2-3 hours)                     |
| **Spec Version**     | 1.0.0                                  |
| **Validated**        | 2026-01-17                             |
| **Codebase Status**  | 85% NOVEL, 15% PARTIAL                 |
| **Blockers**         | B-1: task.ask() AbortSignal support    |

## Overview

### Problem Statement

Once an MCP request is initiated, there's no way to abort it. Users stuck waiting for a long-running operation have no recourse. Additionally, when servers cancel their requests to us (sampling/elicitation), we have no mechanism to abort the pending UI flow.

### Solution Summary

Implement bidirectional cancellation support per MCP 2025-11-25 spec:

1. **Sending**: Send `notifications/cancelled` to abort outgoing requests
2. **Receiving**: Handle `notifications/cancelled` from servers to abort pending operations
3. **Integration**: Use `AbortController` for cancellable async operations

### Success Criteria

- [ ] SC-1: Long-running tool calls can be cancelled by user
- [ ] SC-2: Sampling/elicitation UI can be aborted when server cancels
- [ ] SC-3: Cancelled requests don't produce responses
- [ ] SC-4: Race conditions handled gracefully (late cancellation ignored)

## Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           McpHub.ts                                  │
│                                                                      │
│  ┌─────────────────────────┐    ┌─────────────────────────────────┐│
│  │   RequestTracker        │    │      Public Methods             ││
│  │   (new class)           │    │                                 ││
│  │                         │    │  cancelRequest(requestId, reason)││
│  │  - pendingRequests: Map │◄───│                                 ││
│  │  - registerRequest()    │    │  // Returns AbortSignal         ││
│  │  - getAbortController() │    │  startCancellableRequest()      ││
│  │  - handleCancelled()    │    │                                 ││
│  │  - cleanup()            │    └─────────────────────────────────┘│
│  └──────────┬──────────────┘                                        │
│             │                                                        │
│             ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Notification Handler: "notifications/cancelled"               ││
│  │                                                                  ││
│  │  client.setNotificationHandler(CancelledNotificationSchema, ...)││
│  │  → Abort pending sampling/elicitation                           ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │  Send Cancellation: client.notification(...)                   ││
│  │                                                                  ││
│  │  → Used when user clicks "Cancel" on long-running request       ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Cancellation Flow Diagrams

```
OUTGOING REQUEST CANCELLATION (User cancels tool call):

  User         McpHub              MCP Server
   │              │                    │
   │──callTool────►│                    │
   │              │───tools/call──────►│
   │              │                    │ (processing...)
   │──cancel──────►│                    │
   │              │──notifications/────►│
   │              │   cancelled        │
   │              │                    │ (stops processing)
   │              │                    │ (no response sent)
   │◄─cancelled───│                    │


INCOMING REQUEST CANCELLATION (Server cancels sampling):

  MCP Server       McpHub              WebView
      │               │                   │
      │──sampling/────►│                   │
      │   createMessage│                   │
      │               │───show UI─────────►│
      │               │                   │ (user sees approval)
      │──notifications/│                   │
      │   cancelled───►│                   │
      │               │───abort───────────►│
      │               │                   │ (UI dismissed)
      │◄─(no response)│                   │
```

## Requirements

### Functional Requirements

| ID    | Requirement                                                 | Priority | Acceptance Criteria                           |
| ----- | ----------------------------------------------------------- | -------- | --------------------------------------------- |
| FR-1  | Track pending outgoing requests with requestId              | MUST     | Map<requestId, AbortController> maintained    |
| FR-2  | Expose `cancelRequest(requestId, reason?)` method           | MUST     | Sends notifications/cancelled, triggers abort |
| FR-3  | Register notification handler for `notifications/cancelled` | MUST     | Handler receives requestId and reason         |
| FR-4  | Abort pending sampling requests on cancellation             | MUST     | task.ask() aborted, no response sent          |
| FR-5  | Abort pending elicitation requests on cancellation          | MUST     | task.ask() aborted, no response sent          |
| FR-6  | MUST NOT allow cancellation of initialize request           | MUST     | Throw error if attempted                      |
| FR-7  | Ignore cancellation for unknown/completed requests          | MUST     | No error, silently ignored                    |
| FR-8  | Include reason in cancellation notification                 | SHOULD   | Reason field populated if provided            |
| FR-9  | Expose abort signal for UI cancel button                    | SHOULD   | ClineProvider can trigger cancellation        |
| FR-10 | Log cancellation events for debugging                       | SHOULD   | Console log with requestId and reason         |

### Non-Functional Requirements

| ID    | Requirement                                       | Priority | Metric                     |
| ----- | ------------------------------------------------- | -------- | -------------------------- |
| NFR-1 | Cancellation notification must be fire-and-forget | MUST     | No response expected       |
| NFR-2 | Handle race conditions gracefully                 | MUST     | Late cancellation ignored  |
| NFR-3 | No resource leaks from cancelled requests         | MUST     | AbortController cleaned up |

## Technical Design

### Type Definitions

```typescript
// packages/types/src/mcp.ts - ADD

import { CancelledNotificationSchema, CancelledNotificationParams } from "@modelcontextprotocol/sdk/types.js"

export type { CancelledNotificationParams }

// For internal tracking
export interface PendingRequest {
	requestId: string | number
	method: string
	serverName: string
	abortController: AbortController
	startedAt: number
}

// For webview IPC
export interface McpCancellationRequest {
	serverName: string
	requestId: string | number
	reason?: string
}
```

### RequestTracker Class

```typescript
// src/services/mcp/RequestTracker.ts - NEW

import type { PendingRequest } from "@roo-code/types"

export class RequestTracker {
	private pendingRequests = new Map<string | number, PendingRequest>()

	/**
	 * Register a new pending request
	 * @returns AbortController for the request
	 */
	registerRequest(requestId: string | number, method: string, serverName: string): AbortController {
		const abortController = new AbortController()

		this.pendingRequests.set(requestId, {
			requestId,
			method,
			serverName,
			abortController,
			startedAt: Date.now(),
		})

		return abortController
	}

	/**
	 * Get the AbortController for a pending request
	 */
	getAbortController(requestId: string | number): AbortController | undefined {
		return this.pendingRequests.get(requestId)?.abortController
	}

	/**
	 * Handle incoming cancellation notification
	 * @returns true if request was found and aborted
	 */
	handleCancelled(requestId: string | number, reason?: string): boolean {
		const pending = this.pendingRequests.get(requestId)

		if (!pending) {
			// Unknown or already completed - per spec, ignore silently
			return false
		}

		console.log(`[MCP] Request ${requestId} cancelled` + (reason ? `: ${reason}` : ""))

		pending.abortController.abort(reason ?? "Request cancelled")
		this.pendingRequests.delete(requestId)

		return true
	}

	/**
	 * Clean up after request completion (success or error)
	 */
	cleanup(requestId: string | number): void {
		this.pendingRequests.delete(requestId)
	}

	/**
	 * Check if a request is still pending
	 */
	isPending(requestId: string | number): boolean {
		return this.pendingRequests.has(requestId)
	}

	/**
	 * Get all pending requests (for debugging/UI)
	 */
	getPendingRequests(): PendingRequest[] {
		return Array.from(this.pendingRequests.values())
	}
}
```

### McpHub Integration

```typescript
// src/services/mcp/McpHub.ts - MODIFY

import { CancelledNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { RequestTracker } from "./RequestTracker"

export class McpHub {
  private requestTracker = new RequestTracker()

  // In connectToServer(), after creating client:

  // Register cancellation notification handler
  client.setNotificationHandler(
    CancelledNotificationSchema,
    async (notification) => {
      const { requestId, reason } = notification.params

      // Try to abort the pending request
      const aborted = this.requestTracker.handleCancelled(requestId, reason)

      if (aborted) {
        // Notify webview that the operation was cancelled
        const provider = this.providerRef?.deref()
        provider?.postMessageToWebview({
          type: "mcpRequestCancelled",
          payload: { serverName: name, requestId, reason }
        })
      }
    }
  )

  /**
   * Cancel an outgoing request
   */
  async cancelRequest(
    serverName: string,
    source: McpServerSource,
    requestId: string | number,
    reason?: string
  ): Promise<void> {
    const connection = this.connections.find(
      (conn) => conn.server.name === serverName && conn.server.source === source
    )

    if (!connection?.client) {
      throw new Error(`No active connection to ${serverName}`)
    }

    // Per spec: MUST NOT cancel initialize request
    // (We don't expose initialize as a cancellable request anyway)

    // Send cancellation notification (fire-and-forget)
    await connection.client.notification({
      method: "notifications/cancelled",
      params: {
        requestId,
        reason,
      }
    })

    // Abort local tracking
    this.requestTracker.handleCancelled(requestId, reason)
  }
}
```

### Sampling/Elicitation Abort Integration

```typescript
// In sampling handler - MODIFY

client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
	const provider = this.providerRef?.deref()
	if (!provider) {
		throw new McpError(ErrorCode.InternalError, "No active provider")
	}

	const task = provider.getCurrentTask()
	if (!task) {
		throw new McpError(ErrorCode.InternalError, "No active task")
	}

	// Get requestId from the JSON-RPC request for cancellation tracking
	// The SDK provides this in the request context
	const requestId = request.id

	// Register for potential cancellation
	const abortController = this.requestTracker.registerRequest(requestId, "sampling/createMessage", name)

	try {
		// Pass abort signal to task.ask() for cancellation support
		const { response, text } = await task.ask(
			"use_mcp_server",
			JSON.stringify(askData),
			{ signal: abortController.signal }, // Assuming task.ask supports this
		)

		if (response === "noButtonClicked") {
			throw new McpError(ErrorCode.InvalidRequest, "User declined")
		}

		// ... rest of handler
	} catch (error) {
		if (error.name === "AbortError") {
			// Request was cancelled - don't send response per spec
			// The SDK will handle this appropriately
			throw error
		}
		throw error
	} finally {
		this.requestTracker.cleanup(requestId)
	}
})
```

### UI Cancel Button

```tsx
// webview-ui/src/components/chat/CancelButton.tsx - NEW

import { memo } from "react"
import { X } from "lucide-react"
import { Button } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

interface CancelButtonProps {
	serverName: string
	requestId: string | number
	reason?: string
	disabled?: boolean
}

export const CancelButton = memo(
	({ serverName, requestId, reason = "User cancelled", disabled = false }: CancelButtonProps) => {
		const handleCancel = () => {
			vscode.postMessage({
				type: "cancelMcpRequest",
				payload: { serverName, requestId, reason },
			})
		}

		return (
			<Button
				variant="ghost"
				size="sm"
				onClick={handleCancel}
				disabled={disabled}
				className="text-vscode-errorForeground">
				<X size={14} className="mr-1" />
				Cancel
			</Button>
		)
	},
)
```

## Test Plan

### Unit Tests

| Test ID | Description                                              | Expected Result              |
| ------- | -------------------------------------------------------- | ---------------------------- |
| UT-1    | RequestTracker.registerRequest() returns AbortController | Non-null controller returned |
| UT-2    | RequestTracker.handleCancelled() aborts controller       | Signal.aborted === true      |
| UT-3    | RequestTracker.handleCancelled() unknown requestId       | Returns false, no error      |
| UT-4    | RequestTracker.cleanup() removes request                 | isPending returns false      |

### Integration Tests

| Test ID | Description                            | Expected Result                         |
| ------- | -------------------------------------- | --------------------------------------- |
| IT-1    | cancelRequest sends notification       | Server receives notifications/cancelled |
| IT-2    | Server cancellation aborts sampling UI | task.ask() throws AbortError            |
| IT-3    | Late cancellation ignored              | No error when request already completed |

### Manual Test Scenarios

1. **Cancel long-running tool call**

    - Start `slow_operation` tool
    - Click cancel button
    - Verify operation stops, no result displayed

2. **Server cancels sampling request**
    - Trigger sampling from test server
    - Server sends cancellation
    - Verify approval UI dismisses

## Implementation Checklist

- [ ] Create `RequestTracker` class in `src/services/mcp/RequestTracker.ts`
- [ ] Add type exports to `packages/types/src/mcp.ts`
- [ ] Add `requestTracker` instance to `McpHub`
- [ ] Register `notifications/cancelled` handler in `connectToServer`
- [ ] Add `cancelRequest` method to `McpHub`
- [ ] Modify sampling handler to use AbortController
- [ ] Modify elicitation handler to use AbortController
- [ ] Add IPC handler for `cancelMcpRequest` in ClineProvider
- [ ] Create `CancelButton.tsx` component
- [ ] Write unit tests for `RequestTracker`
- [ ] Run `pnpm check-types` - exit 0
- [ ] Run `pnpm lint` - no new warnings

## Edge Cases and Race Conditions

### Case 1: Cancellation After Completion

```
Timeline:
  T0: Request sent
  T1: Request completes, response sent
  T2: Cancellation notification arrives (late)

Handling:
  - RequestTracker has already cleaned up requestId
  - handleCancelled returns false
  - No action taken (correct per spec)
```

### Case 2: Cancellation During Response Processing

```
Timeline:
  T0: Request sent
  T1: Response received, processing starts
  T2: Cancellation notification arrives

Handling:
  - Check abortController.signal.aborted before each async step
  - If aborted, throw AbortError
  - Partial results discarded
```

### Case 3: Network Disconnect During Cancellation

```
Timeline:
  T0: Cancel notification sent
  T1: Network disconnects before delivery

Handling:
  - Fire-and-forget: we don't wait for confirmation
  - Local abort still happens
  - Server may or may not receive cancellation
  - Acceptable per spec (notifications are unreliable)
```

## Risks and Mitigations

| Risk                                        | Likelihood | Impact | Mitigation                     |
| ------------------------------------------- | ---------- | ------ | ------------------------------ |
| AbortController not supported in task.ask() | Medium     | High   | Need to verify/add support     |
| Orphaned UI state on cancellation           | Medium     | Medium | Clean up UI state explicitly   |
| Memory leak from uncleared requests         | Low        | Medium | Timeout-based cleanup fallback |

## References

- [MCP Cancellation Spec](ai_docs/mcp-2025-11-25/modelcontextprotocol.io_specification_2025-11-25_basic_utilities_cancellation.md)
- [SDK Types](node_modules/.pnpm/@modelcontextprotocol+sdk@1.25.2_hono@4.11.4_zod@3.25.61/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts)
- [Implementation State](.claude/mcp-implementation-state.json)
