import { vi } from 'vitest'
import { outputText, type RegisteredConnector, type ResolvedResult, type ToolOutput } from '@/lib/connectors/types'

export type Call = { method: string; url: URL; headers: Headers; body: BodyInit | null | undefined }

/** Stub global fetch with a router; returns the recorded calls. */
export function mockFetch(route: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call = { method: init.method ?? 'GET', url: new URL(String(input)), headers: new Headers(init.headers), body: init.body }
      calls.push(call)
      return route(call)
    }),
  )
  return calls
}

export function formBody(call: Call): URLSearchParams {
  return call.body instanceof URLSearchParams ? call.body : new URLSearchParams(String(call.body ?? ''))
}

export function configOf(c: RegisteredConnector, raw: Record<string, unknown>): unknown {
  const parsed = c.parseConfig(raw)
  if (!parsed.ok) throw new Error(`invalid config: ${JSON.stringify(parsed.errors)}`)
  return parsed.config
}

export async function runTool(
  c: RegisteredConnector,
  name: string,
  config: unknown,
  args: Record<string, unknown> = {},
  resolveResult: (id: string) => Promise<ResolvedResult> = async () => {
    throw new Error('resolveResult not expected')
  },
): Promise<string> {
  return outputText(await runToolRaw(c, name, config, args, resolveResult))
}

export async function runToolRaw(
  c: RegisteredConnector,
  name: string,
  config: unknown,
  args: Record<string, unknown> = {},
  resolveResult: (id: string) => Promise<ResolvedResult> = async () => {
    throw new Error('resolveResult not expected')
  },
): Promise<ToolOutput> {
  const tool = c.tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no tool ${name}`)
  return tool.run(args, { config, resolveResult })
}

/** Point DATABASE_PATH at a fresh migrated SQLite file. Call before importing modules that use the DB. */
export async function setupTempDb(): Promise<() => void> {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'))
  process.env.DATABASE_PATH = path.join(dir, 'hub.db')
  process.env.HUB_MASTER_KEY ??= 'c'.repeat(64)
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
  const { getDb } = await import('@/lib/db')
  migrate(getDb(), { migrationsFolder: path.join(process.cwd(), 'lib/db/migrations') })
  return () => fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * Everything of a connector the user or the model reads before any call: in English no Cyrillic,
 * in Russian no text without a catalog entry. Returns both findings for one expect.
 */
export async function connectorLanguageGaps(c: RegisteredConnector, config: unknown): Promise<{ cyrillic: string | null; missing: string[] }> {
  const { clearMissingKeys, findCyrillic, missingKeys, runWithLang } = await import('@/lib/i18n')
  const { describeFields, describeTools } = await import('@/lib/connectors/form')
  const { localizedJsonSchema } = await import('@/lib/i18n/schema')
  const { tr } = await import('@/lib/i18n')
  const tools = c.tools.map((x) => x.name)
  const dump = () =>
    JSON.stringify([
      tr(c.name),
      tr(c.description),
      describeFields(c, undefined),
      describeTools(c),
      c.tools.map((x) => [tr(x.description), localizedJsonSchema(x.inputSchema)]),
      c.instructions?.(config, { tools }) ?? null,
    ])
  const cyrillic = findCyrillic(runWithLang('en', dump))
  clearMissingKeys()
  runWithLang('ru', dump)
  return { cyrillic, missing: missingKeys() }
}
