const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

const JWT_SECRET = process.env.JWT_SECRET;

if (!process.env.DATABASE_URL || !JWT_SECRET) {
  console.error("Missing DATABASE_URL or JWT_SECRET environment variable.");
  process.exit(1);
}

const STARTING_CASH = 1000;
const STARTING_PRICE = Number(process.env.MESCOIN_PRICE || 1);

// ==================================================
// DATABASE TABLES
// ==================================================

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      account_number VARCHAR(32) UNIQUE NOT NULL,
      username VARCHAR(60) NOT NULL,
      mobile_number VARCHAR(30) UNIQUE NOT NULL,
      email VARCHAR(254) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      mescoin NUMERIC(30,8) NOT NULL DEFAULT 0
        CHECK (mescoin >= 0),
      cash NUMERIC(30,8) NOT NULL DEFAULT 1000
        CHECK (cash >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      type VARCHAR(10) NOT NULL CHECK (type IN ('buy','sell')),
      amount NUMERIC(30,8) NOT NULL CHECK (amount > 0),
      price NUMERIC(30,8) NOT NULL CHECK (price > 0),
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      reference VARCHAR(64) UNIQUE NOT NULL,
      sender_id BIGINT REFERENCES users(id),
      receiver_id BIGINT REFERENCES users(id),
      transaction_type VARCHAR(20) NOT NULL,
      amount NUMERIC(30,8) NOT NULL CHECK (amount > 0),
      price NUMERIC(30,8),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS orders_created_idx
      ON orders(created_at DESC);

    CREATE INDEX IF NOT EXISTS transactions_sender_idx
      ON transactions(sender_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS transactions_receiver_idx
      ON transactions(receiver_id, created_at DESC);
  `);

  await pool.query(`
    INSERT INTO app_settings (setting_key, setting_value)
    VALUES ('mescoin_price', $1)
    ON CONFLICT (setting_key) DO NOTHING
  `, [String(STARTING_PRICE)]);

  console.log("MesCoin database tables are ready.");
}

// ==================================================
// COMMON HELPERS
// ==================================================

function accountNumber() {
  return "MES" + crypto.randomBytes(8).toString("hex").toUpperCase();
}

function referenceNumber() {
  return "TX" + crypto.randomBytes(12).toString("hex").toUpperCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validMobile(mobile) {
  return /^\+?[0-9]{8,15}$/.test(mobile);
}

function validAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 1e20;
}

function publicUser(user) {
  return {
    id: user.id,
    accountNumber: user.account_number,
    username: user.username,
    mobileNumber: user.mobile_number,
    email: user.email,
    mescoin: Number(user.mescoin),
    cash: Number(user.cash),
    createdAt: user.created_at
  };
}

async function getPrice(client = pool) {
  const result = await client.query(
    "SELECT setting_value FROM app_settings WHERE setting_key = 'mescoin_price'"
  );

  if (!result.rows.length) {
    throw new Error("MesCoin price has not been configured.");
  }

  return Number(result.rows[0].setting_value);
}

function createToken(user) {
  return jwt.sign(
    { sub: String(user.id) },
    JWT_SECRET,
    { expiresIn: "7d", issuer: "mescoin-server" }
  );
}

// ==================================================
// LOGIN PROTECTION
// ==================================================

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
    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: "mescoin-server"
    });

    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Your login has expired. Please log in again."
    });
  }
}

// ==================================================
// HOME AND STATUS
// ==================================================

app.get("/", async (req, res) => {
  res.json({
    success: true,
    status: "online",
    message: "MesCoin server is running!",
    price: await getPrice()
  });
});

app.get("/api/status", async (req, res) => {
  res.json({
    success: true,
    status: "online",
    message: "MesCoin server is connected",
    price: await getPrice()
  });
});

// ==================================================
// REGISTER
// Requires username, mobileNumber, email, password
// ==================================================

app.post("/api/register", async (req, res) => {
  try {
    let { username, mobileNumber, email, password } = req.body;

    username = String(username || "").trim();
    mobileNumber = String(mobileNumber || "").trim();
    email = String(email || "").trim().toLowerCase();

    if (
      username.length < 2 || username.length > 60 ||
      !validMobile(mobileNumber) ||
      !validEmail(email) ||
      typeof password !== "string" ||
      password.length < 8 || password.length > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a username, valid mobile number, valid email, and password of 8–72 characters."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Retry in the extremely unlikely event of an account-number collision.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await pool.query(`
          INSERT INTO users
            (account_number, username, mobile_number, email,
             password_hash, cash)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `, [
          accountNumber(), username, mobileNumber, email,
          passwordHash, STARTING_CASH
        ]);

        const user = result.rows[0];

        return res.status(201).json({
          success: true,
          message: "Account created successfully.",
          user: publicUser(user)
        });
      } catch (error) {
        if (error.code === "23505") {
          const duplicate = await pool.query(`
            SELECT
              CASE
                WHEN email = $1 THEN 'email'
                WHEN mobile_number = $2 THEN 'mobile'
                ELSE 'account'
              END AS field
            FROM users
            WHERE email = $1 OR mobile_number = $2
            LIMIT 1
          `, [email, mobileNumber]);

          if (duplicate.rows.length) {
            return res.status(409).json({
              success: false,
              message: duplicate.rows[0].field === "email"
                ? "Email already registered."
                : "Mobile number already registered."
            });
          }

          continue;
        }

        throw error;
      }
    }

    return res.status(500).json({
      success: false,
      message: "Could not create account. Please try again."
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({
      success: false,
      message: "Registration failed."
    });
  }
});

// ==================================================
// LOGIN BY EMAIL OR MOBILE NUMBER
// ==================================================

app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(
      req.body.identifier || req.body.email || req.body.mobileNumber || ""
    ).trim();

    const password = req.body.password;

    if (!identifier || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Enter your email or mobile number and password."
      });
    }

    const result = await pool.query(`
      SELECT * FROM users
      WHERE LOWER(email) = LOWER($1) OR mobile_number = $1
      LIMIT 1
    `, [identifier]);

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        success: false,
        message: "Invalid login details."
      });
    }

    res.json({
      success: true,
      message: "Login successful.",
      token: createToken(user),
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Login failed."
    });
  }
});

// ==================================================
// PROFILE - RETURNS REGISTERED ACCOUNT DETAILS
// ==================================================

app.get("/api/profile", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({
      success: true,
      user: publicUser(result.rows[0])
    });
  } catch (error) {
    console.error("Profile error:", error);
    res.status(500).json({
      success: false,
      message: "Could not load profile."
    });
  }
});

// ==================================================
// PORTFOLIO
// ==================================================

app.get("/api/portfolio", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [req.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    const user = result.rows[0];
    const price = await getPrice();
    const mescoin = Number(user.mescoin);
    const cash = Number(user.cash);
    const mesValue = mescoin * price;

    res.json({
      success: true,
      portfolio: {
        ...publicUser(user),
        price,
        mesValue,
        totalValue: cash + mesValue
      }
    });
  } catch (error) {
    console.error("Portfolio error:", error);
    res.status(500).json({
      success: false,
      message: "Could not load portfolio."
    });
  }
});

// ==================================================
// BUY MESCOIN
// ==================================================

app.post("/api/buy", authenticate, async (req, res) => {
  const amount = Number(req.body.amount);
  const client = await pool.connect();

  try {
    if (!validAmount(amount)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid amount."
      });
    }

    await client.query("BEGIN");

    const result = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [req.userId]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    const user = result.rows[0];
    const price = await getPrice(client);
    const cost = amount * price;

    if (!Number.isFinite(cost) || cost <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid purchase value."
      });
    }

    if (Number(user.cash) < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Insufficient cash balance."
      });
    }

    await client.query(`
      UPDATE users
      SET cash = cash - $1, mescoin = mescoin + $2
      WHERE id = $3
    `, [cost, amount, req.userId]);

    const reference = referenceNumber();

    await client.query(`
      INSERT INTO transactions
        (reference, receiver_id, transaction_type, amount, price)
      VALUES ($1, $2, 'buy', $3, $4)
    `, [reference, req.userId, amount, price]);

    const updated = await client.query(
      "SELECT * FROM users WHERE id = $1",
      [req.userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "MesCoin purchased successfully.",
      reference,
      mescoin: Number(updated.rows[0].mescoin),
      cash: Number(updated.rows[0].cash),
      price
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Buy error:", error);
    res.status(500).json({
      success: false,
      message: "Purchase failed."
    });
  } finally {
    client.release();
  }
});

// ==================================================
// SELL MESCOIN
// ==================================================

app.post("/api/sell", authenticate, async (req, res) => {
  const amount = Number(req.body.amount);
  const client = await pool.connect();

  try {
    if (!validAmount(amount)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid amount."
      });
    }

    await client.query("BEGIN");

    const result = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [req.userId]
    );

    if (!result.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    const user = result.rows[0];

    if (Number(user.mescoin) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Insufficient MesCoin balance."
      });
    }

    const price = await getPrice(client);
    const value = amount * price;

    await client.query(`
      UPDATE users
      SET mescoin = mescoin - $1, cash = cash + $2
      WHERE id = $3
    `, [amount, value, req.userId]);

    const reference = referenceNumber();

    await client.query(`
      INSERT INTO transactions
        (reference, sender_id, transaction_type, amount, price)
      VALUES ($1, $2, 'sell', $3, $4)
    `, [reference, req.userId, amount, price]);

    const updated = await client.query(
      "SELECT * FROM users WHERE id = $1",
      [req.userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "MesCoin sold successfully.",
      reference,
      mescoin: Number(updated.rows[0].mescoin),
      cash: Number(updated.rows[0].cash),
      price
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Sell error:", error);
    res.status(500).json({
      success: false,
      message: "Sale failed."
    });
  } finally {
    client.release();
  }
});

// ==================================================
// SEND MESCOIN TO ANOTHER ACCOUNT NUMBER
// ==================================================

app.post("/api/transfer", authenticate, async (req, res) => {
  const receiverAccount = String(
    req.body.accountNumber || ""
  ).trim().toUpperCase();

  const amount = Number(req.body.amount);
  const client = await pool.connect();

  try {
    if (!receiverAccount || !validAmount(amount)) {
      return res.status(400).json({
        success: false,
        message: "Enter the receiver's account number and a valid amount."
      });
    }

    await client.query("BEGIN");

    const receiverResult = await client.query(
      "SELECT id, account_number, username FROM users WHERE account_number = $1",
      [receiverAccount]
    );

    if (!receiverResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Receiver account number not found."
      });
    }

    const receiver = receiverResult.rows[0];

    if (String(receiver.id) === String(req.userId)) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "You cannot send MesCoin to your own account."
      });
    }

    // Lock both accounts in ID order to reduce deadlock risk.
    const ids = [String(req.userId), String(receiver.id)].sort(
      (a, b) => BigInt(a) < BigInt(b) ? -1 : 1
    );

    const locked = await client.query(
      "SELECT * FROM users WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE",
      [ids]
    );

    const sender = locked.rows.find(
      user => String(user.id) === String(req.userId)
    );

    const target = locked.rows.find(
      user => String(user.id) === String(receiver.id)
    );

    if (!sender || !target) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        message: "Sender or receiver account not found."
      });
    }

    if (Number(sender.mescoin) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Insufficient MesCoin balance."
      });
    }

    await client.query(
      "UPDATE users SET mescoin = mescoin - $1 WHERE id = $2",
      [amount, sender.id]
    );

    await client.query(
      "UPDATE users SET mescoin = mescoin + $1 WHERE id = $2",
      [amount, target.id]
    );

    const reference = referenceNumber();

    await client.query(`
      INSERT INTO transactions
        (reference, sender_id, receiver_id, transaction_type, amount)
      VALUES ($1, $2, $3, 'transfer', $4)
    `, [reference, sender.id, target.id, amount]);

    const updated = await client.query(
      "SELECT mescoin FROM users WHERE id = $1",
      [sender.id]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "MesCoin transfer completed.",
      reference,
      receiver: {
        accountNumber: target.account_number,
        username: target.username
      },
      amount,
      remainingMescoin: Number(updated.rows[0].mescoin)
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Transfer error:", error);
    res.status(500).json({
      success: false,
      message: "Transfer failed."
    });
  } finally {
    client.release();
  }
});

// ==================================================
// TRANSACTION HISTORY
// ==================================================

app.get("/api/transactions", authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.id, t.reference, t.transaction_type, t.amount,
        t.price, t.created_at,
        s.account_number AS sender_account,
        r.account_number AS receiver_account
      FROM transactions t
      LEFT JOIN users s ON s.id = t.sender_id
      LEFT JOIN users r ON r.id = t.receiver_id
      WHERE t.sender_id = $1 OR t.receiver_id = $1
      ORDER BY t.created_at DESC
      LIMIT 100
    `, [req.userId]);

    res.json({
      success: true,
      transactions: result.rows
    });
  } catch (error) {
    console.error("Transactions error:", error);
    res.status(500).json({
      success: false,
      message: "Could not load transactions."
    });
  }
});

// ==================================================
// CREATE MARKETPLACE ORDER
// ===============
