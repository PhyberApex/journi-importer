const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')

const creds = { email: process.env.JOURNI_EMAIL, password: process.env.JOURNI_PASSWORD }
const hasCreds = Boolean(creds.email && creds.password)
const PORT = Number(process.env.E2E_PORT) || 4399
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = path.resolve(__dirname, '..', '..')
const IMPORT_WINDOW_ITEMS = 40
const PICTURE_SAMPLE = 3

const call = async (route, body) => {
  const res = await fetch(`${BASE}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  assert.equal(res.status, 200, `${route} answered HTTP ${res.status}: ${text}`)
  return JSON.parse(text)
}

const waitForHost = async (deadline) => {
  while (Date.now() < deadline) {
    const up = await fetch(`${BASE}/`).then((r) => r.ok).catch(() => false)
    if (up) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`dev host did not come up on ${BASE}`)
}

const startDevHost = () => {
  const cli = path.join(ROOT, 'node_modules', 'trek-plugin-sdk', 'dist', 'cli', 'trek-plugin.js')
  const child = spawn(process.execPath, [cli, 'dev', ROOT, '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(d))
  child.stderr.on('data', (d) => process.stderr.write(d))
  return child
}

const smallestImportableJournal = (journals) =>
  journals
    .filter((j) => (j.entryCount ?? 0) > 0 && (j.pictureCount ?? 0) > 0)
    .sort((a, b) => a.entryCount - b.entryCount)[0]

describe('Journi import end to end', { skip: hasCreds ? false : 'JOURNI_EMAIL and JOURNI_PASSWORD are not set' }, () => {
  let host
  let session
  let journal
  let moments
  let progress
  const refs = []

  before(async () => {
    host = startDevHost()
    await waitForHost(Date.now() + 30000)
  })

  after(async () => {
    if (refs.length) {
      let remaining = [...refs].reverse()
      while (remaining.length) remaining = (await call('/undo', { refs: remaining })).remaining
    }
    host?.kill()
  })

  test('rejects a wrong password with a readable error', async () => {
    const result = await call('/login', { email: creds.email, password: 'definitely-not-the-password' })
    assert.ok(result.error, 'expected an error')
    assert.match(result.error, /did not accept/)
  })

  test('signs in and lists the account journals', async () => {
    const result = await call('/login', creds)
    assert.equal(result.ok, true, result.error)
    assert.ok(result.session, 'no session handle')
    assert.ok(Array.isArray(result.journals) && result.journals.length > 0, 'no journals listed')
    for (const j of result.journals) {
      assert.ok(j.url, 'journal without url')
      assert.ok(j.title, 'journal without title')
    }
    session = result.session
    journal = smallestImportableJournal(result.journals)
    assert.ok(journal, 'the account needs one journal with moments and pictures')
  })

  test('restores the session from its handle', async () => {
    const result = await call('/session', { session })
    assert.equal(result.signedIn, true)
    assert.equal(result.journals.length > 0, true)
  })

  test('fetches the moments of a journal through the signed-in session', async () => {
    const result = await call('/journal', { url: `https://www.journiapp.com/app/j/${journal.url}`, session })
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.private, false, 'journal reported private although signed in as its owner')
    assert.equal(result.journal.title, journal.title)
    moments = result.moments
    assert.ok(moments.length > 0, 'journal has no moments')
    assert.ok(moments.length <= journal.entryCount, 'more moments than Journi counts entries')
    for (const m of moments) {
      assert.match(m.date ?? '', /^\d{4}-\d{2}-\d{2}$/, `moment ${m.id} without local date`)
      assert.ok(Array.isArray(m.pictures), `moment ${m.id} without pictures array`)
    }
    assert.ok(moments.some((m) => m.title), 'no moment carries a title')
    assert.ok(moments.some((m) => m.pictures.length > 0), 'no moment carries a picture')
  })

  test('creates a journey with one entry per moment', async () => {
    progress = { journeyId: null, next: 0, entries: 0, momentEntryIds: {}, done: false }
    const journalInput = { title: journal.title, subtitle: 'e2e' }
    for (let round = 0; !progress.done && round < 100; round++) {
      const window = moments.slice(progress.next, progress.next + IMPORT_WINDOW_ITEMS)
      const result = await call('/import', { journal: journalInput, moments: window, offset: progress.next, total: moments.length, progress })
      if (result.progress?.journeyId && !refs.length) refs.push({ type: 'journey', id: result.progress.journeyId })
      assert.equal(result.error, undefined, result.error)
      assert.deepEqual(result.errors, [], 'entries failed')
      progress = result.progress
    }
    refs.push(...Object.values(progress.momentEntryIds).map((id) => ({ type: 'entry', id })))
    assert.equal(progress.done, true)
    assert.equal(progress.entries, moments.length)
    assert.equal(Object.keys(progress.momentEntryIds).length, moments.length)
  })

  test('fetches pictures from Journi and attaches them to their entry', async () => {
    const jobs = moments
      .flatMap((m) => m.pictures.map((p) => ({ entryId: progress.momentEntryIds[m.id], guid: p.guid })))
      .slice(0, PICTURE_SAMPLE)
    for (const job of jobs) {
      const result = await call('/photo', { session, ...job })
      assert.equal(result.ok, true, `picture ${job.guid}: ${result.error}`)
      assert.ok(result.bytes > 0)
    }
  })

  test('refuses anything that is not a Journi picture id', async () => {
    const result = await call('/photo', { session, entryId: refs.at(-1).id, guid: '../etc/passwd' })
    assert.match(result.error, /Not a Journi picture id/)
  })

  test('undoes the import', async () => {
    const toDelete = [...refs].reverse()
    let remaining = toDelete
    let deleted = 0
    while (remaining.length) {
      const result = await call('/undo', { refs: remaining })
      assert.deepEqual(result.errors, [], 'undo failed')
      deleted += result.deleted
      remaining = result.remaining
    }
    assert.equal(deleted, toDelete.length)
    refs.length = 0
  })

  test('signs out and forgets the session', async () => {
    await call('/logout', { session })
    const result = await call('/session', { session })
    assert.equal(result.signedIn, false)
  })
})
