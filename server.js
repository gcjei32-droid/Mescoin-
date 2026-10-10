const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const app = express();

app.use(cors());
app.use(express.json());

const SECRET = 'mescoin-secret-2026';
let users = []; // {id, full_name, phone, password, mes_account, kes_balance, mes_balance}
let orders = []; // {id, userId, type, amount, to_account, from_account, date}
let PRICE = 2;

function cleanPhone(p){
  return (p||'').toString().replace(/\D/g,'').slice(-10); // 768871831
}

// --- AUTH MIDDLEWARE ---
function auth(req,res,next){
  try{
    let token = req.headers.authorization?.split(' ')[1];
    if(!token) return res.status(401).json({error:'No token'});
    let decoded = jwt.verify(token, SECRET);
    let user = users.find(u=>u.id===decoded.id);
    if(!user) return res.status(401).json({error:'User not found'});
    req.user = user;
    next();
  }catch(e){ return res.status(401).json({error:'Invalid token'}); }
}

// --- API ---
app.get('/api/price', (req,res)=> res.json({price:PRICE}) );

app.post('/api/signup', (req,res)=>{
  try{
    let {full_name, phone, password} = req.body;
    if(!full_name ||!phone ||!password) return res.status(400).json({error:'Full Name, Mobile and Password required'});
    let cp = cleanPhone(phone);
    if(cp.length < 9) return res.status(400).json({error:'Invalid mobile number'});

    let exists = users.find(u=> cleanPhone(u.phone)===cp );
    if(exists) return res.status(400).json({error:'Mobile already registered - click LOGIN black button'});

    let mes_account = 'MES' + Math.floor(100000 + Math.random()*900000);
    let user = {
      id: Date.now().toString(),
      full_name: full_name.trim(),
      phone: cp,
      password: password,
      mes_account,
      kes_balance: 1000,
      mes_balance: 10
    };
    users.push(user);
    let token = jwt.sign({id:user.id}, SECRET);
    res.json({token, user});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/login', (req,res)=>{
  try{
    let {login_id, password} = req.body;
    if(!login_id ||!password) return res.status(400).json({error:'Enter Mobile/MES and Password'});

    let cp = cleanPhone(login_id);
    let idUpper = login_id.toString().trim().toUpperCase();

    let user = users.find(u=> cleanPhone(u.phone)===cp || u.mes_account.toUpperCase()===idUpper );
    if(!user) return res.status(400).json({error:'Account not found'});
    if(user.password!== password) return res.status(400).json({error:'Wrong password'});

    let token = jwt.sign({id:user.id}, SECRET);
    res.json({token, user});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/me', auth, (req,res)=> res.json(req.user));

app.get('/api/orders', auth, (req,res)=>{
  let list = orders.filter(o=> o.userId===req.user.id || o.to_account===req.user.mes_account).slice(-20).reverse();
  res.json(list);
});

app.post('/api/trade', auth, (req,res)=>{
  let {type, amount} = req.body;
  amount = parseFloat(amount);
  if(!amount || amount<=0) return res.status(400).json({error:'Enter valid amount'});
  if(type==='buy'){
    let cost = amount * PRICE;
    if(req.user.kes_balance < cost) return res.status(400).json({error:'Not enough KES'});
    req.user.kes_balance -= cost;
    req.user.mes_balance += amount;
    orders.push({id:Date.now(), userId:req.user.id, type:'BUY', amount, date:new Date()});
  }else{
    if(req.user.mes_balance < amount) return res.status(400).json({error:'Not enough MES'});
    req.user.mes_balance -= amount;
    req.user.kes_balance += amount * PRICE;
    orders.push({id:Date.now(), userId:req.user.id, type:'SELL', amount, date:new Date()});
  }
  res.json({user:req.user});
});

app.post('/api/send', auth, (req,res)=>{
  let {to_account, amount} = req.body;
  amount = parseFloat(amount);
  if(!to_account ||!amount) return res.status(400).json({error:'Enter receiver and amount'});
  to_account = to_account.trim().toUpperCase();
  if(to_account===req.user.mes_account) return res.status(400).json({error:'Cannot send to yourself'});
  if(req.user.mes_balance < amount) return res.status(400).json({error:'Not enough MES'});

  let receiver = users.find(u=> u.mes_account.toUpperCase()===to_account );
  if(!receiver) return res.status(400).json({error:'Receiver account '+to_account+' not found'});

  req.user.mes_balance -= amount;
  receiver.mes_balance += amount;

  orders.push({id:Date.now(), userId:req.user.id, type:'SEND', amount, to_account, date:new Date()});
  orders.push({id:Date.now()+1, userId:receiver.id, type:'RECEIVED', amount, from_account:req.user.mes_account, date:new Date()});

  res.json({message:'Sent '+amount+' MES to '+to_account, user:req.user});
});

// TEMP: delete a phone to allow re-signup - visit /api/reset/768871831
app.get('/api/reset/:phone', (req,res)=>{
  let cp = cleanPhone(req.params.phone);
  let before = users.length;
  users = users.filter(u=> cleanPhone(u.phone)!==cp);
  res.send(`Deleted ${before - users.length} user(s) with ${cp}. Now you can signup again.`);
});

app.get('/api/debug/users', (req,res)=> res.json(users.map(u=>({name:u.full_name, phone:u.phone, mes:u.mes_account}))));

// --- FRONTEND ---
app.get('/', (req,res)=>{
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MESCOIN</title>
<style>
body{font-family:system-ui;max-width:430px;margin:auto;padding:12px;background:#f0fdf4}
input,button{width:100%;padding:13px;margin:6px 0;border-radius:10px;border:1px solid #ddd;box-sizing:border-box;font-size:15px}
button{background:#16a34a;color:#fff;border:none;font-weight:bold;cursor:pointer}
button:disabled{opacity:.5}
.card{background:#fff;padding:14px;border-radius:14px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}
h1{color:#16a34a;text-align:center;margin:8px 0}
small{color:#666}
</style>
</head>
<body>
<h1>MESCOIN</h1>
<p style="text-align:center;margin:0 0 10px">Send MES by Account Number - LIVE</p>
<div class="card">Price: <b id="price">2</b> KES | My MES: <b id="top_mes">-</b></div>

<div id="auth" class="card">
<b>CREATE ACCOUNT</b><br>
<small>New here? Use this</small>
<input id="full_name" placeholder="Full Name">
<input id="phone" placeholder="Mobile e.g 0768871831">
<input id="password" type="password" placeholder="Password">
<button id="btnSignup" onclick="signup()">SIGN UP (1000 KES + 10 MES Free)</button>
<hr>
<b>ALREADY HAVE ACCOUNT?</b><br>
<small>Click LOGIN only, not signup</small>
<input id="login_id" placeholder="Mobile OR MES Account e.g 768871831 or MES123456">
<input id="login_password" type="password" placeholder="Password">
<button id="btnLogin" onclick="login()" style="background:#111">LOGIN → DASHBOARD</button>
<p id="msg" style="color:red;font-size:13px;min-height:18px"></p>
</div>

<div id="dash" style="display:none">
<div class="card" style="background:#dcfce7">
<b id="p_name"></b> ✅<br>
Mobile: <span id="p_phone"></span><br>
Your MES Account: <b id="acc" style="color:#16a34a;font-size:22px"></b><br><br>
KES: <b id="kes"></b><br>
MES: <b id="mes"></b>
</div>
<div class="card">
<h3 style="margin:0 0 6px">Send MES</h3>
<input id="to_account" placeholder="Receiver MES123456">
<input id="send_amt" type="number" placeholder="Amount e.g 5">
<button onclick="sendMes()" style="background:#2563eb">SEND NOW</button>
</div>
<div class="card">
<h3 style="margin:0 0 6px">Buy / Sell</h3>
<input id="amt" type="number" placeholder="Amount">
<button onclick="trade('buy')">BUY</button>
<button onclick="trade('sell')" style="background:#dc2626;margin-top:6px">SELL</button>
</div>
<div class="card">
<h3 style="margin:0 0 6px">History</h3>
<table id="orders" style="width:100%;font-size:12px;border-collapse:collapse"></table><br>
<button onclick="logout()" style="background:#333">Logout</button>
</div>
</div>

<script>
let token = localStorage.getItem('mes_token')||null;
async function loadPrice(){ try{ let r=await fetch('/api/price'); let d=await r.json(); document.getElementById('price').innerText=d.price; }catch{} } loadPrice();

function goToDashboard(user){
  document.getElementById('auth').style.display='none';
  document.getElementById('dash').style.display='block';
  document.getElementById('p_name').innerText=user.full_name;
  document.getElementById('p_phone').innerText=user.phone;
  document.getElementById('acc').innerText=user.mes_account;
  document.getElementById('kes').innerText=user.kes_balance;
  document.getElementById('mes').innerText=user.mes_balance;
  document.getElementById('top_mes').innerText=user.mes_balance;
  document.getElementById('msg').innerText='';
  loadOrders();
  window.scrollTo(0,0);
}

async function signup(){
  let btn=document.getElementById('btnSignup');
  btn.innerText='Creating...'; btn.disabled=true;
  document.getElementById('msg').innerText='';
  try{
    let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:document.getElementById('full_name').value.trim(),phone:document.getElementById('phone').value.trim(),password:document.getElementById('password').value})});
    let d=await r.json();
    if(d.error){ document.getElementById('msg').innerText=d.error; btn.innerText='SIGN UP (1000 KES + 10 MES Free)'; btn.disabled=false; return; }
    token=d.token; localStorage.setItem('mes_token',token);
    goToDashboard(d.user);
  }catch(e){ document.getElementById('msg').innerText='Network error: '+e.message; }
  btn.innerText='SIGN UP (1000 KES + 10 MES Free)'; btn.disabled=false;
}

async function login(){
  let btn=document.getElementById('btnLogin'); btn.innerText='Logging in...'; btn.disabled=true;
  document.getElementById('msg').innerText='';
  try{
    let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:document.getElementById('login_id').value.trim(),password:document.getElementById('login_password').value})});
    let d=await r.json();
    if(d.error){ document.getElementById('msg').innerText=d.error; btn.innerText='LOGIN → DASHBOARD'; btn.disabled=false; return; }
    token=d.token; localStorage.setItem('mes_token',token);
    goToDashboard(d.user);
  }catch(e){ document.getElementById('msg').innerText='Network error'; }
  btn.innerText='LOGIN → DASHBOARD'; btn.disabled=false;
}

async function loadOrders(){ try{ let r=await fetch('/api/orders',{headers:{Authorization:'Bearer '+token}}); let list=await r.json(); let h='<tr><th>Type</th><th>Amt</th><th>To/From</th></tr>'; list.forEach(o=>{ let other=o.type==='SEND'?o.to_account:o.type==='RECEIVED'?o.from_account:''; h+='<tr><td>'+o.type+'</td><td>'+o.amount+'</td><td>'+(other||'-')+'</td></tr>'; }); document.getElementById('orders').innerHTML=h; }catch{} }

async function trade(type){ let a=parseFloat(document.getElementById('amt').value); if(!a)return alert('Enter amount'); let r=await fetch('/api/trade',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({type,amount:a})}); let d=await r.json(); if(d.error)return alert(d.error); document.getElementById('kes').innerText=d.user.kes_balance; document.getElementById('mes').innerText=d.user.mes_balance; document.getElementById('top_mes').innerText=d.user.mes_balance; loadOrders(); }

async function sendMes(){ let to=document.getElementById('to_account').value.trim().toUpperCase(); let amt=parseFloat(document.getElementById('send_amt').value); if(!to||!amt)return alert('Enter account and amount'); if(!confirm('Send '+amt+' MES to '+to+'?'))return; let r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({to_account:to,amount:amt})}); let d=await r.json(); if(d.error){ alert(d.error); return; } alert(d.message); document.getElementById('kes').innerText=d.user.kes_balance; document.getElementById('mes').innerText=d.user.mes_balance; document.getElementById('top_mes').innerText=d.user.mes_balance; loadOrders(); document.getElementById('to_account').value=''; document.getElementById('send_amt').value=''; }

function logout(){ localStorage.removeItem('mes_token'); token=null; document.getElementById('auth').style.display='block'; document.getElementById('dash').style.display='none'; }

(async()=>{ if(token){ try{ let r=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}}); if(r.ok){ let u=await r.json(); goToDashboard(u); } }catch{} } })();
</script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('MESCOIN running on '+PORT));
