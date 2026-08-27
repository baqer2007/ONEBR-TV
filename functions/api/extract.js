// functions/api/extract.js

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get("url");

  // 🌐 ترويسات CORS للسماح للمشغل بالوصول للبيانات بدون مشاكل أمان
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS, HEAD",
    "Access-Control-Allow-Headers": "*",
  };

  // التعامل مع طلبات OPTIONS المسبقة
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // التحقق من وجود رابط مستهدف
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const targetOrigin = parsedTarget.origin;

    // 📡 جلب البيانات من الخادم الخارجي مع تزوير الترويسات لمحاكاة المتصفح والموقع الأصلي
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": targetOrigin + "/",
        "Origin": targetOrigin,
        "Accept": "*/*",
      },
    });

    const contentType = response.headers.get("content-type") || "";

    // 🎬 إذا كان الرد عبارة عن قائمة تشغيل HLS (m3u8)، نعيد كتابة الروابط النسبية لتمر عبر هذا الوسيط
    if (contentType.includes("application/vnd.apple.mpegurl") || contentType.includes("application/x-mpegurl") || targetUrl.includes(".m3u8")) {
      const originalText = await response.text();
      const currentWorkerBase = `${url.origin}/api/extract?url=`;

      // تحويل الروابط النسبية داخل ملف m3u8 إلى روابط تمر عبر الوسيط
      const modifiedManifest = originalText.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          return line;
        }

        let absoluteUrl;
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
          absoluteUrl = trimmed;
        } else {
          absoluteUrl = new URL(trimmed, targetUrl).href;
        }

        return currentWorkerBase + encodeURIComponent(absoluteUrl);
      }).join("\n");

      return new Response(modifiedManifest, {
        status: response.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        },
      });
    }

    // 📦 إذا كان مقطع فيديو مباشر أو ملف ثنائي (ts/mp4)، يتم تمريره مباشرة للمشغل
    return new Response(response.body, {
      status: response.status,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType || "video/MP2T",
        "Cache-Control": "public, max-age=3600",
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
