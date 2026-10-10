
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "20kb" }));

// Render Environment Variables
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL || !JWT_SECRET) {
  console.error("Set DATABASE_URL and JWT_SECRET in Render Environment.");
  process.exit(1);
}

// Starting market settings. These are used only when the market
// is first created; existing market reserves are preserved.
const START_PRICE = Number(process.env.START_PRICE_KES || 2);
const INITIAL_SUPPLY = Number(process.env.INITIAL_MES_SUPPLY || 1000000);

if (
  !Number.isFinite(START_PRICE) || START_PRICE <= 0 ||
  !Number.isFinite(INITIAL_SUPPLY) || INITIAL_SUPPLY <= 0
) {
  console.error("START_PRICE_KES and INITIAL_MES_SUPPLY must be positive.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000
});

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function amountValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100000000) return null;
  return money(n);
}

function newAccountNumber() {
  return "MES" + crypto.randomInt(100000000, 1000000000);
}

function makeToken(user) {
  return jwt.sign(
    { id: String(user.id) },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function authenticate(req, res, next) {
  const parts = String(req.headers.authorization || "").split(" ");

  if (parts[0] !== "Bearer" || !parts[1]) {
    return res.status(401).json({
      success: false,
      message: "Please log in first."
    });
  }

  try {
    const decoded = jwt.verify(parts[1], JWT_SECRET);
    req.userId = decoded.id;
    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Login expired. Please log in again."
    });
  }
}

// Create permanent PostgreSQL tables.
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      phone VARCHAR(30) UNIQUE NOT NULL,
      email VARCHAR(254) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      account_number VARCHAR(20) UNIQUE NOT NULL,
      mes_balance NUMERIC(24,8) NOT NULL DEFAULT 0
        CHECK (mes_balance >= 0),
      cash_balance NUMERIC(24,2) NOT NULL DEFAULT 0
        CHECK (cash_balance >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      from_user_id BIGINT REFERENCES users(id),
      to_user_id BIGINT REFERENCES users(id),
      type VARCHAR(30) NOT NULL,
      amount NUMERIC(24,8) NOT NULL,
      price NUMERIC(24,8) NOT NULL DEFAULT 0,
      total NUMERIC(24,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS tx_sender_idx
    ON transactions(from_user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS tx_receiver_idx
    ON transactions(to_user_id, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mes_reserve NUMERIC(30,8) NOT NULL CHECK (mes_reserve > 0),
      kes_reserve NUMERIC(30,8) NOT NULL CHECK (kes_reserve > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Seed the market only if it has never been created.
  // Starting reserves establish a starting price of START_PRICE KES.
  await pool.query(
    `INSERT INTO market_state (id, mes_reserve, kes_reserve)
     VALUES (1, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [
      INITIAL_SUPPLY,
      INITIAL_SUPPLY * START_PRICE
    ]
  );

  console.log("MesCoin database tables are ready.");
}

// The current pool price is KES reserve / MES reserve.
async function getMarket(client = pool) {
  const result = await client.query(
    `SELECT mes_reserve, kes_reserve, updated_at
     FROM market_state WHERE id = 1`
  );

  if (!result.rowCount) throw new Error("MARKET_NOT_INITIALIZED");

  const market = result.rows[0];
  const mesReserve = Number(market.mes_reserve);
  const kesReserve = Number(market.kes_reserve);

  return {
    mesReserve,
    kesReserve,
    price: kesReserve / mesReserve,
    updatedAt: market.updated_at
  };
}

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "MesCoin API is running.",
    status: "/api/status",
    market: "/api/market"
  });
});

// Real server and database health check.
app.get("/api/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const market = await getMarket();

    res.json({
      success: true,
      status: "online",
      database: "connected",
      priceKES: market.price,
      message: "MesCoin server and PostgreSQL are connected."
    });
  } catch (err) {
    console.error("Status error:", err.message);
    res.status(503).json({
      success: false,
      status: "offline",
      database: "unavailable"
    });
  }
});

// Current price, available pool supply and reserves.
app.get("/api/market", async (req, res) => {
  try {
    const market = await getMarket();

    res.json({
      success: true,
      currency: "KES",
      priceKES: market.price,
      availableMES: market.mesReserve,
      kesReserve: market.kesReserve,
      updatedAt: market.updatedAt,
      pricing: "automated liquidity pool"
    });
  } catch (err) {
    console.error("Market error:", err.message);
    res.status(503).json({
      success: false,
      message: "Market is not available."
    });
  }
});

// REGISTER
app.post("/api/signup", async (req, res) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const phone = String(req.body.phone || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!fullName || !phone || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Enter full name, phone, email and password."
      });
    }

    if (
      fullName.length > 120 ||
      phone.length > 30 ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        success: false,
        message: "Check your name, phone number and email."
      });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        success: false,
        message: "Password must be 8 to 72 characters."
      });
    }

    const hash = await bcrypt.hash(password, 12);
    let user;

    for (let i = 0; i < 5; i++) {
      try {
        const result = await pool.query(
          `INSERT INTO users
           (full_name, phone, email, password_hash, account_number)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, full_name, phone, email, account_number,
                     mes_balance, cash_balance, created_at`,
          [fullName, phone, email, hash, newAccountNumber()]
        );
        user = result.rows[0];
        break;
      } catch (err) {
        if (
          err.code === "23505" &&
          err.constraint === "users_account_number_key"
        ) {
          continue;
        }

        if (err.code === "23505") {
          return res.status(409).json({
            success: false,
            message: "That phone number or email is already registered."
          });
        }

        throw err;
      }
    }

    if (!user) throw new Error("ACCOUNT_NUMBER_GENERATION_FAILED");

    res.status(201).json({
      success: true,
      message: "Account created.",
      token: makeToken(user),
      user
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not create account."
    });
  }
});

// LOGIN using email or phone.
app.post("/api/login", async (req, res) => {
  try {
    const identifier = String(
      req.body.identifier || req.body.email || req.body.phone || ""
    ).trim();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT * FROM users
       WHERE LOWER(email) = LOWER($1) OR phone = $1
       LIMIT 1`,
      [identifier]
    );

    const user = result.rows[0];

    if (
      !identifier ||
      !password ||
      !user ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        success: false,
        message: "Incorrect login details."
      });
    }

    delete user.password_hash;

    res.json({
      success: true,
      message: "Login successful.",
      token: makeToken(user),
      user
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not log in."
    });
  }
});

// PROFILE
app.get("/api/profile", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, phone, email, account_number,
              mes_balance, cash_balance, created_at
       FROM users WHERE id = $1`,
      [req.userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        success: false,
        message: "Account not found."
      });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Profile error:", err.message);
    res.status(500).json({
      success: false,
      message: "Could not load profile."
    });
  }
});

// BUY MES from the market pool.
// Amount means the number of MES the user wants to receive.
// Cost is calculated from pool reserves, not a fixed price.
app.post("/api/buy", authenticate, async (req, res) => {
  const amount = amountValue(req.body.amount);

  if (!amount) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid MES amount."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Lock the pool so concurrent orders cannot overspend its supply.
    const lockedMarket = await client.query(
      "SELECT * FROM market_state WHERE id = 1 FOR UPDATE"
    );

    if (!lockedMarket.rowCount) throw new Error("MARKET_NOT_INITIALIZED");

    const mesReserve = Number(lockedMarket.rows[0].mes_reserve);
    const kesReserve = Number(lockedMarket.rows[0].kes_reserve);

    if (amount >= mesReserve) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        success: false,
        message: "Not enough MES in the market pool for this order.",
        availableMES: mesReserve
      });
    }

    // Constant-product pool: KES cost to remove amount MES.
    const cost = money((kesReserve * amount) / (mesReserve - amount));

    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error("INVALID_TRADE_VALUE");
    }

    const lockedUser = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [req.userId]
    );

    const user = lockedUser.rows[0];

    if (!user) throw new Error("ACCOUNT_NOT_FOUND");

    if (Number(user.cash_balance) < cost) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Insufficient cash balance. No trade was made.",
        requiredKES: cost,
        cashBalanceKES: Number(user.cash_balance)
      });
    }

    const newMesReserve = mesReserve - amount;
    const newKesReserve = kesReserve + cost;

    await client.query(
      `UPDATE users
       SET cash_balance = cash_balance - $1,
           mes_balance = mes_balance + $2
       WHERE id = $3`,
      [cost, amount, req.userId]
    );

    await client.query(
      `UPDATE market_state
       SET mes_reserve = $1, kes_reserve = $2, updated_at = NOW()
       WHERE id = 1`,
      [newMesReserve, newKesReserve]
    );

    await client.query(
      `INSERT INTO transactions
       (from_user_id, to_user_id, type, amount, price, total)
       VALUES ($1, $1, 'buy', $2, $3, $4)`,
      [req.userId, amount, cost / amount, cost]
    );

    const newPrice = newKesReserve / newMesReserve;

    const updatedUser = await client.query(
      `SELECT account_number, mes_balance, cash_balance
       FROM users WHERE id = $1`,
      [req.userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Buy completed.",
      amountMES: amount,
      costKES: cost,
      averagePriceKES: cost / amount,
      marketPriceKES: newPrice,
      availableMES: newMesReserve,
      user: updatedUser.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Buy error:", err.message);
    res.status(500).json({
      success: false,
      message: "Buy order could not be completed."
    });
  } finally {
    client.release();
  }
});

// SELL MES back to the market pool.
// The more MES sold into the pool, the lower its price can move.
app.post("/api/sell", authenticate, async (req, res) => {
  const amount = amountValue(req.body.amount);

  if (!amount) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid MES amount."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lockedMarket = await client.query(
      "SELECT * FROM market_state WHERE id = 1 FOR UPDATE"
    );

    if (!lockedMarket.rowCount) throw new Error("MARKET_NOT_INITIALIZED");

    const mesReserve = Number(lockedMarket.rows[0].mes_reserve);
    const kesReserve = Number(lockedMarket.rows[0].kes_reserve);

    // Constant-product pool: KES paid out for amount MES added.
    const proceeds = money((kesReserve * amount) / (mesReserve + amount));

    const lockedUser = await client.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [req.userId]
    );

    const user = lockedUser.rows[0];

    if (!user) throw new Error("ACCOUNT_NOT_FOUND");

    if (Number(user.mes_balance) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Insufficient MES balance. No sale was made."
      });
    }

    if (proceeds > kesReserve) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "The market pool cannot cover this sale."
      });
    }

    const newMesReserve = mesReserve + amount;
    const newKesReserve = kesReserve - proceeds;

    if (newKesReserve <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Insufficient market liquidity."
      });
    }

    await client.query(
      `UPDATE users
       SET mes_balance = mes_balance - $1,
           cash_balance = cash_balance + $2
       WHERE id = $3`,
      [amount, proceeds, req.userId]
    );

    await client.query(
      `UPDATE market_state
       SET mes_reserve = $1, kes_reserve = $2, updated_at = NOW()
       WHERE id = 1`,
      [newMesReserve, newKesReserve]
    );

    await client.query(
      `INSERT INTO transactions
       (from_user_id, to_user_id, type, amount, price, total)
       VALUES ($1, $1, 'sell', $2, $3, $4)`,
      [req.userId, amount, proceeds / amount, proceeds]
    );

    const newPrice = newKesReserve / newMesReserve;

    const updatedUser = await client.query(
      `SELECT account_number, mes_balance, cash_balance
       FROM users WHERE id = $1`,
      [req.userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Sale completed in the market pool.",
      amountMES: amount,
      receivedKES: proceeds,
      averagePriceKES: proceeds / amount,
      marketPriceKES: newPrice,
      availableMES: newMesReserve,
      user: updatedUser.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Sell error:", err.message);
    res.status(500).json({
      success: false,
      message: "Sell order could not be completed."
    });
  } finally {
    client.release();
  }
});

// SEND MES to another user's account number.
app.post("/api/send", authenticate, async (req, res) => {
  const accountNumber = String(req.body.accountNumber || "").trim();
  const amount = amountValue(req.body.amount);

  if (!accountNumber || !amount) {
    return res.status(400).json({
      success: false,
      message: "Enter recipient account number and a valid amount."
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const recipientResult = await client.query(
      "SELECT id, account_number FROM users WHERE account_number = $1",
      [accountNumber]
    );

    const recipient = recipientResult.rows[0];

    if (!recipient) throw new Error("RECIPIENT_NOT_FOUND");

    if (String(recipient.id) === String(req.userId)) {
      throw new Error("CANNOT_SEND_TO_SELF");
    }

    const ids = [String(req.userId), String(recipient.id)].sort(
      (a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)
    );

    const locked = await client.query(
      `SELECT id, mes_balance FROM users
       WHERE id = ANY($1::bigint[])
       ORDER BY id FOR UPDATE`,
      [ids]
    );

    const sender = locked.rows.find(
      row => String(row.id) === String(req.userId)
    );

    if (!sender) throw new Error("ACCOUNT_NOT_FOUND");

    if (Number(sender.mes_balance) < amount) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    await client.query(
      "UPDATE users SET mes_balance = mes_balance - $1 WHERE id = $2",
      [amount, req.userId]
    );

    await client.query(
      "UPDATE users SET mes_balance = mes_balance + $1 WHERE id = $2",
      [amount, recipient.id]
    );

    await client.query(
      `INSERT INTO transactions
       (from_user_id, to_user_id, type, amount, price, total)
       VALUES ($1, $2, 'send', $3, 0, 0)`,
      [req.userId, recipient.id, amount]
    );

    const updated = await client.query(
      `SELECT account_number, mes_balance
       FROM users WHERE id = $1`,
      [req.userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "MesCoin transfer completed.",
      amountMES: amount,
      recipientAccount: accountNumber,
      user: updated.rows[0]
    });
  } catch (err) {
    await client.query("ROLLBACK");

    const errors = {
      RECIPIENT_NOT_FOUND: [404, "Recipient account was not found."],
      CANNOT_SEND_TO_SELF: [400, "You cannot send to your own account."],
      INSUFFICIENT_BALANCE: [400, "Insufficient MES balance."],
      ACCOUNT_NOT_FOUND: [404, "Your account was not found."]
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

// Logged-in user's recent transaction history.
app.get("/api/transactions", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.type, t.amount, t.price, t.total, t.created_at,
              sender.account_number AS sender_account,
              recipient.account_number AS recipient_account
       FROM transactions t
       LEFT JOIN users sender ON sender.id = t.from_user_id
       LEFT JOIN users recipient ON recipient.id = t.to_user_id
       WHERE t.from_user_id = $1 OR t.to_user_id = $1
       ORDER BY t.created_at D
