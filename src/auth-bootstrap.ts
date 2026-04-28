/**
 * One-time interactive script to obtain a Spotify refresh token via OAuth.
 * Run with: pnpm bootstrap
 * Prints the refresh token to stdout for use as a GitHub Actions secret.
 */

import 'dotenv/config';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-library-read playlist-read-private playlist-modify-private playlist-modify-public ugc-image-upload';

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log('Could not auto-open browser. Please visit this URL manually:');
    console.log(url);
  });
  child.unref();
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<{ refresh_token: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (typeof data.refresh_token !== 'string') {
    throw new Error('Token response did not contain a refresh_token');
  }

  return { refresh_token: data.refresh_token };
}

function waitForCallback(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:8888`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error !== null) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Authorization denied: ${error}</h2><p>Return to your terminal.</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      const state = url.searchParams.get('state');
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>State mismatch — possible CSRF attack.</h2><p>Return to your terminal.</p></body></html>`);
        server.close();
        reject(new Error('State parameter mismatch'));
        return;
      }

      const code = url.searchParams.get('code');
      if (code === null) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>No code returned by Spotify.</h2><p>Return to your terminal.</p></body></html>`);
        server.close();
        reject(new Error('No authorization code received'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        `<html><body style="font-family:sans-serif;padding:2rem;">` +
          `<h2>Done ✓</h2>` +
          `<p>Return to your terminal — your refresh token has been printed there.</p>` +
          `</body></html>`,
      );

      server.close();
      resolve(code);
    });

    server.on('error', (err) => {
      reject(new Error(`Local server error: ${err.message}`));
    });

    server.listen(8888, '127.0.0.1');
  });
}

export async function runBootstrap(): Promise<{ refreshToken: string }> {
  const clientId = process.env['SPOTIFY_CLIENT_ID'];
  const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];

  if (!clientId || !clientSecret) {
    console.error(
      'Error: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set.\n' +
        'Copy .env.example to .env, fill in the values, and re-run:\n' +
        '  cp .env.example .env && pnpm bootstrap',
    );
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString('hex');

  const authUrl =
    `https://accounts.spotify.com/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${state}`;

  console.log('Opening Spotify authorization page in your browser…');
  console.log(`\nIf the browser does not open, visit:\n  ${authUrl}\n`);
  console.log('Waiting for Spotify callback on http://127.0.0.1:8888/callback …');

  openBrowser(authUrl);

  const code = await waitForCallback(state);

  console.log('\nReceived authorization code. Exchanging for tokens…');

  const { refresh_token } = await exchangeCodeForTokens(code, clientId, clientSecret);

  const bar = '━'.repeat(52);
  console.log(`\n${bar}`);
  console.log(' SPOTIFY_REFRESH_TOKEN');
  console.log(` ${refresh_token}`);
  console.log(`${bar}`);
  console.log('Add this as a GitHub Actions secret named SPOTIFY_REFRESH_TOKEN.\n');

  return { refreshToken: refresh_token };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runBootstrap().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
