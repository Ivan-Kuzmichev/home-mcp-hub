import type { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import { activeConfig, connectorStates } from '../connectors/active'
import { scrub } from '../connectors/http'
import { resolveResult, type JackettLinkAccess } from '../connectors/resolve'
import { checkConnector } from '../connectors/health'
import { CHUNK_HINT } from '../connectors/prototypes'
import { outputText, ToolError, type ErasedTool, type ToolOutput } from '../connectors/types'
import { logToolCall } from '../journal'
import { logger } from '../logger'
import { mcpContext } from './context'
import { LOGO_DATA_URI } from '../brand'
import { HUB_VERSION } from '../version'

export const MCP_INSTRUCTIONS = [
  'Home Hub управляет домашними сервисами пользователя: поиск торрентов (Jackett), закачки (qBittorrent), стриминг (TorrServe) и публикация HTML-прототипов.',
  'Чтобы скачать фильм или сериал: сначала search_torrents, потом torrent_add (qBittorrent), transmission_add (Transmission) или torrserve_add с result_id из результатов поиска. Магнеты и ссылки не перепечатывай.',
  'При прочих равных выбирай релизы с русской озвучкой и сидами больше 10; если подходящих несколько и они заметно отличаются, спроси пользователя.',
  'Перед удалением торрента вместе с файлами и перед удалением прототипа переспроси пользователя.',
  `Прототипы: ${CHUNK_HINT} Один большой вызов с целым HTML может оборваться.`,
  'Cron-скрипты: cron_create/cron_update отправляют код на одобрение пользователю, запускать и включать можно только одобренный. Секреты — только заглушками {{secret:ИМЯ}} (список — cron_secrets), значения тебе недоступны.',
  'Paperless: для разметки — paperless_review (там правила пользователя и примеры прошлой разметки), затем paperless_update списком изменений. Используй существующие теги и корреспондентов из paperless_taxonomy. Для массовой правки сначала покажи план (dry_run), если пользователь не попросил применять сразу. Пересылаемую ссылку (shareable) — только по прямой просьбе.',
  'Если что-то не работает, вызови hub_status: он покажет, какие сервисы подключены и отвечают.',
  'Отвечай коротко: пользователь читает ответы на телефоне.',
].join('\n')

const startedAt = Date.now()
const STATUS_CHECK_TIMEOUT_MS = 8_000

function formatUptime(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} ч ${min % 60} мин`
  return `${Math.floor(h / 24)} дн`
}

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
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
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
}

const globalForMcp = globalThis as unknown as { __hubMcp?: (req: Request) => Promise<Response> }

export function getMcpHandler(): (req: Request) => Promise<Response> {
  // title and icons (MCP Implementation) let clients show the hub's name and logo.
  const serverInfo = { name: 'home-mcp-hub', title: 'Home Hub', version: HUB_VERSION, icons: [{ src: LOGO_DATA_URI, mimeType: 'image/svg+xml', sizes: ['any'] }] }
  globalForMcp.__hubMcp ??= createMcpHandler(initializeServer, {
    serverInfo,
    instructions: MCP_INSTRUCTIONS,
  })
  return globalForMcp.__hubMcp
}
