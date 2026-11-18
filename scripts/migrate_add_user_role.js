import { sequelize } from "../src/config/db.js";

async function ensureColumn(table, column, definition) {
  const [results] = await sequelize.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    { replacements: [table, column] }
  );

  if (results && results[0] && results[0].cnt > 0) {
    console.log(`✅ Column ${column} already exists on ${table}`);
    return true; // Column exists
  }

  // Column doesn't exist, add it
  console.log(`📝 Adding column ${column} to ${table} ...`);
  try {
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ Added ${column} successfully`);
    return false; // Column was just added
  } catch (err) {
    console.error(`❌ Error adding column ${column}:`, err.message);
    throw err;
  }
}

async function main() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connected to database\n');
    
    // Add role column if missing
    console.log('📋 Checking and adding role column...');
    const columnExists = await ensureColumn('Users', 'role', "ENUM('admin', 'user') DEFAULT 'user' NOT NULL");
    
    if (!columnExists) {
      // Set default role for existing users if column was just added
      console.log('📝 Setting default role for existing users...');
      await sequelize.query(`UPDATE Users SET role = 'user' WHERE role IS NULL`);
      console.log('✅ Default role set for existing users');
    }

    console.log('\n✅ Migration script completed successfully.');
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Migration error:', err);
    await sequelize.close();
    process.exit(1);
  }
}

main();
