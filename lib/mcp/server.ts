import type { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import { activeConfig, connectorStates } from '../connectors/active'
import { connectorInstructions, visibleTools } from '../connectors/instructions'
import { scrub } from '../connectors/http'
import { resolveResult, type JackettLinkAccess } from '../connectors/resolve'
import { checkConnector } from '../connectors/health'
import { outputText, ToolError, type ErasedTool, type ToolOutput } from '../connectors/types'
import { logToolCall } from '../journal'
import { executeTool } from '../scripts/scheduler'
import { listScripts, statusOf } from '../scripts/store'
import { inputSchemaOf } from '../scripts/tool-spec'
import { logger } from '../logger'
import { mcpContext } from './context'
import { MCP_SCOPE } from '../auth'
import { LOGO_DATA_URI } from '../brand'
import { HUB_VERSION } from '../version'

/**
 * Server instructions, built from the connectors that are on right now: the model does not read
 * about services the hub does not have or tools that are switched off. Paperless labeling rules
 * are not here — they come with the Paperless read tools.
 */
export function buildInstructions(): string {
  const states = connectorStates()
  const tools = visibleTools(states)
  const active = states.filter((s) => s.status === 'active')
  const services = active.map((s) => `${s.connector.name} — ${s.connector.description.toLowerCase()}`).join('; ')
  const lines = [
    services ? `Home Hub — домашний хаб пользователя. Подключено: ${services}.` : 'Home Hub — домашний хаб пользователя. Сервисы пока не подключены.',
    ...active.map((s) => connectorInstructions(s.connector, s.row, s.config, tools).text),
    'Перед удалением вместе с файлами и перед другими необратимыми действиями переспроси пользователя.',
    'Если что-то не работает, вызови hub_status: он покажет, какие сервисы подключены и отвечают.',
    'Отвечай коротко: пользователь читает ответы на телефоне.',
  ]
  return lines.filter((l): l is string => !!l).join('\n')
}

const startedAt = Date.now()
const STATUS_CHECK_TIMEOUT_MS = 8_000

function formatUptime(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} ч ${min % 60} мин`
  return `${Math.floor(h / 24)} дн`
}

/**
 * Every tool needs the OAuth token (OpenAI Apps SDK `securitySchemes`): ChatGPT offers to link
 * the account only for tools that declare it. The SDK passes `_meta` through as is.
 */
const AUTH_META = { securitySchemes: [{ type: 'oauth2', scopes: [MCP_SCOPE] }] }

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) }
}

function toContent(out: ToolOutput) {
  if (typeof out === 'string') return text(out)
  return {
    content: [
      { type: 'text' as const, text: out.text },
      ...(out.images ?? []).map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType })),
    ],
  }
}

function jackettAccess(): JackettLinkAccess | null {
  const cfg = activeConfig('jackett') as { baseUrl?: string; apiKey?: string } | null
  return cfg?.baseUrl && cfg.apiKey ? { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey } : null
}

/** Run a tool, turn errors into short messages and write the journal entry. */
async function runLogged(name: string, connectorId: string, args: unknown, fn: () => Promise<ToolOutput>) {
  const started = Date.now()
  const ctx = mcpContext.getStore()
  const log = (ok: boolean, message: string) =>
    logToolCall({ tool: name, connectorId, args, ok, [ok ? 'result' : 'error']: message, durationMs: Date.now() - started, clientId: ctx?.clientId, ip: ctx?.ip })
  try {
    const result = await fn()
    log(true, outputText(result))
    return toContent(result)
  } catch (error) {
    let message: string
    if (error instanceof ToolError) message = error.message
    else if (error instanceof z.ZodError) message = `Неверные параметры: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    else {
      message = `Внутренняя ошибка хаба: ${scrub(error instanceof Error ? error.message : String(error))}`
      logger.error({ tool: name, err: message }, 'tool failed')
    }
    log(false, message)
    return text(message, true)
  }
}

function registerConnectorTool(server: McpServer, connectorId: string, tool: ErasedTool, config: unknown): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations, _meta: AUTH_META },
    async (args: unknown) =>
      runLogged(tool.name, connectorId, args, () => tool.run(args, { config, resolveResult: (id) => resolveResult(id, jackettAccess()) })),
  )
}

async function hubStatus(): Promise<string> {
  const states = connectorStates()
  const lines = await Promise.all(
    states.map(async (s) => {
      const name = s.connector.name
      switch (s.status) {
        case 'unconfigured':
          return `• ${name}: не настроен`
        case 'disabled':
          return `• ${name}: выключен в админке`
        case 'invalid':
          return `• ${name}: настройки неполные — открой админку`
        case 'active': {
          const r = await checkConnector(s, STATUS_CHECK_TIMEOUT_MS)
          const tools = s.connector.tools.filter((t) => !s.row.disabledTools.includes(t.name)).length
          return r.ok ? `• ${name}: OK · ${r.summary} · ${tools} инстр.` : `• ${name}: ошибка — ${r.summary}`
        }
      }
    }),
  )
  return [`Home Hub v${HUB_VERSION} · аптайм ${formatUptime(Date.now() - startedAt)}`, ...lines].join('\n')
}

/** Called for every MCP request: tools reflect the current connector settings. */
function initializeServer(server: McpServer): void {
  server.registerTool(
    'hub_status',
    {
      title: 'Статус хаба',
      description: 'Версия хаба и состояние сервисов: какие подключены, отвечают ли, версии. Первый инструмент для отладки.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: AUTH_META,
    },
    async (args: unknown) => runLogged('hub_status', 'hub', args, hubStatus),
  )

  // Tool names are global in MCP: a clash would make registerTool throw and break every call.
  const registered = new Set(['hub_status'])
  for (const state of connectorStates()) {
    if (state.status !== 'active') continue
    for (const tool of state.connector.tools) {
      if (state.row.disabledTools.includes(tool.name)) continue
      if (registered.has(tool.name)) {
        logger.warn({ tool: tool.name, connector: state.connector.id }, 'duplicate tool name skipped')
        continue
      }
      registered.add(tool.name)
      registerConnectorTool(server, state.connector.id, tool, state.config)
    }
  }
  registerCustomTools(server, registered)
}

/** Approved, switched-on MCP tools from the Scripts screen — only while that connector is on. */
function registerCustomTools(server: McpServer, registered: Set<string>): void {
  if (!activeConfig('scripts')) return
  for (const s of listScripts()) {
    if (s.kind !== 'tool' || statusOf(s) !== 'active' || !s.spec) continue
    if (registered.has(s.name)) {
      logger.warn({ tool: s.name }, 'duplicate tool name skipped')
      continue
    }
    registered.add(s.name)
    const spec = s.spec
    server.registerTool(
      s.name,
      {
        title: s.name,
        description: s.description,
        inputSchema: inputSchemaOf(spec),
        annotations: spec.readOnly ? { readOnlyHint: true, openWorldHint: true } : { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        _meta: AUTH_META,
      },
      async (args: unknown) =>
        runLogged(s.name, 'scripts', args, async () => {
          const r = await executeTool(s.id, inputSchemaOf(spec).parse(args))
          if (!r.ok) throw new ToolError(r.error ?? 'ошибка')
          return r.output ?? (r.logs.length ? r.logs.join('\n') : 'Готово')
        }),
    )
  }
}

const globalForMcp = globalThis as unknown as { __hubMcp?: { instructions: string; handler: (req: Request) => Promise<Response> } }

/** The handler is rebuilt only when the instructions change (a connector or its notes changed). */
export function getMcpHandler(): (req: Request) => Promise<Response> {
  const instructions = buildInstructions()
  if (globalForMcp.__hubMcp?.instructions !== instructions) {
    // title and icons (MCP Implementation) let clients show the hub's name and logo.
    const serverInfo = { name: 'home-mcp-hub', title: 'Home Hub', version: HUB_VERSION, icons: [{ src: LOGO_DATA_URI, mimeType: 'image/svg+xml', sizes: ['any'] }] }
    globalForMcp.__hubMcp = { instructions, handler: createMcpHandler(initializeServer, { serverInfo, instructions }) }
  }
  return globalForMcp.__hubMcp.handler
}
