# MCP Sampling & Elicitation Implementation Design

## Overview

This document describes how to implement full MCP `sampling/createMessage` and `elicitation/create` primitives by integrating with the existing webview infrastructure.

## Current Architecture

### Message Flow (Extension ↔ Webview)

```
Extension (Task.ts)
    │
    ├── task.ask(type, text, partial)
    │   Creates ClineMessage { type: "ask", ask: type, text: JSON.stringify(data) }
    │
    ├── provider.postStateToWebview()
    │   Sends { type: "state", state: { clineMessages: [...] } }
    │
    └── Waits for askResponse via pWaitFor()

Webview (ChatRow.tsx)
    │
    ├── Renders ask message based on message.ask type
    │   - "use_mcp_server" → McpExecution component
    │   - "followup" → FollowUpSuggest component
    │   - etc.
    │
    └── User interacts → vscode.postMessage({ type: "askResponse", ... })

Extension (webviewMessageHandler.ts)
    │
    └── task.handleWebviewAskResponse(askResponse, text, images)
        Sets askResponse, askResponseText, askResponseImages
        pWaitFor resolves, task.ask() returns result
```

### Existing MCP Ask Pattern

**Type Definition** (`packages/types/src/vscode-extension-host.ts`):

```typescript
interface ClineAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
	response?: string
}
```

**Usage** (`UseMcpToolTool.ts:60-68`):

```typescript
const completeMessage = JSON.stringify({
	type: "use_mcp_tool",
	serverName,
	toolName,
	arguments: params.arguments ? JSON.stringify(params.arguments) : undefined,
} satisfies ClineAskUseMcpServer)

const didApprove = await askApproval("use_mcp_server", completeMessage)
```

## Design: MCP Sampling

### What Sampling Does (MCP Spec)

Server sends `sampling/createMessage` request → Client must:

1. Show user what the server is requesting (messages, model preferences, etc.)
2. Get user approval (human-in-the-loop requirement)
3. Forward to LLM (or let user modify first)
4. Return LLM response to server

### Type Definitions

Add to `packages/types/src/vscode-extension-host.ts`:

```typescript
// Extends ClineAskUseMcpServer
interface ClineAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource" | "mcp_sampling" | "mcp_elicitation"
	// ... existing fields ...

	// New fields for sampling
	samplingRequest?: McpSamplingRequest
	samplingResponse?: McpSamplingResponse

	// New fields for elicitation
	elicitationRequest?: McpElicitationRequest
	elicitationResponse?: McpElicitationResponse
}

interface McpSamplingRequest {
	messages: Array<{
		role: "user" | "assistant"
		content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
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
}

interface McpSamplingResponse {
	role: "user" | "assistant"
	content: { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	model: string
	stopReason?: "endTurn" | "stopSequence" | "maxTokens"
}
```

### McpHub Handler Update

Update `src/services/mcp/McpHub.ts` - replace stub with real implementation:

```typescript
client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
	// 1. Get reference to current task/provider
	const provider = this.providerRef?.deref()
	if (!provider) {
		throw new McpError(ErrorCode.InternalError, "No active provider")
	}

	const task = provider.getCurrentTask()
	if (!task) {
		throw new McpError(ErrorCode.InternalError, "No active task")
	}

	// 2. Create ask message for webview
	const askData: ClineAskUseMcpServer = {
		type: "mcp_sampling",
		serverName: serverName,
		samplingRequest: {
			messages: request.params.messages,
			modelPreferences: request.params.modelPreferences,
			systemPrompt: request.params.systemPrompt,
			includeContext: request.params.includeContext,
			temperature: request.params.temperature,
			maxTokens: request.params.maxTokens,
			stopSequences: request.params.stopSequences,
			metadata: request.params.metadata,
		},
	}

	// 3. Ask for user approval via webview
	const { response, text } = await task.ask("use_mcp_server", JSON.stringify(askData))

	if (response === "noButtonClicked") {
		throw new McpError(ErrorCode.InvalidRequest, "User declined sampling request")
	}

	// 4. Parse user's decision/modifications
	const userResponse = text ? JSON.parse(text) : null

	// 5. If approved, forward to LLM
	const llmResponse = await this.forwardSamplingToLLM(request.params, userResponse)

	return llmResponse
})
```

### Webview Component: McpSamplingApproval

Create `webview-ui/src/components/chat/McpSamplingApproval.tsx`:

```typescript
interface McpSamplingApprovalProps {
  serverName: string
  request: McpSamplingRequest
  onApprove: (modifiedRequest?: McpSamplingRequest) => void
  onDeny: () => void
}

export const McpSamplingApproval = ({ serverName, request, onApprove, onDeny }: McpSamplingApprovalProps) => {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <div className="mcp-sampling-approval">
      <div className="header">
        <Server size={16} />
        <span className="font-bold">{serverName}</span>
        <span>requests LLM completion</span>
      </div>

      {/* Show summary of request */}
      <div className="request-summary">
        <div>Messages: {request.messages.length}</div>
        <div>Max tokens: {request.maxTokens}</div>
        {request.systemPrompt && <div>Has system prompt</div>}
      </div>

      {/* Expandable details */}
      <Button variant="ghost" onClick={() => setShowDetails(!showDetails)}>
        {showDetails ? "Hide" : "Show"} details
      </Button>

      {showDetails && (
        <div className="request-details">
          {/* Render messages */}
          {request.messages.map((msg, i) => (
            <div key={i} className={`message ${msg.role}`}>
              <strong>{msg.role}:</strong>
              <Markdown markdown={msg.content.type === "text" ? msg.content.text : "[image]"} />
            </div>
          ))}
        </div>
      )}

      {/* Approval buttons */}
      <div className="actions">
        <Button onClick={() => onApprove()}>Approve & Send to LLM</Button>
        <Button variant="secondary" onClick={onDeny}>Deny</Button>
      </div>
    </div>
  )
}
```

### Integration in ChatRow.tsx

Add case for `mcp_sampling` in the `use_mcp_server` handling:

```typescript
case "use_mcp_server":
  const useMcpServer: ClineAskUseMcpServer = parseJson(message.text)

  if (useMcpServer.type === "mcp_sampling") {
    return (
      <McpSamplingApproval
        serverName={useMcpServer.serverName}
        request={useMcpServer.samplingRequest!}
        onApprove={(modified) => {
          vscode.postMessage({
            type: "askResponse",
            askResponse: "yesButtonClicked",
            text: modified ? JSON.stringify(modified) : undefined
          })
        }}
        onDeny={() => {
          vscode.postMessage({
            type: "askResponse",
            askResponse: "noButtonClicked"
          })
        }}
      />
    )
  }
  // ... existing use_mcp_tool handling
```

---

## Design: MCP Elicitation

### What Elicitation Does (MCP Spec)

Server sends `elicitation/create` request → Client must:

1. Parse the JSON Schema form definition
2. Render a form UI for the user
3. Collect user input
4. Return structured response to server

### Type Definitions

Add to types:

```typescript
interface McpElicitationRequest {
	message: string // Prompt to display to user
	requestedSchema: {
		type: "object"
		properties: Record<
			string,
			{
				type: "string" | "number" | "boolean"
				title?: string
				description?: string
				enum?: string[]
				default?: unknown
			}
		>
		required?: string[]
	}
}

interface McpElicitationResponse {
	action: "accept" | "decline" | "cancel"
	content?: Record<string, unknown> // Form data if accepted
}
```

### McpHub Handler Update

```typescript
client.setRequestHandler(ElicitRequestSchema, async (request) => {
	const provider = this.providerRef?.deref()
	const task = provider?.getCurrentTask()

	if (!task) {
		return { action: "decline" as const }
	}

	// Create ask message
	const askData: ClineAskUseMcpServer = {
		type: "mcp_elicitation",
		serverName: serverName,
		elicitationRequest: {
			message: request.params.message,
			requestedSchema: request.params.requestedSchema,
		},
	}

	const { response, text } = await task.ask("use_mcp_server", JSON.stringify(askData))

	if (response === "noButtonClicked") {
		return { action: "decline" as const }
	}

	// Parse form data from response
	const formData = text ? JSON.parse(text) : {}

	return {
		action: "accept" as const,
		content: formData,
	}
})
```

### Webview Component: McpElicitationForm

Create `webview-ui/src/components/chat/McpElicitationForm.tsx`:

```typescript
interface McpElicitationFormProps {
  serverName: string
  request: McpElicitationRequest
  onSubmit: (data: Record<string, unknown>) => void
  onCancel: () => void
}

export const McpElicitationForm = ({ serverName, request, onSubmit, onCancel }: McpElicitationFormProps) => {
  const [formData, setFormData] = useState<Record<string, unknown>>({})

  // Initialize with defaults
  useEffect(() => {
    const defaults: Record<string, unknown> = {}
    for (const [key, schema] of Object.entries(request.requestedSchema.properties)) {
      if (schema.default !== undefined) {
        defaults[key] = schema.default
      }
    }
    setFormData(defaults)
  }, [request])

  const handleSubmit = () => {
    // Validate required fields
    const required = request.requestedSchema.required || []
    for (const field of required) {
      if (formData[field] === undefined || formData[field] === "") {
        // Show validation error
        return
      }
    }
    onSubmit(formData)
  }

  return (
    <div className="mcp-elicitation-form">
      <div className="header">
        <Server size={16} />
        <span className="font-bold">{serverName}</span>
        <span>requests information</span>
      </div>

      <div className="message">
        <Markdown markdown={request.message} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); handleSubmit() }}>
        {Object.entries(request.requestedSchema.properties).map(([key, schema]) => (
          <div key={key} className="field">
            <label>
              {schema.title || key}
              {request.requestedSchema.required?.includes(key) && <span className="required">*</span>}
            </label>

            {schema.description && (
              <p className="description">{schema.description}</p>
            )}

            {renderField(key, schema, formData, setFormData)}
          </div>
        ))}

        <div className="actions">
          <Button type="submit">Submit</Button>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </div>
  )
}

function renderField(
  key: string,
  schema: PropertySchema,
  formData: Record<string, unknown>,
  setFormData: (data: Record<string, unknown>) => void
) {
  if (schema.enum) {
    return (
      <select
        value={formData[key] as string || ""}
        onChange={(e) => setFormData({ ...formData, [key]: e.target.value })}
      >
        <option value="">Select...</option>
        {schema.enum.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    )
  }

  switch (schema.type) {
    case "boolean":
      return (
        <input
          type="checkbox"
          checked={!!formData[key]}
          onChange={(e) => setFormData({ ...formData, [key]: e.target.checked })}
        />
      )
    case "number":
      return (
        <input
          type="number"
          value={formData[key] as number || ""}
          onChange={(e) => setFormData({ ...formData, [key]: parseFloat(e.target.value) })}
        />
      )
    default:
      return (
        <input
          type="text"
          value={formData[key] as string || ""}
          onChange={(e) => setFormData({ ...formData, [key]: e.target.value })}
        />
      )
  }
}
```

---

## Integration Points

### 1. McpHub needs ClineProvider/Task reference

The handlers need access to the current task to call `task.ask()`. Options:

**Option A**: Pass provider reference to McpHub

```typescript
// In McpHub constructor or connection setup
this.providerRef = new WeakRef(provider)
```

**Option B**: Use event emitter pattern

```typescript
// McpHub emits event, ClineProvider handles it
this.emit("samplingRequest", { serverName, request, resolve, reject })
```

**Recommended**: Option A - simpler, direct access

### 2. Response Flow for Long-Running Sampling

For sampling requests that take time (LLM inference), we need streaming updates:

```typescript
// In McpHub, during LLM call
const stream = await this.api.createMessage(samplingParams)

// Send progress updates to webview
for await (const chunk of stream) {
	provider.postMessageToWebview({
		type: "mcpSamplingProgress",
		serverName,
		chunk: chunk.text,
	})
}
```

### 3. Future: Mermaid Animation During Sampling

For the visualization feature you mentioned, we can add:

```typescript
// In MermaidBlock.tsx
interface MermaidBlockProps {
  code: string
  highlightNodes?: string[]  // Node IDs to highlight
  animating?: boolean        // Pulse animation
}

// CSS for animation
.mermaid-node-highlighted {
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { stroke-width: 1px; }
  50% { stroke-width: 3px; stroke: var(--vscode-focusBorder); }
}
```

---

## Test Server Design

Create a test MCP server for exercising these flows:

### `test-elicitation-server.mjs`

```javascript
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const server = new Server({ name: "test-elicitation-server", version: "1.0.0" }, { capabilities: { tools: {} } })

// Tool that triggers elicitation
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "ask_user_preferences",
			description: "Ask user for their preferences via elicitation",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "request_llm_help",
			description: "Request LLM assistance via sampling",
			inputSchema: {
				type: "object",
				properties: {
					question: { type: "string", description: "Question to ask LLM" },
				},
				required: ["question"],
			},
		},
	],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	if (request.params.name === "ask_user_preferences") {
		// Request elicitation from client
		const response = await server.request(
			{
				method: "elicitation/create",
				params: {
					message: "Please configure your preferences for this operation:",
					requestedSchema: {
						type: "object",
						properties: {
							outputFormat: {
								type: "string",
								title: "Output Format",
								description: "How should results be formatted?",
								enum: ["json", "markdown", "plain"],
							},
							verbosity: {
								type: "string",
								title: "Verbosity Level",
								enum: ["minimal", "normal", "verbose"],
							},
							includeTimestamps: {
								type: "boolean",
								title: "Include Timestamps",
								default: true,
							},
						},
						required: ["outputFormat"],
					},
				},
			},
			ElicitResultSchema,
		)

		return {
			content: [
				{
					type: "text",
					text: `User preferences: ${JSON.stringify(response, null, 2)}`,
				},
			],
		}
	}

	if (request.params.name === "request_llm_help") {
		// Request sampling from client
		const response = await server.request(
			{
				method: "sampling/createMessage",
				params: {
					messages: [
						{
							role: "user",
							content: { type: "text", text: request.params.arguments.question },
						},
					],
					maxTokens: 500,
				},
			},
			CreateMessageResultSchema,
		)

		return {
			content: [
				{
					type: "text",
					text: `LLM Response: ${response.content.text}`,
				},
			],
		}
	}
})

const transport = new StdioServerTransport()
await server.connect(transport)
```

---

## Implementation Order

1. **Types** - Add `McpSamplingRequest`, `McpSamplingResponse`, `McpElicitationRequest`, `McpElicitationResponse` to types
2. **McpHub Provider Reference** - Add `providerRef` to McpHub, pass from ClineProvider
3. **McpElicitationForm Component** - Create webview component (simpler, good starting point)
4. **McpHub Elicitation Handler** - Replace stub with real implementation
5. **ChatRow Integration** - Add `mcp_elicitation` case
6. **Test Server** - Create test-elicitation-server.mjs
7. **Test End-to-End** - Run CLI with test server
8. **McpSamplingApproval Component** - Create webview component
9. **McpHub Sampling Handler** - Replace stub with real implementation
10. **LLM Forwarding Logic** - Implement `forwardSamplingToLLM` method

---

## Questions to Resolve

1. **Provider Reference**: How does McpHub get a reference to ClineProvider/Task?

    - Currently McpHub is instantiated by ClineProvider
    - Could pass `this` to McpHub constructor

2. **Multiple Tasks**: What if multiple tasks are active?

    - Sampling/elicitation should target the task that owns the MCP connection
    - May need to track which task initiated each server connection

3. **Auto-approval**: Should sampling/elicitation support auto-approval?

    - Probably not for sampling (security concern - LLM calls cost money)
    - Maybe for elicitation if user explicitly enables it

4. **Timeout**: What happens if user doesn't respond?
    - MCP has request timeout handling
    - Could show countdown in UI

---

## File Checklist

- [ ] `packages/types/src/vscode-extension-host.ts` - Add types
- [ ] `packages/types/src/mcp.ts` - Add MCP-specific types if needed
- [ ] `src/services/mcp/McpHub.ts` - Update handlers, add provider ref
- [ ] `src/core/webview/ClineProvider.ts` - Pass ref to McpHub
- [ ] `webview-ui/src/components/chat/McpElicitationForm.tsx` - New component
- [ ] `webview-ui/src/components/chat/McpSamplingApproval.tsx` - New component
- [ ] `webview-ui/src/components/chat/ChatRow.tsx` - Add cases
- [ ] `/tmp/claude/.../test-elicitation-server.mjs` - Test server
