const express = require('express');
const fs = require('fs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const app = express();
app.use(cors());
app.use(express.json());

const SECRET = 'mescoin-secret-2026';
const DB_FILE = './database.json';
const CK = process.env.MPESA_CONSUMER_KEY;
const CS = process.env.MPESA_CONSUMER_SECRET;
const PASSKEY = process.env.MPESA_PASSKEY;
const SHORTCODE = process.env.MPESA_SHORTCODE || '174379';
const CALLBACK = process.env.MPESA_CALLBACK_URL || 'https://mescoin-1.onrender.com/api/mpesa/callback';

function loadDB(){
  if(!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[], orders:[], trades:[]}));
  return JSON.parse(fs.readFileSync(DB_FILE,'utf8'));
}
function saveDB(d){ fs.writeFileSync(DB_FILE, JSON.stringify(d,null,2)); }
let db=loadDB();
let users=db.users||[];
let orders=db.orders||[];
let trades=db.trades||[];
function save(){ saveDB({users,orders,trades}); }

function cleanPhone(p){ return (p||'').toString().replace(/\D/g,'').slice(-10); }
function auth(req,res,next){
  try{
    let t=req.headers.authorization?.split(' ')[1];
    let dec=jwt.verify(t,SECRET);
    req.user=users.find(u=>u.id===dec.id);
    if(!req.user) return res.status(401).json({error:'User not found'});
    next();
  }catch{ return res.status(401).json({error:'Invalid token'}); }
}
async function getToken(){
  let b=Buffer.from(`${CK}:${CS}`).toString('base64');
  let r=await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:`Basic ${b}`}});
  return r.data.access_token;
}

app.get('/api/price', (req,res)=>res.json({price:2}));
app.post('/api/signup', (req,res)=>{
  let {full_name, phone, password}=req.body;
  if(!full_name||!phone||!password) return res.status(400).json({error:'All required'});
  let cp=cleanPhone(phone);
  if(users.find(u=>cleanPhone(u.phone)===cp)) return res.status(400).json({error:'Mobile already registered - click LOGIN'});
  let user={id:Date.now().toString(), full_name:full_name.trim(), phone:cp, password, mes_account:'MES'+Math.floor(100000+Math.random()*900000), kes_balance:0, mes_balance:0};
  users.push(user); save();
  let token=jwt.sign({id:user.id},SECRET);
  res.json({token,user});
});
app.post('/api/login', (req,res)=>{
  let {login_id,password}=req.body;
  let cp=cleanPhone(login_id); let up=login_id.toString().trim().toUpperCase();
  let u=users.find(x=>cleanPhone(x.phone)===cp || x.mes_account.toUpperCase()===up);
  if(!u) return res.status(400).json({error:'Account not found'});
  if(u.password!==password) return res.status(400).json({error:'Wrong password'});
  let token=jwt.sign({id:u.id},SECRET);
  res.json({token,user:u});
});
app.get('/api/me', auth, (req,res)=>res.json(req.user));
app.get('/api/orders', auth, (req,res)=>{
  let list=orders.filter(o=>o.userId===req.user.id).slice(-20).reverse();
  res.json(list);
});
app.get('/api/market', (req,res)=>{
  res.json({buys:orders.filter(o=>o.type==='BUY'&&o.status==='PENDING').slice(-20), sells:orders.filter(o=>o.type==='SELL'&&o.status==='PENDING').slice(-20)});
});

// P2P BUY
app.post('/api/order/buy', auth, async (req,res)=>{
  let {amount}=req.body; amount=parseFloat(amount);
  if(!amount) return res.status(400).json({error:'Enter amount'});
  let buyOrder={id:Date.now().toString(), userId:req.user.id, type:'BUY', amount, price:2, status:'PENDING', date:new Date()};
  orders.push(buyOrder); save();
  let sellMatch=orders.find(o=>o.type==='SELL'&&o.status==='PENDING'&&o.userId!==req.user.id&&o.amount===amount);
  if(sellMatch){
    buyOrder.status='MATCHED'; buyOrder.matchedWith=sellMatch.id;
    sellMatch.status='MATCHED'; sellMatch.matchedWith=buyOrder.id;
    save();
    try{
      let token=await getToken();
      let timestamp=new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
      let pwd=Buffer.from(SHORTCODE+PASSKEY+timestamp).toString('base64');
      let phone254='254'+cleanPhone(req.user.phone);
      let cost=amount*2;
      await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',{
        BusinessShortCode:SHORTCODE, Password:pwd, Timestamp:timestamp, TransactionType:"CustomerPayBillOnline",
        Amount:Math.round(cost), PartyA:phone254, PartyB:SHORTCODE, PhoneNumber:phone254,
        CallBackURL:CALLBACK, AccountReference:sellMatch.id, TransactionDesc:`Buy ${amount} MES`
      },{headers:{Authorization:`Bearer ${token}`}});
      return res.json({message:`MATCHED! STK sent to you. Enter PIN. Money goes to seller ${sellMatch.id}`, user:req.user});
    }catch(e){
      return res.json({message:`Matched with seller but STK failed: ${e.response?.data?.errorMessage||e.message}`, user:req.user});
    }
  }
  res.json({message:`Buy order saved in DB waiting for seller`, user:req.user});
});

// P2P SELL
app.post('/api/order/sell', auth, (req,res)=>{
  let {amount}=req.body; amount=parseFloat(amount);
  if(req.user.mes_balance < amount) return res.status(400).json({error:'Not enough MES'});
  let sellOrder={id:Date.now().toString(), userId:req.user.id, type:'SELL', amount, price:2, status:'PENDING', date:new Date()};
  req.user.mes_balance-=amount;
  orders.push(sellOrder); save();
  res.json({message:`Sell order saved, MES locked. Waiting for buyer`, user:req.user});
});

app.post('/api/mpesa/callback', (req,res)=>{
  try{
    let cb=req.body.Body?.stkCallback;
    console.log('CALLBACK',JSON.stringify(req.body));
    if(cb?.ResultCode===0){
      let items=cb.CallbackMetadata.Item;
      let amount=items.find(i=>i.Name==='Amount')?.Value;
      let orderId=cb.AccountReference;
      let sellOrder=orders.find(o=>o.id===orderId);
      if(sellOrder){
        let seller=users.find(u=>u.id===sellOrder.userId);
        let buyOrder=orders.find(o=>o.matchedWith===sellOrder.id);
        let buyer=buyOrder?users.find(u=>u.id===buyOrder.userId):null;
        if(seller&&buyer){
          seller.kes_balance+=Number(amount);
          buyer.mes_balance+=sellOrder.amount;
          sellOrder.status='COMPLETED'; buyOrder.status='COMPLETED';
          trades.push({id:Date.now(), amount:sellOrder.amount, kes:amount, date:new Date()});
          save();
        }
      }
    }
    res.json({ResultCode:0});
  }catch{ res.json({ResultCode:0}); }
});

app.post('/api/send', auth, (req,res)=>{
  let {to_account, amount}=req.body; amount=parseFloat(amount);
  to_account=to_account.trim().toUpperCase();
  if(req.user.mes_balance<amount) return res.status(400).json({error:'Not enough MES'});
  let receiver=users.find(u=>u.mes_account.toUpperCase()===to_account);
  if(!receiver) return res.status(400).json({error:'Receiver not found'});
  req.user.mes_balance-=amount; receiver.mes_balance+=amount;
  orders.push({id:Date.now(), userId:req.user.id, type:'SEND', amount, to_account, date:new Date()});
  save();
  res.json({message:`Sent ${amount} to ${to_account}`, user:req.user});
});

app.get('/', (req,res)=>{
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MESCOIN</title><style>body{font-family:system-ui;max-width:430px;margin:auto;padding:12px;background:#f0fdf4}input,button{width:100%;padding:13px;margin:6px 0;border-radius:10px;border:1px solid #ddd;box-sizing:border-box;font-size:15px}button{background:#16a34a;color:#fff;border:none;font-weight:bold;cursor:pointer}.card{background:#fff;padding:14px;border-radius:14px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,.06)}h1{color:#16a34a;text-align:center}small{color:#666}</style></head><body><h1>MESCOIN P2P</h1><p style="text-align:center">Buy/Sell saved in DB + STK to seller</p><div class="card">My MES: <b id="top_mes">-</b> | KES: <b id="top_kes">-</b> | Price 2 KES</div><div id="auth" class="card"><b>CREATE ACCOUNT</b><input id="full_name" placeholder="Full Name"><input id="phone" placeholder="Mobile 0768..."><input id="password" type="password" placeholder="Password"><button id="btnSignup" onclick="signup()">SIGN UP</button><hr><b>LOGIN</b><input id="login_id" placeholder="Mobile or MES Account"><input id="login_password" type="password" placeholder="Password"><button onclick="login()" style="background:#111">LOGIN → DASHBOARD</button><p id="msg" style="color:red"></p></div><div id="dash" style="display:none"><div class="card" style="background:#dcfce7"><b id="p_name"></b><br>Mobile: <span id="p_phone"></span><br>MES Account: <b id="acc" style="font-size:20px;color:#16a34a"></b><br><br>KES: <b id="kes"></b><br>MES: <b id="mes"></b></div><div class="card"><h3>P2P Market Orders</h3><div id="market" style="font-size:12px"></div><button onclick="loadMarket()" style="background:#555">Refresh Market</button></div><div class="card" style="border:2px solid #16a34a"><h3>Request BUY (saved in DB)</h3><input id="buy_amt" type="number" placeholder="Amount e.g 10"><button onclick="buyOrder()">BUY ORDER - WAIT MATCH</button></div><div class="card" style="border:2px solid #dc2626"><h3>Request SELL (MES locked)</h3><input id="sell_amt" type="number" placeholder="Amount e.g 10"><button onclick="sellOrder()" style="background:#dc2626">SELL ORDER - WAIT BUYER</button></div><div class="card"><h3>Send MES Direct</h3><input id="to_account" placeholder="Receiver MES123456"><input id="send_amt" type="number" placeholder="Amount"><button onclick="sendMes()" style="background:#2563eb">SEND NOW</button></div><div class="card"><h3>My History</h3><table id="orders" style="width:100%;font-size:12px"></table><br><button onclick="logout()" style="background:#333">Logout</button></div></div><script>let token=localStorage.getItem('mes_token')||null;function goToDashboard(u){document.getElementById('auth').style.display='none';document.getElementById('dash').style.display='block';document.getElementById('p_name').innerText=u.full_name;document.getElementById('p_phone').innerText=u.phone;document.getElementById('acc').innerText=u.mes_account;document.getElementById('kes').innerText=u.kes_balance;document.getElementById('mes').innerText=u.mes_balance;document.getElementById('top_mes').innerText=u.mes_balance;document.getElementById('top_kes').innerText=u.kes_balance;loadOrders();loadMarket();}async function signup(){let r=await fetch('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({full_name:document.getElementById('full_name').value,phone:document.getElementById('phone').value,password:document.getElementById('password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}async function login(){let r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login_id:document.getElementById('login_id').value,password:document.getElementById('login_password').value})});let d=await r.json();if(d.error){document.getElementById('msg').innerText=d.error;return;}token=d.token;localStorage.setItem('mes_token',token);goToDashboard(d.user);}async function loadOrders(){let r=await fetch('/api/orders',{headers:{Authorization:'Bearer '+token}});let list=await r.json();let h='<tr><th>Type</th><th>Amt</th><th>Status</th></tr>';list.forEach(o=>{h+=\`<tr><td>\${o.type}</td><td>\${o.amount}</td><td>\${o.status||'-'}</td></tr>\`});document.getElementById('orders').innerHTML=h;}async function loadMarket(){let r=await fetch('/api/market');let d=await r.json();let h='<b>BUY Requests:</b><br>';d.buys.forEach(o=>{h+=o.amount+' MES wanted<br>'});h+='<br><b>SELL Offers:</b><br>';d.sells.forEach(o=>{h+=o.amount+' MES available<br>'});document.getElementById('market').innerHTML=h||'No orders';}async function buyOrder(){let a=document.getElementById('buy_amt').value;let r=await fetch('/api/order/buy',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount:a})});let d=await r.json();alert(d.message||d.error);if(d.user)goToDashboard(d.user);}async function sellOrder(){let a=document.getElementById('sell_amt').value;let r=await fetch('/api/order/sell',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount:a})});let d=await r.json();alert(d.message||d.error);if(d.user)goToDashboard(d.user);}async function sendMes(){let to=document.getElementById('to_account').value;let amt=document.getElementById('send_amt').value;let r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({to_account:to,amount:amt})});let d=await r.json();alert(d.message||d.error);if(d.user)goToDashboard(d.user);}function logout(){localStorage.removeItem('mes_token');location.reload();}(async()=>{if(token){let r=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(r.ok)goToDashboard(await r.json());}})();</script></body></html>`);
});

const PORT=process.env.PORT||10000;
app.listen(PORT, ()=>console.log('MESCOIN P2P with screen running '+PORT));
