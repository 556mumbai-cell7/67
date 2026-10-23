const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const rooms = {};

function isSafeSpawn(x, z) {
  const buildings = [
    { x: 15, z: 15, w: 10, d: 10 }, { x: -20, z: -20, w: 12, d: 12 },
    { x: 25, z: -15, w: 8, d: 8 }, { x: -25, z: 20, w: 8, d: 8 },
    { x: 5, z: -25, w: 4, d: 15 }, { x: -5, z: 25, w: 4, d: 15 }
  ];
  for (let b of buildings) {
    if (x > b.x - b.w/2 && x < b.x + b.w/2 && z > b.z - b.d/2 && z < b.z + b.d/2) return false;
  }
  return true;
}

function sendState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  // Snapshot limpo — o cliente só desenha
  io.to(roomId).emit('state', {
    players: room.players,
    bots: room.bots,
    glooWalls: room.glooWalls || []
  });
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (data) => {
    const roomId = data.roomId;
    socket.join(roomId);
    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, bots: [], glooWalls: [] };
      if (data.mode === 'br') {
        for (let i = 0; i < 15; i++) {
          let sx, sz;
          do { sx = Math.random() * 80 - 40; sz = Math.random() * 80 - 40; } while (!isSafeSpawn(sx, sz));
          rooms[roomId].bots.push({ id: 'bot_' + i, x: sx, z: sz, yaw: 0, health: 100, alive: true });
        }
      }
    }

    let px = 0, pz = 0;
    do { px = Math.random() * 80 - 40; pz = Math.random() * 80 - 40; } while (!isSafeSpawn(px, pz));

    rooms[roomId].players[socket.id] = {
      username: data.username, x: px, z: pz, yaw: 0,
      health: 100, kills: 0, alive: true
    };
    socket.roomId = roomId;
    sendState(roomId);
  });

  socket.on('move', (data) => {
    const room = rooms[socket.roomId];
    if (room && room.players[socket.id] && room.players[socket.id].alive) {
      const p = room.players[socket.id];
      p.x = data.x; p.z = data.z; p.yaw = data.yaw;
      socket.to(socket.roomId).emit('playerMoved', { id: socket.id, data: p });
    }
  });

  socket.on('spawnGloo', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (!room.glooWalls) room.glooWalls = [];
    const wall = { x: data.x, z: data.z, yaw: data.yaw };
    room.glooWalls.push(wall);
    // Manda pra TODOS (inclusive o autor) — evita duplicação se o client só criar via evento
    io.to(socket.roomId).emit('glooCreated', wall);
  });

  socket.on('shoot', (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id] || !room.players[socket.id].alive) return;
    const shooter = room.players[socket.id];

    if (data.targetType === 'bot') {
      const bot = room.bots.find(b => b.id === data.targetId);
      if (bot && bot.alive) {
        bot.health -= 35;
        io.to(socket.roomId).emit('botHit', { id: bot.id, health: Math.max(0, bot.health) });
        if (bot.health <= 0) {
          bot.alive = false;
          shooter.kills++;
          io.to(socket.roomId).emit('botDied', { id: bot.id });
          io.to(socket.roomId).emit('killsUpdate', { id: socket.id, kills: shooter.kills });
          checkWin(room, socket.roomId);
        }
      }
    }
    if (data.targetType === 'player' && room.players[data.targetId]) {
      const target = room.players[data.targetId];
      if (!target.alive) return;
      target.health -= 25;
      if (target.health <= 0) {
        target.health = 0;
        target.alive = false;
        shooter.kills++;
        io.to(socket.roomId).emit('playerHit', { id: data.targetId, health: 0 });
        io.to(socket.roomId).emit('playerDied', { id: data.targetId, killerId: socket.id });
        io.to(socket.roomId).emit('killsUpdate', { id: socket.id, kills: shooter.kills });
        checkWin(room, socket.roomId);
      } else {
        io.to(socket.roomId).emit('playerHit', { id: data.targetId, health: target.health });
      }
    }
  });

  socket.on('botAttack', (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[data.playerId]) return;
    const bot = room.bots.find(b => b.id === data.botId);
    const player = room.players[data.playerId];
    if (bot && bot.alive && player && player.alive) {
      player.health -= 10;
      if (player.health <= 0) {
        player.health = 0;
        player.alive = false;
        io.to(socket.roomId).emit('playerHit', { id: data.playerId, health: 0 });
        io.to(socket.roomId).emit('playerDied', { id: data.playerId, killerId: data.botId });
        checkWin(room, socket.roomId);
      } else {
        io.to(socket.roomId).emit('playerHit', { id: data.playerId, health: player.health });
      }
    }
  });

  function checkWin(room, roomId) {
    const alivePlayers = Object.values(room.players).filter(p => p.alive);
    const aliveBots = room.bots.filter(b => b.alive);
    // Vitória: só você vivo e nenhum bot vivo
    if (aliveBots.length === 0 && alivePlayers.length === 1) {
      io.to(roomId).emit('gameOver', { winnerId: Object.keys(room.players).find(id => room.players[id].alive) });
    }
  }

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      delete rooms[socket.roomId].players[socket.id];
      sendState(socket.roomId);
      if (Object.keys(rooms[socket.roomId].players).length === 0) delete rooms[socket.roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
