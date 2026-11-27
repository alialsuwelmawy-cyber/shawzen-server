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
  'glass', 'saw', 'drink', 'smoke', 'cuffs',
  'thief', 'swapper', 'flipper', 'shield', 'pillow'
];
const WEAPONS = ['shotgun', 'pistol', 'ak47', 'bazooka', 'cannon'];
const SKINS = ['classic', 'gold', 'crimson', 'carbon', 'sumerian', 'egyptian'];
const BOT_NAMES = ['Bot_Alpha', 'Bot_Sniper', 'Bot_Shadow', 'Bot_Viper', 'Bot_Ghost'];
const BOT_AVATARS = ['🤖', '🦾', '👾', '🎭', '💀'];

const rooms = new Map();

function normalizeCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function isRoomHost(room, socket, payload = {}) {
  if (!room) return false;
  if (room.hostId === socket.id) return true;
  const token = payload.playerToken || socket.data.playerToken;
  if (token && room.hostToken && token === room.hostToken) {
    room.hostId = socket.id;
    const hostPlayer = room.players.find((p) => p.token === token);
    if (hostPlayer) {
      hostPlayer.id = socket.id;
      hostPlayer.socketId = socket.id;
    }
    return true;
  }
  return false;
}

function isCurrentTurnActor(room, socket, payload = {}) {
  if (!room || !room.started) return null;
  const current = room.players[room.turnIndex];
  if (!current || current.isBot) return null;
  if (current.id === socket.id) return current;
  const token = payload.playerToken || socket.data.playerToken;
  if (token && current.token && current.token === token) {
    current.id = socket.id;
    current.socketId = socket.id;
    if (room.hostToken === token) room.hostId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    return current;
  }
  return null;
}

function createBotEntry(room) {
  const botIndex = room.players.filter((p) => p.isBot).length;
  const id = `bot_${Date.now()}_${botIndex}_${Math.floor(Math.random() * 1000)}`;
  return {
    id,
    token: null,
    socketId: null,
    name: BOT_NAMES[botIndex % BOT_NAMES.length],
    avatar: BOT_AVATARS[botIndex % BOT_AVATARS.length],
    isBot: true,
    hearts: MAX_HEARTS,
    maxHp: MAX_HEARTS,
    items: [],
    cuffed: false,
    hasShield: false,
    shieldTurns: 0,
    pillowTurns: 0,
    weaponId: WEAPONS[Math.floor(Math.random() * WEAPONS.length)],
    skinId: SKINS[Math.floor(Math.random() * SKINS.length)]
  };
}

function buildLobbyPayload(room) {
  return {
    roomId: room.code,
    code: room.code,
    hostId: room.hostId,
    hostToken: room.hostToken,
    started: room.started,
    turnDuration: room.turnDuration,
    maxPlayers: room.maxPlayers,
    players: room.players.map((p) => ({
      id: p.id,
      token: p.token,
      name: p.name,
      avatar: p.avatar,
      isBot: p.isBot,
      weaponId: p.weaponId,
      skinId: p.skinId,
      voiceActive: Boolean(p.voiceActive),
      voiceMuted: Boolean(p.voiceMuted)
    }))
  };
}

function emitLobbyUpdate(room) {
  io.to(room.code).emit('room_updated', buildLobbyPayload(room));
}

function broadcastGameState(room, logMsg = null, highlight = 'neutral', roundReveal = null, eventName = 'game_state') {
  if (logMsg) room.lastLog = logMsg;

  const currentTurnPlayer = room.players[room.turnIndex] || null;
  const currentTurnPlayerId = currentTurnPlayer ? currentTurnPlayer.id : null;

  room.players.forEach((viewer) => {
    if (viewer.isBot || !viewer.socketId) return;

    const playersState = room.players.map((p) => {
      const isSelf = p.id === viewer.id;
      return {
        id: p.id,
        token: p.token,
        name: p.name,
        avatar: p.avatar,
        isBot: p.isBot,
        hp: p.hearts,
        maxHp: MAX_HEARTS,
        eliminated: p.hearts <= 0,
        cuffed: p.cuffed,
        hasShield: p.hasShield,
        shieldTurns: p.shieldTurns || 0,
        pillowTurns: isSelf ? p.pillowTurns : 0,
        weaponId: p.weaponId,
        skinId: p.skinId,
        voiceActive: Boolean(p.voiceActive),
        voiceMuted: Boolean(p.voiceMuted),
        itemsCount: p.items.length,
        items: isSelf ? [...p.items] : []
      };
    });

    io.to(viewer.socketId).emit(eventName, {
      roomId: room.code,
      code: room.code,
      hostId: room.hostId,
      started: room.started,
      round: room.round,
      maxHp: MAX_HEARTS,
      turnIndex: room.turnIndex,
      currentTurnPlayerId,
      remainingShells: room.chamber.length,
      doubleDamage: room.sawed,
      busy: Boolean(room.busy),
      turnDuration: room.turnDuration,
      timeLeft: room.timerLeft,
      lastLog: room.lastLog,
      roundReveal,
      players: playersState
    });
  });
}

function startNewRound(room, isFirstRound = false) {
  clearInterval(room.timerInterval);
  clearTimeout(room.botTimeout);
  clearTimeout(room.roundRevealTimeout);
  room.busy = true;
  room.timerLeft = room.turnDuration;

  const alivePlayers = room.players.filter((p) => p.hearts > 0);
  const liveCount = Math.min(5, Math.max(1, Math.floor(alivePlayers.length * 0.7) + Math.floor(room.round / 2)));
  const blankCount = Math.min(5, Math.max(2, alivePlayers.length + (room.round % 2)));

  const shells = [];
  for (let i = 0; i < liveCount; i++) shells.push('live');
  for (let i = 0; i < blankCount; i++) shells.push('blank');
  for (let i = shells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shells[i], shells[j]] = [shells[j], shells[i]];
  }

  room.chamber = shells;
  room.sawed = false;
  room.players.forEach((p) => {
    p.cuffed = false;
  });

  alivePlayers.forEach((p) => {
    for (let k = 0; k < 2; k++) {
      if (p.items.length < MAX_SLOTS) {
        p.items.push(ITEM_KEYS[Math.floor(Math.random() * ITEM_KEYS.length)]);
      }
    }
  });

  const reveal = { live: liveCount, blank: blankCount };
  const log = `جولة ${room.round}: تم شحن ${liveCount} طلقات حية و ${blankCount} فارغة!`;
  if (isFirstRound) {
    broadcastGameState(room, log, 'gold', reveal, 'match_started');
  }
  broadcastGameState(room, log, 'gold', reveal, 'game_state');

  room.roundRevealTimeout = setTimeout(() => {
    if (!room.started) return;
    beginTurn(room);
  }, 2300);
}

function beginTurn(room) {
  clearInterval(room.timerInterval);
  clearTimeout(room.botTimeout);

  const current = room.players[room.turnIndex];
  if (!current || current.hearts <= 0) {
    advanceTurn(room);
    return;
  }

  if (current.pillowTurns > 0) {
    current.pillowTurns--;
  }

  if (current.shieldTurns > 0) {
    current.shieldTurns--;
    if (current.shieldTurns <= 0) {
      current.shieldTurns = 0;
      current.hasShield = false;
    }
  }

  if (current.cuffed) {
    current.cuffed = false;
    broadcastGameState(room, `⛓️ ${current.name} مقيد وتخطى دوره!`, 'gold');
    setTimeout(() => advanceTurn(room), 1000);
    return;
  }

  room.busy = false;
  room.timerLeft = room.turnDuration;
  broadcastGameState(
    room,
    current.isBot ? `دور ${current.name} الآن...` : 'دورك الآن! اختر خصماً أو أداة للعب 🎯',
    'neutral'
  );

  room.timerInterval = setInterval(() => {
    if (!room.started || room.busy) return;
    room.timerLeft = Math.max(0, room.timerLeft - 1);
    io.to(room.code).emit('timer_tick', { timeLeft: room.timerLeft });
    if (room.timerLeft <= 0) {
      clearInterval(room.timerInterval);
      if (!current.isBot) {
        const aliveOpps = room.players.filter((p) => p.id !== current.id && p.hearts > 0);
        if (aliveOpps.length > 0) {
          performShot(room, current.id, aliveOpps[0].id, false, '⌛ انتهى وقت دورك! تم الإطلاق تلقائياً.');
        }
      }
    }
  }, 1000);

  if (current.isBot) {
    room.busy = true;
    room.botTimeout = setTimeout(() => executeBotTurn(room, current), 850);
  }
}

function advanceTurn(room) {
  const alivePlayers = room.players.filter((p) => p.hearts > 0);
  if (alivePlayers.length <= 1) {
    clearInterval(room.timerInterval);
    clearTimeout(room.botTimeout);
    clearTimeout(room.roundRevealTimeout);
    room.started = false;
    const winner = alivePlayers[0] || null;
    room.players.forEach((p) => {
      if (!p.isBot && p.socketId) {
        io.to(p.socketId).emit('match_ended', {
          winnerId: winner ? winner.id : null,
          winnerName: winner ? winner.name : 'لا أحد',
          won: Boolean(winner && winner.id === p.id)
        });
      }
    });
    return;
  }

  let nextIdx = (room.turnIndex + 1) % room.players.length;
  while (room.players[nextIdx].hearts <= 0) {
    nextIdx = (nextIdx + 1) % room.players.length;
  }
  room.turnIndex = nextIdx;

  if (room.chamber.length === 0) {
    room.round++;
    startNewRound(room, false);
    return;
  }

  beginTurn(room);
}

function performShot(room, shooterId, targetId, selfShot = false, prefixLog = '') {
  room.busy = true;
  clearInterval(room.timerInterval);

  const shooter = room.players.find((p) => p.id === shooterId);
  const target = room.players.find((p) => p.id === targetId);
  if (!shooter || !target || room.chamber.length === 0) {
    room.busy = false;
    advanceTurn(room);
    return;
  }

  const shell = room.chamber.shift();
  const damage = room.sawed ? 2 : 1;
  room.sawed = false;

  let blockedByPillow = false;
  let logMessage = '';
  let highlight = 'neutral';

  if (shell === 'live') {
    if (target.pillowTurns > 0) {
      target.pillowTurns = 0;
      blockedByPillow = true;
      logMessage = `${prefixLog ? prefixLog + ' ' : ''}🛏️ مفاجأة! وسادة ${target.name} السرية امتصت الرصاصة الحية بالكامل!`.trim();
      highlight = 'safe';
    } else {
      target.hearts = Math.max(0, target.hearts - damage);
      const elimText = target.hearts === 0 ? ` (تم إقصاء ${target.name} 💀)` : '';
      logMessage = `${prefixLog ? prefixLog + ' ' : ''}💥 طلق حي! ${shooter.name} أصاب ${target.name} (-${damage} ❤️)${elimText}`.trim();
      highlight = 'danger';
    }
  } else {
    logMessage = `${prefixLog ? prefixLog + ' ' : ''}💨 *تك!* رصاصة فارغة على ${selfShot ? 'نفسه' : target.name}.`.trim();
    highlight = 'safe';
  }

  io.to(room.code).emit('action_event', {
    type: 'shot',
    shooterId: shooter.id,
    targetId: target.id,
    selfShot,
    shell,
    damage,
    blockedByPillow,
    message: logMessage,
    highlight
  });

  broadcastGameState(room, logMessage, highlight);

  setTimeout(() => {
    const alivePlayersAfter = room.players.filter((p) => p.hearts > 0);
    if (alivePlayersAfter.length <= 1) {
      advanceTurn(room);
      return;
    }

    const keepTurn = selfShot && shell === 'blank' && shooter.hearts > 0;
    if (keepTurn) {
      if (room.chamber.length === 0) {
        room.round++;
        startNewRound(room, false);
      } else {
        broadcastGameState(room, `🔥 ${shooter.name} أطلق فارغة على نفسه واحتفظ بدوره!`, 'gold');
        beginTurn(room);
      }
      return;
    }

    advanceTurn(room);
  }, 1150);
}

function executeBotTurn(room, bot) {
  if (!room.started) return;
  const aliveTargets = room.players.filter((p) => p.id !== bot.id && p.hearts > 0);
  if (aliveTargets.length === 0) {
    advanceTurn(room);
    return;
  }

  const liveLeft = room.chamber.filter((s) => s === 'live').length;
  const blankLeft = room.chamber.filter((s) => s === 'blank').length;

  const shieldIdx = bot.items.indexOf('shield');
  if (shieldIdx !== -1 && !bot.hasShield) {
    bot.items.splice(shieldIdx, 1);
    bot.hasShield = true;
    bot.shieldTurns = 3;
    broadcastGameState(room, `🛡️ ${bot.name} فعّل الدرع (3 أدوار)!`, 'safe');
    room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 600);
    return;
  }

  const smokeIdx = bot.items.indexOf('smoke');
  if (smokeIdx !== -1 && bot.hearts < MAX_HEARTS) {
    bot.items.splice(smokeIdx, 1);
    bot.hearts = Math.min(MAX_HEARTS, bot.hearts + 1);
    broadcastGameState(room, `💊 ${bot.name} تناول البراسيتول واستعاد +1 قلب!`, 'gold');
    room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 600);
    return;
  }

  const sawIdx = bot.items.indexOf('saw');
  if (sawIdx !== -1 && !room.sawed && liveLeft >= blankLeft) {
    bot.items.splice(sawIdx, 1);
    room.sawed = true;
    broadcastGameState(room, `🪚 ${bot.name} قص الفوهة بالمنشار (ضرر x2)!`, 'danger');
    room.botTimeout = setTimeout(() => executeBotTurn(room, bot), 600);
    return;
  }

  const shootSelf = liveLeft < blankLeft && room.chamber.length > 0;
  const chosen = shootSelf ? bot : aliveTargets[Math.floor(Math.random() * aliveTargets.length)];
  performShot(room, bot.id, chosen.id, shootSelf);
}

io.on('connection', (socket) => {
  socket.on('create_room', (payload = {}, ack) => {
    const requestedCode = normalizeCode(payload.roomId || payload.code || payload.roomCode);
    const playerToken = payload.playerToken || socket.id;
    socket.data.playerToken = playerToken;

    if (requestedCode && rooms.has(requestedCode)) {
      const existing = rooms.get(requestedCode);
      if (existing.hostToken === playerToken) {
        existing.hostId = socket.id;
        const hp = existing.players.find((p) => p.token === playerToken);
        if (hp) {
          hp.id = socket.id;
          hp.socketId = socket.id;
        }
        socket.join(requestedCode);
        socket.data.roomCode = requestedCode;
        if (existing.started) {
          broadcastGameState(existing);
          if (typeof ack === 'function') ack({ ok: true, started: true });
          return;
        }
        const res = buildLobbyPayload(existing);
        socket.emit('room_created', res);
        emitLobbyUpdate(existing);
        if (typeof ack === 'function') ack({ ok: true, ...res });
        return;
      }
    }

    const code = requestedCode && !rooms.has(requestedCode) ? requestedCode : generateRoomCode();
    const maxPlayers = Math.min(6, Math.max(2, Number(payload.maxPlayers) || 6));
    const turnDuration = [30, 45, 60].includes(Number(payload.turnDuration)) ? Number(payload.turnDuration) : 30;

    const hostPlayer = {
      id: socket.id,
      token: playerToken,
      socketId: socket.id,
      name: (payload.name || payload.playerName || 'المضيف').toString().trim().slice(0, 14),
      avatar: '😎',
      isBot: false,
      hearts: MAX_HEARTS,
      maxHp: MAX_HEARTS,
      items: [],
      cuffed: false,
      hasShield: false,
      shieldTurns: 0,
      pillowTurns: 0,
      weaponId: payload.weaponId || 'shotgun',
      skinId: payload.skinId || 'classic',
      voiceActive: false,
      voiceMuted: false
    };

    const room = {
      code,
      hostId: socket.id,
      hostToken: playerToken,
      started: false,
      maxPlayers,
      turnDuration,
      timerLeft: turnDuration,
      round: 1,
      turnIndex: 0,
      chamber: [],
      sawed: false,
      busy: false,
      lastLog: 'بانتظار انضمام اللاعبين...',
      players: [hostPlayer],
      timerInterval: null,
      botTimeout: null,
      roundRevealTimeout: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    const responseData = buildLobbyPayload(room);
    socket.emit('room_created', responseData);
    emitLobbyUpdate(room);
    if (typeof ack === 'function') ack({ ok: true, ...responseData });
  });

  socket.on('join_room', (payload = {}, ack) => {
    const cleanCode = normalizeCode(payload.roomId || payload.code || payload.roomCode || payload.id);
    const playerToken = payload.playerToken || socket.id;
    socket.data.playerToken = playerToken;

    const room = rooms.get(cleanCode);
    if (!room) {
      const errMsg = 'رمز الغرفة غير صحيح أو انتهت صلاحيتها!';
      socket.emit('room_error', { message: errMsg });
      if (typeof ack === 'function') return ack({ ok: false, error: errMsg });
      return;
    }

    const existingByToken = room.players.find((p) => p.token && p.token === playerToken);
    if (existingByToken) {
      existingByToken.id = socket.id;
      existingByToken.socketId = socket.id;
      if (room.hostToken === playerToken) room.hostId = socket.id;
      socket.join(cleanCode);
      socket.data.roomCode = cleanCode;
      if (room.started) {
        broadcastGameState(room);
        if (typeof ack === 'function') ack({ ok: true, started: true });
        return;
      }
      const res = buildLobbyPayload(room);
      socket.emit('room_joined', res);
      emitLobbyUpdate(room);
      if (typeof ack === 'function') ack({ ok: true, ...res });
      return;
    }

    if (room.started) {
      const errMsg = 'المباراة بدأت بالفعل في هذه الغرفة!';
      socket.emit('room_error', { message: errMsg });
      if (typeof ack === 'function') return ack({ ok: false, error: errMsg });
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      const errMsg = `الغرفة ممتلئة (${room.players.length}/${room.maxPlayers})!`;
      socket.emit('room_error', { message: errMsg });
      if (typeof ack === 'function') return ack({ ok: false, error: errMsg });
      return;
    }

    room.players.push({
      id: socket.id,
      token: playerToken,
      socketId: socket.id,
      name: (payload.name || payload.playerName || `لاعب ${room.players.length + 1}`).toString().trim().slice(0, 14),
      avatar: '🧑🏻',
      isBot: false,
      hearts: MAX_HEARTS,
      maxHp: MAX_HEARTS,
      items: [],
      cuffed: false,
      hasShield: false,
      shieldTurns: 0,
      pillowTurns: 0,
      weaponId: payload.weaponId || 'shotgun',
      skinId: payload.skinId || 'classic',
      voiceActive: false,
      voiceMuted: false
    });

    socket.join(cleanCode);
    socket.data.roomCode = cleanCode;

    const responseData = buildLobbyPayload(room);
    socket.emit('room_joined', responseData);
    emitLobbyUpdate(room);
    if (typeof ack === 'function') ack({ ok: true, ...responseData });
  });

  socket.on('update_settings', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !isRoomHost(room, socket, payload) || room.started) return;

    if ([30, 45, 60].includes(Number(payload.turnDuration))) {
      room.turnDuration = Number(payload.turnDuration);
      room.timerLeft = room.turnDuration;
    }
    if (Number(payload.maxPlayers) >= 2 && Number(payload.maxPlayers) <= 6) {
      room.maxPlayers = Number(payload.maxPlayers);
      while (room.players.length > room.maxPlayers && room.players[room.players.length - 1].isBot) {
        room.players.pop();
      }
    }
    emitLobbyUpdate(room);
  });

  socket.on('add_bot', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room) {
      return socket.emit('lobby_notice', { message: 'الغرفة غير موجودة، أعد إنشاء الغرفة.' });
    }
    if (!isRoomHost(room, socket, payload)) {
      return socket.emit('lobby_notice', { message: 'فقط مضيف الغرفة يمكنه إضافة بوتات.' });
    }
    if (room.started) return;
    if (room.players.length >= room.maxPlayers) {
      return socket.emit('lobby_notice', {
        message: `الغرفة ممتلئة (${room.players.length}/${room.maxPlayers})! ارفع الحد الأقصى للاعبين أولاً.`
      });
    }

    room.players.push(createBotEntry(room));
    emitLobbyUpdate(room);
  });

  socket.on('remove_bot', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !isRoomHost(room, socket, payload) || room.started) return;

    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].isBot) {
        room.players.splice(i, 1);
        emitLobbyUpdate(room);
        return;
      }
    }
    socket.emit('lobby_notice', { message: 'لا يوجد بوت في المقاعد لحذفه.' });
  });

  socket.on('start_match', (payload = {}, ack) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room) {
      const msg = 'انتهت جلسة الغرفة على السيرفر، ارجع وأنشئ غرفة جديدة.';
      socket.emit('lobby_notice', { message: msg });
      if (typeof ack === 'function') ack({ ok: false, error: msg });
      return;
    }
    if (!isRoomHost(room, socket, payload)) {
      const msg = 'فقط مضيف الغرفة يمكنه بدء المواجهة.';
      socket.emit('lobby_notice', { message: msg });
      if (typeof ack === 'function') ack({ ok: false, error: msg });
      return;
    }
    if (room.started) {
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }

    socket.join(code);
    socket.data.roomCode = code;

    if ([30, 45, 60].includes(Number(payload.turnDuration))) {
      room.turnDuration = Number(payload.turnDuration);
    }

    if (room.players.length < 2) {
      const msg = 'أضف بوتاً أو انتظر لاعباً آخر لبدء المباراة (2 على الأقل).';
      socket.emit('lobby_notice', { message: msg });
      if (typeof ack === 'function') ack({ ok: false, error: msg });
      return;
    }

    room.started = true;
    room.round = 1;
    room.turnIndex = 0;
    room.players.forEach((p) => {
      p.hearts = MAX_HEARTS;
      p.items = [];
      p.cuffed = false;
      p.hasShield = false;
      p.shieldTurns = 0;
      p.pillowTurns = 0;
    });

    if (typeof ack === 'function') ack({ ok: true });
    startNewRound(room, true);
  });

  socket.on('send_emote', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !room.started) return;

    const token = payload.playerToken || socket.data.playerToken;
    const sender = room.players.find((p) => p.id === socket.id || (token && p.token && p.token === token));
    if (!sender) return;

    sender.id = socket.id;
    sender.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;

    const emoteId = String(payload.emoteId || payload.emoji || '').trim().slice(0, 16);
    if (!emoteId) return;

    const emotePayload = {
      playerId: sender.id,
      playerToken: sender.token,
      playerName: sender.name,
      emoteId
    };

    room.players.forEach((p) => {
      if (!p.isBot && p.socketId) {
        io.to(p.socketId).emit('player_emote', emotePayload);
      }
    });
  });

  socket.on('chat_message', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const token = payload.playerToken || socket.data.playerToken;
    const sender = room.players.find((p) => p.id === socket.id || (token && p.token && p.token === token));
    if (!sender) return;

    sender.id = socket.id;
    sender.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;

    const text = String(payload.text || '').trim().slice(0, 220);
    if (!text) return;

    const chatPayload = {
      senderId: sender.id,
      senderToken: sender.token,
      senderName: sender.name,
      text,
      timestamp: Date.now()
    };

    room.players.forEach((p) => {
      if (!p.isBot && p.socketId) {
        io.to(p.socketId).emit('chat_message', chatPayload);
      }
    });
  });

  // ==================== WEBRTC VOICE CHAT SIGNALING ====================
  socket.on('voice_join', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const token = payload.playerToken || socket.data.playerToken;
    const sender = room.players.find((p) => p.id === socket.id || (token && p.token && p.token === token));
    if (!sender || sender.isBot) return;

    sender.id = socket.id;
    sender.socketId = socket.id;
    sender.voiceActive = true;
    sender.voiceMuted = Boolean(payload.muted);
    socket.join(room.code);
    socket.data.roomCode = room.code;

    const existingVoicePeers = room.players
      .filter((p) => !p.isBot && p.socketId && p.socketId !== socket.id && p.voiceActive)
      .map((p) => ({
        socketId: p.socketId,
        token: p.token,
        name: p.name,
        muted: Boolean(p.voiceMuted)
      }));

    socket.emit('voice_peers', { peers: existingVoicePeers });

    room.players.forEach((p) => {
      if (!p.isBot && p.socketId && p.socketId !== socket.id) {
        if (p.voiceActive) {
          io.to(p.socketId).emit('voice_peer_joined', {
            socketId: sender.socketId,
            token: sender.token,
            name: sender.name,
            muted: Boolean(sender.voiceMuted)
          });
        }
        io.to(p.socketId).emit('voice_status_updated', {
          playerId: sender.id,
          playerToken: sender.token,
          voiceActive: true,
          voiceMuted: Boolean(sender.voiceMuted)
        });
      }
    });
  });

  socket.on('voice_leave', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const token = payload.playerToken || socket.data.playerToken;
    const sender = room.players.find((p) => p.id === socket.id || (token && p.token && p.token === token));
    if (!sender) return;

    sender.voiceActive = false;
    sender.voiceMuted = false;

    room.players.forEach((p) => {
      if (!p.isBot && p.socketId && p.socketId !== socket.id) {
        io.to(p.socketId).emit('voice_peer_left', {
          socketId: sender.id,
          token: sender.token
        });
        io.to(p.socketId).emit('voice_status_updated', {
          playerId: sender.id,
          playerToken: sender.token,
          voiceActive: false,
          voiceMuted: false
        });
      }
    });
  });

  socket.on('voice_mute_state', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room) return;

    const token = payload.playerToken || socket.data.playerToken;
    const sender = room.players.find((p) => p.id === socket.id || (token && p.token && p.token === token));
    if (!sender) return;

    sender.voiceMuted = Boolean(payload.muted);
    room.players.forEach((p) => {
      if (!p.isBot && p.socketId) {
        io.to(p.socketId).emit('voice_status_updated', {
          playerId: sender.id,
          playerToken: sender.token,
          voiceActive: Boolean(sender.voiceActive),
          voiceMuted: Boolean(sender.voiceMuted)
        });
      }
    });
  });

  socket.on('voice_signal', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !payload.targetSocketId || !payload.signal) return;

    const token = payload.playerToken || socket.data.playerToken;
    const sender = room.players.find((p) => p.id === socket.id || (token && p.token && p.token === token));
    if (!sender) return;

    io.to(payload.targetSocketId).emit('voice_signal', {
      fromSocketId: socket.id,
      fromToken: sender.token,
      fromName: sender.name,
      signal: payload.signal
    });
  });

  socket.on('aim_target', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !room.started || room.busy) return;

    const current = isCurrentTurnActor(room, socket, payload);
    if (!current) return;

    const target = room.players.find((p) => p.id === payload.targetId && p.hearts > 0);
    if (!target) return;

    io.to(room.code).emit('aim_updated', {
      shooterId: current.id,
      targetId: target.id
    });
  });

  socket.on('thief_inspect', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !room.started || room.busy) return;

    const actor = isCurrentTurnActor(room, socket, payload);
    if (!actor) return;

    const slotIndex = Number(payload.slotIndex);
    if (actor.items[slotIndex] !== 'thief') return;

    const target = room.players.find((p) => p.id === payload.targetId && p.hearts > 0 && p.id !== actor.id);
    if (!target) return;

    if (target.hasShield) {
      actor.items.splice(slotIndex, 1);
      target.hasShield = false;
        target.shieldTurns = 0;
      const msg = `🛡️ درع ${target.name} تصدّى للسارق وتحطّم!`;
      socket.emit('thief_blocked');
      io.to(room.code).emit('action_event', {
        type: 'item',
        ejectedShell: null,
        message: msg,
        highlight: 'safe'
      });
      broadcastGameState(room, msg, 'safe');
      return;
    }

    socket.emit('thief_reveal', {
      targetId: target.id,
      targetName: target.name,
      items: [...target.items]
    });
  });

  socket.on('shoot', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !room.started || room.busy) return;

    const current = isCurrentTurnActor(room, socket, payload);
    if (!current) return;

    const selfShot = Boolean(payload.selfShot) || payload.targetId === current.id;
    const target = selfShot
      ? current
      : room.players.find((p) => p.id === payload.targetId && p.hearts > 0);
    if (!target) return;

    performShot(room, current.id, target.id, selfShot);
  });

  socket.on('use_item', (payload = {}) => {
    const code = normalizeCode(payload.roomId || payload.code || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room || !room.started || room.busy) return;

    const actor = isCurrentTurnActor(room, socket, payload);
    if (!actor) return;

    const slotIndex = Number(payload.slotIndex);
    const itemKey = actor.items[slotIndex];
    if (!itemKey) return;

    let ejectedShell = null;
    let msg = '';
    let highlight = 'neutral';

    if (itemKey === 'glass') {
      const topShell = room.chamber[0];
      actor.items.splice(slotIndex, 1);
      socket.emit('peek_result', { shell: topShell });
      msg = `🔍 ${actor.name} استخدم العدسة المكبرة لفحص بيت النار.`;
    } else if (itemKey === 'saw') {
      if (room.sawed) return;
      actor.items.splice(slotIndex, 1);
      room.sawed = true;
      msg = `🪚 ${actor.name} قص الفوهة! الطلقة القادمة ضرر x2.`;
      highlight = 'danger';
    } else if (itemKey === 'drink') {
      ejectedShell = room.chamber.shift();
      actor.items.splice(slotIndex, 1);
      msg = `🥤 ${actor.name} شرب الطاقة وأخرج رصاصة (${ejectedShell === 'live' ? 'حية 🔴' : 'فارغة ⚪'}).`;
      highlight = ejectedShell === 'live' ? 'danger' : 'safe';
    } else if (itemKey === 'smoke') {
      if (actor.hearts >= MAX_HEARTS) return;
      actor.items.splice(slotIndex, 1);
      actor.hearts = Math.min(MAX_HEARTS, actor.hearts + 1);
      msg = `💊 ${actor.name} تناول البراسيتول واستعاد +1 قلب.`;
      highlight = 'gold';
    } else if (itemKey === 'flipper') {
      if (room.chamber.length === 0) return;
      actor.items.splice(slotIndex, 1);
      room.chamber[0] = room.chamber[0] === 'live' ? 'blank' : 'live';
      msg = `🔁 ${actor.name} استخدم القلّاب وعكس الرصاصة الحالية!`;
      highlight = 'gold';
    } else if (itemKey === 'shield') {
      if (actor.hasShield) return;
      actor.items.splice(slotIndex, 1);
      actor.hasShield = true;
      actor.shieldTurns = 3;
      msg = `🛡️ ${actor.name} فعّل الدرع الواقي (3 أدوار)!`;
      highlight = 'safe';
    } else if (itemKey === 'pillow') {
      actor.items.splice(slotIndex, 1);
      actor.pillowTurns = 2;
      msg = `🛏️ ${actor.name} جهّز أداة سرية.`;
    } else if (itemKey === 'cuffs') {
      const target = room.players.find((p) => p.id === payload.targetId && p.hearts > 0 && p.id !== actor.id);
      if (!target) return;
      actor.items.splice(slotIndex, 1);
      if (target.hasShield) {
        target.hasShield = false;
        target.shieldTurns = 0;
        msg = `🛡️ درع ${target.name} تصدّى للقيود وتحطّم!`;
        highlight = 'safe';
      } else {
        target.cuffed = true;
        msg = `⛓️ ${actor.name} قيّد ${target.name}!`;
        highlight = 'gold';
      }
    } else if (itemKey === 'swapper') {
      const target = room.players.find((p) => p.id === payload.targetId && p.hearts > 0 && p.id !== actor.id);
      if (!target) return;
      actor.items.splice(slotIndex, 1);
      if (target.hasShield) {
        target.hasShield = false;
        target.shieldTurns = 0;
        msg = `🛡️ درع ${target.name} منع التبادل وتحطّم!`;
        highlight = 'safe';
      } else {
        const temp = [...actor.items];
        actor.items = [...target.items];
        target.items = temp;
        msg = `🔄 ${actor.name} بدّل جميع أدواته مع ${target.name}!`;
        highlight = 'gold';
      }
    } else if (itemKey === 'thief') {
      const target = room.players.find((p) => p.id === payload.targetId && p.hearts > 0 && p.id !== actor.id);
      if (!target) return;
      actor.items.splice(slotIndex, 1);
      if (target.hasShield) {
        target.hasShield = false;
        target.shieldTurns = 0;
        msg = `🛡️ درع ${target.name} تصدّى للسارق وتحطّم!`;
        highlight = 'safe';
      } else if (target.items.length > 0) {
        const sIdx = Number.isInteger(Number(payload.stealIndex)) && Number(payload.stealIndex) >= 0 && Number(payload.stealIndex) < target.items.length
          ? Number(payload.stealIndex)
          : target.items.length - 1;
        const stolen = target.items.splice(sIdx, 1)[0];
        if (actor.items.length < MAX_SLOTS) actor.items.push(stolen);
        msg = `🦝 ${actor.name} سرق أداة من ${target.name}!`;
        highlight = 'gold';
      } else {
        msg = `🦝 ${actor.name} حاول السرقة من ${target.name} لكن مخزونه فارغ!`;
      }
    }

    io.to(room.code).emit('action_event', {
      type: 'item',
      ejectedShell,
      message: msg,
      highlight
    });

    if (room.chamber.length === 0) {
      broadcastGameState(room, msg, highlight);
      setTimeout(() => {
        room.round++;
        startNewRound(room, false);
      }, 1100);
      return;
    }

    broadcastGameState(room, msg, highlight);
  });

  socket.on('leave_room', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    const leavingPlayer = room.players.find((p) => p.id === socket.id);
    if (leavingPlayer) {
      io.to(room.code).emit('voice_peer_left', { socketId: leavingPlayer.id, token: leavingPlayer.token });
    }
    room.players = room.players.filter((p) => p.id !== socket.id);
    socket.leave(code);
    socket.data.roomCode = null;

    const humans = room.players.filter((p) => !p.isBot);
    if (humans.length === 0) {
      clearInterval(room.timerInterval);
      clearTimeout(room.botTimeout);
      clearTimeout(room.roundRevealTimeout);
      rooms.delete(code);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = humans[0].id;
      room.hostToken = humans[0].token;
    }
    emitLobbyUpdate(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    // Keep players for 10s in case of quick mobile reconnect
    setTimeout(() => {
      const currentRoom = rooms.get(code);
      if (!currentRoom) return;
      const stillDisconnected = currentRoom.players.find((p) => p.id === socket.id);
      if (!stillDisconnected) return;

      io.to(currentRoom.code).emit('voice_peer_left', { socketId: stillDisconnected.id, token: stillDisconnected.token });
      currentRoom.players = currentRoom.players.filter((p) => p.id !== socket.id);
      const humans = currentRoom.players.filter((p) => !p.isBot);
      if (humans.length === 0) {
        clearInterval(currentRoom.timerInterval);
        clearTimeout(currentRoom.botTimeout);
        clearTimeout(currentRoom.roundRevealTimeout);
        rooms.delete(code);
        return;
      }
      if (currentRoom.hostId === socket.id) {
        currentRoom.hostId = humans[0].id;
        currentRoom.hostToken = humans[0].token;
      }
      emitLobbyUpdate(currentRoom);
    }, 45000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Shawzen server running on port ${PORT}`));