import { connect } from 'cloudflare:sockets';
import { Innertube, Platform } from 'youtubei.js/web';

// ─── CF Workers eval shim (needed for YouTube's decipher script) ──────────────
Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n)   props.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
};

// ─── Proxy list (loaded from your GitHub repo, cached 1 hr) ──────────────────
const ENC = new TextEncoder();
const DEC = new TextDecoder();

let proxyList = [];
let proxiesLoadedAt = 0;

async function loadProxies(proxyFileUrl) {
  if (!proxyFileUrl) return;
  if (proxyList.length && Date.now() - proxiesLoadedAt < 3_600_000) return;
  try {
    const res = await fetch(proxyFileUrl);
    if (!res.ok) { console.error('Failed to fetch proxies:', res.status); return; }
    const text = await res.text();
    proxyList = text.split('\n')
      .map(l => l.trim().replace(/\r/, ''))
      .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(l));
    proxiesLoadedAt = Date.now();
    console.log(`Loaded ${proxyList.length} proxies`);
  } catch (e) { console.error('Proxy load error:', e.message); }
}

function pickProxy() {
  if (!proxyList.length) return null;
  const raw = proxyList[Math.floor(Math.random() * proxyList.length)];
  const [host, portStr] = raw.split(':');
  return { host, port: parseInt(portStr) };
}

// ─── Raw HTTP/1.1 over TCP socket (needed for proxy CONNECT tunneling) ────────

// Read bytes from a ReadableStream until \r\n\r\n (end of HTTP headers).
// Returns { headerText, leftover } where leftover is body bytes already read.
async function readHeaders(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;

      // Assemble and scan for \r\n\r\n
      const buf = joinChunks(chunks, total);
      for (let i = 0; i <= buf.length - 4; i++) {
        if (buf[i]===13&&buf[i+1]===10&&buf[i+2]===13&&buf[i+3]===10) {
          reader.releaseLock();
          return { headerText: DEC.decode(buf.subarray(0, i)), leftover: buf.subarray(i + 4) };
        }
      }
    }
  } catch (e) { reader.releaseLock(); throw e; }
  reader.releaseLock();
  const buf = joinChunks(chunks, total);
  return { headerText: DEC.decode(buf), leftover: new Uint8Array(0) };
}

function joinChunks(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function parseResponse(headerText) {
  const lines = headerText.split('\r\n');
  const status = parseInt(lines[0].match(/HTTP\/[\d.]+\s+(\d+)/)?.[1] ?? '0');
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(':');
    if (c > 0) headers.append(lines[i].slice(0, c).trim(), lines[i].slice(c + 1).trim());
  }
  return { status, headers };
}

async function readBody(readable, initial, headers) {
  const te = headers.get('transfer-encoding') ?? '';
  const cl = headers.get('content-length');

  if (te.includes('chunked')) {
    // Collect all remaining bytes then parse chunks
    const all = await readAll(readable, initial);
    const parts = [];
    let pos = 0;
    while (pos < all.length) {
      let nl = -1;
      for (let i = pos; i < all.length - 1; i++) {
        if (all[i]===13 && all[i+1]===10) { nl = i; break; }
      }
      if (nl === -1) break;
      const size = parseInt(DEC.decode(all.subarray(pos, nl)).split(';')[0], 16);
      if (isNaN(size) || size === 0) break;
      pos = nl + 2;
      parts.push(all.subarray(pos, pos + size));
      pos += size + 2;
    }
    const len = parts.reduce((s, p) => s + p.length, 0);
    return joinChunks(parts, len);
  }

  if (cl) {
    const len = parseInt(cl);
    const out = new Uint8Array(len);
    let pos = Math.min(initial.length, len);
    out.set(initial.subarray(0, pos));
    const reader = readable.getReader();
    try {
      while (pos < len) {
        const { value, done } = await reader.read();
        if (done) break;
        const n = Math.min(value.length, len - pos);
        out.set(value.subarray(0, n), pos);
        pos += n;
      }
    } finally { reader.releaseLock(); }
    return out;
  }

  return readAll(readable, initial);
}

async function readAll(readable, initial) {
  const chunks = initial.length ? [initial] : [];
  let total = initial.length;
  const reader = readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally { reader.releaseLock(); }
  return joinChunks(chunks, total);
}

// Full HTTP request through an HTTP CONNECT proxy.
// Handles HTTPS via CONNECT + startTls(), follows redirects, retries on failure.
async function fetchViaProxy(proxy, targetUrl, options = {}, redirects = 0) {
  if (redirects > 5) throw new Error('Too many redirects');

  const url   = new URL(String(targetUrl));
  const https = url.protocol === 'https:';
  const tPort = url.port ? parseInt(url.port) : (https ? 443 : 80);

  // Step 1 — open TCP connection to proxy
  let socket = connect({ hostname: proxy.host, port: proxy.port });

  if (https) {
    // Step 2 — HTTP CONNECT tunnel
    const w = socket.writable.getWriter();
    await w.write(ENC.encode(
      `CONNECT ${url.hostname}:${tPort} HTTP/1.1\r\n` +
      `Host: ${url.hostname}:${tPort}\r\n` +
      `Proxy-Connection: keep-alive\r\n\r\n`
    ));
    w.releaseLock();

    // Step 3 — read "200 Connection Established"
    const { headerText, leftover } = await readHeaders(socket.readable);
    const { status: cStatus } = parseResponse(headerText);
    if (cStatus !== 200) throw new Error(`Proxy CONNECT returned ${cStatus}`);
    if (leftover.length > 0) console.warn(`${leftover.length} unexpected bytes after CONNECT`);

    // Step 4 — upgrade to TLS
    socket = socket.startTls({ expectedServerHostname: url.hostname });
  }

  // Step 5 — build and send HTTP/1.1 request
  const method = (options.method ?? 'GET').toUpperCase();
  const path   = url.pathname + url.search;
  const rh     = new Headers(options.headers ?? {});
  if (!rh.has('Host'))            rh.set('Host', url.hostname);
  if (!rh.has('Connection'))      rh.set('Connection', 'close');
  if (!rh.has('Accept-Encoding')) rh.set('Accept-Encoding', 'identity'); // avoid gzip complexity

  let bodyBytes;
  if (options.body) {
    bodyBytes = typeof options.body === 'string' ? ENC.encode(options.body)
              : options.body instanceof Uint8Array ? options.body
              : new Uint8Array(await new Response(options.body).arrayBuffer());
    rh.set('Content-Length', String(bodyBytes.length));
  }

  let reqStr = `${method} ${path} HTTP/1.1\r\n`;
  for (const [k, v] of rh) reqStr += `${k}: ${v}\r\n`;
  reqStr += '\r\n';

  const w2 = socket.writable.getWriter();
  await w2.write(ENC.encode(reqStr));
  if (bodyBytes) await w2.write(bodyBytes);
  w2.releaseLock();

  // Step 6 — read response
  const { headerText, leftover } = await readHeaders(socket.readable);
  const { status, headers }      = parseResponse(headerText);

  if ([301, 302, 303, 307, 308].includes(status)) {
    const loc = headers.get('location');
    if (loc) return fetchViaProxy(proxy, new URL(loc, url).href, options, redirects + 1);
  }

  const body = await readBody(socket.readable, leftover, headers);
  return new Response(body, { status, headers });
}

// Tries up to 3 random proxies, then falls back to direct if all fail.
async function proxyFetch(url, options) {
  for (let i = 0; i < 3; i++) {
    const proxy = pickProxy();
    if (!proxy) break; // no proxies loaded — go direct
    try {
      return await fetchViaProxy(proxy, url, options);
    } catch (e) {
      console.warn(`Proxy ${proxy.host}:${proxy.port} failed (attempt ${i+1}): ${e.message}`);
    }
  }
  console.warn('All proxy attempts failed — falling back to direct');
  return fetch(url, options);
}

// ─── YouTube helpers ──────────────────────────────────────────────────────────

function parseYouTubeUrl(rawUrl) {
  try {
    const url  = new URL(rawUrl);
    const host = url.hostname.replace(/^www\.|m\./, '');
    const isMusic = host === 'music.youtube.com';
    for (const p of [
      /v=([a-zA-Z0-9_-]{11})/,
      /\/shorts\/([a-zA-Z0-9_-]{11})/,
      /\/live\/([a-zA-Z0-9_-]{11})/,
      /\/embed\/([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /\/v\/([a-zA-Z0-9_-]{11})/,
    ]) {
      const m = url.href.match(p);
      if (m) return { id: m[1], isMusic };
    }
    return null;
  } catch { return null; }
}

function fmtSize(bytes) {
  if (!bytes) return 'stream';
  const mb = Number(bytes) / 1_048_576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(mb * 1024).toFixed(0)} KB`;
}

// ─── Innertube instance (reused across warm requests) ────────────────────────

let ytInstance = null;

async function getYT(proxyFileUrl) {
  await loadProxies(proxyFileUrl);
  if (!ytInstance) {
    ytInstance = await Innertube.create({
      fetch: proxyFetch,          // ← all YouTube requests go through a proxy
      retrieve_player: true,
      generate_session_locally: true,
    });
  }
  return ytInstance;
}

// Try clients in order; embedded clients bypass YouTube's datacenter IP blocks.
const CLIENTS = ['TV_EMBEDDED', 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', 'WEB_EMBEDDED', 'WEB'];

async function fetchInfo(yt, videoId) {
  let lastErr;
  for (const client of CLIENTS) {
    try {
      const info = await yt.getBasicInfo(videoId, client);
      if (info.basic_info?.title || info.playability_status?.status === 'OK')
        return { info, client };
      if (info.playability_status?.status === 'LOGIN_REQUIRED') continue; // bot blocked
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('All clients failed');
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${env.CACHE_TTL || 300}`,
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders, status: 204 });
    if (request.method !== 'GET')
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers: corsHeaders, status: 405 });

    const reqUrl      = new URL(request.url);
    const rawVideoUrl = reqUrl.searchParams.get('url');
    const debug       = reqUrl.searchParams.get('debug') === '1';

    if (!rawVideoUrl)
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), { headers: corsHeaders, status: 400 });

    const parsed = parseYouTubeUrl(rawVideoUrl);
    if (!parsed)
      return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), { headers: corsHeaders, status: 400 });

    try {
      const yt = await getYT(env.PROXY_FILE_URL);
      const { info, client: usedClient } = await fetchInfo(yt, parsed.id);

      if (debug) {
        return new Response(JSON.stringify({
          used_client:       usedClient,
          proxy_count:       proxyList.length,
          playability:       info.playability_status,
          basic_info:        info.basic_info,
          has_streaming:     !!info.streaming_data,
          format_count:      (info.streaming_data?.formats?.length ?? 0)
                           + (info.streaming_data?.adaptive_formats?.length ?? 0),
        }, null, 2), { headers: corsHeaders });
      }

      const details      = info.basic_info;
      const streamingData = info.streaming_data;

      const formats = [
        ...(streamingData?.formats ?? []),
        ...(streamingData?.adaptive_formats ?? []),
      ].map(f => {
        let url;
        try { url = f.decipher(yt.session.player); } catch { url = f.url ?? null; }
        if (!url) return null;
        return {
          itag:    f.itag,
          type:    f.has_video && f.has_audio ? 'video+audio'
                 : f.has_video ? 'video' : f.has_audio ? 'audio' : 'unknown',
          mime:    f.mime_type?.split(';')[0] ?? 'unknown',
          quality: f.quality_label ?? f.audio_quality?.replace('AUDIO_QUALITY_', '').toLowerCase() ?? 'unknown',
          fps:     f.fps    ?? null,
          bitrate: f.bitrate ?? null,
          size:    fmtSize(f.content_length),
          url,
        };
      }).filter(Boolean).sort((a, b) => {
        const o = { 'video+audio': 1, video: 2, audio: 3, unknown: 4 };
        return (o[a.type] ?? 4) - (o[b.type] ?? 4);
      });

      return new Response(JSON.stringify({
        title:    details?.title    ?? 'Unknown',
        author:   details?.author   ?? 'Unknown',
        duration: details?.duration ?? 0,
        is_music: parsed.isMusic,
        formats,
      }), { headers: corsHeaders });

    } catch (err) {
      const msg = err?.message ?? String(err);
      console.error('Extraction error:', msg);

      if (/\bprivate\b/i.test(msg))
        return new Response(JSON.stringify({ error: 'Video is private', details: msg }), { headers: corsHeaders, status: 403 });
      if (/age.?restrict/i.test(msg))
        return new Response(JSON.stringify({ error: 'Age-restricted video', details: msg }), { headers: corsHeaders, status: 403 });
      if (/429|rate.?limit/i.test(msg))
        return new Response(JSON.stringify({ error: 'Rate limited — try again later', details: msg }), { headers: corsHeaders, status: 429 });

      return new Response(JSON.stringify({ error: 'Extraction failed', details: msg }), { headers: corsHeaders, status: 500 });
    }
  },
};
