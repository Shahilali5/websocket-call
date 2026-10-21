import { connect, on } from './ws.js';
import { apiRequest } from './api.js';
import { showToast } from './ui.js';
import { openChat } from './chat.js';
import { startCall } from './call.js';
import './dialpad.js';
import './call.js';
import './chat.js';

const $ = (id) => document.getElementById(id);

export function formatNumber(num) {
  if (!num || num.length !== 10) return num || '-';
  return num.replace(/(\d{4})(\d{4})(\d{2})/, '$1 $2 $3');
}

/**
 * Generates a consistent pleasant color from virtual number
 */
function getNumberColor(num) {
  const colors = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5'];
  let sum = 0;
  for (let i = 0; i < (num || '').length; i++) sum += num.charCodeAt(i);
  return colors[sum % colors.length];
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Service worker registered successfully.');
    } catch (e) {
      console.warn('[SW] Service worker registration error:', e);
    }
  }

  // Request notifications permission
  if ('Notification' in window && Notification.permission === 'default') {
    setTimeout(() => {
      Notification.requestPermission().catch(() => {});
    }, 2000);
  }
}

async function boot() {
  await registerServiceWorker();

  let token = localStorage.getItem('vc_token');
  let number = localStorage.getItem('vc_number');

  if (!token || !number) {
    try {
      const res = await fetch('/api/identity', { method: 'POST' });
      const data = await res.json();
      if (data.token && data.number) {
        token = data.token;
        number = data.number;
        localStorage.setItem('vc_token', token);
        localStorage.setItem('vc_number', number);
      }
    } catch (e) {
      console.error('Failed to create identity:', e);
      showToast('Error generating virtual number', 'error');
      return;
    }
  }

  window.ME = number;
  updateUserDisplay(number, 'Guest');

  on('auth.ok', (m) => {
    window.ME = m.number;
    updateUserDisplay(m.number, m.name || 'Guest');
    loadChats();

    // Check for auto-dial URL query parameter: ?call=7384920155
    const urlParams = new URLSearchParams(window.location.search);
    const callTarget = urlParams.get('call');
    if (callTarget && /^[1-9]\d{9}$/.test(callTarget)) {
      const dialInput = $('dialInput');
      if (dialInput) {
        dialInput.value = callTarget;
        dialInput.dispatchEvent(new Event('input'));
        showToast(`Loaded ${formatNumber(callTarget)} from link!`, 'info');
      }
    }
  });

  on('auth.error', () => {
    localStorage.removeItem('vc_token');
    localStorage.removeItem('vc_number');
    showToast('Session refreshed. Generating fresh line...', 'info');
    setTimeout(() => location.reload(), 1000);
  });

  on('session.replaced', () => {
    alert('VCall was opened in another window with this number. This session has been paused.');
  });

  connect(token);
}

function updateUserDisplay(number, name) {
  if ($('myNumber')) $('myNumber').textContent = formatNumber(number);
  if ($('userName')) $('userName').textContent = name;
  if ($('profileNumberBadge')) $('profileNumberBadge').textContent = formatNumber(number);
  if ($('customNumberInput')) $('customNumberInput').value = number;
  if ($('customNameInput')) $('customNameInput').value = name && name !== 'Guest' ? name : '';
  if ($('settingsNameInput')) $('settingsNameInput').value = name && name !== 'Guest' ? name : '';

  // Update Share Modal Data
  const shareLink = `${window.location.origin}/?call=${number}`;
  if ($('shareLinkInput')) $('shareLinkInput').value = shareLink;
  if ($('shareQrImage')) {
    $('shareQrImage').src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareLink)}&bgcolor=ffffff&color=0f172a`;
  }

  const avatar = $('userAvatar');
  if (avatar) {
    avatar.style.background = getNumberColor(number);
    avatar.textContent = (name && name !== 'Guest' ? name[0] : (number[0] || 'V')).toUpperCase();
  }
}

// Copy number to clipboard
$('copyBtn')?.addEventListener('click', () => {
  const num = window.ME;
  if (!num) return;
  navigator.clipboard.writeText(num).then(() => {
    showToast(`Number ${formatNumber(num)} copied!`, 'success');
  });
});

// Copy shareable link
$('btnCopyShareLink')?.addEventListener('click', () => {
  const link = $('shareLinkInput')?.value;
  if (!link) return;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Call link copied to clipboard!', 'success');
  });
});

// ---------------- TAB LISTENERS ----------------
$('pills-chats-tab')?.addEventListener('click', loadChats);
$('pills-recents-tab')?.addEventListener('click', loadRecents);
$('pills-contacts-tab')?.addEventListener('click', loadContacts);

// ---------------- CHAT LIST ----------------
async function loadChats() {
  const container = $('chatList');
  if (!container) return;
  try {
    const data = await apiRequest('/api/chats');
    container.innerHTML = '';
    if (!data.chats || data.chats.length === 0) {
      container.innerHTML = '<div class="text-center text-muted py-5"><i class="bi bi-chat-square-dots fs-1 d-block mb-2 opacity-50"></i><small>No conversations yet</small></div>';
      return;
    }

    data.chats.forEach((chat) => {
      const item = document.createElement('a');
      item.href = '#';
      item.className = 'list-item-custom list-group-item-action d-flex justify-content-between align-items-center';
      item.innerHTML = `
        <div class="d-flex align-items-center gap-3">
          <div class="peer-avatar" style="background-color: ${getNumberColor(chat.peer)};">
            ${(chat.name && chat.name !== 'User' ? chat.name[0] : chat.peer[0]).toUpperCase()}
            <span class="avatar-online-dot"></span>
          </div>
          <div>
            <h6 class="mb-0 fw-bold">${chat.name || 'User'} <small class="text-muted fw-normal">(${formatNumber(chat.peer)})</small></h6>
            <small class="text-muted text-truncate d-inline-block" style="max-width:210px">${chat.lastMessage}</small>
          </div>
        </div>
        <div class="text-end">
          <small class="text-muted d-block" style="font-size:0.75rem;">${new Date(chat.lastMessageTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
          ${chat.unread > 0 ? `<span class="badge bg-primary rounded-pill mt-1">${chat.unread}</span>` : ''}
        </div>
      `;
      item.onclick = (e) => {
        e.preventDefault();
        openChat(chat.peer, chat.name);
      };
      container.appendChild(item);
    });
  } catch (e) {
    console.error('Error loading chats:', e);
  }
}

// ---------------- RECENTS LIST ----------------
async function loadRecents() {
  const container = $('recentList');
  if (!container) return;
  try {
    const data = await apiRequest('/api/calls');
    container.innerHTML = '';
    if (!data.calls || data.calls.length === 0) {
      container.innerHTML = '<div class="text-center text-muted py-5"><i class="bi bi-clock-history fs-1 d-block mb-2 opacity-50"></i><small>No call history yet</small></div>';
      return;
    }

    data.calls.forEach((c) => {
      const isOutgoing = c.from_number === window.ME;
      const peer = isOutgoing ? c.to_number : c.from_number;
      const peerName = c.other_name || 'User';

      let icon = 'bi-telephone-inbound-fill text-success';
      if (isOutgoing) icon = 'bi-telephone-outbound-fill text-primary';
      if (c.status === 'missed') icon = 'bi-telephone-x-fill text-danger';

      const item = document.createElement('div');
      item.className = 'list-item-custom d-flex justify-content-between align-items-center';
      item.innerHTML = `
        <div class="d-flex align-items-center gap-3">
          <div class="p-2 bg-light rounded-circle shadow-sm"><i class="bi ${icon} fs-5"></i></div>
          <div>
            <h6 class="mb-0 fw-bold">${peerName}</h6>
            <small class="text-muted">${formatNumber(peer)} • ${c.duration_sec ? `${c.duration_sec}s` : c.status}</small>
          </div>
        </div>
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-light text-success rounded-circle shadow-sm" title="Voice Call"><i class="bi bi-telephone-fill"></i></button>
          <button class="btn btn-sm btn-light text-primary rounded-circle shadow-sm" title="Video Call"><i class="bi bi-camera-video-fill"></i></button>
        </div>
      `;

      const buttons = item.querySelectorAll('button');
      buttons[0].onclick = () => startCall(peer, false);
      buttons[1].onclick = () => startCall(peer, true);
      container.appendChild(item);
    });
  } catch (e) {
    console.error('Error loading recents:', e);
  }
}

// ---------------- CONTACTS LIST ----------------
async function loadContacts() {
  const container = $('contactList');
  if (!container) return;
  try {
    const data = await apiRequest('/api/contacts');
    container.innerHTML = '';
    if (!data.contacts || data.contacts.length === 0) {
      container.innerHTML = '<div class="text-center text-muted py-5"><i class="bi bi-person-plus fs-1 d-block mb-2 opacity-50"></i><small>No saved contacts yet</small></div>';
      return;
    }

    data.contacts.forEach((contact) => {
      const item = document.createElement('div');
      item.className = 'list-item-custom d-flex justify-content-between align-items-center';
      item.innerHTML = `
        <div class="d-flex align-items-center gap-3">
          <div class="peer-avatar" style="background-color: ${getNumberColor(contact.contact_number)};">
            ${(contact.nickname ? contact.nickname[0] : contact.contact_number[0]).toUpperCase()}
          </div>
          <div>
            <h6 class="mb-0 fw-bold">${contact.nickname || contact.name || 'Contact'}</h6>
            <small class="text-muted">${formatNumber(contact.contact_number)}</small>
          </div>
        </div>
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-light text-secondary rounded-circle shadow-sm" title="Chat"><i class="bi bi-chat-dots-fill"></i></button>
          <button class="btn btn-sm btn-light text-success rounded-circle shadow-sm" title="Voice Call"><i class="bi bi-telephone-fill"></i></button>
          <button class="btn btn-sm btn-light text-primary rounded-circle shadow-sm" title="Video Call"><i class="bi bi-camera-video-fill"></i></button>
        </div>
      `;

      const buttons = item.querySelectorAll('button');
      buttons[0].onclick = () => openChat(contact.contact_number, contact.nickname);
      buttons[1].onclick = () => startCall(contact.contact_number, false);
      buttons[2].onclick = () => startCall(contact.contact_number, true);
      container.appendChild(item);
    });
  } catch (e) {
    console.error('Error loading contacts:', e);
  }
}

// ---------------- CUSTOM VIRTUAL NUMBER & CUSTOM NAME ----------------
$('saveCustomNumberBtn')?.addEventListener('click', async () => {
  const number = $('customNumberInput').value.replace(/\D/g, '').trim();
  const name = $('customNameInput').value.trim();

  if (!/^[1-9]\d{9}$/.test(number)) {
    return alert('Virtual number must be exactly 10 digits and cannot start with 0.');
  }

  try {
    const res = await apiRequest('/api/change-number', {
      method: 'POST',
      body: JSON.stringify({ number, name })
    });

    localStorage.setItem('vc_number', res.number);
    window.ME = res.number;
    updateUserDisplay(res.number, res.name);
    showToast('Custom VIP number activated!', 'success');

    bootstrap.Modal.getInstance($('customNumberModal'))?.hide();
    setTimeout(() => location.reload(), 500);
  } catch (err) {
    alert(err.message || 'Failed to assign custom number. It may already be registered.');
  }
});

// ---------------- 1-CLICK ROLL NEW RANDOM NUMBER ----------------
$('btnRollNewNumber')?.addEventListener('click', async () => {
  if (confirm('Roll a fresh 10-digit virtual number? Your contacts and chat partners can always reach your new line.')) {
    localStorage.removeItem('vc_token');
    localStorage.removeItem('vc_number');
    location.reload();
  }
});

// ---------------- SAVE CONTACT ----------------
$('saveContactBtn')?.addEventListener('click', async () => {
  const number = $('contactNumberInput').value.replace(/\D/g, '').trim();
  const nickname = $('contactNameInput').value.trim();

  if (!/^[1-9]\d{9}$/.test(number)) {
    return alert('Please enter a valid 10-digit number');
  }

  try {
    await apiRequest('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({ number, nickname })
    });
    showToast('Contact saved successfully!', 'success');
    bootstrap.Modal.getInstance($('addContactModal'))?.hide();
    $('contactNumberInput').value = '';
    $('contactNameInput').value = '';
    loadContacts();
  } catch (err) {
    alert(err.message || 'Failed to save contact');
  }
});

// ---------------- UPDATE PROFILE NAME ----------------
$('saveSettingsBtn')?.addEventListener('click', async () => {
  const name = $('settingsNameInput').value.trim();
  if (!name) return alert('Please enter a display name');

  try {
    await apiRequest('/api/me', {
      method: 'PUT',
      body: JSON.stringify({ name })
    });
    showToast('Profile updated!', 'success');
    updateUserDisplay(window.ME, name);
    bootstrap.Modal.getInstance($('settingsModal'))?.hide();
  } catch (err) {
    alert(err.message || 'Update failed');
  }
});

// Listen for service worker notification click messages
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'NOTIFICATION_ACTION') {
      if (event.data.action === 'accept') {
        const acceptBtn = $('btnImoAccept');
        if (acceptBtn) acceptBtn.click();
      } else if (event.data.action === 'decline') {
        const rejectBtn = $('btnImoReject');
        if (rejectBtn) rejectBtn.click();
      }
    }
  });
}

boot();
