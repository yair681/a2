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
 * 🔴 באייפון אי אפשר להוסיף את האתר למסך הבית מתוך הקוד. אין API, אין
 * בקשת הרשאה, ואין שום דרך עקיפה — אפל חוסמת את זה בכוונה, אחרת כל אתר
 * היה שותל אייקון בטלפון. התחליף היחיד הוא להצביע למשתמש על הכפתור.
 *
 * לכן הכפתור באייפון לא נעלם אלא משנה משמעות: לחיצה עליו פותחת שכבת
 * הדרכה עם חץ אל כפתור השיתוף, במקום רשימה שהמשתמש אמור לקרוא ולזכור.
 */
let iosMode = false;

/** ספארי בלבד יודע "הוספה למסך הבית". כרום באייפון הוא ספארי בתחפושת, ולא תמיד. */
const iosBrowser = () => {
  const ua = navigator.userAgent;
  if (/CriOS/.test(ua)) return 'chrome';
  if (/FxiOS/.test(ua)) return 'firefox';
  if (/EdgiOS/.test(ua)) return 'edge';
  return 'safari';
};

function showIosSheet() {
  const sheet = document.getElementById('ios-sheet');
  const warn = document.getElementById('ios-browser-warning');
  const other = iosBrowser();
  if (warn) {
    warn.hidden = other === 'safari';
    if (other !== 'safari') {
      warn.textContent = 'הדף פתוח כרגע בדפדפן אחר. כדי להוסיף למסך הבית, פתח את הכתובת הזו בספארי.';
    }
  }
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
}

function hideIosSheet() {
  document.getElementById('ios-sheet').hidden = true;
  document.body.style.overflow = '';
}

/**
 * הדפדפן לא מציע התקנה.
 * באייפון זו לא תקלה אלא המצב הרגיל, ולכן השלבים נכתבים מחדש והכפתור
 * נשאר — רק מוביל להדרכה במקום לחלון התקנה שלא קיים.
 */
function showFallback() {
  if (settled) return;
  settled = true;

  if (isIOS()) {
    iosMode = true;
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = 'הראה לי איך להתקין';
    rewriteStep('step-1', 'פתח את תפריט השיתוף', 'הריבוע עם החץ כלפי מעלה, בתחתית המסך בספארי.');
    rewriteStep('step-2', 'בחר "הוספה למסך הבית"', 'צריך לגלול מעט ברשימה. אחר כך לחץ "הוסף".');
    setHint('באייפון ההוספה נעשית מתפריט השיתוף — לחץ ואראה לך בדיוק איפה.');
    return;
  }

  btn.hidden = true;
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
  if (iosMode) { showIosSheet(); return; }
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

document.getElementById('ios-sheet')?.addEventListener('click', (e) => {
  // סגירה בלחיצה על הרקע או על כפתור הסגירה, לא על גוף ההדרכה עצמו.
  if (e.target.id === 'ios-sheet' || e.target.dataset.close !== undefined) hideIosSheet();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideIosSheet(); });
