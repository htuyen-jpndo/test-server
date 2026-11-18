import { sequelize } from "../src/config/db.js";
import { User } from "../src/models/user.model.js";
import bcrypt from "bcryptjs";

async function createAdminUser() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connected to database\n');

    const adminEmail = 'admin@gmail.com';
    const adminPassword = 'admin123'; // Mật khẩu mặc định, nên đổi sau khi đăng nhập
    const adminName = 'Admin User';

    // Kiểm tra xem user đã tồn tại chưa
    const existingUser = await User.findOne({ where: { email: adminEmail } });
    
    if (existingUser) {
      // Nếu user đã tồn tại, cập nhật role thành admin
      if (existingUser.role !== 'admin') {
        existingUser.role = 'admin';
        await existingUser.save();
        console.log(`✅ Updated existing user ${adminEmail} to admin role`);
      } else {
        console.log(`ℹ️  User ${adminEmail} is already an admin`);
      }
    } else {
      // Tạo user admin mới
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      
      const adminUser = await User.create({
        name: adminName,
        email: adminEmail,
        password: hashedPassword,
        role: 'admin'
      });

      console.log(`✅ Admin user created successfully!`);
      console.log(`📧 Email: ${adminEmail}`);
      console.log(`🔑 Password: ${adminPassword}`);
      console.log(`⚠️  Please change the password after first login!`);
    }

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error creating admin user:', err);
    await sequelize.close();
    process.exit(1);
  }
}

createAdminUser();
