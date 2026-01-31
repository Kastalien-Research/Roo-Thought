---
description: Implement full MCP 2025-11-25 spec into McpHub.ts using state machine protocol
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(cd:*), Bash(pnpm:*), Bash(npx:*), Bash(node:*)
---

# MCP Client Builder

Integrate the full MCP 2025-11-25 specification into McpHub.ts through checkpoint-based implementation.

This workflow IS the Ulysses State Machine protocol. Each section is a checkpoint. You cannot proceed to the next checkpoint until the current one is verified complete.

---

## Pre-flight: Resume Check

**⚠️ THIS IS YOUR FIRST ACTION. Do this before anything else.**

Check if `.claude/mcp-implementation-state.json` exists.

### If the file EXISTS:

1. Read it completely
2. Output the following status block:

```
RESUME CHECK

State file found: YES
Current checkpoint: [value from file]
Primitives marked complete: [count]
Primitives with "needs_ui_implementation" or similar status: [list them]
Primitives marked blocked: [list them]
```

3. Evaluate the state:

    **If `current_checkpoint` is "COMPLETE" BUT any primitive has:**

    - `status: "needs_ui_implementation"`
    - `status: "stub"`
    - `implementation` containing "Stub", "TODO", "not yet supported", "returns error", "returns decline"

    **Then the state file is LYING. These are BLOCKED, not complete.**

    Update the state file to mark these as `"status": "blocked"` and set `current_checkpoint` to the first blocked primitive's checkpoint.

    **If genuinely complete** (all primitives have real implementations, tests were run):

    - Report "Implementation genuinely complete" and STOP

    **If in progress:**

    - Resume from `current_checkpoint`
    - Skip to that checkpoint section below

### If the file does NOT exist:

Output:

```
RESUME CHECK

State file found: NO
Starting fresh from Checkpoint 0
```

Then proceed to Checkpoint 0.

---

## Checkpoint 0: Protocol Loaded

### ⛔ MANDATORY: Read Before Proceeding

You MUST read `.claude/commands/meta/ulysses-state-machine.md` NOW.

Do not skim. Do not guess. Do not proceed until you have read it.

### Verification Gate

After reading the protocol file, your **NEXT MESSAGE** must contain **ONLY** the following block, with blanks filled in. Do not include any other text, explanations, or tool calls in that message.

```
CHECKPOINT 0 VERIFICATION

1. The 6 steps of the core loop:
   Step 1: _______________
   Step 2: _______________
   Step 3: _______________
   Step 4: _______________
   Step 5: _______________
   Step 6: _______________

2. Rollback is triggered when: _______________

3. BLOCKED_PATHS contains: _______________

4. The three phases:
   Phase 1: _______________
   Phase 2: _______________
   Phase 3: _______________

CHECKPOINT 0 COMPLETE
```

### ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

### ⛔ DO NOT READ PAST THIS LINE UNTIL YOU HAVE SENT THAT MESSAGE ⛔

### ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

---

## Checkpoint 1: Source Files Loaded

**Current State:** Protocol understood, source files not yet examined.

**Action Required:** Read these files:

- `src/services/mcp/McpHub.ts` (full file)
- `packages/types/src/mcp.ts`

**Predicted Outcome:** You can describe:

- How McpHub manages connections (transport types, lifecycle)
- What capabilities the client currently declares
- Which request handlers exist

**Verification Gate — Output this block after reading:**

```
CHECKPOINT 1 VERIFICATION

1. Connection transports supported: _______________
2. Client capabilities declared in initialize: _______________
3. Existing request handlers (method names): _______________

CHECKPOINT 1 COMPLETE
```

---

## Checkpoint 2: Spec Audited

**Current State:** McpHub.ts understood. Spec not yet examined.

**Action Required:** Read `ai_docs/mcp-2025-11-25/` documentation.

**Predicted Outcome:** Complete enumeration of all MCP 2025-11-25 primitives.

**Document the spec in this format:**

### Client → Server Primitives

| Primitive | Request Type | Response Type | Required |
| --------- | ------------ | ------------- | -------- |
|           |              |               |          |

### Server → Client Primitives

| Primitive | Request Type | Response Type | Client Must Handle |
| --------- | ------------ | ------------- | ------------------ |
|           |              |               |                    |

### Notifications

| Notification | Direction | Payload |
| ------------ | --------- | ------- |
|              |           |         |

### Capabilities

| Capability | Who Declares | What It Enables |
| ---------- | ------------ | --------------- |
|            |              |                 |

**Checkpoint 2 Complete When:** All tables populated from spec (not from memory/guessing).

---

## Checkpoint 3: Delta Computed

**Current State:** Both implementation and spec documented.

**Action Required:** Compute the difference.

```
TODO_LIST = (Spec Primitives) - (Implemented Primitives)
```

**Document the delta:**

### Missing Primitives (TODO_LIST)

| Primitive | Category | Dependencies | Priority |
| --------- | -------- | ------------ | -------- |
|           |          |              |          |

### Dependency Graph

```
[Draw which primitives depend on others]
Example:
  roots/list (no deps)
  └── sampling/createMessage (may need roots context)
      └── elicitation/create (may need sampling context)
```

### Implementation Order

Based on dependencies, implement in this order:

1. ***
2. ***
3. ***
    ...

**Checkpoint 3 Complete When:**

- TODO_LIST has all missing primitives
- Dependencies identified
- Order determined

---

## Checkpoint 4+: Implement Each Primitive

For EACH primitive in the ordered TODO_LIST, execute the following sub-checkpoints.

**IMPORTANT:** Complete one primitive fully before starting the next.

### Checkpoint 4.N.0: Primitive Setup

**Primitive:** [Name]
**Dependencies:** [What must exist first]

**Current State:**

- Previous primitives: [list completed ones]
- This primitive: Not started

**Definition of Done (ALL must be true):**

- [ ] Types added to `packages/types/src/mcp.ts`
- [ ] Capability declared in client `initialize` (if applicable)
- [ ] Handler returns VALID RESPONSE (not error/rejection) for normal requests
- [ ] Error cases handled per spec (specific errors, not blanket rejection)
- [ ] `pnpm check-types` exits with code 0 (no errors, not even pre-existing)
- [ ] Headless test EXECUTED and output shown below

**⚠️ STUB IMPLEMENTATIONS ARE NOT COMPLETE:**

A primitive is NOT done if:

- Handler throws error for all requests
- Handler returns hardcoded rejection
- Handler has TODO/FIXME comments for core logic
- Handler requires "future UI work" to function

If you cannot fully implement a primitive, it stays IN_PROGRESS or moves to BLOCKED. Do NOT mark it complete.

### Checkpoint 4.N.1: Types

**Action:** Add types for this primitive to `packages/types/src/mcp.ts`

**ONE action only.** Do not bundle with other changes.

**Predicted Outcome:**

- New types exported
- `pnpm check-types` exits 0

**Execute, then verify:**

```
TYPES VERIFICATION

Command run: pnpm check-types
Exit code: ___
New errors introduced: YES / NO

If exit code ≠ 0, fix before proceeding.
```

### Checkpoint 4.N.2: Implementation

**Available Actions** (choose ONE):

1. [Approach A] - blocked: no
2. [Approach B] - blocked: no
3. [Approach C] - blocked: no

**Selected Action:** [Choose ONE. Not multiple. ONE.]

**Predicted Outcome:** [Specific expectation]

**Execute ONE change.**

**Actual Outcome:** [What happened]

**Match:** YES / NO

If NO and attempt < 2:

- Analysis: [Why it failed]
- Adjusted approach: [What to try differently]
- Return to execution

If NO and attempt >= 2:

- Add approach to BLOCKED_PATHS
- Return to Available Actions, excluding blocked
- Select different approach

If YES:

- Proceed to testing

### Checkpoint 4.N.3: Testing

**⚠️ YOU MUST ACTUALLY RUN THE TEST. Not describe it. RUN IT.**

**Test Server:** [Name or "need to create"]

**Test Configuration** (`.roo/mcp.json`):

```json
{
	"mcpServers": {
		"test-[primitive]": {
			"command": "___",
			"args": ["___"]
		}
	}
}
```

**Paste the EXACT command you ran:**

```bash
[paste actual command here]
```

**Paste the ACTUAL output (copy/paste, not paraphrase):**

```
[paste actual output here]
```

**If you cannot paste real output, the test was not run. Go run it.**

**Expected Output:** [What proves it works]

**Actual Output Matches Expected:** YES / NO

If NO: Return to Checkpoint 4.N.2 (implementation has a bug)

If YES: Proceed to completion.

### Checkpoint 4.N.4: Primitive Complete

**Primitive:** [Name] ✓
**Implementation approach:** [What worked]
**Blocked approaches:** [What didn't work and why]

**Final Verification:**

```
PRIMITIVE COMPLETE VERIFICATION

- Handler returns valid response: YES / NO
- pnpm check-types exit code: ___
- Test command that was run: ___
- Test passed: YES / NO

All YES and exit code 0? Primitive is complete.
Any NO or non-zero exit? Primitive is NOT complete. Go back.
```

Update persistence file and proceed to Checkpoint 4.(N+1).0

---

## State Persistence

After EACH checkpoint, update `.claude/mcp-implementation-state.json`:

```json
{
	"last_updated": "[timestamp]",
	"current_checkpoint": "4.2.1",
	"todo_list": ["primitive1", "primitive2", "..."],
	"completed": ["primitive0"],
	"in_progress": {
		"primitive": "primitive1",
		"sub_checkpoint": "4.1.2",
		"attempt": 1,
		"blocked_paths": ["approach that failed"]
	},
	"global_blocked_paths": {
		"primitive1": ["failed approach 1"],
		"primitive2": []
	}
}
```

**On session start:** Read this file. Resume from `current_checkpoint`.

**On checkpoint complete:** Update file before proceeding.

---

## Final Checkpoint: Validation

**Current State:** All primitives in TODO_LIST implemented.

**Action Required:** Full regression test.

1. Run all primitive tests in sequence
2. Run combined integration test (if available)
3. Verify `pnpm check-types` exits 0
4. Verify `pnpm lint` exits 0

**Paste actual commands and outputs:**

```bash
# Type check
pnpm check-types
# Exit code: ___

# Lint
pnpm lint
# Exit code: ___
```

**Final Verification:**

- [ ] All individual primitive tests pass (with output shown above)
- [ ] Type check exits 0
- [ ] Lint exits 0

**Final Checkpoint Complete When:** All boxes checked with real outputs shown.

---

## Reference: CLI Options

**Usage:**

```bash
roo [workspace] [options]
```

| Flag                        | Description          |
| --------------------------- | -------------------- |
| `-P, --prompt <prompt>`     | Task to execute      |
| `-y, --yes`                 | Auto-approve prompts |
| `--no-tui`                  | Plain text output    |
| `--ephemeral`               | No state persistence |
| `-d, --debug`               | Debug output         |
| `-p, --provider <provider>` | LLM provider         |
| `-k, --api-key <key>`       | API key              |

**Example:**

```bash
cd apps/cli && pnpm build
./dist/index.js . -P "use test-server to exercise sampling" --no-tui -y --ephemeral
```

---

## Reference: Expected Primitives

### Server → Client (Priority - likely missing)

- `sampling/createMessage` - Server requests LLM completion
- `elicitation/create` - Server requests user input
- `roots/list` - Server queries filesystem boundaries

### Client → Server (likely implemented)

- `tools/list`, `tools/call`
- `resources/list`, `resources/read`
- `resources/templates/list`
- `prompts/list`, `prompts/get`
- `completion/complete`

### Utilities

- `logging/setLevel` + `notifications/message`
- `ping`
- `cancellation`
- `progress`

---

## Anti-Patterns

**DO NOT:**

- Skip verification gates
- Proceed without outputting checkpoint verification blocks
- Implement multiple primitives at once
- Bundle multiple changes into one action ("they're interdependent" is not an excuse)
- Skip the prediction step
- Continue after 2 failures without rollback
- Retry a blocked path
- Guess at verification answers (read the files)
- Mark stubs as complete
- Claim "my changes are clean" when check-types fails (exit code must be 0)
- Describe tests without running them
- Paraphrase test output (copy/paste actual output)

**DO:**

- Output verification blocks as separate messages
- Make ONE atomic change per action
- State predictions before acting
- Update persistence file at each checkpoint
- Run tests and paste actual output
- Keep primitives IN_PROGRESS or BLOCKED if not fully working
