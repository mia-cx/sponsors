import { readFileSync } from 'node:fs'

// Prints the CHANGELOG.md section for one version, used as the GitHub release body.
const version = process.argv[2]
if (!version) throw new Error('release-notes needs a version')
const changelog = readFileSync('CHANGELOG.md', 'utf8')
const start = changelog.indexOf(`\n## ${version}\n`)
if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`)
const rest = changelog.slice(start + `\n## ${version}\n`.length)
const end = rest.search(/\n## /)
process.stdout.write(`${(end < 0 ? rest : rest.slice(0, end)).trim()}\n`)
