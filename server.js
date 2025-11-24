require('dotenv').config(); 
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

// --- הגדרות וחיבור למסד נתונים ---
app.use(bodyParser.json());
app.use(express.static('public'));

const mongoURI = process.env.MONGO_URI; 
if (!mongoURI) {
    console.error("FATAL ERROR: MONGO_URI is not defined in the environment.");
    process.exit(1);
}

mongoose.connect(mongoURI)
    .then(() => console.log("MongoDB Connected Successfully!"))
    .catch(err => {
        console.log("Error connecting to MongoDB:", err);
        process.exit(1);
    });

// --- הגדרת המבנה של תלמיד (Schema) ---
const studentSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    balance: { type: Number, default: 0 }
});

const Student = mongoose.model('Student', studentSchema);

// --- הגדרת המבנה של מוצר בחנות ---
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    description: String,
    createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// --- הגדרת המבנה של קנייה ---
const purchaseSchema = new mongoose.Schema({
    studentId: { type: String, required: true },
    studentName: { type: String, required: true },
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    price: { type: Number, required: true },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
    createdAt: { type: Date, default: Date.now },
    approvedAt: Date
});

const Purchase = mongoose.model('Purchase', purchaseSchema);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";
const PROTECTED_EMAIL = "yairfrish2@gmail.com";
const PROTECTED_PASSWORD = "yair12345";

// --- הגדרת המבנה של מורה ---
const teacherSchema = new mongoose.Schema({
    password: { type: String, required: true, unique: true },
    name: String,
    email: String,
    isProtected: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const Teacher = mongoose.model('Teacher', teacherSchema);

// --- פונקציה לאתחול ראשוני של הכיתה ---
async function initDB() {
    try {
        // אתחול מורה מוגן (לא יופיע ברשימה)
        const protectedTeacher = await Teacher.findOne({ email: PROTECTED_EMAIL });
        if (!protectedTeacher) {
            const newProtectedTeacher = new Teacher({
                password: PROTECTED_PASSWORD,
                name: "מנהל מערכת",
                email: PROTECTED_EMAIL,
                isProtected: true
            });
            await newProtectedTeacher.save();
            console.log("Protected teacher account created.");
        }

        // אתחול הרב אליהו
        const rabbiTeacher = await Teacher.findOne({ password: "הרב אליהו 123" });
        if (!rabbiTeacher) {
            const newRabbiTeacher = new Teacher({
                password: "הרב אליהו 123",
                name: "הרב אליהו",
                email: "",
                isProtected: false
            });
            await newRabbiTeacher.save();
            console.log("Rabbi Eliyahu teacher account created.");
        }
    } catch (error) {
        console.error("Error initializing database:", error);
    }
}

mongoose.connection.on('connected', () => {
    console.log("MongoDB connection established");
    initDB();
});

mongoose.connection.on('error', (err) => {
    console.error("MongoDB connection error:", err);
});

// --- נתיבים (Routes) ---

// 1. התחברות
app.post('/api/login', async (req, res) => {
    try {
        const { code, type } = req.body;

        if (!code || !type) {
            return res.json({ success: false, message: 'נא למלא את כל השדות' });
        }

        if (type === 'admin') {
            // בדיקה ראשונה - סיסמת מורה ראשי
            if (code === ADMIN_PASSWORD) {
                return res.json({ success: true, role: 'admin' });
            } else {
                // בדיקה שנייה - מורים נוספים
                const teacher = await Teacher.findOne({ password: code });
                if (teacher) {
                    return res.json({ 
                        success: true, 
                        role: 'admin', 
                        teacherName: teacher.name,
                        teacherEmail: teacher.email,
                        isProtected: teacher.isProtected 
                    });
                } else {
                    return res.json({ success: false, message: 'סיסמה שגויה' });
                }
            }
        } else {
            const student = await Student.findOne({ id: code });
            if (student) {
                return res.json({ 
                    success: true, 
                    role: 'student', 
                    name: student.name, 
                    balance: student.balance 
                });
            } else {
                return res.json({ success: false, message: 'קוד תלמיד לא נמצא' });
            }
        }
    } catch (error) {
        console.error("Login error:", error);
        res.json({ success: false, message: 'שגיאה בהתחברות' });
    }
});

// 2. קבלת רשימת תלמידים (למורה)
app.get('/api/students', async (req, res) => {
    try {
        const students = await Student.find({}).select('id name balance').sort({ name: 1 });
        res.json(students);
    } catch (error) {
        console.error("Get students error:", error);
        res.json([]);
    }
});

// 3. עדכון יתרה
app.post('/api/update', async (req, res) => {
    try {
        const { studentId, amount } = req.body;
        
        if (!studentId || amount === undefined) {
            return res.json({ success: false, message: 'פרמטרים חסרים' });
        }
        
        const updatedStudent = await Student.findOneAndUpdate(
            { id: studentId },
            { $inc: { balance: parseInt(amount) } },
            { new: true }
        );

        if (updatedStudent) {
            res.json({ success: true, newBalance: updatedStudent.balance });
        } else {
            res.json({ success: false, message: 'תלמיד לא נמצא' });
        }
    } catch (error) {
        console.error("Update balance error:", error);
        res.json({ success: false, message: 'שגיאה בעדכון היתרה' });
    }
});

// 4. יצירת תלמיד
app.post('/api/create-student', async (req, res) => {
    try {
        const { id, name, balance } = req.body;
        
        if (!id || !name) {
            return res.json({ success: false, message: "קוד ושם תלמיד הן שדות חובה" });
        }
        
        const existingStudent = await Student.findOne({ id: id });
        if (existingStudent) {
            return res.json({ success: false, message: "קוד תלמיד זה כבר קיים במערכת" });
        }

        const newStudent = new Student({
            id: id,
            name: name,
            balance: parseInt(balance) || 0
        });

        await newStudent.save();
        res.json({ success: true, message: `התלמיד ${name} נוצר בהצלחה`, newStudent: newStudent });
    } catch (error) {
        console.error("Create student error:", error);
        res.json({ success: false, message: "שגיאה בשמירת תלמיד חדש" });
    }
});

// 5. יצירת מורה
app.post('/api/create-teacher', async (req, res) => {
    try {
        const { password, name, email } = req.body;
        
        if (!password) {
            return res.json({ success: false, message: "סיסמה הינה שדה חובה" });
        }

        // בדיקה שהסיסמה לא קיימת
        const existingTeacher = await Teacher.findOne({ password: password });
        if (existingTeacher) {
            return res.json({ success: false, message: "סיסמה זו כבר קיימת במערכת" });
        }
        
        // בדיקה שהסיסמה לא זהה לסיסמת המורה הראשי
        if (password === ADMIN_PASSWORD || password === PROTECTED_PASSWORD) {
            return res.json({ success: false, message: "לא ניתן להשתמש בסיסמת המורה הראשי" });
        }

        const newTeacher = new Teacher({
            password: password,
            name: name || '',
            email: email || '',
            isProtected: false
        });

        await newTeacher.save();
        res.json({ 
            success: true, 
            message: `המורה ${name || ''} נוצר בהצלחה. סיסמת הכניסה: ${password}` 
        });
    } catch (error) {
        console.error("Create teacher error:", error);
        res.json({ success: false, message: "שגיאה ביצירת מורה חדש" });
    }
});

// 6. קבלת יתרה אישית (לתלמיד)
app.post('/api/my-balance', async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code) {
            return res.json({ balance: 0 });
        }
        
        const student = await Student.findOne({ id: code });
        if (student) {
            res.json({ balance: student.balance });
        } else {
            res.json({ balance: 0 });
        }
    } catch (error) {
        console.error("Get balance error:", error);
        res.json({ balance: 0 });
    }
});

// --- API לחנות ---

// 7. יצירת מוצר חדש (למורה)
app.post('/api/products', async (req, res) => {
    try {
        const { name, price, description } = req.body;
        
        if (!name || !price) {
            return res.json({ success: false, message: "שם ומחיר הן שדות חובה" });
        }

        const newProduct = new Product({
            name,
            price: parseInt(price),
            description: description || ''
        });

        await newProduct.save();
        res.json({ success: true, message: `המוצר ${name} נוסף בהצלחה`, product: newProduct });
    } catch (error) {
        console.error("Create product error:", error);
        res.json({ success: false, message: "שגיאה ביצירת מוצר" });
    }
});

// 8. קבלת כל המוצרים
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find({}).sort({ createdAt: -1 });
        res.json(products);
    } catch (error) {
        console.error("Get products error:", error);
        res.json([]);
    }
});

// 9. מחיקת מוצר
app.delete('/api/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "המוצר נמחק בהצלחה" });
    } catch (error) {
        console.error("Delete product error:", error);
        res.json({ success: false, message: "שגיאה במחיקת המוצר" });
    }
});

// 10. בקשת קנייה (תלמיד)
app.post('/api/purchase', async (req, res) => {
    try {
        const { studentId, productId } = req.body;
        
        if (!studentId || !productId) {
            return res.json({ success: false, message: "פרמטרים חסרים" });
        }
        
        const student = await Student.findOne({ id: studentId });
        const product = await Product.findById(productId);
        
        if (!student) {
            return res.json({ success: false, message: "תלמיד לא נמצא" });
        }
        
        if (!product) {
            return res.json({ success: false, message: "מוצר לא נמצא" });
        }
        
        if (student.balance < product.price) {
            return res.json({ success: false, message: "אין מספיק נקודות לרכישה" });
        }
        
        const newPurchase = new Purchase({
            studentId: student.id,
            studentName: student.name,
            productId: product._id.toString(),
            productName: product.name,
            price: product.price,
            status: 'pending'
        });
        
        await newPurchase.save();
        res.json({ success: true, message: "הבקשה נשלחה למורה לאישור", purchase: newPurchase });
    } catch (error) {
        console.error("Purchase error:", error);
        res.json({ success: false, message: "שגיאה ביצירת הקנייה" });
    }
});

// 11. קבלת כל הקניות
app.get('/api/purchases', async (req, res) => {
    try {
        const purchases = await Purchase.find({}).sort({ createdAt: -1 });
        res.json(purchases);
    } catch (error) {
        console.error("Get purchases error:", error);
        res.json([]);
    }
});

// 12. קבלת קניות של תלמיד מסוים
app.get('/api/purchases/:studentId', async (req, res) => {
    try {
        const purchases = await Purchase.find({ studentId: req.params.studentId }).sort({ createdAt: -1 });
        res.json(purchases);
    } catch (error) {
        console.error("Get student purchases error:", error);
        res.json([]);
    }
});

// 13. אישור/דחיית קנייה (מורה)
app.post('/api/purchases/:id/approve', async (req, res) => {
    try {
        const { approve } = req.body;
        
        const purchase = await Purchase.findById(req.params.id);
        if (!purchase) {
            return res.json({ success: false, message: "קנייה לא נמצאה" });
        }
        
        if (purchase.status !== 'pending') {
            return res.json({ success: false, message: "הקנייה כבר טופלה" });
        }
        
        if (approve) {
            // אישור - הורדת נקודות
            const student = await Student.findOne({ id: purchase.studentId });
            if (!student) {
                return res.json({ success: false, message: "תלמיד לא נמצא" });
            }
            
            if (student.balance < purchase.price) {
                return res.json({ success: false, message: "לתלמיד אין מספיק נקודות" });
            }
            
            student.balance -= purchase.price;
            await student.save();
            
            purchase.status = 'approved';
            purchase.approvedAt = new Date();
            await purchase.save();
            
            res.json({ success: true, message: "הקנייה אושרה והנקודות הורדו" });
        } else {
            // דחייה
            purchase.status = 'rejected';
            await purchase.save();
            res.json({ success: true, message: "הקנייה נדחתה" });
        }
    } catch (error) {
        console.error("Approve purchase error:", error);
        res.json({ success: false, message: "שגיאה בעיבוד הקנייה" });
    }
});

// 14. מחיקת תלמיד
app.delete('/api/students/:id', async (req, res) => {
    try {
        const studentId = req.params.id;
        
        // מחיקת התלמיד
        const deletedStudent = await Student.findOneAndDelete({ id: studentId });
        
        if (!deletedStudent) {
            return res.json({ success: false, message: "תלמיד לא נמצא" });
        }
        
        // מחיקת כל הקניות של התלמיד
        await Purchase.deleteMany({ studentId: studentId });
        
        res.json({ success: true, message: `התלמיד ${deletedStudent.name} נמחק בהצלחה` });
    } catch (error) {
        console.error("Delete student error:", error);
        res.json({ success: false, message: "שגיאה במחיקת התלמיד" });
    }
});

// 15. מחיקת כל ההיסטוריה
app.delete('/api/purchases', async (req, res) => {
    try {
        const result = await Purchase.deleteMany({});
        res.json({ 
            success: true, 
            message: `נמחקו ${result.deletedCount} רשומות קנייה בהצלחה` 
        });
    } catch (error) {
        console.error("Delete all purchases error:", error);
        res.json({ success: false, message: "שגיאה במחיקת ההיסטוריה" });
    }
});

// 16. עדכון יתרה ידני (סכום מדויק)
app.post('/api/set-balance', async (req, res) => {
    try {
        const { studentId, balance } = req.body;
        
        if (!studentId || balance === undefined) {
            return res.json({ success: false, message: 'פרמטרים חסרים' });
        }
        
        const updatedStudent = await Student.findOneAndUpdate(
            { id: studentId },
            { balance: parseInt(balance) },
            { new: true }
        );

        if (updatedStudent) {
            res.json({ success: true, newBalance: updatedStudent.balance });
        } else {
            res.json({ success: false, message: 'תלמיד לא נמצא' });
        }
    } catch (error) {
        console.error("Set balance error:", error);
        res.json({ success: false, message: 'שגיאה בעדכון היתרה' });
    }
});

// 17. שינוי קוד תלמיד
app.post('/api/change-student-code', async (req, res) => {
    try {
        const { oldCode, newCode } = req.body;
        
        if (!oldCode || !newCode) {
            return res.json({ success: false, message: 'נא למלא את שני השדות' });
        }
        
        // בדיקה שהקוד החדש לא תפוס
        const existingStudent = await Student.findOne({ id: newCode });
        if (existingStudent) {
            return res.json({ success: false, message: 'הקוד החדש כבר תפוס במערכת' });
        }
        
        // עדכון הקוד
        const student = await Student.findOne({ id: oldCode });
        if (!student) {
            return res.json({ success: false, message: 'תלמיד לא נמצא' });
        }
        
        student.id = newCode;
        await student.save();
        
        // עדכון גם בכל הקניות
        await Purchase.updateMany(
            { studentId: oldCode },
            { studentId: newCode }
        );
        
        res.json({ 
            success: true, 
            message: `הקוד של ${student.name} שונה בהצלחה מ-${oldCode} ל-${newCode}`,
            newCode: newCode
        });
    } catch (error) {
        console.error("Change student code error:", error);
        res.json({ success: false, message: 'שגיאה בשינוי הקוד' });
    }
});

// 18. קבלת רשימת מורים (ללא החשבון המוגן)
app.get('/api/teachers', async (req, res) => {
    try {
        // מחזיר רק מורים שאינם מוגנים
        const teachers = await Teacher.find({ isProtected: false }).select('password name email createdAt').sort({ createdAt: -1 });
        res.json(teachers);
    } catch (error) {
        console.error("Get teachers error:", error);
        res.json([]);
    }
});

// 19. שינוי סיסמת מורה
app.post('/api/change-teacher-password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        
        if (!oldPassword || !newPassword) {
            return res.json({ success: false, message: 'נא למלא את שני השדות' });
        }
        
        // בדיקה שהסיסמה החדשה לא תפוסה
        const existingTeacher = await Teacher.findOne({ password: newPassword });
        if (existingTeacher) {
            return res.json({ success: false, message: 'הסיסמה החדשה כבר תפוסה במערכת' });
        }
        
        // חיפוש המורה
        const teacher = await Teacher.findOne({ password: oldPassword });
        if (!teacher) {
            return res.json({ success: false, message: 'סיסמה ישנה שגויה' });
        }
        
        // בדיקה אם זה חשבון מוגן
        if (teacher.isProtected) {
            return res.json({ success: false, message: 'לא ניתן לשנות סיסמה לחשבון מוגן זה' });
        }
        
        // עדכון הסיסמה
        teacher.password = newPassword;
        await teacher.save();
        
        res.json({ 
            success: true, 
            message: `הסיסמה של ${teacher.name || 'המורה'} שונתה בהצלחה`,
            newPassword: newPassword
        });
    } catch (error) {
        console.error("Change teacher password error:", error);
        res.json({ success: false, message: 'שגיאה בשינוי הסיסמה' });
    }
});

// 20. מחיקת מורה
app.delete('/api/teachers/:password', async (req, res) => {
    try {
        const password = req.params.password;
        
        // חיפוש המורה
        const teacher = await Teacher.findOne({ password: password });
        
        if (!teacher) {
            return res.json({ success: false, message: "מורה לא נמצא" });
        }
        
        // בדיקה אם זה חשבון מוגן
        if (teacher.isProtected) {
            return res.json({ success: false, message: "לא ניתן למחוק את החשבון המוגן הזה" });
        }
        
        // מחיקת המורה
        await Teacher.findOneAndDelete({ password: password });
        
        res.json({ success: true, message: `המורה ${teacher.name || ''} נמחק בהצלחה` });
    } catch (error) {
        console.error("Delete teacher error:", error);
        res.json({ success: false, message: "שגיאה במחיקת המורה" });
    }
});

// טיפול בשגיאות כלליות
app.use((err, req, res, next) => {
    console.error("Server error:", err);
    res.status(500).json({ success: false, message: "שגיאת שרת" });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
    console.log(`Protected account: ${PROTECTED_EMAIL}`);
});
