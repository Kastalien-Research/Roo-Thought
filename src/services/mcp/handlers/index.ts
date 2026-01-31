/**
 * MCP Request and Notification Handlers
 *
 * This module provides modular handlers for MCP 2025-11-25 spec requests and notifications.
 * Handlers are registered on the MCP Client during connection setup.
 *
 * Request Handlers (Server → Client):
 * - roots/list - Query workspace folders
 * - sampling/createMessage - Request LLM completions
 * - elicitation/create - Request user input via forms
 *
 * Notification Handlers (Server → Client):
 * - progress - Long-running operation progress
 * - cancelled - Request cancellation
 * - task status - Task state changes
 * - logging - Log messages
 * - list changed - Resource/tool/prompt list changes
 * - resource updated - Resource content changes
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"

import type { HandlerContext } from "./types"

import { registerRootsHandler } from "./RootsHandler"
import { registerSamplingHandler } from "./SamplingHandler"
import { registerElicitationHandler } from "./ElicitationHandler"
import { registerAllNotificationHandlers } from "./NotificationHandlers"

// Re-export types
export type { HandlerContext, ProviderAccess, ProgressTokenData, PendingRequestData, TaskData } from "./types"

// Re-export individual handlers for selective use
export { registerRootsHandler } from "./RootsHandler"
export { registerSamplingHandler } from "./SamplingHandler"
export { registerElicitationHandler } from "./ElicitationHandler"
export {
	registerProgressHandler,
	registerCancellationHandler,
	registerTaskStatusHandler,
	registerLoggingHandler,
	registerResourceListChangedHandler,
	registerToolListChangedHandler,
	registerPromptListChangedHandler,
	registerResourceUpdatedHandler,
	registerAllNotificationHandlers,
} from "./NotificationHandlers"

/**
 * Register all MCP handlers on a client.
 *
 * This is the main entry point for handler registration. It sets up all
 * request and notification handlers required for full MCP 2025-11-25 support.
 *
 * @param client - The MCP Client instance
 * @param context - Handler context providing access to McpHub functionality
 */
export function registerAllHandlers(client: Client, context: HandlerContext): void {
	// Request handlers
	registerRootsHandler(client)
	registerSamplingHandler(client, context)
	registerElicitationHandler(client, context)

	// Notification handlers
	registerAllNotificationHandlers(client, context)
}
