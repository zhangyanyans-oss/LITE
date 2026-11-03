/** 学习流程升级：给 objective_states 加 stage/baseline/final_attempts 三列（幂等，可重复运行） */
import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("请先在 .env 里填 DATABASE_URL");
  process.exit(1);
}

const m = new URL(url);
const dbName = m.pathname.replace(/^\//, "");
const conn = await mysql.createConnection({
  host: m.hostname,
  port: Number(m.port || 3306),
  user: decodeURIComponent(m.username),
  password: decodeURIComponent(m.password),
  database: dbName,
});

const adds = [
  ["stage", "ALTER TABLE objective_states ADD COLUMN stage varchar(16) NOT NULL DEFAULT 'diagnose'"],
  ["baseline", "ALTER TABLE objective_states ADD COLUMN baseline double NULL"],
  ["final_attempts", "ALTER TABLE objective_states ADD COLUMN final_attempts int NOT NULL DEFAULT 0"],
];

for (const [col, sql] of adds) {
  const [rows] = await conn.execute(
    "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'objective_states' AND COLUMN_NAME = ?",
    [dbName, col],
  );
  if (rows[0].n > 0) {
    console.log(`列 ${col} 已存在，跳过`);
  } else {
    await conn.query(sql);
    console.log(`列 ${col} 已添加`);
  }
}
console.log("表结构已就绪");
await conn.end();
