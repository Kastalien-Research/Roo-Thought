---
paths: [src/services/mcp/**, src/core/tools/*Mcp*.ts, packages/types/**/mcp*]
---

# MCP (Model Context Protocol) Memory

> **Purpose**: Patterns and learnings for MCP client implementation in Roo Code

## Recent Learnings (Most Recent First)

### 2026-01-12: MCP 2025-11-25 Specification Analysis 🔥

- **Issue**: Need to understand what capabilities are missing from current implementation
- **Solution**: Analyzed spec - identified sampling, elicitation, roots, logging, completion, prompts as missing
- **Files**: `src/services/mcp/McpHub.ts`
- **Pattern**: MCP capabilities are bidirectional - client→server AND server→client. Current impl only does client→server.
- **See Also**: https://modelcontextprotocol.io/specification/2025-11-25

### 2026-01-12: Current McpHub Architecture 🔥

- **Issue**: Understanding existing implementation before extending
- **Solution**: McpHub.ts is ~1967 lines, uses discriminated unions for connection states, Zod for config validation
- **Files**: `src/services/mcp/McpHub.ts:44-58` (connection types), `src/services/mcp/McpHub.ts:66-148` (config schemas)
- **Pattern**: Use discriminated unions (`type: "connected" | "disconnected"`) for state management - enables exhaustive type checking
- **See Also**: `.claude/rules/active-context/current-focus.md`

## Core Patterns

### Connection State Management

**When to use**: Managing MCP server connection lifecycle

**Implementation**:

```typescript
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

// Usage - exhaustive type checking
function handleConnection(conn: McpConnection) {
  if (conn.type === "connected") {
    // TypeScript knows client and transport are non-null here
    conn.client.request(...)
  } else {
    // conn.type === "disconnected"
    // client and transport are null
  }
}
```

**Why it works**: TypeScript can narrow types based on discriminant, prevents null pointer errors

### Server Config Validation with Zod

**When to use**: Validating MCP server configuration from JSON files

**Implementation**:

```typescript
const BaseConfigSchema = z.object({
  disabled: z.boolean().optional(),
  timeout: z.number().min(1).max(3600).optional().default(60),
  alwaysAllow: z.array(z.string()).default([]),
  watchPaths: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).default([]),
})

// Discriminated by transport type
const StdioConfigSchema = BaseConfigSchema.extend({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
})

const SSEConfigSchema = BaseConfigSchema.extend({
  type: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
})

export const ServerConfigSchema = z.union([StdioConfigSchema, SSEConfigSchema, ...])
```

**Why it works**: Zod transforms + refines in one pass, provides detailed error messages

### Capability Declaration Pattern

**When to use**: Initializing MCP client with proper capability negotiation

**Implementation**:

```typescript
// Current (minimal)
const client = new Client(
	{ name: "Roo Code", version: "1.0.0" },
	{ capabilities: {} }, // No capabilities declared
)

// Full 2025-11-25 spec
const client = new Client(
	{ name: "Roo Code", version: "1.0.0" },
	{
		capabilities: {
			sampling: {}, // Client can handle sampling/createMessage
			elicitation: { form: {} }, // Client can handle elicitation/create
			roots: { listChanged: true }, // Client exposes roots, will notify on changes
		},
	},
)

// Register handlers for server→client requests
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
	// Handle sampling request - call LLM and return result
	return { role: "assistant", content: { type: "text", text: "..." }, model: "..." }
})
```

**Why it works**: Capability negotiation ensures server knows what client supports

## MCP 2025-11-25 Specification Reference

### Capability Matrix

| Capability      | Direction | Client Declares             | Server Declares                           | Methods                                                   |
| --------------- | --------- | --------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| **tools**       | C→S       | -                           | `tools: {}`                               | `tools/list`, `tools/call`                                |
| **resources**   | C→S       | -                           | `resources: { subscribe?, listChanged? }` | `resources/list`, `resources/read`, `resources/subscribe` |
| **prompts**     | C→S       | -                           | `prompts: { listChanged? }`               | `prompts/list`, `prompts/get`                             |
| **sampling**    | S→C       | `sampling: {}`              | -                                         | `sampling/createMessage`                                  |
| **elicitation** | S→C       | `elicitation: { form: {} }` | -                                         | `elicitation/create`                                      |
| **roots**       | S→C       | `roots: { listChanged? }`   | -                                         | `roots/list`                                              |
| **logging**     | S→C       | -                           | `logging: {}`                             | `logging/setLevel`, `notifications/message`               |
| **completion**  | C→S       | -                           | `completions: {}`                         | `completion/complete`                                     |

### Protocol Flow

```
┌────────┐                           ┌────────┐
│ Client │                           │ Server │
└────┬───┘                           └───┬────┘
     │                                   │
     │ ──── initialize ────────────────> │  (declare capabilities)
     │ <─── initialize result ────────── │  (server capabilities)
     │                                   │
     │ ──── initialized ───────────────> │  (ready)
     │                                   │
     │ ──── tools/list ────────────────> │
     │ <─── tools result ───────────────│
     │                                   │
     │ ──── tools/call ────────────────> │
     │ <─── tool result ─────────────── │
     │                                   │
     │ <─── sampling/createMessage ──── │  (server→client!)
     │ ──── sampling result ──────────> │
     │                                   │
     │ <─── elicitation/create ──────── │  (server→client!)
     │ ──── elicitation result ───────> │
```

### Sampling Request/Response

```typescript
// Server sends to client
interface CreateMessageRequest {
	method: "sampling/createMessage"
	params: {
		messages: Array<{
			role: "user" | "assistant"
			content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
		}>
		modelPreferences?: {
			hints?: Array<{ name: string }>
			intelligencePriority?: number // 0-1
			speedPriority?: number // 0-1
		}
		systemPrompt?: string
		maxTokens?: number
		tools?: Array<{ name: string; description?: string; inputSchema?: object }>
		toolChoice?: { mode: "auto" | "none" | "required" }
	}
}

// Client responds
interface CreateMessageResult {
	role: "assistant"
	content: { type: "text"; text: string } | Array<{ type: "tool_use"; id: string; name: string; input: object }>
	model: string
	stopReason?: "endTurn" | "toolUse" | "maxTokens"
}
```

### Elicitation Request/Response

```typescript
// Server sends to client
interface ElicitationRequest {
  method: "elicitation/create"
  params: {
    mode?: "form"
    message: string  // Human-readable explanation
    requestedSchema?: {  // JSON Schema for structured input
      type: "object"
      properties: Record<string, { type: string, description?: string, ... }>
      required?: string[]
    }
  }
}

// Client responds
interface ElicitationResult {
  action: "accept" | "decline" | "cancel"
  content?: object  // Matches requestedSchema
}
```

## Common Pitfalls

1. **Not Handling Server→Client Requests**

    - ❌ Only implementing client→server calls
    - ✅ Register handlers with `client.setRequestHandler()` for sampling, elicitation
    - Why: MCP is bidirectional - servers can request actions from clients

2. **Forgetting Capability Declaration**

    - ❌ `{ capabilities: {} }` then wondering why sampling doesn't work
    - ✅ Declare all supported capabilities during initialization
    - Why: Server won't send requests for undeclared capabilities

3. **Missing Error History Truncation**

    - ❌ Storing unlimited error messages
    - ✅ Truncate to MAX_ERROR_LENGTH (1000) and keep last 100 errors
    - Why: Memory management - errors can be verbose
    - See: `McpHub.ts:887-912`

4. **Platform-Specific Command Handling**
    - ❌ Running commands directly on Windows
    - ✅ Wrap with `cmd.exe /c` for non-exe executables (npx.ps1, etc.)
    - Why: Node version managers use PowerShell scripts
    - See: `McpHub.ts:696-710`

## Quick Reference

### Key Files

- **McpHub.ts**: `src/services/mcp/McpHub.ts` - Main MCP client implementation
- **McpServerManager.ts**: `src/services/mcp/McpServerManager.ts` - Singleton manager
- **Types**: `packages/types/` - McpServer, McpTool, McpResource, etc.

### Config Locations

- **Global**: `~/.roo-code/settings/mcp_settings.json`
- **Project**: `.roo/mcp.json`

### Important Methods

| Method                    | Purpose                            | Line  |
| ------------------------- | ---------------------------------- | ----- |
| `connectToServer`         | Establish connection to MCP server | ~644  |
| `callTool`                | Execute tool on server             | ~1702 |
| `readResource`            | Read resource from server          | ~1683 |
| `fetchToolsList`          | Get available tools                | ~955  |
| `updateServerConnections` | Sync config changes                | ~1081 |

## Testing

### Test Location

- **Files**: `src/services/mcp/__tests__/McpHub.spec.ts`
- **Run Command**: `cd src && npx vitest run services/mcp/__tests__/McpHub.spec.ts`

### Key Test Scenarios

1. Connection lifecycle (connect, disconnect, reconnect)
2. Config validation edge cases
3. Tool call with timeout
4. Error handling and recovery

## Architecture Notes

### Why Singleton Manager?

`McpServerManager` ensures only one set of MCP connections per VS Code window:

- Multiple webviews share the same connections
- Prevents duplicate server processes
- Centralized lifecycle management

### Why Discriminated Unions?

Connection states use discriminated unions instead of nullable fields:

- TypeScript can narrow types exhaustively
- No accidental null access
- Clear semantic meaning

### Why Zod for Config?

- Validation + transformation in one pass
- Detailed error messages for users
- Type inference from schemas

## Future Considerations

- **Effect-TS Integration**: Consider for new capability implementations - better error handling
- **Streaming Support**: Sampling responses may need streaming for long generations
- **UI Integration**: Elicitation needs webview forms for structured input
- **Caching**: Resource caching for frequently accessed data

---

**Created**: 2026-01-12
**Last Updated**: 2026-01-12
**Freshness**: 🔥 HOT
