---
name: trace-analysis
description: Provides context for analyzing LangSmith traces to debug model behavior, especially loop detection issues. Use when tasks mention "trace", "LangSmith", "loop debugging", "Gemini Flash loops", or analyzing model behavior patterns. Helps interpret trace hierarchies, identify parameter variations, and diagnose why less capable models get stuck.
---

# LangSmith Trace Analysis Skill

## When to Use This Skill

Use this skill when working with:

- LangSmith trace URLs or JSON exports
- Debugging why models (especially Gemini Flash) get stuck in loops
- Analyzing tool usage patterns across trace sessions
- Comparing model behavior (Claude vs Gemini vs others)
- Investigating repetitive file reading or tool execution
- Understanding context window management issues

## When NOT to Use This Skill

Do NOT use this skill when:

- Implementing new tracing code (use code/architect modes)
- Working on unrelated debugging (use debug mode)
- General code analysis without trace data
- Tasks don't involve observability or model behavior

## LangSmith Trace Hierarchy

### Trace Structure

```
📊 Trace Session (sessionId = taskId)
├─ 🔄 Turn/Iteration #1 (run_type: "chain")
│  ├─ 🤖 LLM Request (run_type: "llm")
│  │  ├─ inputs: { systemPrompt, messages, tools }
│  │  └─ outputs: { assistantMessage, toolCalls, stopReason, usage }
│  ├─ 🔧 Tool: read_file (run_type: "tool", parent: Turn 1)
│  │  ├─ inputs: { path: "src/api/index.ts" }
│  │  └─ outputs: { content: "...", success: true }
│  └─ 🔧 Tool: write_to_file (run_type: "tool")
│     ├─ inputs: { path, content }
│     └─ outputs: { success: true }
└─ 🔄 Turn/Iteration #2
   ├─ 🤖 LLM Request
   └─ ... (continues until task completes)
```

### Roo Code Specific Metadata

Every span in Roo Code traces includes:

**LLM Request Metadata:**

```json
{
	"taskId": "task-abc123",
	"mode": "code",
	"provider": "gemini",
	"modelId": "gemini-2.0-flash-exp",
	"retryAttempt": 0,
	"consecutiveMistakeCount": 0,
	"iterationNumber": 1
}
```

**Tool Execution Metadata:**

```json
{
	"taskId": "task-abc123",
	"repetitionDetected": false,
	"consecutiveMistakeCount": 0
}
```

## Loop Detection Patterns

### Pattern 1: Parameter Variation Bypass

**Symptom**: Same file read multiple times with slightly different parameters

**Example from trace:**

```
Turn 1: read_file({ path: "src/api/index.ts" })
Turn 2: read_file({ path: "src/api/index.ts", lineRanges: [] })
Turn 3: read_file({ path: "./src/api/index.ts" })
```

**Why it loops:**

- `ToolRepetitionDetector` uses exact JSON matching
- Each parameter variation is considered a different tool call
- Bypasses the 3-consecutive-identical-calls limit

**How to identify in traces:**

1. Filter spans by `run_type: "tool"` and `name: "read_file"`
2. Extract `inputs.path` from each
3. Normalize paths (remove `./`, resolve relative paths)
4. Count occurrences of normalized paths
5. If same normalized path appears >3 times with different raw parameters → Parameter Variation Bypass

### Pattern 2: Context Window Pressure Loop

**Symptom**: Loops start after context condensing or truncation

**Example from trace:**

```
Turn 5: LLM Request (inputTokens: 95000) → context at limit
Turn 6: Context condensed (messagesRemoved: 10)
Turn 7: LLM Request (inputTokens: 60000) → requests previously read file again
```

**Why it loops:**

- Context condensing removed file contents from history
- Model "forgets" it already read the file
- Requests file again, triggering loop

**How to identify in traces:**

1. Look for "Context Management" or "condensed" events in trace timeline
2. Check `inputTokens` progression across turns
3. Identify when tokens drop significantly (condensing occurred)
4. See if next LLM request re-reads files from condensed context
5. If loop starts immediately after condensing → Context Window Pressure Loop

### Pattern 3: Tool Result Processing Failure

**Symptom**: Tool executes successfully but model doesn't acknowledge the result

**Example from trace:**

```
Turn 1:
  LLM Request → output: toolCalls: [read_file("app.ts")]
  Tool: read_file → output: { content: "..." , success: true }

Turn 2:
  LLM Request → input includes tool result
              → output: toolCalls: [read_file("app.ts")] // SAME REQUEST!
```

**Why it loops:**

- Model receives tool result but doesn't process it
- Reasoning shows model acts as if it never got the file content
- Repeats the same request hoping for different result

**How to identify in traces:**

1. Find consecutive LLM requests
2. Check if Turn N's tool result is in Turn N+1's input messages
3. Verify if Turn N+1's tool calls duplicate Turn N's
4. If result IS in context but model re-requests → Tool Result Processing Failure

### Pattern 4: Mistake Counter Spiral

**Symptom**: Tool failures increment mistake counter, eventually hits limit

**Example from trace:**

```
Turn 1: write_to_file → error: "File restricted"
        consecutiveMistakeCount: 1
Turn 2: write_to_file (same file) → error: "File restricted"
        consecutiveMistakeCount: 2
...
Turn 5: consecutiveMistakeCount: 5 → Task aborted
```

**How to identify in traces:**

1. Track `metadata.consecutiveMistakeCount` across turns
2. Look for identical tool calls with errors
3. Check if model varies parameters hoping to succeed
4. If count increases linearly with no successful tools → Mistake Counter Spiral

## Comparative Analysis: Claude vs Gemini

### Claude Sonnet 4 (Rarely Loops)

**Behavioral Traits (observable in traces):**

- Uses tool results in next request's reasoning
- Acknowledges when file was already read
- Self-corrects parameter errors
- Varies approach when tool fails (tries different solution)

**Trace Signature:**

```
Turn 1: read_file("api.ts") → success
Turn 2: Reasoning mentions file contents, proceeds to write_to_file
Turn 3: Different file or different action
```

### Gemini Flash 2.0 (Frequently Loops)

**Behavioral Traits (observable in traces):**

- Often re-requests same file with parameter variations
- Doesn't acknowledge tool results in reasoning
- Repeats failed approaches
- May vary parameters randomly

**Trace Signature:**

```
Turn 1: read_file("api.ts") → success
Turn 2: read_file("api.ts", lineRanges: []) → success
Turn 3: read_file("./api.ts") → success (LOOP!)
```

## Trace Analysis Workflow

### Step 1: Load and Parse Trace Data

**If given a LangSmith URL:**

1. Extract trace ID from URL
2. Use LangSmith API or web interface to export JSON
3. Parse into structured data

**If given JSON export:**

1. Parse JSON file
2. Extract trace hierarchy
3. Build timeline of events

**If given task ID:**

1. Query LangSmith for traces matching taskId
2. Filter by date range if multiple sessions
3. Focus on most recent or user-specified session

### Step 2: Identify Loop Signature

**Questions to answer:**

1. How many LLM requests (turns) occurred?
2. At what turn did looping begin?
3. Which tools were called repeatedly?
4. What parameters varied between identical tool calls?
5. Did context condensing occur before the loop?
6. What was the final loop termination reason?

**Build a turn-by-turn summary:**

```
Turn 1: LLM → read_file(A) → Tool → success
Turn 2: LLM → read_file(B) → Tool → success
Turn 3: LLM → read_file(A, lineRanges=[]) → Tool → success ⚠️ Re-read A
Turn 4: LLM → read_file(A) → Tool → success ⚠️ Re-read A again
Turn 5: Aborted (consecutive no-tool-use limit)
```

### Step 3: Extract Evidence

**For each looping turn, document:**

- Input tokens (context size)
- Tool calls made (name + full parameters)
- Tool results returned (success/failure + content)
- Whether ToolRepetitionDetector should have triggered
- Metadata: `consecutiveMistakeCount`, `retryAttempt`, `repetitionDetected`

### Step 4: Form Hypothesis

**Common hypotheses:**

**H1: Parameter Variation Bypass**

- Evidence: Same file/action with different parameter formats
- Test: Normalize parameters - are they semantically identical?
- Fix: Enhance `ToolRepetitionDetector` to normalize parameters before comparison

**H2: Context Loss**

- Evidence: Loop starts after `inputTokens` drops significantly
- Test: Was file content in previous context? Is it gone after condensing?
- Fix: Improve context condensing to preserve critical file references

**H3: Model Incapability**

- Evidence: Tool results are in context, but model doesn't use them
- Test: Does reasoning mention file contents? Or act as if file was never read?
- Fix: Add prompt engineering to reinforce tool result usage, or restrict model usage

**H4: Tool Execution Failures**

- Evidence: Tools return errors, model retries with variations
- Test: Are errors legitimate (permissions, file not found) or false positives?
- Fix: Improve error messages, add retry limits per file

### Step 5: Recommend Fixes

**Based on hypothesis, suggest:**

**For Parameter Variation:**

```typescript
// In ToolRepetitionDetector.ts
private normalizeToolCall(block: ToolUse): string {
  const normalized = {
    name: block.name,
    path: this.normalizePath(block.params?.path),
    // Ignore lineRanges, metadata, etc.
  }
  return JSON.stringify(normalized)
}
```

**For Context Loss:**

```typescript
// In context-management/index.ts
// Preserve file context tracker data during condensing
// Mark "recently read files" for retention
```

**For Model Incapability:**

```
Add to system prompt:
"After using read_file tool, you MUST reference the file contents
in your next message. Do NOT request the same file again unless
the file has been modified since your last read."
```

## LangSmith Query Patterns

**Find all Gemini Flash loops:**

```
provider = "gemini"
AND model LIKE "gemini-%-flash%"
AND metadata.consecutiveNoToolUseCount > 2
```

**Compare Claude vs Gemini on same task:**

```
taskId = "task-abc123"
GROUP BY provider
```

**Find parameter variation patterns:**

```
SELECT tool_name, COUNT(DISTINCT inputs) as param_variations
FROM tool_spans
WHERE normalized_path = same
GROUP BY tool_name
HAVING param_variations > 1
```

## Common Pitfalls

**Pitfall 1: Confusing Session with Turn**

- **Session**: Entire task from start to finish
- **Turn**: One LLM request + tool executions + next request

**Pitfall 2: Assuming Trace Completeness**

- Aborted tasks have incomplete traces
- Some spans may fail to flush if task crashes
- Always check trace end status

**Pitfall 3: Ignoring Metadata**

- `repetitionDetected` shows if detector triggered
- `consecutiveMistakeCount` shows error accumulation
- `iterationNumber` shows loop depth

## Quick Reference: Trace Fields

### LLM Request Span

```json
{
  "name": "LLM Request",
  "run_type": "llm",
  "inputs": {
    "systemPrompt": "string",
    "messages": "MessageParam[]"
  },
  "outputs": {
    "assistantMessage": "string",
    "toolCalls": [{ "name": "tool_name", "input": {} }],
    "usage": { "inputTokens": 50000, "outputTokens": 1500 }
  },
  "metadata": {
    "taskId", "mode", "provider", "modelId",
    "retryAttempt", "consecutiveMistakeCount"
  }
}
```

### Tool Execution Span

```json
{
	"name": "Tool: read_file",
	"run_type": "tool",
	"inputs": { "path": "src/file.ts" },
	"outputs": { "content": "...", "success": true },
	"metadata": {
		"taskId": "...",
		"repetitionDetected": false
	}
}
```

## Trace Analysis Checklist

When analyzing a loop trace:

- [ ] Extract trace session ID / task ID
- [ ] Count total turns/iterations
- [ ] Identify first looping turn
- [ ] List all tool calls with parameters
- [ ] Normalize paths/parameters to find duplicates
- [ ] Check `repetitionDetected` metadata
- [ ] Review `inputTokens` progression
- [ ] Look for context condensing events
- [ ] Extract model reasoning between turns
- [ ] Compare tool inputs vs tool outputs
- [ ] Identify divergence from expected behavior
- [ ] Form hypothesis about loop cause
- [ ] Recommend specific code fix

## Integration with Roo Code

### Current Loop Detection (from codebase)

**`ToolRepetitionDetector`** ([`src/core/tools/ToolRepetitionDetector.ts`](../../src/core/tools/ToolRepetitionDetector.ts)):

- Serializes tool use blocks to JSON
- Compares consecutive calls for exact match
- Allows up to 3 identical calls before blocking
- **Limitation**: Doesn't normalize parameters

**`FileContextTracker`** ([`src/core/context-tracking/FileContextTracker.ts`](../../src/core/context-tracking/FileContextTracker.ts)):

- Tracks when files are read/edited
- NOT used for loop prevention (only staleness detection)

**`ReadFileTool`** ([`src/core/tools/ReadFileTool.ts`](../../src/core/tools/ReadFileTool.ts)):

- No deduplication logic
- Files can be read unlimited times

### How Traces Reveal Gaps

**What traces show vs what code does:**

| Trace Evidence                                                    | Code Behavior                         | Gap                        |
| ----------------------------------------------------------------- | ------------------------------------- | -------------------------- |
| `read_file("file.ts")` then `read_file("file.ts", lineRanges:[])` | Detector sees different JSON → allows | No parameter normalization |
| Context size drops 40% mid-task                                   | Context management condensed history  | File references lost       |
| Tool result in context, but model re-requests                     | Model doesn't use result              | No prompt reinforcement    |

## Example Analysis: Gemini Flash Loop

### Trace Data (Simplified)

```
Task: task-loop-example-1
Provider: gemini
Model: gemini-2.0-flash-exp

Turn 1 (iteration 1):
  LLM Request:
    inputs.messages.length: 5
    inputs.inputTokens: 12500
    outputs.toolCalls: [{ name: "read_file", input: { path: "src/api/index.ts" } }]

  Tool: read_file:
    inputs: { path: "src/api/index.ts" }
    outputs: { content: "<200 lines>", success: true }
    metadata.repetitionDetected: false

Turn 2 (iteration 2):
  LLM Request:
    inputs.messages.length: 7 (includes tool result from Turn 1)
    inputs.inputTokens: 15800
    outputs.toolCalls: [{ name: "read_file", input: { path: "src/api/index.ts", lineRanges: [] } }]

  Tool: read_file:
    inputs: { path: "src/api/index.ts", lineRanges: [] }
    outputs: { content: "<200 lines>", success: true }
    metadata.repetitionDetected: false // ❌ Should be true!

Turn 3 (iteration 3):
  LLM Request:
    inputs.messages.length: 9
    inputs.inputTokens: 19100
    outputs.toolCalls: [{ name: "read_file", input: { path: "./src/api/index.ts" } }]

  Tool: read_file:
    inputs: { path: "./src/api/index.ts" }
    outputs: { content: "<200 lines>", success: true }
    metadata.repetitionDetected: false // ❌ Should be true!

Turn 4: Aborted (consecutive mistake limit)
```

### Analysis

**Pattern**: Parameter Variation Bypass

**Evidence**:

1. Same file (`src/api/index.ts`) read 3 times
2. Parameters varied:
    - Turn 1: `{ path: "src/api/index.ts" }`
    - Turn 2: `{ path: "src/api/index.ts", lineRanges: [] }`
    - Turn 3: `{ path: "./src/api/index.ts" }`
3. All had `repetitionDetected: false` (detector didn't catch it)

**Root Cause**: `ToolRepetitionDetector` uses exact JSON matching:

```typescript
// Current implementation (simplified)
const serialized = JSON.stringify(toolBlock)
if (serialized === this.lastToolCall) {
	this.count++
} else {
	this.count = 0 // RESETS on any difference!
}
```

**Fix Recommendation**:

```typescript
// Normalize before comparison
const normalized = {
	name: toolBlock.name,
	path: normalizePath(toolBlock.params?.path), // Remove ./, ../, etc.
	// Ignore optional parameters like lineRanges for read_file
}
const serialized = JSON.stringify(normalized)
```

## Reporting Template

When completing a trace analysis, use this structure:

### Analysis Report: [Task ID or Trace ID]

**Trace Metadata:**

- Session ID: `...`
- Provider: `...`
- Model: `...`
- Total Turns: `N`
- Loop Detected: Yes/No
- Loop Start Turn: `N`

**Timeline:**

```
Turn 1: [summary]
Turn 2: [summary]
...
Turn N: [loop pattern identified]
```

**Pattern Classification:** [Parameter Variation | Context Loss | Tool Processing Failure | Mistake Spiral]

**Evidence:**

- [Specific data from trace showing the pattern]

**Root Cause Hypothesis:**

- [Why this happened based on code behavior]

**Recommended Fix:**

- [Specific code changes with file references]

**Confidence:** [Low/Medium/High]

**Additional Notes:**

- [Any context-specific observations]

---

## Related Files for Context

When analyzing traces, you may need to reference:

- [`ToolRepetitionDetector.ts`](../../src/core/tools/ToolRepetitionDetector.ts) - Current loop detection logic
- [`ReadFileTool.ts`](../../src/core/tools/ReadFileTool.ts) - File reading implementation
- [`FileContextTracker.ts`](../../src/core/context-tracking/FileContextTracker.ts) - File state tracking
- [`context-management/index.ts`](../../src/core/context-management/index.ts) - Context condensing logic
- [`Task.ts#attemptApiRequest`](../../src/core/task/Task.ts) - API request flow
- [`presentAssistantMessage.ts`](../../src/core/assistant-message/presentAssistantMessage.ts) - Tool execution flow

## Tips for Effective Analysis

1. **Start with the big picture** - How many turns? Where did it loop?
2. **Drill into specifics** - What exact parameters varied?
3. **Look for timestamps** - How long between turns? Any unusual delays?
4. **Check error patterns** - Are tools failing? What errors?
5. **Compare inputs vs outputs** - Is information getting lost?
6. **Visualize the flow** - Create text diagrams of the loop
7. **Be evidence-based** - Every hypothesis needs trace data to support it
8. **Think about code** - How would you fix this in ToolRepetitionDetector or elsewhere?

## Glossary

- **Span**: A single traced operation (LLM request, tool execution, etc.)
- **Run**: Synonym for span in LangSmith terminology
- **Session/Trace**: Collection of related spans (one per task)
- **Turn**: One complete LLM request → tool executions → next request cycle
- **Iteration**: Same as turn (used interchangeably in Roo Code)
- **Parent/Child Span**: Tool executions are children of their LLM request span
- **Run Tree**: Hierarchical structure of spans
- **Metadata**: Custom key-value pairs attached to spans
- **Input Tokens**: Tokens in the prompt sent to LLM
- **Output Tokens**: Tokens in the LLM's response

---

**Skill Version**: 1.0  
**Last Updated**: 2026-01-16  
**Maintained By**: Roo Code Team
