import { Innertube, Platform } from 'youtubei.js/web';

// CF Workers has no eval(), but the Function constructor works fine.
// youtubei.js needs this shim to run YouTube's obfuscated decipher script.
// Without it, format.decipher() silently fails and all URLs are null.
Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n)   props.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  const code = `${data.output}\nreturn { ${props.join(', ')} }`;
  return new Function(code)();
};

// Robust URL parser for all YouTube formats
function parseYouTubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\.|m\./, '');
    const isMusic = host === 'music.youtube.com';

    const patterns = [
      /v=([a-zA-Z0-9_-]{11})/,
      /\/shorts\/([a-zA-Z0-9_-]{11})/,
      /\/live\/([a-zA-Z0-9_-]{11})/,
      /\/embed\/([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /\/v\/([a-zA-Z0-9_-]{11})/,
      /\/watch\/([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
      const match = url.href.match(pattern);
      if (match) return { id: match[1], isMusic };
    }
    return null;
  } catch {
    return null;
  }
}

function formatSize(bytes) {
  if (!bytes) return 'stream';
  const mb = Number(bytes) / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(mb * 1024).toFixed(0)} KB`;
}

// Reuse Innertube instance across warm requests
let ytInstance = null;

async function getYT() {
  if (!ytInstance) {
    ytInstance = await Innertube.create({
      fetch: (url, options) => fetch(url, options), // use CF native fetch
      retrieve_player: true,                        // needed to decipher URLs
      generate_session_locally: true,               // skip one round-trip to YouTube
    });
  }
  return ytInstance;
}

export default {
  async fetch(request, env) {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${env.CACHE_TTL || 300}`,
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
    if (request.method !== 'GET')
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { headers, status: 405 });

    const reqUrl = new URL(request.url);
    const rawVideoUrl = reqUrl.searchParams.get('url');
    if (!rawVideoUrl)
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), { headers, status: 400 });

    const parsed = parseYouTubeUrl(rawVideoUrl);
    if (!parsed)
      return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), { headers, status: 400 });

    try {
      const yt = await getYT();

      // v10 API: client must be an object, not a bare string
      const info = await yt.getBasicInfo(parsed.id, { client: 'WEB' });

      const details = info.basic_info;
      const streamingData = info.streaming_data;

      const rawFormats = [
        ...(streamingData?.formats ?? []),
        ...(streamingData?.adaptive_formats ?? []),
      ];

      const formats = rawFormats
        .map(f => {
          // f.url is null for most videos — must call decipher() to get the real URL
          let url;
          try {
            url = f.decipher(yt.session.player);
          } catch {
            url = f.url ?? null; // fallback for pre-signed URLs (rare)
          }
          if (!url) return null;

          return {
            itag:    f.itag,
            // has_audio / has_video are the correct youtubei.js boolean fields
            type:    f.has_video && f.has_audio ? 'video+audio' :
                     f.has_video               ? 'video'       :
                     f.has_audio               ? 'audio'       : 'unknown',
            mime:    f.mime_type?.split(';')[0] ?? 'unknown',
            quality: f.quality_label ??
                     f.audio_quality?.replace('AUDIO_QUALITY_', '').toLowerCase() ?? 'unknown',
            fps:     f.fps     ?? null,
            bitrate: f.bitrate ?? null,
            size:    formatSize(f.content_length),
            url,
          };
        })
        .filter(Boolean);

      formats.sort((a, b) => {
        const order = { 'video+audio': 1, video: 2, audio: 3, unknown: 4 };
        return (order[a.type] ?? 4) - (order[b.type] ?? 4);
      });

      return new Response(JSON.stringify({
        title:    details?.title    ?? 'Unknown',
        author:   details?.author   ?? 'Unknown',
        duration: details?.duration ?? 0,
        is_music: parsed.isMusic,
        formats,
      }), { headers, status: 200 });

    } catch (err) {
      console.error('Extraction error:', err?.message ?? err);
      const msg = err?.message ?? '';

      if (msg.includes('private') || msg.includes('unavailable'))
        return new Response(JSON.stringify({ error: 'Video is private or unavailable' }), { headers, status: 403 });
      if (msg.includes('age') || msg.includes('login'))
        return new Response(JSON.stringify({ error: 'Age-restricted video. Login required.' }), { headers, status: 403 });
      if (msg.includes('429') || msg.includes('rate limit'))
        return new Response(JSON.stringify({ error: 'YouTube rate limit. Try again later.' }), { headers, status: 429 });

      return new Response(JSON.stringify({
        error:   'Extraction failed',
        details: msg || 'Unknown error',
      }), { headers, status: 500 });
    }
  },
};
