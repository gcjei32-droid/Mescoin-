
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "100kb" }));

// Required Render environment variables:
// DATABASE_URL = your Render PostgreSQL Internal Database URL
// JWT_SECRET = a long, private, random secret

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from Render environment variables.");
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("Set JWT_SECRET to a private random string of at least 32 characters.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

const START_PRICE = 2; // KES per MES
const PRICE_IMPACT = 0.0001;
const MIN_PRICE = 0.01;

function accountNumber() {
  return "MES" + crypto.randomBytes(7).toString("hex").toUpperCase();
}

function tokenFor(user) {
  return jwt.sign(
    { id: user.id },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Please log in first."
    });
  }

  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Your login has expired. Please log in again."
    });
  }
}

function positiveAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 100000000
    ? Math.round(amount * 100000000) / 100000000
    : null;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      account_number VARCHAR(32) UNIQUE NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      mobile VARCHAR(25) UNIQUE NOT NULL,
      email VARCHAR(254) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      mes_balance NUMERIC(24,8) NOT NULL DEFAULT 0,
      kes_balance NUMERIC(24,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS market (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      price NUMERIC(20,8) NOT NULL DEFAULT 2,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO market (id, price)
    VALUES (1, 2)
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      from_user_id BIGINT REFERENCES users(id),
      to_user_id BIGINT REFERENCES users(id),
      type VARCHAR(30) NOT NULL,
      amount NUMERIC(24,8) NOT NULL,
      price NUMERIC(20,8) NOT NULL,
      total_kes NUMERIC(24,2) NOT NULL,
      reference VARCHAR(80) UNIQUE NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS transactions_from_idx
      ON transactions(from_user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS transactions_to_idx
      ON transactions(to_user_id, created_at DESC);
  `);

  console.log("MesCoin PostgreSQL tables are ready.");
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    app: "MesCoin",
    status: "online",
    message: "MesCoin server is running."
  });
});

app.get("/api/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const result = await pool.query(
      "SELECT price, updated_at FROM market WHERE id = 1"
    );

    res.json({
      success: true,
      status: "online",
      database: "connected",
      currency: "KES",
      mesPrice: Number(result.rows[0].price),
      updatedAt: result.rows[0].updated_at
    });
  } catch (err) {
    console.error("Status check failed:", err.message);
    res.status(503).json({
      success: false,
      status: "offline",
      database: "unavailable",
      message: "The database could not be reached."
    });
  }
});

// REGISTER
app.post("/api/signup", async (req, res) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const mobile = String(req.body.mobile || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (
      fullName.length < 2 ||
      fullName.length > 100 ||
      !/^\+?[0-9]{9,15}$/.test(mobile) ||
      !validEmail(email) ||
      password.length < 8 ||
      password.length > 128
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid name, mobile number, email and password of at least 8 characters."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    let user;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await pool.query(
          `INSERT INTO users
            (account_number, full_name, mobile, email, password_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, account_number, full_name, mobile, email,
                     mes_balance, kes_balance, created_at`,
          [accountNumber(), fullName, mobile, email, passwordHash]
        );

        user = result.rows[0];
        break;
      } catch (err) {
        if (err.code === "23505") {
          if (err.constraint === "users_mobile_key") {
            return res.status(409).json({
              success: false,
              message: "That mobile number is already registered."
            });
          }
          if (err.constraint === "users_email_key") {
            return res.status(409).json({
              success: false,
              message: "That email is already registered."
            });
          }
          if (attempt < 2) continue;
        }
        throw err;
      }
    }

    if (!user) {
      return res.status(500).json({
        success: false,
        message: "Account could not be created."
      });
    }

    res.status(201).json({
      success: true,
      message: "MesCoin account created successfully.",
      token: tokenFor(user),
      user: formatUser(user)
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({
      success: false,
      message: "Registration failed. Check the server logs if the problem continues."
    });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  try {
    const login = String(req.body.login || req.body.email || req.body.mobile || "")
      .trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT * FROM users
       WHERE LOWER(email) = $1 OR mobile = $2`,
      [login, login]
    );

    if (
      !result.rows.length ||
      !(await bcrypt.compare(password, result.rows[0].password_hash))
    ) {
      return res.status(401).json({
        success: false,
        message: "Incorrect email/mobile number or password."
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      message: "Login successful.",
      token: tokenFor(user),
      user: formatUser(user)
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({
      success: false,
      message: "Login failed."
    });
  }
});

function formatUser(user) {
  return {
    id: user.id,
    accountNumber: user.account_number,
    fullName: user.full_name,
    mobile: user.mobile,
    email: user.email,
    mesBalance: Number(user.mes_balance),
    kesBalance: Number(user.kes_balance),
    createdAt: user.created_at
  };
}

// PROFILE
app.get("/api/profile", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, account_number, full_name, mobile, email,
              mes_balance, kes_balance, created_at
       FROM users WHERE id = $1`,
      [req.auth.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({
      success: true,
      user: formatUser(result.rows[0])
    });
  } catch (err) {
    console.error("Profile error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not load your profile."
    });
  }
});

// CURRENT MARKET PRICE
app.get("/api/market", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT price, updated_at FROM market WHERE id = 1"
    );

    res.json({
      success: true,
      currency: "KES",
      price: Number(result.rows[0].price),
      updatedAt: result.rows[0].updated_at
    });
  } catch (err) {
    console.error("Market error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not load market price."
    });
  }
});

// BUY MES
app.post("/api/buy", authenticate, async (req, res) => {
  const amount = positiveAmount(req.body.amount);
  if (!amount) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid MES amount."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [req.auth.id]
    );
    if (!userResult.rows.length) throw new Error("ACCOUNT_NOT_FOUND");

    const marketResult = await client.query(
      "SELECT price FROM market WHERE id = 1 FOR UPDATE"
    );
    let price = Number(marketResult.rows[0].price);
    const total = Math.round(amount * price * 100) / 100;
    const user = userResult.rows[0];

    if (Number(user.kes_balance) < total) {
      throw new Error("INSUFFICIENT_KES");
    }

    // A buy increases the price. Balances and price update atomically.
    const newPrice = Math.max(
      MIN_PRICE,
      Math.round(price * (1 + amount * PRICE_IMPACT) * 100000000) / 100000000
    );

    await client.query(
      `UPDATE users
       SET kes_balance = kes_balance - $1,
           mes_balance = mes_balance + $2
       WHERE id = $3`,
      [total, amount, req.auth.id]
    );

    await client.query(
      "UPDATE market SET price = $1, updated_at = NOW() WHERE id = 1",
      [newPrice]
    );

    const reference = "BUY-" + crypto.randomUUID();

    await client.query(
      `INSERT INTO transactions
       (to_user_id, type, amount, price, total_kes, reference)
       VALUES ($1, 'BUY', $2, $3, $4, $5)`,
      [req.auth.id, amount, price, total, reference]
    );

    const updated = await client.query(
      `SELECT id, account_number, full_name, mobile, email,
              mes_balance, kes_balance, created_at
       FROM users WHERE id = $1`,
      [req.auth.id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Buy completed.",
      amountMES: amount,
      priceKES: price,
      totalKES: total,
      newMarketPriceKES: newPrice,
      reference,
      user: formatUser(updated.rows[0])
    });
  } catch (err) {
    await client.query("ROLLBACK");
    const errors = {
      ACCOUNT_NOT_FOUND: [404, "Account not found."],
      INSUFFICIENT_KES: [400, "Insufficient KES balance."]
    };
    if (errors[err.message]) {
      return res.status(errors[err.message][0]).json({
        success: false,
        message: errors[err.message][1]
      });
    }
    console.error("Buy error:", err.message);
    res.status(500).json({
      success: false,
      message: "Buy could not be completed."
    });
  } finally {
    client.release();
  }
});

// SELL MES
app.post("/api/sell", authenticate, async (req, res) => {
  const amount = positiveAmount(req.body.amount);
  if (!amount) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid MES amount."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [req.auth.id]
    );
    if (!userResult.rows.length) throw new Error("ACCOUNT_NOT_FOUND");

    const marketResult = await client.query(
      "SELECT price FROM market WHERE id = 1 FOR UPDATE"
    );
    const price = Number(marketResult.rows[0].price);
    const total = Math.round(amount * price * 100) / 100;
    const user = userResult.rows[0];

    if (Number(user.mes_balance) < amount) {
      throw new Error("INSUFFICIENT_MES");
    }

    const newPrice = Math.max(
      MIN_PRICE,
      Math.round(price * (1 - amount * PRICE_IMPACT) * 100000000) / 100000000
    );

    await client.query(
      `UPDATE users
       SET mes_balance = mes_balance - $1,
           kes_balance = kes_balance + $2
       WHERE id = $3`,
      [amount, total, req.auth.id]
    );

    await client.query(
      "UPDATE market SET price = $1, updated_at = NOW() WHERE id = 1",
      [newPrice]
    );

    const reference = "SELL-" + crypto.randomUUID();

    await client.query(
      `INSERT INTO transactions
       (from_user_id, type, amount, price, total_kes, reference)
       VALUES ($1, 'SELL', $2, $3, $4, $5)`,
      [req.auth.id, amount, price, total, reference]
    );

    const updated = await client.query(
      `SELECT id, account_number, full_name, mobile, email,
              mes_balance, kes_balance, created_at
       FROM users WHERE id = $1`,
      [req.auth.id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Sell completed.",
      amountMES: amount,
      priceKES: price,
      totalKES: total,
      newMarketPriceKES: newPrice,
      reference,
      user: formatUser(updated.rows[0])
    });
  } catch (err) {
    await client.query("ROLLBACK");
    const errors = {
      ACCOUNT_NOT_FOUND: [404, "Account not found."],
      INSUFFICIENT_MES: [400, "Insufficient MES balance."]
    };
    if (errors[err.message]) {
      return res.status(errors[err.message][0]).json({
        success: false,
        message: errors[err.message][1]
      });
    }
    console.error("Sell error:", err.message);
    res.status(500).json({
      success: false,
      message: "Sell could not be completed."
    });
  } finally {
    client.release();
  }
});

// SEND MES TO ANOTHER ACCOUNT
app.post("/api/transfer", authenticate, async (req, res) => {
  const amount = positiveAmount(req.body.amount);
  const recipientAccount = String(
    req.body.accountNumber || req.body.recipientAccount || ""
  ).trim().toUpperCase();

  if (!amount || !recipientAccount) {
    return res.status(400).json({
      success: false,
      message: "Enter the recipient account number and a valid amount."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const senderResult = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [req.auth.id]
    );
    if (!senderResult.rows.length) throw new Error("ACCOUNT_NOT_FOUND");

    const recipientResult = await client.query(
      "SELECT * FROM users WHERE account_number = $1 FOR UPDATE",
      [recipientAccount]
    );

    if (!recipientResult.rows.length) throw new Error("RECIPIENT_NOT_FOUND");
    const sender = senderResult.rows[0];
    const recipient = recipientResult.rows[0];

    if (String(sender.id) === String(recipient.id)) {
      throw new Error("CANNOT_SEND_TO_SELF");
    }

    if (Number(sender.mes_balance) < amount) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    await client.query(
      "UPDATE users SET mes_balance = mes_balance - $1 WHERE id = $2",
      [amount, sender.id]
    );
    await client.query(
      "UPDATE users SET mes_balance = mes_balance + $1 WHERE id = $2",
      [amount, recipient.id]
    );

    const reference = "SEND-" + crypto.randomUUID();
    const marketResult = await client.query(
      "SELECT price FROM market WHERE id = 1"
    );
    const price = Number(marketResult.rows[0].price);

    await client.query(
      `INSERT INTO transactions
       (from_user_id, to_user_id, type, amount, price, total_kes, reference)
       VALUES ($1, $2, 'TRANSFER', $3, $4, $5, $6)`,
      [sender.id, recipient.id, amount, price, amount * price, reference]
    );

    const updated = await client.query(
      `SELECT id, account_number, full_name, mobile, email,
              mes_balance, kes_balance, created_at
       FROM users WHERE id = $1`,
      [sender.id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "MesCoin transfer completed.",
      amountMES: amount,
      recipientAccount,
      reference,
      user: formatUser(updated.rows[0])
    });
  } catch (err) {
    await client.query("ROLLBACK");

    const errors = {
      ACCOUNT_NOT_FOUND: [404, "Your account was not found."],
      RECIPIENT_NOT_FOUND: [404, "Recipient account was not found."],
      CANNOT_SEND_TO_SELF: [400, "You cannot send MES to yourself."],
      INSUFFICIENT_BALANCE: [400, "Insufficient MES balance."]
    };

    if (errors[err.message]) {
      return res.status(errors[err.message][0]).json({
        success: false,
        message: errors[err.message][1]
      });
    }

    console.error("Transfer error:", err.message);
    res.status(500).json({
      success: false,
      message: "Transfer could not be completed."
    });
  } finally {
    client.release();
  }
});

// TRANSACTION HISTORY
app.get("/api/transactions", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.type, t.amount, t.price, t.total_kes,
              t.reference, t.created_at,
              sender.account_number AS sender_account,
              recipient.account_number AS recipient_account
       FROM transactions t
       LEFT JOIN users sender ON sender.id = t.from_user_id
       LEFT JOIN users recipient ON recipient.id = t.to_user_id
       WHERE t.from_user_id = $1 OR t.to_user_id = $1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [req.auth.id]
    );

    res.json({
      success: true,
      transactions: result.rows.map(t => ({
        id: t.id,
        type: t.type,
        amountMES: Number(t.amount),
        priceKES: Number(t.price),
        totalKES: Number(t.total_kes),
        reference: t.reference,
        senderAccount: t.sender_account,
        recipientAccount: t.recipient_account,
        createdAt: t.created_at
      }))
    });
  } catch (err) {
    console.error("Transactions error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not load transaction history."
    });
  }
});

// Handle unexpected errors without exposing secrets.
app.use((err, req, res, next) => {
  console.error("Request error:", err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({
    success: false,
    message: "An unexpected server error occurred."
  });
});

async function startServer() {
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MesCoin server listening on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error("SERVER STARTUP FAILED:", err.message);
  process.exit(1);
});
