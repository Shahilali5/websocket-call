import { connect, on } from './ws.js';
import { apiRequest } from './api.js';
import { showToast } from './ui.js';
import { openChat } from './chat.js';
import { startCall, acceptCallById } from './call.js';
import './dialpad.js';
import './call.js';
import './chat.js';

const $ = (id) => document.getElementById(id);

let deferredPrompt = null;
let currentAvatarData = localStorage.getItem('vc_avatar') || null;

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

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ---------------- SERVICE WORKER & PWA REGISTRATION ----------------
async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Service worker registered successfully.');
      checkPushStatus(reg);
    } catch (e) {
      console.warn('[SW] Service worker registration error:', e);
    }
  }
}

// Listen for PWA Install Prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('btnPwaInstall')?.classList.remove('d-none');
  $('pwaInstallBanner')?.classList.remove('d-none');
});

$('btnPwaInstall')?.addEventListener('click', triggerPwaInstall);
$('btnPwaBannerInstall')?.addEventListener('click', triggerPwaInstall);
$('btnPwaBannerDismiss')?.addEventListener('click', () => {
  $('pwaInstallBanner')?.classList.add('d-none');
});

async function triggerPwaInstall() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  if (choice.outcome === 'accepted') {
    showToast('VCall added to home screen!', 'success');
  }
  deferredPrompt = null;
  $('btnPwaInstall')?.classList.add('d-none');
  $('pwaInstallBanner')?.classList.add('d-none');
}

// ---------------- WEB PUSH NOTIFICATIONS ----------------
async function checkPushStatus(reg) {
  if (!('PushManager' in window) || !reg) return;
  try {
    const sub = await reg.pushManager.getSubscription();
    const badge = $('pushStatusBadge');
    if (sub) {
      if (badge) {
        badge.textContent = 'Active (Ringing Ready)';
        badge.className = 'badge bg-success-subtle text-success rounded-pill px-2 py-1';
      }
      const btn = $('btnTogglePush');
      if (btn) btn.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i> Background Ringing Active';
    } else {
      if (badge) {
        badge.textContent = 'Disabled';
        badge.className = 'badge bg-secondary-subtle text-secondary rounded-pill px-2 py-1';
      }
    }
  } catch (err) {
    console.warn('[Push] Status check failed:', err);
  }
}

async function enableWebPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return alert('Push notifications are not supported on this browser.');
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return alert('Please allow notifications in your browser permissions to receive background calls.');
    }

    const reg = await navigator.serviceWorker.ready;
    const vapidRes = await fetch('/api/push/vapid-public-key');
    const vapidData = await vapidRes.json();

    if (!vapidData || !vapidData.publicKey) {
      return alert('Push server key not configured yet.');
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidData.publicKey)
    });

    const subJson = sub.toJSON();
    await apiRequest('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: subJson.keys,
        device: navigator.userAgent
      })
    });

    showToast('Background call alerts activated!', 'success');
    checkPushStatus(reg);
  } catch (err) {
    console.error('[Push] Subscription failed:', err);
    alert('Failed to enable push notifications: ' + err.message);
  }
}

$('btnTogglePush')?.addEventListener('click', enableWebPushNotifications);

// ---------------- BOOTSTRAP USER & WEBSOCKET ----------------
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
  updateUserDisplay(number, localStorage.getItem('vc_name') || 'Guest', currentAvatarData);

  on('auth.ok', async (m) => {
    window.ME = m.number;

    // Fetch complete updated profile from server
    try {
      const meProfile = await apiRequest('/api/me');
      if (meProfile) {
        if (meProfile.name) localStorage.setItem('vc_name', meProfile.name);
        if (meProfile.avatar) {
          localStorage.setItem('vc_avatar', meProfile.avatar);
          currentAvatarData = meProfile.avatar;
        }
        updateUserDisplay(m.number, meProfile.name || 'Guest', currentAvatarData);
      }
    } catch (e) {}

    loadChats();

    // Check for auto-answer URL query parameter: ?answer=CALL_ID&from=XXXX&video=1
    const urlParams = new URLSearchParams(window.location.search);
    const answerCallId = urlParams.get('answer');
    const answerFrom = urlParams.get('from');
    const answerVideo = urlParams.get('video') === '1';

    if (answerCallId) {
      window.history.replaceState({}, '', '/');
      acceptCallById(answerCallId, answerFrom || 'Caller', answerVideo);
      return;
    }

    // Check for auto-dial URL query parameter: ?call=7384920155
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

// ---------------- USER INTERFACE & PROFILE DISPLAY ----------------
function updateUserDisplay(number, name, avatar) {
  if ($('myNumber')) $('myNumber').textContent = formatNumber(number);
  if ($('userName')) $('userName').textContent = name;
  if ($('profileNumberBadge')) $('profileNumberBadge').textContent = formatNumber(number);
  if ($('customNumberInput')) $('customNumberInput').value = number;
  if ($('customNameInput')) $('customNameInput').value = name && name !== 'Guest' ? name : '';
  if ($('settingsNameInput')) $('settingsNameInput').value = name && name !== 'Guest' ? name : '';

  // Render Header Avatar
  const userAvatarImg = $('userAvatarImg');
  const userAvatarText = $('userAvatarText');
  const avatarEl = $('userAvatar');

  if (avatar && (avatar.startsWith('data:image') || avatar.startsWith('http'))) {
    if (userAvatarImg) {
      userAvatarImg.src = avatar;
      userAvatarImg.classList.remove('d-none');
    }
    if (userAvatarText) userAvatarText.classList.add('d-none');
  } else {
    if (userAvatarText) {
      userAvatarText.textContent = avatar || (name && name !== 'Guest' ? name[0] : (number[0] || 'V')).toUpperCase();
      userAvatarText.classList.remove('d-none');
    }
    if (userAvatarImg) userAvatarImg.classList.add('d-none');
  }

  if (avatarEl && (!avatar || (!avatar.startsWith('data:image') && !avatar.startsWith('http')))) {
    avatarEl.style.background = getNumberColor(number);
  }

  // Render Settings Modal Preview
  updateSettingsPreview(name, avatar, number);

  // Update Share Modal Data
  const shareLink = `${window.location.origin}/?call=${number}`;
  if ($('shareLinkInput')) $('shareLinkInput').value = shareLink;
  if ($('shareQrImage')) {
    $('shareQrImage').src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(shareLink)}&bgcolor=ffffff&color=0f172a`;
  }
}

function updateSettingsPreview(name, avatar, number) {
  const prevImg = $('settingsAvatarPreviewImg');
  const prevText = $('settingsAvatarPreviewText');
  const prevContainer = $('settingsAvatarPreview');

  if (avatar && (avatar.startsWith('data:image') || avatar.startsWith('http'))) {
    if (prevImg) {
      prevImg.src = avatar;
      prevImg.classList.remove('d-none');
    }
    if (prevText) prevText.classList.add('d-none');
  } else {
    if (prevText) {
      prevText.textContent = avatar || (name && name !== 'Guest' ? name[0] : (number ? number[0] : 'V')).toUpperCase();
      prevText.classList.remove('d-none');
    }
    if (prevImg) prevImg.classList.add('d-none');
  }

  if (prevContainer && (!avatar || (!avatar.startsWith('data:image') && !avatar.startsWith('http')))) {
    prevContainer.style.background = getNumberColor(number || window.ME);
  }
}

// ---------------- PROFILE PHOTO & AVATAR EDITING ----------------
$('btnUploadAvatar')?.addEventListener('click', () => {
  $('avatarFileInput')?.click();
});

$('avatarFileInput')?.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    return alert('Image is too large. Please select a photo under 5MB.');
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      // Compress and resize on HTML5 canvas to keep lightweight (~20KB)
      const canvas = document.createElement('canvas');
      const size = 160;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      const minDim = Math.min(img.width, img.height);
      const sx = (img.width - minDim) / 2;
      const sy = (img.height - minDim) / 2;
      ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

      currentAvatarData = canvas.toDataURL('image/jpeg', 0.82);
      updateSettingsPreview($('settingsNameInput')?.value, currentAvatarData, window.ME);
      document.querySelectorAll('.avatar-preset-btn').forEach((b) => b.classList.remove('active'));
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
});

$('btnRemoveAvatar')?.addEventListener('click', () => {
  currentAvatarData = null;
  updateSettingsPreview($('settingsNameInput')?.value, null, window.ME);
  document.querySelectorAll('.avatar-preset-btn').forEach((b) => b.classList.remove('active'));
});

// Quick 3D Emoji Avatar Presets
document.querySelectorAll('.avatar-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.avatar-preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentAvatarData = btn.getAttribute('data-preset');
    updateSettingsPreview($('settingsNameInput')?.value, currentAvatarData, window.ME);
  });
});

// ---------------- SAVE PROFILE SETTINGS ----------------
$('saveSettingsBtn')?.addEventListener('click', async () => {
  const name = $('settingsNameInput').value.trim();
  if (!name) return alert('Please enter a display name');

  try {
    await apiRequest('/api/me', {
      method: 'PUT',
      body: JSON.stringify({
        name,
        avatar: currentAvatarData
      })
    });

    localStorage.setItem('vc_name', name);
    if (currentAvatarData) {
      localStorage.setItem('vc_avatar', currentAvatarData);
    } else {
      localStorage.removeItem('vc_avatar');
    }

    showToast('Profile updated!', 'success');
    updateUserDisplay(window.ME, name, currentAvatarData);
    bootstrap.Modal.getInstance($('settingsModal'))?.hide();
  } catch (err) {
    alert(err.message || 'Update failed');
  }
});

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

// ---------------- LOAD CHATS / CONVERSATIONS ----------------
export async function loadChats() {
  const chatsListEl = $('chatsList');
  if (!chatsListEl) return;

  try {
    const list = await apiRequest('/api/messages/conversations');
    if (!list || list.length === 0) {
      chatsListEl.innerHTML = `
        <div class="text-center text-muted py-5">
          <i class="bi bi-chat-heart fs-1 text-primary opacity-50 mb-2 d-block"></i>
          <p class="mb-1">No chats yet</p>
          <small class="text-white-50">Dial a number to start an encrypted voice, video, or text conversation.</small>
        </div>
      `;
      return;
    }

    chatsListEl.innerHTML = list
      .map((item) => {
        const time = new Date(item.last_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const avatarColor = getNumberColor(item.peer_number);
        const initial = (item.peer_number[0] || 'V').toUpperCase();

        return `
          <div class="card card-custom p-3 mb-2 cursor-pointer chat-peer-card" data-peer="${item.peer_number}">
            <div class="d-flex align-items-center justify-content-between">
              <div class="d-flex align-items-center gap-3">
                <div class="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold shadow-sm" style="width: 44px; height: 44px; background: ${avatarColor}; font-size: 1.1rem;">
                  ${initial}
                </div>
                <div>
                  <h6 class="mb-0 fw-bold font-monospace text-dark">${formatNumber(item.peer_number)}</h6>
                  <small class="text-muted d-block text-truncate" style="max-width: 190px;">
                    <i class="bi bi-shield-lock text-warning me-1"></i>${item.last_msg || 'Voice Note / Message'}
                  </small>
                </div>
              </div>
              <div class="text-end">
                <small class="text-muted d-block" style="font-size: 0.75rem;">${time}</small>
                ${item.unread_count > 0 ? `<span class="badge bg-primary rounded-pill">${item.unread_count}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    chatsListEl.querySelectorAll('.chat-peer-card').forEach((card) => {
      card.addEventListener('click', () => {
        const peer = card.getAttribute('data-peer');
        if (peer) openChat(peer);
      });
    });
  } catch (err) {
    console.error('Failed to load chats:', err);
  }
}

// ---------------- LOAD RECENTS / CALL LOGS ----------------
export async function loadRecents() {
  const recentsListEl = $('recentsList');
  if (!recentsListEl) return;

  try {
    const calls = await apiRequest('/api/calls');
    if (!calls || calls.length === 0) {
      recentsListEl.innerHTML = `
        <div class="text-center text-muted py-5">
          <i class="bi bi-telephone-x fs-1 opacity-50 mb-2 d-block"></i>
          <p class="mb-1">No call history</p>
          <small class="text-white-50">Placed and received calls will appear here.</small>
        </div>
      `;
      return;
    }

    recentsListEl.innerHTML = calls
      .map((c) => {
        const isOut = c.from_number === window.ME;
        const otherNumber = isOut ? c.to_number : c.from_number;
        const iconClass = c.is_video ? 'bi-camera-video-fill' : 'bi-telephone-fill';
        const isMissed = c.status === 'missed';
        const statusColor = isMissed ? 'text-danger' : isOut ? 'text-primary' : 'text-success';
        const durationText = c.duration_sec ? `${Math.floor(c.duration_sec / 60)}m ${c.duration_sec % 60}s` : c.status;
        const time = new Date(c.started_at || c.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

        return `
          <div class="card card-custom p-3 mb-2">
            <div class="d-flex align-items-center justify-content-between">
              <div class="d-flex align-items-center gap-3">
                <div class="rounded-circle bg-light d-flex align-items-center justify-content-center ${statusColor}" style="width: 44px; height: 44px; font-size: 1.2rem;">
                  <i class="bi ${iconClass}"></i>
                </div>
                <div>
                  <h6 class="mb-0 fw-bold font-monospace text-dark">${formatNumber(otherNumber)}</h6>
                  <small class="text-muted">
                    <i class="bi ${isOut ? 'bi-arrow-up-right' : 'bi-arrow-down-left'} me-1 ${statusColor}"></i>
                    ${durationText} &bull; ${time}
                  </small>
                </div>
              </div>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-light border rounded-circle shadow-sm btn-call-recent" data-number="${otherNumber}" data-video="0" title="Audio Call">
                  <i class="bi bi-telephone text-primary"></i>
                </button>
                <button class="btn btn-sm btn-light border rounded-circle shadow-sm btn-call-recent" data-number="${otherNumber}" data-video="1" title="Video Call">
                  <i class="bi bi-camera-video text-success"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    recentsListEl.querySelectorAll('.btn-call-recent').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const num = btn.getAttribute('data-number');
        const isVideo = btn.getAttribute('data-video') === '1';
        if (num) startCall(num, isVideo);
      });
    });
  } catch (err) {
    console.error('Failed to load recents:', err);
  }
}

// ---------------- LOAD CONTACTS ----------------
export async function loadContacts() {
  const contactsListEl = $('contactsList');
  if (!contactsListEl) return;

  try {
    const list = await apiRequest('/api/contacts');
    if (!list || list.length === 0) {
      contactsListEl.innerHTML = `
        <div class="text-center text-muted py-5">
          <i class="bi bi-people fs-1 opacity-50 mb-2 d-block"></i>
          <p class="mb-1">No contacts saved</p>
          <small class="text-white-50">Tap "+ Add Contact" above to save virtual numbers.</small>
        </div>
      `;
      return;
    }

    contactsListEl.innerHTML = list
      .map((c) => {
        const initial = (c.nickname ? c.nickname[0] : c.contact_number[0]).toUpperCase();
        const avatarColor = getNumberColor(c.contact_number);

        return `
          <div class="card card-custom p-3 mb-2">
            <div class="d-flex align-items-center justify-content-between">
              <div class="d-flex align-items-center gap-3">
                <div class="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold shadow-sm" style="width: 44px; height: 44px; background: ${avatarColor}; font-size: 1.1rem;">
                  ${initial}
                </div>
                <div>
                  <h6 class="mb-0 fw-bold text-dark">${c.nickname || 'Unknown'}</h6>
                  <small class="font-monospace text-muted">${formatNumber(c.contact_number)}</small>
                </div>
              </div>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-light border rounded-circle shadow-sm btn-contact-chat" data-number="${c.contact_number}" title="Encrypted Chat">
                  <i class="bi bi-chat-dots-fill text-warning"></i>
                </button>
                <button class="btn btn-sm btn-light border rounded-circle shadow-sm btn-contact-call" data-number="${c.contact_number}" data-video="0" title="Audio Call">
                  <i class="bi bi-telephone-fill text-primary"></i>
                </button>
                <button class="btn btn-sm btn-light border rounded-circle shadow-sm btn-contact-call" data-number="${c.contact_number}" data-video="1" title="Video Call">
                  <i class="bi bi-camera-video-fill text-success"></i>
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    contactsListEl.querySelectorAll('.btn-contact-call').forEach((btn) => {
      btn.addEventListener('click', () => {
        const num = btn.getAttribute('data-number');
        const isVideo = btn.getAttribute('data-video') === '1';
        if (num) startCall(num, isVideo);
      });
    });

    contactsListEl.querySelectorAll('.btn-contact-chat').forEach((btn) => {
      btn.addEventListener('click', () => {
        const num = btn.getAttribute('data-number');
        if (num) openChat(num);
      });
    });
  } catch (err) {
    console.error('Failed to load contacts:', err);
  }
}

// Tab navigation listeners
$('pills-chats-tab')?.addEventListener('shown.bs.tab', loadChats);
$('pills-recents-tab')?.addEventListener('shown.bs.tab', loadRecents);
$('pills-contacts-tab')?.addEventListener('shown.bs.tab', loadContacts);

// ---------------- CUSTOM VIP NUMBER MIGRATION ----------------
$('saveCustomNumberBtn')?.addEventListener('click', async () => {
  const newNumber = $('customNumberInput').value.replace(/\D/g, '').trim();
  const newName = $('customNameInput').value.trim();

  if (!/^[1-9]\d{9}$/.test(newNumber)) {
    return alert('Virtual number must be exactly 10 digits and cannot start with 0.');
  }

  try {
    const res = await apiRequest('/api/change-number', {
      method: 'POST',
      body: JSON.stringify({ newNumber, name: newName })
    });

    if (res.token && res.number) {
      localStorage.setItem('vc_token', res.token);
      localStorage.setItem('vc_number', res.number);
      if (res.name) localStorage.setItem('vc_name', res.name);
      showToast(`Custom Line ${formatNumber(res.number)} Activated!`, 'success');
    }

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
