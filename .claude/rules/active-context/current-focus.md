# Current Focus

> **Last Updated**: 2026-01-12
> **Status**: Active Development

## What We're Working On Now

### Primary Focus: MCP Client Expansion to 2025-11-25 Specification

**Goal**: Expand McpHub.ts to support the full MCP 2025-11-25 specification, exploring Effect-TS for implementation.

**Status**:

- [x] Analyzed current McpHub.ts implementation (~1967 lines)
- [x] Researched MCP 2025-11-25 specification capabilities
- [ ] Implement missing client capabilities (sampling, elicitation, roots)
- [ ] Implement missing server capability handlers (logging, completion)
- [ ] Explore Effect-TS integration for better error handling and composition

**Files Being Modified**:

- `src/services/mcp/McpHub.ts` - Main MCP client hub, currently supports tools, resources, resource templates
- `src/services/mcp/McpServerManager.ts` - Singleton manager for MCP instances
- `packages/types/` - Shared type definitions for MCP

### Current Implementation Status

**What McpHub.ts Already Supports** (via @modelcontextprotocol/sdk 1.12.0):

- ✅ Three transport types: stdio, SSE, streamable-http
- ✅ `tools/list` and `tools/call`
- ✅ `resources/list` and `resources/read`
- ✅ `resources/templates/list`
- ✅ Connection lifecycle management
- ✅ File watching for auto-restart
- ✅ Global and project-level server configs

**What's Missing for Full 2025-11-25 Spec**:

| Capability      | Direction     | Description                                                     | Priority |
| --------------- | ------------- | --------------------------------------------------------------- | -------- |
| **sampling**    | Server→Client | Server requests LLM completions via `sampling/createMessage`    | High     |
| **elicitation** | Server→Client | Server requests user input via `elicitation/create` (form mode) | High     |
| **roots**       | Server→Client | Server queries filesystem boundaries via `roots/list`           | Medium   |
| **logging**     | Server→Client | `logging/setLevel` + `notifications/message`                    | Medium   |
| **completion**  | Client→Server | Autocompletion for prompts/resources via `completion/complete`  | Low      |
| **prompts**     | Client→Server | `prompts/list` and `prompts/get`                                | Medium   |

### Related Work

- MCP TypeScript SDK: `@modelcontextprotocol/sdk` v1.12.0
- Spec URL: https://modelcontextprotocol.io/specification/2025-11-25

## Active Questions / Challenges

1. **Effect-TS Integration Strategy**

    - Current: McpHub uses Promise-based async/await with try/catch
    - Exploring: Effect-TS for better error handling, resource management, composability
    - Challenge: How to integrate Effect gradually without rewriting everything

2. **Capability Negotiation**

    - Current: Client declares minimal capabilities `{ capabilities: {} }`
    - Exploring: Proper capability declaration for sampling, elicitation, roots
    - Challenge: Client-side handlers need UI integration (VS Code webview)

3. **Bidirectional Communication**
    - Current: Client→Server flow only (call tools, read resources)
    - Exploring: Server→Client requests (sampling, elicitation)
    - Challenge: Need to register request handlers on the client

## Recent Decisions

### 2026-01-12: Use Effect-TS for New Code

**Decision**: Explore Effect-TS for new MCP capability implementations
**Rationale**:

- Better error handling with typed errors
- Built-in resource management (Scope, Effect.acquireRelease)
- Composable concurrent operations
- Cleaner retry and timeout logic

**Alternatives Considered**:

- Continue with Promise-based - simpler but error-prone
- Use fp-ts - less batteries-included than Effect

## What NOT to Focus On Right Now

- [ ] Refactoring existing McpHub.ts code - Focus on extending, not rewriting
- [ ] WebView UI changes - Backend first
- [ ] SSE/HTTP transport changes - Already working

## Next Steps

1. [ ] Create Effect-TS memory rules file with patterns
2. [ ] Create MCP memory rules file with spec details
3. [ ] Prototype sampling capability handler
4. [ ] Design elicitation UI flow for VS Code webview

## Success Criteria

We'll know this is working when:

- [ ] Server can request LLM completions via sampling/createMessage
- [ ] Server can request user input via elicitation/create
- [ ] Client properly declares capabilities during initialization
- [ ] Effect-TS patterns documented for future MCP work

## Notes for Future Agents

If you're reading this:

1. The MCP SDK already handles most protocol details - focus on capability handlers
2. `McpHub.ts` uses a discriminated union for connection states (connected/disconnected)
3. Server configs are validated with Zod schemas
4. File watchers auto-restart servers on config changes

---

**Created**: 2026-01-12
**Context**: Expanding Roo Code's MCP client to support full spec for richer server integrations
**See Also**:

- `.claude/rules/tools/mcp.md` - MCP patterns (to be created)
- `.claude/rules/tools/effect-ts.md` - Effect-TS patterns (to be created)
