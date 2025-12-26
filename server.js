require('dotenv').config(); 
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

// --- הגדרות וחיבור למסד הנתונים ---
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
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

// --- הגדרת המבנה של כיתה ---
const classSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    teacherPassword: { type: String, required: true, unique: true },
    teacherName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});

const Class = mongoose.model('Class', classSchema);

// --- הגדרת המבנה של תלמיד ---
const studentSchema = new mongoose.Schema({
    id: { type: String, required: true },
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true }
});

studentSchema.index({ id: 1, classId: 1 }, { unique: true });

const Student = mongoose.model('Student', studentSchema);

// --- הגדרת המבנה של מוצר בחנות ---
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
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

// מנהלי-על
const SUPER_ADMINS = {
    'prha12345': { name: 'יאיר פריש', role: 'superadmin' },
    'yair2589': { name: 'יאיר פרץ', role: 'superadmin' }
};

// --- התחברות ---
app.post('/api/login', async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.json({ success: false, message: 'נא להזין סיסמה או קוד' });
        }

        // בדיקה אם זה מנהל-על
        if (SUPER_ADMINS[code]) {
            return res.json({ 
                success: true, 
                role: 'superadmin',
                name: SUPER_ADMINS[code].name
            });
        }

        // בדיקה אם זה מורה רגיל
        const classDoc = await Class.findOne({ teacherPassword: code });
        if (classDoc) {
            return res.json({ 
                success: true, 
                role: 'teacher',
                classId: classDoc._id,
                className: classDoc.name,
                teacherName: classDoc.teacherName
            });
        }

        // בדיקה אם זה תלמיד
        const student = await Student.findOne({ id: code }).populate('classId');
        if (student) {
            return res.json({ 
                success: true, 
                role: 'student',
                studentId: student.id,
                name: student.name,
                balance: student.balance,
                classId: student.classId._id,
                className: student.classId.name
            });
        }

        return res.json({ success: false, message: 'קוד או סיסמה שגויים' });
    } catch (error) {
        console.error("Login error:", error);
        res.json({ success: false, message: 'שגיאה בהתחברות' });
    }
});

// --- API למנהלי-על ---

// קבלת כל הכיתות
app.get('/api/classes', async (req, res) => {
    try {
        const classes = await Class.find({}).sort({ name: 1 });
        res.json(classes);
    } catch (error) {
        console.error("Get classes error:", error);
        res.json([]);
    }
});

// יצירת כיתה חדשה
app.post('/api/classes', async (req, res) => {
    try {
        const { name, teacherPassword, teacherName } = req.body;
        
        if (!name || !teacherPassword || !teacherName) {
            return res.json({ success: false, message: 'נא למלא את כל השדות' });
        }

        const existingClass = await Class.findOne({ 
            $or: [{ name }, { teacherPassword }] 
        });
        
        if (existingClass) {
            return res.json({ success: false, message: 'שם כיתה או סיסמת מורה כבר קיימים' });
        }

        const newClass = new Class({ name, teacherPassword, teacherName });
        await newClass.save();
        
        res.json({ success: true, message: 'הכיתה נוצרה בהצלחה', class: newClass });
    } catch (error) {
        console.error("Create class error:", error);
        res.json({ success: false, message: 'שגיאה ביצירת כיתה' });
    }
});

// מחיקת כיתה
app.delete('/api/classes/:id', async (req, res) => {
    try {
        const classId = req.params.id;
        
        // מחיקת כל התלמידים, מוצרים וקניות של הכיתה
        await Student.deleteMany({ classId });
        await Product.deleteMany({ classId });
        await Purchase.deleteMany({ classId });
        await Class.findByIdAndDelete(classId);
        
        res.json({ success: true, message: 'הכיתה נמחקה בהצלחה' });
    } catch (error) {
        console.error("Delete class error:", error);
        res.json({ success: false, message: 'שגיאה במחיקת הכיתה' });
    }
});

// עדכון פרטי כיתה (שינוי סיסמת מורה או שם מורה)
app.put('/api/classes/:id', async (req, res) => {
    try {
        const { teacherPassword, teacherName, name } = req.body;
        const updateData = {};
        
        if (name) updateData.name = name;
        if (teacherPassword) updateData.teacherPassword = teacherPassword;
        if (teacherName) updateData.teacherName = teacherName;
        
        const updatedClass = await Class.findByIdAndUpdate(
            req.params.id,
            updateData,
            { new: true }
        );
        
        if (updatedClass) {
            res.json({ success: true, class: updatedClass });
        } else {
            res.json({ success: false, message: 'כיתה לא נמצאה' });
        }
    } catch (error) {
        console.error("Update class error:", error);
        res.json({ success: false, message: 'שגיאה בעדכון הכיתה' });
    }
});

// --- API לתלמידים ---

// קבלת תלמידים של כיתה
app.get('/api/students/:classId', async (req, res) => {
    try {
        const students = await Student.find({ classId: req.params.classId })
            .select('id name balance')
            .sort({ name: 1 });
        res.json(students);
    } catch (error) {
        console.error("Get students error:", error);
        res.json([]);
    }
});

// יצירת תלמיד
app.post('/api/students', async (req, res) => {
    try {
        const { id, name, balance, classId } = req.body;
        
        if (!id || !name || !classId) {
            return res.json({ success: false, message: "קוד, שם ומזהה כיתה הן שדות חובה" });
        }
        
        const existingStudent = await Student.findOne({ id, classId });
        if (existingStudent) {
            return res.json({ success: false, message: "קוד תלמיד זה כבר קיים בכיתה" });
        }

        const newStudent = new Student({
            id,
            name,
            balance: parseInt(balance) || 0,
            classId
        });

        await newStudent.save();
        res.json({ success: true, message: `התלמיד ${name} נוצר בהצלחה`, student: newStudent });
    } catch (error) {
        console.error("Create student error:", error);
        res.json({ success: false, message: "שגיאה בשמירת תלמיד חדש" });
    }
});

// עדכון יתרה
app.post('/api/update-balance', async (req, res) => {
    try {
        const { studentId, classId, amount } = req.body;
        
        if (!studentId || !classId || amount === undefined) {
            return res.json({ success: false, message: 'פרמטרים חסרים' });
        }
        
        const updatedStudent = await Student.findOneAndUpdate(
            { id: studentId, classId },
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

// קבלת יתרה אישית
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

// עדכון יתרה מדויקת
app.post('/api/set-balance', async (req, res) => {
    try {
        const { studentId, classId, balance } = req.body;
        
        if (!studentId || !classId || balance === undefined) {
            return res.json({ success: false, message: 'פרמטרים חסרים' });
        }
        
        const updatedStudent = await Student.findOneAndUpdate(
            { id: studentId, classId },
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

// מחיקת תלמיד
app.delete('/api/students/:classId/:studentId', async (req, res) => {
    try {
        const { classId, studentId } = req.params;
        
        const deletedStudent = await Student.findOneAndDelete({ 
            id: studentId, 
            classId 
        });
        
        if (!deletedStudent) {
            return res.json({ success: false, message: "תלמיד לא נמצא" });
        }
        
        await Purchase.deleteMany({ studentId, classId });
        
        res.json({ success: true, message: `התלמיד ${deletedStudent.name} נמחק בהצלחה` });
    } catch (error) {
        console.error("Delete student error:", error);
        res.json({ success: false, message: "שגיאה במחיקת התלמיד" });
    }
});

// --- API לחנות ---

// יצירת מוצר
app.post('/api/products', async (req, res) => {
    try {
        const { name, price, description, image, stock, classId } = req.body;
        
        if (!name || !price || !classId) {
            return res.json({ success: false, message: "שם, מחיר ומזהה כיתה הן שדות חובה" });
        }

        const newProduct = new Product({
            name,
            price: parseInt(price),
            description: description || '',
            image: image || null,
            stock: parseInt(stock) || 0,
            classId
        });

        await newProduct.save();
        res.json({ success: true, message: `המוצר ${name} נוסף בהצלחה`, product: newProduct });
    } catch (error) {
        console.error("Create product error:", error);
        res.json({ success: false, message: "שגיאה ביצירת מוצר" });
    }
});

// קבלת מוצרים של כיתה
app.get('/api/products/:classId', async (req, res) => {
    try {
        const products = await Product.find({ classId: req.params.classId })
            .sort({ createdAt: -1 });
        res.json(products);
    } catch (error) {
        console.error("Get products error:", error);
        res.json([]);
    }
});

// מחיקת מוצר
app.delete('/api/products/:id', async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "המוצר נמחק בהצלחה" });
    } catch (error) {
        console.error("Delete product error:", error);
        res.json({ success: false, message: "שגיאה במחיקת המוצר" });
    }
});

// עדכון מלאי
app.post('/api/products/:id/stock', async (req, res) => {
    try {
        const { stock } = req.body;
        
        if (stock === undefined || stock < 0) {
            return res.json({ success: false, message: 'מלאי לא תקין' });
        }
        
        const product = await Product.findByIdAndUpdate(
            req.params.id,
            { stock: parseInt(stock) },
            { new: true }
        );

        if (product) {
            res.json({ success: true, newStock: product.stock, message: 'המלאי עודכן בהצלחה' });
        } else {
            res.json({ success: false, message: 'מוצר לא נמצא' });
        }
    } catch (error) {
        console.error("Update stock error:", error);
        res.json({ success: false, message: 'שגיאה בעדכון המלאי' });
    }
});

// בקשת קניה
app.post('/api/purchase', async (req, res) => {
    try {
        const { studentId, productId, classId } = req.body;
        
        if (!studentId || !productId || !classId) {
            return res.json({ success: false, message: "פרמטרים חסרים" });
        }
        
        const student = await Student.findOne({ id: studentId, classId });
        const product = await Product.findById(productId);
        
        if (!student) {
            return res.json({ success: false, message: "תלמיד לא נמצא" });
        }
        
        if (!product) {
            return res.json({ success: false, message: "מוצר לא נמצא" });
        }
        
        if (product.stock <= 0) {
            return res.json({ success: false, message: "המוצר אזל מהמלאי" });
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
            classId,
            status: 'pending'
        });
        
        await newPurchase.save();
        res.json({ success: true, message: "הבקשה נשלחה למורה לאישור", purchase: newPurchase });
    } catch (error) {
        console.error("Purchase error:", error);
        res.json({ success: false, message: "שגיאה ביצירת הקניה" });
    }
});

// קבלת קניות של כיתה
app.get('/api/purchases/:classId', async (req, res) => {
    try {
        const purchases = await Purchase.find({ classId: req.params.classId })
            .sort({ createdAt: -1 });
        res.json(purchases);
    } catch (error) {
        console.error("Get purchases error:", error);
        res.json([]);
    }
});

// קבלת קניות של תלמיד
app.get('/api/purchases/:classId/:studentId', async (req, res) => {
    try {
        const { classId, studentId } = req.params;
        const purchases = await Purchase.find({ classId, studentId })
            .sort({ createdAt: -1 });
        res.json(purchases);
    } catch (error) {
        console.error("Get student purchases error:", error);
        res.json([]);
    }
});

// אישור/דחיית קניה
app.post('/api/purchases/:id/approve', async (req, res) => {
    try {
        const { approve } = req.body;
        
        const purchase = await Purchase.findById(req.params.id);
        if (!purchase) {
            return res.json({ success: false, message: "קניה לא נמצאה" });
        }
        
        if (purchase.status !== 'pending') {
            return res.json({ success: false, message: "הקניה כבר טופלה" });
        }
        
        if (approve) {
            const student = await Student.findOne({ 
                id: purchase.studentId, 
                classId: purchase.classId 
            });
            const product = await Product.findById(purchase.productId);
            
            if (!student) {
                return res.json({ success: false, message: "תלמיד לא נמצא" });
            }
            
            if (!product) {
                return res.json({ success: false, message: "מוצר לא נמצא" });
            }
            
            if (product.stock <= 0) {
                return res.json({ success: false, message: "המוצר אזל מהמלאי" });
            }
            
            if (student.balance < purchase.price) {
                return res.json({ success: false, message: "לתלמיד אין מספיק נקודות" });
            }
            
            student.balance -= purchase.price;
            await student.save();
            
            product.stock -= 1;
            await product.save();
            
            purchase.status = 'approved';
            purchase.approvedAt = new Date();
            await purchase.save();
            
            res.json({ success: true, message: "הקניה אושרה והנקודות הורדו" });
        } else {
            purchase.status = 'rejected';
            await purchase.save();
            res.json({ success: true, message: "הקניה נדחתה" });
        }
    } catch (error) {
        console.error("Approve purchase error:", error);
        res.json({ success: false, message: "שגיאה בעיבוד הקניה" });
    }
});

// מחיקת כל ההיסטוריה של כיתה
app.delete('/api/purchases/:classId/all', async (req, res) => {
    try {
        const result = await Purchase.deleteMany({ classId: req.params.classId });
        res.json({ 
            success: true, 
            message: `נמחקו ${result.deletedCount} רשומות קניה בהצלחה` 
        });
    } catch (error) {
        console.error("Delete all purchases error:", error);
        res.json({ success: false, message: "שגיאה במחיקת ההיסטוריה" });
    }
});

// טיפול בשגיאות כלליות
app.use((err, req, res, next) => {
    console.error("Server error:", err);
    res.status(500).json({ success: false, message: "שגיאת שרת" });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
