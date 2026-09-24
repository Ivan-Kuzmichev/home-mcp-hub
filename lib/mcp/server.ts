import type { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import { activeConfig, connectorStates, type ConnectorState } from '../connectors/active'
import { scrub } from '../connectors/http'
import { resolveResult, type JackettLinkAccess } from '../connectors/resolve'
import { recordCheck } from '../connectors/store'
import { ToolError, type ErasedTool, type TestResult } from '../connectors/types'
import { logger } from '../logger'
import { HUB_VERSION } from '../version'

export const MCP_INSTRUCTIONS = [
  'Home Hub управляет домашними сервисами пользователя: поиск торрентов (Jackett), закачки (qBittorrent), стриминг (TorrServe) и публикация HTML-прототипов.',
  'Чтобы скачать фильм или сериал: сначала search_torrents, потом torrent_add или torrserve_add с result_id из результатов поиска. Магнеты и ссылки не перепечатывай.',
  'При прочих равных выбирай релизы с русской озвучкой и сидами больше 10; если подходящих несколько и они заметно отличаются, спроси пользователя.',
  'Перед удалением торрента вместе с файлами и перед удалением прототипа переспроси пользователя.',
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

function jackettAccess(): JackettLinkAccess | null {
  const cfg = activeConfig('jackett') as { baseUrl?: string; apiKey?: string } | null
  return cfg?.baseUrl && cfg.apiKey ? { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey } : null
}

function registerConnectorTool(server: McpServer, tool: ErasedTool, config: unknown): void {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
    async (args: unknown) => {
      try {
        return text(await tool.run(args, { config, resolveResult: (id) => resolveResult(id, jackettAccess()) }))
      } catch (error) {
        if (error instanceof ToolError) return text(error.message, true)
        if (error instanceof z.ZodError) return text(`Неверные параметры: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, true)
        const message = scrub(error instanceof Error ? error.message : String(error))
        logger.error({ tool: tool.name, err: message }, 'tool failed')
        return text(`Внутренняя ошибка хаба: ${message}`, true)
      }
    },
  )
}

async function checkWithTimeout(state: Extract<ConnectorState, { status: 'active' }>): Promise<TestResult> {
  const timeout = new Promise<TestResult>((resolve) =>
    setTimeout(() => resolve({ ok: false, summary: `не ответил за ${STATUS_CHECK_TIMEOUT_MS / 1000} с`, details: [] }), STATUS_CHECK_TIMEOUT_MS),
  )
  const result = await Promise.race([state.connector.test(state.config), timeout])
  recordCheck(state.connector.id, result)
  return result
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
          const r = await checkWithTimeout(s)
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
    async () => text(await hubStatus()),
  )

  for (const state of connectorStates()) {
    if (state.status !== 'active') continue
    for (const tool of state.connector.tools) {
      if (!state.row.disabledTools.includes(tool.name)) registerConnectorTool(server, tool, state.config)
    }
  }
}

const globalForMcp = globalThis as unknown as { __hubMcp?: (req: Request) => Promise<Response> }

export function getMcpHandler(): (req: Request) => Promise<Response> {
  globalForMcp.__hubMcp ??= createMcpHandler(initializeServer, {
    serverInfo: { name: 'home-mcp-hub', version: HUB_VERSION },
    instructions: MCP_INSTRUCTIONS,
  })
  return globalForMcp.__hubMcp
}
