export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // 1. مسار الفحص الذكي للروابط: /api/resolve
    if (path === "/api/resolve") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";

      if (!tmdbId) {
        return new Response(JSON.stringify({ error: "Missing TMDB ID" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const cacheKey = `stream_${type}_${tmdbId}_${season}_${episode}`;

      // فحص الكاش السحابي
      if (env.STREAM_KV) {
        const cachedData = await env.STREAM_KV.get(cacheKey, { type: "json" });
        if (cachedData) {
          return new Response(JSON.stringify({ success: true, source: "kv-cache", ...cachedData }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      }

      // فحص سريع مباشر
      const isMov = (type === "movie");
      const apiUrl = isMov 
        ? `https://vidlink.pro/api/b/movie/${tmdbId}`
        : `https://vidlink.pro/api/b/tv/${tmdbId}/${season}/${episode}`;

      try {
        const res = await fetch(apiUrl, {
          headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://vidlink.pro/" }
        });

        if (res.ok) {
          const data = await res.json();
          if (data && data.stream && data.stream.playlist) {
            const resultData = {
              streams: [{ quality: "Auto 1080p", url: data.stream.playlist, referer: "https://vidlink.pro/" }],
              subtitles: data.stream.captions || []
            };
            if (env.STREAM_KV) {
              await env.STREAM_KV.put(cacheKey, JSON.stringify(resultData), { expirationTtl: 21600 });
            }
            return new Response(JSON.stringify({ success: true, source: "direct-engine", ...resultData }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
          }
        }
      } catch (e) {}

      return new Response(JSON.stringify({ success: false, fallbackToEmbed: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. مسار البروكسي: /api/proxy
    if (path === "/api/proxy") {
      const targetUrl = decodeURIComponent(url.searchParams.get("url") || "");
      const customReferer = url.searchParams.get("referer") || "https://vidlink.pro/";

      if (!targetUrl) return new Response("Missing URL", { status: 400 });

      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Referer": customReferer,
          "Origin": new URL(customReferer).origin
        }
      });

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/vnd.apple.mpegurl") || targetUrl.includes(".m3u8")) {
        let text = await response.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        text = text.replace(/^(?!#)(?!\s*$)(.+)$/gm, (match) => {
          const fullUrl = match.startsWith("http") ? match : baseUrl + match.trim();
          return `${url.origin}/api/proxy?url=${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(customReferer)}`;
        });

        return new Response(text, {
          headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "public, max-age=60" }
        });
      }

      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": contentType, "Cache-Control": "public, max-age=86400" }
      });
    }

    // 3. مسار الترجمة: /api/subtitles
    if (path === "/api/subtitles") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";

      const subs = [{
        lang: "Arabic", code: "ar", label: "العربية (تلقائي)",
        url: `https://sub.wyzie.ru/subtitles/${tmdbId}/${type === 'tv' ? `${season}-${episode}` : '0'}?lang=ar`
      }];

      return new Response(JSON.stringify(subs), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ status: "Engine Ready" }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
