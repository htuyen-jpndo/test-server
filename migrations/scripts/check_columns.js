import { sequelize } from "../src/config/db.js";

async function checkColumns() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connected to database\n');

    // Check existing columns in flights table
    const [columns] = await sequelize.query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE 
       FROM information_schema.columns 
       WHERE table_schema = DATABASE() 
       AND table_name = 'flights' 
       ORDER BY ORDINAL_POSITION`
    );

    console.log('📋 Existing columns in flights table:');
    console.log('=====================================');
    columns.forEach(col => {
      console.log(`- ${col.COLUMN_NAME} (${col.DATA_TYPE}, ${col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'})`);
    });

    // Check specifically for checklistRemarks and checklistNotes
    console.log('\n🔍 Checking for checklistRemarks and checklistNotes:');
    const checklistRemarks = columns.find(c => 
      c.COLUMN_NAME === 'checklistRemarks' || c.COLUMN_NAME === 'checklist_remarks'
    );
    const checklistNotes = columns.find(c => 
      c.COLUMN_NAME === 'checklistNotes' || c.COLUMN_NAME === 'checklist_notes'
    );

    if (checklistRemarks) {
      console.log(`✅ checklistRemarks exists as: ${checklistRemarks.COLUMN_NAME}`);
    } else {
      console.log('❌ checklistRemarks NOT FOUND');
    }

    if (checklistNotes) {
      console.log(`✅ checklistNotes exists as: ${checklistNotes.COLUMN_NAME}`);
    } else {
      console.log('❌ checklistNotes NOT FOUND');
    }

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

checkColumns();
