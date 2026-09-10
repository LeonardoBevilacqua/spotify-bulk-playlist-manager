# Spotify Bulk Playlist Manager — Build Guide

A step-by-step guide to build a **simple, local, single-page tool** that:

1. Lets you paste a list of songs (one per line) into a text field.
2. Searches every line on Spotify and shows the best match.
3. Lets you exclude any match that looks wrong.
4. Lists all your Spotify playlists in a select box.
5. Adds all the kept matches to the chosen playlist with one click.

**Constraints for this build:** no framework, no CSS, no backend. Just two files
(`index.html` + `app.js`) served from a local static server, for personal use.

> **Proof of concept:** this tool was built quickly with the help of AI as a
> personal, local-use PoC. It is not production-hardened — expect rough edges,
> minimal error handling, and no tests. Don't deploy it publicly as-is.

> Note: the live Spotify docs (https://developer.spotify.com/documentation/web-api)
> could not be fetched from the environment this guide was written in, so the
> endpoint details below come from working knowledge of the Web API, verified
> against a real run. One correction found during testing: adding items uses
> `POST /v1/playlists/{id}/items` (the older `/tracks` path returns 403). Always
> cross-check against the official reference if anything behaves unexpectedly.

---

## 0. How the pieces fit together

```
Browser (index.html + app.js)
   │
   │  1. Authorization Code + PKCE  ──►  accounts.spotify.com/authorize
   │  2. Exchange code for token    ──►  accounts.spotify.com/api/token
   │
   │  3. Search tracks              ──►  api.spotify.com/v1/search
   │  4. List your playlists        ──►  api.spotify.com/v1/me/playlists
   │  5. Add tracks to a playlist   ──►  api.spotify.com/v1/playlists/{id}/items
```

Because there is **no backend**, we use the **Authorization Code flow with PKCE**.
PKCE lets a public client (a browser app) authenticate **without a client secret**,
which is exactly right for a local personal tool.

---

## 1. Prerequisites

- A Spotify account (free works for the API; Premium not required).
- Python 3 installed (used only as a zero-config local static server). Any static
  server works — VS Code "Live Server", `npx serve`, etc.

---

## 2. Register a Spotify application

1. Go to the **Spotify Developer Dashboard**: https://developer.spotify.com/dashboard
2. Log in and click **Create app**.
3. Fill in:
   - **App name / description**: anything (e.g. "Bulk Playlist Manager").
   - **Redirect URI**: `http://127.0.0.1:8080/` — **this must match exactly** what
     the app uses later.
     - Important: Spotify requires HTTPS for redirect URIs **except** for the
       loopback address. Use the literal IPv4 loopback **`127.0.0.1`**, not
       `localhost` (recent Spotify rules reject `localhost`).
   - **Which API/SDKs**: check **Web API**.
4. Save. Open the app's **Settings** and copy the **Client ID**. You do **not**
   need the client secret for PKCE.

Keep the Client ID handy — the app prompts for it on first load (step 6) and stores
it in your browser's `localStorage`; it is **not** written into the source.

---

## 3. Scopes we need

The app requests these OAuth scopes at login:

| Scope | Why |
|---|---|
| `playlist-read-private` | List your private playlists in the select box |
| `playlist-modify-public` | Add tracks to your public playlists |
| `playlist-modify-private` | Add tracks to your private playlists |

Reading public playlists needs no scope, but reading the full list of *your*
playlists (including private) needs `playlist-read-private`.

> You can only add tracks to playlists you **own** or that are **collaborative**.
> `GET /me/playlists` also returns playlists you merely follow (and even
> Spotify-generated ones); adding to those fails with a 403. The app therefore
> fetches your user id via `GET /me` and filters the select box to only playlists
> where `owner.id` matches you (or `collaborative` is true). See step 8.

---

## 4. The Spotify endpoints used

### 4.1 Authorize (PKCE) — redirect the browser here
```
GET https://accounts.spotify.com/authorize
  ?client_id=<CLIENT_ID>
  &response_type=code
  &redirect_uri=http://127.0.0.1:8080/
  &code_challenge_method=S256
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &scope=playlist-read-private playlist-modify-public playlist-modify-private
  &state=<random>
```
Spotify redirects back to the redirect URI with `?code=...&state=...`.

### 4.2 Exchange authorization code for tokens
```
POST https://accounts.spotify.com/api/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code from redirect>
&redirect_uri=http://127.0.0.1:8080/
&client_id=<CLIENT_ID>
&code_verifier=<original code_verifier>
```
Response (JSON): `access_token`, `token_type`, `expires_in` (usually 3600),
`refresh_token`, `scope`.

### 4.3 Refresh the access token (when it expires)
```
POST https://accounts.spotify.com/api/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<refresh_token>
&client_id=<CLIENT_ID>
```

### 4.4 Search for a track
```
GET https://api.spotify.com/v1/search?q=<query>&type=track&limit=5
Authorization: Bearer <access_token>
```
Response: `tracks.items[]`, each item has `id`, `name`, `uri`
(`spotify:track:...`), `artists[].name`, `album.name`.

Since we chose **free-text** lines, each line is sent to `q` as-is
(URL-encoded). We take the first item as the "best match".

### 4.5 Get the current user's playlists (paginated)
```
GET https://api.spotify.com/v1/me/playlists?limit=50&offset=0
Authorization: Bearer <access_token>
```
Response: `items[]` (each with `id`, `name`, `owner.id`, `tracks.total`),
`next` (URL of next page or `null`). Loop until `next` is `null`.

### 4.6 Add tracks to a playlist (max 100 per request)
```
POST https://api.spotify.com/v1/playlists/<playlist_id>/items
Authorization: Bearer <access_token>
Content-Type: application/json

{ "uris": ["spotify:track:...", "spotify:track:..."], "position": 0 }
```
Response: `{ "snapshot_id": "..." }`. Send in **batches of ≤100 URIs**. `position`
is optional (omit to append to the end).

> The older `POST /v1/playlists/{id}/tracks` path returns **403 Forbidden** even
> for your own playlist with the correct scopes. Use `/items`.

---

## 5. Project files

Create a folder with two files.

### 5.1 `index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Spotify Bulk Playlist Manager</title>
</head>
<body>
  <h1>Spotify Bulk Playlist Manager</h1>

  <!-- Login / auth status -->
  <p><button id="login">Log in with Spotify</button> <span id="status"></span></p>

  <!-- Step 1: paste songs -->
  <h2>1. Paste songs (one per line)</h2>
  <textarea id="songs" rows="12" cols="60"
    placeholder="Karma Police Radiohead&#10;Bohemian Rhapsody Queen"></textarea>
  <br />
  <button id="search">Search all songs</button>

  <!-- Step 2: review results -->
  <h2>2. Review matches</h2>
  <p><em>Uncheck any match that looks wrong; it will be skipped.</em></p>
  <div id="results"></div>

  <!-- Step 3: choose playlist and add -->
  <h2>3. Add to playlist</h2>
  <select id="playlists"></select>
  <button id="add">Add selected songs to playlist</button>
  <p id="add-status"></p>

  <script src="app.js"></script>
</body>
</html>
```

### 5.2 `app.js`
```js
// ====== CONFIG ======
// Client ID is not hardcoded. It's stored in localStorage; you're prompted once.
function getClientId() {
  let id = localStorage.getItem("client_id");
  if (!id) {
    id = (window.prompt("Enter your Spotify Client ID:") || "").trim();
    if (id) localStorage.setItem("client_id", id);
  }
  return id;
}
const CLIENT_ID = getClientId();
const REDIRECT_URI = "http://127.0.0.1:8080/"; // must match the dashboard exactly
const SCOPES = "playlist-read-private playlist-modify-public playlist-modify-private";

// ====== PKCE HELPERS ======
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return crypto.subtle.digest("SHA-256", data);
}

// ====== TOKEN STORAGE ======
// Tokens live in localStorage. Fine for a personal local tool; do not ship this.
function saveTokens(t) {
  localStorage.setItem("access_token", t.access_token);
  if (t.refresh_token) localStorage.setItem("refresh_token", t.refresh_token);
  if (t.scope !== undefined) localStorage.setItem("granted_scope", t.scope);
  localStorage.setItem("expires_at", Date.now() + t.expires_in * 1000);
}

// Call from the console to switch accounts / force a fresh consent.
function logout() {
  const clientId = localStorage.getItem("client_id");
  localStorage.clear();
  if (clientId) localStorage.setItem("client_id", clientId); // keep the Client ID
  location.href = REDIRECT_URI;
}

async function getAccessToken() {
  const token = localStorage.getItem("access_token");
  const expiresAt = Number(localStorage.getItem("expires_at") || 0);
  if (token && Date.now() < expiresAt - 60_000) return token; // still valid
  const refresh = localStorage.getItem("refresh_token");
  if (refresh) return await refreshToken(refresh);
  return null;
}

// ====== AUTH: STEP A — redirect to Spotify ======
async function login() {
  const verifier = randomString(64);
  const challenge = base64url(await sha256(verifier));
  const state = randomString(16);
  localStorage.setItem("code_verifier", verifier);
  localStorage.setItem("auth_state", state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
    state,
  });
  window.location = `https://accounts.spotify.com/authorize?${params}`;
}

// ====== AUTH: STEP B — handle the redirect back ======
async function handleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return;
  if (params.get("state") !== localStorage.getItem("auth_state")) {
    alert("State mismatch — aborting for safety.");
    return;
  }
  const verifier = localStorage.getItem("code_verifier");

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const data = await res.json();
  if (data.access_token) saveTokens(data);
  // Clean the ?code=... out of the URL bar
  window.history.replaceState({}, document.title, REDIRECT_URI);
}

async function refreshToken(refresh) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }),
  });
  const data = await res.json();
  if (data.access_token) {
    saveTokens(data);
    return data.access_token;
  }
  return null;
}

// ====== API HELPER ======
async function api(path, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error("Not logged in");
  const res = await fetch(
    path.startsWith("http") ? path : `https://api.spotify.com/v1${path}`,
    { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } }
  );
  if (res.status === 429) {
    // Rate limited: wait Retry-After seconds, then retry once
    const wait = Number(res.headers.get("Retry-After") || 1);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    return api(path, options);
  }
  if (!res.ok) throw new Error(`Spotify API ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ====== FEATURE: SEARCH ALL SONGS ======
let searchResults = []; // [{ line, track }]

async function searchAll() {
  const lines = document.getElementById("songs").value
    .split("\n").map((l) => l.trim()).filter(Boolean);

  searchResults = [];
  const resultsEl = document.getElementById("results");
  resultsEl.innerHTML = "Searching…";

  for (const line of lines) {
    const q = encodeURIComponent(line);
    const data = await api(`/search?q=${q}&type=track&limit=1`);
    const track = data.tracks.items[0] || null;
    searchResults.push({ line, track });
  }
  renderResults();
}

function renderResults() {
  const el = document.getElementById("results");
  el.innerHTML = "";
  searchResults.forEach((r, i) => {
    const row = document.createElement("div");
    if (r.track) {
      const artists = r.track.artists.map((a) => a.name).join(", ");
      row.innerHTML =
        `<label><input type="checkbox" data-i="${i}" checked> ` +
        `<b>${r.track.name}</b> — ${artists} ` +
        `<small>(${r.track.album.name})</small></label> ` +
        `<small style="color:#888"> [searched: "${r.line}"]</small>`;
    } else {
      row.innerHTML = `<span style="color:red">No match for "${r.line}"</span>`;
    }
    el.appendChild(row);
  });
}

// ====== FEATURE: LOAD PLAYLISTS ======
let currentUserId = null;

async function loadPlaylists() {
  if (!currentUserId) currentUserId = (await api("/me")).id;
  const select = document.getElementById("playlists");
  select.innerHTML = "";
  let url = "/me/playlists?limit=50";
  while (url) {
    const data = await api(url);
    for (const pl of data.items) {
      if (!pl || !pl.id) continue; // Spotify can return null/partial items
      // You can only add to playlists you own or that are collaborative
      const canModify = pl.owner?.id === currentUserId || pl.collaborative;
      if (!canModify) continue;
      const opt = document.createElement("option");
      opt.value = pl.id;
      const total = pl.tracks?.total ?? "?";
      opt.textContent = `${pl.name} (${total} tracks)`;
      select.appendChild(opt);
    }
    url = data.next; // full URL or null
  }
}

// ====== FEATURE: ADD SELECTED TO PLAYLIST ======
async function addToPlaylist() {
  const playlistId = document.getElementById("playlists").value;
  const statusEl = document.getElementById("add-status");
  if (!playlistId) { statusEl.textContent = "Pick a playlist first."; return; }

  // Only kept (checked) results that actually matched
  const checked = [...document.querySelectorAll("#results input:checked")]
    .map((cb) => searchResults[Number(cb.dataset.i)])
    .filter((r) => r && r.track);
  const uris = checked.map((r) => r.track.uri);

  if (uris.length === 0) { statusEl.textContent = "Nothing selected."; return; }

  // Spotify accepts max 100 URIs per request
  for (let i = 0; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    await api(`/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uris: batch }),
    });
  }
  statusEl.textContent = `Added ${uris.length} track(s).`;
  await loadPlaylists(); // refresh counts
}

// ====== WIRE UP UI ======
document.getElementById("login").onclick = login;
document.getElementById("search").onclick = searchAll;
document.getElementById("add").onclick = addToPlaylist;

(async function init() {
  await handleRedirect();
  const token = await getAccessToken();
  document.getElementById("status").textContent = token ? "Logged in ✓" : "Not logged in";
  if (token) await loadPlaylists();
})();
```

---

## 6. Run it locally

1. From the project folder, start a static server **on port 8080** (must match the
   redirect URI):
   ```bash
   python3 -m http.server 8080 --bind 127.0.0.1
   ```
2. Open **http://127.0.0.1:8080/** in your browser (use `127.0.0.1`, not `localhost`).
3. On first load the app prompts for your **Client ID** — paste it in. It's stored
   in `localStorage` and never written to the source.
4. Click **Log in with Spotify**, approve the scopes. You'll be redirected back and
   see "Logged in ✓" and your playlists in the select box.

---

## 7. Use it

1. Paste songs into the text field, one per line (free text, e.g.
   `Karma Police Radiohead`).
2. Click **Search all songs**. Each line's best match appears with a checkbox.
3. Uncheck any wrong matches.
4. Pick a playlist and click **Add selected songs to playlist**.

---

## 8. Gotchas & notes

- **`localhost` vs `127.0.0.1`**: they are different origins to Spotify. Use
  `127.0.0.1` everywhere (dashboard redirect URI, server bind, browser URL).
- **Redirect URI must match exactly**, including the trailing `/` and the port.
  A mismatch gives `INVALID_CLIENT: Invalid redirect URI` / "Not matching
  configuration" at login.
- **Use `/items`, not `/tracks`**: `POST /v1/playlists/{id}/items` is the working
  add endpoint. The legacy `/tracks` path returns a bare **403 Forbidden** even
  for your own playlist with valid scopes — the most confusing failure to debug.
- **403 when adding to a playlist you don't own**: you can only add to playlists
  you **own** or that are **collaborative**. `loadPlaylists()` filters these out by
  comparing `pl.owner.id` to your id from `GET /v1/me`.
- **Development Mode**: a new app starts in Development Mode. Only Spotify accounts
  you add under **Settings → User Management** (name + the account's email) can log
  in and call the API. Add your own account there.
- **Stale scopes**: refreshing a token keeps the *original* scopes. If you change
  `SCOPES`, run `logout()` in the console (clears localStorage) and log in again so
  a fresh token is minted. Check the granted scopes via
  `localStorage.getItem("granted_scope")`.
- **Token expiry**: access tokens last ~1 hour. The code refreshes automatically
  using the stored refresh token.
- **Rate limiting (429)**: the `api()` helper waits for `Retry-After` and retries
  once. Searching hundreds of lines fires many requests; consider adding a small
  delay between searches if you hit limits often.
- **Match quality**: free-text search takes the top result, which is usually right
  but not always — that's what the exclude checkboxes are for. For better precision
  you could later switch to field filters (`q=track:NAME artist:ARTIST`).
- **Security**: tokens sit in `localStorage`. Acceptable for a personal, local-only
  tool; do not deploy this publicly as-is.
- **Client ID storage**: the Client ID lives in `localStorage` (`client_id`), not in
  the source. To change it, run `localStorage.removeItem("client_id")` in the
  console and reload. `logout()` intentionally preserves it.
- **Duplicates**: adding runs every time you click; Spotify allows duplicate tracks
  in a playlist, so avoid clicking twice.

---

## 9. Optional next steps

- Show the top 3 matches per line and let you pick the correct one.
- Cache search results so re-runs are faster.
- Add a "copy failed lines" button for songs with no match.
- Add a logout button in the UI (the `logout()` helper already exists).
```
