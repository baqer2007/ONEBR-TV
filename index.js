export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // توجيه طلبات استخراج الفيديو
    if (url.pathname.startsWith("/api/extract")) {
      const targetUrl = url.searchParams.get("url");

      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      };

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing 'url' parameter" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        const html = await response.text();

        return new Response(html, {
          headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // عرض باقي ملفات الموقع الثابتة
    return env.ASSETS.fetch(request);
  },
};
