const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'eazychat-db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], chats: [], messages: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

let cache = null;

function load() {
  ensureDb();
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      cache.users = cache.users || [];
      cache.chats = cache.chats || [];
      cache.messages = cache.messages || [];
    } catch (err) {
      cache = { users: [], chats: [], messages: [] };
    }
  }
  return cache;
}

function save() {
  ensureDb();
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

const db = {
  // Users
  findUserByUsername(username) {
    const normalized = String(username || '').trim().toLowerCase();
    return load().users.find(u => u.username === normalized) || null;
  },
  findUserById(id) {
    return load().users.find(u => u.id === id) || null;
  },
  listUsers() {
    return load().users;
  },
  createUser(user) {
    load().users.push(user);
    save();
    return user;
  },
  updateUser(id, patch) {
    const u = this.findUserById(id);
    if (!u) return null;
    Object.assign(u, patch);
    save();
    return u;
  },

  // Chats
  findChatById(id) {
    return load().chats.find(c => c.id === id) || null;
  },
  findDirectChat(userIdA, userIdB) {
    return load().chats.find(
      c => !c.isGroup && c.members.length === 2 && c.members.includes(userIdA) && c.members.includes(userIdB)
    ) || null;
  },
  listUserChats(userId) {
    return load().chats.filter(c => c.members.includes(userId));
  },
  createChat(chat) {
    load().chats.push(chat);
    save();
    return chat;
  },
  updateChat(id, patch) {
    const c = this.findChatById(id);
    if (!c) return null;
    Object.assign(c, patch);
    save();
    return c;
  },

  // Messages
  listChatMessages(chatId) {
    return load().messages.filter(m => m.chatId === chatId);
  },
  findMessageById(id) {
    return load().messages.find(m => m.id === id) || null;
  },
  createMessage(msg) {
    load().messages.push(msg);
    save();
    return msg;
  },
  deleteMessage(id) {
    const store = load();
    const idx = store.messages.findIndex(m => m.id === id);
    if (idx === -1) return false;
    store.messages.splice(idx, 1);
    save();
    return true;
  },
  markMessagesRead(chatId, readerId) {
    const store = load();
    const updatedIds = [];
    store.messages.forEach(m => {
      if (m.chatId === chatId && m.senderId !== readerId) {
        if (!Array.isArray(m.readBy)) m.readBy = [];
        if (!m.readBy.includes(readerId)) {
          m.readBy.push(readerId);
          m.status = 'read';
          updatedIds.push(m.id);
        }
      }
    });
    if (updatedIds.length > 0) save();
    return updatedIds;
  },
  toggleReaction(messageId, userId, emoji) {
    const msg = this.findMessageById(messageId);
    if (!msg) return null;
    if (!msg.reactions) msg.reactions = {};
    if (!Array.isArray(msg.reactions[emoji])) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(userId);
    if (idx >= 0) {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    } else {
      msg.reactions[emoji].push(userId);
    }
    save();
    return msg;
  }
};

module.exports = db;
