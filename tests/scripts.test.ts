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

  it('after approval the assistant can run and enable it; the scheduler picks it up', async () => {
    const s = store.findScript('Счётчик')
    expect(() => store.approveScript(s.id, 'other-hash')).toThrow('Код изменился')
    store.approveScript(s.id, s.codeHash)
    expect(await runTool(scripts, 'cron_run', cfg, { script: s.id })).toMatch(/^Готово за .+\nРезультат:\nn=1\nЛог:\nrun$/)
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
