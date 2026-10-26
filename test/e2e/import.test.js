const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')

const creds = { email: process.env.JOURNI_EMAIL, password: process.env.JOURNI_PASSWORD }
const hasCreds = Boolean(creds.email && creds.password)
const ROOT = path.resolve(__dirname, '..', '..')
const IMPORT_WINDOW_ITEMS = 40
const PICTURE_SAMPLE = 3

let BASE

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})

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

const startDevHost = (port) => {
  const cli = path.join(ROOT, 'node_modules', 'trek-plugin-sdk', 'dist', 'cli', 'trek-plugin.js')
  const child = spawn(process.execPath, [cli, 'dev', ROOT, '--port', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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
  let momentEntryIds
  const refs = []

  const recordRound = (result) => {
    const journeyId = result.progress?.journeyId
    if (journeyId && !refs.some((r) => r.type === 'journey' && r.id === journeyId)) refs.push({ type: 'journey', id: journeyId })
    refs.push(...Object.values(result.created || {}).map((id) => ({ type: 'entry', id })))
  }

  before(async () => {
    const port = Number(process.env.E2E_PORT) || await freePort()
    BASE = `http://127.0.0.1:${port}`
    host = startDevHost(port)
    await waitForHost(Date.now() + 30000)
  })

  after(async () => {
    try {
      let remaining = [...refs].reverse()
      for (let round = 0; remaining.length && round < 50; round++) remaining = (await call('/undo', { refs: remaining })).remaining
    } finally {
      host?.kill()
    }
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
    let progress = { journeyId: null, next: 0, entries: 0, done: false }
    momentEntryIds = {}
    const journalInput = { title: journal.title, subtitle: 'e2e' }
    const first = await call('/import', { journal: journalInput, moments: moments.slice(0, IMPORT_WINDOW_ITEMS), offset: 0, total: moments.length, progress })
    recordRound(first)
    assert.equal(first.error, undefined, first.error)
    assert.ok(first.progress.journeyId, 'first round returned no journey id')
    assert.deepEqual(first.created, {}, 'first round should only create the journey')
    assert.equal(first.progress.done, false)
    progress = first.progress
    for (let round = 0; !progress.done && round < 100; round++) {
      const window = moments.slice(progress.next, progress.next + IMPORT_WINDOW_ITEMS)
      const result = await call('/import', { journal: journalInput, moments: window, offset: progress.next, total: moments.length, progress })
      recordRound(result)
      assert.equal(result.error, undefined, result.error)
      assert.deepEqual(result.errors, [], 'entries failed')
      Object.assign(momentEntryIds, result.created)
      progress = result.progress
    }
    assert.equal(progress.done, true)
    assert.equal(progress.entries, moments.length)
    assert.equal(Object.keys(momentEntryIds).length, moments.length)
  })

  test('reports broken moments without losing the journey', async () => {
    const journalInput = { title: 'e2e broken moments', subtitle: 'e2e' }
    const first = await call('/import', { journal: journalInput, moments: [], offset: 0, total: 2, progress: { journeyId: null, next: 0, entries: 0, done: false } })
    recordRound(first)
    assert.ok(first.progress.journeyId)
    const result = await call('/import', { journal: journalInput, moments: [null, { id: 7, date: 'yesterday', title: 'No real date' }], offset: 0, total: 2, progress: first.progress })
    recordRound(result)
    assert.equal(result.error, undefined, result.error)
    assert.equal(result.progress.journeyId, first.progress.journeyId)
    assert.equal(result.errors.length, 2, JSON.stringify(result.errors))
    assert.match(result.errors[1], /No real date: has no date/)
    assert.deepEqual(result.created, {})
    assert.equal(result.progress.done, true)
  })

  test('fetches pictures from Journi and attaches them to their entry', async () => {
    const jobs = moments
      .flatMap((m) => m.pictures.map((p) => ({ entryId: momentEntryIds[m.id], guid: p.guid })))
      .slice(0, PICTURE_SAMPLE)
    for (const job of jobs) {
      const result = await call('/photo', { session, ...job })
      assert.equal(result.ok, true, `picture ${job.guid}: ${result.error}`)
      assert.ok(result.bytes > 0)
    }
  })

  test('refuses anything that is not a Journi picture id', async () => {
    const result = await call('/photo', { session, entryId: refs.find((r) => r.type === 'entry').id, guid: '../etc/passwd' })
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
