# CLAUDE.md

A TREK `page` plugin that imports Journi journals as TREK journeys and nothing else. Forked from the Journi path of raduwolf12/trip-importer; the trip, place, booking and cost machinery was deliberately dropped.

## Layout

- `server/index.js` — the whole backend: Journi login/session handling, the journal fetch with the Journi-to-moment reduction, the round-based `/import`, `/photo`, `/undo`. No local requires.
- `client/index.html` — the whole UI. `<!-- trek:ui -->` pulls in the SDK design kit (`window.trek`, `.trek-*` classes) at dev/pack time; the file itself stays a plain page with one inline script. Modern JS is fine, the frame runs in the user's current browser.
- `test/e2e/import.test.js` — `node:test` suite that spawns the dev host and drives the routes against the real Journi account from `JOURNI_EMAIL` / `JOURNI_PASSWORD` (skipped when unset): login, journal fetch, import, pictures, undo. `.github/workflows/e2e.yml` runs it on push, pull request and a weekly cron with the repository secrets. It needs a Journi account with at least one journal that has moments and pictures.
- No build step. `npx trek-plugin-sdk dev` serves the UI at `/preview` with routes proxied under `/api/<path>`; `pack` builds `plugin.zip`.

## Journi facts the code relies on

- Journal: `GET https://www.journiapp.com/api/v7.9/trip/url/<slug>/entries/0` returns `{trip, entries}` with every entry in one page. Without a session that only works for a public journal; a private one answers with `trip` but no `entries`.
- Login: `POST https://www.journiapp.com/api/v8.0/user/login` with JSON `{email,password}`, 200 + profile (`trips[]`, `firstName`) + `Set-Cookie: session=…`, 400 plain text on a wrong password. No CSRF, 2FA or bearer token.
- CloudFront caches the journal endpoint for an hour and ignores the cookie, hence the random `nocache` query in `journiTripUrl()`.
- Pictures: `https://www.journiapp.com/picture/<guid>_mob_full.jpg`, 403 for a private journal unless the owner's cookie is sent. They carry no EXIF.
- Entry `create` is epoch ms, `timezone` is IANA; the entry date is the local date in that zone. `lat/lng` 0,0 means no position. `comment` is `headline\nstory`. Categories 100–103 are system cards (stamp, sticker, flight, weather); only flights are kept.

## Host constraints

- The browser bridge times a route call out at about 8 seconds, so `/import` and `/undo` work in rounds against a 6 second budget and return a cursor the client resends. Plugin route bodies are capped at about 100 KB, so the client windows moments by count and by serialized size.
- `ctx.journal.createJourney` needs no trip. `addEntryPhoto` takes base64 bytes, images only, 10 MB max.
- Sessions live in a `Map` in the plugin process; a host restart forgets them, which the client handles by clearing its stored handle when `/session` says `signedIn:false`.

## Style

Self-documenting code, comments only where the why is not obvious, functional style on the client.
