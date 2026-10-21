import { send, on } from './ws.js';
import { apiRequest } from './api.js';
import { encryptMessage, decryptMessage } from './e2ee.js';
import { startVoiceRecording, stopVoiceRecording, togglePlayVoiceNote } from './voice.js';
import { TELEGRAM_EMOJIS, isOnlyEmojis } from './emoji.js';
import { showToast, playMessageSentSound, playMessageReceivedSound } from './ui.js';

let activeChatPeer = null;
let isRecordingVoice = false;
const $ = (id) => document.getElementById(id);

export async function openChat(peerNumber, peerName = 'User') {
  activeChatPeer = peerNumber;
  $('chatHeaderTitle').textContent = `${peerName} (${peerNumber})`;
  $('chatMessages').innerHTML = '<div class="text-center text-muted py-4"><small>Securing E2EE channel & loading messages...</small></div>';

  const chatOffcanvasEl = $('chatOffcanvas');
  if (chatOffcanvasEl && window.bootstrap) {
    const bsOffcanvas = bootstrap.Offcanvas.getOrCreateInstance(chatOffcanvasEl);
    bsOffcanvas.show();
  }

  initEmojiPicker();

  try {
    const data = await apiRequest(`/api/messages/${peerNumber}?limit=50`);
    await renderHistory(data.messages || [], peerNumber);

    if (data.messages && data.messages.length > 0) {
      const lastMsg = data.messages[data.messages.length - 1];
      send({ type: 'chat.read', with: peerNumber, upToId: lastMsg.id });
    }
  } catch (err) {
    console.error('Failed to load chat history:', err);
    $('chatMessages').innerHTML = '<div class="text-center text-danger py-4"><small>Failed to load messages</small></div>';
  }
}

async function renderHistory(messages, peerNumber) {
  const container = $('chatMessages');
  container.innerHTML = `
    <div class="text-center my-3 px-3">
      <span class="badge bg-warning-subtle text-dark border border-warning-subtle py-2 px-3 rounded-pill fw-normal shadow-sm" style="font-size: 0.75rem;">
        <i class="bi bi-shield-lock-fill text-warning me-1"></i> Messages & Voice Notes are End-to-End Encrypted (AES-256-GCM)
      </span>
    </div>
  `;

  if (messages.length === 0) {
    container.innerHTML += '<div class="text-center text-muted py-4"><small>No messages yet. Send a text or voice note!</small></div>';
    return;
  }

  for (const msg of messages) {
    const isMine = msg.from_number === window.ME;
    const decrypted = await decryptMessage(msg.body, peerNumber);
    appendMessageBubble({
      mine: isMine,
      text: decrypted,
      status: msg.status,
      time: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      id: msg.id
    });
  }

  scrollToBottom();
}

function appendMessageBubble({ mine, text, status, time, clientMsgId, id }) {
  const container = $('chatMessages');

  // Check if replacing optimistic clientMsgId
  if (clientMsgId) {
    const existing = container.querySelector(`[data-client-id="${clientMsgId}"]`);
    if (existing) {
      const tick = existing.querySelector('.msg-tick');
      if (tick) tick.textContent = status === 'delivered' ? '✓✓' : '✓';
      return;
    }
  }

  // Check if content is a Voice Note JSON
  let voicePayload = null;
  if (typeof text === 'string' && text.startsWith('{"type":"voice"')) {
    try { voicePayload = JSON.parse(text); } catch {}
  }

  const isSoloEmoji = !voicePayload && isOnlyEmojis(text);

  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${mine ? 'mine' : 'theirs'} ${isSoloEmoji ? 'bg-transparent shadow-none p-1' : 'shadow-sm'}`;
  if (clientMsgId) bubble.setAttribute('data-client-id', clientMsgId);
  const msgId = id || clientMsgId || crypto.randomUUID();
  bubble.setAttribute('data-id', msgId);

  let tickIcon = '';
  if (mine) {
    tickIcon = status === 'read' ? '<span class="text-info">✓✓</span>' : status === 'delivered' ? '✓✓' : '✓';
  }

  if (voicePayload) {
    // Telegram-Style Voice Message Bubble
    bubble.innerHTML = `
      <div class="d-flex align-items-center gap-2 py-1 voice-bubble-inner">
        <button class="btn btn-sm btn-light rounded-circle shadow-sm voice-play-btn p-0 d-flex align-items-center justify-content-center"
                style="width: 38px; height: 38px;" data-id="${msgId}">
          <i class="bi bi-play-fill fs-5"></i>
        </button>
        <div class="voice-wave-container flex-grow-1 d-flex align-items-center gap-1 mx-1">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <span class="badge bg-dark bg-opacity-25 rounded-pill font-monospace" style="font-size:0.75rem;">
          ${String(Math.floor(voicePayload.duration / 60)).padStart(2, '0')}:${String(voicePayload.duration % 60).padStart(2, '0')}
        </span>
      </div>
      <div class="chat-time text-end" style="font-size:0.68rem; margin-top:2px;">
        ${time || 'Just now'} <span class="msg-tick">${tickIcon}</span>
      </div>
    `;

    const playBtn = bubble.querySelector('.voice-play-btn');
    const wave = bubble.querySelector('.voice-wave-container');
    playBtn.onclick = () => togglePlayVoiceNote(msgId, voicePayload.audioData, playBtn, wave);

  } else if (isSoloEmoji) {
    // Telegram Animated Big Emoji
    bubble.innerHTML = `
      <div class="telegram-big-emoji">${text}</div>
      <div class="chat-time text-end" style="font-size:0.65rem; color:#64748b;">
        ${time || 'Just now'} <span class="msg-tick">${tickIcon}</span>
      </div>
    `;
  } else {
    // Standard Text Message
    bubble.innerHTML = `
      <div>${escapeHtml(text)}</div>
      <div class="chat-time">${time || 'Just now'} <span class="msg-tick">${tickIcon}</span></div>
    `;
  }

  container.appendChild(bubble);
  scrollToBottom();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function scrollToBottom() {
  const container = $('chatMessages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

// ---------------- SEND TEXT MESSAGE ----------------
export async function sendChatMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text || !activeChatPeer) return;

  const clientMsgId = crypto.randomUUID();

  // Optimistic render
  appendMessageBubble({
    mine: true,
    text,
    status: 'sent',
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    clientMsgId
  });

  input.value = '';
  playMessageSentSound();

  // E2EE Encrypt
  const cipherText = await encryptMessage(text, activeChatPeer);

  send({
    type: 'chat.send',
    to: activeChatPeer,
    clientMsgId,
    text: cipherText
  });
}

// ---------------- SEND VOICE NOTE (E2EE) ----------------
export async function sendVoiceNote(voiceData) {
  if (!voiceData || !activeChatPeer) return;

  const clientMsgId = crypto.randomUUID();
  const rawPayload = JSON.stringify({
    type: 'voice',
    audioData: voiceData.dataUrl,
    duration: voiceData.duration
  });

  // Optimistic render
  appendMessageBubble({
    mine: true,
    text: rawPayload,
    status: 'sent',
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    clientMsgId
  });

  // E2EE Encrypt voice message
  playMessageSentSound();
  const cipherText = await encryptMessage(rawPayload, activeChatPeer);

  send({
    type: 'chat.send',
    to: activeChatPeer,
    clientMsgId,
    text: cipherText
  });
}

// ---------------- TELEGRAM EMOJI PICKER ----------------
function initEmojiPicker() {
  const grid = $('telegramEmojiGrid');
  if (!grid || grid.children.length > 0) return;

  grid.innerHTML = '';
  TELEGRAM_EMOJIS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-link p-1 text-decoration-none emoji-grid-item';
    btn.style.fontSize = '1.65rem';
    btn.textContent = emoji;
    btn.onclick = () => {
      const input = $('chatInput');
      input.value += emoji;
      input.focus();
    };
    grid.appendChild(btn);
  });
}

// ---------------- WS CHAT EVENTS ----------------
on('chat.ack', (m) => {
  appendMessageBubble({
    mine: true,
    clientMsgId: m.clientMsgId,
    status: m.status
  });
});

on('chat.receive', async (m) => {
  playMessageReceivedSound();
  const decrypted = await decryptMessage(m.text, m.from);
  if (activeChatPeer === m.from) {
    appendMessageBubble({
      mine: false,
      text: decrypted,
      time: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      id: m.id
    });
    send({ type: 'chat.read', with: m.from, upToId: m.id });
  } else {
    send({ type: 'chat.delivered', id: m.id });
  }
});

on('chat.typing', (m) => {
  if (activeChatPeer === m.from) {
    const typingIndicator = $('chatTyping');
    if (typingIndicator) {
      typingIndicator.classList.remove('d-none');
      setTimeout(() => typingIndicator.classList.add('d-none'), 2500);
    }
  }
});

on('chat.status', (m) => {
  if (m.status === 'read') {
    document.querySelectorAll('.msg-tick').forEach((tick) => {
      tick.innerHTML = '<span class="text-info">✓✓</span>';
    });
  }
});

// Setup DOM event listeners
document.addEventListener('DOMContentLoaded', () => {
  $('btnSendChat')?.addEventListener('click', sendChatMessage);

  $('chatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendChatMessage();
    } else {
      if (activeChatPeer) {
        send({ type: 'chat.typing', to: activeChatPeer });
      }
    }
  });

  // Toggle Emoji Drawer
  $('btnToggleEmoji')?.addEventListener('click', () => {
    const drawer = $('telegramEmojiDrawer');
    if (drawer) {
      drawer.classList.toggle('d-none');
    }
  });

  // Voice Recording Buttons
  const btnVoiceRecord = $('btnVoiceRecord');
  const recordBar = $('chatRecordingBar');
  const recordTimerEl = $('recordingTimer');
  const btnCancelRecord = $('btnCancelRecord');
  const btnSendRecord = $('btnSendRecord');

  btnVoiceRecord?.addEventListener('click', async () => {
    if (!isRecordingVoice) {
      const ok = await startVoiceRecording(
        (timeStr) => {
          if (recordTimerEl) recordTimerEl.textContent = timeStr;
        },
        (err) => showToast(err, 'error')
      );

      if (ok) {
        isRecordingVoice = true;
        recordBar.classList.remove('d-none');
        $('chatInputRow').classList.add('d-none');
      }
    }
  });

  btnCancelRecord?.addEventListener('click', async () => {
    if (isRecordingVoice) {
      await stopVoiceRecording(true);
      isRecordingVoice = false;
      recordBar.classList.add('d-none');
      $('chatInputRow').classList.remove('d-none');
      showToast('Voice recording discarded', 'info');
    }
  });

  btnSendRecord?.addEventListener('click', async () => {
    if (isRecordingVoice) {
      const voiceData = await stopVoiceRecording(false);
      isRecordingVoice = false;
      recordBar.classList.add('d-none');
      $('chatInputRow').classList.remove('d-none');

      if (voiceData) {
        await sendVoiceNote(voiceData);
      }
    }
  });
});
