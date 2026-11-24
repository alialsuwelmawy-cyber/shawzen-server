function addLobbyBot() {
  const maxSlots = AppState.maxRoomPlayers || 6;
  if (AppState.lobbySeats.length >= maxSlots) return;

  if (socket && OnlineSession.connected && OnlineSession.roomId && OnlineSession.isHost) {
    socket.emit('add_bot', {
      roomId: OnlineSession.roomId,
      code: OnlineSession.roomId
    });
    return;
  }

  const botIdx = AppState.lobbySeats.filter(s => s.isBot).length;
  const loadout = generateBotLoadout(botIdx + 1);
  AppState.lobbySeats.push({
    id: `bot_${Date.now()}_${botIdx}`,
    name: BOT_NAMES_POOL[botIdx % BOT_NAMES_POOL.length],
    avatar: BOT_AVATARS[botIdx % BOT_AVATARS.length],
    isBot: true,
    isSelf: false,
    weaponId: loadout.weaponId,
    skinId: loadout.skinId
  });
  AudioEngine.itemUse();
  renderLobbySeats();
}

function removeLobbyBot() {
  if (AppState.lobbySeats.length <= 1) return;

  if (socket && OnlineSession.connected && OnlineSession.roomId && OnlineSession.isHost) {
    socket.emit('remove_bot', {
      roomId: OnlineSession.roomId,
      code: OnlineSession.roomId
    });
    return;
  }

  for (let i = AppState.lobbySeats.length - 1; i >= 0; i--) {
    if (AppState.lobbySeats[i].isBot) {
      AppState.lobbySeats.splice(i, 1);
      AudioEngine.blankClick();
      renderLobbySeats();
      return;
    }
  }
}