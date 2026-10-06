const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "MesCoin server is running!",
    status: "online"
  });
});

app.get("/balance", (req, res) => {
  res.json({
    balance: 0,
    currency: "MES"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`MesCoin server running on port ${PORT}`);
});
