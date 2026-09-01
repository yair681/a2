// עזרים משותפים לכל הדפים.
// ההרשאות נאכפות בשרת — הקוד כאן רק מציג את המסך הנכון ומונע מצב
// שבו משתמש רואה דף ריק אחרי שההתחברות שלו פגה.

// בריחה מתווי HTML. כל טקסט שמגיע מהמסד (שם תלמיד, שם מוצר) חייב לעבור כאן
// לפני שהוא נכנס ל-innerHTML, אחרת שם עם תו < מריץ קוד או שובר את הכפתורים.
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// עטיפה ל-fetch: שולחת עוגיות, ומחזירה למסך ההתחברות אם הסשן פג
async function api(url, options = {}) {
    const res = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...options
    });

    if (res.status === 401) {
        window.location.href = '/';
        throw new Error('unauthorized');
    }

    return res;
}

async function apiJson(url, options) {
    const res = await api(url, options);
    return res.json();
}

async function apiPost(url, body) {
    return apiJson(url, { method: 'POST', body: JSON.stringify(body || {}) });
}

// שואל את השרת מי המשתמש. אין שום ערך ב-localStorage שיכול לזייף את זה.
async function loadSession(allowedRoles) {
    let session;

    try {
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        if (!res.ok) {
            window.location.href = '/';
            return null;
        }
        session = await res.json();
    } catch (error) {
        window.location.href = '/';
        return null;
    }

    if (allowedRoles && !allowedRoles.includes(session.role)) {
        window.location.href = '/';
        return null;
    }

    return session;
}

async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (error) { /* בכל מקרה חוזרים למסך ההתחברות */ }
    sessionStorage.clear();
    localStorage.clear();
    window.location.href = '/';
}
