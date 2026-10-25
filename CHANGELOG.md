# Changelog

## 1.1.0

- The journey id reaches the page in its own first round and every entry is remembered as soon as it exists, so an undo after a failed or interrupted import removes everything that was created.
- Undo reports what it could not remove and offers a retry instead of claiming success.
- Picture downloads time out as a whole, including the body, and pictures keep their real file extension.
- The Journi session now stays alive while it is in use (one idle hour) and an expiry during an import is reported as such.
- Large journals no longer grow the request with every round.
- Fixed "journeies" in the undo confirmation, a lost stored session after a hiccup at page load, and the Enter key signing in twice.
- The release workflow refuses to run without the Journi secrets or from a branch other than main, keeps its own queue, and bumps the lockfile as well.

## 1.0.0

First release, forked out of the Journi path of [trip-importer](https://github.com/raduwolf12/trip-importer) and reduced to one job.

- Sign in to Journi inside the plugin and see every journal of the account, private ones included.
- Add a public journal by its link without signing in.
- Each selected journal becomes a TREK journey; each moment becomes an entry with its local date, title, story and position.
- Pictures are fetched from Journi on the server and attached to their entry.
- Undo removes the journeys an import created.
