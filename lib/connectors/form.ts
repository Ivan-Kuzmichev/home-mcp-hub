import os from 'node:os'
import { fieldRegistry, type FieldMeta, type RegisteredConnector } from './types'
import { readConfig, storedSecretFlags, type ConnectorRow } from './store'

/** Serializable description of one form field for the client component. */
export type FieldDescriptor = Omit<FieldMeta, 'widget'> & {
  name: string
  widget: NonNullable<FieldMeta['widget']>
  /** Current value; never set for secrets */
  value: string | boolean
  /** Secret already stored («задан, изменить») */
  secretSet?: boolean
}

export type ToolDescriptor = { name: string; title: string; readOnly: boolean; destructive: boolean }

export function describeFields(c: RegisteredConnector, row: ConnectorRow | undefined): FieldDescriptor[] {
  const stored = row ? (readConfig(c, row) ?? {}) : {}
  const secrets = storedSecretFlags(c, row)
  return Object.entries(c.shape).map(([name, schema]) => {
    const meta = fieldRegistry.get(schema) ?? { label: name }
    const widget = meta.widget ?? (meta.options ? 'segmented' : 'text')
    // Defaults come from the schema itself: parsing `undefined` yields the default.
    const fallback = schema.safeParse(undefined)
    const initial = stored[name] ?? (fallback.success ? fallback.data : undefined)
    const value = meta.secret ? '' : widget === 'switch' ? initial === true : initial === undefined || initial === null ? '' : String(initial)
    return { ...meta, name, widget, value, ...(meta.secret ? { secretSet: secrets[name] ?? false } : {}) }
  })
}

export function describeTools(c: RegisteredConnector): ToolDescriptor[] {
  return c.tools.map((t) => ({ name: t.name, title: t.title, readOnly: !!t.annotations.readOnlyHint, destructive: !!t.annotations.destructiveHint }))
}

/** The hub's IPv4 networks as CIDR, to whitelist in services that skip auth for a subnet. */
export function hubNetworks(): { address: string; cidr: string }[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfoIPv4 => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => {
      const [a, b, c, d] = i.address.split('.').map(Number)
      const bits = Number(i.cidr?.split('/')[1] ?? 24)
      const ip = (((a! << 24) | (b! << 16) | (c! << 8) | d!) >>> 0) & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)
      const net = [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.')
      return { address: i.address, cidr: `${net}/${bits}` }
    })
}
