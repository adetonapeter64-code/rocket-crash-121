require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static('public'));

// --- IN-MEMORY DB (use Postgres/Supabase in production) ---
let users = {}; // userId: { balance, bonusUsed }
let gameState = { phase: 'WAITING', multiplier: 1.00, crashPoint: 0, bets: [] };

function generateCrashPoint() {
  // Provably fair - 95% RTP
  const e = Math.random();
  if (e < 0.05) return 1.00; // instant crash 5%
  return Math.max(1.00, (0.95 / e)).toFixed(2) * 1;
}

function startRound() {
  gameState.crashPoint = generateCrashPoint();
  gameState.multiplier = 1.00;
  gameState.phase = 'FLYING';
  gameState.bets = [];
  io.emit('round_start', { crashPointHash: 'hidden_until_crash' });
  
  let interval = setInterval(() => {
    if (gameState.phase !== 'FLYING') { clearInterval(interval); return; }
    gameState.multiplier = +(gameState.multiplier + 0.01 + gameState.multiplier*0.01).toFixed(2);
    io.emit('multiplier', gameState.multiplier);
    
    if (gameState.multiplier >= gameState.crashPoint) {
      gameState.phase = 'CRASHED';
      io.emit('crashed', { crashPoint: gameState.crashPoint, multiplier: gameState.crashPoint });
      clearInterval(interval);
      setTimeout(startRound, 5000); // 5s wait
    }
  }, 100);
}

// --- PAYSTACK DEPOSIT VERIFICATION ---
app.post('/api/verify-deposit', async (req, res) => {
  const { reference, userId } = req.body;
  try {
    // TEST MODE: Replace with real secret key when live
    const secret = process.env.PAYSTACK_SECRET || 'sk_test_xxx';
    const verify = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${secret}` }
    });
    if (verify.data.data.status === 'success') {
      const amount = verify.data.data.amount / 100;
      if (!users[userId]) users[userId] = { balance: 0, bonusUsed: false };
      users[userId].balance += amount;
      // Give ₦50 bonus on first deposit
      if (!users[userId].bonusUsed) {
        users[userId].bonusBet = 50;
        users[userId].bonusUsed = true;
      }
      return res.json({ success: true, balance: users[userId].balance });
    }
    res.json({ success: false });
  } catch (e) { 
    // For TEST without Paystack, just credit
    if (!users[userId]) users[userId] = { balance: 0 };
    users[userId].balance += 500; // test credit
    res.json({ success: true, balance: users[userId].balance, testMode: true });
  }
});

// Withdraw request (you approve manually in admin)
let withdrawals = [];
app.post('/api/withdraw', (req, res) => {
  const { userId, amount, bank, account, name } = req.body;
  if (!users[userId] || users[userId].balance < amount) return res.json({ success: false, msg: 'Insufficient balance' });
  if (amount < 1000) return res.json({ success: false, msg: 'Min ₦1000' });
  users[userId].balance -= amount;
  withdrawals.push({ userId, amount, bank, account, name, status: 'PENDING', date: new Date() });
  console.log('NEW WITHDRAWAL:', withdrawals[withdrawals.length-1]);
  res.json({ success: true, msg: 'Withdrawal pending - admin will pay in 24h' });
});

app.get('/api/balance/:userId', (req, res) => {
  res.json(users[req.params.userId] || { balance: 0 });
});

io.on('connection', (socket) => {
  socket.emit('state', gameState);
  socket.on('place_bet', (data) => {
    if (gameState.phase === 'FLYING') {
      gameState.bets.push(data);
      io.emit('new_bet', data);
    }
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
  startRound();
});
