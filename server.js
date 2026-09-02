require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const TOKEN_COOKIE = 'cw_session';
const TOKEN_TTL = '12h';
// עלות 10 ולא 12. המכונה החינמית ב-Render מריצה bcrypt בעלות 12 בכ-2.2 שניות,
// מה שהפך כל התחברות לאיטית. ההגנה מפני ניחוש היא ממילא הגבלת הניסיונות
// (10 ל-15 דקות), לא עלות ה-hash. hash קיים בעלות 12 ימשיך לעבוד — העלות
// שמורה בתוך ה-hash עצמו.
const BCRYPT_ROUNDS = 10;

// --- בדיקת משתני סביבה חובה ---
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('FATAL ERROR: JWT_SECRET is missing or shorter than 32 characters.');
    process.exit(1);
}

const LOOKUP_SECRET = process.env.LOOKUP_SECRET || JWT_SECRET;

const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error('FATAL ERROR: MONGO_URI is not defined in the environment.');
    process.exit(1);
}

// --- מנהלי-על נטענים ממשתני סביבה בלבד, לעולם לא מהקוד ---
function loadSuperAdmins() {
    const admins = [];
    for (let i = 1; i <= 10; i++) {
        const name = process.env[`SUPERADMIN_${i}_NAME`];
        const hash = process.env[`SUPERADMIN_${i}_PASSWORD_HASH`];
        const plain = process.env[`SUPERADMIN_${i}_PASSWORD`];

        if (!name || (!hash && !plain)) continue;

        if (hash) {
            admins.push({ name, hash });
        } else {
            console.warn(`WARNING: SUPERADMIN_${i} uses a plaintext password. Run "npm run hash -- <password>" and switch to SUPERADMIN_${i}_PASSWORD_HASH.`);
            admins.push({ name, hash: bcrypt.hashSync(plain, BCRYPT_ROUNDS) });
        }
    }
    return admins;
}

const SUPER_ADMINS = loadSuperAdmins();
if (SUPER_ADMINS.length === 0) {
    console.error('FATAL ERROR: no superadmin configured. Set SUPERADMIN_1_NAME and SUPERADMIN_1_PASSWORD_HASH.');
    process.exit(1);
}

// --- הגדרות אפליקציה ---
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});

app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ limit: '5mb', extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'יותר מדי בקשות, נסה שוב בעוד כמה דקות' }
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, message: 'יותר מדי ניסיונות התחברות. נסה שוב בעוד 15 דקות.' }
});

// ההרשמה דרך קישור היא הנתיב היחיד שכותב למסד בלי התחברות,
// ולכן היא מוגבלת בנפרד ובחומרה.
const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'יותר מדי בקשות. נסה שוב בעוד כמה דקות.' }
});

mongoose.connect(mongoURI)
    .then(async () => {
        console.log('MongoDB Connected Successfully!');
        await migrateLegacyPasswords();
    })
    .catch(err => {
        console.log('Error connecting to MongoDB:', err);
        process.exit(1);
    });

// --- הגדרת המבנה של כיתה ---
const classSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true, trim: true },
    teacherPasswordHash: { type: String, required: true },
    teacherPasswordLookup: { type: String, required: true, unique: true, index: true },
    teacherName: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now }
});

const Class = mongoose.model('Class', classSchema);

// --- הגדרת המבנה של תלמיד ---
// קוד התלמיד הוא גם סיסמת ההתחברות שלו, ולכן הוא חייב להיות ייחודי בכל המערכת
// ולא רק בתוך הכיתה. אחרת שני תלמידים עם קוד 104 היו מתחברים לאותו חשבון.
const studentSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    balance: { type: Number, default: 0 },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true }
});

studentSchema.index({ classId: 1 });

const Student = mongoose.model('Student', studentSchema);

// --- הגדרת המבנה של מוצר בחנות ---
const productSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true },
    description: String,
    image: String,
    stock: { type: Number, default: 0 },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// --- הגדרת המבנה של קניה ---
const purchaseSchema = new mongoose.Schema({
    studentId: { type: String, required: true },
    studentName: { type: String, required: true },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    price: { type: Number, required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
    createdAt: { type: Date, default: Date.now },
    approvedAt: Date
});

const Purchase = mongoose.model('Purchase', purchaseSchema);

// --- הגדרת המבנה של פרס כיתתי ---
const classRewardSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    description: String,
    targetAmount: { type: Number, required: true },
    currentAmount: { type: Number, default: 0 },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    createdAt: { type: Date, default: Date.now },
    completed: { type: Boolean, default: false },
    completedAt: Date
});

const ClassReward = mongoose.model('ClassReward', classRewardSchema);

// --- הגדרת המבנה של תרומה לפרס ---
const rewardContributionSchema = new mongoose.Schema({
    rewardId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassReward', required: true },
    studentId: { type: String, required: true },
    studentName: { type: String, required: true },
    amount: { type: Number, required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    createdAt: { type: Date, default: Date.now }
});

const RewardContribution = mongoose.model('RewardContribution', rewardContributionSchema);

// --- הגדרת המבנה של קישור הרשמה ---
// המורה מייצר קישור עם מכסת הרשמות. כשהמכסה מתמלאת הקישור ננעל
// והמורה מקבל התראה שהוא יכול לסגור.
const registrationLinkSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true, index: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    maxRegistrations: { type: Number, required: true, min: 1, max: 200 },
    usedCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    limitReachedAt: Date,
    notificationDismissed: { type: Boolean, default: false }
});

registrationLinkSchema.index({ classId: 1 });

const RegistrationLink = mongoose.model('RegistrationLink', registrationLinkSchema);

// --- עזרי סיסמאות ---

// מזהה חיפוש דטרמיניסטי: מאפשר למצוא מורה לפי סיסמה בשאילתה אחת,
// בלי לעבור על כל הכיתות עם bcrypt (שהיה הופך כל התחברות ליקרה ולפגיעה ל-DoS).
function lookupHash(password) {
    return crypto.createHmac('sha256', LOOKUP_SECRET).update(String(password)).digest('hex');
}

async function passwordIsTaken(password, ignoreClassId = null) {
    const lookup = lookupHash(password);
    const query = ignoreClassId ? { teacherPasswordLookup: lookup, _id: { $ne: ignoreClassId } }
                                : { teacherPasswordLookup: lookup };

    if (await Class.exists(query)) return true;
    if (await Student.exists({ id: password })) return true;

    for (const admin of SUPER_ADMINS) {
        if (await bcrypt.compare(String(password), admin.hash)) return true;
    }
    return false;
}

// קוד התלמיד הוא גם סיסמת ההתחברות שלו, ולכן הוא חייב להיות פנוי
// בכל המערכת — גם מול קודים של תלמידים אחרים וגם מול סיסמאות מורים.
async function studentCodeError(code) {
    if (!code || code.length < 3) {
        return 'קוד התלמיד חייב להיות באורך 3 תווים לפחות';
    }
    if (code.length > 40) {
        return 'קוד התלמיד ארוך מדי';
    }
    if (await Student.exists({ id: code })) {
        return 'הקוד הזה כבר תפוס, בחר קוד אחר';
    }
    if (await Class.exists({ teacherPasswordLookup: lookupHash(code) })) {
        return 'הקוד הזה כבר תפוס, בחר קוד אחר';
    }
    // חובה: ההתחברות בודקת תלמיד לפני מנהל-על, ולכן קוד תלמיד שזהה
    // לסיסמת מנהל-על היה חוסם את המנהל מלהיכנס.
    for (const admin of SUPER_ADMINS) {
        if (await bcrypt.compare(code, admin.hash)) {
            return 'הקוד הזה כבר תפוס, בחר קוד אחר';
        }
    }
    return null;
}

// המרה חד-פעמית של סיסמאות מורים שנשמרו בטקסט גלוי בגרסה הקודמת
async function migrateLegacyPasswords() {
    try {
        const collection = mongoose.connection.collection('classes');
        const legacy = await collection.find({ teacherPassword: { $exists: true } }).toArray();

        for (const doc of legacy) {
            const plain = String(doc.teacherPassword);
            await collection.updateOne(
                { _id: doc._id },
                {
                    $set: {
                        teacherPasswordHash: await bcrypt.hash(plain, BCRYPT_ROUNDS),
                        teacherPasswordLookup: lookupHash(plain)
                    },
                    $unset: { teacherPassword: '' }
                }
            );
        }

        if (legacy.length > 0) {
            console.log(`Migrated ${legacy.length} teacher password(s) to bcrypt.`);
        }

        try {
            await collection.dropIndex('teacherPassword_1');
        } catch (e) { /* האינדקס הישן כבר לא קיים */ }
    } catch (error) {
        console.error('Password migration failed:', error.message);
    }
}

// --- אימות ---

function issueToken(res, payload) {
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
    res.cookie(TOKEN_COOKIE, token, {
        httpOnly: true,
        secure: IS_PROD,
        sameSite: 'lax',
        maxAge: 12 * 60 * 60 * 1000,
        path: '/'
    });
}

// הזהות נקראת אך ורק מהעוגייה החתומה. שום דבר שהדפדפן שולח בגוף הבקשה
// לא יכול לקבוע מי המשתמש או לאיזו כיתה יש לו גישה.
function authenticate(req, res, next) {
    const token = req.cookies[TOKEN_COOKIE];
    if (!token) {
        return res.status(401).json({ success: false, message: 'נדרשת התחברות' });
    }

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (error) {
        res.clearCookie(TOKEN_COOKIE, { path: '/' });
        return res.status(401).json({ success: false, message: 'ההתחברות פגה, יש להתחבר מחדש' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה לפעולה זו' });
        }
        next();
    };
}

const requireStaff = requireRole('teacher', 'superadmin');

// קובע על איזו כיתה הבקשה פועלת. למורה ולתלמיד הכיתה נלקחת מהטוקן בלבד,
// כך שאי אפשר להחליף classId בגוף הבקשה ולגעת בכיתה של מישהו אחר.
function withClass(req, res, next) {
    const requested = req.params.classId || req.body.classId || null;

    if (req.user.role === 'superadmin') {
        if (!requested) {
            return res.status(400).json({ success: false, message: 'לא צוינה כיתה' });
        }
        if (!mongoose.isValidObjectId(requested)) {
            return res.status(400).json({ success: false, message: 'מזהה כיתה לא תקין' });
        }
        req.classId = String(requested);
        return next();
    }

    if (requested && String(requested) !== String(req.user.classId)) {
        return res.status(403).json({ success: false, message: 'אין לך הרשאה לכיתה זו' });
    }

    req.classId = String(req.user.classId);
    next();
}

// בדיקה שמסמך (מוצר / פרס / קניה) באמת שייך לכיתה שלמשתמש יש גישה אליה
function assertSameClass(req, doc) {
    if (!doc) return false;
    if (req.user.role === 'superadmin') return true;
    return String(doc.classId) === String(req.user.classId);
}

// --- התחברות ---
app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';

        if (!code) {
            return res.json({ success: false, message: 'נא להזין סיסמה או קוד' });
        }

        // הסדר כאן הוא סדר של ביצועים, לא של חשיבות.
        // תלמידים הם רוב מוחלט של ההתחברויות, והבדיקה שלהם היא שאילתה
        // מאונדקסת אחת בלי bcrypt. קודם היא רצה אחרונה, וכל תלמיד שילם
        // שתי השוואות bcrypt של מנהלי-על לפני שהגיע תורו.
        // הקודים ייחודיים בכל המערכת (ראה studentCodeError ו-passwordIsTaken),
        // ולכן הסדר לא יכול לגרום לזיהוי שגוי.

        // תלמיד
        const student = await Student.findOne({ id: code }).populate('classId');
        if (student && student.classId) {
            issueToken(res, {
                role: 'student',
                studentId: student.id,
                name: student.name,
                classId: String(student.classId._id),
                className: student.classId.name
            });
            return res.json({
                success: true,
                role: 'student',
                name: student.name,
                className: student.classId.name
            });
        }

        // מורה — שאילתה מאונדקסת ואז השוואת bcrypt אחת בלבד
        const classDoc = await Class.findOne({ teacherPasswordLookup: lookupHash(code) });
        if (classDoc && await bcrypt.compare(code, classDoc.teacherPasswordHash)) {
            issueToken(res, {
                role: 'teacher',
                classId: String(classDoc._id),
                className: classDoc.name,
                teacherName: classDoc.teacherName
            });
            return res.json({
                success: true,
                role: 'teacher',
                className: classDoc.name,
                teacherName: classDoc.teacherName
            });
        }

        // מנהל-על — הנתיב היקר, ומי שמתחבר בו הכי מעט
        for (const admin of SUPER_ADMINS) {
            if (await bcrypt.compare(code, admin.hash)) {
                issueToken(res, { role: 'superadmin', name: admin.name });
                return res.json({ success: true, role: 'superadmin', name: admin.name });
            }
        }

        return res.json({ success: false, message: 'קוד או סיסמה שגויים' });
    } catch (error) {
        console.error('Login error:', error.message);
        res.json({ success: false, message: 'שגיאה בהתחברות' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie(TOKEN_COOKIE, { path: '/' });
    res.json({ success: true });
});

// כל דף בצד הלקוח שואל את השרת מי המשתמש, במקום להאמין ל-localStorage
app.get('/api/me', authenticate, (req, res) => {
    res.json({
        success: true,
        role: req.user.role,
        name: req.user.name,
        teacherName: req.user.teacherName || null,
        className: req.user.className || null,
        classId: req.user.classId || null,
        studentId: req.user.studentId || null
    });
});

// --- API למנהלי-על ---

app.get('/api/classes', authenticate, requireRole('superadmin'), async (req, res) => {
    try {
        // הסיסמאות לעולם לא יוצאות מהשרת — גם לא למנהל-על
        const classes = await Class.find({}).select('name teacherName createdAt').sort({ name: 1 });
        res.json(classes);
    } catch (error) {
        console.error('Get classes error:', error.message);
        res.json([]);
    }
});

app.get('/api/classes/:id', authenticate, requireRole('superadmin'), async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה כיתה לא תקין' });
        }
        const classDoc = await Class.findById(req.params.id).select('name teacherName createdAt');
        if (!classDoc) {
            return res.status(404).json({ success: false, message: 'כיתה לא נמצאה' });
        }
        res.json({ success: true, class: classDoc });
    } catch (error) {
        console.error('Get class error:', error.message);
        res.status(500).json({ success: false, message: 'שגיאה בטעינת הכיתה' });
    }
});

app.post('/api/classes', authenticate, requireRole('superadmin'), async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const teacherName = typeof req.body.teacherName === 'string' ? req.body.teacherName.trim() : '';
        const teacherPassword = typeof req.body.teacherPassword === 'string' ? req.body.teacherPassword.trim() : '';

        if (!name || !teacherPassword || !teacherName) {
            return res.json({ success: false, message: 'נא למלא את כל השדות' });
        }

        if (teacherPassword.length < 8) {
            return res.json({ success: false, message: 'סיסמת המורה חייבת להיות באורך 8 תווים לפחות' });
        }

        if (await Class.exists({ name })) {
            return res.json({ success: false, message: 'שם כיתה זה כבר קיים' });
        }

        if (await passwordIsTaken(teacherPassword)) {
            return res.json({ success: false, message: 'הסיסמה הזו כבר בשימוש במערכת, בחר סיסמה אחרת' });
        }

        const newClass = new Class({
            name,
            teacherName,
            teacherPasswordHash: await bcrypt.hash(teacherPassword, BCRYPT_ROUNDS),
            teacherPasswordLookup: lookupHash(teacherPassword)
        });
        await newClass.save();

        res.json({
            success: true,
            message: 'הכיתה נוצרה בהצלחה',
            class: { _id: newClass._id, name: newClass.name, teacherName: newClass.teacherName }
        });
    } catch (error) {
        console.error('Create class error:', error.message);
        res.json({ success: false, message: 'שגיאה ביצירת כיתה' });
    }
});

app.delete('/api/classes/:id', authenticate, requireRole('superadmin'), async (req, res) => {
    try {
        const classId = req.params.id;
        if (!mongoose.isValidObjectId(classId)) {
            return res.status(400).json({ success: false, message: 'מזהה כיתה לא תקין' });
        }

        const rewards = await ClassReward.find({ classId }).select('_id');

        await Student.deleteMany({ classId });
        await Product.deleteMany({ classId });
        await Purchase.deleteMany({ classId });
        // הפרסים והתרומות נמחקים גם הם — בגרסה הקודמת הם נשארו יתומים במסד
        await RewardContribution.deleteMany({ rewardId: { $in: rewards.map(r => r._id) } });
        await ClassReward.deleteMany({ classId });
        await RegistrationLink.deleteMany({ classId });
        await Class.findByIdAndDelete(classId);

        res.json({ success: true, message: 'הכיתה נמחקה בהצלחה' });
    } catch (error) {
        console.error('Delete class error:', error.message);
        res.json({ success: false, message: 'שגיאה במחיקת הכיתה' });
    }
});

app.put('/api/classes/:id', authenticate, requireRole('superadmin'), async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה כיתה לא תקין' });
        }

        const updateData = {};
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const teacherName = typeof req.body.teacherName === 'string' ? req.body.teacherName.trim() : '';
        const teacherPassword = typeof req.body.teacherPassword === 'string' ? req.body.teacherPassword.trim() : '';

        if (name) updateData.name = name;
        if (teacherName) updateData.teacherName = teacherName;

        if (teacherPassword) {
            if (teacherPassword.length < 8) {
                return res.json({ success: false, message: 'סיסמת המורה חייבת להיות באורך 8 תווים לפחות' });
            }
            if (await passwordIsTaken(teacherPassword, req.params.id)) {
                return res.json({ success: false, message: 'הסיסמה הזו כבר בשימוש במערכת, בחר סיסמה אחרת' });
            }
            updateData.teacherPasswordHash = await bcrypt.hash(teacherPassword, BCRYPT_ROUNDS);
            updateData.teacherPasswordLookup = lookupHash(teacherPassword);
        }

        const updatedClass = await Class.findByIdAndUpdate(req.params.id, updateData, { new: true })
            .select('name teacherName');

        if (updatedClass) {
            res.json({ success: true, class: updatedClass, message: 'הכיתה עודכנה בהצלחה' });
        } else {
            res.json({ success: false, message: 'כיתה לא נמצאה' });
        }
    } catch (error) {
        console.error('Update class error:', error.message);
        res.json({ success: false, message: 'שגיאה בעדכון הכיתה' });
    }
});

// --- API לתלמידים ---

app.get('/api/students/:classId', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const students = await Student.find({ classId: req.classId })
            .select('id name balance')
            .sort({ name: 1 });
        res.json(students);
    } catch (error) {
        console.error('Get students error:', error.message);
        res.json([]);
    }
});

app.post('/api/students', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const id = typeof req.body.id === 'string' || typeof req.body.id === 'number' ? String(req.body.id).trim() : '';
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const balance = parseInt(req.body.balance, 10);

        if (!id || !name) {
            return res.json({ success: false, message: 'קוד ושם התלמיד הם שדות חובה' });
        }

        const codeError = await studentCodeError(id);
        if (codeError) {
            return res.json({ success: false, message: codeError });
        }

        const newStudent = new Student({
            id,
            name,
            balance: Number.isFinite(balance) ? balance : 0,
            classId: req.classId
        });

        await newStudent.save();
        res.json({ success: true, message: `התלמיד ${name} נוצר בהצלחה` });
    } catch (error) {
        console.error('Create student error:', error.message);
        res.json({ success: false, message: 'שגיאה בשמירת תלמיד חדש' });
    }
});

app.post('/api/update-balance', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const studentId = typeof req.body.studentId === 'string' ? req.body.studentId.trim() : '';
        const amount = parseInt(req.body.amount, 10);

        if (!studentId || !Number.isFinite(amount)) {
            return res.json({ success: false, message: 'פרמטרים חסרים' });
        }

        const updatedStudent = await Student.findOneAndUpdate(
            { id: studentId, classId: req.classId },
            { $inc: { balance: amount } },
            { new: true }
        );

        if (updatedStudent) {
            res.json({ success: true, newBalance: updatedStudent.balance });
        } else {
            res.json({ success: false, message: 'תלמיד לא נמצא' });
        }
    } catch (error) {
        console.error('Update balance error:', error.message);
        res.json({ success: false, message: 'שגיאה בעדכון היתרה' });
    }
});

app.post('/api/set-balance', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const studentId = typeof req.body.studentId === 'string' ? req.body.studentId.trim() : '';
        const balance = parseInt(req.body.balance, 10);

        if (!studentId || !Number.isFinite(balance) || balance < 0) {
            return res.json({ success: false, message: 'פרמטרים חסרים או לא תקינים' });
        }

        const updatedStudent = await Student.findOneAndUpdate(
            { id: studentId, classId: req.classId },
            { balance },
            { new: true }
        );

        if (updatedStudent) {
            res.json({ success: true, newBalance: updatedStudent.balance });
        } else {
            res.json({ success: false, message: 'תלמיד לא נמצא' });
        }
    } catch (error) {
        console.error('Set balance error:', error.message);
        res.json({ success: false, message: 'שגיאה בעדכון היתרה' });
    }
});

app.delete('/api/students/:classId/:studentId', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const deletedStudent = await Student.findOneAndDelete({
            id: req.params.studentId,
            classId: req.classId
        });

        if (!deletedStudent) {
            return res.json({ success: false, message: 'תלמיד לא נמצא' });
        }

        await Purchase.deleteMany({ studentId: deletedStudent.id, classId: req.classId });
        await RewardContribution.deleteMany({ studentId: deletedStudent.id, classId: req.classId });

        res.json({ success: true, message: `התלמיד ${deletedStudent.name} נמחק בהצלחה` });
    } catch (error) {
        console.error('Delete student error:', error.message);
        res.json({ success: false, message: 'שגיאה במחיקת התלמיד' });
    }
});

// היתרה נקראת לפי הזהות בטוקן. תלמיד לא יכול לבקש את היתרה של מישהו אחר.
app.get('/api/my-balance', authenticate, requireRole('student'), async (req, res) => {
    try {
        const student = await Student.findOne({ id: req.user.studentId, classId: req.user.classId }).select('balance');
        res.json({ balance: student ? student.balance : 0 });
    } catch (error) {
        console.error('Get balance error:', error.message);
        res.json({ balance: 0 });
    }
});

// --- API לקישורי הרשמה ---

// יצירת קישור הרשמה חדש עם מכסה
app.post('/api/registration-links', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const maxRegistrations = parseInt(req.body.maxRegistrations, 10);

        if (!Number.isInteger(maxRegistrations) || maxRegistrations < 1 || maxRegistrations > 200) {
            return res.json({ success: false, message: 'מגבלת ההרשמה חייבת להיות מספר בין 1 ל-200' });
        }

        const link = new RegistrationLink({
            token: crypto.randomBytes(16).toString('hex'),
            classId: req.classId,
            maxRegistrations
        });
        await link.save();

        res.json({ success: true, message: 'הקישור נוצר בהצלחה', link });
    } catch (error) {
        console.error('Create registration link error:', error.message);
        res.json({ success: false, message: 'שגיאה ביצירת הקישור' });
    }
});

// רשימת הקישורים של הכיתה
app.get('/api/registration-links/:classId', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const links = await RegistrationLink.find({ classId: req.classId }).sort({ createdAt: -1 });
        res.json(links);
    } catch (error) {
        console.error('Get registration links error:', error.message);
        res.json([]);
    }
});

// מחיקת קישור — מרגע זה הוא מפסיק לעבוד
app.delete('/api/registration-links/:id', authenticate, requireStaff, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה קישור לא תקין' });
        }

        const link = await RegistrationLink.findById(req.params.id);
        if (!assertSameClass(req, link)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה לקישור זה' });
        }

        await RegistrationLink.findByIdAndDelete(link._id);
        res.json({ success: true, message: 'הקישור נמחק והוא לא יעבוד יותר' });
    } catch (error) {
        console.error('Delete registration link error:', error.message);
        res.json({ success: false, message: 'שגיאה במחיקת הקישור' });
    }
});

// סגירת ההתראה על קישור שהתמלא. הקישור עצמו נשאר.
app.post('/api/registration-links/:id/dismiss', authenticate, requireStaff, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה קישור לא תקין' });
        }

        const link = await RegistrationLink.findById(req.params.id);
        if (!assertSameClass(req, link)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה לקישור זה' });
        }

        link.notificationDismissed = true;
        await link.save();

        res.json({ success: true });
    } catch (error) {
        console.error('Dismiss notification error:', error.message);
        res.json({ success: false, message: 'שגיאה בסגירת ההתראה' });
    }
});

// --- הרשמה עצמית של תלמיד דרך קישור (ללא התחברות) ---

// בדיקת תקינות הקישור לפני הצגת הטופס
app.get('/api/register/:token', registerLimiter, async (req, res) => {
    try {
        const link = await RegistrationLink.findOne({ token: req.params.token }).populate('classId');

        if (!link || !link.classId) {
            return res.json({ valid: false, message: 'הקישור לא קיים או שהמורה ביטל אותו' });
        }

        if (link.usedCount >= link.maxRegistrations) {
            return res.json({ valid: false, message: 'הקישור מלא. פנה למורה שלך.' });
        }

        res.json({
            valid: true,
            className: link.classId.name,
            teacherName: link.classId.teacherName,
            remaining: link.maxRegistrations - link.usedCount
        });
    } catch (error) {
        console.error('Check registration link error:', error.message);
        res.json({ valid: false, message: 'שגיאה בבדיקת הקישור' });
    }
});

// ההרשמה עצמה
app.post('/api/register/:token', registerLimiter, async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';

        if (!name || !code) {
            return res.json({ success: false, message: 'נא למלא שם מלא וקוד אישי' });
        }

        if (name.length < 2 || name.length > 60) {
            return res.json({ success: false, message: 'השם המלא חייב להיות באורך 2 עד 60 תווים' });
        }

        const link = await RegistrationLink.findOne({ token: req.params.token });
        if (!link) {
            return res.json({ success: false, message: 'הקישור לא קיים או שהמורה ביטל אותו' });
        }

        const codeError = await studentCodeError(code);
        if (codeError) {
            return res.json({ success: false, message: codeError });
        }

        // תפיסת מקום במכסה לפני יצירת התלמיד. ההגדלה מותנית בכך שיש מקום,
        // כך ששתי הרשמות במקביל לא יעברו את המגבלה.
        const claimed = await RegistrationLink.findOneAndUpdate(
            { _id: link._id, $expr: { $lt: ['$usedCount', '$maxRegistrations'] } },
            { $inc: { usedCount: 1 } },
            { new: true }
        );

        if (!claimed) {
            return res.json({ success: false, message: 'הקישור מלא. פנה למורה שלך.' });
        }

        try {
            await new Student({ id: code, name, balance: 0, classId: claimed.classId }).save();
        } catch (saveError) {
            // שחרור המקום אם היצירה נכשלה, למשל אם הקוד נתפס בדיוק באותו רגע
            await RegistrationLink.findByIdAndUpdate(claimed._id, { $inc: { usedCount: -1 } });
            return res.json({ success: false, message: 'הקוד הזה כבר תפוס, בחר קוד אחר' });
        }

        if (claimed.usedCount >= claimed.maxRegistrations && !claimed.limitReachedAt) {
            claimed.limitReachedAt = new Date();
            await claimed.save();
        }

        res.json({ success: true, message: 'נרשמת בהצלחה!', code });
    } catch (error) {
        console.error('Register error:', error.message);
        res.json({ success: false, message: 'שגיאה בהרשמה' });
    }
});

// --- API לחנות ---

app.post('/api/products', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const price = parseInt(req.body.price, 10);
        const stock = parseInt(req.body.stock, 10);
        const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
        const image = typeof req.body.image === 'string' ? req.body.image : null;

        if (!name || !Number.isFinite(price) || price <= 0) {
            return res.json({ success: false, message: 'שם ומחיר חוקי הם שדות חובה' });
        }

        if (image && !/^data:image\/(png|jpe?g|gif|webp);base64,/.test(image)) {
            return res.json({ success: false, message: 'פורמט תמונה לא נתמך' });
        }

        const newProduct = new Product({
            name,
            price,
            description,
            image,
            stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
            classId: req.classId
        });

        await newProduct.save();
        res.json({ success: true, message: `המוצר ${name} נוסף בהצלחה` });
    } catch (error) {
        console.error('Create product error:', error.message);
        res.json({ success: false, message: 'שגיאה ביצירת מוצר' });
    }
});

app.get('/api/products/:classId', authenticate, withClass, async (req, res) => {
    try {
        const products = await Product.find({ classId: req.classId }).limit(100);
        res.json(products);
    } catch (error) {
        console.error('Get products error:', error.message);
        res.json([]);
    }
});

app.delete('/api/products/:id', authenticate, requireStaff, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה מוצר לא תקין' });
        }

        const product = await Product.findById(req.params.id);
        if (!assertSameClass(req, product)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה למוצר זה' });
        }

        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'המוצר נמחק בהצלחה' });
    } catch (error) {
        console.error('Delete product error:', error.message);
        res.json({ success: false, message: 'שגיאה במחיקת המוצר' });
    }
});

app.post('/api/products/:id/stock', authenticate, requireStaff, async (req, res) => {
    try {
        const stock = parseInt(req.body.stock, 10);

        if (!Number.isFinite(stock) || stock < 0) {
            return res.json({ success: false, message: 'מלאי לא תקין' });
        }

        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה מוצר לא תקין' });
        }

        const product = await Product.findById(req.params.id);
        if (!assertSameClass(req, product)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה למוצר זה' });
        }

        product.stock = stock;
        await product.save();

        res.json({ success: true, newStock: product.stock, message: 'המלאי עודכן בהצלחה' });
    } catch (error) {
        console.error('Update stock error:', error.message);
        res.json({ success: false, message: 'שגיאה בעדכון המלאי' });
    }
});

// בקשת קניה — התלמיד והכיתה נלקחים מהטוקן, לא מגוף הבקשה
app.post('/api/purchase', authenticate, requireRole('student'), async (req, res) => {
    try {
        const productId = typeof req.body.productId === 'string' ? req.body.productId : '';

        if (!mongoose.isValidObjectId(productId)) {
            return res.json({ success: false, message: 'מוצר לא נמצא' });
        }

        const student = await Student.findOne({ id: req.user.studentId, classId: req.user.classId });
        const product = await Product.findById(productId);

        if (!student) {
            return res.json({ success: false, message: 'תלמיד לא נמצא' });
        }

        if (!product || String(product.classId) !== String(req.user.classId)) {
            return res.json({ success: false, message: 'מוצר לא נמצא' });
        }

        if (product.stock <= 0) {
            return res.json({ success: false, message: 'המוצר אזל מהמלאי' });
        }

        if (student.balance < product.price) {
            return res.json({ success: false, message: 'אין מספיק נקודות לרכישה' });
        }

        const alreadyPending = await Purchase.exists({
            studentId: student.id,
            productId: product._id.toString(),
            status: 'pending'
        });

        if (alreadyPending) {
            return res.json({ success: false, message: 'כבר יש לך בקשה ממתינה על המוצר הזה' });
        }

        await new Purchase({
            studentId: student.id,
            studentName: student.name,
            productId: product._id.toString(),
            productName: product.name,
            price: product.price,
            classId: req.user.classId,
            status: 'pending'
        }).save();

        res.json({ success: true, message: 'הבקשה נשלחה למורה לאישור' });
    } catch (error) {
        console.error('Purchase error:', error.message);
        res.json({ success: false, message: 'שגיאה ביצירת הקניה' });
    }
});

app.get('/api/purchases/:classId', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const purchases = await Purchase.find({ classId: req.classId }).sort({ createdAt: -1 }).limit(500);
        res.json(purchases);
    } catch (error) {
        console.error('Get purchases error:', error.message);
        res.json([]);
    }
});

app.get('/api/my-purchases', authenticate, requireRole('student'), async (req, res) => {
    try {
        const purchases = await Purchase.find({
            classId: req.user.classId,
            studentId: req.user.studentId
        }).sort({ createdAt: -1 }).limit(100);
        res.json(purchases);
    } catch (error) {
        console.error('Get student purchases error:', error.message);
        res.json([]);
    }
});

app.post('/api/purchases/:id/approve', authenticate, requireStaff, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה קניה לא תקין' });
        }

        const purchase = await Purchase.findById(req.params.id);
        if (!assertSameClass(req, purchase)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה לקניה זו' });
        }

        // סימון הקניה כמטופלת מתבצע ראשון ובאופן אטומי, כדי ששתי לחיצות
        // אישור במקביל לא יורידו נקודות פעמיים
        const claimed = await Purchase.findOneAndUpdate(
            { _id: purchase._id, status: 'pending' },
            { status: req.body.approve ? 'approved' : 'rejected', approvedAt: new Date() },
            { new: true }
        );

        if (!claimed) {
            return res.json({ success: false, message: 'הקניה כבר טופלה' });
        }

        if (!req.body.approve) {
            return res.json({ success: true, message: 'הקניה נדחתה' });
        }

        const product = await Product.findOneAndUpdate(
            { _id: claimed.productId, stock: { $gt: 0 } },
            { $inc: { stock: -1 } },
            { new: true }
        );

        if (!product) {
            claimed.status = 'pending';
            claimed.approvedAt = undefined;
            await claimed.save();
            return res.json({ success: false, message: 'המוצר אזל מהמלאי' });
        }

        const student = await Student.findOneAndUpdate(
            { id: claimed.studentId, classId: claimed.classId, balance: { $gte: claimed.price } },
            { $inc: { balance: -claimed.price } },
            { new: true }
        );

        if (!student) {
            await Product.findByIdAndUpdate(product._id, { $inc: { stock: 1 } });
            claimed.status = 'pending';
            claimed.approvedAt = undefined;
            await claimed.save();
            return res.json({ success: false, message: 'לתלמיד אין מספיק נקודות' });
        }

        res.json({ success: true, message: 'הקניה אושרה והנקודות הורדו' });
    } catch (error) {
        console.error('Approve purchase error:', error.message);
        res.json({ success: false, message: 'שגיאה בעיבוד הקניה' });
    }
});

app.delete('/api/purchases/:classId/all', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const result = await Purchase.deleteMany({ classId: req.classId });
        res.json({ success: true, message: `נמחקו ${result.deletedCount} רשומות קניה בהצלחה` });
    } catch (error) {
        console.error('Delete all purchases error:', error.message);
        res.json({ success: false, message: 'שגיאה במחיקת ההיסטוריה' });
    }
});

// --- API לפרסים כיתתיים ---

app.get('/api/rewards/class/:classId', authenticate, withClass, async (req, res) => {
    try {
        const rewards = await ClassReward.find({ classId: req.classId }).sort({ completed: 1, createdAt: -1 });
        res.json(rewards);
    } catch (error) {
        console.error('Get rewards error:', error.message);
        res.json([]);
    }
});

app.post('/api/rewards', authenticate, requireStaff, withClass, async (req, res) => {
    try {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
        const targetAmount = parseInt(req.body.targetAmount, 10);

        if (!name || !Number.isFinite(targetAmount) || targetAmount <= 0) {
            return res.json({ success: false, message: 'נא למלא שם ויעד נקודות חוקי' });
        }

        await new ClassReward({ name, description, targetAmount, classId: req.classId }).save();
        res.json({ success: true, message: 'הפרס נוצר בהצלחה' });
    } catch (error) {
        console.error('Create reward error:', error.message);
        res.json({ success: false, message: 'שגיאה ביצירת הפרס' });
    }
});

app.delete('/api/rewards/:id', authenticate, requireStaff, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה פרס לא תקין' });
        }

        const reward = await ClassReward.findById(req.params.id);
        if (!assertSameClass(req, reward)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה לפרס זה' });
        }

        await RewardContribution.deleteMany({ rewardId: reward._id });
        await ClassReward.findByIdAndDelete(reward._id);
        res.json({ success: true, message: 'הפרס נמחק בהצלחה' });
    } catch (error) {
        console.error('Delete reward error:', error.message);
        res.json({ success: false, message: 'שגיאה במחיקת הפרס' });
    }
});

app.put('/api/rewards/:id', authenticate, requireStaff, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: 'מזהה פרס לא תקין' });
        }

        const reward = await ClassReward.findById(req.params.id);
        if (!assertSameClass(req, reward)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה לפרס זה' });
        }

        const updateData = {};
        if (typeof req.body.name === 'string' && req.body.name.trim()) updateData.name = req.body.name.trim();
        if (typeof req.body.description === 'string') updateData.description = req.body.description.trim();

        if (req.body.targetAmount !== undefined) {
            const targetAmount = parseInt(req.body.targetAmount, 10);
            if (!Number.isFinite(targetAmount) || targetAmount <= 0) {
                return res.json({ success: false, message: 'יעד נקודות לא תקין' });
            }
            updateData.targetAmount = targetAmount;
        }

        const updatedReward = await ClassReward.findByIdAndUpdate(reward._id, updateData, { new: true });
        res.json({ success: true, reward: updatedReward });
    } catch (error) {
        console.error('Update reward error:', error.message);
        res.json({ success: false, message: 'שגיאה בעדכון הפרס' });
    }
});

app.post('/api/rewards/:id/contribute', authenticate, requireRole('student'), async (req, res) => {
    try {
        const amount = parseInt(req.body.amount, 10);

        // בגרסה הקודמת סכום שלילי עבר את הבדיקה והוסיף נקודות לתלמיד
        if (!Number.isInteger(amount) || amount <= 0) {
            return res.json({ success: false, message: 'סכום תרומה לא תקין' });
        }

        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.json({ success: false, message: 'פרס לא נמצא' });
        }

        const reward = await ClassReward.findById(req.params.id);
        if (!reward || String(reward.classId) !== String(req.user.classId)) {
            return res.json({ success: false, message: 'פרס לא נמצא' });
        }

        if (reward.completed) {
            return res.json({ success: false, message: 'הפרס כבר הושג!' });
        }

        // ניכוי אטומי: השורה מתעדכנת רק אם באמת יש מספיק נקודות ברגע הכתיבה
        const student = await Student.findOneAndUpdate(
            { id: req.user.studentId, classId: req.user.classId, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { new: true }
        );

        if (!student) {
            return res.json({ success: false, message: 'אין מספיק נקודות לתרומה' });
        }

        await new RewardContribution({
            rewardId: reward._id,
            studentId: student.id,
            studentName: student.name,
            amount,
            classId: req.user.classId
        }).save();

        const updatedReward = await ClassReward.findByIdAndUpdate(
            reward._id,
            { $inc: { currentAmount: amount } },
            { new: true }
        );

        if (!updatedReward.completed && updatedReward.currentAmount >= updatedReward.targetAmount) {
            updatedReward.completed = true;
            updatedReward.completedAt = new Date();
            await updatedReward.save();
        }

        res.json({
            success: true,
            message: 'התרומה נוספה בהצלחה!',
            newBalance: student.balance,
            rewardCurrentAmount: updatedReward.currentAmount,
            rewardCompleted: updatedReward.completed
        });
    } catch (error) {
        console.error('Contribute to reward error:', error.message);
        res.json({ success: false, message: 'שגיאה בתרומה לפרס' });
    }
});

app.get('/api/rewards/:id/stats', authenticate, async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.json({ totalContributions: 0, totalAmount: 0 });
        }

        const reward = await ClassReward.findById(req.params.id).select('classId');
        if (!assertSameClass(req, reward)) {
            return res.status(403).json({ success: false, message: 'אין לך הרשאה לפרס זה' });
        }

        const contributions = await RewardContribution.find({ rewardId: req.params.id }).select('amount');
        res.json({
            totalContributions: contributions.length,
            totalAmount: contributions.reduce((sum, c) => sum + c.amount, 0)
        });
    } catch (error) {
        console.error('Get reward stats error:', error.message);
        res.json({ totalContributions: 0, totalAmount: 0 });
    }
});

// --- נתיב API לא מוכר ---
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, message: 'נתיב לא נמצא' });
});

// --- טיפול בשגיאות כלליות ---
app.use((err, req, res, next) => {
    console.error('Server error:', err.message);
    res.status(500).json({ success: false, message: 'שגיאת שרת' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
