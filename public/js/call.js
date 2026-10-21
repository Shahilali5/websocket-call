import { send, on } from './ws.js';
import { playRingtone, stopRingtone, playDialTone, stopDialTone, playCallEndSound, showToast, triggerIncomingCallAlert } from './ui.js';
import { apiRequest } from './api.js';

let pc = null;
let localStream = null;
let currentCallId = null;
let currentPeer = null;
let currentPeerName = 'User';
let currentPeerAvatar = null;
let isCaller = false;
let isVideoCall = false;
let currentFacingMode = 'user';
let pendingCandidates = [];
let wakeLock = null;
let iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

const $ = (id) => document.getElementById(id);

on('auth.ok', (m) => {
  if (m.iceServers && m.iceServers.length) {
    iceServers = m.iceServers;
  }
});

/**
 * Toggles visibility between video and neon avatar stage
 */
function setRemoteVideoVisible(visible) {
  const remoteVid = $('remoteVideo');
  const localVid = $('localVideo');
  const avatarStage = document.querySelector('.neon-avatar-stage');
  const soundWave = $('activeCallSoundWave');
  const connSubtitle = $('activeCallConnSubtitle');

  if (visible) {
    if (remoteVid) remoteVid.classList.remove('d-none');
    if (localVid) localVid.classList.remove('d-none');
    if (avatarStage) avatarStage.classList.add('d-none');
    if (soundWave) soundWave.classList.add('d-none');
    if (connSubtitle) connSubtitle.textContent = 'Video is connected';
  } else {
    if (remoteVid) remoteVid.classList.add('d-none');
    if (localVid) localVid.classList.add('d-none');
    if (avatarStage) avatarStage.classList.remove('d-none');
    if (soundWave) soundWave.classList.remove('d-none');
    if (connSubtitle) connSubtitle.textContent = 'Voice is connected';

    // Populate neon avatar
    const avImg = $('neonAvatarImg');
    const avInit = $('neonAvatarInitial');

    if (currentPeerAvatar && (currentPeerAvatar.startsWith('data:image') || currentPeerAvatar.startsWith('http'))) {
      if (avImg) {
        avImg.src = currentPeerAvatar;
        avImg.classList.remove('d-none');
      }
      if (avInit) avInit.classList.add('d-none');
    } else {
      if (avInit) {
        avInit.textContent = currentPeerAvatar || currentPeerName[0]?.toUpperCase() || 'V';
        avInit.classList.remove('d-none');
      }
      if (avImg) avImg.classList.add('d-none');
    }
  }
}

/**
 * Capture microphone & camera with noise cancellation
 */
async function getMedia(wantVideo) {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
  }

  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  };

  const videoConstraints = wantVideo ? {
    facingMode: currentFacingMode,
    width: { ideal: 1280, max: 1920 },
    height: { ideal: 720, max: 1080 }
  } : false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints
    });
  } catch (err) {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantVideo
    });
  }

  const localVidEl = $('localVideo');
  if (localVidEl) localVidEl.srcObject = localStream;

  return localStream;
}

/**
 * PeerConnection setup
 */
function createPC() {
  if (pc) return pc;

  pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  pc.ontrack = (e) => {
    const remoteVid = $('remoteVideo');
    if (remoteVid && e.streams && e.streams[0]) {
      remoteVid.srcObject = e.streams[0];
    }
    if (e.track && e.track.kind === 'video') {
      e.track.onmute = () => setRemoteVideoVisible(false);
      e.track.onunmute = () => setRemoteVideoVisible(true);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      send({ type: 'webrtc.ice', callId: currentCallId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      stopDialTone();
      stopRingtone();
      startTimer();
      acquireWakeLock();
      $('activeCallConnSubtitle').textContent = isVideoCall ? 'HD Video link active' : 'Voice is connected';
    } else if (pc.connectionState === 'failed') {
      showToast('Call connection failed', 'error');
      endCall();
    }
  };

  return pc;
}

async function flushPendingCandidates() {
  while (pendingCandidates.length > 0) {
    const cand = pendingCandidates.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) {
      console.warn('[WebRTC] ICE candidate error:', e);
    }
  }
}

// ---------------- CALLER FLOW ----------------
export async function startCall(to, withVideo) {
  try {
    await getMedia(withVideo);
  } catch (err) {
    alert('Please grant camera/microphone permission to call.');
    return;
  }

  currentCallId = crypto.randomUUID();
  currentPeer = to;
  currentPeerName = to;
  currentPeerAvatar = null;
  isCaller = true;
  isVideoCall = withVideo;
  pendingCandidates = [];

  apiRequest(`/lookup/${to}`).then((info) => {
    if (info && info.name) currentPeerName = info.name;
    if (info && info.avatar) currentPeerAvatar = info.avatar;
    $('activeCallPeerName').textContent = currentPeerName;
    setRemoteVideoVisible(withVideo);
  }).catch(() => {});

  showCallScreen(to, 'Calling...', withVideo);
  playDialTone();

  send({ type: 'call.invite', to, callId: currentCallId, video: withVideo });
}

on('call.ringing', () => {
  $('activeCallConnSubtitle').textContent = 'Ringing...';
});

on('call.accepted', async () => {
  stopDialTone();
  $('activeCallConnSubtitle').textContent = 'Connecting...';
  createPC();
  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: isVideoCall
    });
    await pc.setLocalDescription(offer);
    send({ type: 'webrtc.offer', callId: currentCallId, sdp: offer });
  } catch (err) {
    endCall();
  }
});

on('call.error', (m) => {
  stopDialTone();
  showToast(`Call error: ${m.code}`, 'error');
  playCallEndSound();
  cleanup();
});

on('call.rejected', () => {
  stopDialTone();
  showToast('Call declined', 'info');
  playCallEndSound();
  cleanup();
});

on('call.timeout', () => {
  stopDialTone();
  stopRingtone();
  showToast('No answer', 'info');
  playCallEndSound();
  cleanup();
});

// ---------------- RECEIVER FLOW ----------------
on('call.incoming', (m) => {
  currentCallId = m.callId;
  currentPeer = m.from;
  currentPeerName = m.name || m.from;
  currentPeerAvatar = m.avatar || null;
  isCaller = false;
  isVideoCall = !!m.video;
  pendingCandidates = [];

  showCallScreen(currentPeerName, 'Incoming call...', isVideoCall);
  playRingtone();

  triggerIncomingCallAlert({
    callId: m.callId,
    from: m.from,
    callerName: currentPeerName,
    callerAvatar: currentPeerAvatar,
    video: !!m.video
  });
});

on('call.cancelled', () => {
  stopRingtone();
  showToast('Caller hung up', 'info');
  playCallEndSound();
  cleanup();
});

export async function acceptCallById(callId, from, withVideo = false) {
  currentCallId = callId;
  currentPeer = from;
  currentPeerName = from;
  isVideoCall = !!withVideo;
  isCaller = false;
  pendingCandidates = [];

  stopRingtone();

  try {
    await getMedia(isVideoCall);
  } catch (err) {
    showToast('Permission needed', 'error');
    send({ type: 'call.reject', callId: currentCallId });
    cleanup();
    return;
  }

  showCallScreen(currentPeerName, 'Connecting...', isVideoCall);
  send({ type: 'call.accept', callId: currentCallId });
}

export function rejectIncomingCall() {
  stopRingtone();
  send({ type: 'call.reject', callId: currentCallId });
  playCallEndSound();
  cleanup();
}

// ---------------- SIGNALING RELAY ----------------
on('webrtc.offer', async (m) => {
  createPC();
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
    await flushPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'webrtc.answer', callId: currentCallId, sdp: answer });
  } catch (err) {
    endCall();
  }
});

on('webrtc.answer', async (m) => {
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
    await flushPendingCandidates();
  } catch (err) {}
});

on('webrtc.ice', async (m) => {
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(m.candidate));
    } catch (e) {}
  } else {
    pendingCandidates.push(m.candidate);
  }
});

on('call.state', (m) => {
  if (m.videoMuted !== undefined) {
    setRemoteVideoVisible(!m.videoMuted);
  }
});

// ---------------- CONTROLS & CLEANUP ----------------
export function endCall() {
  if (currentCallId) {
    send({
      type: isCaller && (!pc || pc.connectionState === 'new') ? 'call.cancel' : 'call.end',
      callId: currentCallId
    });
  }
  playCallEndSound();
  cleanup();
}

on('call.ended', (m) => {
  showToast(m.duration ? `Call ended (${m.duration}s)` : 'Call ended', 'info');
  playCallEndSound();
  cleanup();
});

let timerId = null;
let durationSec = 0;

function startTimer() {
  durationSec = 0;
  if (timerId) clearInterval(timerId);
  timerId = setInterval(() => {
    durationSec++;
    const mins = String(Math.floor(durationSec / 60)).padStart(2, '0');
    const secs = String(durationSec % 60).padStart(2, '0');
    const timerEl = $('activeCallTimer');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function showCallScreen(title, status = 'Calling...', withVideo = false) {
  $('activeCallPeerName').textContent = title;
  $('activeCallTypeBadge').innerHTML = withVideo 
    ? '<i class="bi bi-camera-video-fill text-primary me-1"></i> Video Call' 
    : '<i class="bi bi-telephone-fill text-success me-1"></i> Voice Call';
  $('activeCallTimer').textContent = '00:00';
  $('activeCallConnSubtitle').textContent = status;

  $('viewActiveCall')?.classList.remove('d-none');
  setRemoteVideoVisible(withVideo);
}

async function acquireWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {}
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

function cleanup() {
  stopDialTone();
  stopRingtone();
  releaseWakeLock();

  if (timerId) clearInterval(timerId);
  durationSec = 0;

  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  const remoteVid = $('remoteVideo');
  if (remoteVid) remoteVid.srcObject = null;
  const localVid = $('localVideo');
  if (localVid) localVid.srcObject = null;

  $('viewActiveCall')?.classList.add('d-none');
  currentCallId = null;
  currentPeer = null;
  currentPeerAvatar = null;
  pendingCandidates = [];
}

// ---------------- 5-BUTTON CALL DOCK EVENT LISTENERS ----------------
document.addEventListener('DOMContentLoaded', () => {
  $('btnCallHangup')?.addEventListener('click', endCall);

  // Mute Mic Toggle
  $('btnCallMute')?.addEventListener('click', () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      const isMuted = !audioTrack.enabled;
      const btn = $('btnCallMute');
      btn.classList.toggle('text-danger', isMuted);
      btn.innerHTML = `<i class="bi bi-mic${isMuted ? '-mute-fill' : '-fill'}"></i>`;
      showToast(isMuted ? 'Microphone muted' : 'Microphone on', 'info');
    }
  });

  // Open Keypad during Call
  $('btnCallKeypad')?.addEventListener('click', () => {
    bootstrap.Modal.getOrCreateInstance($('dialpadModal')).show();
  });

  // Speaker Toggle
  $('btnCallSpeaker')?.addEventListener('click', () => {
    showToast('Speaker toggled', 'info');
  });

  // Add Call (Invite to Group)
  $('btnCallAddPeer')?.addEventListener('click', () => {
    bootstrap.Modal.getOrCreateInstance($('addContactModal')).show();
  });

  // Minimize Call Screen (Return to Dashboard)
  $('btnCallMinimize')?.addEventListener('click', () => {
    $('viewActiveCall')?.classList.add('d-none');
    showToast('Call running in background', 'info');
  });
});
