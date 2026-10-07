/* Service worker מינימלי.
 *
 * הוא קיים מסיבה אחת: כרום מציע התקנה רק לאתר שיש לו manifest תקין
 * וגם service worker רשום עם מטפל fetch. בלעדיו הכפתור "התקנת
 * האפליקציה" פשוט לא יופיע לעולם.
 *
 * 🔴 בכוונה אין כאן שום מטמון. הארנק מציג יתרת נקודות ומלאי פרסים —
 * מספר ישן שנשמר במטמון גרוע בהרבה ממסך שנטען רגע יותר לאט. תלמיד
 * שרואה 40 נקודות שכבר הוציא, או פרס שכבר אזל, זו תקלה ולא נוחות.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  // ניקוי מטמונים מגרסאות קודמות, אם אי פעם יהיו.
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// מעביר הכל לרשת כמו שהוא. המטפל נדרש כדי שההתקנה תוצע, ולא כדי לשמור.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
