export async function register(): Promise<void> {
  // This exact form lets Next drop the Node-only import from the edge bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrap } = await import('./lib/bootstrap')
    try {
      await bootstrap()
    } catch (error) {
      // Without the database the hub is useless: exit so Docker shows the failure and restarts it,
      // instead of Next printing «Ready» and serving errors.
      console.error('Hub failed to start:', error)
      process.exit(1)
    }
  }
}
