import { AsyncLocalStorage } from 'node:async_hooks'

/** Who is calling: set by /api/mcp around the MCP handler, read when logging tool calls. */
export type McpRequestContext = { clientId: string | null; ip: string | null }

const globalForCtx = globalThis as unknown as { __hubMcpCtx?: AsyncLocalStorage<McpRequestContext> }
export const mcpContext = (globalForCtx.__hubMcpCtx ??= new AsyncLocalStorage<McpRequestContext>())
