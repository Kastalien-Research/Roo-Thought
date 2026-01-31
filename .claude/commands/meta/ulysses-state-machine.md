---
description: State-based implementation with checkpoints, predictions, and automatic rollback
argument-hint: <goal>
---

# Ulysses State Machine Protocol

State-based implementation workflow with checkpoints, prediction gates, and automatic rollback on repeated failures.

## Variables

GOAL: $ARGUMENTS
CHECKPOINT_STATE: 0
ATTEMPT_COUNT: 0
MAX_ATTEMPTS_BEFORE_ROLLBACK: 2
BLOCKED_PATHS: []

## Core Loop

```
WHILE goal not achieved:

  1. OBSERVE current state (checkpoint)
  2. ENUMERATE all possible next actions
  3. SELECT best action
  4. PREDICT expected outcome explicitly
  5. EXECUTE action
  6. EVALUATE actual outcome vs prediction

  IF outcome == expected:
    -> Current state becomes new CHECKPOINT
    -> ATTEMPT_COUNT = 0
    -> Continue to next iteration

  IF outcome != expected AND ATTEMPT_COUNT < 1:
    -> Analyze what went wrong
    -> ATTEMPT_COUNT += 1
    -> Try again with adjusted approach
    -> Return to step 5

  IF outcome != expected AND ATTEMPT_COUNT >= 1:
    -> ROLLBACK to last CHECKPOINT
    -> Add failed approach to BLOCKED_PATHS
    -> ATTEMPT_COUNT = 0
    -> Return to step 2 (enumerate NEW options, excluding blocked)
```

## State Documentation Format

Before each action, document:

```markdown
### State Checkpoint [N]

**Current State:**

- What exists now
- What works
- What doesn't

**Goal for Next State:**

- Specific, measurable target

**Available Actions:**

1. [Action A] - blocked: yes/no
2. [Action B] - blocked: yes/no
3. [Action C] - blocked: yes/no

**Selected Action:** [Action X]

**Predicted Outcome:**

- Specific expectation of what will happen
- How we will verify success

---

**Execution Log:**
[What was actually done]

**Actual Outcome:**

- What actually happened

**Match:** YES / NO

IF NO:

- **Analysis:** Why didn't it work?
- **Attempt:** [1 or 2]
- **Next:** Retry with adjustment / Rollback to checkpoint
```

## Rollback Protocol

When rolling back after two failures:

```markdown
### ROLLBACK TRIGGERED

**Failed Approach:** [Description]
**Failure 1:** [What happened]
**Failure 2:** [What happened]

**Root Cause Analysis:**

- Why this path doesn't work
- What we learned

**BLOCKED_PATHS updated:**

- [Previous blocked paths]
- [Newly blocked path] <-- added

**Returning to Checkpoint [N]**

**New Available Actions (excluding blocked):**

1. [Remaining options]
```

## Success Criteria

A checkpoint is established when:

- [ ] Action completed
- [ ] Outcome matched prediction
- [ ] State is stable and verifiable
- [ ] Can be returned to if needed

## Phase Structure

### Phase 1: Problem Space Exploration

- Map current system state
- Identify target end state
- Document all known constraints
- Establish Checkpoint 0

### Phase 2: Strategic Execution Loop

- Execute the core loop above
- Each successful state = new checkpoint
- Failed paths get blocked
- Continue until goal reached

### Phase 3: Validation

- Verify final state meets original goal
- Run all relevant tests
- Document the successful path taken

## Anti-Patterns

**DO NOT:**

- Skip the prediction step
- Continue after two failures without rollback
- Retry a blocked path
- Make multiple changes in one action
- Forget to document state

**DO:**

- Make atomic, reversible changes
- State predictions explicitly before acting
- Honor the rollback rule strictly
- Keep blocked paths list updated
- Checkpoint after every success

## Example Usage

```
/ulysses-state-machine "Add sampling capability to McpHub.ts"

Checkpoint 0: McpHub.ts exists with tools/resources support, no sampling

Available Actions:
1. Add sampling types to @roo-code/types
2. Create sampling handler in McpHub
3. Add capability declaration to client init

Selected: Action 1 (types first, foundation)

Predicted Outcome: New types file with SamplingRequest, SamplingResponse,
CreateMessageParams exported from @roo-code/types

[Execute]

Actual: Types created and exported successfully
Match: YES

-> Checkpoint 1 established
```

## Integration

This protocol can wrap any implementation task. Call it with a clear goal:

```bash
/ulysses-state-machine "Implement MCP 2025-11-25 elicitation capability"
/ulysses-state-machine "Fix connection retry logic in McpHub"
/ulysses-state-machine "Add streaming support to sampling handler"
```

The state machine ensures systematic progress with automatic course correction.
