import { useState, useEffect, useCallback, memo } from "react"
import { Server, FormInput } from "lucide-react"
import { useTranslation } from "react-i18next"

import type { McpElicitationRequest } from "@roo-code/types"

import { cn } from "@src/lib/utils"
import { Button } from "@src/components/ui"

import { Markdown } from "./Markdown"

interface McpElicitationFormProps {
	serverName: string
	request: McpElicitationRequest
	onSubmit?: (data: Record<string, unknown>) => void
	onCancel?: () => void
	disabled?: boolean
}

/**
 * Component to display MCP elicitation (user input) requests as a form.
 * Renders form fields based on the JSON Schema provided by the MCP server.
 */
export const McpElicitationForm = memo(
	({ serverName, request, onSubmit, onCancel, disabled = false }: McpElicitationFormProps) => {
		const { t } = useTranslation("mcp")
		const [formData, setFormData] = useState<Record<string, unknown>>({})
		const [errors, setErrors] = useState<Record<string, string>>({})

		// Initialize form with default values
		useEffect(() => {
			const defaults: Record<string, unknown> = {}
			for (const [key, schema] of Object.entries(request.requestedSchema.properties)) {
				if (schema.default !== undefined) {
					defaults[key] = schema.default
				}
			}
			setFormData(defaults)
		}, [request])

		const handleFieldChange = useCallback((key: string, value: unknown) => {
			setFormData((prev) => ({ ...prev, [key]: value }))
			// Clear error when field is modified
			setErrors((prev) => {
				const newErrors = { ...prev }
				delete newErrors[key]
				return newErrors
			})
		}, [])

		const handleSubmit = useCallback(() => {
			// Validate required fields
			const required = request.requestedSchema.required || []
			const newErrors: Record<string, string> = {}

			for (const field of required) {
				const value = formData[field]
				if (value === undefined || value === "" || value === null) {
					newErrors[field] = t("elicitation.required", "This field is required")
				}
			}

			if (Object.keys(newErrors).length > 0) {
				setErrors(newErrors)
				return
			}

			onSubmit?.(formData)
		}, [formData, request.requestedSchema.required, onSubmit, t])

		const renderField = (key: string, schema: (typeof request.requestedSchema.properties)[string]) => {
			const isRequired = request.requestedSchema.required?.includes(key)
			const error = errors[key]
			const value = formData[key]

			const fieldId = `elicitation-${key}`
			const labelText = schema.title || key

			return (
				<div key={key} className="flex flex-col gap-1">
					<label htmlFor={fieldId} className="text-sm font-medium flex items-center gap-1">
						{labelText}
						{isRequired && <span className="text-vscode-errorForeground">*</span>}
					</label>

					{schema.description && (
						<p className="text-xs text-vscode-descriptionForeground mb-1">{schema.description}</p>
					)}

					{/* Render appropriate input based on type */}
					{schema.enum ? (
						<select
							id={fieldId}
							value={(value as string) || ""}
							onChange={(e) => handleFieldChange(key, e.target.value)}
							disabled={disabled}
							className={cn(
								"bg-vscode-input-background text-vscode-input-foreground",
								"border rounded px-2 py-1.5 text-sm",
								error
									? "border-vscode-errorForeground"
									: "border-vscode-input-border focus:border-vscode-focusBorder",
								"focus:outline-none",
							)}>
							<option value="">{t("elicitation.selectOption", "Select an option...")}</option>
							{schema.enum.map((opt) => (
								<option key={opt} value={opt}>
									{opt}
								</option>
							))}
						</select>
					) : schema.type === "boolean" ? (
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="checkbox"
								id={fieldId}
								checked={!!value}
								onChange={(e) => handleFieldChange(key, e.target.checked)}
								disabled={disabled}
								className="rounded border-vscode-input-border"
							/>
							<span className="text-sm">{t("elicitation.enabled", "Enabled")}</span>
						</label>
					) : schema.type === "number" ? (
						<input
							type="number"
							id={fieldId}
							value={(value as number) ?? ""}
							onChange={(e) =>
								handleFieldChange(key, e.target.value ? parseFloat(e.target.value) : undefined)
							}
							disabled={disabled}
							className={cn(
								"bg-vscode-input-background text-vscode-input-foreground",
								"border rounded px-2 py-1.5 text-sm",
								error
									? "border-vscode-errorForeground"
									: "border-vscode-input-border focus:border-vscode-focusBorder",
								"focus:outline-none",
							)}
						/>
					) : (
						<input
							type="text"
							id={fieldId}
							value={(value as string) || ""}
							onChange={(e) => handleFieldChange(key, e.target.value)}
							disabled={disabled}
							className={cn(
								"bg-vscode-input-background text-vscode-input-foreground",
								"border rounded px-2 py-1.5 text-sm",
								error
									? "border-vscode-errorForeground"
									: "border-vscode-input-border focus:border-vscode-focusBorder",
								"focus:outline-none",
							)}
						/>
					)}

					{error && <p className="text-xs text-vscode-errorForeground">{error}</p>}
				</div>
			)
		}

		return (
			<div className="flex flex-col gap-2">
				{/* Header */}
				<div className="flex items-center gap-2 text-vscode-descriptionForeground">
					<Server size={16} className="shrink-0" />
					<span className="font-medium text-vscode-foreground">{serverName}</span>
					<span>{t("elicitation.requestsInfo", "requests information")}</span>
				</div>

				{/* Form */}
				<div className="bg-vscode-editor-background border border-vscode-border rounded-xs p-3">
					{/* Message */}
					{request.message && (
						<div className="mb-4">
							<Markdown markdown={request.message} />
						</div>
					)}

					{/* Form fields */}
					<div className="flex flex-col gap-4">
						{Object.entries(request.requestedSchema.properties).map(([key, schema]) =>
							renderField(key, schema),
						)}
					</div>

					{/* Actions - only show if handlers are provided */}
					{(onSubmit || onCancel) && (
						<div className="flex gap-2 mt-4 pt-3 border-t border-vscode-border">
							{onSubmit && (
								<Button onClick={handleSubmit} disabled={disabled} size="sm">
									<FormInput size={14} className="mr-1" />
									{t("elicitation.submit", "Submit")}
								</Button>
							)}
							{onCancel && (
								<Button variant="secondary" onClick={onCancel} disabled={disabled} size="sm">
									{t("elicitation.cancel", "Cancel")}
								</Button>
							)}
						</div>
					)}
				</div>
			</div>
		)
	},
)

McpElicitationForm.displayName = "McpElicitationForm"

export default McpElicitationForm
