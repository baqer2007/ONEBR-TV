export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // توجيه طلبات السيرفرات
    if (url.pathname.startsWith("/api/extract")) {
      const targetUrl = url.searchParams.get("url");

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing url parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const response = await fetch(targetUrl, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
            "Referer": targetUrl
          }
        });

        // إنشاء استجابة جديدة وإزالة قيود الحماية للتضمين
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.delete("X-Frame-Options");
        newHeaders.delete("Content-Security-Policy");

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // تقديم باقي ملفات الموقع الثابتة
    return env.ASSETS.fetch(request);
  }
};
