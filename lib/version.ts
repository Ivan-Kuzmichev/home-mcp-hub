import pkg from '../package.json'

export const HUB_VERSION: string = pkg.version

/** Short commit of the image, set at build time in CI (Dockerfile ARG HUB_GIT_SHA). */
export function hubBuild(): string | null {
  const sha = process.env.HUB_GIT_SHA
  return sha && sha !== 'dev' ? sha.slice(0, 7) : null
}
