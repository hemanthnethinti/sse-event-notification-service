const { Pool } = require("pg");

const connectionString =
  process.env.DATABASE_URL || "postgresql://user:password@localhost:5432/eventsdb";

const pool = new Pool({ connectionString });

async function query(text, params = []) {
  return pool.query(text, params);
}

async function closePool() {
  await pool.end();
}

module.exports = {
  query,
  closePool,
};
