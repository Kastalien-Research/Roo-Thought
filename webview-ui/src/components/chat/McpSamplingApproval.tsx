import { useState, memo } from "react"
import { Server, ChevronDown, ChevronUp, MessageSquare } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { McpSamplingRequest } from "@roo-code/types"

import { cn } from "@src/lib/utils"
import { Button } from "@src/components/ui"

import { Markdown } from "./Markdown"

interface McpSamplingApprovalProps {
	serverName: string
	request: McpSamplingRequest
	isExpanded?: boolean
}

/**
 * Component to display MCP sampling (LLM completion) requests for user approval.
 * Shows the server requesting the completion and the messages/parameters involved.
 */
export const McpSamplingApproval = memo(({ serverName, request, isExpanded = false }: McpSamplingApprovalProps) => {
	const { t } = useTranslation("mcp")
	const [showDetails, setShowDetails] = useState(isExpanded)

	// Count messages by role
	const userMessageCount = request.messages.filter((m) => m.role === "user").length
	const assistantMessageCount = request.messages.filter((m) => m.role === "assistant").length

	return (
		<div className="flex flex-col gap-2">
			{/* Header */}
			<div className="flex items-center gap-2 text-vscode-descriptionForeground">
				<Server size={16} className="shrink-0" />
				<span className="font-medium text-vscode-foreground">{serverName}</span>
				<span>{t("sampling.requestsCompletion", "requests LLM completion")}</span>
			</div>

			{/* Request Summary */}
			<div className="bg-vscode-editor-background border border-vscode-border rounded-xs p-3">
				<div className="flex flex-col gap-2 text-sm">
					<div className="flex items-center gap-2">
						<MessageSquare size={14} className="text-vscode-descriptionForeground" />
						<span>
							{t("sampling.messageCount", "{{count}} message(s)", { count: request.messages.length })}
							{userMessageCount > 0 && (
								<span className="text-vscode-descriptionForeground">
									{" "}
									({userMessageCount} user
									{assistantMessageCount > 0 && `, ${assistantMessageCount} assistant`})
								</span>
							)}
						</span>
					</div>

					<div className="text-vscode-descriptionForeground">
						{t("sampling.maxTokens", "Max tokens")}: {request.maxTokens}
					</div>

					{request.systemPrompt && (
						<div className="text-vscode-descriptionForeground">
							{t("sampling.hasSystemPrompt", "Has system prompt")}
						</div>
					)}

					{request.modelPreferences?.hints && request.modelPreferences.hints.length > 0 && (
						<div className="text-vscode-descriptionForeground">
							{t("sampling.modelHints", "Model hints")}:{" "}
							{request.modelPreferences.hints.map((h) => h.name).join(", ")}
						</div>
					)}
				</div>

				{/* Toggle details button */}
				<Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={() => setShowDetails(!showDetails)}>
					{showDetails ? (
						<>
							<ChevronUp size={14} className="mr-1" />
							{t("sampling.hideDetails", "Hide details")}
						</>
					) : (
						<>
							<ChevronDown size={14} className="mr-1" />
							{t("sampling.showDetails", "Show details")}
						</>
					)}
				</Button>

				{/* Expanded details */}
				{showDetails && (
					<div className="mt-3 pt-3 border-t border-vscode-border">
						{/* System prompt */}
						{request.systemPrompt && (
							<div className="mb-3">
								<div className="text-xs font-medium text-vscode-descriptionForeground mb-1">
									{t("sampling.systemPrompt", "System Prompt")}
								</div>
								<div className="bg-vscode-textBlockQuote-background p-2 rounded text-sm">
									<Markdown markdown={request.systemPrompt} />
								</div>
							</div>
						)}

						{/* Messages */}
						<div className="text-xs font-medium text-vscode-descriptionForeground mb-2">
							{t("sampling.messages", "Messages")}
						</div>
						<div className="flex flex-col gap-2">
							{request.messages.map((msg, idx) => (
								<div
									key={idx}
									className={cn(
										"p-2 rounded text-sm",
										msg.role === "user"
											? "bg-vscode-input-background border-l-2 border-vscode-focusBorder"
											: "bg-vscode-textBlockQuote-background border-l-2 border-vscode-descriptionForeground",
									)}>
									<div className="text-xs font-medium text-vscode-descriptionForeground mb-1">
										{msg.role === "user"
											? t("sampling.userRole", "User")
											: t("sampling.assistantRole", "Assistant")}
									</div>
									{Array.isArray(msg.content) ? (
										// Array of content blocks - render each
										msg.content.map((block, blockIdx) =>
											block.type === "text" ? (
												<Markdown key={blockIdx} markdown={block.text} />
											) : block.type === "image" ? (
												<div
													key={blockIdx}
													className="text-vscode-descriptionForeground italic">
													[{t("sampling.imageContent", "Image content")}]
												</div>
											) : (
												<div
													key={blockIdx}
													className="text-vscode-descriptionForeground italic">
													[{t("sampling.toolContent", "Tool content")}]
												</div>
											),
										)
									) : msg.content.type === "text" ? (
										<Markdown markdown={msg.content.text} />
									) : (
										<div className="text-vscode-descriptionForeground italic">
											[{t("sampling.imageContent", "Image content")}]
										</div>
									)}
								</div>
							))}
						</div>

						{/* Model preferences */}
						{request.modelPreferences && (
							<div className="mt-3">
								<div className="text-xs font-medium text-vscode-descriptionForeground mb-1">
									{t("sampling.preferences", "Model Preferences")}
								</div>
								<div className="text-sm text-vscode-descriptionForeground">
									{request.modelPreferences.costPriority !== undefined && (
										<div>
											{t("sampling.costPriority", "Cost priority")}:{" "}
											{request.modelPreferences.costPriority}
										</div>
									)}
									{request.modelPreferences.speedPriority !== undefined && (
										<div>
											{t("sampling.speedPriority", "Speed priority")}:{" "}
											{request.modelPreferences.speedPriority}
										</div>
									)}
									{request.modelPreferences.intelligencePriority !== undefined && (
										<div>
											{t("sampling.intelligencePriority", "Intelligence priority")}:{" "}
											{request.modelPreferences.intelligencePriority}
										</div>
									)}
								</div>
							</div>
						)}

						{/* Temperature and stop sequences */}
						{(request.temperature !== undefined || request.stopSequences?.length) && (
							<div className="mt-3 text-sm text-vscode-descriptionForeground">
								{request.temperature !== undefined && (
									<div>
										{t("sampling.temperature", "Temperature")}: {request.temperature}
									</div>
								)}
								{request.stopSequences && request.stopSequences.length > 0 && (
									<div>
										{t("sampling.stopSequences", "Stop sequences")}:{" "}
										{request.stopSequences.join(", ")}
									</div>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	)
})

McpSamplingApproval.displayName = "McpSamplingApproval"

export default McpSamplingApproval
