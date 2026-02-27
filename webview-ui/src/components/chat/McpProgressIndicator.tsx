import { useCallback, useState, memo } from "react"
import { useEvent } from "react-use"

import type { ExtensionMessage } from "@roo-code/types"

interface McpProgressIndicatorProps {
	serverName: string
	progressToken: string | number
	requestId?: string | number // Optional requestId for cancellation correlation
}

interface ProgressState {
	progress: number
	total?: number
	message?: string
}

function McpProgressIndicatorInner({ serverName, progressToken, requestId }: McpProgressIndicatorProps) {
	const [state, setState] = useState<ProgressState | null>(null)
	const [cancelled, setCancelled] = useState(false)

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "mcpProgress") {
				const payload = message.payload as {
					serverName: string
					progressToken: string | number
					progress: number
					total?: number
					message?: string
				}
				if (payload.serverName === serverName && payload.progressToken === progressToken) {
					setState({ progress: payload.progress, total: payload.total, message: payload.message })
				}
			}

			if (message.type === "mcpCancelled") {
				const payload = message.payload as {
					serverName: string
					requestId: string | number
				}
				// Only mark as cancelled if both serverName AND requestId match
				// This prevents cancelling unrelated progress indicators on the same server
				if (payload.serverName === serverName && requestId !== undefined && payload.requestId === requestId) {
					setCancelled(true)
				}
			}
		},
		[serverName, progressToken, requestId],
	)

	useEvent("message", onMessage)

	if (cancelled) {
		return <span className="text-xs text-vscode-descriptionForeground italic">Cancelled by server</span>
	}

	if (!state) {
		return null
	}

	const percentage = state.total ? Math.round((state.progress / state.total) * 100) : null

	return (
		<div className="flex items-center gap-2 text-xs text-vscode-descriptionForeground">
			{percentage !== null ? (
				<div className="flex items-center gap-1.5 min-w-0">
					<div className="h-1 w-16 rounded-full bg-vscode-input-background overflow-hidden">
						<div
							className="h-full rounded-full bg-vscode-button-background transition-all"
							style={{ width: `${Math.min(percentage, 100)}%` }}
						/>
					</div>
					<span>{percentage}%</span>
				</div>
			) : (
				<span>Progress: {state.progress}</span>
			)}
			{state.message && <span className="truncate">{state.message}</span>}
		</div>
	)
}

const McpProgressIndicator = memo(McpProgressIndicatorInner)
export default McpProgressIndicator
