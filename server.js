const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// Serve the MesCoin app
app.use(express.static(path.join(__dirname, "public")));

// Demo wallet data
let wallet = {
  mes: 100,
  cash: 1000
};

// MesCoin price
let mesPrice = 1;

// SERVER STATUS
app.get("/api/status", (req, res) => {
  res.json({
    success: true,
    message: "MesCoin server is running",
    status: "online"
  });
});

// BALANCE
app.get("/api/balance", (req, res) => {
  res.json({
    success: true,
    mes: wallet.mes,
    cash: wallet.cash,
    price: mesPrice,
    currency: "MES"
  });
});

// BUY MES
app.post("/api/buy", (req, res) => {
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid amount"
    });
  }

  const cost = amount * mesPrice;

  if (cost > wallet.cash) {
    return res.status(400).json({
      success: false,
      message: "Insufficient cash balance"
    });
  }

  wallet.cash -= cost;
  wallet.mes += amount;

  res.json({
    success: true,
    message: "MES bought successfully",
    bought: amount,
    price: mesPrice,
    mes: wallet.mes,
    cash: wallet.cash
  });
});

// SELL MES
app.post("/api/sell", (req, res) => {
  const amount = Number(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid amount"
    });
  }

  if (amount > wallet.mes) {
    return res.status(400).json({
      success: false,
      message: "Insufficient MES balance"
    });
  }

  const received = amount * mesPrice;

  wallet.mes -= amount;
  wallet.cash += received;

  res.json({
    success: true,
    message: "MES sold successfully",
    sold: amount,
    price: mesPrice,
    mes: wallet.mes,
    cash: wallet.cash
  });
});

// Keep the web app working
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Render supplies its own PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MesCoin server running on port ${PORT}`);
});
