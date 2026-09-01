// שרת פיתוח מקומי עם מסד נתונים זמני בזיכרון ונתוני דמו.
// הרצה:  node scripts/dev-server.js
// לא נוגע בשום מסד נתונים אמיתי.

const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.DEV_PORT || 4321;

(async function run() {
    const mongo = await MongoMemoryServer.create();
    const uri = mongo.getUri('classwallet_dev');

    const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            MONGO_URI: uri,
            JWT_SECRET: 'dev-only-secret-that-is-long-enough-for-checks',
            LOOKUP_SECRET: 'dev-only-lookup-secret',
            SUPERADMIN_1_NAME: 'מנהל דמו',
            SUPERADMIN_1_PASSWORD_HASH: bcrypt.hashSync('demo-super-admin', 10),
            NODE_ENV: 'development',
            RENDER: ''
        },
        stdio: 'inherit'
    });

    // זריעת נתוני דמו דרך ה-API, בדיוק כמו משתמש אמיתי
    let cookie = null;
    async function call(method, url, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers.Cookie = cookie;
        const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body)
        });
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) cookie = setCookie.split(';')[0];
        return res.json().catch(() => null);
    }

    for (let i = 0; i < 100; i++) {
        try {
            await fetch(`http://127.0.0.1:${PORT}/api/me`);
            break;
        } catch (e) {
            await new Promise(r => setTimeout(r, 300));
        }
    }

    await call('POST', '/api/login', { code: 'demo-super-admin' });
    const cls = await call('POST', '/api/classes', {
        name: "כיתה ו' 1", teacherName: 'רונית לוי', teacherPassword: 'morah-ronit-1'
    });

    const classId = cls.class._id;
    await call('POST', '/api/students', { id: '10401', name: 'דני כהן', balance: 120, classId });
    await call('POST', '/api/students', { id: '10402', name: "שרה <script>alert('xss')</script>", balance: 75, classId });
    await call('POST', '/api/students', { id: '10403', name: "יוסי או'brien", balance: 40, classId });
    await call('POST', '/api/products', { name: 'עיפרון מיוחד', price: 30, stock: 10, description: 'עיפרון יפה', classId });
    await call('POST', '/api/rewards', { name: 'טיול כיתתי', targetAmount: 1000, description: 'טיול סוף שנה', classId });

    console.log('\n=================================================');
    console.log(`  שרת דמו:  http://localhost:${PORT}`);
    console.log('  מנהל-על:  demo-super-admin');
    console.log('  מורה:     morah-ronit-1');
    console.log('  תלמיד:    10401');
    console.log('=================================================\n');

    process.on('SIGINT', async () => {
        server.kill();
        await mongo.stop();
        process.exit(0);
    });
})();
