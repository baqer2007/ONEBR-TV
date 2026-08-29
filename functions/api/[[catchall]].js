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
    // 1. مسار الفحص الذكي واستخراج روابط البث المؤكدة
    if (path === "/api/resolve") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";

      if (!tmdbId) return new Response(JSON.stringify({ error: "Missing ID" }), { status: 400, headers: corsHeaders });

      const cacheKey = `stream_verified_v3_${type}_${tmdbId}_${season}_${episode}`;

      // فحص الكاش السحابي (المدة قصيرة: 30 دقيقة فقط لمنع انتهاء التوكنات)
      if (env.STREAM_KV) {
        const cached = await env.STREAM_KV.get(cacheKey, { type: "json" });
        if (cached) return new Response(JSON.stringify({ success: true, source: "kv-cache", ...cached }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // استخراج وفحص المصادر الحقيقية المتوفرة
      const activeStream = await extractAndVerifyStream(tmdbId, type, season, episode);

      if (activeStream) {
        if (env.STREAM_KV) {
          // تخزين لمدة 1800 ثانية (نصف ساعة) لتفادي التوكنات الموقوتة
          await env.STREAM_KV.put(cacheKey, JSON.stringify(activeStream), { expirationTtl: 1800 });
        }
        return new Response(JSON.stringify({ success: true, ...activeStream }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ success: false, message: "No playable stream found" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. مسار البروكسي لتجاوز حظر CORS وتمرير مفاتيح التشفير AES-128
    if (path === "/api/proxy") {
      const targetUrl = decodeURIComponent(url.searchParams.get("url") || "");
      const customReferer = url.searchParams.get("referer") || "https://vidlink.pro/";

      if (!targetUrl) return new Response("Missing URL", { status: 400 });

      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": customReferer,
          "Origin": new URL(customReferer).origin
        }
      });

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/vnd.apple.mpegurl") || targetUrl.includes(".m3u8")) {
        let text = await response.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        // 1. إعادة كتابة مسارات أجزاء الفيديو (.ts)
        text = text.replace(/^(?!#)(?!\s*$)(.+)$/gm, (match) => {
          const fullUrl = match.startsWith("http") ? match : baseUrl + match.trim();
          return `${url.origin}/api/proxy?url=${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(customReferer)}`;
        });

        // 2. إعادة كتابة روابط مفاتيح التشفير (AES-128 Key URI Proxy)
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

    return new Response(JSON.stringify({ status: "Prober Engine Active" }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

// محرك الفحص المباشر
async function extractAndVerifyStream(tmdb, type, s, e) {
  const isMov = (type === "movie");

  const providers = [
    async () => {
      const apiUrl = isMov ? `https://vidlink.pro/api/b/movie/${tmdb}` : `https://vidlink.pro/api/b/tv/${tmdb}/${s}/${e}`;
      const res = await fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://vidlink.pro/" } });
      if (!res.ok) return null;
      const json = await res.json();
      if (json && json.stream && json.stream.playlist) {
        return { directStreamUrl: json.stream.playlist, referer: "https://vidlink.pro/", provider: "VidLink Core" };
      }
      return null;
    },
    async () => {
      const target = isMov ? `https://embed.su/api/e/movie/${tmdb}` : `https://embed.su/api/e/tv/${tmdb}/${s}/${e}`;
      const res = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://embed.su/" } });
      if (!res.ok) return null;
      const json = await res.json();
      if (json && json.source) {
        return { directStreamUrl: json.source, referer: "https://embed.su/", provider: "EmbedSu Ultra" };
      }
      return null;
    }
  ];

  for (const getStream of providers) {
    try {
      const result = await getStream();
      if (result && result.directStreamUrl) {
        // فحص سريع لصلاحية البث
        const check = await fetch(result.directStreamUrl, { method: "HEAD", headers: { "Referer": result.referer } });
        if (check.ok) return result;
      }
    } catch (err) {}
  }

  return null;
}
