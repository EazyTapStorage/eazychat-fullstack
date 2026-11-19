(function () {
  const TOKEN_KEY = 'eazychat_token';
  const THEME_KEY = 'eazychat_dark';
  const QUICK_EMOJIS = ['😀','😂','🥰','😎','🤔','🙌','🔥','✨','👍','❤️','🎉','🙏','😮','😢','🤝','💯','☕','🚀','📍','📸','✅','⚡','🎵','👋'];
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  let token = localStorage.getItem(TOKEN_KEY) || null;
  let currentUser = null;
  let socket = null;
  let chats = [];
  let activeChatId = null;
  let messagesByChat = {};
  let typingByChat = {}; // chatId -> userName
  let sidebarFilter = 'all';
  let sidebarQuery = '';
  let replyingTo = null;
  let mobileView = 'list';
  let infoDrawerOpen = false;
  let typingTimeout = null;
  let isCurrentlyTyping = false;
  let toastTimer = null;

  // In-chat search state
  let inChatSearchQuery = '';
  let currentSearchMatchIndex = -1;

  // Voice note recording state
  let mediaRecorder = null;
  let audioChunks = [];
  let recordStartTime = null;
  let recordTimerInterval = null;

  // 1-on-1 WebRTC Calling state
  let peerConnection = null;
  let localStream = null;
  let activeCall = null; // { type, chatId, remoteUserId, remoteUserName, remoteUserColor }
  let callDurationTimer = null;
  let callStartTime = null;
  let pendingIncomingCall = null;
  let isAudioMuted = false;
  let isVideoMuted = false;

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getInitials(name) {
    const parts = (name || '?').trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatLastSeen(iso) {
    if (!iso) return 'offline';
    const d = new Date(iso);
    return `last seen ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  function tickSvg(status) {
    if (status === 'sent') {
      return '<svg class="w-3.5 h-3.5 inline-block text-sub" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>';
    }
    const cls = status === 'read' ? 'text-[#53bdeb]' : 'text-sub';
    return `<svg class="w-4 h-3.5 inline-block ${cls}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.5 12.75l5 5 8.5-11.5M9.5 12.75l5 5 7.5-10.5"/></svg>`;
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!(options.body instanceof FormData) && options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function applyTheme(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    document.getElementById('themeIconMoon').classList.toggle('hidden', isDark);
    document.getElementById('themeIconSun').classList.toggle('hidden', !isDark);
    localStorage.setItem(THEME_KEY, isDark ? '1' : '0');
  }

  function syncResponsivePanes() {
    const isDesktop = window.innerWidth >= 768;
    const sidebar = document.getElementById('sidebarPane');
    const chatPane = document.getElementById('chatPane');
    if (isDesktop) {
      sidebar.classList.remove('hidden');
      chatPane.classList.remove('hidden');
      chatPane.classList.add('flex');
    } else if (mobileView === 'chat' && activeChatId) {
      sidebar.classList.add('hidden');
      chatPane.classList.remove('hidden');
      chatPane.classList.add('flex');
    } else {
      sidebar.classList.remove('hidden');
      chatPane.classList.add('hidden');
      chatPane.classList.remove('flex');
    }
  }

  function renderProfileHeader() {
    if (!currentUser) return;
    const avatar = document.getElementById('myAvatar');
    avatar.textContent = getInitials(currentUser.name);
    avatar.style.background = currentUser.color || '#00a884';
    document.getElementById('myProfileName').textContent = currentUser.name;
    document.getElementById('myProfileStatus').textContent = currentUser.about || 'Online';
  }

  function renderChatList() {
    const unreadTotal = chats.filter(c => c.unreadCount > 0).length;
    document.querySelectorAll('.filter-pill').forEach(btn => {
      const f = btn.dataset.filter;
      if (f === 'unread') btn.textContent = unreadTotal > 0 ? `Unread (${unreadTotal})` : 'Unread';
      btn.className = f === sidebarFilter
        ? 'filter-pill px-3 py-1 rounded-full text-xs font-semibold transition bg-[#00a884]/15 text-[#00a884]'
        : 'filter-pill px-3 py-1 rounded-full text-xs font-medium transition bg-header text-sub hover:text-main';
    });

    const q = sidebarQuery.trim().toLowerCase();
    const filtered = chats.filter(c => {
      if (sidebarFilter === 'unread' && c.unreadCount <= 0) return false;
      if (sidebarFilter === 'groups' && !c.isGroup) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });

    const listEl = document.getElementById('chatList');
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="p-8 text-center text-sm text-sub">No conversations yet. Click <strong>+</strong> to start chatting.</div>';
      return;
    }

    listEl.innerHTML = filtered.map(chat => {
      const last = chat.lastMessage;
      const isTyping = Boolean(typingByChat[chat.id]);
      let preview = '<span class="italic">No messages yet</span>';
      if (isTyping) {
        preview = `<span class="text-[#00a884] font-medium">${escapeHtml(typingByChat[chat.id])} is typing...</span>`;
      } else if (last) {
        const fromMe = last.senderId === currentUser.id;
        const tick = fromMe ? tickSvg(last.status) + ' ' : '';
        const prefix = chat.isGroup && !fromMe ? `<span class="font-medium">${escapeHtml(last.senderName.split(' ')[0])}:</span> ` : '';
        let body = escapeHtml(last.text);
        if (last.type === 'image') body = `📷 ${escapeHtml(last.text || 'Photo')}`;
        else if (last.type === 'audio') body = `🎤 Voice Note ${last.duration ? `(${last.duration}s)` : ''}`;
        preview = `${tick}${prefix}${body}`;
      }

      return `
        <button type="button" data-chat-id="${chat.id}" class="chat-item ${chat.id === activeChatId ? 'active' : ''} w-full px-3.5 py-3 flex items-center gap-3 text-left">
          <div class="w-11 h-11 rounded-full flex items-center justify-center font-semibold text-white text-sm shrink-0 relative" style="background:${chat.color}">
            ${getInitials(chat.name)}
            ${!chat.isGroup && chat.online ? '<span class="w-2.5 h-2.5 rounded-full bg-[#00a884] ring-2 ring-[var(--bg-sidebar)] absolute bottom-0 right-0"></span>' : ''}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold text-sm text-main truncate">${escapeHtml(chat.name)}</span>
              <span class="text-[11px] shrink-0 ${chat.unreadCount > 0 ? 'text-[#00a884] font-semibold' : 'text-sub'}">${last ? formatTime(last.createdAt) : ''}</span>
            </div>
            <div class="flex items-center justify-between gap-2 mt-0.5">
              <div class="text-xs text-sub truncate">${preview}</div>
              ${chat.unreadCount > 0 ? `<span class="min-w-[18px] h-[18px] px-1 rounded-full bg-[#00a884] text-white text-[10px] font-bold flex items-center justify-center shrink-0">${chat.unreadCount}</span>` : ''}
            </div>
          </div>
        </button>
      `;
    }).join('');
  }

  function renderActiveChat(scrollBottom = false) {
    const chat = chats.find(c => c.id === activeChatId);
    const emptyEl = document.getElementById('emptyChatState');
    const wrapper = document.getElementById('activeChatWrapper');

    if (!chat) {
      emptyEl.classList.remove('hidden');
      wrapper.classList.add('hidden');
      wrapper.classList.remove('flex');
      return;
    }

    emptyEl.classList.add('hidden');
    wrapper.classList.remove('hidden');
    wrapper.classList.add('flex');

    const avatarEl = document.getElementById('activeChatAvatar');
    avatarEl.style.background = chat.color;
    avatarEl.innerHTML = `${getInitials(chat.name)}${!chat.isGroup && chat.online ? '<span class="w-2.5 h-2.5 rounded-full bg-[#00a884] ring-2 ring-[var(--bg-header)] absolute bottom-0 right-0"></span>' : ''}`;
    document.getElementById('activeChatName').textContent = chat.name;

    const statusEl = document.getElementById('activeChatStatus');
    if (typingByChat[chat.id]) {
      statusEl.textContent = `${typingByChat[chat.id]} is typing...`;
      statusEl.className = 'text-xs text-[#00a884] font-medium truncate';
    } else if (chat.isGroup) {
      statusEl.textContent = chat.members.map(m => m.name).join(', ');
      statusEl.className = 'text-xs text-sub truncate';
    } else {
      statusEl.textContent = chat.online ? 'online' : formatLastSeen(chat.lastSeen);
      statusEl.className = chat.online ? 'text-xs text-[#00a884] font-medium truncate' : 'text-xs text-sub truncate';
    }

    // Direct 1-on-1 Call Buttons visibility
    const callButtons = document.getElementById('directCallButtons');
    if (!chat.isGroup) {
      callButtons.classList.remove('hidden');
      callButtons.classList.add('flex');
    } else {
      callButtons.classList.add('hidden');
      callButtons.classList.remove('flex');
    }

    const msgs = messagesByChat[chat.id] || [];
    const listEl = document.getElementById('messagesList');

    if (msgs.length === 0) {
      listEl.innerHTML = '<div class="my-12 mx-auto bg-sidebar/90 border border-theme text-sub text-xs px-4 py-2.5 rounded-xl text-center max-w-xs">No messages yet. Say hello to start the conversation!</div>';
      updateInChatSearchCounter(0);
    } else {
      let html = msgs.map(msg => {
        const fromMe = msg.senderId === currentUser.id;
        const reactions = Object.entries(msg.reactions || {}).filter(([, arr]) => arr.length > 0);
        const reactionsHtml = reactions.length > 0
          ? `<div class="flex flex-wrap gap-1 mt-1">${reactions.map(([emoji, arr]) => `<button type="button" data-action="react" data-msg-id="${msg.id}" data-emoji="${emoji}" class="text-xs bg-sidebar border border-theme rounded-full px-1.5 py-0.5 shadow-sm">${emoji} ${arr.length > 1 ? arr.length : ''}</button>`).join('')}</div>`
          : '';

        let bodyHtml = '';
        if (msg.replyTo) {
          bodyHtml += `
            <div class="border-l-4 border-[#00a884] bg-black/5 dark:bg-black/20 rounded-r-md px-2.5 py-1 mb-1.5 text-xs">
              <div class="font-semibold text-[#00a884] truncate">${escapeHtml(msg.replyTo.senderName)}</div>
              <div class="text-sub truncate">${escapeHtml(msg.replyTo.text)}</div>
            </div>
          `;
        }
        if (chat.isGroup && !fromMe) {
          bodyHtml += `<div class="text-xs font-semibold text-[#00a884] mb-0.5">${escapeHtml(msg.senderName)}</div>`;
        }
        if (msg.type === 'image' && msg.imageUrl) {
          bodyHtml += `<button type="button" data-action="lightbox" data-src="${msg.imageUrl}" class="block mb-1.5 overflow-hidden rounded-lg"><img src="${msg.imageUrl}" alt="Photo" class="max-w-full w-64 sm:w-72 h-auto rounded-lg object-cover" /></button>`;
        }
        if (msg.type === 'audio' && msg.audioUrl) {
          const durationSec = Math.round(Number(msg.duration || 0));
          const mins = Math.floor(durationSec / 60);
          const secs = durationSec % 60;
          const durationStr = durationSec > 0 ? `${mins}:${secs < 10 ? '0' : ''}${secs}` : '';
          bodyHtml += `
            <div class="audio-bubble flex flex-col gap-1.5 my-1 min-w-[210px] max-w-xs">
              <div class="flex items-center justify-between text-xs font-semibold text-[#00a884]">
                <span class="flex items-center gap-1.5">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15a3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3v6a3 3 0 003 3z"/></svg>
                  Voice Note
                </span>
                ${durationStr ? `<span class="text-[11px] font-mono text-sub">${durationStr}</span>` : ''}
              </div>
              <audio controls preload="metadata" class="w-full h-8 rounded-lg mt-0.5" src="${msg.audioUrl}"></audio>
            </div>
          `;
        }
        if (msg.text) {
          let textHtml = escapeHtml(msg.text);
          if (inChatSearchQuery) {
            const escaped = escapeHtml(inChatSearchQuery).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(${escaped})`, 'gi');
            textHtml = textHtml.replace(regex, '<mark class="chat-search-match bg-yellow-300 dark:bg-yellow-500 text-black px-0.5 rounded font-semibold transition">$1</mark>');
          }
          bodyHtml += `<div class="text-[13.5px] leading-snug whitespace-pre-wrap break-words">${textHtml}</div>`;
        }

        const actionsBar = `
          <div class="msg-actions flex items-center gap-0.5 bg-sidebar/95 border border-theme rounded-full px-1.5 py-0.5 shadow-sm mb-1 shrink-0">
            <button type="button" data-action="reply" data-msg-id="${msg.id}" class="p-1 text-sub hover:text-main" title="Reply">↩</button>
            <button type="button" data-action="quick-react" data-msg-id="${msg.id}" class="p-1 text-sub hover:text-main" title="React">😊</button>
            ${fromMe ? `<button type="button" data-action="delete" data-msg-id="${msg.id}" class="p-1 text-sub hover:text-rose-500" title="Delete">🗑</button>` : ''}
          </div>
        `;

        return `
          <div class="msg-row flex ${fromMe ? 'justify-end' : 'justify-start'} items-end gap-1.5" data-msg-row-id="${msg.id}">
            ${fromMe ? actionsBar : ''}
            <div class="max-w-[82%] sm:max-w-[70%] lg:max-w-[62%] flex flex-col ${fromMe ? 'items-end' : 'items-start'}">
              <div class="${fromMe ? 'bubble-out' : 'bubble-in'} px-3 py-2">
                ${bodyHtml}
                <div class="flex items-center justify-end gap-1 mt-1 -mb-0.5 select-none">
                  <span class="text-[10px] text-sub">${formatTime(msg.createdAt)}</span>
                  ${fromMe ? tickSvg(msg.status) : ''}
                </div>
              </div>
              ${reactionsHtml}
            </div>
            ${!fromMe ? actionsBar : ''}
          </div>
        `;
      }).join('');

      if (typingByChat[chat.id]) {
        html += `
          <div class="flex justify-start mt-1">
            <div class="bubble-in px-3.5 py-2.5 flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full bg-sub typing-dot"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-sub typing-dot"></span>
              <span class="w-1.5 h-1.5 rounded-full bg-sub typing-dot"></span>
            </div>
          </div>
        `;
      }
      listEl.innerHTML = html;

      // Update in-chat search highlights and navigation if search is active
      if (inChatSearchQuery) {
        const matches = document.querySelectorAll('.chat-search-match');
        updateInChatSearchCounter(matches.length);
        if (matches.length > 0) {
          if (currentSearchMatchIndex < 0 || currentSearchMatchIndex >= matches.length) {
            currentSearchMatchIndex = 0;
          }
          highlightCurrentMatch(matches);
        }
      }
    }

    if (scrollBottom) {
      const container = document.getElementById('messagesContainer');
      container.scrollTop = container.scrollHeight;
    }
  }

  // --- IN-CHAT SEARCH CONTROLS ---
  function updateInChatSearchCounter(totalMatches) {
    const counterEl = document.getElementById('chatSearchCounter');
    if (!counterEl) return;
    if (totalMatches === 0) {
      counterEl.textContent = '0 matches';
    } else {
      counterEl.textContent = `${currentSearchMatchIndex + 1} of ${totalMatches}`;
    }
  }

  function highlightCurrentMatch(matches) {
    matches.forEach((el, idx) => {
      if (idx === currentSearchMatchIndex) {
        el.classList.add('ring-2', 'ring-rose-500', 'bg-amber-400');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        el.classList.remove('ring-2', 'ring-rose-500', 'bg-amber-400');
      }
    });
    updateInChatSearchCounter(matches.length);
  }

  function toggleInChatSearch(forceState) {
    const bar = document.getElementById('chatSearchBar');
    const isHidden = bar.classList.contains('hidden');
    const willShow = forceState !== undefined ? forceState : isHidden;
    if (willShow) {
      bar.classList.remove('hidden');
      document.getElementById('chatSearchInput').focus();
    } else {
      bar.classList.add('hidden');
      inChatSearchQuery = '';
      currentSearchMatchIndex = -1;
      document.getElementById('chatSearchInput').value = '';
      document.getElementById('chatSearchCounter').textContent = '0 matches';
      renderActiveChat(false);
    }
  }

  function stepInChatSearch(direction) {
    const matches = document.querySelectorAll('.chat-search-match');
    if (matches.length === 0) return;
    if (direction === 'next') {
      currentSearchMatchIndex = (currentSearchMatchIndex + 1) % matches.length;
    } else {
      currentSearchMatchIndex = (currentSearchMatchIndex - 1 + matches.length) % matches.length;
    }
    highlightCurrentMatch(matches);
  }

  // --- BROWSER NOTIFICATIONS ---
  function updateNotificationIcon() {
    const isGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    const onIcon = document.getElementById('notifyIconOn');
    const offIcon = document.getElementById('notifyIconOff');
    if (onIcon && offIcon) {
      onIcon.classList.toggle('hidden', !isGranted);
      offIcon.classList.toggle('hidden', isGranted);
    }
  }

  async function requestNotificationAccess() {
    if (typeof Notification === 'undefined') {
      showToast('Notifications are not supported in this browser.');
      return;
    }
    if (Notification.permission === 'granted') {
      showToast('Browser notifications are already enabled!');
      return;
    }
    const perm = await Notification.requestPermission();
    updateNotificationIcon();
    if (perm === 'granted') {
      showToast('Notifications enabled!');
      try {
        new Notification('Eazychat', {
          body: 'Desktop notifications active for incoming messages and calls',
          icon: '/favicon.ico'
        });
      } catch (_) {}
    } else {
      showToast('Notification permission ' + perm);
    }
  }

  // --- REAL VOICE NOTE RECORDING (MediaRecorder) ---
  async function startVoiceRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Microphone access is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];

      let mimeType = '';
      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
        else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) mimeType = 'audio/ogg;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      }

      mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
      };

      recordStartTime = Date.now();
      mediaRecorder.start(250);

      document.getElementById('standardInputControls').classList.add('hidden');
      const recBar = document.getElementById('voiceRecordingBar');
      recBar.classList.remove('hidden');
      recBar.classList.add('flex');
      document.getElementById('voiceRecordTimer').textContent = '00:00';

      if (recordTimerInterval) clearInterval(recordTimerInterval);
      recordTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        document.getElementById('voiceRecordTimer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }, 500);
    } catch (err) {
      showToast('Microphone access denied: ' + err.message);
    }
  }

  function stopRecordingStream() {
    if (mediaRecorder && mediaRecorder.stream) {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    if (recordTimerInterval) clearInterval(recordTimerInterval);
    recordTimerInterval = null;
    const recBar = document.getElementById('voiceRecordingBar');
    recBar.classList.add('hidden');
    recBar.classList.remove('flex');
    document.getElementById('standardInputControls').classList.remove('hidden');
  }

  function cancelVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
    stopRecordingStream();
    audioChunks = [];
    showToast('Voice note discarded');
  }

  async function sendVoiceRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    const duration = Math.max(1, Math.round((Date.now() - recordStartTime) / 1000));

    mediaRecorder.onstop = async () => {
      try {
        const blobType = mediaRecorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunks, { type: blobType });
        if (blob.size === 0) {
          showToast('No audio captured');
          return;
        }
        const fd = new FormData();
        const ext = blobType.includes('ogg') ? 'ogg' : blobType.includes('mp4') ? 'mp4' : 'webm';
        fd.append('audio', blob, `voice-${Date.now()}.${ext}`);

        showToast('Uploading voice note...');
        const res = await api('/api/upload-audio', { method: 'POST', body: fd });
        if (socket && activeChatId) {
          socket.emit('message:send', {
            chatId: activeChatId,
            type: 'audio',
            audioUrl: res.audioUrl,
            duration,
            replyTo: replyingTo
          });
          replyingTo = null;
          document.getElementById('replyBanner').classList.add('hidden');
        }
      } catch (err) {
        showToast('Audio upload failed: ' + err.message);
      } finally {
        audioChunks = [];
      }
    };

    mediaRecorder.stop();
    stopRecordingStream();
  }

  // --- 1-ON-1 WEBRTC VOICE & VIDEO CALLING ---
  function setupActiveCallUI(statusText) {
    const modal = document.getElementById('activeCallModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    document.getElementById('callRemoteName').textContent = activeCall.remoteUserName;
    document.getElementById('callStatusText').textContent = statusText;
    const remAv = document.getElementById('callRemoteAvatar');
    remAv.textContent = getInitials(activeCall.remoteUserName);
    remAv.style.background = activeCall.remoteUserColor || '#00a884';

    const isVoice = activeCall.type === 'voice';
    const voiceDisp = document.getElementById('voiceCallDisplay');
    const remoteVid = document.getElementById('remoteVideo');
    const toggleCamBtn = document.getElementById('toggleCameraBtn');

    if (isVoice) {
      voiceDisp.classList.remove('hidden');
      voiceDisp.classList.add('flex');
      remoteVid.classList.add('hidden');
      toggleCamBtn.classList.add('hidden');
      const bigAv = document.getElementById('voiceCallBigAvatar');
      bigAv.textContent = getInitials(activeCall.remoteUserName);
      bigAv.style.background = activeCall.remoteUserColor || '#00a884';
    } else {
      voiceDisp.classList.add('hidden');
      voiceDisp.classList.remove('flex');
      remoteVid.classList.remove('hidden');
      toggleCamBtn.classList.remove('hidden');
    }

    document.getElementById('callDurationTimer').textContent = '00:00';
    isAudioMuted = false;
    isVideoMuted = false;
  }

  function onCallConnected() {
    document.getElementById('callStatusText').textContent = 'Connected';
    if (!callDurationTimer) {
      callStartTime = Date.now();
      callDurationTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        document.getElementById('callDurationTimer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      }, 1000);
    }
  }

  function endCallCleanup(toastMsg) {
    if (callDurationTimer) clearInterval(callDurationTimer);
    callDurationTimer = null;
    callStartTime = null;

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    const remoteVideoEl = document.getElementById('remoteVideo');
    if (remoteVideoEl) remoteVideoEl.srcObject = null;
    const localVideoEl = document.getElementById('localVideo');
    if (localVideoEl) localVideoEl.srcObject = null;

    document.getElementById('activeCallModal').classList.add('hidden');
    document.getElementById('activeCallModal').classList.remove('flex');
    document.getElementById('incomingCallModal').classList.add('hidden');

    pendingIncomingCall = null;
    activeCall = null;

    if (toastMsg) showToast(toastMsg);
  }

  async function initiateCall(type) {
    const chat = chats.find(c => c.id === activeChatId);
    if (!chat || chat.isGroup || !chat.otherUserId) {
      showToast('Calling is available in 1-on-1 direct conversations only.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Calling is not supported in this browser.');
      return;
    }
    try {
      activeCall = {
        type,
        chatId: chat.id,
        remoteUserId: chat.otherUserId,
        remoteUserName: chat.name,
        remoteUserColor: chat.color
      };

      const constraints = {
        audio: true,
        video: type === 'video' ? { facingMode: 'user' } : false
      };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);

      const localVideoEl = document.getElementById('localVideo');
      localVideoEl.srcObject = localStream;
      localVideoEl.classList.toggle('hidden', type !== 'video');

      setupActiveCallUI('Calling ' + chat.name + '...');

      peerConnection = new RTCPeerConnection(RTC_CONFIG);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

      peerConnection.ontrack = e => {
        const remoteVideoEl = document.getElementById('remoteVideo');
        if (e.streams && e.streams[0]) {
          remoteVideoEl.srcObject = e.streams[0];
        }
      };

      peerConnection.onicecandidate = e => {
        if (e.candidate && activeCall && socket) {
          socket.emit('call:ice-candidate', {
            chatId: activeCall.chatId,
            targetUserId: activeCall.remoteUserId,
            candidate: e.candidate
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
          onCallConnected();
        } else if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
          endCallCleanup('Call disconnected');
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      socket.emit('call:offer', {
        chatId: activeCall.chatId,
        targetUserId: activeCall.remoteUserId,
        offer,
        callType: type
      });
    } catch (err) {
      endCallCleanup('Failed to access camera/mic: ' + err.message);
    }
  }

  async function acceptIncomingCall() {
    if (!pendingIncomingCall) return;
    const call = pendingIncomingCall;
    pendingIncomingCall = null;
    document.getElementById('incomingCallModal').classList.add('hidden');

    try {
      activeCall = {
        type: call.callType,
        chatId: call.chatId,
        remoteUserId: call.callerId,
        remoteUserName: call.callerName,
        remoteUserColor: call.callerColor
      };

      const constraints = {
        audio: true,
        video: call.callType === 'video' ? { facingMode: 'user' } : false
      };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);

      const localVideoEl = document.getElementById('localVideo');
      localVideoEl.srcObject = localStream;
      localVideoEl.classList.toggle('hidden', call.callType !== 'video');

      setupActiveCallUI('Connecting...');

      peerConnection = new RTCPeerConnection(RTC_CONFIG);
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

      peerConnection.ontrack = e => {
        const remoteVideoEl = document.getElementById('remoteVideo');
        if (e.streams && e.streams[0]) {
          remoteVideoEl.srcObject = e.streams[0];
        }
      };

      peerConnection.onicecandidate = e => {
        if (e.candidate && activeCall && socket) {
          socket.emit('call:ice-candidate', {
            chatId: activeCall.chatId,
            targetUserId: activeCall.remoteUserId,
            candidate: e.candidate
          });
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
          onCallConnected();
        } else if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
          endCallCleanup('Call disconnected');
        }
      };

      await peerConnection.setRemoteDescription(new RTCSessionDescription(call.offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit('call:answer', {
        chatId: call.chatId,
        targetUserId: call.callerId,
        answer
      });
    } catch (err) {
      endCallCleanup('Failed to accept call: ' + err.message);
    }
  }

  function declineIncomingCall() {
    if (pendingIncomingCall && socket) {
      socket.emit('call:reject', {
        chatId: pendingIncomingCall.chatId,
        targetUserId: pendingIncomingCall.callerId,
        reason: 'declined'
      });
    }
    pendingIncomingCall = null;
    document.getElementById('incomingCallModal').classList.add('hidden');
  }

  function hangupActiveCall() {
    if (activeCall && socket) {
      socket.emit('call:hangup', {
        chatId: activeCall.chatId,
        targetUserId: activeCall.remoteUserId
      });
    }
    endCallCleanup('Call ended');
  }

  function toggleAudioMute() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      isAudioMuted = !isAudioMuted;
      audioTrack.enabled = !isAudioMuted;
      const btn = document.getElementById('toggleMuteBtn');
      btn.classList.toggle('bg-rose-500', isAudioMuted);
      btn.classList.toggle('bg-white/15', !isAudioMuted);
      showToast(isAudioMuted ? 'Microphone muted' : 'Microphone unmuted');
    }
  }

  function toggleVideoCamera() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      isVideoMuted = !isVideoMuted;
      videoTrack.enabled = !isVideoMuted;
      const btn = document.getElementById('toggleCameraBtn');
      btn.classList.toggle('bg-rose-500', isVideoMuted);
      btn.classList.toggle('bg-white/15', !isVideoMuted);
      showToast(isVideoMuted ? 'Camera disabled' : 'Camera enabled');
    }
  }

  // --- INFO DRAWER ---
  function renderInfoDrawer() {
    const drawer = document.getElementById('infoDrawer');
    const chat = chats.find(c => c.id === activeChatId);
    if (!infoDrawerOpen || !chat) {
      drawer.classList.add('hidden');
      drawer.classList.remove('flex');
      return;
    }
    drawer.classList.remove('hidden');
    drawer.classList.add('flex');
    document.getElementById('infoDrawerTitle').textContent = chat.isGroup ? 'Group Info' : 'Contact Info';
    const media = (messagesByChat[chat.id] || []).filter(m => m.type === 'image' && m.imageUrl);

    document.getElementById('infoDrawerBody').innerHTML = `
      <div class="flex flex-col items-center text-center pb-4 border-b border-theme">
        <div class="w-20 h-20 rounded-full flex items-center justify-center text-white text-2xl font-bold mb-3" style="background:${chat.color}">${getInitials(chat.name)}</div>
        <h4 class="font-semibold text-base text-main">${escapeHtml(chat.name)}</h4>
        <p class="text-xs text-sub mt-0.5">${chat.isGroup ? `${chat.members.length} members` : (chat.online ? 'online' : formatLastSeen(chat.lastSeen))}</p>
      </div>
      <div class="space-y-1">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-sub">${chat.isGroup ? 'Description' : 'About'}</div>
        <p class="text-sm text-main">${escapeHtml(chat.about || 'Hey there! I am using Eazychat.')}</p>
      </div>
      ${chat.isGroup ? `
        <div class="space-y-2">
          <div class="text-[11px] font-semibold uppercase tracking-wide text-sub">Participants</div>
          ${chat.members.map(m => `
            <div class="flex items-center gap-2.5 py-1">
              <div class="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold" style="background:${m.color}">${getInitials(m.name)}</div>
              <span class="text-sm text-main">${escapeHtml(m.name)} ${m.id === currentUser.id ? '(You)' : ''}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <div class="space-y-2">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-sub">Shared Media (${media.length})</div>
        ${media.length === 0 ? '<p class="text-xs text-sub italic">No photos yet.</p>' : `<div class="grid grid-cols-3 gap-1.5">${media.map(m => `<button type="button" data-action="lightbox" data-src="${m.imageUrl}" class="aspect-square rounded-lg overflow-hidden border border-theme"><img src="${m.imageUrl}" class="w-full h-full object-cover" /></button>`).join('')}</div>`}
      </div>
    `;
  }

  async function selectChat(chatId) {
    activeChatId = chatId;
    mobileView = 'chat';
    replyingTo = null;
    inChatSearchQuery = '';
    currentSearchMatchIndex = -1;
    document.getElementById('chatSearchBar').classList.add('hidden');
    document.getElementById('chatSearchInput').value = '';
    document.getElementById('chatSearchCounter').textContent = '0 matches';
    document.getElementById('replyBanner').classList.add('hidden');
    syncResponsivePanes();

    const chat = chats.find(c => c.id === chatId);
    if (chat) chat.unreadCount = 0;

    if (!messagesByChat[chatId]) {
      try {
        const data = await api(`/api/chats/${chatId}/messages`);
        messagesByChat[chatId] = data.messages || [];
      } catch (err) {
        showToast(err.message);
      }
    }

    if (socket) socket.emit('message:read', { chatId });
    renderChatList();
    renderActiveChat(true);
    renderInfoDrawer();
    document.getElementById('messageInput').focus();
  }

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });

    socket.on('chat:created', chat => {
      if (!chats.some(c => c.id === chat.id)) {
        chats.unshift(chat);
        renderChatList();
      }
    });

    socket.on('message:new', ({ chatId, message }) => {
      if (!messagesByChat[chatId]) messagesByChat[chatId] = [];
      if (!messagesByChat[chatId].some(m => m.id === message.id)) {
        messagesByChat[chatId].push(message);
      }
      const chat = chats.find(c => c.id === chatId);
      if (chat) {
        chat.lastMessage = message;
        chat.updatedAt = message.createdAt;
        if (chatId !== activeChatId && message.senderId !== currentUser.id) {
          chat.unreadCount = (chat.unreadCount || 0) + 1;
        }
        chats.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      } else {
        loadChats();
      }
      if (chatId === activeChatId && message.senderId !== currentUser.id) {
        socket.emit('message:read', { chatId });
      }
      renderChatList();
      if (chatId === activeChatId) {
        renderActiveChat(true);
        renderInfoDrawer();
      }

      // Browser Desktop Notification
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && currentUser && message.senderId !== currentUser.id) {
        if (document.hidden || activeChatId !== chatId) {
          const senderName = message.senderName || 'Someone';
          let preview = message.text;
          if (message.type === 'image') preview = '📷 Sent a photo';
          else if (message.type === 'audio') preview = '🎤 Sent a voice note';
          try {
            const notif = new Notification(chat ? chat.name : senderName, {
              body: `${senderName}: ${preview}`,
              icon: '/favicon.ico',
              tag: chatId
            });
            notif.onclick = () => {
              window.focus();
              selectChat(chatId);
            };
          } catch (_) {}
        }
      }
    });

    socket.on('message:status', ({ chatId, messageIds, status }) => {
      const msgs = messagesByChat[chatId] || [];
      msgs.forEach(m => {
        if (messageIds.includes(m.id)) m.status = status;
      });
      const chat = chats.find(c => c.id === chatId);
      if (chat && chat.lastMessage && messageIds.includes(chat.lastMessage.id)) {
        chat.lastMessage.status = status;
      }
      renderChatList();
      if (chatId === activeChatId) renderActiveChat(false);
    });

    socket.on('message:updated', ({ chatId, message }) => {
      const msgs = messagesByChat[chatId] || [];
      const idx = msgs.findIndex(m => m.id === message.id);
      if (idx >= 0) msgs[idx] = message;
      if (chatId === activeChatId) renderActiveChat(false);
    });

    socket.on('message:deleted', ({ chatId, messageId }) => {
      if (messagesByChat[chatId]) {
        messagesByChat[chatId] = messagesByChat[chatId].filter(m => m.id !== messageId);
      }
      const chat = chats.find(c => c.id === chatId);
      if (chat && messagesByChat[chatId]) {
        chat.lastMessage = messagesByChat[chatId][messagesByChat[chatId].length - 1] || null;
      }
      renderChatList();
      if (chatId === activeChatId) renderActiveChat(false);
    });

    socket.on('typing:update', ({ chatId, userName, isTyping }) => {
      if (isTyping) typingByChat[chatId] = userName;
      else delete typingByChat[chatId];
      renderChatList();
      if (chatId === activeChatId) renderActiveChat(true);
    });

    socket.on('presence:update', ({ userId, online, lastSeen }) => {
      chats.forEach(c => {
        if (!c.isGroup && c.otherUserId === userId) {
          c.online = online;
          c.lastSeen = lastSeen;
        }
      });
      renderChatList();
      if (activeChatId) renderActiveChat(false);
    });

    socket.on('user:updated', updated => {
      chats.forEach(c => {
        if (!c.isGroup && c.otherUserId === updated.id) {
          c.name = updated.name;
          c.about = updated.about;
        }
        c.members = (c.members || []).map(m => (m.id === updated.id ? updated : m));
      });
      renderChatList();
      if (activeChatId) {
        renderActiveChat(false);
        renderInfoDrawer();
      }
    });

    // WebRTC Signaling listeners
    socket.on('call:incoming', data => {
      if (peerConnection || activeCall) {
        socket.emit('call:reject', { chatId: data.chatId, targetUserId: data.callerId, reason: 'busy' });
        return;
      }
      pendingIncomingCall = data;
      document.getElementById('incomingCallerName').textContent = data.callerName;
      document.getElementById('incomingCallType').textContent = data.callType === 'video' ? 'Incoming Video Call...' : 'Incoming Voice Call...';
      const av = document.getElementById('incomingCallerAvatar');
      av.textContent = getInitials(data.callerName);
      av.style.background = data.callerColor || '#00a884';
      document.getElementById('incomingCallModal').classList.remove('hidden');

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        try {
          new Notification('Incoming Call', {
            body: `${data.callerName} is calling you on Eazychat...`,
            icon: '/favicon.ico'
          });
        } catch (_) {}
      }
    });

    socket.on('call:answered', async ({ answer }) => {
      if (peerConnection && answer) {
        try {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
          onCallConnected();
        } catch (err) {
          console.error('Failed to set remote description on answer:', err);
        }
      }
    });

    socket.on('call:ice-candidate', async ({ candidate }) => {
      if (peerConnection && candidate) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('Failed to add remote ICE candidate:', err);
        }
      }
    });

    socket.on('call:rejected', ({ reason }) => {
      showToast(reason ? `Call rejected (${reason})` : 'Call declined');
      endCallCleanup();
    });

    socket.on('call:ended', () => {
      showToast('Call ended by remote user');
      endCallCleanup();
    });
  }

  async function loadChats() {
    const data = await api('/api/chats');
    chats = data.chats || [];
    renderChatList();
    if (!activeChatId && chats.length > 0 && window.innerWidth >= 768) {
      selectChat(chats[0].id);
    }
  }

  async function enterApp() {
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    renderProfileHeader();
    updateNotificationIcon();
    syncResponsivePanes();
    connectSocket();
    await loadChats();
  }

  function showAuthScreen() {
    if (socket) socket.disconnect();
    token = null;
    currentUser = null;
    chats = [];
    activeChatId = null;
    messagesByChat = {};
    localStorage.removeItem(TOKEN_KEY);
    document.getElementById('appShell').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
  }

  async function openNewChatModal() {
    document.getElementById('newChatModal').classList.remove('hidden');
    setModalTab('direct');
    try {
      const data = await api('/api/users');
      const users = data.users || [];
      const directEl = document.getElementById('directUsersPanel');
      const groupEl = document.getElementById('groupUsersChecklist');

      if (users.length === 0) {
        directEl.innerHTML = '<p class="text-sm text-sub text-center py-6">No other users registered yet. Open another browser tab and create a second account to test live chat!</p>';
        groupEl.innerHTML = '<p class="text-xs text-sub">Register at least one more user to create a group.</p>';
        return;
      }

      directEl.innerHTML = users.map(u => `
        <button type="button" data-start-user="${u.id}" class="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--bg-hover)] text-left transition">
          <div class="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold relative shrink-0" style="background:${u.color}">
            ${getInitials(u.name)}
            ${u.online ? '<span class="w-2.5 h-2.5 rounded-full bg-[#00a884] ring-2 ring-[var(--bg-sidebar)] absolute bottom-0 right-0"></span>' : ''}
          </div>
          <div class="min-w-0">
            <div class="font-semibold text-sm text-main truncate">${escapeHtml(u.name)}</div>
            <div class="text-xs text-sub truncate">@${escapeHtml(u.username)} · ${escapeHtml(u.about)}</div>
          </div>
        </button>
      `).join('');

      groupEl.innerHTML = users.map(u => `
        <label class="flex items-center gap-2.5 p-2 rounded-lg hover:bg-[var(--bg-hover)] cursor-pointer">
          <input type="checkbox" value="${u.id}" class="accent-[#00a884] w-4 h-4" />
          <div class="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold" style="background:${u.color}">${getInitials(u.name)}</div>
          <span class="text-sm text-main">${escapeHtml(u.name)}</span>
        </label>
      `).join('');
    } catch (err) {
      showToast(err.message);
    }
  }

  function setModalTab(mode) {
    const tDirect = document.getElementById('tabDirectChat');
    const tGroup = document.getElementById('tabGroupChat');
    const pDirect = document.getElementById('directUsersPanel');
    const fGroup = document.getElementById('groupChatForm');
    if (mode === 'group') {
      tGroup.className = 'py-1.5 rounded-lg text-xs font-semibold transition bg-sidebar text-main shadow-sm';
      tDirect.className = 'py-1.5 rounded-lg text-xs font-semibold transition text-sub';
      fGroup.classList.remove('hidden');
      pDirect.classList.add('hidden');
    } else {
      tDirect.className = 'py-1.5 rounded-lg text-xs font-semibold transition bg-sidebar text-main shadow-sm';
      tGroup.className = 'py-1.5 rounded-lg text-xs font-semibold transition text-sub';
      pDirect.classList.remove('hidden');
      fGroup.classList.add('hidden');
    }
  }

  function sendCurrentMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text || !activeChatId || !socket) return;
    input.value = '';
    input.style.height = 'auto';
    socket.emit('typing:stop', { chatId: activeChatId });
    isCurrentlyTyping = false;
    socket.emit('message:send', { chatId: activeChatId, type: 'text', text, replyTo: replyingTo });
    replyingTo = null;
    document.getElementById('replyBanner').classList.add('hidden');
  }

  // --- EVENT INITIALIZATION ---
  function init() {
    applyTheme(localStorage.getItem(THEME_KEY) === '1');
    document.getElementById('emojiGrid').innerHTML = QUICK_EMOJIS.map(e => `<button type="button" data-emoji-pick="${e}" class="p-1 rounded-lg hover:bg-[var(--bg-hover)]">${e}</button>`).join('');

    window.addEventListener('resize', syncResponsivePanes);

    // Notifications
    updateNotificationIcon();
    document.getElementById('notifyToggleBtn').addEventListener('click', requestNotificationAccess);

    // Auth tabs
    const showAuthErr = msg => {
      const el = document.getElementById('authError');
      el.textContent = msg;
      el.classList.toggle('hidden', !msg);
    };
    document.getElementById('authTabLogin').addEventListener('click', () => {
      showAuthErr('');
      document.getElementById('loginForm').classList.remove('hidden');
      document.getElementById('registerForm').classList.add('hidden');
      document.getElementById('authTabLogin').className = 'py-1.5 rounded-lg text-xs font-semibold transition bg-sidebar text-main shadow-sm';
      document.getElementById('authTabRegister').className = 'py-1.5 rounded-lg text-xs font-semibold transition text-sub';
    });
    document.getElementById('authTabRegister').addEventListener('click', () => {
      showAuthErr('');
      document.getElementById('registerForm').classList.remove('hidden');
      document.getElementById('loginForm').classList.add('hidden');
      document.getElementById('authTabRegister').className = 'py-1.5 rounded-lg text-xs font-semibold transition bg-sidebar text-main shadow-sm';
      document.getElementById('authTabLogin').className = 'py-1.5 rounded-lg text-xs font-semibold transition text-sub';
    });

    document.getElementById('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      showAuthErr('');
      try {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            username: document.getElementById('loginUsername').value,
            password: document.getElementById('loginPassword').value
          })
        });
        token = data.token;
        currentUser = data.user;
        localStorage.setItem(TOKEN_KEY, token);
        await enterApp();
      } catch (err) {
        showAuthErr(err.message);
      }
    });

    document.getElementById('registerForm').addEventListener('submit', async e => {
      e.preventDefault();
      showAuthErr('');
      try {
        const data = await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            name: document.getElementById('regName').value,
            username: document.getElementById('regUsername').value,
            password: document.getElementById('regPassword').value
          })
        });
        token = data.token;
        currentUser = data.user;
        localStorage.setItem(TOKEN_KEY, token);
        await enterApp();
      } catch (err) {
        showAuthErr(err.message);
      }
    });

    // Theme & Sidebar
    document.getElementById('themeToggleBtn').addEventListener('click', () => {
      applyTheme(!document.documentElement.classList.contains('dark'));
    });
    document.getElementById('sidebarSearch').addEventListener('input', e => {
      sidebarQuery = e.target.value;
      renderChatList();
    });
    document.getElementById('filterPills').addEventListener('click', e => {
      const btn = e.target.closest('.filter-pill');
      if (!btn) return;
      sidebarFilter = btn.dataset.filter;
      renderChatList();
    });
    document.getElementById('chatList').addEventListener('click', e => {
      const item = e.target.closest('[data-chat-id]');
      if (item) selectChat(item.dataset.chatId);
    });
    document.getElementById('mobileBackBtn').addEventListener('click', () => {
      mobileView = 'list';
      infoDrawerOpen = false;
      renderInfoDrawer();
      syncResponsivePanes();
    });

    // In-Chat Search
    document.getElementById('chatSearchBtn').addEventListener('click', () => toggleInChatSearch());
    document.getElementById('closeChatSearchBtn').addEventListener('click', () => toggleInChatSearch(false));
    document.getElementById('chatSearchInput').addEventListener('input', e => {
      inChatSearchQuery = e.target.value.trim().toLowerCase();
      currentSearchMatchIndex = 0;
      renderActiveChat(false);
    });
    document.getElementById('chatSearchInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        stepInChatSearch(e.shiftKey ? 'prev' : 'next');
      }
    });
    document.getElementById('chatSearchNextBtn').addEventListener('click', () => stepInChatSearch('next'));
    document.getElementById('chatSearchPrevBtn').addEventListener('click', () => stepInChatSearch('prev'));

    // 1-on-1 WebRTC Call Buttons in header
    document.getElementById('voiceCallBtn').addEventListener('click', () => initiateCall('voice'));
    document.getElementById('videoCallBtn').addEventListener('click', () => initiateCall('video'));

    // Incoming Call Modal buttons
    document.getElementById('acceptCallBtn').addEventListener('click', acceptIncomingCall);
    document.getElementById('declineCallBtn').addEventListener('click', declineIncomingCall);

    // Active Call Overlay buttons
    document.getElementById('toggleMuteBtn').addEventListener('click', toggleAudioMute);
    document.getElementById('toggleCameraBtn').addEventListener('click', toggleVideoCamera);
    document.getElementById('endCallBtn').addEventListener('click', hangupActiveCall);

    // Voice Note Recording
    document.getElementById('recordAudioBtn').addEventListener('click', startVoiceRecording);
    document.getElementById('cancelVoiceBtn').addEventListener('click', cancelVoiceRecording);
    document.getElementById('sendVoiceBtn').addEventListener('click', sendVoiceRecording);

    // Info Drawer
    const toggleInfo = () => { infoDrawerOpen = !infoDrawerOpen; renderInfoDrawer(); };
    document.getElementById('toggleInfoDrawerBtn').addEventListener('click', toggleInfo);
    document.getElementById('headerContactBtn').addEventListener('click', toggleInfo);
    document.getElementById('closeInfoDrawerBtn').addEventListener('click', () => { infoDrawerOpen = false; renderInfoDrawer(); });
    document.getElementById('infoDrawerBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action="lightbox"]');
      if (btn) {
        document.getElementById('lightboxImg').src = btn.dataset.src;
        document.getElementById('lightboxModal').classList.remove('hidden');
      }
    });

    // Composer & Typing
    const msgInput = document.getElementById('messageInput');
    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 112) + 'px';
      if (socket && activeChatId) {
        if (!isCurrentlyTyping) {
          isCurrentlyTyping = true;
          socket.emit('typing:start', { chatId: activeChatId });
        }
        if (typingTimeout) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
          isCurrentlyTyping = false;
          socket.emit('typing:stop', { chatId: activeChatId });
        }, 1400);
      }
    });
    msgInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentMessage();
      }
    });
    document.getElementById('sendBtn').addEventListener('click', sendCurrentMessage);

    // Emoji picker
    const emojiPicker = document.getElementById('emojiPicker');
    document.getElementById('emojiBtn').addEventListener('click', () => emojiPicker.classList.toggle('hidden'));
    document.getElementById('emojiGrid').addEventListener('click', e => {
      const btn = e.target.closest('[data-emoji-pick]');
      if (!btn) return;
      msgInput.value += btn.dataset.emojiPick;
      msgInput.focus();
    });

    // Image upload
    document.getElementById('photoUploadInput').addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file || !activeChatId || !socket) return;
      try {
        const fd = new FormData();
        fd.append('image', file);
        const data = await api('/api/upload', { method: 'POST', body: fd });
        socket.emit('message:send', {
          chatId: activeChatId,
          type: 'image',
          imageUrl: data.imageUrl,
          text: '',
          replyTo: replyingTo
        });
        replyingTo = null;
        document.getElementById('replyBanner').classList.add('hidden');
      } catch (err) {
        showToast(err.message);
      }
    });

    // Message actions
    document.getElementById('messagesList').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || !activeChatId) return;
      const action = btn.dataset.action;
      if (action === 'lightbox') {
        document.getElementById('lightboxImg').src = btn.dataset.src;
        document.getElementById('lightboxModal').classList.remove('hidden');
        return;
      }
      const msgId = btn.dataset.msgId;
      const msg = (messagesByChat[activeChatId] || []).find(m => m.id === msgId);
      if (!msg) return;

      if (action === 'reply') {
        replyingTo = { id: msg.id, senderName: msg.senderName, text: msg.text || (msg.type === 'audio' ? '🎤 Voice Note' : '📷 Photo') };
        document.getElementById('replyBannerAuthor').textContent = replyingTo.senderName;
        document.getElementById('replyBannerText').textContent = replyingTo.text;
        document.getElementById('replyBanner').classList.remove('hidden');
        msgInput.focus();
      } else if (action === 'quick-react') {
        const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
        socket.emit('message:react', { chatId: activeChatId, messageId: msg.id, emoji });
      } else if (action === 'react') {
        socket.emit('message:react', { chatId: activeChatId, messageId: msg.id, emoji: btn.dataset.emoji });
      } else if (action === 'delete') {
        socket.emit('message:delete', { chatId: activeChatId, messageId: msg.id });
      }
    });

    document.getElementById('cancelReplyBtn').addEventListener('click', () => {
      replyingTo = null;
      document.getElementById('replyBanner').classList.add('hidden');
    });

    // New Chat Modal
    document.getElementById('newChatBtn').addEventListener('click', openNewChatModal);
    document.getElementById('closeNewChatModalBtn').addEventListener('click', () => document.getElementById('newChatModal').classList.add('hidden'));
    document.getElementById('tabDirectChat').addEventListener('click', () => setModalTab('direct'));
    document.getElementById('tabGroupChat').addEventListener('click', () => setModalTab('group'));

    document.getElementById('directUsersPanel').addEventListener('click', async e => {
      const btn = e.target.closest('[data-start-user]');
      if (!btn) return;
      try {
        const data = await api('/api/chats/direct', { method: 'POST', body: JSON.stringify({ userId: btn.dataset.startUser }) });
        if (!chats.some(c => c.id === data.chat.id)) chats.unshift(data.chat);
        document.getElementById('newChatModal').classList.add('hidden');
        selectChat(data.chat.id);
      } catch (err) {
        showToast(err.message);
      }
    });

    document.getElementById('groupChatForm').addEventListener('submit', async e => {
      e.preventDefault();
      const name = document.getElementById('newGroupName').value.trim();
      const memberIds = Array.from(document.querySelectorAll('#groupUsersChecklist input:checked')).map(i => i.value);
      try {
        const data = await api('/api/chats/group', { method: 'POST', body: JSON.stringify({ name, memberIds }) });
        if (!chats.some(c => c.id === data.chat.id)) chats.unshift(data.chat);
        document.getElementById('groupChatForm').reset();
        document.getElementById('newChatModal').classList.add('hidden');
        selectChat(data.chat.id);
      } catch (err) {
        showToast(err.message);
      }
    });

    // Profile Modal
    document.getElementById('openProfileBtn').addEventListener('click', () => {
      if (!currentUser) return;
      document.getElementById('profileNameInput').value = currentUser.name;
      document.getElementById('profileAboutInput').value = currentUser.about || '';
      document.getElementById('profileModal').classList.remove('hidden');
    });
    document.getElementById('closeProfileModalBtn').addEventListener('click', () => document.getElementById('profileModal').classList.add('hidden'));
    document.getElementById('profileForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const data = await api('/api/auth/me', {
          method: 'PATCH',
          body: JSON.stringify({
            name: document.getElementById('profileNameInput').value,
            about: document.getElementById('profileAboutInput').value
          })
        });
        currentUser = data.user;
        renderProfileHeader();
        document.getElementById('profileModal').classList.add('hidden');
        showToast('Profile updated');
      } catch (err) {
        showToast(err.message);
      }
    });
    document.getElementById('logoutBtn').addEventListener('click', () => {
      document.getElementById('profileModal').classList.add('hidden');
      showAuthScreen();
    });

    // Lightbox
    document.getElementById('closeLightboxBtn').addEventListener('click', () => document.getElementById('lightboxModal').classList.add('hidden'));
    document.getElementById('lightboxModal').addEventListener('click', e => {
      if (e.target.id === 'lightboxModal') document.getElementById('lightboxModal').classList.add('hidden');
    });

    // Auto-login if token exists
    if (token) {
      api('/api/auth/me')
        .then(data => {
          currentUser = data.user;
          enterApp();
        })
        .catch(() => showAuthScreen());
    }
  }

  init();
})();
