const express=require('express'),fs=require('fs'),path=require('path'),crypto=require('crypto'),jwt=require('jsonwebtoken'),cors=require('cors');
const app=express(); app.use(cors()); app.use(express.json());
const DB_FILE=fs.existsSync('/data')?'/data/database.json':'./database.json';
const SECRET=process.env.JWT_SECRET||'btc-mescoin-secret';
const FOUNDER='254768871831'; const FOUNDER_CODE=process.env.FOUNDER_CODE||'MES100M';
const clean=p=>(p||'').toString().replace(/\D/g,'').slice(-9);
const newId=()=>crypto.randomUUID();

function hashSha(d){return crypto.createHash('sha256').update(d).digest('hex');}
function blockHash(prev,time,txs,nonce){return hashSha(prev+time+JSON.stringify(txs)+nonce);}

function loadChain(){
 if(!fs.existsSync(DB_FILE)){let g={index:0,prev_hash:'0',timestamp:new Date().toISOString(),transactions:[{from:'GENESIS',to:'NETWORK',amount:0}],nonce:0,hash:''}; g.hash=blockHash(g.prev_hash,g.timestamp,g.transactions,g.nonce); fs.writeFileSync(DB_FILE,JSON.stringify({users:[],blockchain:[g]},null,2));}
 let r=JSON.parse(fs.readFileSync(DB_FILE,'utf8')); if(!r.blockchain.length){let g={index:0,prev_hash:'0',timestamp:new Date().toISOString(),transactions:[{from:'GENESIS',to:'NETWORK',amount:0}],nonce:0,hash:''}; g.hash=blockHash(g.prev_hash,g.timestamp,g.transactions,g.nonce); r.blockchain=[g];} return r;
}
let db=loadChain(); let users=db.users||[]; let blockchain=db.blockchain||[];
function save(){fs.writeFileSync(DB_FILE,JSON.stringify({users,blockchain},null,2));}

function getBalance(acc){
 let b=0; let a=acc.toUpperCase();
 for(let bl of blockchain) for(let tx of bl.transactions){ if(tx.to&&tx.to.toUpperCase()===a) b+=Number(tx.amount); if(tx.from&&tx.from.toUpperCase()===a) b-=Number(tx.amount); }
 return b;
}
function mine(txs){
 let prev=blockchain[blockchain.length-1]; let ts=new Date().toISOString(); let nonce=0; let h='';
 do{nonce++; h=blockHash(prev.hash,ts,txs,nonce);}while(!h.startsWith('00'));
 return {index:prev.index+1,prev_hash:prev.hash,timestamp:ts,transactions:txs,nonce,hash:h};
}
function addBlock(txs){let b=mine(txs); blockchain.push(b); save(); return b;}

function hashPw(pw){let s=crypto.randomBytes(16).toString('hex'); return 'scrypt$'+s+'$'+crypto.scryptSync(String(pw),s,32).toString('hex');}
function checkPw(u,pw){let s=u.password||''; if(s.startsWith('scrypt$')){let p=s.split('$'); let a=crypto.scryptSync(String(pw),p[1],32); let b=Buffer.from(p[2],'hex'); return a.length===b.length&&crypto.timingSafeEqual(a,b);} return false;}
function safe(u){let {password,...r}=u; return r;}

function auth(req,res,next){try{let t=req.headers.authorization?.split(' ')[1]; let d=jwt.verify(t,SECRET); req.user=users.find(u=>u.id===d.id); if(!req.user) return res.status(401).json({error:'no user'}); next();}catch{return res.status(401).json({error:'invalid'});}}

// ---- BTC API ----
app.get('/api/btc/info',(req,res)=>{res.json({blocks:blockchain.length, last:blockchain[blockchain.length-1], founder:FOUNDER});});
app.get('/api/btc/balance/:acc',(req,res)=>{res.json({account:req.params.acc, balance:getBalance(req.params.acc), source:'blockchain only - like BTC'});});
app.get('/api/blockchain',(req,res)=>{res.json(blockchain.slice(-20).reverse());});

app.post('/api/signup',(req,res)=>{
 let {full_name,phone,password,founder_code}=req.body||{};
 let cp=clean(phone); if(!full_name||!cp||!password) return res.status(400).json({error:'required'});
 if(users.find(u=>clean(u.phone)===cp)) return res.status(400).json({error:'registered'});
 if(cp===clean(FOUNDER) && founder_code!==FOUNDER_CODE) return res.status(403).json({error:'founder code MES100M needed'});
 let u={id:newId(),full_name:full_name.trim().slice(0,40),phone:cp,password:hashPw(password),mes_account:'MES'+crypto.randomInt(100000,999999)};
 users.push(u);
 if(cp===clean(FOUNDER)){ addBlock([{from:'GENESIS_BANK_100M',to:u.mes_account,amount:100000000,note:'Founder BTC like'}]); }
 else{ addBlock([{from:'GENESIS',to:u.mes_account,amount:0,note:'new account'}]); }
 save();
 res.json({token:jwt.sign({id:u.id},SECRET,{expiresIn:'7d'}),user:{...safe(u),balance:getBalance(u.mes_account)}});
});
app.post('/api/login',(req,res)=>{
 let {login_id,password}=req.body||{}; let cp=clean(login_id); let up=String(login_id).toUpperCase();
 let u=users.find(x=>clean(x.phone)===cp||x.mes_account.toUpperCase()===up);
 if(!u||!checkPw(u,password)) return res.status(400).json({error:'wrong'});
 res.json({token:jwt.sign({id:u.id},SECRET,{expiresIn:'7d'}),user:{...safe(u),balance:getBalance(u.mes_account)}});
});
app.get('/api/me',auth,(req,res)=>{res.json({...safe(req.user),balance:getBalance(req.user.mes_account),blocks:blockchain.length});});

app.post('/api/send',auth,(req,res)=>{
 let {to_account,amount}=req.body||{}; let amt=Number(amount);
 if(!to_account||!Number.isFinite(amt)||amt<=0) return res.status(400).json({error:'invalid'});
 let bal=getBalance(req.user.mes_account); if(bal<amt) return res.status(400).json({error:'Not enough - BTC checks chain, you have '+bal});
 let acc=String(to_account).trim().toUpperCase();
 let recv=users.find(u=>u.mes_account.toUpperCase()===acc||clean(u.phone)===clean(to_account));
 if(!recv) return res.status(400).json({error:'receiver not found'});
 if(recv.id===req.user.id) return res.status(400).json({error:'self'});
 let blk=addBlock([{from:req.user.mes_account,to:recv.mes_account,amount:amt,note:'BTC-like P2P'}]);
 res.json({message:'Sent '+amt+' MES - mined in block '+blk.index+' like BTC',block:blk,balance:getBalance(req.user.mes_account)});
});

app.get('/',(req,res)=>{
 res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;max-width:480px;margin:auto;padding:12px;background:#fefce8}.card{background:#fff;padding:12px;border-radius:12px;margin:8px 0;border:1px solid #eee}input,button{width:100%;padding:11px;margin:5px 0;border-radius:8px;border:1px solid #ddd;box-sizing:border-box}button{background:#000;color:#fff;font-weight:bold}h2{text-align:center}</style></head><body>
<h2>⚡ MESCOIN BTC</h2>
<div class="card"><b>Like Bitcoin:</b> No mes_balance field. Balance = sum of blockchain only.<br>Blocks: <span id="bc">-</span> | My Balance: <b id="bal">-</b> (from chain)</div>
<div class="card" id="auth"><input id="fn" placeholder="Full name"><input id="ph" placeholder="Phone 07..."><input id="pw" type="password" placeholder="Password"><input id="fc" placeholder="Founder code MES100M if founder"><button onclick="signup()">SIGNUP - BTC LIKE</button><hr><input id="li" placeholder="Phone or MES..."><input id="lp" type="password" placeholder="Password"><button onclick="login()">LOGIN</button><p id="msg"></p></div>
<div class="card" id="dash" style="display:none"><b id="name"></b> <span id="acc"></span><br><input id="to" placeholder="To MES... or phone"><input id="am" type="number" placeholder="Amount"><button onclick="send()">SEND - MINES BLOCK LIKE BTC</button><pre id="chain" style="font-size:10px;max-height:200px;overflow:auto;background:#f5f5f5;padding:6px"></pre><button onclick="logout()" style="background:#333">Logout</button></div>
<script>
let token=localStorage.getItem('t')||''; async function api(p,o={}){o.headers=Object.assign({'Content-Type':'application/json',Authorization:'Bearer '+token},o.headers||{}); let r=await fetch(p,o); let d=await r.json(); if(!r.ok) throw d; return d;}
async function signup(){try{let d=await api('/api/signup',{method:'POST',body:JSON.stringify({full_name:fn.value,phone:ph.value,password:pw.value,founder_code:fc.value})}); token=d.token; localStorage.setItem('t',token); go(d.user);}catch(e){msg.innerText=e.error;}}
async function login(){try{let d=await api('/api/login',{method:'POST',body:JSON.stringify({login_id:li.value,password:lp.value})}); token=d.token; localStorage.setItem('t',token); go(d.user);}catch(e){msg.innerText=e.error;}}
function go(u){auth.style.display='none';dash.style.display='block';name.innerText=u.full_name;acc.innerText=u.mes_account;bal.innerText=u.balance;bc.innerText='loading'; load();}
async function load(){try{let me=await api('/api/me'); bal.innerText=me.balance; name.innerText=me.full_name; acc.innerText=me.mes_account; bc.innerText=me.blocks; let ch=await api('/api/blockchain'); chain.innerText=JSON.stringify(ch,null,2);}catch{}}
async function send(){try{let d=await api('/api/send',{method:'POST',body:JSON.stringify({to_account:to.value,amount:am.value})}); alert(d.message); load();}catch(e){alert(e.error);}}
function logout(){localStorage.removeItem('t'); location.reload();}
if(token){api('/api/me').then(go).catch(()=>{});}
</script></body></html>`);
});

app.listen(process.env.PORT||10000,()=>console.log('BTC-LIKE MESCOIN RUNNING blocks:'+blockchain.length));
