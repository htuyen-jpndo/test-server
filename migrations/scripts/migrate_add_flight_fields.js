import { sequelize } from "../src/config/db.js";

// Helper function to convert camelCase to snake_case
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

async function ensureColumn(table, column, definition) {
  // Try both camelCase and snake_case
  const columnNames = [column, camelToSnake(column)];
  
  for (const colName of columnNames) {
    const [results] = await sequelize.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      { replacements: [table, colName] }
    );

    if (results && results[0] && results[0].cnt > 0) {
      console.log(`Column ${colName} already exists on ${table}`);
      return; // Column exists, no need to add
    }
  }

  // Column doesn't exist in either format, add it with camelCase (matching model)
  console.log(`Adding column ${column} to ${table} ...`);
  try {
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ Added ${column}`);
  } catch (err) {
    console.error(`❌ Error adding column ${column}:`, err.message);
    throw err;
  }
}

async function modifyColumnIfNeeded(table, column, definition) {
  const [results] = await sequelize.query(
    `SELECT DATA_TYPE FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    { replacements: [table, column] }
  );
  if (!results || !results[0]) {
    console.log(`Column ${column} does not exist; cannot modify.`);
    return;
  }
  const current = results[0].DATA_TYPE;
  if (current.toLowerCase() !== definition.type.toLowerCase()) {
    console.log(`Altering ${table}.${column} from ${current} to ${definition.type} ...`);
    // MySQL: MODIFY COLUMN <name> <type>
    await sequelize.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition.sql}`);
    console.log(`Modified ${column}`);
  } else {
    console.log(`Column ${column} already has type ${current}`);
  }
}

async function main() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connected to database');
    
    // Add columns if missing
    console.log('\n📋 Checking and adding columns...');
    await ensureColumn('flights', 'flightSquawk', 'VARCHAR(255) NULL');
    await ensureColumn('flights', 'actionDate', 'DATE NULL');
    await ensureColumn('flights', 'correctiveAction', 'TEXT NULL');
    await ensureColumn('flights', 'checklistRemarks', 'JSON NULL');
    await ensureColumn('flights', 'checklistNotes', 'TEXT NULL');

    // If actionDate exists but is datetime, convert to DATE (MODIFY)
    await modifyColumnIfNeeded('flights', 'actionDate', { type: 'date', sql: 'DATE NULL' });

    console.log('\n✅ Migration script completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Migration error:', err);
    process.exit(1);
  }
}

main();
