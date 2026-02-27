import { useCallback, useState, memo } from "react"
import { useEvent } from "react-use"
import { Loader2, CheckCircle2, XCircle, Ban, AlertTriangle } from "lucide-react"

import type { ExtensionMessage } from "@roo-code/types"

interface McpTaskStatusIndicatorProps {
	serverName: string
	taskId: string
}

type TaskStatus = "working" | "completed" | "failed" | "cancelled" | "input_required"

interface TaskState {
	status: TaskStatus
	statusMessage?: string
}

const TERMINAL_STATES: TaskStatus[] = ["completed", "failed", "cancelled"]

function McpTaskStatusIndicatorInner({ serverName, taskId }: McpTaskStatusIndicatorProps) {
	const [state, setState] = useState<TaskState | null>(null)

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "mcpTaskStatus") {
				const payload = message.payload as {
					serverName: string
					taskId: string
					status: TaskStatus
					statusMessage?: string
				}
				if (payload.serverName === serverName && payload.taskId === taskId) {
					setState((prev) => {
						if (prev && TERMINAL_STATES.includes(prev.status)) {
							return prev
						}
						return { status: payload.status, statusMessage: payload.statusMessage }
					})
				}
			}
		},
		[serverName, taskId],
	)

	useEvent("message", onMessage)

	if (!state) {
		return null
	}

	return (
		<div className="flex items-center gap-1.5 text-xs">
			{state.status === "working" && (
				<>
					<Loader2 className="h-3 w-3 animate-spin text-vscode-descriptionForeground" />
					<span className="text-vscode-descriptionForeground">{state.statusMessage ?? "Working..."}</span>
				</>
			)}
			{state.status === "completed" && (
				<>
					<CheckCircle2 className="h-3 w-3 text-vscode-charts-green" />
					<span className="text-vscode-charts-green">Completed</span>
				</>
			)}
			{state.status === "failed" && (
				<>
					<XCircle className="h-3 w-3 text-vscode-errorForeground" />
					<span className="text-vscode-errorForeground">{state.statusMessage ?? "Failed"}</span>
				</>
			)}
			{state.status === "cancelled" && (
				<>
					<Ban className="h-3 w-3 text-vscode-descriptionForeground" />
					<span className="text-vscode-descriptionForeground">Cancelled</span>
				</>
			)}
			{state.status === "input_required" && (
				<>
					<AlertTriangle className="h-3 w-3 text-vscode-editorWarning-foreground" />
					<span className="text-vscode-editorWarning-foreground">Server needs input — not yet supported</span>
				</>
			)}
		</div>
	)
}

const McpTaskStatusIndicator = memo(McpTaskStatusIndicatorInner)
export default McpTaskStatusIndicator
