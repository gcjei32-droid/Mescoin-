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

app.use(
    express.static(path.join(__dirname, "public"))
);

// ======================================================
// DATABASE
// ======================================================

if (!process.env.DATABASE_URL) {
    console.error("WARNING: DATABASE_URL is missing.");
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false,

    max: 10,

    idleTimeoutMillis: 30000,

    connectionTimeoutMillis: 10000
});

// ======================================================
// DATABASE INITIALIZATION
// ======================================================

async function initializeDatabase() {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is not configured");
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // --------------------------------------------------
        // USERS
        // --------------------------------------------------

        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,

                name TEXT NOT NULL,

                email TEXT UNIQUE NOT NULL,

                password_hash TEXT NOT NULL,

                mes_balance NUMERIC(30,8)
                    NOT NULL DEFAULT 100,

                cash_balance NUMERIC(30,2)
                    NOT NULL DEFAULT 1000,

                reserved_mes NUMERIC(30,8)
                    NOT NULL DEFAULT 0,

                reserved_cash NUMERIC(30,2)
                    NOT NULL DEFAULT 0,

                created_at TIMESTAMP
                    DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --------------------------------------------------
        // ADD NEW BALANCE COLUMNS IF OLD TABLE EXISTS
        // --------------------------------------------------

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS reserved_mes
            NUMERIC(30,8) NOT NULL DEFAULT 0;
        `);

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS reserved_cash
            NUMERIC(30,2) NOT NULL DEFAULT 0;
        `);

        // --------------------------------------------------
        // SESSIONS
        // --------------------------------------------------

        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,

                user_id INTEGER
                    REFERENCES users(id)
                    ON DELETE CASCADE,

                token TEXT UNIQUE NOT NULL,

                created_at TIMESTAMP
                    DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --------------------------------------------------
        // ORDERS
        // --------------------------------------------------

        await client.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id SERIAL PRIMARY KEY,

                user_id INTEGER
                    REFERENCES users(id)
                    ON DELETE CASCADE,

                type TEXT NOT NULL
                    CHECK (type IN ('BUY', 'SELL')),

                amount NUMERIC(30,8) NOT NULL,

                remaining_amount NUMERIC(30,8),

                price NUMERIC(30,8) NOT NULL,

                status TEXT NOT NULL DEFAULT 'OPEN',

                matched_order_id INTEGER,

                created_at TIMESTAMP
                    DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --------------------------------------------------
        // SUPPORT OLD ORDERS TABLE
        // --------------------------------------------------

        await client.query(`
            ALTER TABLE orders
            ADD COLUMN IF NOT EXISTS remaining_amount
            NUMERIC(30,8);
        `);

        await client.query(`
            UPDATE orders
            SET remaining_amount = amount
            WHERE remaining_amount IS NULL;
        `);

        // --------------------------------------------------
        // ORDER INDEXES
        // --------------------------------------------------

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            orders_status_type_idx
            ON orders(status, type);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            orders_user_idx
            ON orders(user_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS
            sessions_token_idx
            ON sessions(token);
        `);

        await client.query("COMMIT");

        console.log("Database tables are ready.");

    } catch (error) {

        await client.query("ROLLBACK");

        console.error(
            "Database initialization error:",
            error.message
        );

        throw error;

    } finally {
        client.release();
    }
}

// ======================================================
// PASSWORD FUNCTIONS
// ======================================================

function hashPassword(password) {

    const salt = crypto
        .randomBytes(16)
        .toString("hex");

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

        const a = Buffer.from(hash, "hex");

        const b = Buffer.from(storedHash, "hex");

        if (a.length !== b.length) {
            return false;
        }

        return crypto.timingSafeEqual(a, b);

    } catch (error) {

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

    const token = auth
        .substring(7)
        .trim();

    if (!token) {
        return null;
    }

    const result = await pool.query(
        `
        SELECT
            users.*
        FROM sessions
        JOIN users
            ON users.id = sessions.user_id
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
// HEALTH / SERVER STATUS
// ======================================================

app.get("/", async (req, res) => {

    let database = "offline";

    try {

        await pool.query("SELECT NOW()");

        database = "online";

    } catch (error) {

        console.error(
            "Database health check:",
            error.message
        );
    }

    res.json({

        success: true,

        server: "MesCoin",

        status: "online",

        database: database,

        message: database === "online"
            ? "MesCoin server and database are connected"
            : "MesCoin server is running but database is offline"

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

            message:
                "MesCoin server and database are connected"

        });

    } catch (error) {

        console.error(
            "Status error:",
            error.message
        );

        res.status(503).json({

            success: false,

            server: "MesCoin",

            status: "online",

            database: "offline",

            message:
                "Server is running but database connection failed"

        });
    }
});

// ======================================================
// SIGN UP
// ======================================================

app.post("/api/signup", async (req, res) => {

    try {

        const {
            name,
            email,
            password
        } = req.body;

        if (
            !name ||
            !email ||
            !password
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Name, email and password are required"

            });
        }

        const cleanName =
            String(name).trim();

        const cleanEmail =
            String(email)
                .trim()
                .toLowerCase();

        if (!cleanName || !cleanEmail) {

            return res.status(400).json({

                success: false,

                message:
                    "Name and email are required"

            });
        }

        if (password.length < 6) {

            return res.status(400).json({

                success: false,

                message:
                    "Password must be at least 6 characters"

            });
        }

        const existing =
            await pool.query(
                `
                SELECT id
                FROM users
                WHERE email = $1
                `,
                [cleanEmail]
            );

        if (existing.rows.length > 0) {

            return res.status(409).json({

                success: false,

                message:
                    "An account with this email already exists"

            });
        }

        const passwordHash =
            hashPassword(password);

        const result =
            await pool.query(
                `
                INSERT INTO users
                (
                    name,
                    email,
                    password_hash,
                    mes_balance,
                    cash_balance,
                    reserved_mes,
                    reserved_cash
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    100,
                    1000,
                    0,
                    0
                )
                RETURNING
                    id,
                    name,
                    email,
                    mes_balance,
                    cash_balance,
                    reserved_mes,
                    reserved_cash,
                    created_at
                `,
                [
                    cleanName,
                    cleanEmail,
                    passwordHash
                ]
            );

        res.json({

            success: true,

            message:
                "Account created successfully",

            user: result.rows[0]

        });

    } catch (error) {

        console.error(
            "Signup error:",
            error
        );

        if (error.code === "23505") {

            return res.status(409).json({

                success: false,

                message:
                    "An account with this email already exists"

            });
        }

        res.status(500).json({

            success: false,

            message:
                "Could not create account"

        });
    }
});

// ======================================================
// LOGIN
// ======================================================

app.post("/api/login", async (req, res) => {

    try {

        const {
            email,
            password
        } = req.body;

        if (!email || !password) {

            return res.status(400).json({

                success: false,

                message:
                    "Email and password are required"

            });
        }

        const cleanEmail =
            String(email)
                .trim()
                .toLowerCase();

        const result =
            await pool.query(
                `
                SELECT *
                FROM users
                WHERE email = $1
                `,
                [cleanEmail]
            );

        if (result.rows.length === 0) {

            return res.status(401).json({

                success: false,

                message:
                    "Invalid email or password"

            });
        }

        const user =
            result.rows[0];

        if (
            !verifyPassword(
                password,
                user.password_hash
            )
        ) {

            return res.status(401).json({

                success: false,

                message:
                    "Invalid email or password"

            });
        }

        const token =
            crypto
                .randomBytes(32)
                .toString("hex");

        await pool.query(
            `
            INSERT INTO sessions
            (
                user_id,
                token
            )
            VALUES
            (
                $1,
                $2
            )
            `,
            [
                user.id,
                token
            ]
        );

        res.json({

            success: true,

            message:
                "Login successful",

            token: token,

            user: {

                id: user.id,

                name: user.name,

                email: user.email,

                mes_balance:
                    user.mes_balance,

                cash_balance:
                    user.cash_balance,

                reserved_mes:
                    user.reserved_mes,

                reserved_cash:
                    user.reserved_cash
            }

        });

    } catch (error) {

        console.error(
            "Login error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Login failed"

        });
    }
});

// ======================================================
// LOGOUT
// ======================================================

app.post("/api/logout", async (req, res) => {

    try {

        const auth =
            req.headers.authorization;

        if (
            auth &&
            auth.startsWith("Bearer ")
        ) {

            const token =
                auth.substring(7).trim();

            await pool.query(
                `
                DELETE FROM sessions
                WHERE token = $1
                `,
                [token]
            );
        }

        res.json({

            success: true,

            message:
                "Logged out successfully"

        });

    } catch (error) {

        console.error(
            "Logout error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Logout failed"

        });
    }
});

// ======================================================
// ACCOUNT
// ======================================================

app.get("/api/account", async (req, res) => {

    try {

        const user =
            await getUserFromRequest(req);

        if (!user) {

            return res.status(401).json({

                success: false,

                message:
                    "You must be logged in"

            });
        }

        res.json({

            success: true,

            account: {

                id: user.id,

                name: user.name,

                email: user.email,

                mes_balance:
                    user.mes_balance,

                cash_balance:
                    user.cash_balance,

                reserved_mes:
                    user.reserved_mes,

                reserved_cash:
                    user.reserved_cash,

                available_mes:
                    Number(user.mes_balance) -
                    Number(user.reserved_mes),

                available_cash:
                    Number(user.cash_balance) -
                    Number(user.reserved_cash)

            }

        });

    } catch (error) {

        console.error(
            "Account error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Could not load account"

        });
    }
});

// ======================================================
// ORDER HISTORY
// ======================================================

app.get("/api/orders", async (req, res) => {

    try {

        const user =
            await getUserFromRequest(req);

        if (!user) {

            return res.status(401).json({

                success: false,

                message:
                    "You must be logged in"

            });
        }

        const result =
            await pool.query(
                `
                SELECT
                    id,
                    type,
                    amount,
                    remaining_amount,
                    price,
                    status,
                    matched_order_id,
                    created_at
                FROM orders
                WHERE user_id = $1
                ORDER BY created_at DESC
                `,
                [user.id]
            );

        res.json({

            success: true,

            orders:
                result.rows

        });

    } catch (error) {

        console.error(
            "Orders error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Could not load orders"

        });
    }
});

// ======================================================
// OPEN MARKET ORDERS
// ======================================================

app.get("/api/market", async (req, res) => {

    try {

        const result =
            await pool.query(
                `
                SELECT
                    id,
                    type,
                    amount,
                    remaining_amount,
                    price,
                    created_at
                FROM orders
                WHERE status = 'OPEN'
                AND remaining_amount > 0
                ORDER BY created_at ASC
                `
            );

        res.json({

            success: true,

            orders:
                result.rows

        });

    } catch (error) {

        console.error(
            "Market error:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Could not load market"

        });
    }
});

// ======================================================
// BUY ORDER
// ======================================================

app.post("/api/orders/buy", async (req, res) => {

    const client =
        await pool.connect();

    try {

        const user =
            await getUserFromRequest(req);

        if (!user) {

            return res.status(401).json({

                success: false,

                message:
                    "You must be logged in"

            });
        }

        const amount =
            Number(req.body.amount);

        const price =
            Number(req.body.price);

        if (
            !Number.
