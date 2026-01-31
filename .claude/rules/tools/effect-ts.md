---
paths: [src/**/*effect*.ts, src/**/*Effect*.ts, packages/**/*effect*.ts]
---

# Effect-TS Memory

> **Purpose**: Patterns and learnings for using Effect-TS in this codebase

## Recent Learnings (Most Recent First)

### 2026-01-12: Effect-TS for MCP Client Expansion 🔥

- **Issue**: Current McpHub uses Promise-based async/await, error handling is verbose
- **Solution**: Exploring Effect-TS for new capability implementations (sampling, elicitation)
- **Files**: `src/services/mcp/McpHub.ts` (to be extended)
- **Pattern**: Use Effect for new modules, bridge to Promise at boundaries with `Effect.runPromise`
- **See Also**: `.claude/rules/tools/mcp.md`, `.claude/rules/active-context/current-focus.md`

## Core Patterns

### Creating Effects

**When to use**: Wrapping synchronous and asynchronous operations

```typescript
import { Effect } from "effect"

// Synchronous value
const succeed = Effect.succeed(42)

// Synchronous failure
const fail = Effect.fail(new Error("Something went wrong"))

// Synchronous computation (may throw)
const sync = Effect.sync(() => {
	const result = someComputation()
	return result
})

// Wrap a Promise
const fromPromise = Effect.promise(() => fetch("https://api.example.com"))

// Wrap a Promise that might reject
const tryPromise = Effect.tryPromise({
	try: () => fetch("https://api.example.com"),
	catch: (error) => new FetchError({ cause: error }),
})
```

**Why it works**: Effects are lazy and composable - no execution until run

### Chaining with pipe and flatMap

**When to use**: Sequencing operations that depend on previous results

```typescript
import { Effect, pipe } from "effect"

const program = pipe(
	Effect.succeed(10),
	Effect.map((n) => n * 2), // Transform success value
	Effect.flatMap((n) => divide(100, n)), // Chain to another Effect
	Effect.mapError((e) => new AppError(e)), // Transform error
)

// Or with Effect.gen (generator syntax)
const program = Effect.gen(function* () {
	const a = yield* Effect.succeed(10)
	const b = yield* divide(100, a)
	return b * 2
})
```

**Why it works**: pipe reads left-to-right, Effect.gen reads like async/await

### Error Handling

**When to use**: Handling recoverable errors in a type-safe way

```typescript
import { Effect, Data } from "effect"

// Define typed errors
class HttpError extends Data.TaggedError("HttpError")<{
	status: number
	message: string
}> {}

class TimeoutError extends Data.TaggedError("TimeoutError")<{
	ms: number
}> {}

// Effect<Result, HttpError | TimeoutError>
const fetchWithTimeout = (url: string, timeout: number) =>
	Effect.tryPromise({
		try: () => fetch(url, { signal: AbortSignal.timeout(timeout) }),
		catch: (error) =>
			error.name === "TimeoutError"
				? new TimeoutError({ ms: timeout })
				: new HttpError({ status: 0, message: String(error) }),
	})

// Handle specific errors
const handled = fetchWithTimeout("https://api.example.com", 5000).pipe(
	Effect.catchTag("TimeoutError", (e) => Effect.succeed({ error: `Timed out after ${e.ms}ms` })),
	Effect.catchTag("HttpError", (e) => Effect.succeed({ error: `HTTP error: ${e.message}` })),
)
```

**Why it works**: Errors are tracked in the type signature, catchTag is exhaustive

### Dependency Injection with Services

**When to use**: Inverting dependencies for testability

```typescript
import { Effect, Context, Layer } from "effect"

// Define service interface
class McpClient extends Context.Tag("McpClient")<
	McpClient,
	{
		readonly callTool: (name: string, args: object) => Effect.Effect<unknown, McpError>
		readonly readResource: (uri: string) => Effect.Effect<string, McpError>
	}
>() {}

// Implement live service
const McpClientLive = Layer.succeed(McpClient, {
	callTool: (name, args) =>
		Effect.tryPromise({
			try: () => client.request({ method: "tools/call", params: { name, arguments: args } }),
			catch: (e) => new McpError({ cause: e }),
		}),
	readResource: (uri) =>
		Effect.tryPromise({
			try: () => client.request({ method: "resources/read", params: { uri } }),
			catch: (e) => new McpError({ cause: e }),
		}),
})

// Use in program
const program = Effect.gen(function* () {
	const mcp = yield* McpClient
	const result = yield* mcp.callTool("my-tool", { arg: "value" })
	return result
})

// Provide layer at edge
Effect.runPromise(Effect.provide(program, McpClientLive))
```

**Why it works**: Services are resolved at runtime, easily swapped for testing

### Resource Management

**When to use**: Managing resources that need cleanup (connections, file handles)

```typescript
import { Effect, Scope } from "effect"

// Define resource acquisition and release
const connection = Effect.acquireRelease(
	// Acquire
	Effect.tryPromise({
		try: () => createConnection(),
		catch: (e) => new ConnectionError({ cause: e }),
	}),
	// Release
	(conn) => Effect.promise(() => conn.close()),
)

// Use with scoped
const program = Effect.scoped(
	Effect.gen(function* () {
		const conn = yield* connection
		const result = yield* queryDatabase(conn, "SELECT * FROM users")
		return result
		// conn.close() called automatically when scope ends
	}),
)

// Or use acquireUseRelease for simpler cases
const program = Effect.acquireUseRelease(
	Effect.promise(() => createConnection()),
	(conn) => Effect.promise(() => conn.query("SELECT * FROM users")),
	(conn) => Effect.promise(() => conn.close()),
)
```

**Why it works**: Guarantees cleanup even on errors or interruption

### Converting to/from Promises

**When to use**: Integrating Effect with existing Promise-based code

```typescript
import { Effect } from "effect"

// Effect → Promise (run at boundary)
const result = await Effect.runPromise(myEffect)

// Handle errors explicitly
const result = await Effect.runPromise(myEffect.pipe(Effect.catchAll((e) => Effect.succeed({ error: e }))))

// Promise → Effect (wrap at boundary)
const wrapped = Effect.tryPromise({
	try: () => somePromiseFunction(),
	catch: (e) => new MyError({ cause: e }),
})

// Existing async function → Effect
const legacyFn = async (x: number) => x * 2
const effectFn = (x: number) => Effect.promise(() => legacyFn(x))
```

**Why it works**: Keep Effect internal, convert at system boundaries

### Schema Validation (Alternative to Zod)

**When to use**: Validating external data with Effect ecosystem

```typescript
import { Schema } from "effect"

// Define schema
const Person = Schema.Struct({
	name: Schema.String,
	age: Schema.Number.pipe(Schema.positive()),
})

// Decode (throws on error)
const person = Schema.decodeUnknownSync(Person)({ name: "Alice", age: 30 })

// Decode as Effect (typed error)
const decodeEffect = Schema.decodeUnknown(Person)({ name: "Alice", age: 30 })
// Effect<{ name: string, age: number }, ParseError>

// Transform
const PersonFromApi = Schema.transform(Schema.Struct({ n: Schema.String, a: Schema.Number }), Person, {
	decode: ({ n, a }) => ({ name: n, age: a }),
	encode: ({ name, age }) => ({ n: name, a: age }),
})
```

**Why it works**: Integrates with Effect error channel, supports transformations

## Common Pitfalls

1. **Forgetting to Run Effects**

    - ❌ `const result = Effect.succeed(42)` — result is Effect, not 42
    - ✅ `const result = await Effect.runPromise(Effect.succeed(42))`
    - Why: Effects are descriptions of computations, not executed values

2. **Using try/catch with Effects**

    - ❌ `try { await Effect.runPromise(effect) } catch (e) { ... }`
    - ✅ `effect.pipe(Effect.catchAll((e) => Effect.succeed(fallback)))`
    - Why: Use Effect's error channel, not exceptions

3. **Not Tracking Errors in Types**

    - ❌ `Effect.promise(() => fetch(...))` — error is unknown
    - ✅ `Effect.tryPromise({ try: () => fetch(...), catch: (e) => new FetchError(e) })`
    - Why: Typed errors enable exhaustive handling

4. **Blocking with runSync on Async Effects**

    - ❌ `Effect.runSync(Effect.promise(() => ...))` — throws!
    - ✅ `await Effect.runPromise(Effect.promise(() => ...))`
    - Why: runSync only works for synchronous effects

5. **Not Providing Services**
    - ❌ Running effect without providing required services
    - ✅ `Effect.provide(program, MyServiceLive)`
    - Why: Effect tracks required services in type signature

## Quick Reference

### Effect Type Signature

```typescript
Effect<Success, Error, Requirements>

// Examples:
Effect<number> // Succeeds with number, no error, no requirements
Effect<number, Error> // May fail with Error
Effect<number, Error, McpClient> // Requires McpClient service
```

### Common Operators

| Operator                      | Purpose                         |
| ----------------------------- | ------------------------------- |
| `Effect.succeed(a)`           | Create successful effect        |
| `Effect.fail(e)`              | Create failed effect            |
| `Effect.sync(() => ...)`      | Wrap sync computation           |
| `Effect.promise(() => ...)`   | Wrap Promise                    |
| `Effect.tryPromise(...)`      | Wrap Promise with typed error   |
| `Effect.map(f)`               | Transform success value         |
| `Effect.flatMap(f)`           | Chain to another effect         |
| `Effect.mapError(f)`          | Transform error                 |
| `Effect.catchAll(f)`          | Handle all errors               |
| `Effect.catchTag("Tag", f)`   | Handle specific tagged error    |
| `Effect.provide(layer)`       | Provide service dependencies    |
| `Effect.runPromise(e)`        | Execute and return Promise      |
| `Effect.gen(function* () {})` | Generator syntax for sequencing |

### Generator Syntax

```typescript
// This:
const program = Effect.gen(function* () {
	const a = yield* Effect.succeed(1)
	const b = yield* Effect.succeed(2)
	return a + b
})

// Is equivalent to:
const program = Effect.succeed(1).pipe(Effect.flatMap((a) => Effect.succeed(2).pipe(Effect.map((b) => a + b))))
```

## Integration Strategy for McpHub

### Gradual Adoption

1. **Start with new capabilities** (sampling, elicitation)
2. **Keep existing code** as Promise-based
3. **Bridge at boundaries** with `Effect.runPromise`

```typescript
// New capability implemented with Effect
const handleSamplingRequest = (request: SamplingRequest) =>
  Effect.gen(function* () {
    const provider = yield* ApiProvider
    const response = yield* provider.createMessage(request.params)
    return response
  })

// Bridge to existing Promise-based code
async callTool(...): Promise<McpToolCallResponse> {
  // Existing implementation
}

// New method using Effect internally
async handleServerRequest(method: string, params: unknown): Promise<unknown> {
  if (method === "sampling/createMessage") {
    return Effect.runPromise(
      handleSamplingRequest(params as SamplingRequest).pipe(
        Effect.provide(ApiProviderLive)
      )
    )
  }
}
```

### Testing with Effect

```typescript
// Create test service
const McpClientTest = Layer.succeed(McpClient, {
	callTool: (name, args) => Effect.succeed({ result: "mocked" }),
	readResource: (uri) => Effect.succeed("mocked content"),
})

// Test with mocked service
const result = await Effect.runPromise(Effect.provide(program, McpClientTest))
```

## Architecture Notes

### Why Effect for MCP?

1. **Typed Errors**: MCP has many error cases (timeout, connection, protocol)
2. **Resource Management**: Connections need proper cleanup
3. **Dependency Injection**: Easy to mock MCP client for testing
4. **Composability**: Building complex request handlers from simple pieces

### Effect vs. fp-ts

- Effect is more batteries-included (runtime, services, layers)
- Effect has better DX (generator syntax, better errors)
- Effect has Schema built-in (can replace Zod)

---

**Created**: 2026-01-12
**Last Updated**: 2026-01-12
**Freshness**: 🔥 HOT
