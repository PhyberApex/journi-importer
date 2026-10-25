'use strict'
const crypto = require('node:crypto')
const { definePlugin } = require('trek-plugin-sdk')

const JOURNI_API_BASE = 'https://www.journiapp.com/api/v7.9/trip/url/'
const JOURNI_LOGIN_URL = 'https://www.journiapp.com/api/v8.0/user/login'
const JOURNI_PICTURE_BASE = 'https://www.journiapp.com/picture/'
const JOURNI_PICTURE_GUID = /^[A-Za-z0-9_=-]{8,120}$/
const JOURNI_USER_AGENT = 'TREK-journi-importer/1.0'
const JOURNI_SESSION_IDLE_MS = 60 * 60 * 1000
const JOURNI_SESSIONS_PER_USER = 5
const JOURNI_CATEGORY_NAMES = { 1: 'Accommodation', 2: 'Activity', 3: 'Nature', 4: 'Food', 6: 'Shopping', 7: 'Nightlife', 8: 'Culture & Art', 10: 'Worth Seeing', 11: 'Transport', 12: 'Coffee & Drinks', 13: 'Entertainment', 14: 'Architecture', 15: 'Relax' }
const JOURNI_SYSTEM_CATEGORY = { 100: 'stamp', 101: 'sticker', 102: 'flight', 103: 'weather' }

// TREK's browser bridge times a route call out at ~8s, so every long route here works in
// rounds: it does what fits in this budget and hands back a cursor the client resends.
const ROUND_BUDGET_MS = 6000
const PICTURE_MAX_BYTES = 10 * 1024 * 1024
const TITLE_MAX_CHARS = 500
const STORY_MAX_CHARS = 50000

const json = (obj) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function reporting(fn) {
  try { return await fn() } catch (e) {
    const cause = e?.cause?.message ? ' (' + e.cause.message + ')' : ''
    return { error: (e?.message || String(e)) + cause }
  }
}

// The signal stays attached to the response, so reading the body counts against the same limit.
const fetchWithTimeout = (url, init, ms) => fetch(url, { ...init, signal: AbortSignal.timeout(ms) })

// ── Journi sessions ──────────────────────────────────────────────────────────
// The `session` cookie Journi's login hands out lives only in this process, keyed by a random
// handle the client holds, bound to the TREK user who signed in and dropped an hour after its
// last use. The password is used for the one login call and never kept anywhere.
const journiSessions = new Map()

function pruneSessions(userId) {
  for (const [handle, s] of journiSessions) if (s.expires < Date.now()) journiSessions.delete(handle)
  const ofUser = [...journiSessions].filter(([, s]) => s.userId === userId).sort((a, b) => a[1].expires - b[1].expires)
  ofUser.slice(0, Math.max(0, ofUser.length - (JOURNI_SESSIONS_PER_USER - 1))).forEach(([handle]) => journiSessions.delete(handle))
}

function sessionFor(req) {
  const handle = String(req.body?.session || '')
  const found = handle && journiSessions.get(handle)
  if (!found) return null
  const expired = found.expires < Date.now()
  const otherUser = found.userId != null && req.user?.id != null && found.userId !== req.user.id
  if (expired || otherUser) { journiSessions.delete(handle); return null }
  found.expires = Date.now() + JOURNI_SESSION_IDLE_MS
  return found
}

const signedOutFor = (req, session) => !!req.body?.session && !session

function journiHeaders(session, extra) {
  return { 'User-Agent': JOURNI_USER_AGENT, ...(session ? { Cookie: 'session=' + session.cookie } : {}), ...(extra || {}) }
}

// CloudFront caches the trip endpoint for an hour without keying on the cookie, so a signed-in
// fetch of a journal someone already fetched anonymously would get the header-only answer.
// A unique query string forces the request to the origin.
const journiTripUrl = (slug) => JOURNI_API_BASE + encodeURIComponent(slug) + '/entries/0?nocache=' + crypto.randomUUID()

const journiPictureUrl = (guid) => JOURNI_PICTURE_BASE + encodeURIComponent(guid) + '_mob_full.jpg'

const PICTURE_EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/heic': '.heic' }
const pictureExtension = (contentType) => PICTURE_EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()] || '.jpg'

function journiSlugFromUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  let slug = raw
  try {
    const u = new URL(raw)
    if (!/(^|\.)journiapp\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/(?:app\/j|trip|api\/v[\d.]+\/trip\/url)\/([^/]+)/)
    slug = m ? decodeURIComponent(m[1]) : null
  } catch (_notAUrl) {}
  return slug && /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(slug) ? slug : null
}

// ── Journi → moments ─────────────────────────────────────────────────────────
// Journi's trip endpoint answers with the trip header and, when the caller may see it, every
// entry of the journal newest-first. `comment` is "headline\nstory"; lat/lng 0,0 means no
// location; categories 100-103 are system entries whose comment is JSON.

function journalSummary(t) {
  return {
    id: t.id, url: t.url, title: t.title, isPublic: !!t.isPublic,
    entryCount: t.entryCount ?? null, pictureCount: t.pictureCount ?? null,
    start: t.start ?? null, end: t.end ?? null,
  }
}

// Journi stores a moment's instant as epoch ms plus the IANA zone it was written in; the
// journal date is the local date in that zone.
function localDateTime(ms, timezone) {
  const d = new Date(ms)
  if (isNaN(d)) return { date: null, time: null }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]))
    if (v.year && v.month && v.day) return { date: `${v.year}-${v.month}-${v.day}`, time: `${(v.hour || '00').replace(/^24$/, '00')}:${v.minute || '00'}` }
  } catch (_unknownZone) {}
  const iso = d.toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

function validCoords(lat, lng) {
  const a = Number(lat), b = Number(lng)
  if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null
  if (a === 0 && b === 0) return null
  return { lat: a, lng: b }
}

function medianPoint(points) {
  const mid = (values) => { const s = [...values].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  return { lat: mid(points.map((p) => p.lat)), lng: mid(points.map((p) => p.lng)) }
}

function parseSystemComment(comment) {
  try { const o = JSON.parse(comment); return o && typeof o === 'object' ? o : null } catch (_notJson) { return null }
}

function momentFromEntry(entry) {
  const kind = JOURNI_SYSTEM_CATEGORY[entry.categoryId]
  if (kind === 'stamp' || kind === 'sticker' || kind === 'weather') return null
  const when = localDateTime(Number(entry.create), entry.timezone)
  let title = null, story = ''
  if (kind === 'flight') {
    const fl = parseSystemComment(entry.comment) || {}
    if (!fl.fromCode && !fl.toCode) return null
    title = `Flight ${fl.fromCode || '?'} → ${fl.toCode || '?'}`
    if (fl.fromName || fl.toName) story = `${fl.fromName || fl.fromCode || '?'} → ${fl.toName || fl.toCode || '?'}`
  } else {
    const comment = String(entry.comment || '').replace(/\r\n?/g, '\n')
    const firstBreak = comment.indexOf('\n')
    title = (firstBreak < 0 ? comment : comment.slice(0, firstBreak)).trim() || JOURNI_CATEGORY_NAMES[entry.categoryId] || null
    story = (firstBreak < 0 ? '' : comment.slice(firstBreak + 1)).trim()
  }
  const pictures = (Array.isArray(entry.pictures) ? entry.pictures : []).filter((p) => p && JOURNI_PICTURE_GUID.test(String(p.guid)))
  const picturePoints = pictures.map((p) => validCoords(p.lat, p.lng)).filter(Boolean)
  const coords = validCoords(entry.lat, entry.lng) || (picturePoints.length ? medianPoint(picturePoints) : null)
  return {
    id: entry.id,
    title,
    story,
    date: when.date,
    time: when.time,
    lat: coords ? coords.lat : null,
    lng: coords ? coords.lng : null,
    pictures: pictures.map((p) => ({ guid: String(p.guid) })),
    sortKey: Number(entry.create) || 0,
  }
}

function momentsFromEntries(entries) {
  return entries
    .filter((e) => e && !e.deleted)
    .map(momentFromEntry)
    .filter(Boolean)
    .sort((a, b) => a.sortKey - b.sortKey)
}

const idOf = (res) => res?.id ?? res?.data?.id ?? null

const clip = (value, max) => String(value ?? '').slice(0, max)

const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

function entryInput(journalTitle, moment) {
  if (!moment || typeof moment !== 'object') throw new Error('not a moment')
  if (!isDate(moment.date)) throw new Error('has no date')
  const coords = validCoords(moment.lat, moment.lng)
  const title = clip(moment.title, TITLE_MAX_CHARS).trim() || journalTitle
  return {
    entry_date: moment.date,
    title,
    story: clip(moment.story, STORY_MAX_CHARS),
    ...(coords ? { location_name: title, location_lat: coords.lat, location_lng: coords.lng } : {}),
  }
}

const momentLabel = (moment, position) => clip(moment?.title, 80).trim() || 'Moment ' + (position + 1)

module.exports = definePlugin({
  async onLoad(ctx) { ctx.log.info('journi-importer loaded') },
  routes: [
    {
      method: 'POST', path: '/login', auth: true,
      async handler(req) {
        const email = String(req.body?.email || '').trim()
        const password = String(req.body?.password || '')
        if (!email || !password) return json({ error: 'Enter your Journi email and password' })
        return json(await reporting(async () => {
          const res = await fetchWithTimeout(JOURNI_LOGIN_URL, {
            method: 'POST',
            headers: journiHeaders(null, { 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json' }),
            body: JSON.stringify({ email, password }),
          }, 8000)
          if (res.status === 400 || res.status === 401) return { error: 'Journi did not accept that login: ' + ((await res.text()) || 'wrong email or password').trim().slice(0, 200) }
          if (!res.ok) return { error: 'Journi answered HTTP ' + res.status + ' to the login' }
          const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || '']
          const cookie = setCookies.map((c) => (c.match(/^session=([^;]+)/) || [])[1]).find(Boolean)
          if (!cookie) return { error: 'Journi signed in but sent no session cookie — its login may have changed' }
          const profile = await res.json().catch(() => null)
          const journals = (Array.isArray(profile?.trips) ? profile.trips : []).filter((t) => t && !t.deleted && t.url).map(journalSummary)
          const handle = crypto.randomUUID() + crypto.randomUUID()
          pruneSessions(req.user?.id ?? null)
          journiSessions.set(handle, { cookie, userId: req.user?.id ?? null, expires: Date.now() + JOURNI_SESSION_IDLE_MS, firstName: profile?.firstName || null, journals })
          return { ok: true, session: handle, firstName: profile?.firstName || null, journals }
        }))
      },
    },
    {
      method: 'POST', path: '/session', auth: true,
      async handler(req) {
        const session = sessionFor(req)
        if (!session) return json({ signedIn: false })
        return json({ signedIn: true, firstName: session.firstName, journals: session.journals })
      },
    },
    {
      method: 'POST', path: '/logout', auth: true,
      async handler(req) {
        const handle = String(req.body?.session || '')
        if (sessionFor(req)) journiSessions.delete(handle)
        return json({ ok: true })
      },
    },

    // A journal fetched through Journi's own web API, already reduced to the moments the
    // import creates. Without the owner's session a private journal answers 410 (sometimes
    // with the header only and no entries); both are reported as private:true.
    {
      method: 'POST', path: '/journal', auth: true,
      async handler(req) {
        const slug = journiSlugFromUrl(req.body?.url)
        if (!slug) return json({ error: 'That doesn\'t look like a Journi journal link — expected something like https://www.journiapp.com/app/j/my-journal' })
        const session = sessionFor(req)
        const signedOut = signedOutFor(req, session)
        return json(await reporting(async () => {
          const res = await fetchWithTimeout(journiTripUrl(slug), { headers: journiHeaders(session, { Accept: 'application/json' }) }, 6000)
          if (res.status === 404) return { error: 'Journi has no journal at "' + slug + '" — check the link' }
          if ([401, 403, 410].includes(res.status)) return { journal: { url: slug, title: null }, moments: [], private: true, signedOut }
          if (!res.ok) return { error: 'Journi answered HTTP ' + res.status }
          const data = await res.json()
          if (!data?.trip || typeof data.trip !== 'object') return { error: 'Journi returned no journal for that link' }
          const isPrivate = !Array.isArray(data.entries)
          return {
            journal: journalSummary(data.trip),
            moments: isPrivate ? [] : momentsFromEntries(data.entries),
            private: isPrivate,
            signedOut,
          }
        }))
      },
    },

    // The first round only creates the journey, so its id reaches the client before anything
    // else can go wrong. Every later round creates one entry per moment of the window the
    // client sent (starting at progress.next) until the round budget runs out, and answers with
    // the entry ids of that round in `created` so the client can attach pictures and undo.
    // Whatever fails, the answer carries `progress`, so the client never loses the journey id.
    {
      method: 'POST', path: '/import', auth: true,
      async handler(req, ctx) {
        const journal = req.body?.journal && typeof req.body.journal === 'object' ? req.body.journal : {}
        const moments = Array.isArray(req.body?.moments) ? req.body.moments : []
        const offset = Math.max(0, Math.trunc(Number(req.body?.offset)) || 0)
        const total = Math.max(offset + moments.length, Math.trunc(Number(req.body?.total)) || 0)
        const title = clip(journal.title, TITLE_MAX_CHARS).trim() || 'Journi journal'
        const subtitle = clip(journal.subtitle, TITLE_MAX_CHARS).trim() || undefined
        const given = req.body?.progress && typeof req.body.progress === 'object' ? req.body.progress : {}
        const progress = { journeyId: given.journeyId ?? null, next: Math.max(0, Math.trunc(Number(given.next)) || 0), entries: Math.max(0, Math.trunc(Number(given.entries)) || 0), done: false }
        const created = {}
        const errors = []
        try {
          const deadline = Date.now() + ROUND_BUDGET_MS
          if (!progress.journeyId) {
            progress.journeyId = idOf(await ctx.journal.createJourney({ title, subtitle }))
            if (!progress.journeyId) return json({ error: 'TREK created no journey for "' + title + '"', progress })
            return json({ ok: true, progress, created, errors })
          }
          let i = Math.max(progress.next, offset)
          for (; i < offset + moments.length && Date.now() < deadline; i++) {
            const moment = moments[i - offset]
            try {
              const entryId = idOf(await ctx.journal.createEntry(progress.journeyId, entryInput(title, moment)))
              progress.entries++
              if (entryId && moment.id != null) created[moment.id] = entryId
            } catch (e) { errors.push(momentLabel(moment, i) + ': ' + e.message) }
            await sleep(60)
          }
          progress.next = i
          progress.done = i >= total
          return json({ ok: true, progress, created, errors })
        } catch (e) {
          return json({ error: e?.message || String(e), progress, created, errors })
        }
      },
    },

    // One picture per call: fetched from Journi here (the iframe can't reach journiapp.com and
    // the bytes must not pass through the plugin-route body ceiling) and attached straight into
    // the entry's gallery. Only a Journi picture guid is accepted, so this can't proxy anything else.
    {
      method: 'POST', path: '/photo', auth: true,
      async handler(req, ctx) {
        const guid = String(req.body?.guid || '')
        const entryId = Number(req.body?.entryId)
        if (!JOURNI_PICTURE_GUID.test(guid)) return json({ error: 'Not a Journi picture id' })
        if (!entryId) return json({ error: 'entryId required' })
        const session = sessionFor(req)
        const signedOut = signedOutFor(req, session)
        if (signedOut) return json({ error: 'Your Journi session has expired', signedOut })
        return json(await reporting(async () => {
          const res = await fetchWithTimeout(journiPictureUrl(guid), { headers: journiHeaders(session) }, 6000)
          if (!res.ok) return { error: 'Journi answered HTTP ' + res.status + ' for the picture', status: res.status }
          const contentType = res.headers.get('content-type') || 'image/jpeg'
          if (!/^image\//.test(contentType)) return { error: 'Journi returned ' + contentType + ' instead of an image', status: res.status }
          if (Number(res.headers.get('content-length')) > PICTURE_MAX_BYTES) return { error: 'Picture too large' }
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length > PICTURE_MAX_BYTES) return { error: 'Picture too large' }
          const extension = pictureExtension(contentType)
          const added = await ctx.journal.addEntryPhoto(entryId, { name: guid + extension, content_base64: buf.toString('base64') })
          return { ok: true, photoId: idOf(added), bytes: buf.length }
        }))
      },
    },

    {
      method: 'POST', path: '/undo', auth: true,
      async handler(req, ctx) {
        const refs = Array.isArray(req.body?.refs) ? req.body.refs : []
        return json(await reporting(async () => {
          const deadline = Date.now() + ROUND_BUDGET_MS
          const errors = []
          let i = 0
          for (; i < refs.length && Date.now() < deadline; i++) {
            const ref = refs[i] && typeof refs[i] === 'object' ? refs[i] : {}
            try {
              if (ref.type === 'entry') await ctx.journal.deleteEntry(Number(ref.id))
              else if (ref.type === 'journey') await ctx.journal.deleteJourney(Number(ref.id))
              else throw new Error('unknown ref')
            } catch (e) { errors.push(ref.type + ' ' + ref.id + ': ' + e.message) }
          }
          return { deleted: i - errors.length, remaining: refs.slice(i), errors, done: i >= refs.length }
        }))
      },
    },
  ],
})
