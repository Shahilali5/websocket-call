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
let screenStream = null;
let isSharingScreen = false;
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
 * Update local avatar view inside floating PiP
 */
function updateLocalAvatarPreview() {
  const localAvatarImg = $('localAvatarImg');
  const localAvatarInit = $('localAvatarInitial');
  const myAvatar = localStorage.getItem('vc_avatar');
  const myName = localStorage.getItem('vc_name') || 'Me';

  if (myAvatar && (myAvatar.startsWith('data:image') || myAvatar.startsWith('http'))) {
    if (localAvatarImg) {
      localAvatarImg.src = myAvatar;
      localAvatarImg.classList.remove('d-none');
    }
    if (localAvatarInit) localAvatarInit.classList.add('d-none');
  } else {
    if (localAvatarInit) {
      localAvatarInit.textContent = myAvatar || myName[0]?.toUpperCase() || 'M';
      localAvatarInit.classList.remove('d-none');
    }
    if (localAvatarImg) localAvatarImg.classList.add('d-none');
  }
}

/**
 * Toggles visibility between local video and local avatar inside PiP
 */
function setLocalVideoVisible(visible) {
  const localVid = $('localVideo');
  const localAv = $('localAvatarView');
  if (visible) {
    if (localVid) localVid.classList.remove('d-none');
    if (localAv) localAv.classList.add('d-none');
  } else {
    if (localVid) localVid.classList.add('d-none');
    if (localAv) localAv.classList.remove('d-none');
    updateLocalAvatarPreview();
  }
}

/**
 * Toggles visibility between remote video and remote avatar screen
 */
function setRemoteVideoVisible(visible) {
  const remoteVid = $('remoteVideo');
  const remoteAv = $('remoteAvatarView');
  const waveAnim = $('outgoingWaveAnimation');

  if (visible) {
    if (remoteVid) remoteVid.classList.remove('d-none');
    if (remoteAv) remoteAv.classList.add('d-none');
    if (waveAnim) waveAnim.classList.add('d-none');
  } else {
    if (remoteVid) remoteVid.classList.add('d-none');
    if (remoteAv) {
      remoteAv.classList.remove('d-none');
      // Update peer details
      const nameDisp = $('remotePeerNameDisplay');
      const numDisp = $('remotePeerNumberDisplay');
      const avImg = $('remoteAvatarImg');
      const avInit = $('remoteAvatarInitial');

      if (nameDisp) nameDisp.textContent = currentPeerName;
      if (numDisp) numDisp.textContent = currentPeer || '---';

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
}

/**
 * Media Capture with Hardware Acoustic Cancellation & Auto-Gain
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
    height: { ideal: 720, max: 1080 },
    frameRate: { ideal: 30, max: 60 }
  } : false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: videoConstraints
    });
  } catch (err) {
    // Fallback without HD constraints
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantVideo
    });
  }

  const localVidEl = $('localVideo');
  if (localVidEl) {
    localVidEl.srcObject = localStream;
  }

  setLocalVideoVisible(wantVideo);
  return localStream;
}

/**
 * Production WebRTC PeerConnection with ICE Candidate Queuing & Bandwidth Tuning
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
      const sender = pc.addTrack(track, localStream);
      if (track.kind === 'video') {
        tuneVideoSender(sender);
      }
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

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected') {
      showToast('Reconnecting call link...', 'info');
      if (isCaller) {
        pc.restartIce();
        pc.createOffer({ iceRestart: true }).then((offer) => {
          pc.setLocalDescription(offer);
          send({ type: 'webrtc.offer', callId: currentCallId, sdp: offer });
        }).catch(() => {});
      }
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      stopDialTone();
      stopRingtone();
      startTimer();
      acquireWakeLock();
      $('callStatusBadge').textContent = 'Connected';
      $('callStatusBadge').className = 'badge bg-success-subtle text-success border border-success-subtle rounded-pill px-3 py-1';
      $('outgoingWaveAnimation')?.classList.add('d-none');
    } else if (pc.connectionState === 'failed') {
      showToast('Call connection failed', 'error');
      endCall();
    }
  };

  return pc;
}

async function tuneVideoSender(sender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = 1200000; // 1.2 Mbps for crisp 720p/1080p
    params.encodings[0].networkPriority = 'high';
    await sender.setParameters(params);
  } catch (err) {
    // Non-critical parameter tuning
  }
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
    alert('Please grant camera and microphone permission to initiate calls.');
    return;
  }

  currentCallId = crypto.randomUUID();
  currentPeer = to;
  currentPeerName = to;
  currentPeerAvatar = null;
  isCaller = true;
  isVideoCall = withVideo;
  pendingCandidates = [];

  // Async lookup peer name/avatar for immediate rich display
  apiRequest(`/lookup/${to}`).then((info) => {
    if (info && info.name) currentPeerName = info.name;
    if (info && info.avatar) currentPeerAvatar = info.avatar;
    if (!withVideo) setRemoteVideoVisible(false);
  }).catch(() => {});

  showCallScreen(to, 'Calling...', withVideo);
  playDialTone();

  send({ type: 'call.invite', to, callId: currentCallId, video: withVideo });
}

on('call.ringing', (m) => {
  $('callStatusBadge').textContent = m.pushSent ? 'Ringing (Push Alert Sent)...' : 'Ringing...';
  $('callStatusBadge').className = 'badge bg-primary-subtle text-primary border border-primary-subtle rounded-pill px-3 py-1';
});

on('call.accepted', async () => {
  stopDialTone();
  $('callStatusBadge').textContent = 'Connecting...';
  $('callStatusBadge').className = 'badge bg-warning-subtle text-warning border border-warning-subtle rounded-pill px-3 py-1';
  createPC();
  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: isVideoCall
    });
    await pc.setLocalDescription(offer);
    send({ type: 'webrtc.offer', callId: currentCallId, sdp: offer });
  } catch (err) {
    console.error('Error creating offer:', err);
    endCall();
  }
});

on('call.error', (m) => {
  stopDialTone();
  const codeMessages = {
    NOT_FOUND: 'Virtual number does not exist.',
    OFFLINE: 'User is offline. Leave them a chat message.',
    BUSY: 'User is busy on another call.',
    BLOCKED: 'Cannot place call to this number.',
    SELF: 'You cannot call your own number.'
  };
  showToast(codeMessages[m.code] || `Call error: ${m.code}`, 'error');
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

// ---------------- RECEIVER FLOW (IMO-STYLE FULLSCREEN POPUP) ----------------
on('call.incoming', (m) => {
  currentCallId = m.callId;
  currentPeer = m.from;
  currentPeerName = m.name || m.from;
  currentPeerAvatar = m.avatar || null;
  isCaller = false;
  isVideoCall = !!m.video;
  pendingCandidates = [];

  // Populate IMO-style Incoming Call Screen
  $('imoCallerName').textContent = currentPeerName;
  $('imoCallerNumber').textContent = currentPeer;
  $('imoCallType').textContent = m.video ? 'Incoming Video Call' : 'Incoming Voice Call';

  const imoAvatarImg = $('imoCallerAvatarImg');
  const imoCallerInit = $('imoCallerInitial');

  if (currentPeerAvatar && (currentPeerAvatar.startsWith('data:image') || currentPeerAvatar.startsWith('http'))) {
    if (imoAvatarImg) {
      imoAvatarImg.src = currentPeerAvatar;
      imoAvatarImg.classList.remove('d-none');
    }
    if (imoCallerInit) imoCallerInit.classList.add('d-none');
  } else {
    if (imoCallerInit) {
      imoCallerInit.textContent = currentPeerAvatar || (currentPeerName[0] || 'V').toUpperCase();
      imoCallerInit.classList.remove('d-none');
    }
    if (imoAvatarImg) imoAvatarImg.classList.add('d-none');
  }

  // Show fullscreen overlay
  $('imoIncomingCallScreen').classList.remove('d-none');
  playRingtone();

  // Background notification trigger
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
  $('imoIncomingCallScreen').classList.add('d-none');
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
  $('imoIncomingCallScreen').classList.add('d-none');

  try {
    await getMedia(isVideoCall);
  } catch (err) {
    showToast('Camera/Mic permission needed', 'error');
    send({ type: 'call.reject', callId: currentCallId });
    cleanup();
    return;
  }

  showCallScreen(currentPeerName, 'Connecting...', isVideoCall);
  send({ type: 'call.accept', callId: currentCallId });
}

export async function acceptIncomingCall() {
  await acceptCallById(currentCallId, currentPeer, isVideoCall);
}

export function rejectIncomingCall() {
  stopRingtone();
  $('imoIncomingCallScreen').classList.add('d-none');
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
    console.error('[WebRTC] Offer handling error:', err);
    endCall();
  }
});

on('webrtc.answer', async (m) => {
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
    await flushPendingCandidates();
  } catch (err) {
    console.error('[WebRTC] Answer handling error:', err);
  }
});

on('webrtc.ice', async (m) => {
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(m.candidate));
    } catch (e) {
      console.warn('[WebRTC] Error adding ICE candidate:', e);
    }
  } else {
    pendingCandidates.push(m.candidate);
  }
});

// Relay peer state changes (e.g. video muted / camera toggled off)
on('call.state', (m) => {
  if (m.videoMuted !== undefined) {
    setRemoteVideoVisible(!m.videoMuted);
    const badge = $('remoteCamStatusBadge');
    if (badge) {
      badge.innerHTML = m.videoMuted
        ? '<i class="bi bi-camera-video-off-fill me-1"></i> Camera is Off'
        : '<i class="bi bi-camera-video-fill me-1"></i> Camera On';
    }
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
    const timerEl = $('callTimer');
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
}

function showCallScreen(title, status = 'Calling...', withVideo = false) {
  $('callPeer').textContent = title;
  $('callStatusBadge').textContent = status;
  $('callTimer').textContent = '00:00';
  $('callScreen').classList.remove('d-none');

  if (withVideo) {
    setRemoteVideoVisible(true);
    setLocalVideoVisible(true);
  } else {
    setRemoteVideoVisible(false);
    setLocalVideoVisible(false);
    const badge = $('remoteCamStatusBadge');
    if (badge) badge.innerHTML = '<i class="bi bi-mic-fill me-1"></i> Voice Only';
  }
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

function stopScreenSharing() {
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }
  isSharingScreen = false;
  $('btnScreenShare')?.classList.remove('btn-primary');
  $('btnScreenShare')?.classList.add('btn-secondary');
}

function cleanup() {
  stopDialTone();
  stopRingtone();
  releaseWakeLock();
  stopScreenSharing();

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

  $('callScreen').classList.add('d-none');
  $('imoIncomingCallScreen').classList.add('d-none');
  $('remoteAvatarView')?.classList.add('d-none');
  $('localAvatarView')?.classList.add('d-none');

  currentCallId = null;
  currentPeer = null;
  currentPeerAvatar = null;
  pendingCandidates = [];
}

// Media toggle button handlers
document.addEventListener('DOMContentLoaded', () => {
  $('btnImoAccept')?.addEventListener('click', acceptIncomingCall);
  $('btnImoReject')?.addEventListener('click', rejectIncomingCall);
  $('btnEnd')?.addEventListener('click', endCall);

  // Mute Audio
  $('btnMute')?.addEventListener('click', () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      $('btnMute').classList.toggle('btn-secondary', audioTrack.enabled);
      $('btnMute').classList.toggle('btn-danger', !audioTrack.enabled);
      $('btnMute').innerHTML = `<i class="bi bi-mic${audioTrack.enabled ? '-fill' : '-mute-fill'}"></i>`;
    }
  });

  // Camera Toggle (Show Profile when camera is off)
  $('btnCam')?.addEventListener('click', () => {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      const isEnabled = videoTrack.enabled;
      $('btnCam').classList.toggle('btn-secondary', isEnabled);
      $('btnCam').classList.toggle('btn-danger', !isEnabled);
      $('btnCam').innerHTML = `<i class="bi bi-camera-video${isEnabled ? '-fill' : '-off-fill'}"></i>`;

      setLocalVideoVisible(isEnabled);
      send({ type: 'call.state', callId: currentCallId, videoMuted: !isEnabled });
    }
  });

  // Flip Camera (Mobile)
  $('btnFlip')?.addEventListener('click', async () => {
    if (!localStream || !isVideoCall) return;
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    await getMedia(true);
    if (pc) {
      const newVideoTrack = localStream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender && newVideoTrack) {
        sender.replaceTrack(newVideoTrack);
      }
    }
  });

  // Picture in Picture for remote video
  $('btnPip')?.addEventListener('click', async () => {
    const remoteVid = $('remoteVideo');
    if (remoteVid && document.pictureInPictureEnabled) {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await remoteVid.requestPictureInPicture();
        }
      } catch (e) {
        console.warn('PiP error:', e);
      }
    }
  });

  // Screen Sharing
  $('btnScreenShare')?.addEventListener('click', async () => {
    if (!pc) return;
    if (!isSharingScreen) {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(screenTrack);
        }
        isSharingScreen = true;
        $('btnScreenShare').classList.remove('btn-secondary');
        $('btnScreenShare').classList.add('btn-primary');

        screenTrack.onended = () => {
          stopScreenSharing();
          if (localStream) {
            const camTrack = localStream.getVideoTracks()[0];
            if (sender && camTrack) sender.replaceTrack(camTrack);
          }
        };
      } catch (e) {
        console.warn('Screen share cancelled/failed:', e);
      }
    } else {
      stopScreenSharing();
      if (localStream) {
        const camTrack = localStream.getVideoTracks()[0];
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender && camTrack) sender.replaceTrack(camTrack);
      }
    }
  });
});
