import { sequelize } from "../src/config/db.js";

async function addEnumValue(table, column, newValue) {
  try {
    // Lấy định nghĩa ENUM hiện tại
    const [results] = await sequelize.query(
      `SELECT COLUMN_TYPE FROM information_schema.columns 
       WHERE table_schema = DATABASE() 
       AND table_name = ? 
       AND column_name = ?`,
      { replacements: [table, column] }
    );

    if (!results || !results[0]) {
      console.log(`Column ${column} does not exist on ${table}`);
      return false;
    }

    const currentEnum = results[0].COLUMN_TYPE;
    
    // Kiểm tra xem giá trị đã tồn tại chưa
    if (currentEnum.includes(newValue)) {
      console.log(`Value '${newValue}' already exists in ${table}.${column}`);
      return true;
    }

    // Parse ENUM values từ string như "enum('pilot','drone','purpose')"
    const enumMatch = currentEnum.match(/enum\((.+)\)/i);
    if (!enumMatch) {
      console.log(`Column ${column} is not an ENUM type`);
      return false;
    }

    // Lấy các giá trị hiện tại (loại bỏ dấu nháy)
    const existingValues = enumMatch[1]
      .split(',')
      .map(v => v.trim().replace(/^'|'$/g, ''));

    // Thêm giá trị mới
    const allValues = [...existingValues, newValue];
    const newEnumDefinition = `ENUM(${allValues.map(v => `'${v}'`).join(',')})`;

    console.log(`Adding '${newValue}' to ${table}.${column} ...`);
    console.log(`New ENUM definition: ${newEnumDefinition}`);

    // ALTER TABLE để thêm giá trị mới vào ENUM
    await sequelize.query(
      `ALTER TABLE ${table} MODIFY COLUMN ${column} ${newEnumDefinition} NOT NULL`
    );

    console.log(`✅ Successfully added '${newValue}' to ${table}.${column}`);
    return true;
  } catch (err) {
    console.error(`Error adding enum value:`, err);
    throw err;
  }
}

async function main() {
  try {
    await sequelize.authenticate();
    console.log("✅ Connected to database");

    // Thêm "maintenance-detail" vào ENUM của cột type trong bảng user_options
    await addEnumValue('user_options', 'type', 'maintenance-detail');

    console.log('✅ Migration script completed.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration error:', err);
    process.exit(1);
  }
}

main();

