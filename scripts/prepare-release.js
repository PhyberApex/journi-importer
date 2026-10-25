#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const changelogPath = path.join(root, 'CHANGELOG.md')
const manifestPath = path.join(root, 'trek-plugin.json')

const readChangelog = () => fs.readFileSync(changelogPath, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n')

const sectionOf = (changelog, version) => {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => l.trim() === `## ${version}`)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

const ensureSection = (version, notes) => {
  const changelog = readChangelog()
  if (sectionOf(changelog, version)) return
  if (!notes.trim()) throw new Error(`CHANGELOG.md has no "## ${version}" section and no notes were given`)
  const header = changelog.match(/^# Changelog\n+/)
  if (!header) throw new Error('CHANGELOG.md must start with a "# Changelog" line')
  fs.writeFileSync(changelogPath, `# Changelog\n\n## ${version}\n\n${notes.trim()}\n\n` + changelog.slice(header[0].length))
}

const setManifestVersion = (version) =>
  fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace(/("version":\s*")[^"]*(")/, (_, open, close) => open + version + close))

// npm bumps package.json and package-lock.json together and keeps their formatting.
const setPackageVersion = (version) =>
  execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: root, stdio: 'ignore' })

const [first, ...rest] = process.argv.slice(2)
if (first === '--notes') {
  const section = sectionOf(readChangelog(), rest[0] || '')
  if (!section) throw new Error(`CHANGELOG.md has no "## ${rest[0]}" section`)
  process.stdout.write(section + '\n')
} else {
  if (!/^\d+\.\d+\.\d+$/.test(first || '')) throw new Error('usage: prepare-release.js <version> [notes] | --notes <version>')
  ensureSection(first, rest[0] || '')
  setManifestVersion(first)
  setPackageVersion(first)
}
