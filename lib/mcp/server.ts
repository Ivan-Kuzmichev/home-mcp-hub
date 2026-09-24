import type { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
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

function formatUptime(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} мин`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} ч ${min % 60} мин`
  return `${Math.floor(h / 24)} дн`
}

function registerTools(server: McpServer): void {
  server.registerTool(
    'hub_status',
    {
      title: 'Статус хаба',
      description: 'Версия хаба и состояние подключённых сервисов. Первый инструмент для отладки подключения.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const lines = [
        `Home Hub v${HUB_VERSION} · аптайм ${formatUptime(Date.now() - startedAt)}`,
        'Коннекторы: ещё не настроены (админка → Коннекторы).',
      ]
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    },
  )
}

const globalForMcp = globalThis as unknown as { __hubMcp?: (req: Request) => Promise<Response> }

/** Stateless Streamable HTTP handler; tools are registered per request by mcp-handler. */
export function getMcpHandler(): (req: Request) => Promise<Response> {
  globalForMcp.__hubMcp ??= createMcpHandler(registerTools, {
    serverInfo: { name: 'home-mcp-hub', version: HUB_VERSION },
    instructions: MCP_INSTRUCTIONS,
  })
  return globalForMcp.__hubMcp
}
