export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range, User-Agent, Referer",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // 1. محرك الفحص والاستخراج الذكي متعدد المسارات
    if (path === "/api/resolve") {
      const tmdbId = url.searchParams.get("tmdb");
      const type = url.searchParams.get("type") || "movie";
      const season = url.searchParams.get("s") || "1";
      const episode = url.searchParams.get("e") || "1";

      if (!tmdbId) return new Response(JSON.stringify({ error: "Missing TMDB ID" }), { status: 400, headers: corsHeaders });

      const isMov = (type === "movie");
      const cacheKey = `ultra_stream_v6_${type}_${tmdbId}_${season}_${episode}`;

      // فحص الكاش السحابي السريع
      if (env.STREAM_KV) {
        const cached = await env.STREAM_KV.get(cacheKey, { type: "json" });
        if (cached) return new Response(JSON.stringify({ success: true, source: "kv-cache", ...cached }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // شبكة استخراج من المزودات العالمية وفحص توفر البث
      const extractors = [
        // استخراج فوري من شبكة VidLink السريعة
        async () => {
          const target = isMov ? `https://vidlink.pro/api/b/movie/${tmdbId}` : `https://vidlink.pro/api/b/tv/${tmdbId}/${season}/${episode}`;
          const res = await fetch(target, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
              "Referer": "https://vidlink.pro/",
              "Origin": "https://vidlink.pro"
            },
            signal: AbortSignal.timeout(3000)
          });
          if (!res.ok) return null;
          const data = await res.json();
          if (data?.stream?.playlist) {
            return { directStreamUrl: data.stream.playlist, referer: "https://vidlink.pro/", serverName: "VidLink Core" };
          }
          return null;
        },

        // استخراج مباشر من مشغل AutoEmbed
        async () => {
          const target = isMov ? `https://player.autoembed.cc/embed/movie/${tmdbId}` : `https://player.autoembed.cc/embed/tv/${tmdbId}/${season}/${episode}`;
          const res = await fetch(target, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(3000)
          });
          if (!res.ok) return null;
          const html = await res.text();
          const match = html.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i);
          if (match && match[1]) {
            return { directStreamUrl: match[1], referer: "https://player.autoembed.cc/", serverName: "AutoEmbed Stream" };
          }
          if (html.length > 1000 && !html.includes("not found")) {
            return { workingServerUrl: target, serverName: "AutoEmbed Server" };
          }
          return null;
        },

        // فحص سيرفر VidSrc المعتمد والخالي من الكابتشا
        async () => {
          const target = isMov ? `https://vidsrc.cc/v2/embed/movie/${tmdbId}` : `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season}/${episode}`;
          const res = await fetch(target, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(2800)
          });
          if (!res.ok) return null;
          const html = await res.text();
          if (!html.includes("404 Not Found") && html.length > 800) {
            return { workingServerUrl: target, serverName: "VidSrc HighSpeed" };
          }
          return null;
        },

        // فحص سيرفر 2Embed VIP
        async () => {
          const target = isMov ? `https://www.2embed.cc/embed/${tmdbId}` : `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}`;
          const res = await fetch(target, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(2800)
          });
          if (res.ok) return { workingServerUrl: target, serverName: "2Embed VIP" };
          return null;
        },

        // فحص سيرفر MultiEmbed (الأشمل للأعمال القديمة والتركية)
        async () => {
          const target = isMov ? `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1` : `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${season}&e=${episode}`;
          const res = await fetch(target, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            signal: AbortSignal.timeout(2800)
          });
          if (!res.ok) return null;
          const html = await res.text();
          if (!html.includes("There are no sources yet") && !html.includes("404 Not Found") && html.length > 600) {
            return { workingServerUrl: target, serverName: "MultiEmbed Global" };
          }
          return null;
        }
      ];

      // إطلاق الفحص بالتوازي واختيار أول خيار متاح وموثوق
      let resolvedData = null;
      for (const extract of extractors) {
        try {
          const result = await extract();
          if (result) {
            // إذا كان الرابط مباشراً، نقوم بفحص صلاحية أول بايتات منه للتأكد من أنه ليس صفحة 403
            if (result.directStreamUrl) {
              const checkStream = await fetch(result.directStreamUrl, {
                method: "HEAD",
                headers: { "Referer": result.referer, "User-Agent": "Mozilla/5.0" }
              });
              if (checkStream.ok) {
                resolvedData = result;
                break;
              }
            } else {
              resolvedData = result;
              break;
            }
          }
        } catch (e) {}
      }

      // خطة الأمان الأخيرة إذا كان العمل قديماً جداً ونادراً
      if (!resolvedData) {
        resolvedData = {
          workingServerUrl: isMov ? `https://vidsrc.cc/v2/embed/movie/${tmdbId}` : `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${season}/${episode}`,
          serverName: "VidSrc Reserve"
        };
      }

      if (env.STREAM_KV) {
        await env.STREAM_KV.put(cacheKey, JSON.stringify(resolvedData), { expirationTtl: 1800 });
      }

      return new Response(JSON.stringify({ success: true, ...resolvedData }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. مسار البروكسي العميق لكسر حظر الكوكيز ومفاتيح AES-128
    if (path === "/api/proxy") {
      const targetUrl = decodeURIComponent(url.searchParams.get("url") || "");
      const customReferer = url.searchParams.get("referer") || "https://vidlink.pro/";

      if (!targetUrl) return new Response("Missing URL", { status: 400 });

      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Referer": customReferer,
          "Origin": new URL(customReferer).origin,
          "Accept": "*/*",
          "Sec-Fetch-Mode": "cors"
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

    return new Response(JSON.stringify({ status: "Ultra Resolver Engine Active" }), { headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
  }
}
