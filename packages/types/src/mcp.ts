import { z } from "zod"

/**
 * McpServerUse
 */

export interface McpServerUse {
	type: string
	serverName: string
	toolName?: string
	uri?: string
}

/**
 * McpExecutionStatus
 */

export const mcpExecutionStatusSchema = z.discriminatedUnion("status", [
	z.object({
		executionId: z.string(),
		status: z.literal("started"),
		serverName: z.string(),
		toolName: z.string(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("output"),
		response: z.string(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("completed"),
		response: z.string().optional(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("error"),
		error: z.string().optional(),
	}),
])

export type McpExecutionStatus = z.infer<typeof mcpExecutionStatusSchema>

/**
 * McpServer
 */

export type McpServer = {
	name: string
	config: string
	status: "connected" | "connecting" | "disconnected"
	error?: string
	errorHistory?: McpErrorEntry[]
	tools?: McpTool[]
	resources?: McpResource[]
	resourceTemplates?: McpResourceTemplate[]
	prompts?: McpPrompt[]
	disabled?: boolean
	timeout?: number
	source?: "global" | "project"
	projectPath?: string
	instructions?: string
}

export type McpTool = {
	name: string
	description?: string
	inputSchema?: object
	alwaysAllow?: boolean
	enabledForPrompt?: boolean
}

export type McpResource = {
	uri: string
	name: string
	mimeType?: string
	description?: string
}

export type McpResourceTemplate = {
	uriTemplate: string
	name: string
	description?: string
	mimeType?: string
}

export type McpPrompt = {
	name: string
	description?: string
	arguments?: Array<{
		name: string
		description?: string
		required?: boolean
	}>
}

export type McpPromptResponse = {
	description?: string
	messages: Array<{
		role: "user" | "assistant"
		content:
			| {
					type: "text"
					text: string
			  }
			| {
					type: "image"
					data: string
					mimeType: string
			  }
			| {
					type: "resource"
					resource: {
						uri: string
						mimeType?: string
						text?: string
						blob?: string
					}
			  }
	}>
}

export type McpResourceResponse = {
	_meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	contents: Array<{
		uri: string
		mimeType?: string
		text?: string
		blob?: string
	}>
}

export type McpToolCallResponse = {
	_meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	content: Array<
		| {
				type: "text"
				text: string
		  }
		| {
				type: "image"
				data: string
				mimeType: string
		  }
		| {
				type: "audio"
				data: string
				mimeType: string
		  }
		| {
				type: "resource"
				resource: {
					uri: string
					mimeType?: string
					text?: string
					blob?: string
				}
		  }
	>
	isError?: boolean
}

export type McpErrorEntry = {
	message: string
	timestamp: number
	level: "error" | "warn" | "info"
}

/**
 * MCP Sampling Types (Server → Client)
 * Per MCP 2025-11-25 spec: sampling/createMessage
 */

export type McpSamplingMessageContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }

/**
 * Tool use content - when the model wants to use a tool (MCP 2025-11-25)
 */
export type McpSamplingToolUseContent = {
	type: "tool_use"
	toolUseId: string
	name: string
	input: Record<string, unknown>
}

/**
 * Tool result content - the result of a tool execution (MCP 2025-11-25)
 */
export type McpSamplingToolResultContent = {
	type: "tool_result"
	toolUseId: string
	content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
	isError?: boolean
}

/**
 * Extended message content that can include tool use/results (MCP 2025-11-25)
 */
export type McpSamplingExtendedContent =
	| McpSamplingMessageContent
	| McpSamplingToolUseContent
	| McpSamplingToolResultContent

/**
 * Tool definition for sampling requests (MCP 2025-11-25)
 */
export type McpSamplingTool = {
	name: string
	description?: string
	inputSchema: {
		type: "object"
		properties?: Record<string, unknown>
		required?: string[]
	}
}

/**
 * Tool choice for sampling requests (MCP 2025-11-25)
 */
export type McpSamplingToolChoice = {
	/** Controls when tools are used: auto (default), required, or none */
	mode?: "auto" | "required" | "none"
}

export type McpSamplingRequest = {
	messages: Array<{
		role: "user" | "assistant"
		content: McpSamplingMessageContent | McpSamplingExtendedContent[]
	}>
	modelPreferences?: {
		hints?: Array<{ name?: string }>
		costPriority?: number
		speedPriority?: number
		intelligencePriority?: number
	}
	systemPrompt?: string
	includeContext?: "none" | "thisServer" | "allServers"
	temperature?: number
	maxTokens: number
	stopSequences?: string[]
	metadata?: Record<string, unknown>
	/** Tools available for the model to use (MCP 2025-11-25) */
	tools?: McpSamplingTool[]
	/** Controls how the model uses tools (MCP 2025-11-25) */
	toolChoice?: McpSamplingToolChoice
}

export type McpSamplingResponse = {
	role: "user" | "assistant"
	content: McpSamplingMessageContent | McpSamplingExtendedContent[]
	model: string
	stopReason?: "endTurn" | "stopSequence" | "maxTokens" | "toolUse"
}

/**
 * MCP Elicitation Types (Server → Client)
 * Per MCP 2025-11-25 spec: elicitation/create
 */

export type McpElicitationPropertySchema = {
	type: "string" | "number" | "boolean"
	title?: string
	description?: string
	enum?: string[]
	default?: unknown
}

export type McpElicitationRequest = {
	message: string
	requestedSchema: {
		type: "object"
		properties: Record<string, McpElicitationPropertySchema>
		required?: string[]
	}
}

export type McpElicitationResponse = {
	action: "accept" | "decline" | "cancel"
	content?: Record<string, unknown>
}
