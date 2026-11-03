/** 本地初始化：连上 MySQL 并创建数据库（不存在才建），读 .env 里的 DATABASE_URL */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("请先在 .env 里填 DATABASE_URL，例如：mysql://root:123456@localhost:3306/tutor");
  process.exit(1);
}

const m = new URL(url);
const dbName = m.pathname.replace(/^\//, "");
if (!dbName) {
  console.error("DATABASE_URL 里要带数据库名，例如结尾的 /tutor");
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: m.hostname,
  port: Number(m.port || 3306),
  user: decodeURIComponent(m.username),
  password: decodeURIComponent(m.password),
});
await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARACTER SET utf8mb4`);
console.log(`数据库 ${dbName} 已就绪`);
await conn.end();
