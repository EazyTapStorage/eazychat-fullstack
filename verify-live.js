// Live Verification Script against public HTTPS & WSS deployment
const { io: ioClient } = require('socket.io-client');

const LIVE_URL = process.env.LIVE_URL || 'https://eazychat.35-192-68-101.nip.io';

async function req(endpoint, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  let body = options.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${LIVE_URL}${endpoint}`, { ...options, headers, body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function verifyLive() {
  console.log(`Starting live verification against: ${LIVE_URL}`);

  // 1. Health check
  const health = await req('/api/health');
  if (health.status !== 200 || health.data.status !== 'ok') {
    throw new Error(`Health check failed: ${JSON.stringify(health)}`);
  }
  console.log('✓ Health check passed (HTTP 200 OK)');

  // 2. Register test accounts
  const ts = Date.now();
  const userA_reg = await req('/api/auth/register', {
    method: 'POST',
    body: { name: 'Aarav Live', username: `aarav_${ts}`, password: 'password123' }
  });
  if (userA_reg.status !== 201) throw new Error(`User A registration failed: ${JSON.stringify(userA_reg)}`);
  const tokenA = userA_reg.data.token;
  const userA = userA_reg.data.user;
  console.log(`✓ User A registered: ${userA.username} (${userA.id})`);

  const userB_reg = await req('/api/auth/register', {
    method: 'POST',
    body: { name: 'Zoya Live', username: `zoya_${ts}`, password: 'password123' }
  });
  if (userB_reg.status !== 201) throw new Error(`User B registration failed: ${JSON.stringify(userB_reg)}`);
  const tokenB = userB_reg.data.token;
  const userB = userB_reg.data.user;
  console.log(`✓ User B registered: ${userB.username} (${userB.id})`);

  // 3. Create direct chat
  const chatRes = await req('/api/chats/direct', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: { userId: userB.id }
  });
  if (chatRes.status !== 201) throw new Error(`Chat creation failed: ${JSON.stringify(chatRes)}`);
  const chat = chatRes.data.chat;
  console.log(`✓ Direct chat established: ${chat.id}`);

  // 4. Connect real-time Socket.io clients over HTTPS/WSS
  console.log('Connecting real-time Socket.io clients over WSS...');
  const clientA = ioClient(LIVE_URL, {
    auth: { token: tokenA },
    transports: ['websocket', 'polling']
  });
  const clientB = ioClient(LIVE_URL, {
    auth: { token: tokenB },
    transports: ['websocket', 'polling']
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      clientA.on('connect', resolve);
      clientA.on('connect_error', reject);
    }),
    new Promise((resolve, reject) => {
      clientB.on('connect', resolve);
      clientB.on('connect_error', reject);
    })
  ]);
  console.log('✓ Both Socket.io clients connected over secure WSS');

  // 5. Verify real-time messaging
  const messageReceivedPromise = new Promise(resolve => {
    clientB.on('message:new', data => {
      resolve(data.message || data);
    });
  });

  const sentMessage = await new Promise(resolve => {
    clientA.emit('message:send', {
      chatId: chat.id,
      text: 'Hello from live verified Eazychat HTTPS/WSS deployment!'
    }, ack => {
      resolve(ack);
    });
  });

  if (!sentMessage || !sentMessage.message) {
    throw new Error('Message send acknowledgement failed');
  }
  console.log(`✓ Message sent by User A: "${sentMessage.message.text}" (status: ${sentMessage.message.status})`);

  const receivedMessage = await messageReceivedPromise;
  if (receivedMessage.id !== sentMessage.message.id) {
    throw new Error(`Message ID mismatch: got ${receivedMessage.id}, expected ${sentMessage.message.id}`);
  }
  console.log(`✓ Real-time message received by User B via WebSocket: "${receivedMessage.text}"`);

  // 6. Verify read receipt
  const readReceiptPromise = new Promise(resolve => {
    clientA.on('message:status', update => {
      if (update.status === 'read' && (update.messageIds || []).includes(sentMessage.message.id)) {
        resolve(update);
      }
    });
  });

  clientB.emit('message:read', { chatId: chat.id });
  const receipt = await readReceiptPromise;
  console.log(`✓ Read receipt (double blue check) received by User A over WSS: status=${receipt.status}`);

  // 7. Test hardening fix over live HTTPS: upload non-image rejection
  const boundary = '----WebKitFormBoundaryLiveTest123';
  const badData = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="exploit.sh"\r\nContent-Type: application/x-sh\r\n\r\necho test\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  const badRes = await fetch(`${LIVE_URL}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: badData
  });
  const badJson = await badRes.json().catch(() => ({}));
  if (badRes.status !== 400 || badJson.error !== 'Only image files are allowed') {
    throw new Error(`Hardening test failed: status=${badRes.status}, data=${JSON.stringify(badJson)}`);
  }
  console.log('✓ Hardening verified over live HTTPS: rejected non-image upload with clean HTTP 400 JSON');

  // 8. Test live voice note audio upload endpoint
  const audioBoundary = '----WebKitFormBoundaryLiveAudio456';
  const dummyWebm = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
    0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84,
    0x77, 0x65, 0x62, 0x6d, 0x42, 0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02
  ]);
  const audioData = Buffer.concat([
    Buffer.from(`--${audioBoundary}\r\nContent-Disposition: form-data; name="audio"; filename="live-voice.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
    dummyWebm,
    Buffer.from(`\r\n--${audioBoundary}--\r\n`)
  ]);
  const audioUploadRes = await fetch(`${LIVE_URL}/api/upload-audio`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': `multipart/form-data; boundary=${audioBoundary}`
    },
    body: audioData
  });
  const audioUploadJson = await audioUploadRes.json().catch(() => ({}));
  if (audioUploadRes.status !== 201 || !audioUploadJson.audioUrl) {
    throw new Error(`Live audio upload failed: status=${audioUploadRes.status}, data=${JSON.stringify(audioUploadJson)}`);
  }
  console.log(`✓ Live audio upload verified: ${audioUploadJson.audioUrl}`);

  // Verify static serving of live uploaded audio
  const fetchAudioStatic = await fetch(`${LIVE_URL}${audioUploadJson.audioUrl}`);
  if (fetchAudioStatic.status !== 200) {
    throw new Error(`Live uploaded audio static serving failed: status=${fetchAudioStatic.status}`);
  }
  console.log('✓ Live uploaded audio file accessible over HTTPS static CDN');

  // 9. Send audio note message over live WSS
  const audioReceivedPromise = new Promise(resolve => {
    clientB.on('message:new', data => {
      const m = data.message || data;
      if (m.type === 'audio') resolve(m);
    });
  });

  const sendAudioAck = await new Promise(resolve => {
    clientA.emit('message:send', {
      chatId: chat.id,
      type: 'audio',
      audioUrl: audioUploadJson.audioUrl,
      duration: 15
    }, resolve);
  });
  if (!sendAudioAck || !sendAudioAck.ok) {
    throw new Error('Live audio message send failed');
  }
  const receivedAudio = await audioReceivedPromise;
  console.log(`✓ Real-time voice note received by User B via WebSocket: duration=${receivedAudio.duration}s`);

  // 10. WebRTC signaling relay verification over live WSS
  const callIncomingPromise = new Promise(resolve => {
    clientB.on('call:incoming', resolve);
  });

  clientA.emit('call:offer', {
    chatId: chat.id,
    targetUserId: userB.id,
    offer: { type: 'offer', sdp: 'v=0\r\no=LiveA 11111 2 IN IP4 127.0.0.1...' },
    callType: 'video'
  });

  const incomingSignal = await callIncomingPromise;
  if (!incomingSignal || incomingSignal.chatId !== chat.id || incomingSignal.callerId !== userA.id) {
    throw new Error('Live WebRTC incoming call signal mismatch');
  }
  console.log(`✓ WebRTC signaling relay verified over live WSS (caller: ${incomingSignal.callerName}, type: ${incomingSignal.callType})`);

  clientA.disconnect();
  clientB.disconnect();
  console.log('\n================================================================');
  console.log('ALL LIVE HTTPS & WSS VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');
}

verifyLive().catch(err => {
  console.error('Live verification failed:', err);
  process.exit(1);
});
