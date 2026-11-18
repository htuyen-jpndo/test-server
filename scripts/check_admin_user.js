import { sequelize } from "../src/config/db.js";
import { User } from "../src/models/user.model.js";

async function checkAdminUser() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connected to database\n');

    // Kiểm tra tất cả users có role = 'admin'
    console.log('🔍 Checking for admin users...\n');
    const adminUsers = await User.findAll({
      where: { role: 'admin' },
      attributes: ['id', 'name', 'email', 'role', 'createdAt']
    });

    if (adminUsers.length === 0) {
      console.log('❌ No admin users found in database!');
      console.log('\n💡 To create an admin user, run:');
      console.log('   npm run create:admin');
      console.log('   or');
      console.log('   node scripts/create_admin_user.js');
    } else {
      console.log(`✅ Found ${adminUsers.length} admin user(s):\n`);
      adminUsers.forEach((user, idx) => {
        console.log(`Admin ${idx + 1}:`);
        console.log(`  ID: ${user.id}`);
        console.log(`  Name: ${user.name}`);
        console.log(`  Email: ${user.email}`);
        console.log(`  Role: ${user.role}`);
        console.log(`  Created: ${user.createdAt}`);
        console.log('');
      });
    }

    // Kiểm tra user mặc định từ script
    const defaultAdminEmail = 'admin@gmail.com';
    const defaultAdmin = await User.findOne({
      where: { email: defaultAdminEmail }
    });

    if (defaultAdmin) {
      console.log(`📧 Default admin account (${defaultAdminEmail}):`);
      console.log(`   Role: ${defaultAdmin.role}`);
      if (defaultAdmin.role !== 'admin') {
        console.log(`   ⚠️  Warning: This user exists but is not an admin!`);
      }
    } else {
      console.log(`📧 Default admin account (${defaultAdminEmail}): NOT FOUND`);
    }

    // Thống kê tổng quan
    console.log('\n📊 User Statistics:');
    const totalUsers = await User.count();
    const adminCount = await User.count({ where: { role: 'admin' } });
    const userCount = await User.count({ where: { role: 'user' } });
    const nullRoleCount = await User.count({ where: { role: null } });

    console.log(`  Total users: ${totalUsers}`);
    console.log(`  Admin users: ${adminCount}`);
    console.log(`  Regular users: ${userCount}`);
    if (nullRoleCount > 0) {
      console.log(`  ⚠️  Users without role: ${nullRoleCount}`);
    }

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error:', err);
    await sequelize.close();
    process.exit(1);
  }
}

checkAdminUser();
