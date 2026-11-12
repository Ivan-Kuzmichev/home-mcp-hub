import type { z } from 'zod'
import { translateText, type Lang } from './core'
import { getLang } from './lang'

type Standard = z.ZodType['~standard']
type JsonOptions = Parameters<NonNullable<Standard['jsonSchema']>['input']>[0]

/** Every `description` in a JSON Schema through the catalog, nested ones too. */
function translateDescriptions(node: unknown, lang: Lang): unknown {
  if (Array.isArray(node)) return node.map((n) => translateDescriptions(n, lang))
  if (!node || typeof node !== 'object') return node
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [k, k === 'description' && typeof v === 'string' ? translateText(lang, v) : translateDescriptions(v, lang)]),
  )
}

/**
 * The tool's input schema for the MCP SDK (Standard Schema with JSON Schema): validation is the zod
 * schema's own, the JSON Schema shown to the model is translated at listing time.
 */
export function localizeSchema(schema: z.ZodType): { '~standard': Standard } {
  const std = schema['~standard']
  const json = std.jsonSchema!
  return {
    '~standard': {
      ...std,
      // Not 'zod': a vendor check must not treat this wrapper as a zod schema.
      vendor: 'home-mcp-hub',
      jsonSchema: {
        input: (o: JsonOptions) => translateDescriptions(json.input(o), getLang()) as Record<string, unknown>,
        output: (o: JsonOptions) => translateDescriptions(json.output(o), getLang()) as Record<string, unknown>,
      },
    },
  }
}

/** What the model sees, for Diagnostics and coverage tests. */
export function localizedJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return localizeSchema(schema)['~standard'].jsonSchema!.input({ target: 'draft-2020-12' })
}
