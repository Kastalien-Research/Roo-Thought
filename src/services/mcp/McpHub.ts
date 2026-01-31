import * as fs from "fs/promises"
import * as path from "path"
import crypto from "crypto"

import * as vscode from "vscode"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import ReconnectingEventSource from "reconnecting-eventsource"
import {
	CallToolResultSchema,
	CompleteResultSchema,
	GetPromptResultSchema,
	ListPromptsResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ReadResourceResultSchema,
	// Progress tracking (MCP 2025-11-25)
	ProgressTokenSchema,
	ProgressNotificationSchema,
	// Tasks (MCP 2025-11-25)
	TaskSchema,
	CreateTaskResultSchema,
	GetTaskRequestSchema,
	GetTaskResultSchema,
	ListTasksRequestSchema,
	ListTasksResultSchema,
	CancelTaskRequestSchema,
	CancelTaskResultSchema,
	TaskStatusNotificationSchema,
	// Roots (MCP 2025-11-25) - server requests workspace roots from client
	ListRootsRequestSchema,
	RootsListChangedNotificationSchema,
	// Sampling (MCP 2025-11-25) - server requests LLM completions from client
	CreateMessageRequestSchema,
	// Elicitation (MCP 2025-11-25) - server requests user input from client
	ElicitRequestSchema,
	// Logging (MCP 2025-11-25) - server sends log messages to client
	LoggingMessageNotificationSchema,
	// Resource/Tool/Prompt list change notifications
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
	PromptListChangedNotificationSchema,
	ResourceUpdatedNotificationSchema,
	// Cancellation notifications
	CancelledNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { SamplingMessage, Tool as McpSdkTool, PrimitiveSchemaDefinition } from "@modelcontextprotocol/sdk/types.js"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"

import { registerAllHandlers, type HandlerContext } from "./handlers"
import chokidar, { FSWatcher } from "chokidar"
import delay from "delay"
import deepEqual from "fast-deep-equal"
import { z } from "zod"

import type {
	McpPrompt,
	McpPromptResponse,
	McpResource,
	McpResourceResponse,
	McpResourceTemplate,
	McpServer,
	McpTool,
	McpToolCallResponse,
	McpSamplingRequest,
	McpSamplingTool,
	McpElicitationRequest,
	ClineAskUseMcpServer,
} from "@roo-code/types"

import { t } from "../../i18n"

import { ClineProvider } from "../../core/webview/ClineProvider"

import { GlobalFileNames } from "../../shared/globalFileNames"

import { fileExistsAtPath } from "../../utils/fs"
import { arePathsEqual, getWorkspacePath } from "../../utils/path"
import { injectVariables } from "../../utils/config"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { sanitizeMcpName, validateMcpToolName } from "../../utils/mcp-name"
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js"
import { getDisplayName as sdkGetDisplayName } from "@modelcontextprotocol/sdk/shared/metadataUtils.js"

// Discriminated union for connection states
export type ConnectedMcpConnection = {
	type: "connected"
	server: McpServer
	client: Client
	transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
}

export type DisconnectedMcpConnection = {
	type: "disconnected"
	server: McpServer
	client: null
	transport: null
}

export type McpConnection = ConnectedMcpConnection | DisconnectedMcpConnection

// Enum for disable reasons
export enum DisableReason {
	MCP_DISABLED = "mcpDisabled",
	SERVER_DISABLED = "serverDisabled",
}

// Base configuration schema for common settings
const BaseConfigSchema = z.object({
	disabled: z.boolean().optional(),
	timeout: z.number().min(1).max(3600).optional().default(60),
	alwaysAllow: z.array(z.string()).default([]),
	watchPaths: z.array(z.string()).optional(), // paths to watch for changes and restart server
	disabledTools: z.array(z.string()).default([]),
})

// Custom error messages for better user feedback
const typeErrorMessage = "Server type must be 'stdio', 'sse', or 'streamable-http'"
const stdioFieldsErrorMessage =
	"For 'stdio' type servers, you must provide a 'command' field and can optionally include 'args' and 'env'"
const sseFieldsErrorMessage =
	"For 'sse' type servers, you must provide a 'url' field and can optionally include 'headers'"
const streamableHttpFieldsErrorMessage =
	"For 'streamable-http' type servers, you must provide a 'url' field and can optionally include 'headers'"
const mixedFieldsErrorMessage =
	"Cannot mix 'stdio' and ('sse' or 'streamable-http') fields. For 'stdio' use 'command', 'args', and 'env'. For 'sse'/'streamable-http' use 'url' and 'headers'"
const missingFieldsErrorMessage =
	"Server configuration must include either 'command' (for stdio) or 'url' (for sse/streamable-http) and a corresponding 'type' if 'url' is used."

// Helper function to create a refined schema with better error messages
const createServerTypeSchema = () => {
	return z.union([
		// Stdio config (has command field)
		BaseConfigSchema.extend({
			type: z.enum(["stdio"]).optional(),
			command: z.string().min(1, "Command cannot be empty"),
			args: z.array(z.string()).optional(),
			cwd: z.string().default(() => vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? process.cwd()),
			env: z.record(z.string()).optional(),
			// Ensure no SSE fields are present
			url: z.undefined().optional(),
			headers: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "stdio" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "stdio", { message: typeErrorMessage }),
		// SSE config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["sse"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "sse" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "sse", { message: typeErrorMessage }),
		// StreamableHTTP config (has url field)
		BaseConfigSchema.extend({
			type: z.enum(["streamable-http"]).optional(),
			url: z.string().url("URL must be a valid URL format"),
			headers: z.record(z.string()).optional(),
			// Ensure no stdio fields are present
			command: z.undefined().optional(),
			args: z.undefined().optional(),
			env: z.undefined().optional(),
		})
			.transform((data) => ({
				...data,
				type: "streamable-http" as const,
			}))
			.refine((data) => data.type === undefined || data.type === "streamable-http", {
				message: typeErrorMessage,
			}),
	])
}

// Server configuration schema with automatic type inference and validation
export const ServerConfigSchema = createServerTypeSchema()

// Settings schema
const McpSettingsSchema = z.object({
	mcpServers: z.record(ServerConfigSchema),
})

export class McpHub {
	private providerRef: WeakRef<ClineProvider>
	private disposables: vscode.Disposable[] = []
	private settingsWatcher?: vscode.FileSystemWatcher
	private fileWatchers: Map<string, FSWatcher[]> = new Map()
	private projectMcpWatcher?: vscode.FileSystemWatcher
	private isDisposed: boolean = false
	connections: McpConnection[] = []
	isConnecting: boolean = false
	private refCount: number = 0 // Reference counter for active clients
	private configChangeDebounceTimers: Map<string, NodeJS.Timeout> = new Map()
	private isProgrammaticUpdate: boolean = false
	private flagResetTimer?: NodeJS.Timeout
	private sanitizedNameRegistry: Map<string, string> = new Map()

	// Progress tracking (MCP 2025-11-25)
	// Maps progressToken -> { serverName, callback, lastProgress }
	private activeProgressTokens: Map<
		string | number,
		{
			serverName: string
			callback?: (progress: number, total?: number, message?: string) => void
			lastProgress: number
		}
	> = new Map()

	// Request cancellation tracking (MCP 2025-11-25)
	// Maps requestId -> AbortController for pending requests
	private pendingRequests: Map<string | number, { serverName: string; controller: AbortController }> = new Map()

	// Tasks tracking (MCP 2025-11-25)
	// Maps taskId -> task state for long-running operations
	private activeTasks: Map<
		string,
		{
			serverName: string
			source?: "global" | "project"
			status: "working" | "input_required" | "completed" | "failed" | "cancelled"
			progressToken?: string | number
			pollInterval?: number
			message?: string
			createdAt: number
			updatedAt: number
		}
	> = new Map()

	// Resource subscriptions tracking (MCP 2025-11-25)
	// Maps serverName -> Set of subscribed resource URIs
	private resourceSubscriptions: Map<string, Set<string>> = new Map()

	constructor(provider: ClineProvider) {
		this.providerRef = new WeakRef(provider)
		this.watchMcpSettingsFile()
		this.watchProjectMcpFile().catch(console.error)
		this.setupWorkspaceFoldersWatcher()
		this.initializeGlobalMcpServers()
		this.initializeProjectMcpServers()
	}
	/**
	 * Registers a client (e.g., ClineProvider) using this hub.
	 * Increments the reference count.
	 */
	public registerClient(): void {
		this.refCount++
		// console.log(`McpHub: Client registered. Ref count: ${this.refCount}`)
	}

	/**
	 * Unregisters a client. Decrements the reference count.
	 * If the count reaches zero, disposes the hub.
	 */
	public async unregisterClient(): Promise<void> {
		this.refCount--

		// console.log(`McpHub: Client unregistered. Ref count: ${this.refCount}`)

		if (this.refCount <= 0) {
			console.log("McpHub: Last client unregistered. Disposing hub.")
			await this.dispose()
		}
	}

	/**
	 * Validates and normalizes server configuration
	 * @param config The server configuration to validate
	 * @param serverName Optional server name for error messages
	 * @returns The validated configuration
	 * @throws Error if the configuration is invalid
	 */
	private validateServerConfig(config: any, serverName?: string): z.infer<typeof ServerConfigSchema> {
		// Detect configuration issues before validation
		const hasStdioFields = config.command !== undefined
		const hasUrlFields = config.url !== undefined // Covers sse and streamable-http

		// Check for mixed fields (stdio vs url-based)
		if (hasStdioFields && hasUrlFields) {
			throw new Error(mixedFieldsErrorMessage)
		}

		// Infer type for stdio if not provided
		if (!config.type && hasStdioFields) {
			config.type = "stdio"
		}

		// For url-based configs, type must be provided by the user
		if (hasUrlFields && !config.type) {
			throw new Error("Configuration with 'url' must explicitly specify 'type' as 'sse' or 'streamable-http'.")
		}

		// Validate type if provided
		if (config.type && !["stdio", "sse", "streamable-http"].includes(config.type)) {
			throw new Error(typeErrorMessage)
		}

		// Check for type/field mismatch
		if (config.type === "stdio" && !hasStdioFields) {
			throw new Error(stdioFieldsErrorMessage)
		}
		if (config.type === "sse" && !hasUrlFields) {
			throw new Error(sseFieldsErrorMessage)
		}
		if (config.type === "streamable-http" && !hasUrlFields) {
			throw new Error(streamableHttpFieldsErrorMessage)
		}

		// If neither command nor url is present (type alone is not enough)
		if (!hasStdioFields && !hasUrlFields) {
			throw new Error(missingFieldsErrorMessage)
		}

		// Validate the config against the schema
		try {
			return ServerConfigSchema.parse(config)
		} catch (validationError) {
			if (validationError instanceof z.ZodError) {
				// Extract and format validation errors
				const errorMessages = validationError.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("; ")
				throw new Error(
					serverName
						? `Invalid configuration for server "${serverName}": ${errorMessages}`
						: `Invalid server configuration: ${errorMessages}`,
				)
			}
			throw validationError
		}
	}

	/**
	 * Formats and displays error messages to the user
	 * @param message The error message prefix
	 * @param error The error object
	 */
	private showErrorMessage(message: string, error: unknown): void {
		console.error(`${message}:`, error)
	}

	public setupWorkspaceFoldersWatcher(): void {
		// Skip if test environment is detected
		if (process.env.NODE_ENV === "test") {
			return
		}

		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(async () => {
				await this.updateProjectMcpServers()
				await this.watchProjectMcpFile()
				// Notify all connected MCP servers that roots have changed (MCP 2025-11-25)
				await this.notifyRootsListChanged()
			}),
		)
	}

	/**
	 * Debounced wrapper for handling config file changes
	 */
	private debounceConfigChange(filePath: string, source: "global" | "project"): void {
		// Skip processing if this is a programmatic update to prevent unnecessary server restarts
		if (this.isProgrammaticUpdate) {
			return
		}

		const key = `${source}-${filePath}`

		// Clear existing timer if any
		const existingTimer = this.configChangeDebounceTimers.get(key)
		if (existingTimer) {
			clearTimeout(existingTimer)
		}

		// Set new timer
		const timer = setTimeout(async () => {
			this.configChangeDebounceTimers.delete(key)
			await this.handleConfigFileChange(filePath, source)
		}, 500) // 500ms debounce

		this.configChangeDebounceTimers.set(key, timer)
	}

	private async handleConfigFileChange(filePath: string, source: "global" | "project"): Promise<void> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			const result = McpSettingsSchema.safeParse(config)

			if (!result.success) {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))
				return
			}

			await this.updateServerConnections(result.data.mcpServers || {}, source)
		} catch (error) {
			// Check if the error is because the file doesn't exist
			if (error.code === "ENOENT" && source === "project") {
				// File was deleted, clean up project MCP servers
				await this.cleanupProjectMcpServers()
				await this.notifyWebviewOfServerChanges()
				vscode.window.showInformationMessage(t("mcp:info.project_config_deleted"))
			} else {
				this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
			}
		}
	}

	private async watchProjectMcpFile(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		// Clean up existing project MCP watcher if it exists
		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		if (!vscode.workspace.workspaceFolders?.length) {
			return
		}

		const workspaceFolder = this.providerRef.deref()?.cwd ?? getWorkspacePath()
		const projectMcpPattern = new vscode.RelativePattern(workspaceFolder, ".roo/mcp.json")

		// Create a file system watcher for the project MCP file pattern
		this.projectMcpWatcher = vscode.workspace.createFileSystemWatcher(projectMcpPattern)

		// Watch for file changes
		const changeDisposable = this.projectMcpWatcher.onDidChange((uri) => {
			this.debounceConfigChange(uri.fsPath, "project")
		})

		// Watch for file creation
		const createDisposable = this.projectMcpWatcher.onDidCreate((uri) => {
			this.debounceConfigChange(uri.fsPath, "project")
		})

		// Watch for file deletion
		const deleteDisposable = this.projectMcpWatcher.onDidDelete(async () => {
			// Clean up all project MCP servers when the file is deleted
			await this.cleanupProjectMcpServers()
			await this.notifyWebviewOfServerChanges()
			vscode.window.showInformationMessage(t("mcp:info.project_config_deleted"))
		})

		this.disposables.push(
			vscode.Disposable.from(changeDisposable, createDisposable, deleteDisposable, this.projectMcpWatcher),
		)
	}

	private async updateProjectMcpServers(): Promise<void> {
		try {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) return

			const content = await fs.readFile(projectMcpPath, "utf-8")
			let config: any

			try {
				config = JSON.parse(content)
			} catch (parseError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, parseError)
				vscode.window.showErrorMessage(errorMessage)
				return
			}

			// Validate configuration structure
			const result = McpSettingsSchema.safeParse(config)
			if (result.success) {
				await this.updateServerConnections(result.data.mcpServers || {}, "project")
			} else {
				// Format validation errors for better user feedback
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				console.error("Invalid project MCP settings format:", errorMessages)
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))
			}
		} catch (error) {
			this.showErrorMessage(t("mcp:errors.failed_update_project"), error)
		}
	}

	private async cleanupProjectMcpServers(): Promise<void> {
		// Disconnect and remove all project MCP servers
		const projectConnections = this.connections.filter((conn) => conn.server.source === "project")

		for (const conn of projectConnections) {
			await this.deleteConnection(conn.server.name, "project")
		}

		// Clear project servers from the connections list
		await this.updateServerConnections({}, "project", false)
	}

	getServers(): McpServer[] {
		// Only return enabled servers, deduplicating by name with project servers taking priority
		const enabledConnections = this.connections.filter((conn) => !conn.server.disabled)

		// Deduplicate by server name: project servers take priority over global servers
		const serversByName = new Map<string, McpServer>()
		for (const conn of enabledConnections) {
			const existing = serversByName.get(conn.server.name)
			if (!existing) {
				serversByName.set(conn.server.name, conn.server)
			} else if (conn.server.source === "project" && existing.source !== "project") {
				// Project server overrides global server with the same name
				serversByName.set(conn.server.name, conn.server)
			}
			// If existing is project and current is global, keep existing (project wins)
		}

		return Array.from(serversByName.values())
	}

	getAllServers(): McpServer[] {
		// Return all servers regardless of state
		return this.connections.map((conn) => conn.server)
	}

	async getMcpServersPath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpServersPath = await provider.ensureMcpServersDirectoryExists()
		return mcpServersPath
	}

	async getMcpSettingsFilePath(): Promise<string> {
		const provider = this.providerRef.deref()
		if (!provider) {
			throw new Error("Provider not available")
		}
		const mcpSettingsFilePath = path.join(
			await provider.ensureSettingsDirectoryExists(),
			GlobalFileNames.mcpSettings,
		)
		const fileExists = await fileExistsAtPath(mcpSettingsFilePath)
		if (!fileExists) {
			await fs.writeFile(
				mcpSettingsFilePath,
				`{
  "mcpServers": {

  }
}`,
			)
		}
		return mcpSettingsFilePath
	}

	private async watchMcpSettingsFile(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		// Clean up existing settings watcher if it exists
		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}

		const settingsPath = await this.getMcpSettingsFilePath()
		const settingsUri = vscode.Uri.file(settingsPath)
		const settingsPattern = new vscode.RelativePattern(path.dirname(settingsPath), path.basename(settingsPath))

		// Create a file system watcher for the global MCP settings file
		this.settingsWatcher = vscode.workspace.createFileSystemWatcher(settingsPattern)

		// Watch for file changes
		const changeDisposable = this.settingsWatcher.onDidChange((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounceConfigChange(settingsPath, "global")
			}
		})

		// Watch for file creation
		const createDisposable = this.settingsWatcher.onDidCreate((uri) => {
			if (arePathsEqual(uri.fsPath, settingsPath)) {
				this.debounceConfigChange(settingsPath, "global")
			}
		})

		this.disposables.push(vscode.Disposable.from(changeDisposable, createDisposable, this.settingsWatcher))
	}

	private async initializeMcpServers(source: "global" | "project"): Promise<void> {
		try {
			const configPath =
				source === "global" ? await this.getMcpSettingsFilePath() : await this.getProjectMcpPath()

			if (!configPath) {
				return
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)
			const result = McpSettingsSchema.safeParse(config)

			if (result.success) {
				// Pass all servers including disabled ones - they'll be handled in updateServerConnections
				await this.updateServerConnections(result.data.mcpServers || {}, source, false)
			} else {
				const errorMessages = result.error.errors
					.map((err) => `${err.path.join(".")}: ${err.message}`)
					.join("\n")
				console.error(`Invalid ${source} MCP settings format:`, errorMessages)
				vscode.window.showErrorMessage(t("mcp:errors.invalid_settings_validation", { errorMessages }))

				if (source === "global") {
					// Still try to connect with the raw config, but show warnings
					try {
						await this.updateServerConnections(config.mcpServers || {}, source, false)
					} catch (error) {
						this.showErrorMessage(`Failed to initialize ${source} MCP servers with raw config`, error)
					}
				}
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				const errorMessage = t("mcp:errors.invalid_settings_syntax")
				console.error(errorMessage, error)
				vscode.window.showErrorMessage(errorMessage)
			} else {
				this.showErrorMessage(`Failed to initialize ${source} MCP servers`, error)
			}
		}
	}

	private async initializeGlobalMcpServers(): Promise<void> {
		await this.initializeMcpServers("global")
	}

	// Get project-level MCP configuration path
	private async getProjectMcpPath(): Promise<string | null> {
		const workspacePath = this.providerRef.deref()?.cwd ?? getWorkspacePath()
		const projectMcpDir = path.join(workspacePath, ".roo")
		const projectMcpPath = path.join(projectMcpDir, "mcp.json")

		try {
			await fs.access(projectMcpPath)
			return projectMcpPath
		} catch {
			return null
		}
	}

	// Initialize project-level MCP servers
	private async initializeProjectMcpServers(): Promise<void> {
		await this.initializeMcpServers("project")
	}

	/**
	 * Creates a placeholder connection for disabled servers or when MCP is globally disabled
	 * @param name The server name
	 * @param config The server configuration
	 * @param source The source of the server (global or project)
	 * @param reason The reason for creating a placeholder (mcpDisabled or serverDisabled)
	 * @returns A placeholder DisconnectedMcpConnection object
	 */
	private createPlaceholderConnection(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project",
		reason: DisableReason,
	): DisconnectedMcpConnection {
		return {
			type: "disconnected",
			server: {
				name,
				config: JSON.stringify(config),
				status: "disconnected",
				disabled: reason === DisableReason.SERVER_DISABLED ? true : config.disabled,
				source,
				projectPath: source === "project" ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,
				errorHistory: [],
			},
			client: null,
			transport: null,
		}
	}

	/**
	 * Checks if MCP is globally enabled
	 * @returns Promise<boolean> indicating if MCP is enabled
	 */
	private async isMcpEnabled(): Promise<boolean> {
		const provider = this.providerRef.deref()
		if (!provider) {
			return true // Default to enabled if provider is not available
		}
		const state = await provider.getState()
		return state.mcpEnabled ?? true
	}

	private async connectToServer(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" = "global",
	): Promise<void> {
		// Remove existing connection if it exists with the same source
		await this.deleteConnection(name, source)

		// Register the sanitized name for O(1) lookup
		const sanitizedName = sanitizeMcpName(name)
		this.sanitizedNameRegistry.set(sanitizedName, name)

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			// Still create a connection object to track the server, but don't actually connect
			const connection = this.createPlaceholderConnection(name, config, source, DisableReason.MCP_DISABLED)
			this.connections.push(connection)
			return
		}

		// Skip connecting to disabled servers
		if (config.disabled) {
			// Still create a connection object to track the server, but don't actually connect
			const connection = this.createPlaceholderConnection(name, config, source, DisableReason.SERVER_DISABLED)
			this.connections.push(connection)
			return
		}

		// Set up file watchers for enabled servers
		this.setupFileWatcher(name, config, source)

		try {
			const client = new Client(
				{
					name: "Roo Code",
					version: this.providerRef.deref()?.context.extension?.packageJSON?.version ?? "1.0.0",
				},
				{
					capabilities: {
						roots: {
							listChanged: true,
						},
						// Sampling: servers can request LLM completions via sampling/createMessage
						// Requires user approval via webview, then forwards to task's API
						// tools: {} declares support for tool-augmented completions (MCP 2025-11-25)
						sampling: {
							tools: {},
						},
						// Elicitation: servers can request user input via elicitation/create
						// Renders form in webview, returns user-submitted data
						elicitation: {
							form: {}, // Support form-based input
						},
					},
				},
			)

			// Register handler for server-initiated roots/list requests
			// This allows MCP servers to query the client for filesystem boundaries
			client.setRequestHandler(ListRootsRequestSchema, async () => {
				const workspaceFolders = vscode.workspace.workspaceFolders ?? []
				return {
					roots: workspaceFolders.map((folder) => ({
						uri: folder.uri.toString(),
						name: folder.name,
					})),
				}
			})

			// Register handler for server-initiated sampling/createMessage requests
			// Per MCP spec, sampling allows servers to request LLM completions from the client
			// This implements the human-in-the-loop approval workflow via webview
			client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
				// Get provider and current task
				const provider = this.providerRef?.deref()
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
					messages: request.params.messages.map((msg: SamplingMessage) => {
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
					tools: request.params.tools?.map((tool: McpSdkTool) => ({
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
					serverName: name, // 'name' is from connectToServer method parameter
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
						samplingRequest.messages.map((msg: McpSamplingRequest["messages"][number]) => {
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
					const openaiTools = samplingRequest.tools?.map((tool: McpSamplingTool) => ({
						type: "function" as const,
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.inputSchema,
						},
					}))

					// Map MCP toolChoice to OpenAI format
					const openaiToolChoice = samplingRequest.toolChoice?.mode as
						| "none"
						| "auto"
						| "required"
						| undefined

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
							throw new McpError(ErrorCode.InternalError, chunk.message)
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

			// Register handler for server-initiated elicitation/create requests
			// Per MCP spec, elicitation allows servers to request user input via forms
			// This implements the form UI workflow via webview
			client.setRequestHandler(ElicitRequestSchema, async (request) => {
				// Get provider and current task
				const provider = this.providerRef?.deref()
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
							Object.entries(params.requestedSchema.properties).map(
								([key, prop]: [string, PrimitiveSchemaDefinition]) => [
									key,
									{
										type: prop.type as "string" | "number" | "boolean",
										title: prop.title,
										description: prop.description,
										enum: "enum" in prop ? (prop.enum as string[]) : undefined,
										default: prop.default,
									},
								],
							),
						),
						required: params.requestedSchema.required,
					},
				}

				const askData: ClineAskUseMcpServer = {
					type: "mcp_elicitation",
					serverName: name, // 'name' is from connectToServer method parameter
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

			// Register notification handler for progress updates (MCP 2025-11-25)
			// Servers send notifications/progress to report progress on long-running operations
			client.setNotificationHandler(ProgressNotificationSchema, async (notification) => {
				const { progressToken, progress, total, message } = notification.params
				const tokenData = this.activeProgressTokens.get(progressToken)

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
					const provider = this.providerRef?.deref()
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

			// Register notification handler for cancellation (MCP 2025-11-25)
			// Servers send notifications/cancelled to abort pending requests
			client.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
				const { requestId, reason } = notification.params

				// requestId is required per MCP spec, but SDK types may be loose
				if (requestId === undefined) {
					console.warn("[McpHub] Received cancellation without requestId")
					return
				}

				const pendingRequest = this.pendingRequests.get(requestId)

				if (pendingRequest) {
					console.log(`[McpHub] Received cancellation for request ${requestId}: ${reason ?? "no reason"}`)
					// Abort the pending operation
					pendingRequest.controller.abort(reason)
					// Clean up tracking
					this.pendingRequests.delete(requestId)
				} else {
					// Per MCP spec: ignore cancellation for unknown/completed requests
					console.debug(`[McpHub] Ignoring cancellation for unknown request ${requestId}`)
				}
			})

			// Register notification handler for task status updates (MCP 2025-11-25)
			// Servers send notifications/tasks/status to report task state changes
			client.setNotificationHandler(TaskStatusNotificationSchema, async (notification) => {
				const { taskId, status, statusMessage, pollInterval } = notification.params
				const taskData = this.activeTasks.get(taskId)

				if (taskData) {
					taskData.status = status
					taskData.message = statusMessage
					if (pollInterval !== undefined) {
						taskData.pollInterval = pollInterval
					}
					taskData.updatedAt = Date.now()

					// Forward to webview for UI updates
					const provider = this.providerRef?.deref()
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

			// Register notification handler for logging messages (MCP 2025-11-25)
			// Servers send notifications/message to forward log messages to the client
			client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
				const { level, logger, data } = notification.params

				// Log to console based on level
				const logMessage = `[MCP ${name}${logger ? ` - ${logger}` : ""}] ${typeof data === "string" ? data : JSON.stringify(data)}`
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
				const provider = this.providerRef?.deref()
				if (provider) {
					await provider.postMessageToWebview({
						type: "mcpLogMessage",
						payload: {
							serverName: name,
							level,
							logger,
							data,
							timestamp: Date.now(),
						},
					})
				}

				// Also add to error history if it's a warning or error
				const connection = this.findConnection(name, source)
				if (
					connection &&
					(level === "warning" ||
						level === "error" ||
						level === "critical" ||
						level === "alert" ||
						level === "emergency")
				) {
					this.appendErrorMessage(
						connection,
						typeof data === "string" ? data : JSON.stringify(data),
						level === "warning" ? "warn" : "error",
					)
				}
			})

			// Register notification handler for resource list changes (MCP 2025-11-25)
			// Servers send notifications/resources/list_changed when resources are added/removed
			client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
				console.log(`[McpHub] Resource list changed for server ${name}`)
				try {
					const connection = this.findConnection(name, source)
					if (connection && connection.type === "connected") {
						connection.server.resources = await this.fetchResourcesList(name, source)
						await this.notifyWebviewOfServerChanges()
					}
				} catch (error) {
					console.error(`[McpHub] Error refreshing resources for ${name}:`, error)
				}
			})

			// Register notification handler for tool list changes (MCP 2025-11-25)
			// Servers send notifications/tools/list_changed when tools are added/removed
			client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				console.log(`[McpHub] Tool list changed for server ${name}`)
				try {
					const connection = this.findConnection(name, source)
					if (connection && connection.type === "connected") {
						connection.server.tools = await this.fetchToolsList(name, source)
						await this.notifyWebviewOfServerChanges()
					}
				} catch (error) {
					console.error(`[McpHub] Error refreshing tools for ${name}:`, error)
				}
			})

			// Register notification handler for prompt list changes (MCP 2025-11-25)
			// Servers send notifications/prompts/list_changed when prompts are added/removed
			client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
				console.log(`[McpHub] Prompt list changed for server ${name}`)
				try {
					const connection = this.findConnection(name, source)
					if (connection && connection.type === "connected") {
						connection.server.prompts = await this.fetchPromptsList(name, source)
						await this.notifyWebviewOfServerChanges()
					}
				} catch (error) {
					console.error(`[McpHub] Error refreshing prompts for ${name}:`, error)
				}
			})

			// Register notification handler for resource updates (MCP 2025-11-25)
			// Servers send notifications/resources/updated when a subscribed resource changes
			client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
				const { uri } = notification.params
				console.log(`[McpHub] Resource updated for server ${name}: ${uri}`)

				try {
					// Forward to webview for UI updates
					const provider = this.providerRef?.deref()
					if (provider) {
						await provider.postMessageToWebview({
							type: "mcpResourceUpdated",
							payload: {
								serverName: name,
								uri,
								timestamp: Date.now(),
							},
						})
					}

					// Optionally refresh the resource list
					const connection = this.findConnection(name, source)
					if (connection && connection.type === "connected") {
						// Re-fetch resources to get updated metadata
						connection.server.resources = await this.fetchResourcesList(name, source)
						await this.notifyWebviewOfServerChanges()
					}
				} catch (error) {
					console.error(`[McpHub] Error handling resource update for ${name}:`, error)
				}
			})

			let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

			// Inject variables to the config (environment, magic variables,...)
			const configInjected = (await injectVariables(config, {
				env: process.env,
				workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
			})) as typeof config

			if (configInjected.type === "stdio") {
				// On Windows, wrap commands with cmd.exe to handle non-exe executables like npx.ps1
				// This is necessary for node version managers (fnm, nvm-windows, volta) that implement
				// commands as PowerShell scripts rather than executables.
				// Note: This adds a small overhead as commands go through an additional shell layer.
				const isWindows = process.platform === "win32"

				// Check if command is already cmd.exe to avoid double-wrapping
				const isAlreadyWrapped =
					configInjected.command.toLowerCase() === "cmd.exe" || configInjected.command.toLowerCase() === "cmd"

				const command = isWindows && !isAlreadyWrapped ? "cmd.exe" : configInjected.command
				const args =
					isWindows && !isAlreadyWrapped
						? ["/c", configInjected.command, ...(configInjected.args || [])]
						: configInjected.args

				transport = new StdioClientTransport({
					command,
					args,
					cwd: configInjected.cwd,
					env: {
						...getDefaultEnvironment(),
						...(configInjected.env || {}),
					},
					stderr: "pipe",
				})

				// Set up stdio specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}

				// transport.stderr is only available after the process has been started. However we can't start it separately from the .connect() call because it also starts the transport. And we can't place this after the connect call since we need to capture the stderr stream before the connection is established, in order to capture errors during the connection process.
				// As a workaround, we start the transport ourselves, and then monkey-patch the start method to no-op so that .connect() doesn't try to start it again.
				await transport.start()
				const stderrStream = transport.stderr
				if (stderrStream) {
					stderrStream.on("data", async (data: Buffer) => {
						const output = data.toString()
						// Check if output contains INFO level log
						const isInfoLog = /INFO/i.test(output)

						if (isInfoLog) {
							// Log normal informational messages
							console.log(`Server "${name}" info:`, output)
						} else {
							// Treat as error log
							console.error(`Server "${name}" stderr:`, output)
							const connection = this.findConnection(name, source)
							if (connection) {
								this.appendErrorMessage(connection, output)
								if (connection.server.status === "disconnected") {
									await this.notifyWebviewOfServerChanges()
								}
							}
						}
					})
				} else {
					console.error(`No stderr stream for ${name}`)
				}
			} else if (configInjected.type === "streamable-http") {
				// Streamable HTTP connection
				transport = new StreamableHTTPClientTransport(new URL(configInjected.url), {
					requestInit: {
						headers: configInjected.headers,
					},
				})

				// Set up Streamable HTTP specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}" (streamable-http):`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}
			} else if (configInjected.type === "sse") {
				// SSE connection
				const sseOptions = {
					requestInit: {
						headers: configInjected.headers,
					},
				}
				// Configure ReconnectingEventSource options
				const reconnectingEventSourceOptions = {
					max_retry_time: 5000, // Maximum retry time in milliseconds
					withCredentials: configInjected.headers?.["Authorization"] ? true : false, // Enable credentials if Authorization header exists
					fetch: (url: string | URL, init: RequestInit) => {
						const headers = new Headers({ ...(init?.headers || {}), ...(configInjected.headers || {}) })
						return fetch(url, {
							...init,
							headers,
						})
					},
				}
				global.EventSource = ReconnectingEventSource
				transport = new SSEClientTransport(new URL(configInjected.url), {
					...sseOptions,
					eventSourceInit: reconnectingEventSourceOptions,
				})

				// Set up SSE specific error handling
				transport.onerror = async (error) => {
					console.error(`Transport error for "${name}":`, error)
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					await this.notifyWebviewOfServerChanges()
				}

				transport.onclose = async () => {
					const connection = this.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await this.notifyWebviewOfServerChanges()
				}
			} else {
				// Should not happen if validateServerConfig is correct
				throw new Error(`Unsupported MCP server type: ${(configInjected as any).type}`)
			}

			// Only override transport.start for stdio transports that have already been started
			if (configInjected.type === "stdio") {
				transport.start = async () => {}
			}

			// Create a connected connection
			const connection: ConnectedMcpConnection = {
				type: "connected",
				server: {
					name,
					config: JSON.stringify(configInjected),
					status: "connecting",
					disabled: configInjected.disabled,
					source,
					projectPath: source === "project" ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,
					errorHistory: [],
				},
				client,
				transport,
			}
			this.connections.push(connection)

			// Connect (this will automatically start the transport)
			await client.connect(transport)
			connection.server.status = "connected"
			connection.server.error = ""
			connection.server.instructions = client.getInstructions()

			// Initial fetch of tools, resources, and prompts
			connection.server.tools = await this.fetchToolsList(name, source)
			connection.server.resources = await this.fetchResourcesList(name, source)
			connection.server.resourceTemplates = await this.fetchResourceTemplatesList(name, source)
			connection.server.prompts = await this.fetchPromptsList(name, source)
		} catch (error) {
			// Update status with error
			const connection = this.findConnection(name, source)
			if (connection) {
				connection.server.status = "disconnected"
				this.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
			}
			throw error
		}
	}

	private appendErrorMessage(connection: McpConnection, error: string, level: "error" | "warn" | "info" = "error") {
		const MAX_ERROR_LENGTH = 1000
		const truncatedError =
			error.length > MAX_ERROR_LENGTH
				? `${error.substring(0, MAX_ERROR_LENGTH)}...(error message truncated)`
				: error

		// Add to error history
		if (!connection.server.errorHistory) {
			connection.server.errorHistory = []
		}

		connection.server.errorHistory.push({
			message: truncatedError,
			timestamp: Date.now(),
			level,
		})

		// Keep only the last 100 errors
		if (connection.server.errorHistory.length > 100) {
			connection.server.errorHistory = connection.server.errorHistory.slice(-100)
		}

		// Update current error display
		connection.server.error = truncatedError
	}

	/**
	 * Helper method to find a connection by server name and source
	 * @param serverName The name of the server to find
	 * @param source Optional source to filter by (global or project)
	 * @returns The matching connection or undefined if not found
	 */
	private findConnection(serverName: string, source?: "global" | "project"): McpConnection | undefined {
		// If source is specified, only find servers with that source
		if (source !== undefined) {
			return this.connections.find((conn) => conn.server.name === serverName && conn.server.source === source)
		}

		// If no source is specified, first look for project servers, then global servers
		// This ensures that when servers have the same name, project servers are prioritized
		const projectConn = this.connections.find(
			(conn) => conn.server.name === serverName && conn.server.source === "project",
		)
		if (projectConn) return projectConn

		// If no project server is found, look for global servers
		return this.connections.find(
			(conn) => conn.server.name === serverName && (conn.server.source === "global" || !conn.server.source),
		)
	}

	/**
	 * Find a connection by sanitized server name.
	 * This is used when parsing MCP tool responses where the server name has been
	 * sanitized (e.g., hyphens replaced with underscores) for API compliance.
	 * @param sanitizedServerName The sanitized server name from the API tool call
	 * @returns The original server name if found, or null if no match
	 */
	public findServerNameBySanitizedName(sanitizedServerName: string): string | null {
		const exactMatch = this.connections.find((conn) => conn.server.name === sanitizedServerName)
		if (exactMatch) {
			return exactMatch.server.name
		}

		return this.sanitizedNameRegistry.get(sanitizedServerName) ?? null
	}

	private async fetchToolsList(serverName: string, source?: "global" | "project"): Promise<McpTool[]> {
		try {
			// Use the helper method to find the connection
			const connection = this.findConnection(serverName, source)

			if (!connection || connection.type !== "connected") {
				return []
			}

			const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema)

			// Determine the actual source of the server
			const actualSource = connection.server.source || "global"
			let configPath: string
			let alwaysAllowConfig: string[] = []
			let disabledToolsList: string[] = []

			// Read from the appropriate config file based on the actual source
			try {
				let serverConfigData: Record<string, any> = {}
				if (actualSource === "project") {
					// Get project MCP config path
					const projectMcpPath = await this.getProjectMcpPath()
					if (projectMcpPath) {
						configPath = projectMcpPath
						const content = await fs.readFile(configPath, "utf-8")
						serverConfigData = JSON.parse(content)
					}
				} else {
					// Get global MCP settings path
					configPath = await this.getMcpSettingsFilePath()
					const content = await fs.readFile(configPath, "utf-8")
					serverConfigData = JSON.parse(content)
				}
				if (serverConfigData) {
					alwaysAllowConfig = serverConfigData.mcpServers?.[serverName]?.alwaysAllow || []
					disabledToolsList = serverConfigData.mcpServers?.[serverName]?.disabledTools || []
				}
			} catch (error) {
				console.error(`Failed to read tool configuration for ${serverName}:`, error)
				// Continue with empty configs
			}

			// Validate and mark tools as always allowed and enabled for prompt based on settings
			const tools = (response?.tools || []).map((tool) => {
				// Validate tool name against MCP spec and log warnings if non-compliant
				validateMcpToolName(tool.name, serverName)

				return {
					...tool,
					alwaysAllow: alwaysAllowConfig.includes(tool.name),
					enabledForPrompt: !disabledToolsList.includes(tool.name),
				}
			})

			return tools
		} catch (error) {
			console.error(`Failed to fetch tools for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourcesList(serverName: string, source?: "global" | "project"): Promise<McpResource[]> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection || connection.type !== "connected") {
				return []
			}
			const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema)
			return response?.resources || []
		} catch (error) {
			// console.error(`Failed to fetch resources for ${serverName}:`, error)
			return []
		}
	}

	private async fetchResourceTemplatesList(
		serverName: string,
		source?: "global" | "project",
	): Promise<McpResourceTemplate[]> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection || connection.type !== "connected") {
				return []
			}
			const response = await connection.client.request(
				{ method: "resources/templates/list" },
				ListResourceTemplatesResultSchema,
			)
			return response?.resourceTemplates || []
		} catch (error) {
			// console.error(`Failed to fetch resource templates for ${serverName}:`, error)
			return []
		}
	}

	/**
	 * Fetch the list of prompts from an MCP server
	 * @param serverName The name of the server to fetch prompts from
	 * @param source Optional source to filter by (global or project)
	 * @returns Array of prompts offered by the server
	 */
	private async fetchPromptsList(serverName: string, source?: "global" | "project"): Promise<McpPrompt[]> {
		try {
			const connection = this.findConnection(serverName, source)
			if (!connection || connection.type !== "connected") {
				return []
			}
			const response = await connection.client.request({ method: "prompts/list" }, ListPromptsResultSchema)
			return (
				response?.prompts?.map((prompt) => ({
					name: prompt.name,
					description: prompt.description,
					arguments: prompt.arguments,
				})) || []
			)
		} catch (error) {
			// Server may not support prompts capability, which is fine
			return []
		}
	}

	async deleteConnection(name: string, source?: "global" | "project"): Promise<void> {
		// Clean up file watchers for this server
		this.removeFileWatchersForServer(name)

		// If source is provided, only delete connections from that source
		const connections = source
			? this.connections.filter((conn) => conn.server.name === name && conn.server.source === source)
			: this.connections.filter((conn) => conn.server.name === name)

		for (const connection of connections) {
			try {
				if (connection.type === "connected") {
					await connection.transport.close()
					await connection.client.close()
				}
			} catch (error) {
				console.error(`Failed to close transport for ${name}:`, error)
			}
		}

		// Remove the connections from the array
		this.connections = this.connections.filter((conn) => {
			if (conn.server.name !== name) return true
			if (source && conn.server.source !== source) return true
			return false
		})

		// Remove from sanitized name registry if no more connections with this name exist
		const remainingConnections = this.connections.filter((conn) => conn.server.name === name)
		if (remainingConnections.length === 0) {
			const sanitizedName = sanitizeMcpName(name)
			this.sanitizedNameRegistry.delete(sanitizedName)
		}
	}

	async updateServerConnections(
		newServers: Record<string, any>,
		source: "global" | "project" = "global",
		manageConnectingState: boolean = true,
	): Promise<void> {
		if (manageConnectingState) {
			this.isConnecting = true
		}
		this.removeAllFileWatchers()
		// Filter connections by source
		const currentConnections = this.connections.filter(
			(conn) => conn.server.source === source || (!conn.server.source && source === "global"),
		)
		const currentNames = new Set(currentConnections.map((conn) => conn.server.name))
		const newNames = new Set(Object.keys(newServers))

		// Delete removed servers
		for (const name of currentNames) {
			if (!newNames.has(name)) {
				await this.deleteConnection(name, source)
			}
		}

		// Update or add servers
		for (const [name, config] of Object.entries(newServers)) {
			// Only consider connections that match the current source
			const currentConnection = this.findConnection(name, source)

			// Validate and transform the config
			let validatedConfig: z.infer<typeof ServerConfigSchema>
			try {
				validatedConfig = this.validateServerConfig(config, name)
			} catch (error) {
				this.showErrorMessage(`Invalid configuration for MCP server "${name}"`, error)
				continue
			}

			if (!currentConnection) {
				// New server
				try {
					// Only setup file watcher for enabled servers
					if (!validatedConfig.disabled) {
						this.setupFileWatcher(name, validatedConfig, source)
					}
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to connect to new MCP server ${name}`, error)
				}
			} else if (!deepEqual(JSON.parse(currentConnection.server.config), config)) {
				// Existing server with changed config
				try {
					// Only setup file watcher for enabled servers
					if (!validatedConfig.disabled) {
						this.setupFileWatcher(name, validatedConfig, source)
					}
					await this.deleteConnection(name, source)
					await this.connectToServer(name, validatedConfig, source)
				} catch (error) {
					this.showErrorMessage(`Failed to reconnect MCP server ${name}`, error)
				}
			}
			// If server exists with same config, do nothing
		}
		await this.notifyWebviewOfServerChanges()
		if (manageConnectingState) {
			this.isConnecting = false
		}
	}

	private setupFileWatcher(
		name: string,
		config: z.infer<typeof ServerConfigSchema>,
		source: "global" | "project" = "global",
	) {
		// Initialize an empty array for this server if it doesn't exist
		if (!this.fileWatchers.has(name)) {
			this.fileWatchers.set(name, [])
		}

		const watchers = this.fileWatchers.get(name) || []

		// Only stdio type has args
		if (config.type === "stdio") {
			// Setup watchers for custom watchPaths if defined
			if (config.watchPaths && config.watchPaths.length > 0) {
				const watchPathsWatcher = chokidar.watch(config.watchPaths, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true,
				})

				watchPathsWatcher.on("change", async (changedPath) => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						console.error(`Failed to restart server ${name} after change in ${changedPath}:`, error)
					}
				})

				watchers.push(watchPathsWatcher)
			}

			// Also setup the fallback build/index.js watcher if applicable
			const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
			if (filePath) {
				// we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor
				const indexJsWatcher = chokidar.watch(filePath, {
					// persistent: true,
					// ignoreInitial: true,
					// awaitWriteFinish: true, // This helps with atomic writes
				})

				indexJsWatcher.on("change", async () => {
					try {
						// Pass the source from the config to restartConnection
						await this.restartConnection(name, source)
					} catch (error) {
						console.error(`Failed to restart server ${name} after change in ${filePath}:`, error)
					}
				})

				watchers.push(indexJsWatcher)
			}

			// Update the fileWatchers map with all watchers for this server
			if (watchers.length > 0) {
				this.fileWatchers.set(name, watchers)
			}
		}
	}

	private removeAllFileWatchers() {
		this.fileWatchers.forEach((watchers) => watchers.forEach((watcher) => watcher.close()))
		this.fileWatchers.clear()
	}

	private removeFileWatchersForServer(serverName: string) {
		const watchers = this.fileWatchers.get(serverName)
		if (watchers) {
			watchers.forEach((watcher) => watcher.close())
			this.fileWatchers.delete(serverName)
		}
	}

	async restartConnection(serverName: string, source?: "global" | "project"): Promise<void> {
		this.isConnecting = true

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			this.isConnecting = false
			return
		}

		// Get existing connection and update its status
		const connection = this.findConnection(serverName, source)
		const config = connection?.server.config
		if (config) {
			vscode.window.showInformationMessage(t("mcp:info.server_restarting", { serverName }))
			connection.server.status = "connecting"
			connection.server.error = ""
			await this.notifyWebviewOfServerChanges()
			await delay(500) // artificial delay to show user that server is restarting
			try {
				await this.deleteConnection(serverName, connection.server.source)
				// Parse the config to validate it
				const parsedConfig = JSON.parse(config)
				try {
					// Validate the config
					const validatedConfig = this.validateServerConfig(parsedConfig, serverName)

					// Try to connect again using validated config
					await this.connectToServer(serverName, validatedConfig, connection.server.source || "global")
					vscode.window.showInformationMessage(t("mcp:info.server_connected", { serverName }))
				} catch (validationError) {
					this.showErrorMessage(`Invalid configuration for MCP server "${serverName}"`, validationError)
				}
			} catch (error) {
				this.showErrorMessage(`Failed to restart ${serverName} MCP server connection`, error)
			}
		}

		await this.notifyWebviewOfServerChanges()
		this.isConnecting = false
	}

	public async refreshAllConnections(): Promise<void> {
		if (this.isConnecting) {
			return
		}

		// Check if MCP is globally enabled
		const mcpEnabled = await this.isMcpEnabled()
		if (!mcpEnabled) {
			// Clear all existing connections
			const existingConnections = [...this.connections]
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Still initialize servers to track them, but they won't connect
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await this.notifyWebviewOfServerChanges()
			return
		}

		this.isConnecting = true

		try {
			const globalPath = await this.getMcpSettingsFilePath()
			let globalServers: Record<string, any> = {}
			try {
				const globalContent = await fs.readFile(globalPath, "utf-8")
				const globalConfig = JSON.parse(globalContent)
				globalServers = globalConfig.mcpServers || {}
				const globalServerNames = Object.keys(globalServers)
			} catch (error) {
				console.log("Error reading global MCP config:", error)
			}

			const projectPath = await this.getProjectMcpPath()
			let projectServers: Record<string, any> = {}
			if (projectPath) {
				try {
					const projectContent = await fs.readFile(projectPath, "utf-8")
					const projectConfig = JSON.parse(projectContent)
					projectServers = projectConfig.mcpServers || {}
					const projectServerNames = Object.keys(projectServers)
				} catch (error) {
					console.log("Error reading project MCP config:", error)
				}
			}

			// Clear all existing connections first
			const existingConnections = [...this.connections]
			for (const conn of existingConnections) {
				await this.deleteConnection(conn.server.name, conn.server.source)
			}

			// Re-initialize all servers from scratch
			// This ensures proper initialization including fetching tools, resources, etc.
			await this.initializeMcpServers("global")
			await this.initializeMcpServers("project")

			await delay(100)

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage("Failed to refresh MCP servers", error)
		} finally {
			this.isConnecting = false
		}
	}

	private async notifyWebviewOfServerChanges(): Promise<void> {
		// Get global server order from settings file
		const settingsPath = await this.getMcpSettingsFilePath()
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const globalServerOrder = Object.keys(config.mcpServers || {})

		// Get project server order if available
		const projectMcpPath = await this.getProjectMcpPath()
		let projectServerOrder: string[] = []
		if (projectMcpPath) {
			try {
				const projectContent = await fs.readFile(projectMcpPath, "utf-8")
				const projectConfig = JSON.parse(projectContent)
				projectServerOrder = Object.keys(projectConfig.mcpServers || {})
			} catch (error) {
				// Silently continue with empty project server order
			}
		}

		// Sort connections: first project servers in their defined order, then global servers in their defined order
		// This ensures that when servers have the same name, project servers are prioritized
		const sortedConnections = [...this.connections].sort((a, b) => {
			const aIsGlobal = a.server.source === "global" || !a.server.source
			const bIsGlobal = b.server.source === "global" || !b.server.source

			// If both are global or both are project, sort by their respective order
			if (aIsGlobal && bIsGlobal) {
				const indexA = globalServerOrder.indexOf(a.server.name)
				const indexB = globalServerOrder.indexOf(b.server.name)
				return indexA - indexB
			} else if (!aIsGlobal && !bIsGlobal) {
				const indexA = projectServerOrder.indexOf(a.server.name)
				const indexB = projectServerOrder.indexOf(b.server.name)
				return indexA - indexB
			}

			// Project servers come before global servers (reversed from original)
			return aIsGlobal ? 1 : -1
		})

		// Send sorted servers to webview
		const targetProvider: ClineProvider | undefined = this.providerRef.deref()

		if (targetProvider) {
			const serversToSend = sortedConnections.map((connection) => connection.server)

			const message = {
				type: "mcpServers" as const,
				mcpServers: serversToSend,
			}

			try {
				await targetProvider.postMessageToWebview(message)
			} catch (error) {
				console.error("[McpHub] Error calling targetProvider.postMessageToWebview:", error)
			}
		} else {
			console.error(
				"[McpHub] No target provider available (neither from getInstance nor providerRef) - cannot send mcpServers message to webview",
			)
		}
	}

	public async toggleServerDisabled(
		serverName: string,
		disabled: boolean,
		source?: "global" | "project",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { disabled }, serverSource)

			// Update the connection object
			if (connection) {
				try {
					connection.server.disabled = disabled

					// If disabling a connected server, disconnect it
					if (disabled && connection.server.status === "connected") {
						// Clean up file watchers when disabling
						this.removeFileWatchersForServer(serverName)
						await this.deleteConnection(serverName, serverSource)
						// Re-add as a disabled connection
						// Re-read config from file to get updated disabled state
						const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
						await this.connectToServer(serverName, updatedConfig, serverSource)
					} else if (!disabled && connection.server.status === "disconnected") {
						// If enabling a disabled server, connect it
						// Re-read config from file to get updated disabled state
						const updatedConfig = await this.readServerConfigFromFile(serverName, serverSource)
						await this.deleteConnection(serverName, serverSource)
						// When re-enabling, file watchers will be set up in connectToServer
						await this.connectToServer(serverName, updatedConfig, serverSource)
					} else if (connection.server.status === "connected") {
						// Only refresh capabilities if connected
						connection.server.tools = await this.fetchToolsList(serverName, serverSource)
						connection.server.resources = await this.fetchResourcesList(serverName, serverSource)
						connection.server.resourceTemplates = await this.fetchResourceTemplatesList(
							serverName,
							serverSource,
						)
						connection.server.prompts = await this.fetchPromptsList(serverName, serverSource)
					}
				} catch (error) {
					console.error(`Failed to refresh capabilities for ${serverName}:`, error)
				}
			}

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} state`, error)
			throw error
		}
	}

	/**
	 * Helper method to read a server's configuration from the appropriate settings file
	 * @param serverName The name of the server to read
	 * @param source Whether to read from the global or project config
	 * @returns The validated server configuration
	 */
	private async readServerConfigFromFile(
		serverName: string,
		source: "global" | "project" = "global",
	): Promise<z.infer<typeof ServerConfigSchema>> {
		// Determine which config file to read
		let configPath: string
		if (source === "project") {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			configPath = await this.getMcpSettingsFilePath()
		}

		// Ensure the settings file exists and is accessible
		try {
			await fs.access(configPath)
		} catch (error) {
			console.error("Settings file not accessible:", error)
			throw new Error("Settings file not accessible")
		}

		// Read and parse the config file
		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content)

		// Validate the config structure
		if (!config || typeof config !== "object") {
			throw new Error("Invalid config structure")
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			throw new Error("No mcpServers section in config")
		}

		if (!config.mcpServers[serverName]) {
			throw new Error(`Server ${serverName} not found in config`)
		}

		// Validate and return the server config
		return this.validateServerConfig(config.mcpServers[serverName], serverName)
	}

	/**
	 * Helper method to update a server's configuration in the appropriate settings file
	 * @param serverName The name of the server to update
	 * @param configUpdate The configuration updates to apply
	 * @param source Whether to update the global or project config
	 */
	private async updateServerConfig(
		serverName: string,
		configUpdate: Record<string, any>,
		source: "global" | "project" = "global",
	): Promise<void> {
		// Determine which config file to update
		let configPath: string
		if (source === "project") {
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			configPath = await this.getMcpSettingsFilePath()
		}

		// Ensure the settings file exists and is accessible
		try {
			await fs.access(configPath)
		} catch (error) {
			console.error("Settings file not accessible:", error)
			throw new Error("Settings file not accessible")
		}

		// Read and parse the config file
		const content = await fs.readFile(configPath, "utf-8")
		const config = JSON.parse(content)

		// Validate the config structure
		if (!config || typeof config !== "object") {
			throw new Error("Invalid config structure")
		}

		if (!config.mcpServers || typeof config.mcpServers !== "object") {
			config.mcpServers = {}
		}

		if (!config.mcpServers[serverName]) {
			config.mcpServers[serverName] = {}
		}

		// Create a new server config object to ensure clean structure
		const serverConfig = {
			...config.mcpServers[serverName],
			...configUpdate,
		}

		// Ensure required fields exist
		if (!serverConfig.alwaysAllow) {
			serverConfig.alwaysAllow = []
		}

		config.mcpServers[serverName] = serverConfig

		// Write the entire config back
		const updatedConfig = {
			mcpServers: config.mcpServers,
		}

		// Set flag to prevent file watcher from triggering server restart
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
		}
		this.isProgrammaticUpdate = true
		try {
			await safeWriteJson(configPath, updatedConfig)
		} finally {
			// Reset flag after watcher debounce period (non-blocking)
			this.flagResetTimer = setTimeout(() => {
				this.isProgrammaticUpdate = false
				this.flagResetTimer = undefined
			}, 600)
		}
	}

	public async updateServerTimeout(
		serverName: string,
		timeout: number,
		source?: "global" | "project",
	): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			// Update the server config in the appropriate file
			await this.updateServerConfig(serverName, { timeout }, connection.server.source || "global")

			await this.notifyWebviewOfServerChanges()
		} catch (error) {
			this.showErrorMessage(`Failed to update server ${serverName} timeout settings`, error)
			throw error
		}
	}

	public async deleteServer(serverName: string, source?: "global" | "project"): Promise<void> {
		try {
			// Find the connection to determine if it's a global or project server
			const connection = this.findConnection(serverName, source)
			if (!connection) {
				throw new Error(`Server ${serverName}${source ? ` with source ${source}` : ""} not found`)
			}

			const serverSource = connection.server.source || "global"
			// Determine config file based on server source
			const isProjectServer = serverSource === "project"
			let configPath: string

			if (isProjectServer) {
				// Get project MCP config path
				const projectMcpPath = await this.getProjectMcpPath()
				if (!projectMcpPath) {
					throw new Error("Project MCP configuration file not found")
				}
				configPath = projectMcpPath
			} else {
				// Get global MCP settings path
				configPath = await this.getMcpSettingsFilePath()
			}

			// Ensure the settings file exists and is accessible
			try {
				await fs.access(configPath)
			} catch (error) {
				throw new Error("Settings file not accessible")
			}

			const content = await fs.readFile(configPath, "utf-8")
			const config = JSON.parse(content)

			// Validate the config structure
			if (!config || typeof config !== "object") {
				throw new Error("Invalid config structure")
			}

			if (!config.mcpServers || typeof config.mcpServers !== "object") {
				config.mcpServers = {}
			}

			// Remove the server from the settings
			if (config.mcpServers[serverName]) {
				delete config.mcpServers[serverName]

				// Write the entire config back
				const updatedConfig = {
					mcpServers: config.mcpServers,
				}

				await safeWriteJson(configPath, updatedConfig)

				// Update server connections with the correct source
				await this.updateServerConnections(config.mcpServers, serverSource)

				vscode.window.showInformationMessage(t("mcp:info.server_deleted", { serverName }))
			} else {
				vscode.window.showWarningMessage(t("mcp:info.server_not_found", { serverName }))
			}
		} catch (error) {
			this.showErrorMessage(`Failed to delete MCP server ${serverName}`, error)
			throw error
		}
	}

	async readResource(serverName: string, uri: string, source?: "global" | "project"): Promise<McpResourceResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		return await connection.client.request(
			{
				method: "resources/read",
				params: {
					uri,
				},
			},
			ReadResourceResultSchema,
		)
	}

	/**
	 * Get a specific prompt from an MCP server with optional arguments
	 * @param serverName The name of the server to get the prompt from
	 * @param promptName The name of the prompt to retrieve
	 * @param promptArguments Optional arguments to pass to the prompt
	 * @param source Optional source to filter by (global or project)
	 * @returns The prompt response containing messages
	 */
	async getPrompt(
		serverName: string,
		promptName: string,
		promptArguments?: Record<string, string>,
		source?: "global" | "project",
	): Promise<McpPromptResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		const response = await connection.client.request(
			{
				method: "prompts/get",
				params: {
					name: promptName,
					arguments: promptArguments,
				},
			},
			GetPromptResultSchema,
		)
		return {
			description: response.description,
			messages: response.messages.map((msg) => ({
				role: msg.role,
				content: msg.content as McpPromptResponse["messages"][0]["content"],
			})),
		}
	}

	/**
	 * Set the logging level for an MCP server
	 * This controls what level of log messages the server will send via notifications/message
	 * @param serverName The name of the server
	 * @param level The logging level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency"
	 * @param source Optional source to filter by (global or project)
	 */
	async setLoggingLevel(
		serverName: string,
		level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency",
		source?: "global" | "project",
	): Promise<void> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		// Per MCP spec, logging/setLevel sets the minimum level of logs the server should send
		await connection.client.request(
			{
				method: "logging/setLevel",
				params: {
					level,
				},
			},
			z.object({}), // Empty result schema - logging/setLevel returns empty object on success
		)
	}

	/**
	 * Request autocompletion suggestions for a prompt or resource template argument
	 * @param serverName The name of the server
	 * @param ref Reference to the prompt or resource template
	 * @param argument The argument being completed (name and current value)
	 * @param context Optional context with already-resolved argument values
	 * @param source Optional source to filter by (global or project)
	 * @returns Completion suggestions with values array, optional total count, and hasMore flag
	 */
	async complete(
		serverName: string,
		ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string },
		argument: { name: string; value: string },
		context?: { arguments?: Record<string, string> },
		source?: "global" | "project",
	): Promise<{ completion: { values: string[]; total?: number; hasMore?: boolean } }> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		const response = await connection.client.request(
			{
				method: "completion/complete",
				params: {
					ref,
					argument,
					...(context && { context }),
				},
			},
			CompleteResultSchema,
		)
		return {
			completion: {
				values: response.completion.values,
				total: response.completion.total,
				hasMore: response.completion.hasMore,
			},
		}
	}

	async callTool(
		serverName: string,
		toolName: string,
		toolArguments?: Record<string, unknown>,
		source?: "global" | "project",
	): Promise<McpToolCallResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(
				`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
			)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled and cannot be used`)
		}

		let timeout: number
		try {
			const parsedConfig = ServerConfigSchema.parse(JSON.parse(connection.server.config))
			timeout = (parsedConfig.timeout ?? 60) * 1000
		} catch (error) {
			console.error("Failed to parse server config for timeout:", error)
			// Default to 60 seconds if parsing fails
			timeout = 60 * 1000
		}

		// Cast to McpToolCallResponse - SDK schema is a superset with additional fields like resource_link
		return (await connection.client.request(
			{
				method: "tools/call",
				params: {
					name: toolName,
					arguments: toolArguments,
				},
			},
			CallToolResultSchema,
			{
				timeout,
			},
		)) as McpToolCallResponse
	}

	/**
	 * Helper method to update a specific tool list (alwaysAllow or disabledTools)
	 * in the appropriate settings file.
	 * @param serverName The name of the server to update
	 * @param source Whether to update the global or project config
	 * @param toolName The name of the tool to add or remove
	 * @param listName The name of the list to modify ("alwaysAllow" or "disabledTools")
	 * @param addTool Whether to add (true) or remove (false) the tool from the list
	 */
	private async updateServerToolList(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		listName: "alwaysAllow" | "disabledTools",
		addTool: boolean,
	): Promise<void> {
		// Find the connection with matching name and source
		const connection = this.findConnection(serverName, source)

		if (!connection) {
			throw new Error(`Server ${serverName} with source ${source} not found`)
		}

		// Determine the correct config path based on the source
		let configPath: string
		if (source === "project") {
			// Get project MCP config path
			const projectMcpPath = await this.getProjectMcpPath()
			if (!projectMcpPath) {
				throw new Error("Project MCP configuration file not found")
			}
			configPath = projectMcpPath
		} else {
			// Get global MCP settings path
			configPath = await this.getMcpSettingsFilePath()
		}

		// Normalize path for cross-platform compatibility
		// Use a consistent path format for both reading and writing
		const normalizedPath = process.platform === "win32" ? configPath.replace(/\\/g, "/") : configPath

		// Read the appropriate config file
		const content = await fs.readFile(normalizedPath, "utf-8")
		const config = JSON.parse(content)

		if (!config.mcpServers) {
			config.mcpServers = {}
		}

		if (!config.mcpServers[serverName]) {
			config.mcpServers[serverName] = {
				type: "stdio",
				command: "node",
				args: [], // Default to an empty array; can be set later if needed
			}
		}

		if (!config.mcpServers[serverName][listName]) {
			config.mcpServers[serverName][listName] = []
		}

		const targetList = config.mcpServers[serverName][listName]
		const toolIndex = targetList.indexOf(toolName)

		if (addTool && toolIndex === -1) {
			targetList.push(toolName)
		} else if (!addTool && toolIndex !== -1) {
			targetList.splice(toolIndex, 1)
		}

		// Set flag to prevent file watcher from triggering server restart
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
		}
		this.isProgrammaticUpdate = true
		try {
			await safeWriteJson(normalizedPath, config)
		} finally {
			// Reset flag after watcher debounce period (non-blocking)
			this.flagResetTimer = setTimeout(() => {
				this.isProgrammaticUpdate = false
				this.flagResetTimer = undefined
			}, 600)
		}

		if (connection) {
			connection.server.tools = await this.fetchToolsList(serverName, source)
			await this.notifyWebviewOfServerChanges()
		}
	}

	async toggleToolAlwaysAllow(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		shouldAllow: boolean,
	): Promise<void> {
		try {
			await this.updateServerToolList(serverName, source, toolName, "alwaysAllow", shouldAllow)
		} catch (error) {
			this.showErrorMessage(
				`Failed to toggle always allow for tool "${toolName}" on server "${serverName}" with source "${source}"`,
				error,
			)
			throw error
		}
	}

	async toggleToolEnabledForPrompt(
		serverName: string,
		source: "global" | "project",
		toolName: string,
		isEnabled: boolean,
	): Promise<void> {
		try {
			// When isEnabled is true, we want to remove the tool from the disabledTools list.
			// When isEnabled is false, we want to add the tool to the disabledTools list.
			const addToolToDisabledList = !isEnabled
			await this.updateServerToolList(serverName, source, toolName, "disabledTools", addToolToDisabledList)
		} catch (error) {
			this.showErrorMessage(`Failed to update settings for tool ${toolName}`, error)
			throw error // Re-throw to ensure the error is properly handled
		}
	}

	/**
	 * Handles enabling/disabling MCP globally
	 * @param enabled Whether MCP should be enabled or disabled
	 * @returns Promise<void>
	 */
	async handleMcpEnabledChange(enabled: boolean): Promise<void> {
		if (!enabled) {
			// If MCP is being disabled, disconnect all servers with error handling
			const existingConnections = [...this.connections]
			const disconnectionErrors: Array<{ serverName: string; error: string }> = []

			for (const conn of existingConnections) {
				try {
					await this.deleteConnection(conn.server.name, conn.server.source)
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error)
					disconnectionErrors.push({
						serverName: conn.server.name,
						error: errorMessage,
					})
					console.error(`Failed to disconnect MCP server ${conn.server.name}: ${errorMessage}`)
				}
			}

			// If there were errors, notify the user
			if (disconnectionErrors.length > 0) {
				const errorSummary = disconnectionErrors.map((e) => `${e.serverName}: ${e.error}`).join("\n")
				vscode.window.showWarningMessage(
					t("mcp:errors.disconnect_servers_partial", {
						count: disconnectionErrors.length,
						errors: errorSummary,
					}),
				)
			}

			// Re-initialize servers to track them in disconnected state
			try {
				await this.refreshAllConnections()
			} catch (error) {
				console.error(`Failed to refresh MCP connections after disabling: ${error}`)
				vscode.window.showErrorMessage(t("mcp:errors.refresh_after_disable"))
			}
		} else {
			// If MCP is being enabled, reconnect all servers
			try {
				await this.refreshAllConnections()
			} catch (error) {
				console.error(`Failed to refresh MCP connections after enabling: ${error}`)
				vscode.window.showErrorMessage(t("mcp:errors.refresh_after_enable"))
			}
		}
	}

	// ============================================================================
	// Progress Tracking (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Generate a unique progress token for tracking long-running operations.
	 * Call this before making a request that may report progress.
	 */
	generateProgressToken(
		serverName: string,
		callback?: (progress: number, total?: number, message?: string) => void,
	): string {
		const token = crypto.randomUUID()
		this.activeProgressTokens.set(token, {
			serverName,
			callback,
			lastProgress: 0,
		})
		return token
	}

	/**
	 * Clean up a progress token after the operation completes.
	 * Should be called when the request finishes (success or failure).
	 */
	clearProgressToken(token: string | number): void {
		this.activeProgressTokens.delete(token)
	}

	// ============================================================================
	// Request Cancellation (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Register a pending request for cancellation tracking.
	 * Returns an AbortController whose signal can be used by async operations.
	 */
	registerCancellableRequest(serverName: string, requestId: string | number): AbortController {
		const controller = new AbortController()
		this.pendingRequests.set(requestId, { serverName, controller })
		return controller
	}

	/**
	 * Unregister a request when it completes (success or failure).
	 * Important: Call this to prevent memory leaks.
	 */
	unregisterRequest(requestId: string | number): void {
		this.pendingRequests.delete(requestId)
	}

	/**
	 * Send a cancellation notification to a server.
	 * Per MCP spec, this is fire-and-forget (no response expected).
	 */
	async sendCancellation(
		serverName: string,
		requestId: string | number,
		reason?: string,
		source?: "global" | "project",
	): Promise<void> {
		const connection = this.findConnection(serverName, source)
		if (!connection?.client) {
			console.warn(`[McpHub] Cannot cancel request ${requestId}: server ${serverName} not connected`)
			return
		}

		try {
			// Send notifications/cancelled per MCP spec
			await connection.client.notification({
				method: "notifications/cancelled",
				params: {
					requestId,
					reason,
				},
			})
		} catch (error) {
			// Fire-and-forget per spec, but log for debugging
			console.debug(`[McpHub] Failed to send cancellation for ${requestId}:`, error)
		}
	}

	// ============================================================================
	// Ping (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Send a ping request to verify server connectivity.
	 * Per MCP spec, this is a simple health check that returns an empty object.
	 * @param serverName The name of the server to ping
	 * @param source Optional source to filter by (global or project)
	 * @throws Error if the server is not connected or doesn't respond
	 */
	async ping(serverName: string, source?: "global" | "project"): Promise<void> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}
		// Per MCP spec, ping returns an empty object
		await connection.client.request({ method: "ping" }, z.object({}))
	}

	// ============================================================================
	// URI Template Handling (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Check if a URI string is a template (contains template expressions like {foo}).
	 * @param uri The URI string to check
	 * @returns true if the URI contains template expressions
	 */
	isUriTemplate(uri: string): boolean {
		return UriTemplate.isTemplate(uri)
	}

	/**
	 * Get the variable names from a URI template.
	 * @param uriTemplate The URI template string
	 * @returns Array of variable names in the template
	 */
	getUriTemplateVariables(uriTemplate: string): string[] {
		const template = new UriTemplate(uriTemplate)
		return template.variableNames
	}

	/**
	 * Expand a URI template with the given variables.
	 * Per RFC 6570, this handles various expansion operators like {+path}, {?query}, etc.
	 * @param uriTemplate The URI template string
	 * @param variables The variables to expand the template with
	 * @returns The expanded URI string
	 */
	expandUriTemplate(uriTemplate: string, variables: Record<string, string | string[]>): string {
		const template = new UriTemplate(uriTemplate)
		return template.expand(variables)
	}

	/**
	 * Match a URI against a template and extract the variable values.
	 * @param uriTemplate The URI template string
	 * @param uri The URI to match against the template
	 * @returns The extracted variables, or null if the URI doesn't match the template
	 */
	matchUriTemplate(uriTemplate: string, uri: string): Record<string, string | string[]> | null {
		const template = new UriTemplate(uriTemplate)
		return template.match(uri)
	}

	/**
	 * Read a resource using a template and variables.
	 * This expands the template with the given variables and reads the resulting URI.
	 * @param serverName The name of the server
	 * @param uriTemplate The URI template string
	 * @param variables The variables to expand the template with
	 * @param source Optional source to filter by (global or project)
	 * @returns The resource response
	 */
	async readResourceFromTemplate(
		serverName: string,
		uriTemplate: string,
		variables: Record<string, string | string[]>,
		source?: "global" | "project",
	): Promise<McpResourceResponse> {
		const expandedUri = this.expandUriTemplate(uriTemplate, variables)
		return this.readResource(serverName, expandedUri, source)
	}

	// ============================================================================
	// Display Name Handling (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Get the display name for an MCP object (tool, resource, prompt, etc.).
	 * Per MCP spec, the precedence is:
	 * - For tools: title → annotations.title → name
	 * - For other objects: title → name
	 *
	 * @param metadata Object with name and optional title/annotations
	 * @returns The appropriate display name
	 */
	getDisplayName(metadata: { name: string; title?: string; annotations?: { title?: string } }): string {
		return sdkGetDisplayName(metadata as any)
	}

	/**
	 * Get display names for all tools from a server.
	 * @param serverName The name of the server
	 * @param source Optional source to filter by (global or project)
	 * @returns Map of tool name to display name
	 */
	getToolDisplayNames(serverName: string, source?: "global" | "project"): Map<string, string> {
		const connection = this.findConnection(serverName, source)
		const displayNames = new Map<string, string>()

		if (connection && connection.type === "connected" && connection.server.tools) {
			for (const tool of connection.server.tools) {
				displayNames.set(tool.name, this.getDisplayName(tool))
			}
		}

		return displayNames
	}

	/**
	 * Get display names for all resources from a server.
	 * @param serverName The name of the server
	 * @param source Optional source to filter by (global or project)
	 * @returns Map of resource URI to display name
	 */
	getResourceDisplayNames(serverName: string, source?: "global" | "project"): Map<string, string> {
		const connection = this.findConnection(serverName, source)
		const displayNames = new Map<string, string>()

		if (connection && connection.type === "connected" && connection.server.resources) {
			for (const resource of connection.server.resources) {
				displayNames.set(resource.uri, this.getDisplayName(resource))
			}
		}

		return displayNames
	}

	/**
	 * Get display names for all prompts from a server.
	 * @param serverName The name of the server
	 * @param source Optional source to filter by (global or project)
	 * @returns Map of prompt name to display name
	 */
	getPromptDisplayNames(serverName: string, source?: "global" | "project"): Map<string, string> {
		const connection = this.findConnection(serverName, source)
		const displayNames = new Map<string, string>()

		if (connection && connection.type === "connected" && connection.server.prompts) {
			for (const prompt of connection.server.prompts) {
				displayNames.set(prompt.name, this.getDisplayName(prompt))
			}
		}

		return displayNames
	}

	// ============================================================================
	// Resource Subscriptions (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Subscribe to updates for a specific resource.
	 * When the resource changes, the server will send notifications/resources/updated.
	 * @param serverName The name of the server
	 * @param uri The URI of the resource to subscribe to
	 * @param source Optional source to filter by (global or project)
	 */
	async subscribeToResource(serverName: string, uri: string, source?: "global" | "project"): Promise<void> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}

		// Check if server supports subscriptions
		const serverCapabilities = connection.client.getServerCapabilities()
		if (!serverCapabilities?.resources?.subscribe) {
			throw new Error(`Server "${serverName}" does not support resource subscriptions`)
		}

		// Send subscribe request
		await connection.client.request(
			{
				method: "resources/subscribe",
				params: { uri },
			},
			z.object({}), // Empty result on success
		)

		// Track the subscription locally
		const serverKey = `${serverName}:${source ?? "global"}`
		if (!this.resourceSubscriptions.has(serverKey)) {
			this.resourceSubscriptions.set(serverKey, new Set())
		}
		this.resourceSubscriptions.get(serverKey)!.add(uri)

		console.log(`[McpHub] Subscribed to resource ${uri} on server ${serverName}`)
	}

	/**
	 * Unsubscribe from updates for a specific resource.
	 * @param serverName The name of the server
	 * @param uri The URI of the resource to unsubscribe from
	 * @param source Optional source to filter by (global or project)
	 */
	async unsubscribeFromResource(serverName: string, uri: string, source?: "global" | "project"): Promise<void> {
		const connection = this.findConnection(serverName, source)
		if (!connection || connection.type !== "connected") {
			throw new Error(`No connection found for server: ${serverName}${source ? ` with source ${source}` : ""}`)
		}
		if (connection.server.disabled) {
			throw new Error(`Server "${serverName}" is disabled`)
		}

		// Send unsubscribe request
		await connection.client.request(
			{
				method: "resources/unsubscribe",
				params: { uri },
			},
			z.object({}), // Empty result on success
		)

		// Remove from local tracking
		const serverKey = `${serverName}:${source ?? "global"}`
		const subscriptions = this.resourceSubscriptions.get(serverKey)
		if (subscriptions) {
			subscriptions.delete(uri)
			if (subscriptions.size === 0) {
				this.resourceSubscriptions.delete(serverKey)
			}
		}

		console.log(`[McpHub] Unsubscribed from resource ${uri} on server ${serverName}`)
	}

	/**
	 * Get the list of currently subscribed resources for a server.
	 * @param serverName The name of the server
	 * @param source Optional source to filter by (global or project)
	 * @returns Array of subscribed resource URIs
	 */
	getSubscribedResources(serverName: string, source?: "global" | "project"): string[] {
		const serverKey = `${serverName}:${source ?? "global"}`
		const subscriptions = this.resourceSubscriptions.get(serverKey)
		return subscriptions ? Array.from(subscriptions) : []
	}

	// ============================================================================
	// Roots List Changed (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Notify all connected servers that the workspace roots have changed.
	 * Per MCP spec, clients SHOULD send this notification when the list of roots changes.
	 * This allows servers to refresh their view of available filesystem boundaries.
	 */
	async notifyRootsListChanged(): Promise<void> {
		const notificationPromises: Promise<void>[] = []

		for (const connection of this.connections) {
			if (connection.type === "connected" && !connection.server.disabled) {
				// Per MCP spec, roots/list_changed is broadcast to all connected servers.
				// Servers that need filesystem boundaries will call roots/list; others ignore this.
				// Note: roots is a CLIENT capability, not a server capability to filter on.
				notificationPromises.push(
					connection.client
						.notification({
							method: "notifications/roots/list_changed",
						})
						.catch((error) => {
							// Fire-and-forget per spec, but log for debugging
							console.debug(
								`[McpHub] Failed to send roots/list_changed to ${connection.server.name}:`,
								error,
							)
						}),
				)
			}
		}

		// Send all notifications in parallel
		await Promise.allSettled(notificationPromises)
	}

	// ============================================================================
	// Tasks (MCP 2025-11-25)
	// ============================================================================

	/**
	 * Call a tool with task augmentation for long-running operations.
	 * Returns a CreateTaskResult if the server supports tasks and returns one,
	 * otherwise returns the normal tool result.
	 */
	async callToolAsTask(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
		options?: {
			source?: "global" | "project"
			ttl?: number
			progressCallback?: (progress: number, total?: number, message?: string) => void
		},
	): Promise<
		{ type: "task"; taskId: string; pollInterval?: number } | { type: "result"; result: McpToolCallResponse }
	> {
		const connection = this.findConnection(serverName, options?.source)
		if (!connection?.client) {
			throw new McpError(ErrorCode.InternalError, `Server ${serverName} not connected`)
		}

		// Check if server supports tasks
		const serverCapabilities = connection.client.getServerCapabilities()
		if (!serverCapabilities?.tasks) {
			// Server doesn't support tasks, fall back to normal call
			const result = await connection.client.request(
				{ method: "tools/call", params: { name: toolName, arguments: args } },
				CallToolResultSchema,
			)
			// Cast to McpToolCallResponse - SDK schema is a superset with additional fields
			return { type: "result", result: result as McpToolCallResponse }
		}

		// Generate progress token for tracking
		const progressToken = options?.progressCallback
			? this.generateProgressToken(serverName, options.progressCallback)
			: undefined

		try {
			// Make task-augmented request
			const result = await connection.client.callTool({
				name: toolName,
				arguments: args,
				_meta: {
					...(progressToken && { progressToken }),
				},
				// Task augmentation params per MCP spec
				task: {
					ttl: options?.ttl,
				},
			} as any) // SDK types may not include task param yet

			// Check if result is a CreateTaskResult
			const createTaskResult = CreateTaskResultSchema.safeParse(result)
			if (createTaskResult.success && createTaskResult.data.task) {
				const task = createTaskResult.data.task
				// Track the task
				this.activeTasks.set(task.taskId, {
					serverName,
					source: options?.source,
					status: task.status,
					progressToken,
					pollInterval: task.pollInterval,
					message: task.statusMessage,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				})
				return {
					type: "task",
					taskId: task.taskId,
					pollInterval: task.pollInterval,
				}
			}

			// Normal result - cast to McpToolCallResponse for backward compatibility
			if (progressToken) {
				this.clearProgressToken(progressToken)
			}
			return { type: "result", result: result as McpToolCallResponse }
		} catch (error) {
			if (progressToken) {
				this.clearProgressToken(progressToken)
			}
			throw error
		}
	}

	/**
	 * Get the current status of a task.
	 * Returns the task object with current status.
	 */
	async getTask(
		serverName: string,
		taskId: string,
		source?: "global" | "project",
	): Promise<{
		task?: {
			taskId: string
			status: "working" | "input_required" | "completed" | "failed" | "cancelled"
			statusMessage?: string
			pollInterval?: number
		}
	}> {
		const connection = this.findConnection(serverName, source)
		if (!connection?.client) {
			throw new McpError(ErrorCode.InternalError, `Server ${serverName} not connected`)
		}

		const result = (await connection.client.request(
			{ method: "tasks/get", params: { taskId } },
			GetTaskResultSchema,
		)) as {
			task?: {
				taskId: string
				status: "working" | "input_required" | "completed" | "failed" | "cancelled"
				statusMessage?: string
				pollInterval?: number
			}
		}

		// Update local tracking
		const taskData = this.activeTasks.get(taskId)
		if (taskData && result.task) {
			taskData.status = result.task.status
			taskData.message = result.task.statusMessage
			taskData.pollInterval = result.task.pollInterval
			taskData.updatedAt = Date.now()
		}

		return result
	}

	/**
	 * Get the result of a completed task.
	 * Only valid for tasks in completed status.
	 */
	async getTaskResult(
		serverName: string,
		taskId: string,
		source?: "global" | "project",
	): Promise<McpToolCallResponse> {
		const connection = this.findConnection(serverName, source)
		if (!connection?.client) {
			throw new McpError(ErrorCode.InternalError, `Server ${serverName} not connected`)
		}

		// Use tasks/result to get the actual result
		const result = await connection.client.request(
			{ method: "tasks/result", params: { taskId } },
			CallToolResultSchema, // tasks/result returns the same format as tools/call
		)

		// Clean up task tracking after result retrieval
		const taskData = this.activeTasks.get(taskId)
		if (taskData?.progressToken) {
			this.clearProgressToken(taskData.progressToken)
		}
		this.activeTasks.delete(taskId)

		// Cast to McpToolCallResponse - SDK schema is a superset with additional fields
		return result as McpToolCallResponse
	}

	/**
	 * Cancel a running task.
	 * Only valid for tasks not in terminal state (completed/failed/cancelled).
	 */
	async cancelTask(
		serverName: string,
		taskId: string,
		source?: "global" | "project",
	): Promise<{
		task?: {
			taskId: string
			status: "working" | "input_required" | "completed" | "failed" | "cancelled"
			statusMessage?: string
			pollInterval?: number
		}
	}> {
		const connection = this.findConnection(serverName, source)
		if (!connection?.client) {
			throw new McpError(ErrorCode.InternalError, `Server ${serverName} not connected`)
		}

		const result = (await connection.client.request(
			{ method: "tasks/cancel", params: { taskId } },
			CancelTaskResultSchema,
		)) as {
			task?: {
				taskId: string
				status: "working" | "input_required" | "completed" | "failed" | "cancelled"
				statusMessage?: string
				pollInterval?: number
			}
		}

		// Update local tracking
		const taskData = this.activeTasks.get(taskId)
		if (taskData) {
			taskData.status = "cancelled"
			taskData.updatedAt = Date.now()
		}

		return result
	}

	/**
	 * List all tasks for a server with optional pagination.
	 */
	async listTasks(
		serverName: string,
		options?: {
			source?: "global" | "project"
			cursor?: string
		},
	): Promise<{
		tasks: Array<{
			taskId: string
			status: "working" | "input_required" | "completed" | "failed" | "cancelled"
			statusMessage?: string
			pollInterval?: number
		}>
		nextCursor?: string
	}> {
		const connection = this.findConnection(serverName, options?.source)
		if (!connection?.client) {
			throw new McpError(ErrorCode.InternalError, `Server ${serverName} not connected`)
		}

		return (await connection.client.request(
			{ method: "tasks/list", params: { cursor: options?.cursor } },
			ListTasksResultSchema,
		)) as {
			tasks: Array<{
				taskId: string
				status: "working" | "input_required" | "completed" | "failed" | "cancelled"
				statusMessage?: string
				pollInterval?: number
			}>
			nextCursor?: string
		}
	}

	/**
	 * Poll a task until it reaches a terminal state or timeout.
	 * Respects the server's pollInterval recommendation.
	 */
	async pollTaskUntilComplete(
		serverName: string,
		taskId: string,
		options?: {
			source?: "global" | "project"
			timeoutMs?: number
			onStatusChange?: (status: string, message?: string) => void
		},
	): Promise<McpToolCallResponse> {
		const startTime = Date.now()
		const timeoutMs = options?.timeoutMs ?? 300000 // Default 5 minute timeout

		while (true) {
			// Check timeout
			if (Date.now() - startTime > timeoutMs) {
				throw new McpError(ErrorCode.InternalError, `Task ${taskId} timed out after ${timeoutMs}ms`)
			}

			// Get current status
			const taskResult = await this.getTask(serverName, taskId, options?.source)
			const task = taskResult.task

			if (!task) {
				throw new McpError(ErrorCode.InternalError, `Task ${taskId} not found`)
			}

			// Notify status change
			if (options?.onStatusChange) {
				options.onStatusChange(task.status, task.statusMessage)
			}

			// Check for terminal states
			if (task.status === "completed") {
				return await this.getTaskResult(serverName, taskId, options?.source)
			}

			if (task.status === "failed") {
				throw new McpError(
					ErrorCode.InternalError,
					`Task ${taskId} failed: ${task.statusMessage ?? "unknown error"}`,
				)
			}

			if (task.status === "cancelled") {
				throw new McpError(ErrorCode.InternalError, `Task ${taskId} was cancelled`)
			}

			// TODO: Handle input_required state - would need UI integration

			// Wait before polling again (respect server's pollInterval)
			const pollInterval = task.pollInterval ?? 1000
			await delay(pollInterval)
		}
	}

	async dispose(): Promise<void> {
		// Prevent multiple disposals
		if (this.isDisposed) {
			return
		}

		this.isDisposed = true

		// Clear progress tokens, pending requests, tasks, and subscriptions
		this.activeProgressTokens.clear()
		this.pendingRequests.clear()
		this.activeTasks.clear()
		this.resourceSubscriptions.clear()

		// Clear all debounce timers
		for (const timer of this.configChangeDebounceTimers.values()) {
			clearTimeout(timer)
		}

		this.configChangeDebounceTimers.clear()

		// Clear flag reset timer and reset programmatic update flag
		if (this.flagResetTimer) {
			clearTimeout(this.flagResetTimer)
			this.flagResetTimer = undefined
		}

		this.isProgrammaticUpdate = false
		this.removeAllFileWatchers()

		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name, connection.server.source)
			} catch (error) {
				console.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}

		this.connections = []

		if (this.settingsWatcher) {
			this.settingsWatcher.dispose()
			this.settingsWatcher = undefined
		}

		if (this.projectMcpWatcher) {
			this.projectMcpWatcher.dispose()
			this.projectMcpWatcher = undefined
		}

		this.disposables.forEach((d) => d.dispose())
	}
}
