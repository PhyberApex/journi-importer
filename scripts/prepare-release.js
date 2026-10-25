#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const changelogPath = path.join(root, 'CHANGELOG.md')
const manifestPaths = ['trek-plugin.json', 'package.json'].map((f) => path.join(root, f))

const readChangelog = () => fs.readFileSync(changelogPath, 'utf8')

const sectionOf = (changelog, version) => {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${version}`)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

const setVersion = (file, version) =>
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/("version":\s*")[^"]*(")/, `$1${version}$2`))

const ensureSection = (version, notes) => {
  const changelog = readChangelog()
  if (sectionOf(changelog, version)) return
  if (!notes.trim()) throw new Error(`CHANGELOG.md has no "## ${version}" section and no notes were given`)
  fs.writeFileSync(changelogPath, changelog.replace(/^# Changelog\n+/, `# Changelog\n\n## ${version}\n\n${notes.trim()}\n\n`))
}

const [first, ...rest] = process.argv.slice(2)
if (first === '--notes') {
  const section = sectionOf(readChangelog(), rest[0] || '')
  if (!section) throw new Error(`CHANGELOG.md has no "## ${rest[0]}" section`)
  process.stdout.write(section + '\n')
} else {
  if (!/^\d+\.\d+\.\d+$/.test(first || '')) throw new Error('usage: prepare-release.js <version> [notes] | --notes <version>')
  ensureSection(first, rest[0] || '')
  manifestPaths.forEach((file) => setVersion(file, first))
}
