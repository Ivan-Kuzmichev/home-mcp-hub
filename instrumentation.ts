export async function register(): Promise<void> {
  // This exact form lets Next drop the Node-only import from the edge bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { bootstrap } = await import('./lib/bootstrap')
    await bootstrap()
  }
}
