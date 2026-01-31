/**
 * Handler for MCP roots/list requests.
 *
 * Per MCP 2025-11-25 spec, this allows servers to query the client
 * for filesystem boundaries (workspace roots).
 */

import * as vscode from "vscode"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

/**
 * Register the roots/list request handler on an MCP client.
 *
 * This handler returns the VS Code workspace folders as MCP roots,
 * allowing servers to understand the client's filesystem boundaries.
 */
export function registerRootsHandler(client: Client): void {
	client.setRequestHandler(ListRootsRequestSchema, async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? []
		return {
			roots: workspaceFolders.map((folder) => ({
				uri: folder.uri.toString(),
				name: folder.name,
			})),
		}
	})
}
