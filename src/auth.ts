/**
 * Authorization Code + PKCE for Spotify, plus an on-disk token store.
 *
 * Why PKCE and not client-credentials: this server serves *your* listening
 * data, which client-credentials (app-only) tokens cannot see. Why PKCE and
 * not plain Authorization Code: PKCE needs no client secret, so nothing
 * confidential has to live in an MCP client config file.
 *
 * Why login is a separate CLI command (`npm run spotify:login`) rather than a
 * tool: the MCP server runs headless as a subprocess of the client, with stdout
 * reserved for JSON-RPC. It cannot open a browser and hold a consent
 * conversation. Auth happens once, out of band; the server only ever refreshes.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadDotEnv } from "./env.js";

export const TOKEN_DIR = path.join(homedir(), ".spotify-mcp");
export const TOKEN_PATH = path.join(TOKEN_DIR, "tokens.json");

/**
 * Loopback literal, not "localhost" - Spotify disallowed localhost hostnames
 * in February 2025. HTTP is permitted only for loopback IP literals.
 */
export const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const CALLBACK_PORT = 8888;

/** Read-only scopes. This server can observe your account; it cannot change it. */
export const SCOPES = [
  "user-top-read",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-read-currently-playing",
].join(" ");

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Absolute epoch ms when the access token stops being valid. */
  expires_at: number;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

export class AuthError extends Error {}

/**
 * The app's Client ID. Not a secret - PKCE exists precisely so no client
 * secret is needed, and nothing confidential has to sit in a config file.
 *
 * Resolution order: a real environment variable (what an MCP client config
 * sets) first, then a local .env as a development convenience.
 */
export function clientId(): string {
  if (!process.env.SPOTIFY_CLIENT_ID) loadDotEnv();

  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id) {
    throw new AuthError(
      "SPOTIFY_CLIENT_ID is not set. Create an app at " +
        "https://developer.spotify.com/dashboard, add the redirect URI " +
        `${REDIRECT_URI}, then either put SPOTIFY_CLIENT_ID=... in a .env ` +
        "file at the repo root or set it in your MCP client config.",
    );
  }
  return id;
}

/* ------------------------------- storage -------------------------------- */

export async function loadTokens(): Promise<StoredTokens> {
  let raw: string;
  try {
    raw = await readFile(TOKEN_PATH, "utf8");
  } catch {
    throw new AuthError(
      `Not authorized yet - no token file at ${TOKEN_PATH}. ` +
        "Run `npm run spotify:login` once to grant access.",
    );
  }
  return JSON.parse(raw) as StoredTokens;
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600); // enforce even if the file already existed
}

/* --------------------------------- PKCE --------------------------------- */

const base64url = (buf: Buffer) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/** 43-128 chars of unreserved characters; 64 random bytes gives 86. */
const makeVerifier = () => base64url(randomBytes(64));

const makeChallenge = (verifier: string) =>
  base64url(createHash("sha256").update(verifier).digest());

/* ------------------------------ token calls ----------------------------- */

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as {
        error?: string;
        error_description?: string;
      };
      detail = parsed.error_description ?? parsed.error ?? text;
    } catch {
      /* keep raw body */
    }
    throw new AuthError(`Spotify token endpoint ${res.status}: ${detail}`);
  }
  return JSON.parse(text) as TokenResponse;
}

const toStored = (r: TokenResponse, fallbackRefresh?: string): StoredTokens => ({
  access_token: r.access_token,
  // Spotify may or may not rotate the refresh token; keep the old one if not.
  refresh_token: r.refresh_token ?? fallbackRefresh ?? "",
  expires_at: Date.now() + r.expires_in * 1000,
  scope: r.scope,
});

export async function refreshTokens(current: StoredTokens): Promise<StoredTokens> {
  const refreshed = await tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
      client_id: clientId(),
    }),
  );
  const next = toStored(refreshed, current.refresh_token);
  await saveTokens(next);
  return next;
}

/* ------------------------------ login flow ------------------------------ */

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* fall back to the printed URL */
  }
}

const page = (title: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h1>${title}</h1><p>${message}</p></div>`;

/**
 * Run the one-time consent flow: spin a loopback listener, send the user to
 * Spotify, catch the redirect, exchange the code, persist the tokens.
 */
export async function login(): Promise<StoredTokens> {
  const id = clientId();
  const verifier = makeVerifier();
  const state = base64url(randomBytes(16));

  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    new URLSearchParams({
      client_id: id,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: makeChallenge(verifier),
      state,
      scope: SCOPES,
    });

  return new Promise<StoredTokens>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const finish = (code: number, title: string, msg: string) => {
        res.writeHead(code, { "Content-Type": "text/html" }).end(page(title, msg));
        server.close();
      };

      const error = url.searchParams.get("error");
      if (error) {
        finish(400, "Authorization denied", error);
        reject(new AuthError(`Spotify returned: ${error}`));
        return;
      }

      // Guards against a forged callback hitting the loopback listener.
      if (url.searchParams.get("state") !== state) {
        finish(400, "State mismatch", "The request was rejected.");
        reject(new AuthError("State mismatch - possible CSRF; aborted."));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        finish(400, "No code", "Spotify did not return an authorization code.");
        reject(new AuthError("No authorization code in callback."));
        return;
      }

      try {
        const tokens = toStored(
          await tokenRequest(
            new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: REDIRECT_URI,
              client_id: id,
              code_verifier: verifier,
            }),
          ),
        );
        await saveTokens(tokens);
        finish(200, "Authorized", "You can close this tab and return to the terminal.");
        resolve(tokens);
      } catch (err) {
        finish(500, "Token exchange failed", String(err));
        reject(err);
      }
    });

    server.on("error", reject);
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.error(`Listening on ${REDIRECT_URI}`);
      console.error(`Opening browser. If nothing happens, visit:\n${authUrl}\n`);
      openBrowser(authUrl.toString());
    });

    setTimeout(
      () => {
        server.close();
        reject(new AuthError("Timed out after 5 minutes waiting for consent."));
      },
      5 * 60 * 1000,
    ).unref();
  });
}
