import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getAuth } from './auth'
import { href } from './prefix'

/** True when the request carries an admin session with 2FA completed. Never throws. */
export async function hasAdminSession(h: Headers): Promise<boolean> {
  try {
    const session = await getAuth().api.getSession({ headers: h })
    return !!session?.user.twoFactorEnabled
  } catch {
    return false
  }
}

/** Admin session with 2FA completed, or a redirect to the login page. */
export async function requireAdmin() {
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session || !session.user.twoFactorEnabled) redirect(href('/login'))
  return session
}
