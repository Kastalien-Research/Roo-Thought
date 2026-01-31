/**
 * Handler for MCP sampling/createMessage requests.
 *
 * Per MCP 2025-11-25 spec, sampling allows servers to request LLM completions
 * from the client. This implements the human-in-the-loop approval workflow.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"

import type { McpSamplingRequest, ClineAskUseMcpServer } from "@roo-code/types"

import type { HandlerContext } from "./types"

/**
 * Register the sampling/createMessage request handler on an MCP client.
 *
 * This handler:
 * 1. Converts MCP message format to a format suitable for the webview
 * 2. Asks the user for approval via the webview
 * 3. If approved, forwards the request to the task's LLM API
 * 4. Returns the LLM response in MCP format
 */
export function registerSamplingHandler(client: Client, context: HandlerContext): void {
	client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
		// Get provider and current task
		const provider = context.getProvider()
		if (!provider) {
			throw new McpError(ErrorCode.InternalError, "No active provider for sampling request")
		}

		const task = provider.getCurrentTask()
		if (!task) {
			throw new McpError(ErrorCode.InternalError, "No active task for sampling request")
		}

		// Build the sampling request data for the webview
		// Handle MCP SDK message content which can be string or content object
		const samplingRequest: McpSamplingRequest = {
			messages: request.params.messages.map((msg) => {
				const content = msg.content
				// Content can be a string, a single content object, or an array
				if (typeof content === "string") {
					return { role: msg.role, content: { type: "text" as const, text: content } }
				}
				if (Array.isArray(content)) {
					// Take the first text content from the array
					const textContent = content.find((c) => c.type === "text")
					const text = textContent && "text" in textContent ? textContent.text : ""
					return { role: msg.role, content: { type: "text" as const, text } }
				}
				// Single content object
				if (content.type === "text") {
					return { role: msg.role, content: { type: "text" as const, text: content.text } }
				}
				if (content.type === "image") {
					return {
						role: msg.role,
						content: { type: "image" as const, data: content.data, mimeType: content.mimeType },
					}
				}
				// Fallback for unknown content types
				return { role: msg.role, content: { type: "text" as const, text: "[Unknown content type]" } }
			}),
			modelPreferences: request.params.modelPreferences,
			systemPrompt: request.params.systemPrompt,
			includeContext: request.params.includeContext,
			temperature: request.params.temperature,
			maxTokens: request.params.maxTokens,
			stopSequences: request.params.stopSequences,
			metadata: request.params.metadata as Record<string, unknown> | undefined,
			// Tool-augmented sampling (MCP 2025-11-25)
			tools: request.params.tools?.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema as {
					type: "object"
					properties?: Record<string, unknown>
					required?: string[]
				},
			})),
			toolChoice: request.params.toolChoice as { mode?: "auto" | "required" | "none" } | undefined,
		}

		const askData: ClineAskUseMcpServer = {
			type: "mcp_sampling",
			serverName: context.serverName,
			samplingRequest,
		}

		// Ask user for approval via webview
		const { response } = await task.ask("use_mcp_server", JSON.stringify(askData))

		if (response === "noButtonClicked") {
			throw new McpError(ErrorCode.InvalidRequest, "User declined sampling request")
		}

		// User approved - forward to LLM
		try {
			const api = task.api
			if (!api) {
				throw new McpError(ErrorCode.InternalError, "No API available for sampling")
			}

			// Convert MCP messages to Anthropic format
			const anthropicMessages: Array<{ role: "user" | "assistant"; content: string }> =
				samplingRequest.messages.map((msg) => {
					// Handle content that can be single object or array
					const content = msg.content
					if (Array.isArray(content)) {
						// Extract text from array of content blocks
						const textParts = content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
						return {
							role: msg.role as "user" | "assistant",
							content: textParts.join("\n") || "[Non-text content]",
						}
					}
					// Single content object
					return {
						role: msg.role as "user" | "assistant",
						content: content.type === "text" ? content.text : "[Non-text content]",
					}
				})

			// Build system prompt
			const systemPrompt = samplingRequest.systemPrompt ?? ""

			// Convert MCP tools to OpenAI format for the API
			const openaiTools = samplingRequest.tools?.map((tool) => ({
				type: "function" as const,
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.inputSchema,
				},
			}))

			// Map MCP toolChoice to OpenAI format
			const openaiToolChoice = samplingRequest.toolChoice?.mode as "none" | "auto" | "required" | undefined

			// Create the message stream
			// Note: temperature/maxTokens from MCP request are not passed through
			// as the API handler uses the task's configured settings
			const stream = api.createMessage(
				systemPrompt,
				anthropicMessages as any, // Anthropic SDK types
				{
					taskId: task.taskId,
					tools: openaiTools,
					tool_choice: openaiToolChoice,
				},
			)

			// Consume the stream and collect text
			let responseText = ""
			let stopReason: "endTurn" | "stopSequence" | "maxTokens" = "endTurn"

			for await (const chunk of stream) {
				if (chunk.type === "text") {
					responseText += chunk.text
				} else if (chunk.type === "error") {
					throw new McpError(ErrorCode.InternalError, chunk.message ?? "Unknown error")
				}
			}

			// Check for stop sequences
			if (samplingRequest.stopSequences?.length) {
				for (const seq of samplingRequest.stopSequences) {
					if (responseText.includes(seq)) {
						responseText = responseText.split(seq)[0]
						stopReason = "stopSequence"
						break
					}
				}
			}

			return {
				role: "assistant" as const,
				content: {
					type: "text" as const,
					text: responseText,
				},
				model: api.getModel().id,
				stopReason,
			}
		} catch (error) {
			throw new McpError(
				ErrorCode.InternalError,
				`Failed to process sampling request: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	})
}
