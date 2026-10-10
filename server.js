const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET = process.env.JWT_SECRET || "mescoin-2026";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());

async function initDB(){
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, mes_account TEXT UNIQUE NOT NULL, password TEXT NOT NULL, kes_balance DECIMAL DEFAULT 1000, mes_balance DECIMAL DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS price_table (id INTEGER PRIMARY KEY, current_price DECIMAL DEFAULT 2.0);
      CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), type TEXT, amount DECIMAL, price DECIMAL, total DECIMAL, from_account TEXT, to_account TEXT, created_at TIMESTAMP DEFAULT NOW());
      INSERT INTO price_table (id, current_price) VALUES (1, 2.0) ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mes_account TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kes_balance DECIMAL DEFAULT 1000`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mes_balance DECIMAL DEFAULT 0`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS from_account TEXT`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS to_account TEXT`);
    console.log("MESCOIN Ready with SEND - DB Fixed");
  }catch(e){ console.error(e.message); }
}
initDB();
