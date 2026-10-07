/**
 * התקנת האפליקציה ישירות מהדפדפן, בלי חנות ובלי קובץ להוריד.
 *
 * beforeinstallprompt נורה רק אחרי שהדפדפן מצא manifest תקין ו-service
 * worker רשום, ולכן ה-service worker נרשם כאן במפורש. הוא גם נורה פעם
 * אחת בלבד — ולכן שומרים את האירוע, אי אפשר לייצר אותו מחדש.
 *
 * באייפון האירוע הזה לא קיים ולא יהיה קיים: ספארי לא תומך בהתקנה
 * בלחיצה. לכן שם לא מציגים כפתור מת, אלא כותבים מחדש את השלבים כך
 * שיתארו את תפריט השיתוף.
 */

const btn = document.getElementById('install-btn');
const hint = document.getElementById('install-hint');
const fallback = document.getElementById('install-fallback');

let deferred = null;
let settled = false;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent)
  // אייפד חדש מתחזה למק, ומזוהה לפי מסך מגע
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const setHint = (text) => { hint.textContent = text; };

/** מחליף כותרת ותיאור של שלב ברשימה הממוספרת. */
function rewriteStep(id, title, detail) {
  const li = document.getElementById(id);
  if (!li) return;
  li.querySelector('b').textContent = title;
  li.querySelector('.muted').textContent = detail;
}

/**
 * הדפדפן לא מציע התקנה.
 * באייפון זו לא תקלה אלא המצב הרגיל, ולכן השלבים נכתבים מחדש במקום
 * להוסיף הערת שוליים — אחרת הרשימה מפנה לכפתור שלא קיים.
 */
function showFallback() {
  if (settled) return;
  settled = true;
  btn.hidden = true;

  if (isIOS()) {
    rewriteStep('step-1', 'פתח את תפריט השיתוף', 'הריבוע עם החץ כלפי מעלה, בתחתית המסך בספארי.');
    rewriteStep('step-2', 'בחר "הוספה למסך הבית"', 'צריך לגלול מעט ברשימה. אחר כך לחץ "הוסף".');
    setHint('באייפון ההתקנה נעשית מתוך ספארי, בשני שלבים.');
    return;
  }

  fallback.hidden = false;
  fallback.open = true;
  setHint('הדפדפן הזה לא מציע התקנה בלחיצה. אפשר להתקין ידנית מהתפריט.');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

if (isInstalled()) {
  settled = true;
  btn.hidden = true;
  setHint('האפליקציה כבר מותקנת במכשיר הזה.');
} else {
  setHint('בודק אם הדפדפן תומך בהתקנה…');

  window.addEventListener('beforeinstallprompt', (e) => {
    // בלי זה כרום מציג באנר משלו במקום הכפתור שבדף.
    e.preventDefault();
    deferred = e;
    settled = true;
    btn.hidden = false;
    btn.disabled = false;
    setHint('לחיצה אחת, וזה מותקן.');
  });

  // אם האירוע לא הגיע תוך כמה שניות, הוא כבר לא יגיע.
  setTimeout(showFallback, 3500);
}

btn.addEventListener('click', async () => {
  if (!deferred) { showFallback(); return; }
  btn.disabled = true;
  try {
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome !== 'accepted') {
      setHint('ההתקנה בוטלה. אפשר לנסות שוב.');
      btn.disabled = false;
    }
  } catch {
    showFallback();
  } finally {
    // אירוע ההתקנה תקף לשימוש אחד בלבד.
    deferred = null;
  }
});

window.addEventListener('appinstalled', () => {
  btn.hidden = true;
  if (fallback) fallback.hidden = true;
  setHint('האפליקציה הותקנה. אפשר לפתוח אותה מהמסך הראשי.');
});
