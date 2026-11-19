(function () {
  const TOKEN_KEY = 'eazychat_token';
  const THEME_KEY = 'eazychat_dark';
  const QUICK_EMOJIS = ['😀','😂','🥰','😎','🤔','🙌','🔥','✨','👍','❤️','🎉','🙏','😮','😢','🤝','💯','☕','🚀','📍','📸','✅','⚡','🎵','👋'];
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

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
        const body = last.type === 'image' ? `📷 ${escapeHtml(last.text || 'Photo')}` : escapeHtml(last.text);
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

    const msgs = messagesByChat[chat.id] || [];
    const listEl = document.getElementById('messagesList');

    if (msgs.length === 0) {
      listEl.innerHTML = '<div class="my-12 mx-auto bg-sidebar/90 border border-theme text-sub text-xs px-4 py-2.5 rounded-xl text-center max-w-xs">No messages yet. Say hello to start the conversation!</div>';
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
        if (msg.text) {
          bodyHtml += `<div class="text-[13.5px] leading-snug whitespace-pre-wrap break-words">${escapeHtml(msg.text)}</div>`;
        }

        const actionsBar = `
          <div class="msg-actions flex items-center gap-0.5 bg-sidebar/95 border border-theme rounded-full px-1.5 py-0.5 shadow-sm mb-1 shrink-0">
            <button type="button" data-action="reply" data-msg-id="${msg.id}" class="p-1 text-sub hover:text-main" title="Reply">↩</button>
            <button type="button" data-action="quick-react" data-msg-id="${msg.id}" class="p-1 text-sub hover:text-main" title="React">😊</button>
            ${fromMe ? `<button type="button" data-action="delete" data-msg-id="${msg.id}" class="p-1 text-sub hover:text-rose-500" title="Delete">🗑</button>` : ''}
          </div>
        `;

        return `
          <div class="msg-row flex ${fromMe ? 'justify-end' : 'justify-start'} items-end gap-1.5">
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
    }

    if (scrollBottom) {
      const container = document.getElementById('messagesContainer');
      container.scrollTop = container.scrollHeight;
    }
  }

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

  // Event wiring
  function init() {
    applyTheme(localStorage.getItem(THEME_KEY) === '1');
    document.getElementById('emojiGrid').innerHTML = QUICK_EMOJIS.map(e => `<button type="button" data-emoji-pick="${e}" class="p-1 rounded-lg hover:bg-[var(--bg-hover)]">${e}</button>`).join('');

    window.addEventListener('resize', syncResponsivePanes);

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
        replyingTo = { id: msg.id, senderName: msg.senderName, text: msg.text || '📷 Photo' };
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
