// בדיקת אבטחה מקצה לקצה מול השרת האמיתי, על מסד נתונים זמני בזיכרון.
// הרצה:  node scripts/security-smoke-test.js
//
// הבדיקה מדמה בדיוק את מה שהחבר עשה: פנייה ל-API בלי התחברות תקפה,
// וגם ניסיונות של מורה לגעת בכיתה אחרת ושל תלמיד להדפיס לעצמו נקודות.

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
        console.log(`  PASS  ${name}`);
    } else {
        failed++;
        console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    }
}

// לקוח HTTP קטן ששומר עוגיות, כמו דפדפן
function makeClient() {
    let cookie = null;
    return async function request(method, url, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers.Cookie = cookie;

        const res = await fetch(BASE + url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });

        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];

        let data = null;
        try { data = await res.json(); } catch (e) { /* לא JSON */ }
        return { status: res.status, data };
    };
}

async function waitForServer(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(BASE + '/api/me');
            if (res.status === 401) return true;
        } catch (e) { /* עדיין עולה */ }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('השרת לא עלה בזמן');
}

(async function run() {
    const mongo = await MongoMemoryServer.create();

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            MONGO_URI: mongo.getUri('classwallet_test'),
            JWT_SECRET: 'test-secret-that-is-definitely-long-enough-32',
            LOOKUP_SECRET: 'test-lookup-secret',
            SUPERADMIN_1_NAME: 'בודק',
            SUPERADMIN_1_PASSWORD_HASH: bcrypt.hashSync('super-secret-admin-pw', 10),
            NODE_ENV: 'test',
            RENDER: ''
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    server.stderr.on('data', d => process.stderr.write('[server] ' + d));

    try {
        await waitForServer();

        // ============ 1. גישה ללא התחברות ============
        console.log('\n1. גישה ללא התחברות (מה שהחבר עשה)');
        const anon = makeClient();

        check('GET /api/me חוסם', (await anon('GET', '/api/me')).status === 401);
        check('GET /api/classes חוסם', (await anon('GET', '/api/classes')).status === 401);
        check('POST /api/classes חוסם',
            (await anon('POST', '/api/classes', { name: 'x', teacherName: 'y', teacherPassword: 'zzzzzzzz' })).status === 401);
        check('POST /api/update-balance חוסם',
            (await anon('POST', '/api/update-balance', { studentId: '104', classId: '000000000000000000000000', amount: 9999 })).status === 401);
        check('DELETE /api/classes/:id חוסם',
            (await anon('DELETE', '/api/classes/000000000000000000000000')).status === 401);
        check('GET /users-list.html כבר לא קיים',
            (await fetch(BASE + '/users-list.html')).status === 404);

        // ============ 2. התחברות מנהל-על ============
        console.log('\n2. מנהל-על');
        const admin = makeClient();

        check('סיסמה שגויה נדחית',
            (await admin('POST', '/api/login', { code: 'not-the-password' })).data.success === false);

        const adminLogin = await admin('POST', '/api/login', { code: 'super-secret-admin-pw' });
        check('התחברות מנהל-על מצליחה', adminLogin.data.success === true && adminLogin.data.role === 'superadmin');

        const classA = await admin('POST', '/api/classes', { name: 'כיתה א', teacherName: 'מורה א', teacherPassword: 'teacher-a-pass' });
        const classB = await admin('POST', '/api/classes', { name: 'כיתה ב', teacherName: 'מורה ב', teacherPassword: 'teacher-b-pass' });
        check('יצירת שתי כיתות', classA.data.success && classB.data.success);

        const classAId = classA.data.class._id;
        const classBId = classB.data.class._id;

        const classList = await admin('GET', '/api/classes');
        check('רשימת הכיתות לא מכילה סיסמאות',
            JSON.stringify(classList.data).includes('assword') === false,
            JSON.stringify(classList.data).slice(0, 120));

        check('סיסמת מורה קצרה נדחית',
            (await admin('POST', '/api/classes', { name: 'כיתה ג', teacherName: 'מורה ג', teacherPassword: 'short' })).data.success === false);

        check('סיסמת מורה כפולה נדחית',
            (await admin('POST', '/api/classes', { name: 'כיתה ד', teacherName: 'מורה ד', teacherPassword: 'teacher-a-pass' })).data.success === false);

        // תלמידים
        await admin('POST', '/api/students', { id: '10401', name: 'דני', balance: 100, classId: classAId });
        await admin('POST', '/api/students', { id: '20501', name: 'רוני', balance: 50, classId: classBId });
        check('קוד תלמיד כפול נדחה',
            (await admin('POST', '/api/students', { id: '10401', name: 'כפול', balance: 0, classId: classBId })).data.success === false);

        // ============ 3. מורה ============
        console.log('\n3. מורה — בידוד בין כיתות');
        const teacherA = makeClient();
        const tLogin = await teacherA('POST', '/api/login', { code: 'teacher-a-pass' });
        check('התחברות מורה מצליחה', tLogin.data.success === true && tLogin.data.role === 'teacher');

        check('מורה לא רואה את רשימת הכיתות', (await teacherA('GET', '/api/classes')).status === 403);
        check('מורה לא יכול ליצור כיתה',
            (await teacherA('POST', '/api/classes', { name: 'כיתה שלי', teacherName: 'אני', teacherPassword: 'aaaaaaaaaa' })).status === 403);
        check('מורה לא יכול למחוק כיתה', (await teacherA('DELETE', `/api/classes/${classBId}`)).status === 403);

        check('מורה א לא רואה תלמידים של כיתה ב',
            (await teacherA('GET', `/api/students/${classBId}`)).status === 403);
        check('מורה א לא יכול לשנות יתרה בכיתה ב',
            (await teacherA('POST', '/api/update-balance', { studentId: '20501', classId: classBId, amount: 500 })).status === 403);

        const ownStudents = await teacherA('GET', `/api/students/${classAId}`);
        check('מורה א רואה את התלמידים שלו', Array.isArray(ownStudents.data) && ownStudents.data.length === 1);

        const bumped = await teacherA('POST', '/api/update-balance', { studentId: '10401', classId: classAId, amount: 10 });
        check('מורה א מעדכן יתרה בכיתה שלו', bumped.data.success === true && bumped.data.newBalance === 110);

        const zeroed = await teacherA('POST', '/api/set-balance', { studentId: '10401', classId: classAId, balance: 0 });
        check('אפשר לאפס יתרה ל-0', zeroed.data.success === true && zeroed.data.newBalance === 0);

        await teacherA('POST', '/api/set-balance', { studentId: '10401', classId: classAId, balance: 100 });

        // ============ 4. תלמיד ============
        console.log('\n4. תלמיד');
        const student = makeClient();
        const sLogin = await student('POST', '/api/login', { code: '10401' });
        check('התחברות תלמיד מצליחה', sLogin.data.success === true && sLogin.data.role === 'student');

        const bal = await student('GET', '/api/my-balance');
        check('תלמיד רואה את היתרה שלו', bal.data.balance === 100);

        check('תלמיד לא יכול לשנות יתרה',
            (await student('POST', '/api/update-balance', { studentId: '10401', classId: classAId, amount: 1000 })).status === 403);
        check('תלמיד לא רואה רשימת תלמידים',
            (await student('GET', `/api/students/${classAId}`)).status === 403);
        check('תלמיד לא רואה מוצרים של כיתה אחרת',
            (await student('GET', `/api/products/${classBId}`)).status === 403);
        check('תלמיד לא יכול למחוק היסטוריה',
            (await student('DELETE', `/api/purchases/${classAId}/all`)).status === 403);

        // ============ 5. הבאג של התרומה השלילית ============
        console.log('\n5. תרומה לפרס');
        const reward = await teacherA('POST', '/api/rewards', { name: 'טיול', targetAmount: 1000, classId: classAId });
        check('מורה יוצר פרס', reward.data.success === true);

        const rewards = await student('GET', `/api/rewards/class/${classAId}`);
        const rewardId = rewards.data[0]._id;

        const negative = await student('POST', `/api/rewards/${rewardId}/contribute`, { amount: -500 });
        const afterNegative = await student('GET', '/api/my-balance');
        check('תרומה שלילית נדחית', negative.data.success === false);
        check('היתרה לא עלתה אחרי ניסיון התרומה השלילית', afterNegative.data.balance === 100,
            `balance=${afterNegative.data.balance}`);

        check('תרומה גדולה מהיתרה נדחית',
            (await student('POST', `/api/rewards/${rewardId}/contribute`, { amount: 5000 })).data.success === false);

        const goodContribution = await student('POST', `/api/rewards/${rewardId}/contribute`, { amount: 40 });
        check('תרומה תקינה עוברת', goodContribution.data.success === true && goodContribution.data.newBalance === 60);

        // ============ 6. קניה בחנות ============
        console.log('\n6. חנות');
        await teacherA('POST', '/api/products', { name: 'עיפרון', price: 30, stock: 1, classId: classAId });
        const products = await student('GET', `/api/products/${classAId}`);
        const productId = products.data[0]._id;

        const purchase = await student('POST', '/api/purchase', { productId });
        check('תלמיד מבקש לקנות', purchase.data.success === true);

        const pending = await teacherA('GET', `/api/purchases/${classAId}`);
        const purchaseId = pending.data[0]._id;

        // שני אישורים במקביל — רק אחד אמור לרדת מהיתרה
        const [first, second] = await Promise.all([
            teacherA('POST', `/api/purchases/${purchaseId}/approve`, { approve: true }),
            teacherA('POST', `/api/purchases/${purchaseId}/approve`, { approve: true })
        ]);
        const approvedCount = [first, second].filter(r => r.data.success).length;
        check('אישור כפול במקביל מתקבל פעם אחת בלבד', approvedCount === 1,
            `approved=${approvedCount}`);

        const finalBalance = await student('GET', '/api/my-balance');
        check('הנקודות ירדו פעם אחת בלבד', finalBalance.data.balance === 30,
            `balance=${finalBalance.data.balance}`);

        // ============ 7. קישורי הרשמה ============
        console.log('\n7. קישורי הרשמה');

        check('אנונימי לא יכול ליצור קישור',
            (await anon('POST', '/api/registration-links', { maxRegistrations: 5, classId: classAId })).status === 401);
        check('אנונימי לא רואה את רשימת הקישורים',
            (await anon('GET', `/api/registration-links/${classAId}`)).status === 401);
        check('תלמיד לא יכול ליצור קישור',
            (await student('POST', '/api/registration-links', { maxRegistrations: 5, classId: classAId })).status === 403);
        check('מורה א לא יכול ליצור קישור לכיתה ב',
            (await teacherA('POST', '/api/registration-links', { maxRegistrations: 5, classId: classBId })).status === 403);

        check('מכסה לא חוקית נדחית',
            (await teacherA('POST', '/api/registration-links', { maxRegistrations: 0, classId: classAId })).data.success === false);

        const linkRes = await teacherA('POST', '/api/registration-links', { maxRegistrations: 2, classId: classAId });
        check('מורה יוצר קישור עם מכסה 2', linkRes.data.success === true);

        const token = linkRes.data.link.token;
        const linkId = linkRes.data.link._id;

        const info = await anon('GET', `/api/register/${token}`);
        check('הקישור תקף ומחזיר את שם הכיתה', info.data.valid === true && info.data.className === 'כיתה א');
        check('הקישור מדווח על 2 מקומות פנויים', info.data.remaining === 2);
        check('הקישור לא חושף את סיסמת המורה',
            JSON.stringify(info.data).includes('assword') === false);

        check('טוקן מומצא נדחה',
            (await anon('GET', '/api/register/deadbeefdeadbeefdeadbeefdeadbeef')).data.valid === false);

        const reg1 = await anon('POST', `/api/register/${token}`, { name: 'תלמיד ראשון', code: '77701' });
        check('הרשמה ראשונה מצליחה', reg1.data.success === true && reg1.data.code === '77701');

        check('קוד תפוס נדחה',
            (await anon('POST', `/api/register/${token}`, { name: 'מישהו', code: '10401' })).data.success === false);
        check('קוד קצר מדי נדחה',
            (await anon('POST', `/api/register/${token}`, { name: 'מישהו', code: 'ab' })).data.success === false);
        check('שם ריק נדחה',
            (await anon('POST', `/api/register/${token}`, { name: '', code: '77709' })).data.success === false);

        const reg2 = await anon('POST', `/api/register/${token}`, { name: 'תלמיד שני', code: '77702' });
        check('הרשמה שנייה מצליחה', reg2.data.success === true);

        const reg3 = await anon('POST', `/api/register/${token}`, { name: 'תלמיד שלישי', code: '77703' });
        check('הרשמה שלישית נחסמת — המכסה מלאה', reg3.data.success === false);

        check('הקישור המלא מדווח שהוא נעול',
            (await anon('GET', `/api/register/${token}`)).data.valid === false);

        const afterReg = await teacherA('GET', `/api/students/${classAId}`);
        check('שני התלמידים נוספו לכיתה של המורה', afterReg.data.length === 3,
            `count=${afterReg.data.length}`);

        const links = await teacherA('GET', `/api/registration-links/${classAId}`);
        check('הקישור מסומן כמלא עם התראה פתוחה',
            links.data[0].usedCount === 2 && !!links.data[0].limitReachedAt && links.data[0].notificationDismissed === false);

        await teacherA('POST', `/api/registration-links/${linkId}/dismiss`);
        const afterDismiss = await teacherA('GET', `/api/registration-links/${classAId}`);
        check('סגירת ההתראה נשמרת', afterDismiss.data[0].notificationDismissed === true);

        // תלמיד שנרשם לבד יכול להתחבר
        const selfStudent = makeClient();
        const selfLogin = await selfStudent('POST', '/api/login', { code: '77701' });
        check('תלמיד שנרשם דרך הקישור מתחבר', selfLogin.data.success === true && selfLogin.data.role === 'student');
        check('הוא שויך לכיתה הנכונה', selfLogin.data.className === 'כיתה א');

        // מחיקת קישור
        check('מורה ב לא יכול למחוק קישור של כיתה א',
            (await (async () => {
                const teacherB = makeClient();
                await teacherB('POST', '/api/login', { code: 'teacher-b-pass' });
                return teacherB('DELETE', `/api/registration-links/${linkId}`);
            })()).status === 403);

        check('מורה א מוחק את הקישור שלו',
            (await teacherA('DELETE', `/api/registration-links/${linkId}`)).data.success === true);
        check('אחרי מחיקה הקישור לא עובד',
            (await anon('GET', `/api/register/${token}`)).data.valid === false);
        check('אחרי מחיקה אי אפשר להירשם דרכו',
            (await anon('POST', `/api/register/${token}`, { name: 'מאוחר', code: '77708' })).data.success === false);

        // ============ 8. יציאה ============
        console.log('\n8. יציאה');
        await student('POST', '/api/logout');
        check('אחרי יציאה הסשן נסגר', (await student('GET', '/api/my-balance')).status === 401);

        console.log(`\n=================================`);
        console.log(`עברו: ${passed} | נכשלו: ${failed}`);
        console.log(`=================================`);
    } catch (error) {
        console.error('\nהבדיקה נפלה:', error);
        failed++;
    } finally {
        server.kill();
        await mongo.stop();
        process.exit(failed > 0 ? 1 : 0);
    }
})();
