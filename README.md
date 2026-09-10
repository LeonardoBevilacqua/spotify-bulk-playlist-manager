# Spotify Bulk Playlist Manager

A tiny, local, no-framework web tool to **bulk-add songs to a Spotify playlist**:
paste a list of songs, search them all on Spotify, uncheck any wrong matches, pick
one of your playlists, and add them in one click.

> ⚠️ **Proof of concept, built with AI.** This is a personal, local-use PoC put
> together quickly with the help of an AI assistant. It is not production-hardened —
> minimal error handling, no tests, tokens kept in `localStorage`. Don't deploy it
> publicly as-is.

## What it does

1. Paste songs into a text box, one per line (free text, e.g. `Karma Police Radiohead`).
2. Searches every line on Spotify and shows the best match.
3. Uncheck any match that looks wrong to skip it.
4. Pick one of your playlists (only ones you can modify are listed).
5. Adds all kept matches to that playlist.

## Stack

- Plain `index.html` + `app.js`. No framework, no CSS, no backend, no build step.
- Spotify Web API with the **Authorization Code + PKCE** flow (no client secret).

## Quick start

1. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
   enable **Web API**, and add the redirect URI **exactly**: `http://127.0.0.1:8080/`.
   Copy the **Client ID**. (While in Development Mode, also add your Spotify account
   under **Settings → User Management**.)
2. From this folder, start a static server on port 8080:
   ```bash
   python3 -m http.server 8080 --bind 127.0.0.1
   ```
3. Open **http://127.0.0.1:8080/** (use `127.0.0.1`, not `localhost`).
4. On first load, paste your **Client ID** when prompted (stored in `localStorage`,
   never written to the source).
5. Click **Log in with Spotify**, approve, then paste songs → **Search** → review →
   pick a playlist → **Add**.

## Files

- `index.html` — the UI.
- `app.js` — auth, search, playlist loading, and adding.
- `DOCUMENTATION.md` — full build guide: endpoints, PKCE flow, code walkthrough,
  and gotchas.

## Notes / gotchas

- Redirect URI must match the dashboard **exactly**, trailing slash included, and
  use `127.0.0.1` (not `localhost`).
- Adding uses `POST /v1/playlists/{id}/items` — the legacy `/tracks` path returns 403.
- You can only add to playlists you **own** or that are **collaborative**.
- To change the stored Client ID: `localStorage.removeItem("client_id")` in the
  console, then reload.

See **`DOCUMENTATION.md`** for the complete step-by-step guide and troubleshooting.
