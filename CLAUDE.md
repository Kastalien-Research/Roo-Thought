# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Roo Code is an AI-powered VS Code extension that acts as an autonomous dev team assistant. It's a Turborepo monorepo with TypeScript throughout.

## Build & Development Commands

```bash
# Install dependencies (pnpm 10.8.1 required, Node 20.19.2)
pnpm install

# Development - opens VS Code extension host window
Press F5 in VS Code

# Build all packages
pnpm build

# Bundle extension (esbuild + webview)
pnpm bundle

# Create .vsix package
pnpm vsix

# Build and install directly to VS Code/Cursor
pnpm install:vsix

# Lint (ESLint, zero warnings allowed)
pnpm lint

# Type check
pnpm check-types

# Format (Prettier)
pnpm format
```

## Testing

Tests use Vitest. **Critical**: Tests must be run from inside the correct workspace, not from the project root.

```bash
# Run all tests via Turbo
pnpm test

# Run a single test file (backend)
cd src && npx vitest run path/to/test-file.test.ts

# Run a single test file (webview UI)
cd webview-ui && npx vitest run src/path/to/test-file.test.ts

# Run tests in watch mode
cd src && npx vitest path/to/test-file.test.ts
```

Note: `vi`, `describe`, `test`, `it`, etc. are globals configured in tsconfig.json and don't need to be imported.

## Architecture

### Monorepo Structure

```
src/                    # Main VS Code extension (Node.js)
webview-ui/             # React UI (Vite + Tailwind CSS v4)
packages/               # Shared libraries
  types/                # @roo-code/types - Shared TypeScript types
  core/                 # @roo-code/core - Platform-agnostic core
  cloud/                # @roo-code/cloud - Cloud service integration
  telemetry/            # @roo-code/telemetry - Analytics (PostHog)
  ipc/                  # @roo-code/ipc - Inter-process communication
apps/                   # Standalone applications
  cli/                  # Command-line interface
  vscode-e2e/           # E2E integration tests
```

### Extension Architecture (src/)

- **extension.ts**: Entry point, activates services and registers commands
- **core/**: Main functionality
    - `webview/ClineProvider.ts`: Webview communication hub
    - `tools/`: Agent tool implementations (ReadFileTool, WriteToFileTool, EditFileTool, ExecuteCommandTool, etc.)
    - `prompts/`: LLM instruction templates
    - `task/`: Task execution management
    - `config/`: Settings via VS Code API
- **services/**: Service layer
    - `mcp/`: MCP (Model Context Protocol) server management
    - `code-index/`: Codebase indexing with embeddings
    - `tree-sitter/`: AST parsing for code analysis
    - `ripgrep/`: Content search
- **api/providers/**: LLM provider implementations (Anthropic, OpenAI, Gemini, OpenRouter, Bedrock, Vertex, Ollama, LM Studio, Mistral, etc.)
- **integrations/**: VS Code integration points (editor, terminal, diagnostics)

### WebView UI (webview-ui/)

React 18 + Tailwind CSS v4 + Radix UI components. Communicates with extension via message passing.

## Code Style

- **Formatting**: Prettier with tabs, 120 width, no semicolons
- **Linting**: ESLint with max-warnings=0
- **Styling**: Tailwind CSS classes (not inline styles). VSCode CSS variables must be added to `webview-ui/src/index.css` before use in Tailwind classes
- **TypeScript**: Strict mode enabled

## Key Patterns

### Tool Implementation

Tools in `src/core/tools/` extend `BaseTool` and implement file operations, command execution, and AI interactions. Each tool has a specific responsibility.

### API Providers

Providers in `src/api/providers/` implement a common interface for different LLM backends. They handle streaming, tool use, and provider-specific quirks.

### MCP Integration

MCP servers are managed via `src/services/mcp/McpServerManager.ts`. Tools can invoke MCP resources via `UseMcpToolTool`.

## Custom Modes

The `.roo/` directory contains custom agent modes (code, debug, translate, issue-fixer, etc.) with specialized prompts and behaviors.
