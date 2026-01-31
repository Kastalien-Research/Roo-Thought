/**
 * Types and interfaces for MCP request/notification handlers.
 *
 * These interfaces define the dependencies that handlers need from McpHub,
 * allowing for better testability and clearer contracts.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

import type {
	McpResource,
	McpTool,
	McpPrompt,
	McpSamplingRequest,
	McpElicitationRequest,
	ClineAskUseMcpServer,
} from "@roo-code/types"

import type { McpConnection } from "../McpHub"

/**
 * Minimal interface for provider access in handlers.
 * This abstracts away the full ClineProvider complexity.
 */
export interface ProviderAccess {
	getCurrentTask(): {
		ask(type: string, data: string): Promise<{ response: string; text?: string }>
		api?: {
			createMessage(
				systemPrompt: string,
				messages: Array<{ role: "user" | "assistant"; content: string }>,
				options: { taskId: string; tools?: unknown[]; tool_choice?: string },
			): AsyncIterable<{ type: string; text?: string; message?: string }>
			getModel(): { id: string }
		}
		taskId: string
	} | null
	postMessageToWebview(message: unknown): Promise<void>
}

/**
 * Progress tracking state for a single token.
 */
export interface ProgressTokenData {
	serverName: string
	callback?: (progress: number, total?: number, message?: string) => void
	lastProgress: number
}

/**
 * Pending request tracking for cancellation.
 */
export interface PendingRequestData {
	serverName: string
	controller: AbortController
}

/**
 * Task tracking state.
 */
export interface TaskData {
	serverName: string
	source?: "global" | "project"
	status: "working" | "input_required" | "completed" | "failed" | "cancelled"
	progressToken?: string | number
	pollInterval?: number
	message?: string
	createdAt: number
	updatedAt: number
}

/**
 * Context passed to handlers during registration.
 * Provides access to McpHub functionality without exposing the full class.
 */
export interface HandlerContext {
	/** Server name (from connectToServer parameter) */
	serverName: string
	/** Server source (global or project) */
	source: "global" | "project"

	/** Get the provider (may return null if provider is disposed) */
	getProvider(): ProviderAccess | null

	/** Progress tracking map */
	activeProgressTokens: Map<string | number, ProgressTokenData>

	/** Pending requests for cancellation */
	pendingRequests: Map<string | number, PendingRequestData>

	/** Active tasks */
	activeTasks: Map<string, TaskData>

	/** Find a connection by name and source */
	findConnection(name: string, source: "global" | "project"): McpConnection | undefined

	/** Fetch resources list for a server */
	fetchResourcesList(name: string, source: "global" | "project"): Promise<McpResource[] | undefined>

	/** Fetch tools list for a server */
	fetchToolsList(name: string, source: "global" | "project"): Promise<McpTool[] | undefined>

	/** Fetch prompts list for a server */
	fetchPromptsList(name: string, source: "global" | "project"): Promise<McpPrompt[] | undefined>

	/** Notify webview of server changes */
	notifyWebviewOfServerChanges(): Promise<void>

	/** Append error message to connection */
	appendErrorMessage(connection: McpConnection, message: string, level?: "error" | "warn"): void
}

/**
 * Function type for registering all handlers on a client.
 */
export type RegisterHandlers = (client: Client, context: HandlerContext) => void
