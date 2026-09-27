import { z } from 'zod'
import type { ToolParam, ToolSpec } from '../db/schema'

export type { ToolParam, ToolSpec }

/** Custom tools live next to the built-in ones, so they carry their own prefix. */
export const TOOL_PREFIX = 'my_'
export const MAX_PARAMS = 10
/** An MCP call is awaited by the model: well below the client's own timeout. */
export const TOOL_TIME_MS = 25_000

const PARAM_NAME = /^[a-z][a-z0-9_]{0,31}$/

/** «eth price» / «ETH_price» / «my_eth_price» → «my_eth_price». */
export function toolNameOf(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/^my_/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  if (!/^[a-z]/.test(slug)) throw new Error('Имя инструмента — латиница, цифры и _, начинается с буквы, например eth_price')
  return `${TOOL_PREFIX}${slug}`
}

/** What the assistant (or the admin form) sends as parameters. */
export const paramInput = z.object({
  name: z.string().regex(PARAM_NAME, 'имя параметра — латиница в нижнем регистре, цифры и _'),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  description: z.string().max(300).default(''),
  required: z.boolean().default(true),
  options: z.array(z.string().min(1).max(80)).min(1).max(30).optional(),
})

/** Normalized, stable-ordered spec: its JSON is part of the approved version hash. */
export function normalizeSpec(params: z.input<typeof paramInput>[], readOnly: boolean): ToolSpec {
  if (params.length > MAX_PARAMS) throw new Error(`Не больше ${MAX_PARAMS} параметров`)
  const seen = new Set<string>()
  const out: ToolParam[] = params.map((raw, i) => {
    const parsed = paramInput.safeParse(raw)
    if (!parsed.success) throw new Error(`Параметр ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.') || 'значение'} — ${x.message}`).join('; ')}`)
    const p = parsed.data
    if (seen.has(p.name)) throw new Error(`Параметр ${p.name} повторяется`)
    seen.add(p.name)
    if (p.type === 'enum' && !p.options) throw new Error(`У параметра ${p.name} типа enum нужен список options`)
    return { name: p.name, type: p.type, description: p.description, required: p.required, ...(p.type === 'enum' ? { options: p.options } : {}) }
  })
  return { params: out, readOnly }
}

/** zod input schema for registerTool, built from the approved spec. */
export function inputSchemaOf(spec: ToolSpec): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {}
  for (const p of spec.params) {
    let t: z.ZodType =
      p.type === 'number' ? z.number() : p.type === 'boolean' ? z.boolean() : p.type === 'enum' ? z.enum(p.options as [string, ...string[]]) : z.string().max(10_000)
    if (p.description) t = t.describe(p.description)
    shape[p.name] = p.required ? t : t.optional()
  }
  return z.object(shape)
}

/** One line for lists and the review card: «city: string, days?: number». */
export function describeParams(spec: ToolSpec | null): string {
  if (!spec || spec.params.length === 0) return 'без параметров'
  return spec.params.map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type === 'enum' ? (p.options ?? []).join('|') : p.type}`).join(', ')
}
