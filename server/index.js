require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'eazychat-dev-secret-change-in-production';
const AVATAR_COLORS = ['#00a884', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#4f46e5', '#059669'];

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Multer setup for voice audio uploads (up to 10 MB)
const audioStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.webm';
    cb(null, `audio-${Date.now()}-${uuidv4().slice(0, 8)}${ext}`);
  }
});

const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/x-m4a'];
    if (file.mimetype && (file.mimetype.startsWith('audio/') || allowed.includes(file.mimetype) || file.mimetype === 'video/webm')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed.'));
    }
  }
});

// Track online users: userId -> Set of socket IDs
const onlineUsers = new Map();

function isUserOnline(userId) {
  const sockets = onlineUsers.get(userId);
  return Boolean(sockets && sockets.size > 0);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    about: user.about || 'Hey there! I am using Eazychat.',
    color: user.color || '#00a884',
    online: isUserOnline(user.id),
    lastSeen: user.lastSeen || null
  };
}

function enrichChat(chat, currentUserId) {
  const messages = db.listChatMessages(chat.id);
  const lastMessage = messages[messages.length - 1] || null;
  const unreadCount = messages.filter(
    m => m.senderId !== currentUserId && !(Array.isArray(m.readBy) && m.readBy.includes(currentUserId))
  ).length;

  const memberProfiles = chat.members
    .map(id => publicUser(db.findUserById(id)))
    .filter(Boolean);

  let displayName = chat.name;
  let color = chat.color || '#00a884';
  let otherUser = null;

  if (!chat.isGroup) {
    otherUser = memberProfiles.find(u => u.id !== currentUserId) || memberProfiles[0] || null;
    if (otherUser) {
      displayName = otherUser.name;
      color = otherUser.color;
    }
  }

  return {
    id: chat.id,
    isGroup: Boolean(chat.isGroup),
    name: displayName,
    about: chat.isGroup ? (chat.about || 'Group conversation') : (otherUser ? otherUser.about : ''),
    color,
    online: otherUser ? otherUser.online : false,
    lastSeen: otherUser ? otherUser.lastSeen : null,
    otherUserId: otherUser ? otherUser.id : null,
    members: memberProfiles,
    unreadCount,
    lastMessage,
    updatedAt: lastMessage ? lastMessage.createdAt : chat.createdAt
  };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.findUserById(payload.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --- AUTH ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Display name must be at least 2 characters.' });
    }
    if (!username || !/^[a-z0-9._+-]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'Username/phone must be 3–30 characters (letters, numbers, ., _, +, -).' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (db.findUserByUsername(username)) {
      return res.status(409).json({ error: 'That username is already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = db.createUser({
      id: uuidv4(),
      name,
      username,
      passwordHash,
      about: 'Hey there! I am using Eazychat.',
      color: AVATAR_COLORS[db.listUsers().length % AVATAR_COLORS.length],
      lastSeen: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.findUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password.' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.patch('/api/auth/me', authMiddleware, (req, res) => {
  const name = String(req.body.name || req.user.name).trim();
  const about = String(req.body.about ?? req.user.about).trim();
  if (!name) return res.status(400).json({ error: 'Display name is required.' });
  const updated = db.updateUser(req.user.id, { name, about });
  io.emit('user:updated', publicUser(updated));
  res.json({ user: publicUser(updated) });
});

// --- USERS & CHATS ROUTES ---
app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.listUsers()
    .filter(u => u.id !== req.user.id)
    .map(publicUser);
  res.json({ users });
});

app.get('/api/chats', authMiddleware, (req, res) => {
  const chats = db.listUserChats(req.user.id)
    .map(c => enrichChat(c, req.user.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ chats });
});

app.post('/api/chats/direct', authMiddleware, (req, res) => {
  const targetUserId = req.body.userId;
  const target = db.findUserById(targetUserId);
  if (!target || target.id === req.user.id) {
    return res.status(400).json({ error: 'Valid recipient user is required.' });
  }

  let chat = db.findDirectChat(req.user.id, target.id);
  if (!chat) {
    chat = db.createChat({
      id: uuidv4(),
      isGroup: false,
      name: '',
      members: [req.user.id, target.id],
      createdAt: new Date().toISOString()
    });
    // Notify both users' sockets to join the new room
    [req.user.id, target.id].forEach(uid => {
      const sockets = onlineUsers.get(uid);
      if (sockets) {
        sockets.forEach(sid => {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            s.join(chat.id);
            s.emit('chat:created', enrichChat(chat, uid));
          }
        });
      }
    });
  }

  res.status(201).json({ chat: enrichChat(chat, req.user.id) });
});

app.post('/api/chats/group', authMiddleware, (req, res) => {
  const name = String(req.body.name || '').trim();
  const memberIds = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
  if (!name) return res.status(400).json({ error: 'Group name is required.' });

  const uniqueMembers = Array.from(new Set([req.user.id, ...memberIds]))
    .filter(id => Boolean(db.findUserById(id)));

  if (uniqueMembers.length < 2) {
    return res.status(400).json({ error: 'Select at least one other member.' });
  }

  const chat = db.createChat({
    id: uuidv4(),
    isGroup: true,
    name,
    about: `Created by ${req.user.name}`,
    color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
    members: uniqueMembers,
    createdAt: new Date().toISOString()
  });

  uniqueMembers.forEach(uid => {
    const sockets = onlineUsers.get(uid);
    if (sockets) {
      sockets.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.join(chat.id);
          s.emit('chat:created', enrichChat(chat, uid));
        }
      });
    }
  });

  res.status(201).json({ chat: enrichChat(chat, req.user.id) });
});

app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
  const chat = db.findChatById(req.params.chatId);
  if (!chat || !chat.members.includes(req.user.id)) {
    return res.status(404).json({ error: 'Chat not found.' });
  }
  const messages = db.listChatMessages(chat.id);
  res.json({ messages });
});

app.post('/api/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
  res.status(201).json({ imageUrl: `/uploads/${req.file.filename}` });
});

app.post('/api/upload-audio', authMiddleware, uploadAudio.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded.' });
  res.status(201).json({ audioUrl: `/uploads/${req.file.filename}` });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: 'Eazychat' });
});

// --- SOCKET.IO REAL-TIME ENGINE ---
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.findUserById(payload.userId);
    if (!user) return next(new Error('User not found'));
    socket.user = user;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', socket => {
  const userId = socket.user.id;

  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId).add(socket.id);

  // Join all chat rooms for this user
  const userChats = db.listUserChats(userId);
  userChats.forEach(c => socket.join(c.id));

  io.emit('presence:update', { userId, online: true, lastSeen: new Date().toISOString() });

  socket.on('message:send', (payload, ack) => {
    try {
      const { chatId, type = 'text', text = '', imageUrl = '', audioUrl = '', duration = 0, replyTo = null } = payload || {};
      const chat = db.findChatById(chatId);
      if (!chat || !chat.members.includes(userId)) {
        if (ack) ack({ error: 'Chat not found' });
        return;
      }

      const trimmed = String(text || '').trim();
      if (type === 'text' && !trimmed) {
        if (ack) ack({ error: 'Message cannot be empty' });
        return;
      }
      if (type === 'audio' && !audioUrl) {
        if (ack) ack({ error: 'Audio URL is required' });
        return;
      }

      const anyOtherOnline = chat.members.some(mid => mid !== userId && isUserOnline(mid));
      const sender = db.findUserById(userId);

      const message = db.createMessage({
        id: uuidv4(),
        chatId,
        senderId: userId,
        senderName: sender ? sender.name : 'Unknown',
        type,
        text: trimmed,
        imageUrl: type === 'image' ? imageUrl : '',
        audioUrl: type === 'audio' ? audioUrl : '',
        duration: type === 'audio' ? Math.round(Number(duration || 0)) : 0,
        replyTo: replyTo ? {
          id: replyTo.id,
          senderName: replyTo.senderName,
          text: replyTo.text
        } : null,
        status: anyOtherOnline ? 'delivered' : 'sent',
        readBy: [userId],
        reactions: {},
        createdAt: new Date().toISOString()
      });

      io.to(chatId).emit('message:new', { chatId, message });
      if (ack) ack({ ok: true, message });
    } catch (err) {
      if (ack) ack({ error: 'Failed to send message' });
    }
  });

  socket.on('message:read', ({ chatId }) => {
    const chat = db.findChatById(chatId);
    if (!chat || !chat.members.includes(userId)) return;
    const updatedIds = db.markMessagesRead(chatId, userId);
    if (updatedIds.length > 0) {
      io.to(chatId).emit('message:status', { chatId, messageIds: updatedIds, status: 'read', readerId: userId });
    }
  });

  socket.on('message:react', ({ chatId, messageId, emoji }) => {
    const chat = db.findChatById(chatId);
    if (!chat || !chat.members.includes(userId)) return;
    const updated = db.toggleReaction(messageId, userId, emoji);
    if (updated) {
      io.to(chatId).emit('message:updated', { chatId, message: updated });
    }
  });

  socket.on('message:delete', ({ chatId, messageId }) => {
    const chat = db.findChatById(chatId);
    const msg = db.findMessageById(messageId);
    if (!chat || !msg || msg.chatId !== chatId || msg.senderId !== userId) return;
    if (db.deleteMessage(messageId)) {
      io.to(chatId).emit('message:deleted', { chatId, messageId });
    }
  });

  socket.on('typing:start', ({ chatId }) => {
    const sender = db.findUserById(userId);
    socket.to(chatId).emit('typing:update', { chatId, userId, userName: sender ? sender.name : 'Someone', isTyping: true });
  });

  socket.on('typing:stop', ({ chatId }) => {
    socket.to(chatId).emit('typing:update', { chatId, userId, isTyping: false });
  });

  // --- WEBRTC 1-ON-1 AUDIO/VIDEO CALL SIGNALING ---
  function sendCallSignal(targetUid, eventName, data) {
    const sockets = onlineUsers.get(targetUid);
    if (sockets && sockets.size > 0) {
      sockets.forEach(sid => io.to(sid).emit(eventName, data));
      return true;
    }
    return false;
  }

  socket.on('call:offer', ({ chatId, targetUserId, offer, callType }) => {
    const chat = db.findChatById(chatId);
    if (!chat || !chat.members.includes(userId) || !chat.members.includes(targetUserId)) {
      return socket.emit('call:rejected', { chatId, reason: 'Invalid call session' });
    }
    const caller = db.findUserById(userId);
    const sent = sendCallSignal(targetUserId, 'call:incoming', {
      chatId,
      callerId: userId,
      callerName: caller ? caller.name : 'Unknown',
      callerColor: caller ? caller.color : '#00a884',
      offer,
      callType: callType || 'video'
    });
    if (!sent) {
      socket.emit('call:rejected', { chatId, targetUserId, reason: 'User is currently offline' });
    }
  });

  socket.on('call:answer', ({ chatId, targetUserId, answer }) => {
    const chat = db.findChatById(chatId);
    if (!chat || !chat.members.includes(userId) || !chat.members.includes(targetUserId)) return;
    sendCallSignal(targetUserId, 'call:answered', {
      chatId,
      userId,
      answer
    });
  });

  socket.on('call:ice-candidate', ({ chatId, targetUserId, candidate }) => {
    const chat = db.findChatById(chatId);
    if (!chat || !chat.members.includes(userId) || !chat.members.includes(targetUserId)) return;
    sendCallSignal(targetUserId, 'call:ice-candidate', {
      chatId,
      userId,
      candidate
    });
  });

  socket.on('call:reject', ({ chatId, targetUserId, reason }) => {
    const chat = db.findChatById(chatId);
    if (!chat || !chat.members.includes(userId) || !chat.members.includes(targetUserId)) return;
    sendCallSignal(targetUserId, 'call:rejected', {
      chatId,
      userId,
      reason: reason || 'declined'
    });
  });

  socket.on('call:hangup', ({ chatId, targetUserId }) => {
    const chat = db.findChatById(chatId);
    if (!chat || !chat.members.includes(userId) || !chat.members.includes(targetUserId)) return;
    sendCallSignal(targetUserId, 'call:ended', {
      chatId,
      userId
    });
  });

  socket.on('disconnect', () => {
    const set = onlineUsers.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(userId);
        const lastSeen = new Date().toISOString();
        db.updateUser(userId, { lastSeen });
        io.emit('presence:update', { userId, online: false, lastSeen });
      }
    }
  });
});

// Fallback to index.html for SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Express error handling middleware (handles Multer upload errors and general exceptions)
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const isAudio = (req.originalUrl || req.url || '').includes('audio');
      return res.status(400).json({ error: isAudio ? 'Audio file size exceeds 10 MB limit.' : 'File size exceeds 5 MB limit.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err && (err.message === 'Only image files are allowed' || err.message === 'Only audio files are allowed.' || err.message?.includes('allowed'))) {
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    const status = err.status && typeof err.status === 'number' ? err.status : 400;
    return res.status(status).json({ error: err.message || 'An unexpected error occurred.' });
  }
  _next();
});

server.listen(PORT, () => {
  console.log(`Eazychat server running at http://localhost:${PORT}`);
});
