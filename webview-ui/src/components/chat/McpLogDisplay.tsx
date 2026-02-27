import { useCallback, useState, memo } from "react"
import { useEvent } from "react-use"
import { ChevronDown } from "lucide-react"

import type { ExtensionMessage } from "@roo-code/types"

import { cn } from "@src/lib/utils"

interface McpLogDisplayProps {
	serverName: string
}

interface LogEntry {
	level: string
	logger?: string
	data: unknown
	timestamp: number
}

const MAX_LOG_ENTRIES = 100

const LEVEL_STYLES: Record<string, string> = {
	debug: "text-vscode-descriptionForeground",
	info: "text-vscode-foreground",
	notice: "text-vscode-foreground",
	warning: "text-vscode-editorWarning-foreground",
	error: "text-vscode-errorForeground",
	critical: "text-vscode-errorForeground font-semibold",
	alert: "text-vscode-errorForeground font-semibold",
	emergency: "text-vscode-errorForeground font-semibold",
}

function McpLogDisplayInner({ serverName }: McpLogDisplayProps) {
	const [entries, setEntries] = useState<LogEntry[]>([])
	const [expanded, setExpanded] = useState(false)

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "mcpLogMessage") {
				const payload = message.payload as {
					serverName: string
					level: string
					logger?: string
					data: unknown
					timestamp: number
				}
				if (payload.serverName === serverName) {
					setEntries((prev) => {
						const next = [
							...prev,
							{
								level: payload.level,
								logger: payload.logger,
								data: payload.data,
								timestamp: payload.timestamp,
							},
						]
						return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next
					})
				}
			}
		},
		[serverName],
	)

	useEvent("message", onMessage)

	if (entries.length === 0) {
		return null
	}

	return (
		<div className="mt-1 text-xs">
			<button
				className="flex items-center gap-1 text-vscode-descriptionForeground hover:text-vscode-foreground cursor-pointer"
				onClick={() => setExpanded(!expanded)}>
				<ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
				<span>Server logs ({entries.length})</span>
			</button>
			{expanded && (
				<div className="mt-1 max-h-32 overflow-y-auto rounded border border-vscode-panel-border bg-vscode-editor-background p-1.5 font-mono text-[11px] leading-relaxed">
					{entries.map((entry, i) => (
						<div key={i} className={cn("whitespace-pre-wrap break-all", LEVEL_STYLES[entry.level])}>
							<span className="opacity-60">[{entry.level.toUpperCase()}]</span>{" "}
							{entry.logger && <span className="opacity-60">{entry.logger}: </span>}
							{typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}

const McpLogDisplay = memo(McpLogDisplayInner)
export default McpLogDisplay
