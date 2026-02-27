import { useCallback, useState, useEffect, memo } from "react"
import { useEvent } from "react-use"

import type { ExtensionMessage } from "@roo-code/types"

interface McpResourceUpdatedBadgeProps {
	serverName: string
	uri: string
}

function McpResourceUpdatedBadgeInner({ serverName, uri }: McpResourceUpdatedBadgeProps) {
	const [showBadge, setShowBadge] = useState(false)

	const onMessage = useCallback(
		(event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "mcpResourceUpdated") {
				const payload = message.payload as {
					serverName: string
					uri: string
					timestamp: number
				}
				if (payload.serverName === serverName && payload.uri === uri) {
					setShowBadge(true)
				}
			}
		},
		[serverName, uri],
	)

	useEvent("message", onMessage)

	// Clear badge after 3 seconds
	useEffect(() => {
		if (!showBadge) return
		const timer = setTimeout(() => setShowBadge(false), 3000)
		return () => clearTimeout(timer)
	}, [showBadge])

	if (!showBadge) {
		return null
	}

	return (
		<span className="ml-1.5 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-vscode-badge-background text-vscode-badge-foreground">
			Updated
		</span>
	)
}

const McpResourceUpdatedBadge = memo(McpResourceUpdatedBadgeInner)
export default McpResourceUpdatedBadge
