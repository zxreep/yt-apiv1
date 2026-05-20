import { Innertube, Platform } from 'youtubei.js/web';

// CF Workers has no eval(), but the Function constructor works.
// youtubei.js needs this to run YouTube's obfuscated decipher script.
Platform.shim.eval = async (data, env) => {
  const props = [];
  if (env.n)   props.push(`n: exportedVars.nFunction("${env.n}")`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction("${env.sig}")`);
  const code = `${data.output}\nreturn { ${props.join(', ')} }`;
  return new Function(code)();
};

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
  } catch { return null; }
}

function formatSize(bytes) {
  if (!bytes) return 'stream';
  const mb = Number(bytes) / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(mb * 1024).toFixed(0)} KB`;
}

let ytInstance = null;

async function getYT() {
  if (!ytInstance) {
    ytInstance = await Innertube.create({
      fetch: (url, options) => fetch(url, options),
      retrieve_player: true,
      generate_session_locally: true,
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
    const debug = reqUrl.searchParams.get('debug') === '1'; // ?debug=1 dumps raw info

    if (!rawVideoUrl)
      return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), { headers, status: 400 });

    const parsed = parseYouTubeUrl(rawVideoUrl);
    if (!parsed)
      return new Response(JSON.stringify({ error: 'Invalid YouTube URL' }), { headers, status: 400 });

    try {
      const yt = await getYT();

      // WEB/ANDROID/iOS all get "Sign in to confirm you're not a bot" from YouTube
      // and return no videoDetails. TV_EMBEDDED bypasses this bot detection check.
      const info = await yt.getBasicInfo(parsed.id, 'TV_EMBEDDED');

      // Debug mode: dump raw response so you can inspect field names
      if (debug) {
        return new Response(JSON.stringify({
          basic_info: info.basic_info,
          has_streaming_data: !!info.streaming_data,
          format_count: (info.streaming_data?.formats?.length ?? 0) + (info.streaming_data?.adaptive_formats?.length ?? 0),
          playability: info.playability_status,
        }, null, 2), { headers, status: 200 });
      }

      const details = info.basic_info;
      const streamingData = info.streaming_data;

      const rawFormats = [
        ...(streamingData?.formats ?? []),
        ...(streamingData?.adaptive_formats ?? []),
      ];

      const formats = rawFormats
        .map(f => {
          let url;
          try {
            url = f.decipher(yt.session.player);
          } catch {
            url = f.url ?? null;
          }
          if (!url) return null;

          return {
            itag:    f.itag,
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
        return new Response(JSON.stringify({ error: 'Age-restricted or login-required video.' }), { headers, status: 403 });
      if (msg.includes('429') || msg.includes('rate limit'))
        return new Response(JSON.stringify({ error: 'YouTube rate limit. Try again later.' }), { headers, status: 429 });

      return new Response(JSON.stringify({
        error:   'Extraction failed',
        details: msg || 'Unknown error',
      }), { headers, status: 500 });
    }
  },
};
