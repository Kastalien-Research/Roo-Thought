# MCP Utilities Dependency Graph

## Visual Representation

```mermaid
graph TD
    subgraph Foundation["Foundation Layer (P0)"]
        PROG[01-progress<br/>Progress Tracking]
        CANCEL[02-cancellation<br/>Request Cancellation]
    end

    subgraph Tasks["Tasks Layer (P1-P2)"]
        TASK_CORE[03-tasks-core<br/>Client-Side Tasks]
        TASK_RECV[04-tasks-receiver<br/>Receiver-Side Tasks]
    end

    PROG --> TASK_CORE
    CANCEL --> TASK_CORE
    TASK_CORE --> TASK_RECV

    subgraph External["External Dependencies"]
        SDK["@modelcontextprotocol/sdk<br/>v1.25.2"]
        MCPHUB["McpHub.ts<br/>(existing)"]
        TASK_ASK["task.ask()<br/>(verify abort support)"]
    end

    SDK --> PROG
    SDK --> CANCEL
    SDK --> TASK_CORE
    SDK --> TASK_RECV
    MCPHUB --> PROG
    MCPHUB --> CANCEL
    TASK_ASK --> CANCEL
    TASK_ASK --> TASK_RECV

    classDef foundation fill:#4CAF50,color:white
    classDef tasks fill:#2196F3,color:white
    classDef external fill:#9E9E9E,color:white
    classDef blocker fill:#FF5722,color:white

    class PROG,CANCEL foundation
    class TASK_CORE,TASK_RECV tasks
    class SDK,MCPHUB external
    class TASK_ASK blocker
```

## Dependency Matrix

|                       | 01-progress | 02-cancellation | 03-tasks-core | 04-tasks-receiver |
| --------------------- | ----------- | --------------- | ------------- | ----------------- |
| **01-progress**       | -           | ❌              | ✅            | ✅                |
| **02-cancellation**   | ❌          | -               | ✅            | ✅                |
| **03-tasks-core**     | ❌          | ❌              | -             | ✅                |
| **04-tasks-receiver** | ❌          | ❌              | ❌            | -                 |

**Legend:** ✅ = depends on (row depends on column), ❌ = no dependency

## Implementation Phases

### Phase 1: Foundation (Parallel)

```
┌─────────────────────────────────────────────────────────────────┐
│                        Phase 1                                   │
│                                                                  │
│   ┌─────────────────┐        ┌─────────────────┐                │
│   │  01-progress    │        │ 02-cancellation │                │
│   │                 │   ||   │                 │                │
│   │ ProgressTracker │        │ RequestTracker  │                │
│   │ notifications/  │        │ notifications/  │                │
│   │   progress      │        │   cancelled     │                │
│   └─────────────────┘        └─────────────────┘                │
│                                                                  │
│   Estimated: 4-7 hours (parallel)                               │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 2: Tasks Core

```
┌─────────────────────────────────────────────────────────────────┐
│                        Phase 2                                   │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   03-tasks-core                          │   │
│   │                                                          │   │
│   │  • TaskPoller (client-side polling)                     │   │
│   │  • callToolAsTask, getTask, getTaskResult               │   │
│   │  • tasks/list, tasks/cancel                             │   │
│   │  • notifications/tasks/status handling                   │   │
│   │                                                          │   │
│   │  Depends on:                                             │   │
│   │    - Progress (progressToken throughout task)           │   │
│   │    - Cancellation (tasks/cancel uses different pattern) │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Estimated: 6-8 hours                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 3: Tasks Receiver

```
┌─────────────────────────────────────────────────────────────────┐
│                        Phase 3                                   │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                 04-tasks-receiver                        │   │
│   │                                                          │   │
│   │  • TaskManager (receiver-side state)                    │   │
│   │  • Modified sampling/elicitation handlers               │   │
│   │  • tasks/get, tasks/result, tasks/list, tasks/cancel    │   │
│   │  • notifications/tasks/status emission                   │   │
│   │                                                          │   │
│   │  Depends on:                                             │   │
│   │    - Tasks-Core (shared types, patterns)                │   │
│   │    - Cancellation (abort signal pattern)                │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Estimated: 6-8 hours                                          │
└─────────────────────────────────────────────────────────────────┘
```

## File Dependency Graph

```mermaid
graph LR
    subgraph Types["packages/types/"]
        MCP_TYPES["mcp.ts"]
        IPC_TYPES["vscode-extension-host.ts"]
    end

    subgraph Services["src/services/mcp/"]
        MCPHUB["McpHub.ts"]
        PROGRESS["ProgressTracker.ts"]
        REQUEST["RequestTracker.ts"]
        POLLER["TaskPoller.ts"]
        MANAGER["TaskManager.ts"]
    end

    subgraph UI["webview-ui/"]
        CHATROW["ChatRow.tsx"]
        PROG_IND["ProgressIndicator.tsx"]
        CANCEL_BTN["CancelButton.tsx"]
        TASK_IND["TaskStatusIndicator.tsx"]
    end

    MCP_TYPES --> PROGRESS
    MCP_TYPES --> REQUEST
    MCP_TYPES --> POLLER
    MCP_TYPES --> MANAGER
    MCP_TYPES --> PROG_IND
    MCP_TYPES --> TASK_IND

    PROGRESS --> MCPHUB
    REQUEST --> MCPHUB
    POLLER --> MCPHUB
    MANAGER --> MCPHUB

    IPC_TYPES --> CHATROW
    PROG_IND --> CHATROW
    CANCEL_BTN --> CHATROW
    TASK_IND --> CHATROW
```

## Critical Path

```
SDK Types ─► mcp.ts ─► ProgressTracker ─┐
                                        ├─► McpHub ─► TaskPoller ─► TaskManager
            mcp.ts ─► RequestTracker ───┘

Time estimate (sequential critical path): 16-23 hours
Time estimate (with parallelization):    12-16 hours
```

## Blockers and Dependencies

### External Blockers

| Blocker                | Impact       | Resolution                    |
| ---------------------- | ------------ | ----------------------------- |
| task.ask() AbortSignal | Specs 02, 04 | Check `src/core/task/Task.ts` |
| SDK 1.25.2 exports     | All specs    | Verify schema availability    |

### Internal Dependencies

| Dependency              | Provider          | Consumers         | Type     |
| ----------------------- | ----------------- | ----------------- | -------- |
| ProgressToken types     | 01-progress       | 03-tasks-core     | Type     |
| AbortController pattern | 02-cancellation   | 04-tasks-receiver | Pattern  |
| Task types              | 03-tasks-core     | 04-tasks-receiver | Type     |
| TaskManager             | 04-tasks-receiver | McpHub            | Instance |

---

_Generated by /spec-designer on 2026-01-17_
