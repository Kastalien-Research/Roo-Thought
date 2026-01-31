# MCP Utilities Spec Inventory

## Overview

This spec set covers the implementation of MCP 2025-11-25 utility features for Roo Code's MCP client (McpHub.ts).

| Metric                 | Value                                  |
| ---------------------- | -------------------------------------- |
| Total Specs            | 4                                      |
| Total Requirements     | 52                                     |
| Estimated Total Effort | 16-23 hours                            |
| Dependencies           | Progress → Tasks, Cancellation → Tasks |

## Spec Listing

| ID                                          | Title                             | Priority | Status | Effort |
| ------------------------------------------- | --------------------------------- | -------- | ------ | ------ |
| [01-progress](./01-progress.md)             | Progress Tracking                 | P0       | Draft  | 2-4h   |
| [02-cancellation](./02-cancellation.md)     | Request Cancellation              | P0       | Draft  | 2-3h   |
| [03-tasks-core](./03-tasks-core.md)         | Tasks Core (Client-Side)          | P1       | Draft  | 6-8h   |
| [04-tasks-receiver](./04-tasks-receiver.md) | Tasks Receiver (Server-to-Client) | P2       | Draft  | 6-8h   |

## Dependency Order

```
Parallel Foundation:
  01-progress ─────┐
                   ├──► 03-tasks-core ──► 04-tasks-receiver
  02-cancellation ─┘
```

**Implementation Order:**

1. `01-progress` and `02-cancellation` (can be parallel)
2. `03-tasks-core` (depends on both)
3. `04-tasks-receiver` (depends on 03)

## Requirements Summary

### By Spec

| Spec              | MUST | SHOULD | MAY |
| ----------------- | ---- | ------ | --- |
| 01-progress       | 6    | 3      | 0   |
| 02-cancellation   | 7    | 3      | 0   |
| 03-tasks-core     | 10   | 3      | 0   |
| 04-tasks-receiver | 12   | 3      | 0   |

### By Category

| Category               | Count |
| ---------------------- | ----- |
| Protocol Handlers      | 12    |
| State Management       | 8     |
| UI Components          | 5     |
| Type Definitions       | 4     |
| Testing                | 16    |
| Capability Declaration | 4     |

## Files to Create/Modify

### New Files

| File                                                     | Spec | Purpose                  |
| -------------------------------------------------------- | ---- | ------------------------ |
| `src/services/mcp/ProgressTracker.ts`                    | 01   | Progress token tracking  |
| `src/services/mcp/RequestTracker.ts`                     | 02   | Cancellation tracking    |
| `src/services/mcp/TaskPoller.ts`                         | 03   | Client-side task polling |
| `src/services/mcp/TaskManager.ts`                        | 04   | Receiver-side task state |
| `webview-ui/src/components/chat/ProgressIndicator.tsx`   | 01   | Progress bar UI          |
| `webview-ui/src/components/chat/CancelButton.tsx`        | 02   | Cancel button UI         |
| `webview-ui/src/components/chat/TaskStatusIndicator.tsx` | 03   | Task status UI           |

### Modified Files

| File                                          | Specs      | Changes                          |
| --------------------------------------------- | ---------- | -------------------------------- |
| `src/services/mcp/McpHub.ts`                  | All        | Add handlers, methods, instances |
| `packages/types/src/mcp.ts`                   | All        | Add type exports                 |
| `packages/types/src/vscode-extension-host.ts` | 01, 02, 03 | IPC message types                |
| `webview-ui/src/components/chat/ChatRow.tsx`  | 01, 02, 03 | Integrate new components         |
| `src/core/webview/ClineProvider.ts`           | 02, 03     | IPC handlers                     |

## Quality Metrics

### Confidence Scores (Target: 0.85)

| Spec              | Technical Design | Requirements | Test Coverage | Overall |
| ----------------- | ---------------- | ------------ | ------------- | ------- |
| 01-progress       | 0.90             | 0.85         | 0.80          | 0.85    |
| 02-cancellation   | 0.85             | 0.90         | 0.80          | 0.85    |
| 03-tasks-core     | 0.85             | 0.85         | 0.75          | 0.82    |
| 04-tasks-receiver | 0.80             | 0.85         | 0.75          | 0.80    |

### Risk Assessment

| Risk                           | Specs Affected | Likelihood | Mitigation               |
| ------------------------------ | -------------- | ---------- | ------------------------ |
| task.ask() lacks abort support | 02, 04         | High       | Verify/add support first |
| SDK schema mismatch            | All            | Low        | Use SDK types directly   |
| Polling performance            | 03             | Medium     | Respect pollInterval     |

## Implementation Readiness

### Blockers

1. **task.ask() AbortSignal Support**: Specs 02 and 04 assume `task.ask()` accepts an AbortSignal option. This needs verification before implementation.

### Pre-Implementation Verification

- [ ] Verify task.ask() supports AbortSignal
- [ ] Confirm SDK 1.25.2 schema exports
- [ ] Check ClineProvider IPC message handling pattern

## Next Steps

1. **Verify Blockers**: Check task.ask() signature in `src/core/task/Task.ts`
2. **Start Foundation**: Implement 01-progress and 02-cancellation in parallel
3. **Build Tasks**: Implement 03-tasks-core after foundation complete
4. **Complete Receiver**: Implement 04-tasks-receiver last

## Command to Start Implementation

```bash
/spec-orchestrator .specs/mcp-utilities/ --budget=100
```

---

_Generated by /spec-designer on 2026-01-17_
