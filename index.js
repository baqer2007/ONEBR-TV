import { onRequest } from "./functions/api/extract.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // توجيه طلبات استخراج السيرفرات إلى الدالة الأصلية
    if (url.pathname.startsWith("/api/extract")) {
      return onRequest({ 
        request, 
        env, 
        params: {}, 
        waitUntil: ctx.waitUntil.bind(ctx), 
        next: () => {} 
      });
    }

    // تقديم ملفات الموقع الثابتة
    return env.ASSETS.fetch(request);
  },
};
