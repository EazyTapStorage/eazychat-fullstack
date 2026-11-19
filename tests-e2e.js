// Comprehensive Automated End-to-End Test Suite for Eazychat
const http = require('http');
const path = require('path');
const fs = require('fs');

// Set test environment before requiring server modules
process.env.PORT = '4005';
process.env.JWT_SECRET = 'test-secret-key-12345';
process.env.NODE_ENV = 'test';

// Use clean isolated test data directory
const TEST_DATA_DIR = path.join(__dirname, 'test-data');
const TEST_DB = path.join(TEST_DATA_DIR, 'eazychat-db.json');
const TEST_UPLOADS = path.join(__dirname, 'test-uploads');

if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
if (fs.existsSync(TEST_UPLOADS)) fs.rmSync(TEST_UPLOADS, { recursive: true, force: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.mkdirSync(TEST_UPLOADS, { recursive: true });

// Clean data directory before starting test
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'eazychat-db.json');
if (fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], chats: [], messages: [] }, null, 2), 'utf8');
}

const express = require('express');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');

async function request(url, options = {}) {
  const fullUrl = `http://localhost:${process.env.PORT}${url}`;
  const headers = Object.assign({}, options.headers || {});
  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(fullUrl, { ...options, headers, body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

let passed = 0;
let failed = 0;

function assert(condition, testName, detail = '') {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${testName}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${testName} ${detail ? '--> ' + detail : ''}`);
  }
}

async function runTests() {
  console.log('================================================================================');
  console.log('      EAZYCHAT FULL-STACK VALIDATION & AUTOMATED AUDIT SUITE                   ');
  console.log('================================================================================\n');

  // Start the server
  require('./server/index');
  // Wait 600ms for server listen
  await new Promise(r => setTimeout(r, 600));

  console.log('--- 1. HEALTH & CONNECTIVITY AUDIT ---');
  const health = await request('/api/health');
  assert(health.status === 200, 'Health endpoint returns HTTP 200');
  assert(health.data.status === 'ok' && health.data.app === 'Eazychat', 'Health payload valid');

  console.log('\n--- 2. AUTHENTICATION & SECURITY VALIDATION ---');
  // Rejection of invalid username (too short)
  const regShortUser = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Test', username: 'ab', password: 'password123' }
  });
  assert(regShortUser.status === 400, 'Rejects short username (< 3 chars)');

  // Rejection of short password
  const regShortPass = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Test', username: 'testuser', password: '123' }
  });
  assert(regShortPass.status === 400, 'Rejects short password (< 6 chars)');

  // Valid registration User A (Aarav)
  const regA = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Aarav Mehta', username: 'aarav', password: 'password123' }
  });
  assert(regA.status === 201, 'User A registered successfully (HTTP 201)');
  assert(Boolean(regA.data.token), 'User A received JWT bearer token');
  assert(regA.data.user.username === 'aarav', 'User A profile contains normalized username');
  assert(!regA.data.user.passwordHash, 'User A passwordHash is NEVER leaked in API response');
  const tokenA = regA.data.token;
  const userA = regA.data.user;

  // Duplicate registration rejection
  const regDup = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Aarav Duplicate', username: 'AARAV', password: 'password123' }
  });
  assert(regDup.status === 409, 'Rejects duplicate case-insensitive username with HTTP 409');

  // Valid registration User B (Priya)
  const regB = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Priya Sharma', username: 'priya', password: 'password123' }
  });
  assert(regB.status === 201, 'User B registered successfully (HTTP 201)');
  const tokenB = regB.data.token;
  const userB = regB.data.user;

  // Login verification
  const loginFailPass = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'aarav', password: 'wrongpassword' }
  });
  assert(loginFailPass.status === 401, 'Rejects incorrect password with HTTP 401');

  const loginFailUser = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'nonexistent', password: 'password123' }
  });
  assert(loginFailUser.status === 401, 'Rejects non-existent username with HTTP 401');

  const loginOk = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'AARAV', password: 'password123' }
  });
  assert(loginOk.status === 200, 'Login succeeds with case-insensitive username');
  assert(Boolean(loginOk.data.token), 'Login returns valid JWT session token');

  // Auth Middleware Protection
  const noAuth = await request('/api/auth/me');
  assert(noAuth.status === 401, 'Protected route /api/auth/me blocks unauthenticated requests');

  const fakeAuth = await request('/api/auth/me', {
    headers: { Authorization: 'Bearer invalid.tampered.token' }
  });
  assert(fakeAuth.status === 401, 'Protected route blocks tampered JWT tokens');

  const meA = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${tokenA}` }
  });
  assert(meA.status === 200 && meA.data.user.id === userA.id, '/api/auth/me returns current user');

  // Profile Update
  const updateProfile = await request('/api/auth/me', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: { name: 'Aarav M. (Founder)', about: 'Building EazyAI!' }
  });
  assert(updateProfile.status === 200, 'Profile update succeeds');
  assert(updateProfile.data.user.name === 'Aarav M. (Founder)', 'Profile name updated');
  assert(updateProfile.data.user.about === 'Building EazyAI!', 'Profile about updated');

  console.log('\n--- 3. USER DISCOVERY & CHAT CREATION AUDIT ---');
  const userList = await request('/api/users', {
    headers: { Authorization: `Bearer ${tokenA}` }
  });
  assert(userList.status === 200, 'GET /api/users returns HTTP 200');
  assert(userList.data.users.some(u => u.id === userB.id), 'Other users visible in discovery list');
  assert(!userList.data.users.some(u => u.id === userA.id), 'Self is excluded from discovery list');

  // Create Direct 1-on-1 Chat
  const directChat1 = await request('/api/chats/direct', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: { userId: userB.id }
  });
  assert(directChat1.status === 201, 'Creates 1-on-1 direct conversation');
  assert(directChat1.data.chat.isGroup === false, 'Direct chat isGroup flag is false');
  assert(directChat1.data.chat.otherUserId === userB.id, 'Identifies other user in direct chat');
  const chatId = directChat1.data.chat.id;

  // Direct Chat Idempotency: Second request returns existing chat
  const directChat2 = await request('/api/chats/direct', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}` },
    body: { userId: userA.id }
  });
  assert(directChat2.data.chat.id === chatId, 'Direct chat creation is idempotent (reuses same chat)');

  // Create Group Chat
  const groupChat = await request('/api/chats/group', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: { name: 'Founders Council', memberIds: [userB.id] }
  });
  assert(groupChat.status === 201, 'Group conversation created successfully');
  assert(groupChat.data.chat.isGroup === true, 'Group chat isGroup flag is true');
  assert(groupChat.data.chat.members.length === 2, 'Group chat has all selected members');

  // Chat Isolation: Non-member cannot read chat messages
  const regC = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'Third Party', username: 'outsider', password: 'password123' }
  });
  const tokenC = regC.data.token;
  const unauthorizedMessages = await request(`/api/chats/${chatId}/messages`, {
    headers: { Authorization: `Bearer ${tokenC}` }
  });
  assert(unauthorizedMessages.status === 404, 'Non-member blocked from fetching chat messages (HTTP 404)');

  console.log('\n--- 4. REAL-TIME SOCKET.IO ENGINE AUDIT ---');
  const socketUrl = `http://localhost:${process.env.PORT}`;

  // Socket Auth Rejection
  const unauthSocket = ioClient(socketUrl, {
    transports: ['websocket'],
    auth: { token: 'invalid-token' },
    autoConnect: true
  });
  const unauthRejected = await new Promise(resolve => {
    unauthSocket.on('connect_error', err => {
      resolve(err.message === 'Invalid token' || err.message === 'Authentication required');
    });
  });
  assert(unauthRejected, 'Socket.io connection rejects unauthenticated/invalid tokens');
  unauthSocket.disconnect();

  // Connect Client A and Client B
  const clientA = ioClient(socketUrl, { transports: ['websocket'], auth: { token: tokenA } });
  const clientB = ioClient(socketUrl, { transports: ['websocket'], auth: { token: tokenB } });

  await Promise.all([
    new Promise(r => clientA.on('connect', r)),
    new Promise(r => clientB.on('connect', r)),
  ]);
  assert(clientA.connected && clientB.connected, 'Both clients connected via WebSockets');

  // Verify Real-Time Message Send & Delivery Status
  let receivedMsgB = null;
  clientB.on('message:new', ({ chatId: cid, message }) => {
    if (cid === chatId) receivedMsgB = message;
  });

  const sendAck = await new Promise(resolve => {
    clientA.emit('message:send', {
      chatId,
      type: 'text',
      text: 'Hello Priya! Real-time Socket.io delivery test.'
    }, resolve);
  });

  assert(sendAck.ok === true, 'Message send acknowledged by server');
  assert(sendAck.message.status === 'delivered', 'Message status automatically set to "delivered" because recipient is online');

  // Wait 100ms for websocket delivery to Client B
  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(receivedMsgB), 'Recipient Client B received real-time "message:new" event');
  assert(receivedMsgB.text === 'Hello Priya! Real-time Socket.io delivery test.', 'Delivered message text matches exact content');
  const sentMsgId = sendAck.message.id;

  // Real-Time Read Receipt Verification
  let statusUpdateReceived = null;
  clientA.on('message:status', update => {
    statusUpdateReceived = update;
  });

  clientB.emit('message:read', { chatId });
  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(statusUpdateReceived), 'Sender received real-time "message:status" read receipt');
  assert(statusUpdateReceived.status === 'read', 'Read receipt status transitioned to "read" (double blue check)');
  assert(statusUpdateReceived.messageIds.includes(sentMsgId), 'Read receipt confirms specific message ID');

  // Real-Time Typing Indicator
  let typingEvent = null;
  clientB.on('typing:update', evt => {
    typingEvent = evt;
  });

  clientA.emit('typing:start', { chatId });
  await new Promise(r => setTimeout(r, 100));
  assert(typingEvent && typingEvent.isTyping === true, 'Client B received real-time "typing:start" indicator');

  clientA.emit('typing:stop', { chatId });
  await new Promise(r => setTimeout(r, 100));
  assert(typingEvent && typingEvent.isTyping === false, 'Client B received real-time "typing:stop" indicator');

  // Emoji Reactions
  let reactionUpdate = null;
  clientA.on('message:updated', evt => {
    reactionUpdate = evt;
  });

  clientB.emit('message:react', { chatId, messageId: sentMsgId, emoji: '🔥' });
  await new Promise(r => setTimeout(r, 100));
  assert(reactionUpdate && reactionUpdate.message.reactions['🔥'].includes(userB.id), 'Emoji reaction added and broadcast to all members');

  // Toggle Reaction off
  clientB.emit('message:react', { chatId, messageId: sentMsgId, emoji: '🔥' });
  await new Promise(r => setTimeout(r, 100));
  assert(!reactionUpdate.message.reactions['🔥'], 'Toggling emoji reaction removes it cleanly');

  // Message Deletion Protection & Broadcast
  let deleteEvent = null;
  clientB.on('message:deleted', evt => {
    deleteEvent = evt;
  });

  // Client B attempts to delete Client A's message (MUST BE BLOCKED)
  clientB.emit('message:delete', { chatId, messageId: sentMsgId });
  await new Promise(r => setTimeout(r, 100));
  assert(deleteEvent === null, 'Non-author CANNOT delete another user message');

  // Client A (author) deletes message
  clientA.emit('message:delete', { chatId, messageId: sentMsgId });
  await new Promise(r => setTimeout(r, 100));
  assert(deleteEvent && deleteEvent.messageId === sentMsgId, 'Author deletes message and real-time deletion is broadcast');

  // Clean disconnect
  clientA.disconnect();
  clientB.disconnect();

  console.log('\n--- 5. FILE UPLOAD & MEDIA VALIDATION ---');
  // Upload valid image
  const dummyPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ]);

  const boundary = '----WebKitFormBoundaryTest123';
  const postData = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`),
    dummyPng,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const uploadRes = await request('/api/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: postData
  });
  assert(uploadRes.status === 201, 'Image upload succeeds with HTTP 201');
  assert(uploadRes.data.imageUrl && uploadRes.data.imageUrl.startsWith('/uploads/'), 'Image URL returned in uploads namespace');

  // Verify uploaded image static serving
  const fetchImg = await fetch(`http://localhost:${process.env.PORT}${uploadRes.data.imageUrl}`);
  assert(fetchImg.status === 200, 'Uploaded image is publicly accessible via static route');

  // Reject non-image upload with clean HTTP 400 JSON
  const badData = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="script.sh"\r\nContent-Type: application/x-sh\r\n\r\necho exploit\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  const badUpload = await request('/api/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: badData
  });
  assert(badUpload.status === 400, 'Non-image file extensions & mimetypes rejected with HTTP 400');
  assert(badUpload.data && badUpload.data.error === 'Only image files are allowed', 'Returns clean JSON error for invalid file type');

  // Reject oversized file (> 5 MB) with clean HTTP 400 JSON
  const largePayload = Buffer.alloc(5.5 * 1024 * 1024, 'a');
  const oversizedData = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n`),
    largePayload,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const oversizedUpload = await request('/api/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: oversizedData
  });
  assert(oversizedUpload.status === 400, 'Oversized file (> 5 MB) rejected with HTTP 400');
  assert(oversizedUpload.data && oversizedUpload.data.error === 'File size exceeds 5 MB limit.', 'Returns clean JSON error for oversized file');

  console.log('\n--- 6. AUDIO VOICE NOTES & RECORDING AUDIT ---');
  // Upload valid audio note (dummy webm/opus audio payload)
  const dummyWebm = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
    0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84,
    0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02
  ]);

  const audioBoundary = '----WebKitFormBoundaryAudio456';
  const audioPostData = Buffer.concat([
    Buffer.from(`--${audioBoundary}\r\nContent-Disposition: form-data; name="audio"; filename="voice-note.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    dummyWebm,
    Buffer.from(`\r\n--${audioBoundary}--\r\n`)
  ]);

  const uploadAudioRes = await request('/api/upload-audio', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${audioBoundary}`
    },
    body: audioPostData
  });
  assert(uploadAudioRes.status === 201, 'Voice note upload succeeds with HTTP 201');
  assert(uploadAudioRes.data.audioUrl && uploadAudioRes.data.audioUrl.startsWith('/uploads/'), 'Audio URL returned under /uploads/ namespace');

  // Verify uploaded audio static route
  const fetchAudio = await fetch(`http://localhost:${process.env.PORT}${uploadAudioRes.data.audioUrl}`);
  assert(fetchAudio.status === 200, 'Uploaded audio file is publicly accessible via static route');

  // Reject non-audio upload to /api/upload-audio
  const badAudioData = Buffer.concat([
    Buffer.from(`--${audioBoundary}\r\nContent-Disposition: form-data; name="audio"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\r\n`),
    Buffer.from(`\r\n--${audioBoundary}--\r\n`)
  ]);
  const badAudioUpload = await request('/api/upload-audio', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${audioBoundary}`
    },
    body: badAudioData
  });
  assert(badAudioUpload.status === 400, 'Non-audio file rejected by /api/upload-audio with HTTP 400');
  assert(badAudioUpload.data && badAudioUpload.data.error === 'Only audio files are allowed.', 'Clean JSON error returned for non-audio file');

  // Reject oversized audio file (> 10 MB)
  const largeAudioPayload = Buffer.alloc(10.5 * 1024 * 1024, '0');
  const oversizedAudioData = Buffer.concat([
    Buffer.from(`--${audioBoundary}\r\nContent-Disposition: form-data; name="audio"; filename="large-voice.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    largeAudioPayload,
    Buffer.from(`\r\n--${audioBoundary}--\r\n`)
  ]);
  const oversizedAudioUpload = await request('/api/upload-audio', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${audioBoundary}`
    },
    body: oversizedAudioData
  });
  assert(oversizedAudioUpload.status === 400, 'Oversized audio file (> 10 MB) rejected with HTTP 400');
  assert(oversizedAudioUpload.data && oversizedAudioUpload.data.error === 'Audio file size exceeds 10 MB limit.', 'Clean JSON error for oversized audio file');

  // Re-connect sockets to verify audio message and WebRTC signaling
  const sockClientA = ioClient(socketUrl, { transports: ['websocket'], auth: { token: tokenA } });
  const sockClientB = ioClient(socketUrl, { transports: ['websocket'], auth: { token: tokenB } });

  await Promise.all([
    new Promise(r => sockClientA.on('connect', r)),
    new Promise(r => sockClientB.on('connect', r)),
  ]);

  let audioMsgReceived = null;
  sockClientB.on('message:new', ({ chatId: cid, message }) => {
    if (cid === chatId && message.type === 'audio') audioMsgReceived = message;
  });

  const sendAudioAck = await new Promise(resolve => {
    sockClientA.emit('message:send', {
      chatId,
      type: 'audio',
      audioUrl: uploadAudioRes.data.audioUrl,
      duration: 12
    }, resolve);
  });

  assert(sendAudioAck.ok === true, 'Audio voice message acknowledged by server');
  assert(sendAudioAck.message.type === 'audio', 'Message type is audio');
  assert(sendAudioAck.message.duration === 12, 'Audio message records duration in seconds');

  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(audioMsgReceived), 'Client B received real-time audio voice note message');
  assert(audioMsgReceived.audioUrl === uploadAudioRes.data.audioUrl, 'Audio URL matches uploaded voice file');

  console.log('\n--- 7. 1-ON-1 WEBRTC SIGNALING RELAY AUDIT ---');
  let incomingCallData = null;
  sockClientB.on('call:incoming', data => {
    incomingCallData = data;
  });

  // Client A calls Client B
  sockClientA.emit('call:offer', {
    chatId,
    targetUserId: userB.id,
    offer: { type: 'offer', sdp: 'v=0\r\no=ClientA 12345 2 IN IP4 127.0.0.1...' },
    callType: 'video'
  });

  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(incomingCallData), 'Client B received call:incoming signaling event');
  assert(incomingCallData.chatId === chatId, 'Incoming call matches active chatId');
  assert(incomingCallData.callerId === userA.id, 'Incoming call identifies caller User A');
  assert(incomingCallData.callType === 'video', 'Incoming call specifies callType video');
  assert(incomingCallData.offer.type === 'offer', 'Incoming call forwards complete SDP offer');

  // Client B answers Client A
  let answeredCallData = null;
  sockClientA.on('call:answered', data => {
    answeredCallData = data;
  });

  sockClientB.emit('call:answer', {
    chatId,
    targetUserId: userA.id,
    answer: { type: 'answer', sdp: 'v=0\r\no=ClientB 67890 2 IN IP4 127.0.0.1...' }
  });

  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(answeredCallData), 'Client A received call:answered signaling event');
  assert(answeredCallData.userId === userB.id, 'Answer confirms recipient User B');
  assert(answeredCallData.answer.type === 'answer', 'Answer contains complete SDP answer');

  // ICE Candidate relay
  let iceCandidateReceived = null;
  sockClientB.on('call:ice-candidate', data => {
    iceCandidateReceived = data;
  });

  sockClientA.emit('call:ice-candidate', {
    chatId,
    targetUserId: userB.id,
    candidate: { candidate: 'candidate:dummy1234 1 udp 2122260223 127.0.0.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
  });

  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(iceCandidateReceived), 'Client B received call:ice-candidate relay');
  assert(iceCandidateReceived.candidate.sdpMid === '0', 'ICE candidate payload intact');

  // Call Hangup / Termination
  let callEndedReceived = null;
  sockClientA.on('call:ended', data => {
    callEndedReceived = data;
  });

  sockClientB.emit('call:hangup', {
    chatId,
    targetUserId: userA.id
  });

  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(callEndedReceived), 'Client A received call:ended event when Client B hangs up');

  // Call Reject to offline or invalid user
  let callRejectReceived = null;
  sockClientA.on('call:rejected', data => {
    callRejectReceived = data;
  });

  // Call to non-existent / offline user
  sockClientA.emit('call:offer', {
    chatId,
    targetUserId: 'offline-user-999',
    offer: { type: 'offer', sdp: 'test' },
    callType: 'voice'
  });

  await new Promise(r => setTimeout(r, 100));
  assert(Boolean(callRejectReceived), 'Client A receives call:rejected when calling invalid/offline user');

  sockClientA.disconnect();
  sockClientB.disconnect();

  console.log('\n================================================================================');
  console.log(`AUDIT RESULTS: ${passed} PASSED | ${failed} FAILED | TOTAL: ${passed + failed}`);
  console.log('================================================================================\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
