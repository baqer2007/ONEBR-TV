/**
 * ONEBR TV - Cloudflare Worker Secure API & Server
 * نظام توثيق ديناميكي موقّع (HMAC-SHA256 Signed Tokens)
 */

// 🔑 المفاتيح والبيانات السرية (محفوظة بالكامل داخل الخادم)
const FIREBASE_SECRET = "HzzNWUjdX5nANFUXnm9RuEhWokJmDo7Rvpy81hlO";
const FIREBASE_DB_URL = "https://cinemavip-a9a21-default-rtdb.firebaseio.com";
const ADMIN_EMAIL = "altrfybaqer0@gmail.com";
const ADMIN_PASS = "baqer1234";
const JWT_SECRET = "ONEBR_SECURE_SERVER_KEY_987412356_!@#$%";

// دالة الاتصال بقاعدة البيانات عبر المفتاح السري
async function fbFetch(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${FIREBASE_DB_URL}${path}${separator}auth=${FIREBASE_SECRET}`;
  return await fetch(url, options);
}

// دوال تشفير والتحقق من التوكن الموقّع (HMAC-SHA256)
async function signToken(payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const dataStr = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(dataStr));
  const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${dataStr}.${sigHex}`;
}

async function verifyToken(token) {
  try {
    if (!token || !token.includes('.')) return null;
    const [dataStr, sigHex] = token.split('.');
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(dataStr));
    if (!isValid) return null;

    const payload = JSON.parse(decodeURIComponent(escape(atob(dataStr))));
    if (payload.exp && Date.now() > payload.exp) return null; // منتهي الصلاحية
    return payload;
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // معالجة CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    // 1️⃣ مسار فك واستخراج بروكسي الفيديو للبث المباشر
    if (url.pathname.startsWith("/api/extract")) {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing url parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
      try {
        const response = await fetch(targetUrl, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
            "Referer": targetUrl
          }
        });
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
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // 2️⃣ مسارات API الموقع
    if (url.pathname.startsWith("/api/")) {
      const headers = { 
        "Content-Type": "application/json; charset=utf-8", 
        "Access-Control-Allow-Origin": "*" 
      };

      // 🔐 تسجيل الدخول وإصدار توكن ديناميكي
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        try {
          const { email, pin } = await request.json();
          const cleanEmail = (email || "").trim().toLowerCase();

          // التحقق من الأدمن وإصدار توكن خاص بالمشرف
          if (cleanEmail === ADMIN_EMAIL.toLowerCase() && pin === ADMIN_PASS) {
            const token = await signToken({
              email: cleanEmail,
              isAdmin: true,
              isVip: true,
              exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // صالح لمدة 7 أيام
            });
            return new Response(JSON.stringify({
              success: true,
              token,
              user: { email: cleanEmail, isAdmin: true, isVip: true, adsDisabled: true }
            }), { headers });
          }

          // فحص الحظر
          const key = cleanEmail.replace(/[^a-zA-Z0-9]/g, '_');
          const banRes = await fbFetch(`/banned_users/${key}.json`);
          const isBanned = await banRes.json();
          if (isBanned) {
            return new Response(JSON.stringify({ error: "تم حظر هذا الحساب من استخدام المنصة!" }), { status: 403, headers });
          }

          // فحص بيانات المستخدم وإصدار توكن عضو عادي
          const userRes = await fbFetch(`/users/${key}.json`);
          const user = await userRes.json();

          if (user && user.pin === pin) {
            const token = await signToken({
              email: user.email,
              isAdmin: false,
              isVip: !!user.isVip,
              exp: Date.now() + (30 * 24 * 60 * 60 * 1000)
            });
            return new Response(JSON.stringify({
              success: true,
              token,
              user: { email: user.email, isAdmin: false, isVip: !!user.isVip, adsDisabled: !!user.adsDisabled }
            }), { headers });
          }

          return new Response(JSON.stringify({ error: "بيانات الدخول غير صحيحة!" }), { status: 401, headers });
        } catch (e) {
          return new Response(JSON.stringify({ error: "خطأ في معالجة الطلب" }), { status: 500, headers });
        }
      }

      // 📝 إنشاء حساب جديد
      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        try {
          const { email, pin } = await request.json();
          const cleanEmail = (email || "").trim().toLowerCase();
          if (!cleanEmail || !pin || pin.length < 6) {
            return new Response(JSON.stringify({ error: "يرجى إدخال بريد صالح ورمز من 6 خانات على الأقل" }), { status: 400, headers });
          }

          const key = cleanEmail.replace(/[^a-zA-Z0-9]/g, '_');
          const existingRes = await fbFetch(`/users/${key}.json`);
          const existing = await existingRes.json();
          if (existing) {
            return new Response(JSON.stringify({ error: "هذا البريد مسجل مسبقاً!" }), { status: 400, headers });
          }

          const userData = { email: cleanEmail, pin, isVip: false, adsDisabled: false, isAdmin: false, created: new Date().toISOString() };
          await fbFetch(`/users/${key}.json`, { method: "PUT", body: JSON.stringify(userData) });

          return new Response(JSON.stringify({ success: true }), { headers });
        } catch (e) {
          return new Response(JSON.stringify({ error: "خطأ في إنشاء الحساب" }), { status: 500, headers });
        }
      }

      // 🎬 جلب الأعمال المخصصة
      if (url.pathname === "/api/series" && request.method === "GET") {
        const res = await fbFetch("/series.json");
        const data = await res.json();
        return new Response(JSON.stringify(data || {}), { headers });
      }

      // ⚙️ جلب الإعدادات العامة
      if (url.pathname === "/api/settings" && request.method === "GET") {
        const res = await fbFetch("/settings.json");
        const data = await res.json();
        return new Response(JSON.stringify(data || {}), { headers });
      }

      // 🌐 تسجيل الزوار
      if (url.pathname === "/api/visitors" && request.method === "POST") {
        const visitorData = await request.json();
        const res = await fbFetch("/visitors.json", { method: "POST", body: JSON.stringify(visitorData) });
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers });
      }

      // ⏱️ تحديث مدة الزيارة
      if (url.pathname.startsWith("/api/visitors/duration/") && request.method === "POST") {
        const key = url.pathname.split("/").pop();
        const durationText = await request.json();
        await fbFetch(`/visitors/${key}/duration.json`, { method: "PUT", body: JSON.stringify(durationText) });
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 👁️ تسجيل المشاهدات
      if (url.pathname.startsWith("/api/visitors/watched/") && request.method === "POST") {
        const key = url.pathname.split("/").pop();
        const watchData = await request.json();
        await fbFetch(`/visitors/${key}/watched.json`, { method: "POST", body: JSON.stringify(watchData) });
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 📩 إرسال طلبات VIP
      if (url.pathname === "/api/vip-requests" && request.method === "POST") {
        const reqData = await request.json();
        await fbFetch("/vip_requests.json", { method: "POST", body: JSON.stringify(reqData) });
        return new Response(JSON.stringify({ success: true }), { headers });
      }

      // 👑 مسارات الأدمن (التحقق الأمني عبر التوكن الموقّع ديناميكياً)
      if (url.pathname.startsWith("/api/admin/")) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "").trim();
        const tokenData = await verifyToken(token);

        if (!tokenData || !tokenData.isAdmin) {
          return new Response(JSON.stringify({ error: "غير مصرح لك بالوصول إلى لوحة الإدارة!" }), { status: 403, headers });
        }

        // إحصائيات الأدمن
        if (url.pathname === "/api/admin/stats" && request.method === "GET") {
          const [vRes, uRes, sRes, bRes, rRes] = await Promise.all([
            fbFetch("/visitors.json"),
            fbFetch("/users.json"),
            fbFetch("/series.json"),
            fbFetch("/banned_users.json"),
            fbFetch("/vip_requests.json")
          ]);
          return new Response(JSON.stringify({
            visitors: await vRes.json(),
            users: await uRes.json(),
            series: await sRes.json(),
            banned: await bRes.json(),
            requests: await rRes.json()
          }), { headers });
        }

        // إضافة عمل
        if (url.pathname === "/api/admin/series" && request.method === "POST") {
          const body = await request.json();
          const id = body.title.replace(/[^a-zA-Z0-9_؀-ۿ]/g, '_').toLowerCase();
          await fbFetch(`/series/${id}.json`, { method: "PUT", body: JSON.stringify(body) });
          return new Response(JSON.stringify({ success: true }), { headers });
        }

        // حذف عمل
        if (url.pathname.startsWith("/api/admin/series/") && request.method === "DELETE") {
          const id = url.pathname.split("/").pop();
          await fbFetch(`/series/${id}.json`, { method: "DELETE" });
          return new Response(JSON.stringify({ success: true }), { headers });
        }

        // حذف طلب VIP
        if (url.pathname.startsWith("/api/admin/vip-requests/") && request.method === "DELETE") {
          const key = url.pathname.split("/").pop();
          await fbFetch(`/vip_requests/${key}.json`, { method: "DELETE" });
          return new Response(JSON.stringify({ success: true }), { headers });
        }

        // إدارة المستخدمين
        if (url.pathname.startsWith("/api/admin/users/")) {
          const parts = url.pathname.split("/");
          const userKey = parts[4];
          const action = parts[5];

          if (request.method === "DELETE") {
            await fbFetch(`/users/${userKey}.json`, { method: "DELETE" });
            return new Response(JSON.stringify({ success: true }), { headers });
          }

          if (action === "vip" && request.method === "PUT") {
            const { isVip } = await request.json();
            await fbFetch(`/users/${userKey}/isVip.json`, { method: "PUT", body: JSON.stringify(isVip) });
            return new Response(JSON.stringify({ success: true }), { headers });
          }

          if (action === "ads" && request.method === "PUT") {
            const { adsDisabled } = await request.json();
            await fbFetch(`/users/${userKey}/adsDisabled.json`, { method: "PUT", body: JSON.stringify(adsDisabled) });
            return new Response(JSON.stringify({ success: true }), { headers });
          }
        }

        // إدارة الحظر
        if (url.pathname === "/api/admin/ban" && request.method === "POST") {
          const { email } = await request.json();
          const key = email.replace(/[^a-zA-Z0-9]/g, '_');
          await fbFetch(`/banned_users/${key}.json`, { method: "PUT", body: JSON.stringify({ email, time: new Date().toLocaleString('ar-EG') }) });
          return new Response(JSON.stringify({ success: true }), { headers });
        }

        if (url.pathname.startsWith("/api/admin/ban/") && request.method === "DELETE") {
          const key = url.pathname.split("/").pop();
          await fbFetch(`/banned_users/${key}.json`, { method: "DELETE" });
          return new Response(JSON.stringify({ success: true }), { headers });
        }

        // إعدادات الإعلانات وشريط التنبيهات
        if (url.pathname === "/api/admin/settings/ads" && request.method === "PUT") {
          const { global_ads } = await request.json();
          await fbFetch("/settings/global_ads.json", { method: "PUT", body: JSON.stringify(global_ads) });
          return new Response(JSON.stringify({ success: true }), { headers });
        }

        if (url.pathname === "/api/admin/settings/banner" && request.method === "PUT") {
          const { banner } = await request.json();
          await fbFetch("/settings/banner.json", { method: "PUT", body: JSON.stringify(banner) });
          return new Response(JSON.stringify({ success: true }), { headers });
        }

        if (url.pathname === "/api/admin/settings/banner" && request.method === "DELETE") {
          await fbFetch("/settings/banner.json", { method: "DELETE" });
          return new Response(JSON.stringify({ success: true }), { headers });
        }
      }
    }

    // 3️⃣ ملفات الموقع
    return env.ASSETS ? env.ASSETS.fetch(request) : fetch(request);
  }
};
