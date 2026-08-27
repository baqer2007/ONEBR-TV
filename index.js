import { onRequest } from "./functions/api/extract.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // توجيه طلبات السيرفرات إلى كود الاستخراج
    if (url.pathname.startsWith("/api/extract")) {
      return onRequest({ request, env, params: {}, waitUntil: ctx.waitUntil.bind(ctx), next: () => {} });
    }

    // عرض باقي صفحات وملفات الموقع
    return env.ASSETS.fetch(request);
  },
};
