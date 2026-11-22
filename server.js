const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Shawzen Online Server is Running!'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const MAX_HEARTS = 5;
const MAX_SLOTS = 7;
const ITEM_KEYS = [
  'magnifier', 'saw', 'soda', 'medkit', 'cuffs',
  'thief', 'exchanger', 'inverter', 'shield', 'pillow'
];
const WEAPONS = ['shotgun', 'pistol', 'ak', 'bazooka', 'cannon'];
const SKINS = ['classic', 'gold', 'neon', 'shadow', 'sumerian', 'egyptian'];
const BOT_NAMES = ['صقر البصرة', 'ذيب الليل', 'القناص', 'كاسر', 'السلطان'];

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastRoomState(room, logMsg = null) {
  if (logMsg) room.lastLog = logMsg;

  room.players.forEach((viewer) => {
    if (viewer.isBot || !viewer.socketId) return;

    const sanitizedPlayers = room.players.map((p) => {
      const isSelf = p.id === viewer.id;
      return {
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        hearts: p.hearts,
        cuffed: p.cuffed,
        shield: p.shield,
        weapon: p.weapon,
        skin: p.skin,
        itemsCount: p.items.length,
        items: isSelf ? p.items : [],
        pillowTurns: isSelf ? p.pillowTurns : 0
      };
    });

    io.to(viewer.socketId).emit('room_state', {
      code: room.code,
      hostId: room.hostId,
      started: room.started,
      maxPlayers: room.maxPlayers,
      timerMax: room.timerMax,
      timerLeft: room.timerLeft,
      round: room.round,
      turnIndex: room.turnIndex,
      remainingShells: room.chamber.length,
      totalRoundShells: room.totalRoundShells,
      roundLiveCount: room.roundLiveCount,
      roundBlankCount: room.roundBlankCount,
      sawed: room.sawed,
      lastLog: room.lastLog,
      myPlayerId: viewer.id,
      players: sanitizedPlayers
    });
  });
}

function startNewRound(room) {
  const alivePlayers = room.players.filter((p) => p.hearts > 0);
  const totalShells = Math.min(8, Math.max(3, alivePlayers.length + 2));
  const liveCount = Math.max(1, Math.floor(totalShells / 2));
  const blankCount = totalShells - liveCount;

  const shells = [];
  for (let i = 0; i < liveCount; i++) shells.push('live');
  for (let i = 0; i < blankCount; i++) shells.push('blank');
  shells.sort(() => Math.random() - 0.5);

  room.chamber = shells;
  room.totalRoundShells = totalShells;
  room.roundLiveCount = liveCount;
  room.roundBlankCount = blankCount;
  room.sawed = false;

  const itemsPerRound = room.round === 1 ? 2 : 3;
  alivePlayers.forEach((p) => {
    for (let k = 0; k < itemsPerRound; k++) {
      if (p.items.length < MAX_SLOTS) {
        p.items.push(ITEM_KEYS[Math.floor(Math.random() * ITEM_KEYS.length)]);
      }
    }
  });

  broadcastRoomState(
    room,
    `جولة ${room.round}: تم شحن ${liveCount} طلقات حية و ${blankCount} فارغة وتوزيع الأدوات!`
  );
  beginTurn(room);
}

function beginTurn(room) {
  clearInterval(room.timerInterval);
  clearTimeout(room.botTimeout);

  const current = room.players[room.turnIndex];
  if (!current || current.hearts <= 0) {
    advanceTurn(room);
    return;
  }

  if (current.pillowTurns > 0) current.pillowTurns--;

  if (current.cuffed) {
    current.cuffed = false;
    broadcastRoomState(room, `⛓️ ${current.name} مقيّد ويفقد هذا الدور!`);
    setTimeout(() => advanceTurn(room), 1200);
    return;
  }

  room.busy = false;
  room.timerLeft = room.timerMax;
  broadcastRoomState(room);

  room.timerInterval = setInterval(() => {
    room.timerLeft--;
    io.to(room.code).emit('timer_tick', room.timerLeft);
    if (room.timerLeft <= 0) {
      clearInterval(room.timerInterval);
      if (!current.isBot && !room.busy) {
        const aliveOpps = room.players.filter((p) => p.id !== current.id && p.hearts > 0);
        if (aliveOpps.length > 0) {
          performShot(room, current.id, aliveOpps[0].id, '⏰ انتهى الوقت! تم إطلاق النار تلقائياً.');
        }
      }
    }
  }, 1000);

  if (current.isBot) {
    room.busy = true;
    room.botTimeout = setTimeout(() => executeBotTurn(room, current), 950);
  }
}

function advanceTurn(room) {
  const alivePlayers = room.players.filter((p) => p.hearts > 0);
  if (alivePlayers.length <= 1) {
    clearInterval(room.timerInterval);
    clearTimeout(room.botTimeout);
    const winner = alivePlayers[0];
    io.to(room.code).emit('game_over', {
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : 'لا أحد'
    });
    return;
  }

  if (room.chamber.length === 0) {
    room.round++;
    startNewRound(room);
    return;
  }

  let nextIdx = (room.turnIndex + 1) % room.players.length;
  while (room.players[nextIdx].hearts <= 0) {
    nextIdx = (nextIdx + 1) % room.players.length;
  }
  room.turnIndex = nextIdx;
  beginTurn(room);
}

function performShot(room, shooterId, targetId, prefixLog = '') {
  room.busy = true;
  clearInterval(room.timerInterval);

  const shooter = room.players.find((p) => p.id === shooterId);
  const target = room.players.find((p) => p.id === targetId);
  const shell = room.chamber.pop();
  const damage = room.sawed ? 2 : 1;
  room.sawed = false;

  io.to(room.code).emit('shot_animation', { shooterId, targetId, shell });

  setTimeout(() => {
    if (shell === 'live') {
      if (target.pillowTurns > 0) {
        target.pillowTurns = 0;
        broadcastRoomState(
          room,
          `${prefixLog} 🛏️ مفاجأة! وسادة ${target.name} السرية امتصت الرصاصة الحية بالكامل!`
        );
      } else {
        target.hearts = Math.max(0, target.hearts - damage);
        broadcastRoomState(
          room,
          `${prefixLog} 💥 طلقة حية! ${shooter.name} أصاب ${target.name} (-${damage} ❤️)`
        );
      }
      setTimeout(() => advanceTurn(room), 1300);
    } else {
      broadcastRoomState(room, `${prefixLog} ⚪ طق! طلقة فارغة على ${target.name}.`);
      if (shooterId === targetId) {
        setTimeout(() => {
          if (room.chamber.length === 0) {
            room.round++;
            startNewRound(room);
          } else {
            broadcastRoomState(room, `🔁 ${shooter.name} أطلق طلقة فارغة على نفسه وحصل على دور إضافي!`);
            beginTurn(room);
          }
        }, 1100);
      } else {
        setTimeout(() => advanceTurn(room), 1100);
      }
    }
  }, 300);
}

function executeBotTurn(room, bot) {
  const aliveTargets = room.players.filter((p) => p.id !== bot.id && p.hearts > 0);
  if (aliveTargets.length === 0) {
    advanceTurn(room);
    return;
  }

  if (bot.items.length > 0 && Math.random() < 0.6) {
    const idx = Math.floor(Math.random() * bot.items.length);
    const key = bot.items[idx];
    const target = aliveTargets[Math.floor(Math.random() * aliveTargets.length)];

    if (key === 'medkit' && bot.hearts < MAX_HEARTS) {
      bot.items.splice(idx, 1);
      bot.hearts++;
      broadcastRoomState(room, `💊 ${bot.name} استخدم مسكن الألم (+1 ❤️).`);
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 650);
      return;
    } else if (key === 'shield' && !bot.shield) {
      bot.items.splice(idx, 1);
      bot.shield = true;
      broadcastRoomState(room, `🛡️ ${bot.name} فعّل الدرع الواقي.`);
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 650);
      return;
    } else if (key === 'pillow' && bot.pillowTurns === 0) {
      bot.items.splice(idx, 1);
      bot.pillowTurns = 2;
      broadcastRoomState(room);
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 450);
      return;
    } else if (key === 'saw' && !room.sawed) {
      bot.items.splice(idx, 1);
      room.sawed = true;
      broadcastRoomState(room, `🪚 ${bot.name} قص السبطانة بالمنشار!`);
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 650);
      return;
    } else if (key === 'inverter') {
      bot.items.splice(idx, 1);
      const top = room.chamber.length - 1;
      room.chamber[top] = room.chamber[top] === 'live' ? 'blank' : 'live';
      broadcastRoomState(room, `🔁 ${bot.name} استخدم القلاب على الطلقة الحالية!`);
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 650);
      return;
    } else if (key === 'cuffs') {
      bot.items.splice(idx, 1);
      if (target.shield) {
        target.shield = false;
        broadcastRoomState(room, `🛡️ درع ${target.name} امتص قيود ${bot.name} وانكسر!`);
      } else {
        target.cuffed = true;
        broadcastRoomState(room, `⛓️ ${bot.name} قيّد ${target.name}!`);
      }
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 650);
      return;
    } else if (key === 'thief' && target.items.length > 0) {
      bot.items.splice(idx, 1);
      if (target.shield) {
        target.shield = false;
        broadcastRoomState(room, `🛡️ درع ${target.name} تصدى لسارق ${bot.name} وانكسر!`);
      } else {
        const stolenIdx = Math.floor(Math.random() * target.items.length);
        const stolenKey = target.items.splice(stolenIdx, 1)[0];
        if (bot.items.length < MAX_SLOTS) bot.items.push(stolenKey);
        broadcastRoomState(room, `🦝 ${bot.name} سرق أداة من ${target.name}!`);
      }
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 650);
      return;
    } else if (key === 'exchanger') {
      bot.items.splice(idx, 1);
      if (target.shield) {
        target.shield = false;
        broadcastRoomState(room, `🛡️ درع ${target.name} منع ${bot.name} من التبادل وانكسر!`);
      } else {
        const temp = [...bot.items];
        bot.items = [...target.items];
        target.items = temp;
        broadcastRoomState(room, `🔄 ${bot.name} بدّل جميع أدواته مع ${target.name}!`);
      }
      room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 650);
      return;
    }
  }

  const shootSelf =
    room.chamber.length === 1 && room.chamber[0] === 'blank'
      ? true
      : Math.random() < 0.25 && !room.sawed;
  const chosen = shootSelf ? bot : aliveTargets[Math.floor(Math.random() * aliveTargets.length)];
  performShot(room, bot.id, chosen.id);
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ name, maxPlayers, timerMax, weapon, skin }) => {
    const code = generateRoomCode();
    const player = {
      id: 0,
      socketId: socket.id,
      name: (name || 'علي').trim().slice(0, 14),
      isBot: false,
      hearts: MAX_HEARTS,
      items: [],
      cuffed: false,
      shield: false,
      pillowTurns: 0,
      weapon: weapon || 'shotgun',
      skin: skin || 'classic'
    };

    const room = {
      code,
      hostId: 0,
      started: false,
      maxPlayers: Math.min(6, Math.max(2, Number(maxPlayers) || 4)),
      timerMax: [30, 45, 60].includes(Number(timerMax)) ? Number(timerMax) : 45,
      timerLeft: 45,
      round: 1,
      turnIndex: 0,
      chamber: [],
      totalRoundShells: 0,
      roundLiveCount: 0,
      roundBlankCount: 0,
      sawed: false,
      busy: false,
      lastLog: 'بانتظار انضمام اللاعبين...',
      players: [player],
      timerInterval: null,
      botTimeout: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = 0;
    broadcastRoomState(room);
  });

  socket.on('join_room', ({ code, name, weapon, skin }) => {
    const cleanCode = (code || '').trim().toUpperCase();
    const room = rooms.get(cleanCode);
    if (!room) return socket.emit('error_msg', 'رمز الغرفة غير صحيح!');
    if (room.started) return socket.emit('error_msg', 'المباراة بدأت بالفعل في هذه الغرفة!');
    if (room.players.length >= room.maxPlayers) return socket.emit('error_msg', 'الغرفة ممتلئة!');

    const newId = room.players.length;
    room.players.push({
      id: newId,
      socketId: socket.id,
      name: (name || `لاعب ${newId + 1}`).trim().slice(0, 14),
      isBot: false,
      hearts: MAX_HEARTS,
      items: [],
      cuffed: false,
      shield: false,
      pillowTurns: 0,
      weapon: weapon || 'shotgun',
      skin: skin || 'classic'
    });

    socket.join(cleanCode);
    socket.data.roomCode = cleanCode;
    socket.data.playerId = newId;
    broadcastRoomState(room, `✅ انضم ${room.players[newId].name} إلى الغرفة!`);
  });

  socket.on('start_room_game', ({ fillBots }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId || room.started) return;

    if (fillBots) {
      const shuffledBots = [...BOT_NAMES].sort(() => Math.random() - 0.5);
      while (room.players.length < room.maxPlayers) {
        const idx = room.players.length;
        room.players.push({
          id: idx,
          socketId: null,
          name: shuffledBots[idx - 1] || `بوت ${idx}`,
          isBot: true,
          hearts: MAX_HEARTS,
          items: [],
          cuffed: false,
          shield: false,
          pillowTurns: 0,
          weapon: WEAPONS[Math.floor(Math.random() * WEAPONS.length)],
          skin: SKINS[Math.floor(Math.random() * SKINS.length)]
        });
      }
    }

    if (room.players.length < 2) {
      return socket.emit('error_msg', 'يجب وجود لاعبين على الأقل لبدء المباراة!');
    }

    room.started = true;
    room.round = 1;
    room.turnIndex = 0;
    startNewRound(room);
  });

  socket.on('player_shoot', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.busy) return;
    const current = room.players[room.turnIndex];
    if (!current || current.id !== socket.data.playerId) return;

    const target = room.players.find((p) => p.id === Number(targetId) && p.hearts > 0);
    if (!target) return;

    performShot(room, current.id, target.id);
  });

  socket.on('thief_inspect', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.busy) return;
    const actor = room.players[room.turnIndex];
    if (!actor || actor.id !== socket.data.playerId) return;
    if (!actor.items.includes('thief')) return;

    const target = room.players.find((p) => p.id === Number(targetId) && p.hearts > 0 && p.id !== actor.id);
    if (!target) return;

    if (target.shield) {
      const thiefIdx = actor.items.indexOf('thief');
      actor.items.splice(thiefIdx, 1);
      target.shield = false;
      broadcastRoomState(room, `🛡️ درع ${target.name} تصدى لسارق ${actor.name} وانكسر!`);
      return;
    }

    socket.emit('thief_reveal', {
      targetId: target.id,
      targetName: target.name,
      items: target.items
    });
  });

  socket.on('use_item', ({ slotIndex, targetId, stealIndex }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || room.busy) return;
    const actor = room.players[room.turnIndex];
    if (!actor || actor.id !== socket.data.playerId) return;

    const itemKey = actor.items[slotIndex];
    if (!itemKey) return;

    if (itemKey === 'magnifier') {
      const topShell = room.chamber[room.chamber.length - 1];
      actor.items.splice(slotIndex, 1);
      socket.emit('private_hint', `🔍 العدسة تكشف سراً: الطلقة القادمة ${topShell === 'live' ? '🔴 حية!' : '⚪ فارغة!'}`);
      broadcastRoomState(room, `🔍 ${actor.name} تفحّص بيت النار بالعدسة المكبرة.`);
    } else if (itemKey === 'saw') {
      if (room.sawed) return;
      actor.items.splice(slotIndex, 1);
      room.sawed = true;
      broadcastRoomState(room, `🪚 ${actor.name} قص السبطانة! الضرر القادم مضاعف (2 ❤️).`);
    } else if (itemKey === 'soda') {
      const ejected = room.chamber.pop();
      actor.items.splice(slotIndex, 1);
      broadcastRoomState(room, `🥤 ${actor.name} أخرج طلقة وكانت: ${ejected === 'live' ? '🔴 حية' : '⚪ فارغة'}.`);
      if (room.chamber.length === 0) {
        setTimeout(() => { room.round++; startNewRound(room); }, 1100);
      }
    } else if (itemKey === 'medkit') {
      if (actor.hearts >= MAX_HEARTS) return;
      actor.items.splice(slotIndex, 1);
      actor.hearts++;
      broadcastRoomState(room, `💊 ${actor.name} تناول مسكن الألم واستعاد قلباً (+1 ❤️).`);
    } else if (itemKey === 'inverter') {
      const idx = room.chamber.length - 1;
      room.chamber[idx] = room.chamber[idx] === 'live' ? 'blank' : 'live';
      actor.items.splice(slotIndex, 1);
      broadcastRoomState(room, `🔁 ${actor.name} استخدم القلاب! انعكست حالة الطلقة الحالية.`);
    } else if (itemKey === 'shield') {
      if (actor.shield) return;
      actor.items.splice(slotIndex, 1);
      actor.shield = true;
      broadcastRoomState(room, `🛡️ ${actor.name} فعّل الدرع الواقي!`);
    } else if (itemKey === 'pillow') {
      actor.items.splice(slotIndex, 1);
      actor.pillowTurns = 2;
      socket.emit('private_hint', '🛏️ تم تفعيل الوسادة السرية بصمت لمدة دورين.');
      broadcastRoomState(room);
    } else if (itemKey === 'cuffs') {
      const target = room.players.find((p) => p.id === Number(targetId) && p.hearts > 0 && p.id !== actor.id);
      if (!target) return;
      actor.items.splice(slotIndex, 1);
      if (target.shield) {
        target.shield = false;
        broadcastRoomState(room, `🛡️ درع ${target.name} امتص القيود الحديدية وانكسر!`);
      } else {
        target.cuffed = true;
        broadcastRoomState(room, `⛓️ ${actor.name} قيّد ${target.name}! سيفقد دوره القادم.`);
      }
    } else if (itemKey === 'exchanger') {
      const target = room.players.find((p) => p.id === Number(targetId) && p.hearts > 0 && p.id !== actor.id);
      if (!target) return;
      actor.items.splice(slotIndex, 1);
      if (target.shield) {
        target.shield = false;
        broadcastRoomState(room, `🛡️ درع ${target.name} منع تبادل الأدوات وانكسر!`);
      } else {
        const temp = [...actor.items];
        actor.items = [...target.items];
        target.items = temp;
        broadcastRoomState(room, `🔄 ${actor.name} تبادل جميع الأدوات مع ${target.name}!`);
      }
    } else if (itemKey === 'thief') {
      const target = room.players.find((p) => p.id === Number(targetId) && p.hearts > 0 && p.id !== actor.id);
      if (!target || target.items[stealIndex] === undefined) return;
      actor.items.splice(slotIndex, 1);
      if (target.shield) {
        target.shield = false;
        broadcastRoomState(room, `🛡️ درع ${target.name} تصدى للسارق وانكسر!`);
      } else {
        const stolen = target.items.splice(stealIndex, 1)[0];
        actor.items.push(stolen);
        broadcastRoomState(room, `🦝 ${actor.name} سرق أداة من ${target.name}!`);
      }
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.data.playerId);
    if (player) {
      player.isBot = true;
      player.socketId = null;
      player.name += ' (بوت)';
      broadcastRoomState(room, `⚠️ غادر ${player.name} وتولى البوت مكانه.`);
    }
    const anyHuman = room.players.some((p) => !p.isBot && p.socketId);
    if (!anyHuman) {
      clearInterval(room.timerInterval);
      clearTimeout(room.botTimeout);
      rooms.delete(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Shawzen server running on port ${PORT}`));
