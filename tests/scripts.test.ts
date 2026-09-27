import { afterAll, describe, expect, it } from 'vitest'
import { configOf, runTool, setupTempDb } from './helpers'

const cleanup = await setupTempDb()
const { scripts } = await import('@/lib/connectors/scripts')
const store = await import('@/lib/scripts/store')
const { scheduledCount, executeScript, syncSchedules } = await import('@/lib/scripts/scheduler')
const { saveSecret } = await import('@/lib/scripts/secrets')
const { queryJournal } = await import('@/lib/journal')

afterAll(() => {
  store.listScripts().forEach((s) => store.deleteScript(s.id))
  syncSchedules()
  cleanup()
})

const cfg = configOf(scripts, {})
const CODE = `log('run'); state.set('n', (state.get('n') ?? 0) + 1); return 'n=' + state.get('n')`

describe('cron scripts: approval flow', () => {
  it('validates schedule and syntax before accepting code', async () => {
    await expect(runTool(scripts, 'cron_create', cfg, { name: 'bad', schedule: '* * *', code: 'return 1' })).rejects.toThrow('5 полей')
    await expect(runTool(scripts, 'cron_create', cfg, { name: 'bad', schedule: '*/5 * * * *', code: 'return (' })).rejects.toThrow('Ошибка в коде')
  })

  it('new code waits for approval: no run, no enable', async () => {
    const out = await runTool(scripts, 'cron_create', cfg, { name: 'Счётчик', description: 'тест', schedule: '*/5 * * * *', code: CODE })
    expect(out).toContain('ждёт одобрения пользователя')
    await expect(runTool(scripts, 'cron_run', cfg, { script: 'Счётчик' })).rejects.toThrow('не одобрен')
    await expect(runTool(scripts, 'cron_enable', cfg, { script: 'Счётчик', enabled: true })).rejects.toThrow('ещё не одобрен')
    expect(await runTool(scripts, 'cron_list', cfg)).toContain('«Счётчик»')
    expect(await runTool(scripts, 'cron_list', cfg)).toContain('ждёт одобрения')
  })

  it('approval switches the script on; the scheduler picks it up and the assistant can run it', async () => {
    const s = store.findScript('Счётчик')
    expect(() => store.approveScript(s.id, 'other-hash')).toThrow('Код изменился')
    store.approveScript(s.id, s.codeHash)
    syncSchedules()
    expect(store.statusOf(store.findScript(s.id))).toBe('active')
    expect(scheduledCount()).toBe(1)
    expect(await runTool(scripts, 'cron_run', cfg, { script: s.id })).toMatch(/^Готово за .+\nРезультат:\nn=1\nЛог:\nrun$/)
    expect(await runTool(scripts, 'cron_enable', cfg, { script: s.id, enabled: false })).toBe('«Счётчик» выключен.')
    expect(scheduledCount()).toBe(0)
    expect(await runTool(scripts, 'cron_enable', cfg, { script: s.id, enabled: true })).toContain('включён, следующий запуск')
    expect(scheduledCount()).toBe(1)
    expect(queryJournal({ connector: 'scripts' })[0]).toMatchObject({ tool: 'cron:Счётчик', ok: true, resultSummary: 'n=1' })
  })

  it('changing the code pauses the script until it is approved again; the schedule does not', async () => {
    await runTool(scripts, 'cron_update', cfg, { script: 'Счётчик', schedule: '0 9 * * *' })
    expect(store.statusOf(store.findScript('Счётчик'))).toBe('active')
    const out = await runTool(scripts, 'cron_update', cfg, { script: 'Счётчик', code: `${CODE} + '!'` })
    expect(out).toContain('Новый код выключен до одобрения')
    const s = store.findScript('Счётчик')
    expect(store.statusOf(s)).toBe('pending')
    expect(s.enabled).toBe(false)
    expect(scheduledCount()).toBe(0)
    await expect(executeScript(s.id, 'cron')).rejects.toThrow('не одобрен')
    expect(s.approvedCode).toBe(CODE)
  })

  it('rejection is shown to the assistant', async () => {
    const s = store.findScript('Счётчик')
    store.rejectScript(s.id, s.codeHash, 'слишком часто')
    expect(await runTool(scripts, 'cron_get', cfg, { script: s.id })).toContain('Причина отказа: слишком часто')
  })

  it('lists secret names and hosts, never values', async () => {
    saveSecret({ name: 'TELEGRAM_TOKEN', value: '8123:very-secret', hosts: ['api.telegram.org'], description: 'бот' })
    const out = await runTool(scripts, 'cron_secrets', cfg)
    expect(out).toContain('TELEGRAM_TOKEN → api.telegram.org — бот')
    expect(out).not.toContain('very-secret')
  })

  it('delete needs confirm', async () => {
    expect(await runTool(scripts, 'cron_delete', cfg, { script: 'Счётчик' })).toContain('confirm: true')
    expect(await runTool(scripts, 'cron_delete', cfg, { script: 'Счётчик', confirm: true })).toBe('Удалён «Счётчик».')
    expect(store.listScripts()).toHaveLength(0)
  })

  it('marks the tools', () => {
    const hints = Object.fromEntries(scripts.tools.map((t) => [t.name, t.annotations]))
    expect(hints.cron_delete?.destructiveHint).toBe(true)
    expect(hints.cron_list?.readOnlyHint).toBe(true)
    expect(hints.cron_secrets?.readOnlyHint).toBe(true)
  })
})

describe('cron scripts: switches', () => {
  it('«Без одобрения» turns new code on at once, including updates', async () => {
    const auto = configOf(scripts, { autoApprove: true })
    const out = await runTool(scripts, 'cron_create', auto, { name: 'Авто', schedule: '0 9 * * *', code: 'return 1' })
    expect(out).toContain('Включён без одобрения')
    expect(store.statusOf(store.findScript('Авто'))).toBe('active')
    expect(await runTool(scripts, 'cron_run', auto, { script: 'Авто' })).toContain('Готово')

    await runTool(scripts, 'cron_update', auto, { script: 'Авто', code: 'return 2' })
    expect(store.statusOf(store.findScript('Авто'))).toBe('active')
    await runTool(scripts, 'cron_update', cfg, { script: 'Авто', code: 'return 3' })
    expect(store.statusOf(store.findScript('Авто'))).toBe('pending')
  })

  it('instructions describe approval and network access', () => {
    const tools = scripts.tools.map((t) => t.name)
    expect(scripts.instructions?.(cfg, { tools })).toContain('на одобрение')
    expect(scripts.instructions?.(cfg, { tools })).toContain('только во внешние адреса')
    const open = configOf(scripts, { autoApprove: true, allowLocal: true })
    expect(scripts.instructions?.(open, { tools })).toContain('одобрения нет')
    expect(scripts.instructions?.(open, { tools })).toContain('и в локальную сеть')
  })
})

describe('cron scripts: connector settings for scripts', () => {
  it('shares only switched-on connectors, with names derived from fields', async () => {
    const { saveConfig } = await import('@/lib/connectors/store')
    const { getConnector } = await import('@/lib/connectors/registry')
    const { connectorValues, setConnectorShared, describeConnectorSharing } = await import('@/lib/scripts/connector-secrets')
    saveConfig(getConnector('jackett')!, { baseUrl: 'http://jackett:9117', apiKey: 'jk-1', minSeeders: 2 })
    expect(connectorValues()).toEqual([])
    expect(describeConnectorSharing().find((c) => c.id === 'jackett')?.entries.map((e) => e.name)).toEqual(['JACKETT_BASE_URL', 'JACKETT_API_KEY', 'JACKETT_MIN_SEEDERS'])

    setConnectorShared('jackett', true)
    const values = connectorValues()
    expect(values.find((v) => v.name === 'JACKETT_API_KEY')).toMatchObject({ secret: true, value: 'jk-1', hosts: ['jackett'] })
    expect(values.find((v) => v.name === 'JACKETT_BASE_URL')).toMatchObject({ secret: false, value: 'http://jackett:9117' })
    const listed = await runTool(scripts, 'cron_secrets', cfg)
    expect(listed).toContain('JACKETT_API_KEY — API-ключ · секрет → jackett')
    expect(listed).not.toContain('jk-1')
    expect(listed).not.toContain('http://jackett:9117')
    setConnectorShared('jackett', false)
    expect(connectorValues()).toEqual([])
  })
})
