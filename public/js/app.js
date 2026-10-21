import { connect, on, send } from './ws.js';
import { apiRequest } from './api.js';
import { showToast, playRingtone, stopRingtone, playCallEndSound } from './ui.js';
import { startCall, acceptCallById, endCall } from './call.js';
import './dialpad.js';
import './call.js';
import './chat.js';

const $ = (id) => document.getElementById(id);

let currentAvatarData = localStorage.getItem('vc_avatar') || null;
let currentChatPeer = null;

export function formatNumber(num) {
  if (!num || num.length !== 10) return num || '-';
  return num.replace(/(\d{4})(\d{4})(\d{2})/, '$1 $2 $3');
}

function updateClock() {
  const clock = $('statusBarClock');
  if (clock) {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
}
setInterval(updateClock, 1000);
updateClock();

// ---------------- USER INTERFACE & PROFILE ----------------
function updateUserDisplay(number, name, avatar) {
  if ($('profileNumberBadge')) $('profileNumberBadge').textContent = formatNumber(number);
  if ($('settingsNameInput')) $('settingsNameInput').value = name && name !== 'Guest' ? name : '';

  // Header Avatar
  const headerImg = $('headerAvatarImg');
  const headerText = $('headerAvatarText');
  if (avatar && (avatar.startsWith('data:image') || avatar.startsWith('http'))) {
    if (headerImg) {
      headerImg.src = avatar;
      headerImg.classList.remove('d-none');
    }
    if (headerText) headerText.classList.add('d-none');
  } else {
    if (headerText) {
      headerText.textContent = avatar || (name && name !== 'Guest' ? name[0] : (number[0] || 'V')).toUpperCase();
      headerText.classList.remove('d-none');
    }
    if (headerImg) headerImg.classList.add('d-none');
  }

  // Settings Modal Preview
  updateSettingsPreview(name, avatar, number);
}

function updateSettingsPreview(name, avatar, number) {
  const prevImg = $('settingsAvatarPreviewImg');
  const prevText = $('settingsAvatarPreviewText');

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
}

// ---------------- PROFILE PHOTO & PRESETS ----------------
$('btnUploadAvatar')?.addEventListener('click', () => {
  $('avatarFileInput')?.click();
});

$('avatarFileInput')?.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 160;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const minDim = Math.min(img.width, img.height);
      const sx = (img.width - minDim) / 2;
      const sy = (img.height - minDim) / 2;
      ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

      currentAvatarData = canvas.toDataURL('image/jpeg', 0.85);
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

document.querySelectorAll('.avatar-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.avatar-preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentAvatarData = btn.getAttribute('data-preset');
    updateSettingsPreview($('settingsNameInput')?.value, currentAvatarData, window.ME);
  });
});

$('saveSettingsBtn')?.addEventListener('click', async () => {
  const name = $('settingsNameInput').value.trim();
  if (!name) return alert('Please enter a display name');

  try {
    await apiRequest('/api/me', {
      method: 'PUT',
      body: JSON.stringify({ name, avatar: currentAvatarData })
    });
    localStorage.setItem('vc_name', name);
    if (currentAvatarData) localStorage.setItem('vc_avatar', currentAvatarData);
    else localStorage.removeItem('vc_avatar');

    showToast('Profile updated!', 'success');
    updateUserDisplay(window.ME, name, currentAvatarData);
    bootstrap.Modal.getInstance($('settingsModal'))?.hide();
  } catch (err) {
    alert(err.message || 'Update failed');
  }
});

// ---------------- NAVIGATION TABS ----------------
const navButtons = [$('tabBtnHome'), $('tabBtnChats'), $('tabBtnContacts'), $('tabBtnSettings')];

function setActiveTab(btn) {
  navButtons.forEach((b) => b?.classList.remove('active'));
  btn?.classList.add('active');
}

$('tabBtnHome')?.addEventListener('click', () => {
  setActiveTab($('tabBtnHome'));
  $('viewChatScreen')?.classList.add('d-none');
  $('viewHomeDashboard')?.classList.remove('d-none');
});

$('tabBtnChats')?.addEventListener('click', () => {
  setActiveTab($('tabBtnChats'));
  // Open most recent chat or open chat screen
  openChatScreen('9876543210', 'Riya 💙');
});

$('tabBtnContacts')?.addEventListener('click', () => {
  setActiveTab($('tabBtnContacts'));
  bootstrap.Modal.getOrCreateInstance($('addContactModal')).show();
});

$('tabBtnSettings')?.addEventListener('click', () => {
  setActiveTab($('tabBtnSettings'));
  bootstrap.Modal.getOrCreateInstance($('settingsModal')).show();
});

$('headerUserAvatar')?.addEventListener('click', () => {
  bootstrap.Modal.getOrCreateInstance($('settingsModal')).show();
});

// ---------------- BENTO QUICK ACTIONS ----------------
$('btnBentoVideoCall')?.addEventListener('click', () => {
  bootstrap.Modal.getOrCreateInstance($('dialpadModal')).show();
});

$('btnBentoVoiceCall')?.addEventListener('click', () => {
  bootstrap.Modal.getOrCreateInstance($('dialpadModal')).show();
});

$('btnBentoGroupCall')?.addEventListener('click', () => {
  openChatScreen('9998887777', 'Gaming Squad', true);
});

$('btnBentoAddContact')?.addEventListener('click', () => {
  bootstrap.Modal.getOrCreateInstance($('addContactModal')).show();
});

// ---------------- RECENT CALLS LIST CLICK HANDLERS ----------------
document.querySelectorAll('.call-item-row').forEach((row) => {
  const number = row.getAttribute('data-number');
  const name = row.getAttribute('data-name');

  row.querySelector('.call-item-left')?.addEventListener('click', () => {
    openChatScreen(number, name);
  });

  const btnAction = row.querySelector('.call-btn-action');
  btnAction?.addEventListener('click', (e) => {
    e.stopPropagation();
    const type = btnAction.getAttribute('data-call-type');
    if (type === 'video') {
      startCall(number, true);
    } else {
      startCall(number, false);
    }
  });
});

// ---------------- FLOATING DIALPAD BUTTON ----------------
$('fabOpenDialpad')?.addEventListener('click', () => {
  bootstrap.Modal.getOrCreateInstance($('dialpadModal')).show();
});

// ---------------- DIALPAD MODAL KEYPAD LOGIC ----------------
document.querySelectorAll('.dial-key').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-key');
    const display = $('dialNumberDisplay');
    if (!display) return;

    if (key === '#') {
      display.value = display.value.slice(0, -1);
    } else {
      if (display.value.length < 10) display.value += key;
    }
    display.dispatchEvent(new Event('input'));
  });
});

$('dialNumberDisplay')?.addEventListener('input', async (e) => {
  const val = e.target.value.replace(/\D/g, '');
  e.target.value = val;
  const statusBadge = $('dialPeerStatusBadge');

  if (val.length === 10) {
    statusBadge.textContent = 'Checking user...';
    try {
      const res = await apiRequest(`/lookup/${val}`);
      if (res && res.exists) {
        statusBadge.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill me-1"></i>${res.name || 'User'} (${res.status})</span>`;
      } else {
        statusBadge.innerHTML = `<span class="text-warning"><i class="bi bi-info-circle me-1"></i>Unregistered (Can invite via link)</span>`;
      }
    } catch {
      statusBadge.textContent = 'Peer reachable';
    }
  } else {
    statusBadge.textContent = `${10 - val.length} digits remaining`;
  }
});

$('btnModalStartVoice')?.addEventListener('click', () => {
  const num = $('dialNumberDisplay')?.value.trim();
  if (num.length !== 10) return alert('Please enter a 10-digit virtual number');
  bootstrap.Modal.getInstance($('dialpadModal'))?.hide();
  startCall(num, false);
});

$('btnModalStartVideo')?.addEventListener('click', () => {
  const num = $('dialNumberDisplay')?.value.trim();
  if (num.length !== 10) return alert('Please enter a 10-digit virtual number');
  bootstrap.Modal.getInstance($('dialpadModal'))?.hide();
  startCall(num, true);
});

// ---------------- CHAT SCREEN FUNCTIONS ----------------
export function openChatScreen(peerNumber, peerName, isGroup = false) {
  currentChatPeer = peerNumber;
  $('viewHomeDashboard')?.classList.add('d-none');
  const chatView = $('viewChatScreen');
  chatView?.classList.remove('d-none');

  $('chatHeaderName').textContent = peerName || formatNumber(peerNumber);
  $('chatHeaderStatus').textContent = isGroup ? '5 members &bull; 🟢 Online 3' : 'online';
  $('chatHeaderAvatarText').textContent = (peerName ? peerName[0] : 'U').toUpperCase();

  const banner = $('chatPinnedBanner');
  if (isGroup) {
    banner?.classList.remove('d-none');
    $('pinnedBannerText').textContent = 'Tomorrow 8 PM – BGMI Custom Room 🔥';
  } else {
    banner?.classList.add('d-none');
  }
}

$('btnChatBack')?.addEventListener('click', () => {
  $('viewChatScreen')?.classList.add('d-none');
  $('viewHomeDashboard')?.classList.remove('d-none');
  setActiveTab($('tabBtnHome'));
});

$('btnChatStartVideo')?.addEventListener('click', () => {
  if (currentChatPeer) startCall(currentChatPeer, true);
});

$('btnChatStartVoice')?.addEventListener('click', () => {
  if (currentChatPeer) startCall(currentChatPeer, false);
});

// Send Chat Message on Enter
$('chatTextInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = e.target.value.trim();
    if (!text) return;

    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgEl = document.createElement('div');
    msgEl.className = 'msg-bubble msg-outgoing';
    msgEl.innerHTML = `${text} <span class="msg-time">${timeStr} <i class="bi bi-check2 text-white-50"></i></span>`;
    
    $('chatMessagesArea')?.appendChild(msgEl);
    e.target.value = '';
    $('chatMessagesArea').scrollTop = $('chatMessagesArea').scrollHeight;

    if (currentChatPeer) {
      send({
        type: 'chat.msg',
        to: currentChatPeer,
        body: text
      });
    }
  }
});

// ---------------- BOOTSTRAP VIRTUAL NUMBER & WEBSOCKET ----------------
async function boot() {
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
      console.warn('Fallback generating client identity');
    }
  }

  window.ME = number;
  updateUserDisplay(number, localStorage.getItem('vc_name') || 'Guest', currentAvatarData);

  on('auth.ok', async (m) => {
    window.ME = m.number;
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
    } catch {}

    // Check URL parameters for auto-answer: ?answer=CALL_ID
    const urlParams = new URLSearchParams(window.location.search);
    const answerCallId = urlParams.get('answer');
    const answerFrom = urlParams.get('from');
    const answerVideo = urlParams.get('video') === '1';

    if (answerCallId) {
      window.history.replaceState({}, '', '/');
      acceptCallById(answerCallId, answerFrom || 'Caller', answerVideo);
    }
  });

  connect(token);
}

boot();
