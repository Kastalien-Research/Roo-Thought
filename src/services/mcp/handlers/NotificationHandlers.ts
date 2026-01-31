/**
 * Notification handlers for MCP 2025-11-25 spec notifications.
 *
 * These handlers process server-initiated notifications for:
 * - Progress updates on long-running operations
 * - Request cancellation
 * - Task status changes
 * - Logging messages
 * - Resource/tool/prompt list changes
 * - Resource content updates
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
	ProgressNotificationSchema,
	CancelledNotificationSchema,
	TaskStatusNotificationSchema,
	LoggingMessageNotificationSchema,
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
	PromptListChangedNotificationSchema,
	ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"

import type { HandlerContext } from "./types"

/**
 * Register progress notification handler.
 *
 * Servers send notifications/progress to report progress on long-running operations.
 * This handler validates monotonic progress and forwards updates to the webview.
 */
export function registerProgressHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(ProgressNotificationSchema, async (notification) => {
		const { progressToken, progress, total, message } = notification.params
		const tokenData = context.activeProgressTokens.get(progressToken)

		if (tokenData) {
			// Validate monotonic progress (SHOULD per spec)
			if (progress < tokenData.lastProgress) {
				console.warn(
					`[McpHub] Non-monotonic progress for token ${progressToken}: ${progress} < ${tokenData.lastProgress}`,
				)
			}
			tokenData.lastProgress = progress

			// Call the registered callback if present
			if (tokenData.callback) {
				tokenData.callback(progress, total, message)
			}

			// Forward to webview for UI updates
			const provider = context.getProvider()
			if (provider) {
				await provider.postMessageToWebview({
					type: "mcpProgress",
					payload: {
						serverName: tokenData.serverName,
						progressToken,
						progress,
						total,
						message,
					},
				})
			}
		}
	})
}

/**
 * Register cancellation notification handler.
 *
 * Servers send notifications/cancelled to abort pending requests.
 * This handler aborts the pending operation and cleans up tracking.
 */
export function registerCancellationHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
		const { requestId, reason } = notification.params

		// requestId is required per MCP spec, but SDK types may be loose
		if (requestId === undefined) {
			console.warn("[McpHub] Received cancellation without requestId")
			return
		}

		const pendingRequest = context.pendingRequests.get(requestId)

		if (pendingRequest) {
			console.log(`[McpHub] Received cancellation for request ${requestId}: ${reason ?? "no reason"}`)
			// Abort the pending operation
			pendingRequest.controller.abort(reason)
			// Clean up tracking
			context.pendingRequests.delete(requestId)
		} else {
			// Per MCP spec: ignore cancellation for unknown/completed requests
			console.debug(`[McpHub] Ignoring cancellation for unknown request ${requestId}`)
		}
	})
}

/**
 * Register task status notification handler.
 *
 * Servers send notifications/tasks/status to report task state changes.
 * This handler updates task tracking and forwards status to the webview.
 */
export function registerTaskStatusHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(TaskStatusNotificationSchema, async (notification) => {
		const { taskId, status, statusMessage, pollInterval } = notification.params
		const taskData = context.activeTasks.get(taskId)

		if (taskData) {
			taskData.status = status
			taskData.message = statusMessage
			if (pollInterval !== undefined) {
				taskData.pollInterval = pollInterval
			}
			taskData.updatedAt = Date.now()

			// Forward to webview for UI updates
			const provider = context.getProvider()
			if (provider) {
				await provider.postMessageToWebview({
					type: "mcpTaskStatus",
					payload: {
						serverName: taskData.serverName,
						taskId,
						status,
						statusMessage,
						pollInterval,
					},
				})
			}

			// Clean up completed/failed/cancelled tasks after notification
			if (status === "completed" || status === "failed" || status === "cancelled") {
				// Keep task data for result retrieval, but mark as terminal
				// Cleanup will happen when result is retrieved or after TTL
			}
		} else {
			console.debug(`[McpHub] Received status for unknown task ${taskId}`)
		}
	})
}

/**
 * Register logging message notification handler.
 *
 * Servers send notifications/message to forward log messages to the client.
 * This handler logs to console based on level and forwards to webview.
 */
export function registerLoggingHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
		const { level, logger, data } = notification.params

		// Log to console based on level
		const logMessage = `[MCP ${context.serverName}${logger ? ` - ${logger}` : ""}] ${typeof data === "string" ? data : JSON.stringify(data)}`
		switch (level) {
			case "debug":
				console.debug(logMessage)
				break
			case "info":
			case "notice":
				console.log(logMessage)
				break
			case "warning":
				console.warn(logMessage)
				break
			case "error":
			case "critical":
			case "alert":
			case "emergency":
				console.error(logMessage)
				break
			default:
				console.log(logMessage)
		}

		// Forward to webview for display in UI
		const provider = context.getProvider()
		if (provider) {
			await provider.postMessageToWebview({
				type: "mcpLogMessage",
				payload: {
					serverName: context.serverName,
					level,
					logger,
					data,
					timestamp: Date.now(),
				},
			})
		}

		// Also add to error history if it's a warning or error
		const connection = context.findConnection(context.serverName, context.source)
		if (
			connection &&
			(level === "warning" ||
				level === "error" ||
				level === "critical" ||
				level === "alert" ||
				level === "emergency")
		) {
			context.appendErrorMessage(
				connection,
				typeof data === "string" ? data : JSON.stringify(data),
				level === "warning" ? "warn" : "error",
			)
		}
	})
}

/**
 * Register resource list changed notification handler.
 *
 * Servers send notifications/resources/list_changed when resources are added/removed.
 * This handler refreshes the resource list and notifies the webview.
 */
export function registerResourceListChangedHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
		console.log(`[McpHub] Resource list changed for server ${context.serverName}`)
		try {
			const connection = context.findConnection(context.serverName, context.source)
			if (connection && connection.type === "connected") {
				connection.server.resources = await context.fetchResourcesList(context.serverName, context.source)
				await context.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error(`[McpHub] Error refreshing resources for ${context.serverName}:`, error)
		}
	})
}

/**
 * Register tool list changed notification handler.
 *
 * Servers send notifications/tools/list_changed when tools are added/removed.
 * This handler refreshes the tool list and notifies the webview.
 */
export function registerToolListChangedHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
		console.log(`[McpHub] Tool list changed for server ${context.serverName}`)
		try {
			const connection = context.findConnection(context.serverName, context.source)
			if (connection && connection.type === "connected") {
				connection.server.tools = await context.fetchToolsList(context.serverName, context.source)
				await context.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error(`[McpHub] Error refreshing tools for ${context.serverName}:`, error)
		}
	})
}

/**
 * Register prompt list changed notification handler.
 *
 * Servers send notifications/prompts/list_changed when prompts are added/removed.
 * This handler refreshes the prompt list and notifies the webview.
 */
export function registerPromptListChangedHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
		console.log(`[McpHub] Prompt list changed for server ${context.serverName}`)
		try {
			const connection = context.findConnection(context.serverName, context.source)
			if (connection && connection.type === "connected") {
				connection.server.prompts = await context.fetchPromptsList(context.serverName, context.source)
				await context.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error(`[McpHub] Error refreshing prompts for ${context.serverName}:`, error)
		}
	})
}

/**
 * Register resource updated notification handler.
 *
 * Servers send notifications/resources/updated when a subscribed resource changes.
 * This handler notifies the webview and refreshes resource metadata.
 */
export function registerResourceUpdatedHandler(client: Client, context: HandlerContext): void {
	client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
		const { uri } = notification.params
		console.log(`[McpHub] Resource updated for server ${context.serverName}: ${uri}`)

		try {
			// Forward to webview for UI updates
			const provider = context.getProvider()
			if (provider) {
				await provider.postMessageToWebview({
					type: "mcpResourceUpdated",
					payload: {
						serverName: context.serverName,
						uri,
						timestamp: Date.now(),
					},
				})
			}

			// Optionally refresh the resource list
			const connection = context.findConnection(context.serverName, context.source)
			if (connection && connection.type === "connected") {
				// Re-fetch resources to get updated metadata
				connection.server.resources = await context.fetchResourcesList(context.serverName, context.source)
				await context.notifyWebviewOfServerChanges()
			}
		} catch (error) {
			console.error(`[McpHub] Error handling resource update for ${context.serverName}:`, error)
		}
	})
}

/**
 * Register all notification handlers on an MCP client.
 *
 * This is a convenience function that registers all notification handlers at once.
 */
export function registerAllNotificationHandlers(client: Client, context: HandlerContext): void {
	registerProgressHandler(client, context)
	registerCancellationHandler(client, context)
	registerTaskStatusHandler(client, context)
	registerLoggingHandler(client, context)
	registerResourceListChangedHandler(client, context)
	registerToolListChangedHandler(client, context)
	registerPromptListChangedHandler(client, context)
	registerResourceUpdatedHandler(client, context)
}
