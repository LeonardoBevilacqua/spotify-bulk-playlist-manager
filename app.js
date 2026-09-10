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

  // Diagnostic: who owns this playlist vs who am I
  const me = await api("/me");
  const pl = await api(`/playlists/${playlistId}`);
  console.log("me.id:", me.id, "| type:", me.type, "| product:", me.product);
  console.log(
    "playlist:", pl.name,
    "| owner.id:", pl.owner?.id,
    "| owner.type:", pl.owner?.type,
    "| collaborative:", pl.collaborative,
    "| public:", pl.public
  );
  if (pl.owner?.id !== me.id && !pl.collaborative) {
    statusEl.textContent =
      `You cannot modify "${pl.name}" — owned by ${pl.owner?.id}, not you.`;
    return;
  }

  // Only kept (checked) results that actually matched
  const checked = [...document.querySelectorAll("#results input:checked")]
    .map((cb) => searchResults[Number(cb.dataset.i)])
    .filter((r) => r && r.track);
  const uris = checked.map((r) => r.track.uri);

  if (uris.length === 0) { statusEl.textContent = "Nothing selected."; return; }

  console.log("Adding URIs:", uris);

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
  console.log("Granted scopes:", localStorage.getItem("granted_scope"));
  document.getElementById("status").textContent = token ? "Logged in ✓" : "Not logged in";
  if (token) await loadPlaylists();
})();
