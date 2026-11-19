const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'eazychat-db.json');

let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
    });
    initPgTables();
  } catch (err) {
    console.error('Failed to initialize PostgreSQL pool, falling back to JSON:', err.message);
    pool = null;
  }
}

async function initPgTables() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS eazychat_store (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    // Preload from PG if available
    const res = await pool.query(`SELECT data FROM eazychat_store WHERE id = 'main'`);
    if (res.rows.length > 0 && res.rows[0].data) {
      cache = res.rows[0].data;
      cache.users = cache.users || [];
      cache.chats = cache.chats || [];
      cache.messages = cache.messages || [];
      cache.reports = cache.reports || [];
      saveToJson();
    } else {
      // Seed PG from local JSON
      saveToPg();
    }
  } catch (err) {
    console.error('PostgreSQL table init error:', err.message);
  }
}

function saveToPg() {
  if (!pool || !cache) return;
  pool.query(`
    INSERT INTO eazychat_store (id, data, updated_at)
    VALUES ('main', $1, NOW())
    ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
  `, [JSON.stringify(cache)]).catch(err => {
    console.error('PostgreSQL sync error:', err.message);
  });
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initial = { users: [], chats: [], messages: [], reports: [] };
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
      cache.reports = cache.reports || [];
    } catch (err) {
      cache = { users: [], chats: [], messages: [], reports: [] };
    }
  }
  return cache;
}

function saveToJson() {
  ensureDb();
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmpFile, DB_FILE);
}

function save() {
  saveToJson();
  saveToPg();
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
    if (!user.blockedUsers) user.blockedUsers = [];
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
  deleteUser(userId) {
    const store = load();
    const initialUserCount = store.users.length;
    store.users = store.users.filter(u => u.id !== userId);
    if (store.users.length === initialUserCount) return false;

    // Clean up blocked references
    store.users.forEach(u => {
      if (Array.isArray(u.blockedUsers)) {
        u.blockedUsers = u.blockedUsers.filter(bId => bId !== userId);
      }
    });

    // Remove user from chats or remove 1-on-1 chats involving this user
    store.chats = store.chats.filter(c => {
      if (!c.isGroup && c.members.includes(userId)) return false;
      if (c.isGroup && c.members.includes(userId)) {
        c.members = c.members.filter(m => m !== userId);
      }
      return true;
    });

    // Remove user's messages
    store.messages = store.messages.filter(m => m.senderId !== userId);

    save();
    return true;
  },

  // Blocking support
  blockUser(userId, targetUserId) {
    const user = this.findUserById(userId);
    if (!user) return false;
    if (!Array.isArray(user.blockedUsers)) user.blockedUsers = [];
    if (!user.blockedUsers.includes(targetUserId)) {
      user.blockedUsers.push(targetUserId);
      save();
    }
    return true;
  },
  unblockUser(userId, targetUserId) {
    const user = this.findUserById(userId);
    if (!user) return false;
    if (!Array.isArray(user.blockedUsers)) user.blockedUsers = [];
    const idx = user.blockedUsers.indexOf(targetUserId);
    if (idx >= 0) {
      user.blockedUsers.splice(idx, 1);
      save();
    }
    return true;
  },
  isBlocked(userAId, userBId) {
    const userA = this.findUserById(userAId);
    const userB = this.findUserById(userBId);
    if (userA && Array.isArray(userA.blockedUsers) && userA.blockedUsers.includes(userBId)) {
      return true;
    }
    if (userB && Array.isArray(userB.blockedUsers) && userB.blockedUsers.includes(userAId)) {
      return true;
    }
    return false;
  },

  // Reports
  createReport(report) {
    const store = load();
    if (!store.reports) store.reports = [];
    store.reports.push(report);
    save();
    return report;
  },
  listReports() {
    const store = load();
    return store.reports || [];
  },

  // Push Token
  setPushToken(userId, pushToken) {
    return this.updateUser(userId, { pushToken });
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
