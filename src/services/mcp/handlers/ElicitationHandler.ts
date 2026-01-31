/**
 * Handler for MCP elicitation/create requests.
 *
 * Per MCP 2025-11-25 spec, elicitation allows servers to request user input
 * via forms. This implements the form UI workflow via the webview.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js"

import type { McpElicitationRequest, ClineAskUseMcpServer } from "@roo-code/types"

import type { HandlerContext } from "./types"

/**
 * Register the elicitation/create request handler on an MCP client.
 *
 * This handler:
 * 1. Checks if the request is form mode (URL mode is not supported)
 * 2. Converts the JSON Schema to a format suitable for the webview form
 * 3. Asks the user to fill out the form via the webview
 * 4. Returns the user's input or a decline action
 */
export function registerElicitationHandler(client: Client, context: HandlerContext): void {
	client.setRequestHandler(ElicitRequestSchema, async (request) => {
		// Get provider and current task
		const provider = context.getProvider()
		if (!provider) {
			return { action: "decline" as const }
		}

		const task = provider.getCurrentTask()
		if (!task) {
			return { action: "decline" as const }
		}

		// Elicitation can be form mode or URL mode - we only support form mode
		const params = request.params
		if ("url" in params) {
			// URL mode - redirect user to external URL, not supported
			return { action: "decline" as const }
		}

		// Build the elicitation request data for the webview (form mode)
		const elicitationRequest: McpElicitationRequest = {
			message: params.message,
			requestedSchema: {
				type: "object" as const,
				properties: Object.fromEntries(
					Object.entries(params.requestedSchema.properties).map(([key, prop]) => [
						key,
						{
							type: prop.type as "string" | "number" | "boolean",
							title: prop.title,
							description: prop.description,
							enum: "enum" in prop ? (prop.enum as string[]) : undefined,
							default: prop.default,
						},
					]),
				),
				required: params.requestedSchema.required,
			},
		}

		const askData: ClineAskUseMcpServer = {
			type: "mcp_elicitation",
			serverName: context.serverName,
			elicitationRequest,
		}

		// Ask user for input via webview form
		const { response, text } = await task.ask("use_mcp_server", JSON.stringify(askData))

		if (response === "noButtonClicked") {
			return { action: "decline" as const }
		}

		// User submitted the form - parse the response
		try {
			const formData = text ? JSON.parse(text) : {}
			return {
				action: "accept" as const,
				content: formData,
			}
		} catch {
			return { action: "decline" as const }
		}
	})
}
