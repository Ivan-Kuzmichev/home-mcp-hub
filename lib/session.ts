import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getAuth } from './auth'
import { href } from './prefix'

/** Admin session with 2FA completed, or a redirect to the login page. */
export async function requireAdmin() {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session || !session.user.twoFactorEnabled) redirect(href('/login'))
  return session
}
