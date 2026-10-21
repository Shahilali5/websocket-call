import { startCall } from './call.js';
import { openChat } from './chat.js';
import { showToast, playDtmfTone } from './ui.js';
import { apiRequest } from './api.js';

const input = document.getElementById('dialInput');
const keysContainer = document.getElementById('keys');
const peerStatusEl = document.getElementById('dialPeerStatus');

const keyList = [
  { key: '1', sub: '&nbsp;' },
  { key: '2', sub: 'ABC' },
  { key: '3', sub: 'DEF' },
  { key: '4', sub: 'GHI' },
  { key: '5', sub: 'JKL' },
  { key: '6', sub: 'MNO' },
  { key: '7', sub: 'PQRS' },
  { key: '8', sub: 'TUV' },
  { key: '9', sub: 'WXYZ' },
  { key: '*', sub: '&nbsp;' },
  { key: '0', sub: '+' },
  { key: '⌫', sub: '&nbsp;' }
];

let lookupTimeout = null;

async function checkPeerStatus(number) {
  if (!peerStatusEl) return;
  if (number === window.ME) {
    peerStatusEl.innerHTML = '<span class="text-warning"><i class="bi bi-info-circle me-1"></i>This is your own number</span>';
    return;
  }

  peerStatusEl.innerHTML = '<span class="text-muted"><span class="spinner-border spinner-border-sm me-1" style="width:0.75rem; height:0.75rem;"></span>Checking number...</span>';

  try {
    const data = await apiRequest(`/api/lookup/${number}`);
    if (data.exists) {
      const statusIcon = data.status === 'online' ? '🟢' : data.status === 'in-call' ? '🟡' : '⚪';
      const statusText = data.status === 'online' ? 'Online' : data.status === 'in-call' ? 'In Call' : 'Offline';
      peerStatusEl.innerHTML = `
        <span class="text-dark fw-semibold">${statusIcon} ${data.name || 'User'}</span>
        <span class="text-muted ms-1">(${statusText})</span>
      `;
    } else {
      peerStatusEl.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle me-1"></i>Number not registered</span>';
    }
  } catch (e) {
    peerStatusEl.innerHTML = '<span class="text-muted">Enter 10-digit number to call or chat</span>';
  }
}

function onNumberChanged() {
  const num = input.value;
  if (num.length === 10 && /^[1-9]\d{9}$/.test(num)) {
    clearTimeout(lookupTimeout);
    lookupTimeout = setTimeout(() => checkPeerStatus(num), 300);
  } else {
    if (peerStatusEl) {
      peerStatusEl.innerHTML = '<span class="text-muted">Enter 10-digit number to call or chat</span>';
    }
  }
}

export function initDialpad() {
  if (!keysContainer) return;
  keysContainer.innerHTML = '';

  keyList.forEach(({ key, sub }) => {
    const col = document.createElement('div');
    col.className = 'col-4';
    col.innerHTML = `
      <button class="btn dial-btn w-100 flex-column" data-key="${key}">
        <span>${key}</span>
        <sub>${sub}</sub>
      </button>
    `;

    const btn = col.querySelector('button');
    btn.onclick = () => {
      playDtmfTone(key);
      if (key === '⌫') {
        input.value = input.value.slice(0, -1);
      } else if (/\d/.test(key) && input.value.length < 10) {
        input.value += key;
      }
      onNumberChanged();
    };
    keysContainer.appendChild(col);
  });

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 10);
    onNumberChanged();
  });
}

const isValidNumber = () => /^[1-9]\d{9}$/.test(input.value);

function validateTarget() {
  if (!isValidNumber()) {
    showToast('Please enter a valid 10-digit number', 'error');
    return false;
  }
  if (input.value === window.ME) {
    showToast('Cannot call your own number', 'error');
    return false;
  }
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  initDialpad();

  document.getElementById('btnVoice')?.addEventListener('click', () => {
    if (validateTarget()) {
      startCall(input.value, false);
    }
  });

  document.getElementById('btnVideo')?.addEventListener('click', () => {
    if (validateTarget()) {
      startCall(input.value, true);
    }
  });

  document.getElementById('btnChat')?.addEventListener('click', () => {
    if (validateTarget()) {
      openChat(input.value);
    }
  });
});
