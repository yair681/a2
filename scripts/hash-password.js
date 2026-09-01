// יצירת hash לסיסמת מנהל-על.
// שימוש:  npm run hash -- "הסיסמה שלי"
// את הפלט מדביקים ב-Render כמשתנה סביבה SUPERADMIN_1_PASSWORD_HASH

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
    console.error('שימוש: npm run hash -- "<password>"');
    process.exit(1);
}

// אותו מינימום כמו סיסמאות מורים בשרת. ההגנה העיקרית מפני ניחוש היא
// הגבלת הניסיונות (10 ל-15 דקות), לא אורך הסיסמה.
if (password.length < 8) {
    console.error('הסיסמה קצרה מדי. בחר סיסמה באורך 8 תווים לפחות.');
    process.exit(1);
}

console.log(bcrypt.hashSync(password, 12));
