require('dotenv').config(); 
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const path = require('path'); // מודול חובה לניהול נתיבים בשרת
const app = express();
const PORT = process.env.PORT || 3000;

// --- הגדרות וחיבור למסד הנתונים ---
app.use(bodyParser.json());

// **תיקון סופי:** מגיש קבצים סטטיים מהתיקייה הנוכחית באמצעות path.resolve
app.use(express.static(path.resolve(__dirname)));

const mongoURI = process.env.MONGO_URI; 
if (!mongoURI) {
    console.error("FATAL ERROR: MONGO_URI is not defined in the environment.");
    process.exit(1);
}

mongoose.connect(mongoURI)
    .then(() => console.log("MongoDB Connected Successfully!"))
    .catch(err => console.log("Error connecting to MongoDB:", err));

// --- הגדרת המבנה של תלמיד (Schema) ---
const studentSchema = new mongoose.Schema({
    id: String,      // קוד תלמיד אישי
    name: String,    // שם מלא
    balance: Number  // יתרה נוכחית
});

const Student = mongoose.model('Student', studentSchema);

// --- הגדרת המבנה של מוצר בחנות ---
const productSchema = new mongoose.Schema({
    name: String,       // שם המוצר
    price: Number,      // מחיר בנקודות
    description: String, // תיאור
    createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// --- הגדרת המבנה של קנייה ---
const purchaseSchema = new mongoose.Schema({
    studentId: String,   // קוד התלמיד
    studentName: String, // שם התלמיד
    productId: String,   // מזהה המוצר
    productName: String, // שם המוצר
    price: Number,       // מחיר בזמן הקנייה
    status: { type: String, default: 'pending' }, // pending / approved / rejected
    createdAt: { type: Date, default: Date.now },
    approvedAt: Date
});

const Purchase = mongoose.model('Purchase', purchaseSchema);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";

// --- הגדרת המבנה של מורה ---
const teacherSchema = new mongoose.Schema({
    password: String,    // סיסמה ייחודית
    name: String,        // שם המורה (אופציונלי)
    createdAt: { type: Date, default: Date.now }
});

const Teacher = mongoose.model('Teacher', teacherSchema);

// --- פונקציה לאתחול ראשוני של הכיתה ---
async function initDB() {
    const count = await Student.countDocuments();
    if (count === 0) {
        console.log("Initializing Database with initial students...");
        const initialStudents = [
            { id: "101", name: "יוסי כהן", balance: 50 },
            { id: "102", name: "דני לוי", balance: 120 },
            { id: "103", name: "אריאל מזרחי", balance: 85 }
        ];
        await Student.insertMany(initialStudents);
        console.log("Database initialization complete.");
    }
}
mongoose.connection.on('connected', initDB);

// --- נתיבים (Routes) ---

// נתיב ראשי
app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'index.html')); // path.resolve
});

// נתיבים ספציפיים לקבצי HTML
app.get('/admin.html', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'admin.html')); // path.resolve
});

app.get('/student.html', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'student.html')); // path.resolve
});

app.get('/shop-admin.html', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'shop-admin.html')); // path.resolve
});

app.get('/shop-student.html', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'shop-student.html')); // path.resolve
});

// 1. התחברות
app.post('/api/login', async (req, res) => {
    const { code, type } = req.body;

    if (type === 'admin') {
        // בדיקה ראשונה - סיסמת מורה ראשי
        if (code === ADMIN_PASSWORD) {
            res.json({ success: true, role: 'admin' });
        } else {
            // בדיקה שנייה - מורים נוספים
            const teacher = await Teacher.findOne({ password: code });
            if (teacher) {
                res.json({ success: true, role: 'admin', teacherName: teacher.name });
            } else {
                res.json({ success: false, message: 'סיסמה שגויה' });
            }
        }
    } else {
        const student = await Student.findOne({ id: code });
        if (student) {
            res.json({ success: true, role: 'student', name: student.name, balance: student.balance });
        } else {
            res.json({ success: false, message: 'קוד תלמיד לא נמצא' });
        }
    }
});

// 2. קבלת רשימת תלמידים (למורה)
app.get('/api/students', async (req, res) => {
    const students = await Student.find({}).select('id name balance');
    res.json(students);
});

// 3. עדכון יתרה
app.post('/api/update', async (req, res) => {
    const { studentId, amount } = req.body;
    
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
});

// 4. יצירת תלמיד
app.post('/api/create-student', async (req, res) => {
    const { id, name, balance } = req.body;
    
    const existingStudent = await Student.findOne({ id: id });
    if (existingStudent) {
        return res.json({ success: false, message: "קוד תלמיד זה כבר קיים במערכת." });
    }

    const newStudent = new Student({
        id: id,
        name: name,
        balance: parseInt(balance) || 0
    });

    try {
        await newStudent.save();
        res.json({ success: true, message: `התלמיד ${name} נוצר בהצלחה.`, newStudent: newStudent });
    } catch (error) {
        res.json({ success: false, message: "שגיאה בשמירת תלמיד חדש." });
    }
});

// 4.5. יצירת מורה
app.post('/api/create-teacher', async (req, res) => {
    const { password, name } = req.body;
    
    if (!password) {
        return res.json({ success: false, message: "סיסמה היא שדה חובה." });
    }

    // בדיקה שהסיסמה לא קיימת
    const existingTeacher = await Teacher.findOne({ password: password });
    if (existingTeacher) {
        return res.json({ success: false, message: "סיסמה זו כבר קיימת במערכת." });
    }
    
    // בדיקה שהסיסמה לא זהה לסיסמת המורה הראשי
    if (password === ADMIN_PASSWORD) {
        return res.json({ success: false, message: "לא ניתן להשתמש בסיסמת המורה הראשי." });
    }

    const newTeacher = new Teacher({
        password: password,
        name: name || ''
    });

    try {
        await newTeacher.save();
        res.json({ success: true, message: `המורה ${name || ''} נוצר בהצלחה. סיסמת הכניסה: ${password}` });
    } catch (error) {
        res.json({ success: false, message: "שגיאה ביצירת מורה חדש." });
    }
});

// 5. קבלת יתרה אישית (לתלמיד)
app.post('/api/my-balance', async (req, res) => {
    const { code } = req.body;
    const student = await Student.findOne({ id: code });
    if(student) {
        res.json({ balance: student.balance });
    } else {
        res.json({ balance: 0 });
    }
});

// --- API לחנות ---

// 6. יצירת מוצר חדש (למורה)
app.post('/api/products', async (req, res) => {
    const { name, price, description } = req.body;
    
    if (!name || !price) {
        return res.json({ success: false, message: "שם ומחיר הם שדות חובה" });
    }

    const newProduct = new Product({
        name,
        price: parseInt(price),
        description: description || ''
    });

    try {
        await newProduct.save();
        res.json({ success: true, message: `המוצר ${name} נוסף בהצלחה`, product: newProduct });
    } catch (error) {
        res.json({ success: false, message: "שגיאה ביצירת מוצר" });
    }
});

// 7. קבלת כל המוצרים
app.get('/api/products', async (req, res) => {
    const products = await Product.find({}).sort({ createdAt: -1 });
    res.json(products);
});

// 8. מחיקת מוצר
app.delete('/api/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "המוצר נמחק בהצלחה" });
    } catch (error) {
        res.json({ success: false, message: "שגיאה במחיקת המוצר" });
    }
});

// 9. בקשת קנייה (תלמיד)
app.post('/api/purchase', async (req, res) => {
    const { studentId, productId } = req.body;
    
    const student = await Student.findOne({ id: studentId });
    const product = await Product.findById(productId);
    
    if (!student || !product) {
        return res.json({ success: false, message: "תלמיד או מוצר לא נמצא" });
    }
    
    if (student.balance < product.price) {
        return res.json({ success: false, message: "אין מספיק נקודות לרכישה" });
    }
    
    const newPurchase = new Purchase({
        studentId: student.id,
        studentName: student.name,
        productId: product._id,
        productName: product.name,
        price: product.price,
        status: 'pending'
    });
    
    try {
        await newPurchase.save();
        res.json({ success: true, message: "הבקשה נשלחה למורה לאישור", purchase: newPurchase });
    } catch (error) {
        res.json({ success: false, message: "שגיאה ביצירת הקנייה" });
    }
});

// 10. קבלת כל הקניות
app.get('/api/purchases', async (req, res) => {
    const purchases = await Purchase.find({}).sort({ createdAt: -1 });
    res.json(purchases);
});

// 11. קבלת קניות של תלמיד מסוים
app.get('/api/purchases/:studentId', async (req, res) => {
    const purchases = await Purchase.find({ studentId: req.params.studentId }).sort({ createdAt: -1 });
    res.json(purchases);
});

// 12. אישור/דחיית קנייה (מורה)
app.post('/api/purchases/:id/approve', async (req, res) => {
    const { approve } = req.body; // true לאישור, false לדחייה
    
    try {
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
        res.json({ success: false, message: "שגיאה בעיבוד הקנייה" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
