// pnpm release [patch|minor|major] — bump package.json, commit, tag vX.Y.Z and push.
// The tag makes CI publish ghcr.io/…/home-mcp-hub:X.Y.Z and :X.Y.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const level = process.argv[2] ?? 'patch'
if (!['patch', 'minor', 'major'].includes(level)) throw new Error('usage: pnpm release [patch|minor|major]')
const sh = (cmd) => execSync(cmd, { stdio: 'inherit' })
if (execSync('git status --porcelain').toString().trim()) throw new Error('Working tree is not clean')

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
pkg.version = level === 'major' ? `${major + 1}.0.0` : level === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)

sh('git add package.json')
sh(`git commit -m "Release v${pkg.version}"`)
sh(`git tag -a v${pkg.version} -m "v${pkg.version}"`)
sh('git push origin HEAD --follow-tags')
console.log(`\nv${pkg.version} pushed — CI publishes :${pkg.version} and :${pkg.version.split('.').slice(0, 2).join('.')}`)
