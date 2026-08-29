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
    // 1. محرك الفحص السحابي (نظام السباق)
    if (path === "/api/resolve") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";

      if (!tmdbId) return new Response(JSON.stringify({ error: "Missing ID" }), { status: 400, headers: corsHeaders });

      const cacheKey = `verified_v2_${type}_${tmdbId}_${season}_${episode}`;

      // أ. فحص الكاش السريع
      if (env.STREAM_KV) {
        const cachedData = await env.STREAM_KV.get(cacheKey, { type: "json" });
        if (cachedData) return new Response(JSON.stringify({ success: true, source: "kv-cache", ...cachedData }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // ب. سباق السيرفرات (إيجاد الأسرع والأصح)
      const verifiedResult = await raceServersForContent(tmdbId, type, season, episode);

      if (verifiedResult) {
        if (env.STREAM_KV) await env.STREAM_KV.put(cacheKey, JSON.stringify(verifiedResult), { expirationTtl: 21600 });
        return new Response(JSON.stringify({ success: true, ...verifiedResult }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({ success: false, message: "No active sources found right now." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. بروكسي تجاوز الحجب
    if (path === "/api/proxy") {
      const targetUrl = decodeURIComponent(url.searchParams.get("url") || "");
      const customReferer = url.searchParams.get("referer") || "https://vidlink.pro/";
      if (!targetUrl) return new Response("Missing URL", { status: 400 });

      const response = await fetch(targetUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": customReferer, "Origin": new URL(customReferer).origin }
      });

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/vnd.apple.mpegurl") || targetUrl.includes(".m3u8")) {
        let text = await response.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
        text = text.replace(/^(?!#)(?!\s*$)(.+)$/gm, match => {
          const fullUrl = match.startsWith("http") ? match : baseUrl + match.trim();
          return `${url.origin}/api/proxy?url=${encodeURIComponent(fullUrl)}&referer=${encodeURIComponent(customReferer)}`;
        });
        return new Response(text, { headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "public, max-age=60" } });
      }
      return new Response(response.body, { status: response.status, headers: { ...corsHeaders, "Content-Type": contentType } });
    }

    // 3. جلب الترجمات
    if (path === "/api/subtitles") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";
      return new Response(JSON.stringify([{ lang: "Arabic", code: "ar", label: "العربية", url: `https://sub.wyzie.ru/subtitles/${tmdbId}/${type === 'tv' ? `${season}-${episode}` : '0'}?lang=ar` }]), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ status: "Prober Engine Active 🚀" }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}

// خوارزمية السباق: من يرسل بيانات حقيقية أولاً يفوز
async function raceServersForContent(id, type, s, e) {
  const isMov = (type === "movie");

  const candidates = [
    { name: "VidLink PRO", url: isMov ? `https://vidlink.pro/api/b/movie/${id}` : `https://vidlink.pro/api/b/tv/${id}/${s}/${e}`, embed: isMov ? `https://vidlink.pro/movie/${id}` : `https://vidlink.pro/tv/${id}/${s}/${e}`, isJson: true },
    { name: "MultiEmbed VIP", url: isMov ? `https://multiembed.mov/?video_id=${id}&tmdb=1` : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`, embed: isMov ? `https://multiembed.mov/?video_id=${id}&tmdb=1` : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`, isJson: false },
    { name: "Embed.su", url: isMov ? `https://embed.su/embed/movie/${id}` : `https://embed.su/embed/tv/${id}/${s}/${e}`, embed: isMov ? `https://embed.su/embed/movie/${id}` : `https://embed.su/embed/tv/${id}/${s}/${e}`, isJson: false },
    { name: "VidSrc.cc", url: isMov ? `https://vidsrc.cc/v2/embed/movie/${id}` : `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`, embed: isMov ? `https://vidsrc.cc/v2/embed/movie/${id}` : `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}`, isJson: false },
    { name: "NontonGo", url: isMov ? `https://www.nontongo.win/embed/movie/${id}` : `https://www.nontongo.win/embed/tv/${id}/${s}/${e}`, embed: isMov ? `https://www.nontongo.win/embed/movie/${id}` : `https://www.nontongo.win/embed/tv/${id}/${s}/${e}`, isJson: false }
  ];

  return new Promise((resolve) => {
    let failedCount = 0;
    for (let c of candidates) {
      fetch(c.url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4500) })
        .then(async res => {
          if (!res.ok) throw new Error("Bad status");
          if (c.isJson) {
            const json = await res.json();
            if (json && json.stream && json.stream.playlist) resolve({ directStreamUrl: json.stream.playlist, serverName: c.name, workingServerUrl: c.embed });
            else throw new Error("No playlist");
          } else {
            const html = await res.text();
            if (!html.includes("There are no sources yet") && !html.includes("404 Not Found") && html.length > 500) {
              resolve({ workingServerUrl: c.embed, serverName: c.name });
            } else throw new Error("Fake load");
          }
        })
        .catch(() => {
          failedCount++;
          if (failedCount === candidates.length) resolve(null);
        });
    }
  });
}
