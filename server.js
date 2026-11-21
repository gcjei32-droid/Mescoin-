const express = require('express');
const app = express();
app.use(express.json());

let users = {};
const PRICE = 10; // KSh per 1 MES

const HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mescoin</title><style>body{background:#0a0a0a;color:white;font-family:Arial;padding:20px}h1{text-align:center;color:#FFD700}.card{background:#1a1a1a;padding:18px;border-radius:15px;margin-bottom:15px}input{width:100%;box-sizing:border-box;padding:13px;margin:7px 0;border-radius:10px;border:none;background:#333;color:white}button{width:100%;padding:14px;border:none;border-radius:10px;font-weight:bold;margin:6px 0}.yellow{background:#FFD700}.green{background:#00c853;color:white}.red{background:#e53935;color:white}.row{display:flex;gap:10px}.row button{flex:1}.hist{font-size:13px;color:#bbb;margin:4px 0}</style></head><body><h1>🪙 MESCOIN</h1><div id="loginPage" class="card"><h2>Welcome</h2><input id="name" placeholder="Your Name"><input id="phone" placeholder="Phone e.g 0722000000"><input id="pin" type="password" placeholder="PIN e.g 1234"><button class="yellow" onclick="signup()">CREATE ACCOUNT</button><button class="green" onclick="login()">LOGIN</button><p id="msg"></p></div><div id="appPage" style="display:none"><div class="card"><h3>Hello <span id="uName"></span></h3><p>Balance: KSh <b id="bal">0</b> | Coins: <b id="coins">0</b> MES</p></div><div class="card"><h3>Buy / Sell Mescoin</h3><p>Price: KSh <b id="price">10</b> per 1 MES</p><input id="orderMes" type="number" min="0" step="any" placeholder="Amount of MES" oninput="est()"><p id="est"></p><div class="row"><button class="green" onclick="placeOrder('buy')">BUY</button><button class="red" onclick="placeOrder('sell')">SELL</button></div><p id="msg3"></p><div id="hist"></div></div><div class="card"><h3>Send Mescoin</h3><input id="toPhone" placeholder="To Phone - must have account"><input id="sendMes" type="number" placeholder="MES to send"><button class="yellow" onclick="sendCoin()">SEND</button><p id="msg2"></p></div><button onclick="location.reload()">Logout</button></div><script>let myPhone="",myPin="",PRICE=10;function $(i){return document.getElementById(i)}async function post(u,b){let r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json()}async function signup(){let name=$('name').value,phone=$('phone').value,pin=$('pin').value;let d=await post('/api/signup',{name,phone,pin});$('msg').innerText=d.msg;if(d.success){myPhone=phone;myPin=pin;show(d.user);}}async function login(){let phone=$('phone').value,pin=$('pin').value;let d=await post('/api/login',{phone,pin});$('msg').innerText=d.msg;if(d.success){myPhone=phone;myPin=pin;show(d.user);}}async function sendCoin(){let toPhone=$('toPhone').value,coins=parseFloat($('sendMes').value);let d=await post('/api/send',{fromPhone:myPhone,pin:myPin,toPhone,coins});$('msg2').innerText=d.msg;if(d.success)show(d.user);}async function placeOrder(type){let coins=parseFloat($('orderMes').value);let d=await post('/api/order',{phone:myPhone,pin:myPin,type,coins});$('msg3').innerText=d.msg;if(d.success){$('orderMes').value='';$('est').innerText='';show(d.user);}}function est(){let c=parseFloat($('orderMes').value);$('est').innerText=c>0?('= KSh '+(c*PRICE)):'';}function show(user){$('loginPage').style.display='none';$('appPage').style.display='block';$('uName').innerText=user.name;$('bal').innerText=user.balance;$('coins').innerText=user.coins;let h='';(user.orders||[]).slice(-5).reverse().forEach(function(o){h+='<div class="hist">'+o.type.toUpperCase()+' '+o.coins+' MES @ KSh '+o.price+' = KSh '+o.total+'</div>';});$('hist').innerHTML=h;}</script></body></html>`;

function safe(u) {
  const { pin, ...rest } = u;
  return rest;
}

app.get('/', (req, res) => {
  res.send(HTML);
});

app.post('/api/signup', (req, res) => {
  const { name, phone, pin } = req.body;
  if (!name || !phone || !pin) return res.json({ success: false, msg: "Fill in all fields" });
  if (users[phone]) return res.json({ success: false, msg: "Account already exists. Please LOGIN" });
  users[phone] = { name, phone, pin, coins: 0, balance: 1000, orders: [] };
  res.json({ success: true, msg: "Account Created! Bonus 1000 KSh", user: safe(users[phone]) });
});

app.post('/api/login', (req, res) => {
  const { phone, pin } = req.body;
  if (!users[phone]) return res.json({ success: false, msg: "No account. Please CREATE ACCOUNT first" });
  if (users[phone].pin !== pin) return res.json({ success: false, msg: "Wrong PIN" });
  res.json({ success: true, msg: "Welcome " + users[phone].name, user: safe(users[phone]) });
});

// BUY / SELL ORDER
app.post('/api/order', (req, res) => {
  const { phone, pin, type } = req.body;
  const coins = Number(req.body.coins);
  const u = users[phone];
  if (!u || u.pin !== pin) return res.json({ success: false, msg: "Not authorised" });
  if (type !== 'buy' && type !== 'sell') return res.json({ success: false, msg: "Invalid order type" });
  if (!isFinite(coins) || coins <= 0) return res.json({ success: false, msg: "Enter a valid amount" });

  const total = Math.round(coins * PRICE * 100) / 100;

  if (type === 'buy') {
    if (u.balance < total) return res.json({ success: false, msg: "Not enough KSh. Need " + total });
    u.balance = Math.round((u.balance - total) * 100) / 100;
    u.coins += coins;
  } else {
    if (u.coins < coins) return res.json({ success: false, msg: "Not enough MES to sell" });
    u.coins -= coins;
    u.balance = Math.round((u.balance + total) * 100) / 100;
  }

  u.orders.push({ type, coins, price: PRICE, total, time: Date.now() });
  const verb = type === 'buy' ? "Bought " : "Sold ";
  res.json({ success: true, msg: verb + coins + " MES for KSh " + total, user: safe(u) });
});

app.post('/api/send', (req, res) => {
  const { fromPhone, pin, toPhone } = req.body;
  const coins = Number(req.body.coins);
  const from = users[fromPhone];
  if (!from || from.pin !== pin) return res.json({ success: false, msg: "Not authorised" });
  if (!users[toPhone]) return res.json({ success: false, msg: "❌ " + toPhone + " has NO account. Tell them to create account." });
  if (!isFinite(coins) || coins <= 0) return res.json({ success: false, msg: "Enter a valid amount" });
  if (from.coins < coins) return res.json({ success: false, msg: "Not enough MES" });
  from.coins -= coins;
  users[toPhone].coins += coins;
  res.json({ success: true, msg: "Sent " + coins + " MES to " + users[toPhone].name, user: safe(from) });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Running on " + PORT));
    
