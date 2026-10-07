const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// BASIC SETUP
// ======================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ======================================================
// DATABASE
// ======================================================

if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// ======================================================
// DATABASE INITIALIZATION
// ======================================================

async function initializeDatabase() {
    const client = await pool.connect();

    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                mes_balance NUMERIC(20,8) DEFAULT 100,
                cash_balance NUMERIC(20,2) DEFAULT 1000,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                token TEXT UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type TEXT NOT NULL CHECK (type IN ('BUY', 'SELL')),
                amount NUMERIC(20,8) NOT NULL,
                price NUMERIC(20,8) NOT NULL,
                status TEXT DEFAULT 'OPEN',
                matched_order_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("Database tables are ready.");
    } finally {
        client.release();
    }
}

// ======================================================
// PASSWORD FUNCTIONS
// ======================================================

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");

    const hash = crypto
        .scryptSync(password, salt, 64)
        .toString("hex");

    return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
    try {
        const parts = storedPassword.split(":");

        if (parts.length !== 2) {
            return false;
        }

        const salt = parts[0];
        const storedHash = parts[1];

        const hash = crypto
            .scryptSync(password, salt, 64)
            .toString("hex");

        return crypto.timingSafeEqual(
            Buffer.from(hash, "hex"),
            Buffer.from(storedHash, "hex")
        );
    } catch {
        return false;
    }
}

// ======================================================
// AUTHENTICATION
// ======================================================

async function getUserFromRequest(req) {
    const auth = req.headers.authorization;

    if (!auth) {
        return null;
    }

    if (!auth.startsWith("Bearer ")) {
        return null;
    }

    const token = auth.substring(7);

    const result = await pool.query(
        `
        SELECT users.*
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token = $1
        `,
        [token]
    );

    if (result.rows.length === 0) {
        return null;
    }

    return result.rows[0];
}

// ======================================================
// SERVER STATUS
// ======================================================

app.get("/", async (req, res) => {
    let database = "offline";

    try {
        await pool.query("SELECT NOW()");
        database = "online";
    } catch (error) {
        console.error("Database check failed:", error.message);
    }

    res.json({
        success: true,
        server: "MesCoin",
        status: "online",
        database: database,
        message: "MesCoin server is running"
    });
});

app.get("/api/status", async (req, res) => {
    try {
        await pool.query("SELECT NOW()");

        res.json({
            success: true,
            server: "MesCoin",
            status: "online",
            database: "online",
            message: "MesCoin server and database are connected"
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            server: "MesCoin",
            status: "online",
            database: "offline",
            message: "Server is running but database connection failed"
        });
    }
});

// ======================================================
// SIGN UP
// ======================================================

app.post("/api/signup", async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Name, email and password are required"
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters"
            });
        }

        const cleanEmail = email.trim().toLowerCase();

        const existing = await pool.query(
            "SELECT id FROM users WHERE email = $1",
            [cleanEmail]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: "An account with this email already exists"
            });
        }

        const passwordHash = hashPassword(password);

        const result = await pool.query(
            `
            INSERT INTO users
            (name, email, password_hash, mes_balance, cash_balance)
            VALUES ($1, $2, $3, 100, 1000)
            RETURNING id, name, email, mes_balance, cash_balance, created_at
            `,
            [name.trim(), cleanEmail, passwordHash]
        );

        const user = result.rows[0];

        res.json({
            success: true,
            message: "Account created successfully",
            user: user
        });

    } catch (error) {
        console.error("Signup error:", error);

        res.status(500).json({
            success: false,
            message: "Could not create account"
        });
    }
});

// ======================================================
// LOGIN
// ======================================================

app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required"
            });
        }

        const cleanEmail = email.trim().toLowerCase();

        const result = await pool.query(
            "SELECT * FROM users WHERE email = $1",
            [cleanEmail]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        const user = result.rows[0];

        if (!verifyPassword(password, user.password_hash)) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password"
            });
        }

        const token = crypto.randomBytes(32).toString("hex");

        await pool.query(
            `
            INSERT INTO sessions (user_id, token)
            VALUES ($1, $2)
            `,
            [user.id, token]
        );

        res.json({
            success: true,
            message: "Login successful",
            token: token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                mes_balance: user.mes_balance,
                cash_balance: user.cash_balance
            }
        });

    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message: "Login failed"
        });
    }
});

// ======================================================
// LOGOUT
// ======================================================

app.post("/api/logout", async (req, res) => {
    try {
        const auth = req.headers.authorization;

        if (auth && auth.startsWith("Bearer ")) {
            const token = auth.substring(7);

            await pool.query(
                "DELETE FROM sessions WHERE token = $1",
                [token]
            );
        }

        res.json({
            success: true,
            message: "Logged out"
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Logout failed"
        });
    }
});

// ======================================================
// ACCOUNT
// ======================================================

app.get("/api/account", async (req, res) => {
    try {
        const user = await getUserFromRequest(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "You must be logged in"
            });
        }

        res.json({
            success: true,
            account: {
                id: user.id,
                name: user.name,
                email: user.email,
                mes_balance: user.mes_balance,
                cash_balance: user.cash_balance
            }
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not load account"
        });
    }
});

// ======================================================
// BUY ORDER
// ======================================================

app.post("/api/orders/buy", async (req, res) => {
    const client = await pool.connect();

    try {
        const user = await getUserFromRequest(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "You must be logged in"
            });
        }

        const amount = Number(req.body.amount);
        const price = Number(req.body.price);

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid amount"
            });
        }

        if (!Number.isFinite(price) || price <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid price"
            });
        }

        const total = amount * price;

        await client.query("BEGIN");

        // Find an open SELL order from another account.
        const sellerResult = await client.query(
            `
            SELECT *
            FROM orders
            WHERE type = 'SELL'
            AND status = 'OPEN'
            AND user_id <> $1
            AND amount >= $2
            AND price <= $3
            ORDER BY price ASC, created_at ASC
            LIMIT 1
            FOR UPDATE
            `,
            [user.id, amount, price]
        );

        if (sellerResult.rows.length > 0) {
            const sellerOrder = sellerResult.rows[0];

            const sellerUserResult = await client.query(
                "SELECT * FROM users WHERE id = $1 FOR UPDATE",
                [sellerOrder.user_id]
            );

            const seller = sellerUserResult.rows[0];

            const buyerCash = Number(user.cash_balance);

            if (buyerCash < total) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message: "Insufficient cash balance"
                });
            }

            if (Number(seller.mes_balance) < amount) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message: "Seller does not have enough MesCoin"
                });
            }

            await client.query(
                `
                UPDATE users
                SET cash_balance = cash_balance - $1,
                    mes_balance = mes_balance + $2
                WHERE id = $3
                `,
                [total, amount, user.id]
            );

            await client.query(
                `
                UPDATE users
                SET cash_balance = cash_balance + $1,
                    mes_balance = mes_balance - $2
                WHERE id = $3
                `,
                [total, amount, seller.id]
            );

            await client.query(
                `
                UPDATE orders
                SET status = 'FILLED'
                WHERE id = $1
                `,
                [sellerOrder.id]
            );

            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Buy order matched with a seller",
                matched: true,
                amount: amount,
                price: price,
                total: total
            });
        }

        // No seller found: create a BUY order.
        await client.query(
            `
            INSERT INTO orders
            (user_id, type, amount, price, status)
            VALUES ($1, 'BUY', $2, $3, 'OPEN')
            `,
            [user.id, amount, price]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Buy order created and waiting for a seller",
            matched: false,
            amount: amount,
            price: price,
            total: total
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        console.error("Buy error:", error);

        res.status(500).json({
            success: false,
            message: "Buy order failed"
        });

    } finally {
        client.release();
    }
});

// ======================================================
// SELL ORDER
// ======================================================

app.post("/api/orders/sell", async (req, res) => {
    const client = await pool.connect();

    try {
        const user = await getUserFromRequest(req);

        if (!user) {
            return res.status(401).json({
                success: false,
                message: "You must be logged in"
            });
        }

        const amount = Number(req.body.amount);
        const price = Number(req.body.price);

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid amount"
            });
        }

        if (!Number.isFinite(price) || price <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid price"
            });
        }

        const total = amount * price;

        await client.query("BEGIN");

        // Find an open BUY order from another account.
        const buyerResult = await client.query(
            `
            SELECT *
            FROM orders
            WHERE type = 'BUY'
            AND status = 'OPEN'
            AND user_id <> $1
            AND amount >= $2
            AND price >= $3
            ORDER BY price DESC, created_at ASC
            LIMIT 1
            FOR UPDATE
            `,
            [user.id, amount, price]
        );

        if (buyerResult.rows.length > 0) {
            const buyerOrder = buyerResult.rows[0];

            const buyerUserResult = await client.query(
                "SELECT * FROM users WHERE id = $1 FOR UPDATE",
                [buyerOrder.user_id]
            );

            const buyer = buyerUserResult.rows[0];

            if (Number(user.mes_balance) < amount) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message: "Insufficient MesCoin balance"
                });
            }

            if (Number(buyer.cash_balance) < total) {
                await client.query("ROLLBACK");

                return res.status(400).json({
                    success: false,
                    message: "Buyer does not have enough cash"
                });
            }

            await client.query(
                `
                UPDATE users
                SET mes_balance = mes_balance - $1,
                    cash_balance = cash_balance + $2
                WHERE id = $3
                `,
                [amount, total, user.id]
            );

            await client.query(
                `
                UPDATE users
                SET mes_balance = mes_balance + $1,
                    cash_balance = cash_balance - $2
                WHERE id = $3
                `,
                [amount, total, buyer.id]
            );

            await client.query(
                `
                UPDATE orders
                SET status = 'FILLED'
                WHERE id = $1
                `,
                [buyerOrder.id]
            );

            await client.query("COMMIT");

            return res.json({
                success: true,
                message: "Sell order matched with a buyer",
                matched: true,
                amount: amount,
                price: price,
                total: total
            });
        }

        // No buyer found: create a SELL order.
        await client.query(
            `
            INSERT INTO orders
            (user_id, type, amount, price, status)
            VALUES ($1, 'SELL', $2, $3, 'OPEN')
            `,
            [user.id, amount, price]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Sell order created and waiting for a buyer",
            matched: false,
            amount: amount,
            price: price,
            total: total
        });

    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});

        console.error("Sell error:", error);

        res.status(500).json({
            success: false,
            message: "Sell order failed"
        });

    } finally {
        client.release();
    }
});

// ======================================================
// OPEN ORDERS
// ======================================================

app.get("/api/orders", async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                orders.id,
                orders.type,
                orders.amount,
                orders.price,
                orders.status,
                orders.created_at,
                users.name AS user_name
            FROM orders
            JOIN users ON users.id = orders.user_id
            WHERE orders.status = 'OPEN'
            ORDER BY orders.created_at DESC
            `
        );

        res.json({
            success: true,
            orders: result.rows
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Coul// ======================================================
// START SERVER
// ======================================================

async function startServer() {
    try {
        await initializeDatabase();

        app.listen(PORT
