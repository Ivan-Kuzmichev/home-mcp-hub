import { z } from 'zod'
import { defineConnector, field, secret } from '../types'

const configSchema = z.object({
  baseUrl: field(
    z
      .string()
      .trim()
      .url('Нужен адрес вида http://host:port')
      .transform((v) => v.replace(/\/+$/, ''))
      .default('http://mitmweb:8081'),
    {
      label: 'Адрес mitmweb',
      placeholder: 'http://mitmweb:8081',
      help: 'Внутренний адрес веб-интерфейса mitmweb',
      widget: 'url',
      mono: true,
      section: 'connection',
    },
  ),
  password: secret({ label: 'Пароль веб-интерфейса', help: 'MITM_WEB_PASSWORD. Пусто — без пароля', section: 'connection' }),
  allowMocks: field(z.boolean().default(false), {
    label: 'Разрешить моки',
    help: 'Подмена ответов сервисов. Выключено — только просмотр трафика',
    widget: 'switch',
    section: 'defaults',
  }),
  showTokens: field(z.boolean().default(false), {
    label: 'Показывать токены',
    help: 'Выключено — токены и пароли в заголовках и телах маскируются',
    widget: 'switch',
    section: 'defaults',
  }),
  textLimit: field(z.coerce.number().int().min(2000).max(200_000).default(24_000), {
    label: 'Лимит текста в ответе, символов',
    help: 'Сколько текста в одном ответе',
    widget: 'number',
    section: 'defaults',
  }),
  timeoutSec: field(z.coerce.number().int().min(5).max(120).default(15), {
    label: 'Таймаут запроса, с',
    help: 'На один вызов mitmweb',
    widget: 'number',
    section: 'defaults',
  }),
})

export type Config = z.infer<typeof configSchema>

export const mitmproxy = defineConnector<Config>({
  id: 'mitmproxy',
  name: 'mitmproxy',
  description: 'Перехват трафика: куда ходят приложения и моки',
  docsUrl: 'https://docs.mitmproxy.org/',
  configSchema,
  test: async () => ({ ok: false, summary: 'не реализовано', details: [] }),
  tools: [],
})
