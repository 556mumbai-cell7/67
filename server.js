const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};

// Função simples para o servidor saber onde estão as paredes (para bloquear tiro)
function checkWallCollision(x, z) {
  // Essas são as caixas que geramos no mapa do cliente (mesmas posições aproximadas)
  const walls = [
    {x: 10, z: 10, w: 4, d: 4}, {x: -10, z: -10, w: 4, d: 4}, {x: 20, z: 5, w: 8, d: 2},
    {x: -20, z: -5, w: 8, d: 2}, {x: 5, z: -20, w: 2, d: 8}, {x: -5, z: 20, w: 2, d: 8}
  ];
  for (let w of walls) {
    if (x > w.x - w.w/2 && x < w.x + w.w/2 && z > w.z - w.d/2 && z < w.z + w.d/2) return true;
  }
  return false;
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (data) => {
    const roomId = data.roomId;
    socket.join(roomId);

    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, bots: [] };
      if (data.mode === 'br') {
        for(let i=0; i<15; i++) {
          rooms[roomId].bots.push({
            id: 'bot_' + i, x: Math.random() * 80 - 40, z: Math.random() * 80 - 40, yaw: 0, health: 100, alive: true
          });
        }
      }
    }

    rooms[roomId].players[socket.id] = {
      username: data.username, x: 0, z: 0, yaw: 0, health: 100, kills: 0
    };

    socket.roomId = roomId;
    io.to(roomId).emit('updateRoom', rooms[roomId]);
  });

  socket.on('move', (data) => {
    const room = rooms[socket.roomId];
    if (room && room.players[socket.id]) {
      room.players[socket.id].x = data.x;
      room.players[socket.id].z = data.z;
      room.players[socket.id].yaw = data.yaw;
      socket.to(socket.roomId).emit('playerMoved', { id: socket.id, data: room.players[socket.id] });
    }
  });

  socket.on('shoot', (data) => {
    const room = rooms[socket.roomId];
    if (!room || !room.players[socket.id]) return;
    const shooter = room.players[socket.id];

    // Se atirou em um bot
    if (data.targetType === 'bot') {
      const bot = room.bots.find(b => b.id === data.targetId);
      if (bot && bot.alive) {
        // O SERVIDOR CHECA SE TEM PAREDE NO MEIO
        if (checkWallCollision(bot.x, bot.z)) return; 

        bot.health -= 35;
        if (bot.health <= 0) { 
          bot.alive = false; 
          shooter.kills++; 
          io.to(socket.roomId).emit('botKilled', { killerId: socket.id, newKills: shooter.kills });
          checkBRWin(room, socket.roomId); 
        }
        io.to(socket.roomId).emit('updateRoom', room);
      }
    }
    
    // Se atirou em um jogador
    if (data.targetType === 'player' && room.players[data.targetId]) {
      const target = room.players[data.targetId];
      if (checkWallCollision(target.x, target.z)) return;

      target.health -= 25;
      if (target.health <= 0) { 
        target.health = 0; 
        shooter.kills++;
        io.to(socket.roomId).emit('botKilled', { killerId: socket.id, newKills: shooter.kills });
        io.to(data.targetId).emit('died'); 
      }
      io.to(socket.roomId).emit('playerHit', { id: data.targetId, health: target.health });
    }
  });

  function checkBRWin(room, roomId) {
    const botsAlive = room.bots.filter(b => b.alive).length;
    const playersAlive = Object.values(room.players).filter(p => p.health > 0).length;
    if (botsAlive === 0 && playersAlive === 1) {
      io.to(roomId).emit('gameOver');
    }
  }

  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      delete rooms[socket.roomId].players[socket.id];
      io.to(socket.roomId).emit('updateRoom', rooms[socket.roomId]);
      if (Object.keys(rooms[socket.roomId].players).length === 0) delete rooms[socket.roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor BR rodando na porta ${PORT}`));
