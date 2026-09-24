import { z } from 'zod'

// ---------------------------------------------------------------------------
// Config fields. The admin panel renders the form from configSchema; every field
// carries its UI metadata in this registry.

export type FieldOption = {
  value: string
  label: string
  short?: string
  help?: string
  /** Show the hub's own addresses under the help text (for LAN whitelists) */
  showHubNetwork?: boolean
}

export type FieldMeta = {
  label: string
  help?: string
  placeholder?: string
  widget?: 'text' | 'url' | 'number' | 'switch' | 'segmented'
  options?: FieldOption[]
  /** Stored encrypted, never shown after saving */
  secret?: boolean
  mono?: boolean
  /** Show the field only when another field has one of the values */
  showWhen?: { field: string; equals: string[] }
  /** 'connection' fields go first, 'defaults' after the auth block */
  section?: 'connection' | 'defaults'
}

export const fieldRegistry = z.registry<FieldMeta>()

export function field<T extends z.ZodType>(schema: T, meta: FieldMeta): T {
  fieldRegistry.add(schema, meta)
  return schema
}

/** A secret string (password, API key): encrypted with HUB_MASTER_KEY, masked in the UI. */
export function secret(meta: Omit<FieldMeta, 'secret'>) {
  return field(z.string().optional(), { ...meta, secret: true, mono: true })
}

export function baseUrl(meta: Omit<FieldMeta, 'widget'>) {
  return field(
    z
      .string()
      .trim()
      .url('Нужен адрес вида http://host:port')
      .transform((v) => v.replace(/\/+$/, '')),
    { ...meta, widget: 'url', mono: true, section: 'connection' },
  )
}

// ---------------------------------------------------------------------------
// Tools

/** Error with a short, user-facing message; shown to Claude as the tool result. */
export class ToolError extends Error {}

export type ResolvedResult =
  | { kind: 'magnet'; uri: string; title: string; infoHash?: string }
  | { kind: 'file'; data: Uint8Array; filename: string; title: string; infoHash?: string }

export type ToolContext<C> = {
  config: C
  /** result_id from search_torrents → magnet link or .torrent file */
  resolveResult: (resultId: string) => Promise<ResolvedResult>
}

export type ToolAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type ConnectorTool<C, S extends z.ZodObject = z.ZodObject> = {
  name: string
  title: string
  description: string
  inputSchema: S
  annotations: ToolAnnotations
  // Method syntax on purpose: parameters stay bivariant, so tools with specific
  // input schemas fit into Connector.tools.
  run(args: z.output<S>, ctx: ToolContext<C>): Promise<string>
}

/** toolFor<Config>()({ inputSchema, run }) — argument types are inferred from inputSchema. */
export function toolFor<C>() {
  return <S extends z.ZodObject>(tool: ConnectorTool<C, S>): ConnectorTool<C, z.ZodObject> => tool
}

export type TestResult = {
  ok: boolean
  /** One line: «qBittorrent v5.2.3» or the error */
  summary: string
  /** Extra lines for the admin panel: API version, counts, latency */
  details: string[]
  version?: string
}

export type Connector<C> = {
  id: string
  name: string
  description: string
  /** Built into the hub: no settings, enabled from the first start */
  builtin?: boolean
  docsUrl?: string
  configSchema: z.ZodType<C> & { shape: Record<string, z.ZodType> }
  test: (config: C) => Promise<TestResult>
  // Tools are a static list (not a factory of config) so the admin panel can list
  // them before the connector is configured; the config arrives in ToolContext.
  tools: ConnectorTool<C, z.ZodObject>[]
}

// ---------------------------------------------------------------------------
// Type-erased form used by the registry, admin panel and MCP server.

export type ErasedTool = {
  name: string
  title: string
  description: string
  inputSchema: z.ZodObject
  annotations: ToolAnnotations
  run: (args: unknown, ctx: ToolContext<unknown>) => Promise<string>
}

export type RegisteredConnector = {
  id: string
  name: string
  description: string
  builtin: boolean
  docsUrl?: string
  shape: Record<string, z.ZodType>
  parseConfig: (raw: unknown) => { ok: true; config: unknown } | { ok: false; errors: Record<string, string> }
  test: (config: unknown) => Promise<TestResult>
  tools: ErasedTool[]
}

export function defineConnector<C>(c: Connector<C>): RegisteredConnector {
  // Values reaching test/run always come from parseConfig, so the casts are safe.
  const asConfig = (v: unknown) => v as C
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    builtin: c.builtin ?? false,
    docsUrl: c.docsUrl,
    shape: c.configSchema.shape,
    parseConfig(raw) {
      const r = c.configSchema.safeParse(raw)
      if (r.success) return { ok: true, config: r.data }
      const errors: Record<string, string> = {}
      for (const issue of r.error.issues) {
        const key = String(issue.path[0] ?? '_')
        errors[key] ??= issue.message
      }
      return { ok: false, errors }
    },
    test: (config) => c.test(asConfig(config)),
    tools: c.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      run: (args, ctx) => t.run(t.inputSchema.parse(args), { ...ctx, config: asConfig(ctx.config) }),
    })),
  }
}
