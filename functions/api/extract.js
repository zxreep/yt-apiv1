// functions/api/extract.js
import ytdl from '@ybd-project/ytdl-core/cloudflare';

/**
 * Minimal YouTube stream URL extractor for educational purposes.
 * 
 * Usage:
 *   GET /api/extract?url=https://www.youtube.com/watch?v=VIDEO_ID
 * 
 * Environment variables (optional):
 *   YT_COOKIE – a logged‑in YouTube cookie string to reduce bot blocking.
 *                Only use for personal testing on your own videos.
 */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const videoUrl = url.searchParams.get('url');

  if (!videoUrl) {
    return new Response(
      JSON.stringify({ error: 'Missing "url" query parameter' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Prepare headers to appear more like a real browser
  const requestOptions = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  };

  // Attach a YouTube cookie if provided (for personal testing)
  if (env.YT_COOKIE) {
    requestOptions.headers['Cookie'] = env.YT_COOKIE;
  }

  try {
    const info = await ytdl.getInfo(videoUrl, { requestOptions });
    const format = ytdl.chooseFormat(info.formats, { quality: '18' }); // 360p MP4 with audio

    if (!format || !format.url) {
      throw new Error('No suitable stream found');
    }

    return new Response(
      JSON.stringify({
        title: info.videoDetails.title,
        streamUrl: format.url,
        mimeType: format.mimeType,
        expiresIn: '~6 hours (temporary link)',
        disclaimer: 'For educational/research use only. Do not download copyrighted content without permission.'
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
