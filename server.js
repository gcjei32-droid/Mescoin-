const express = require('express');
const app = express();
app.use(express.json());

let users = {};

// HTML IS INSIDE HERE - No separate file needed
const HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mescoin</title><style>body{background:#0a0a0a;color:white;font-family:Arial;padding:20px}h1{text-align:center;color:#FFD700}.card{background:#1a1a1a;padding:18px;border-radius:15px}input{width:100%;padding:13px;margin:7px 0;border-radius:10px;border:none;background:#333;color:white}button{width:100%;padding:14px;border:none;border-radius:10px;font-weight:bold;margin:6px 0}.yellow{background:#FFD700}.green{background:#00c853;color:white}</style></head><body><h1>🪙 MESCOIN</h1><div id="loginPage" class="card"><h2>Welcome</h2><input id="name" placeholder="Your Name"><input id="phone" placeholder="Phone e.g 0722000000"><input id="pin" type="password" placeholder="PIN e.g 1234"><button class="yellow" onclick="signup()">CREATE ACCOUNT</button><button class="green" onclick="login()">LOGIN</button><p id="msg"></p></div><div id="appPage" class="card" style="display:none"><h3>Hello <span id="uName"></span></h3><p>Balance: KSh <b id="bal">0</b> | Coins: <b id="coins">0</b> MES</p><hr><h3>Send Mescoin</h3><input id="toPhone" placeholder="To Phone - must have account"><input id="sendMes" type="number" placeholder="MES to send"><button class="yellow" onclick="sendCoin()">SEND</button><p id="msg2"></p><button onclick="location.reload()">Logout</button></div><script>let myPhone="";async function signup(){let name=document.getElementById('name').value,phone=document.getElementById('phone').value,pin=document.getElementById('pin').value;let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,phone,pin})});let d=await r.json();document.getElementById('msg').innerText=d.msg;if(d.success){myPhone=phone;show(d.user);}}async function login(){let phone=document.getElementById('phone').value,pin=document.getElementById('pin').value;let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,pin})});let d=await r.json();document.getElementById('msg').innerText=d.msg;if(d.success){myPhone=phone;show(d.user);}}async function sendCoin(){let toPhone=document.getElementById('toPhone').value,coins=parseFloat(document.getElementById('sendMes').value);let r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fromPhone:myPhone,toPhone,coins})});let d=await r.json();document.getElementById('msg2').innerText=d.msg;if(d.success)show(d.user);}function show(user){document.getElementById('loginPage').style.display='none';document.getElementById('appPage').style.display='block';document.getElementById('uName').innerText=user.name;document.getElementById('bal').innerText=user.balance;document.getElementById('coins').innerText=user.coins;}</script></body></html>`;

app.get('/', (req, res) => {
  res.send(HTML);
});

app.post('/api/signup', (req, res) => {
  const { name, phone, pin } = req.body;
  if (users[phone]) return res.json({ success: false, msg: "Account already exists. Please LOGIN" });
  users[phone] = { name, phone, pin, coins: 0, balance: 1000 };
  res.json({ success: true, msg: "Account Created! Bonus 1000 KSh", user: users[phone] });
});

app.post('/api/login', (req, res) => {
  const { phone, pin } = req.body;
  if (!users[phone]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  if (users[phone].pin !== pin) return res.json({ success: false, msg: "Wrong PIN" });
  res.json({ success: true, msg: "Welcome " + users[phone].name, user: users[phone] });
});

app.post('/api/send', (req, res) => {
  const { fromPhone, toPhone, coins } = req.body;
  if (!users[toPhone]) return res.json({ success: false, msg: "❌ " + toPhone + " has NO account. Tell them to create account." });
  if (users[fromPhone].coins < coins) return res.json({ success: false, msg: "Not enough MES" });
  users[fromPhone].coins -= coins;
  users[toPhone].coins += coins;
  res.json({ success: true, msg: "Sent " + coins + " MES to " + users[toPhone].name, user: users[fromPhone] });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on " + PORT));
