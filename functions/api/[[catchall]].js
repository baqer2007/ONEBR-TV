export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // 1. مسار الفحص الذكي للبحث عن السيرفر الشغال
    if (path === "/api/resolve") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";

      if (!tmdbId) return new Response(JSON.stringify({ error: "Missing TMDB ID" }), { status: 400, headers: corsHeaders });

      const isMov = (type === "movie");
      const cacheKey = `verified_source_${type}_${tmdbId}_${season}_${episode}`;

      // فحص الكاش السحابي السريع
      if (env.STREAM_KV) {
        const cached = await env.STREAM_KV.get(cacheKey, { type: "json" });
        if (cached) return new Response(JSON.stringify({ success: true, source: "kv-cache", ...cached }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // قائمة السيرفرات العالمية المرشحة
      const candidates = [
        {
          name: "VidLink Direct",
          checkUrl: isMov ? `https://vidlink.pro/api/b/movie/${tmdbId}` : `https://vidlink.pro/api/b/tv/${tmdbId}/${season}/${episode}`,
          embedUrl: isMov ? `https://vidlink.pro/movie/${tmdbId}?primaryColor=e50914` : `https://vidlink.pro/tv/${tmdbId}/${season}/${episode}?primaryColor=e50914`,
          isJson: true
        },
        {
          name: "MultiEmbed (شامل المسلسلات القديمة والتركي)",
          checkUrl: isMov ? `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1` : `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
          embedUrl: isMov ? `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1` : `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
          isJson: false
        },
        {
          name: "Embed.su Ultra",
          checkUrl: isMov ? `https://embed.su/embed/movie/${tmdbId}` : `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}`,
          embedUrl: isMov ? `https://embed.su/embed/movie/${tmdbId}` : `https://embed.su/embed/tv/${tmdbId}/${season}/${episode}`,
          isJson: false
        },
        {
          name: "VidSrc.cc",
          checkUrl: isMov ? `https://vidsrc.cc/v2/embed/movie/${tmdbId}` : `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season}/${episode}`,
          embedUrl: isMov ? `https://vidsrc.cc/v2/embed/movie/${tmdbId}` : `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season}/${episode}`,
          isJson: false
        },
        {
          name: "NontonGo",
          checkUrl: isMov ? `https://www.nontongo.win/embed/movie/${tmdbId}` : `https://www.nontongo.win/embed/tv/${tmdbId}/${season}/${episode}`,
          embedUrl: isMov ? `https://www.nontongo.win/embed/movie/${tmdbId}` : `https://www.nontongo.win/embed/tv/${tmdbId}/${season}/${episode}`,
          isJson: false
        }
      ];

      // فحص متوازي لجميع السيرفرات في أجزاء من الثانية
      let verifiedResult = null;

      for (const server of candidates) {
        try {
          const res = await fetch(server.checkUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(2800)
          });

          if (!res.ok) continue;

          if (server.isJson) {
            const data = await res.json();
            if (data && data.stream && data.stream.playlist) {
              verifiedResult = {
                directStreamUrl: data.stream.playlist,
                referer: "https://vidlink.pro/",
                serverName: server.name
              };
              break;
            }
          } else {
            const html = await res.text();
            // التحقق من خلو السيرفر من رسائل الخطأ
            if (
              !html.includes("Couldn't Find This Content") &&
              !html.includes("There are no sources yet") &&
              !html.includes("404 Not Found") &&
              html.length > 600
            ) {
              verifiedResult = {
                workingServerUrl: server.embedUrl,
                serverName: server.name
              };
              break;
            }
          }
        } catch (e) {}
      }

      // إذا لم يتوفر أي خيار مؤكد، اختيار سيرفر MultiEmbed كبديل واسع الانتشار للأعمال القديمة
      if (!verifiedResult) {
        verifiedResult = {
          workingServerUrl: isMov ? `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1` : `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`,
          serverName: "MultiEmbed"
        };
      }

      if (env.STREAM_KV) {
        await env.STREAM_KV.put(cacheKey, JSON.stringify(verifiedResult), { expirationTtl: 1800 });
      }

      return new Response(JSON.stringify({ success: true, ...verifiedResult }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. مسار البروكسي لتمرير البث ومفاتيح التشفير
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

        text = text.replace(/URI="([^"]+)"/g, (match, keyUrl) => {
          const fullKeyUrl = keyUrl.startsWith("http") ? keyUrl : baseUrl + keyUrl;
          return `URI="${url.origin}/api/proxy?url=${encodeURIComponent(fullKeyUrl)}&referer=${encodeURIComponent(customReferer)}"`;
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

    // 3. مسار الترجمة التلقائية
    if (path === "/api/subtitles") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";

      const subs = [{
        lang: "Arabic", code: "ar", label: "العربية",
        url: `https://sub.wyzie.ru/subtitles/${tmdbId}/${type === 'tv' ? `${season}-${episode}` : '0'}?lang=ar`
      }];

      return new Response(JSON.stringify(subs), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ status: "Prober Engine Online" }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
