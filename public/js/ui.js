/**
 * Studio-Grade Audio, DTMF Keypad Tones & Notification Helpers
 */

let audioCtx = null;
let ringtoneOsc1 = null;
let ringtoneOsc2 = null;
let ringtoneGain = null;
let ringInterval = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// DTMF Keypad Frequencies (ITU-T Standard)
const DTMF_FREQS = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
};

/**
 * Plays authentic DTMF telephone keypad tone on dialpad key press
 */
export function playDtmfTone(key) {
  const freqs = DTMF_FREQS[key];
  if (!freqs) return;

  try {
    const ctx = getAudioContext();
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(freqs[0], ctx.currentTime);
    osc2.frequency.setValueAtTime(freqs[1], ctx.currentTime);

    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.12);
    osc2.stop(ctx.currentTime + 0.12);
  } catch {}
}

/**
 * Subtle Telegram-like Message Sent & Received Audio Chimes
 */
export function playMessageSentSound() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
  } catch {}
}

export function playMessageReceivedSound() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046.5, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1318.5, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
  } catch {}
}
export function playRingtone() {
  stopRingtone();
  try {
    const ctx = getAudioContext();
    ringtoneGain = ctx.createGain();
    ringtoneGain.gain.setValueAtTime(0, ctx.currentTime);
    ringtoneGain.connect(ctx.destination);

    ringtoneOsc1 = ctx.createOscillator();
    ringtoneOsc2 = ctx.createOscillator();
    ringtoneOsc1.type = 'sine';
    ringtoneOsc2.type = 'triangle';
    ringtoneOsc1.frequency.setValueAtTime(480, ctx.currentTime);
    ringtoneOsc2.frequency.setValueAtTime(520, ctx.currentTime);

    ringtoneOsc1.connect(ringtoneGain);
    ringtoneOsc2.connect(ringtoneGain);

    ringtoneOsc1.start();
    ringtoneOsc2.start();

    let ringOn = true;
    const pulse = () => {
      if (!ringtoneGain) return;
      const t = ctx.currentTime;
      if (ringOn) {
        ringtoneGain.gain.cancelScheduledValues(t);
        ringtoneGain.gain.linearRampToValueAtTime(0.2, t + 0.1);
        ringtoneGain.gain.setValueAtTime(0.2, t + 1.4);
        ringtoneGain.gain.linearRampToValueAtTime(0, t + 1.5);
      }
      ringOn = !ringOn;
    };

    pulse();
    ringInterval = setInterval(pulse, 2000);

    // Vibrate device (if supported)
    if ('vibrate' in navigator) {
      navigator.vibrate([600, 400, 600, 400, 600]);
    }
  } catch (e) {
    console.warn('Ringtone playback error:', e);
  }
}

export function stopRingtone() {
  if (ringInterval) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
  if (ringtoneGain) {
    try { ringtoneGain.disconnect(); } catch {}
    ringtoneGain = null;
  }
  if (ringtoneOsc1) {
    try { ringtoneOsc1.stop(); ringtoneOsc1.disconnect(); } catch {}
    ringtoneOsc1 = null;
  }
  if (ringtoneOsc2) {
    try { ringtoneOsc2.stop(); ringtoneOsc2.disconnect(); } catch {}
    ringtoneOsc2 = null;
  }
  if ('vibrate' in navigator) {
    navigator.vibrate(0);
  }
}

/**
 * Dialing Ringback Tone (what caller hears while waiting for receiver to pick up)
 */
let dialOsc1 = null;
let dialOsc2 = null;
let dialGain = null;
let dialInterval = null;

export function playDialTone() {
  stopDialTone();
  try {
    const ctx = getAudioContext();
    dialGain = ctx.createGain();
    dialGain.gain.setValueAtTime(0, ctx.currentTime);
    dialGain.connect(ctx.destination);

    dialOsc1 = ctx.createOscillator();
    dialOsc2 = ctx.createOscillator();
    dialOsc1.type = 'sine';
    dialOsc2.type = 'sine';
    dialOsc1.frequency.setValueAtTime(440, ctx.currentTime);
    dialOsc2.frequency.setValueAtTime(480, ctx.currentTime);

    dialOsc1.connect(dialGain);
    dialOsc2.connect(dialGain);

    dialOsc1.start();
    dialOsc2.start();

    let on = true;
    const tick = () => {
      if (!dialGain) return;
      const t = ctx.currentTime;
      if (on) {
        dialGain.gain.cancelScheduledValues(t);
        dialGain.gain.linearRampToValueAtTime(0.12, t + 0.05);
        dialGain.gain.setValueAtTime(0.12, t + 1.8);
        dialGain.gain.linearRampToValueAtTime(0, t + 1.95);
      }
      on = !on;
    };
    tick();
    dialInterval = setInterval(tick, 3000);
  } catch (e) {
    console.warn('Dial tone error:', e);
  }
}

export function stopDialTone() {
  if (dialInterval) {
    clearInterval(dialInterval);
    dialInterval = null;
  }
  if (dialGain) {
    try { dialGain.disconnect(); } catch {}
    dialGain = null;
  }
  if (dialOsc1) {
    try { dialOsc1.stop(); dialOsc1.disconnect(); } catch {}
    dialOsc1 = null;
  }
  if (dialOsc2) {
    try { dialOsc2.stop(); dialOsc2.disconnect(); } catch {}
    dialOsc2 = null;
  }
}

export function playCallEndSound() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(425, ctx.currentTime);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch {}
}

/**
 * Native System Notification & Service Worker Alert
 */
export async function triggerIncomingCallAlert(callerData) {
  if (Notification.permission === 'granted') {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'INCOMING_CALL',
        ...callerData
      });
    } else {
      try {
        new Notification(`📞 Incoming Call from ${callerData.from}`, {
          body: `${callerData.callerName || 'Someone'} is calling you. Tap to answer.`,
          requireInteraction: true
        });
      } catch {}
    }
  }
}

export function showToast(message, type = 'info') {
  const toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) {
    alert(message);
    return;
  }

  const toastEl = document.createElement('div');
  const bgClass = type === 'error' ? 'danger' : type === 'success' ? 'success' : 'primary';
  toastEl.className = `toast align-items-center text-bg-${bgClass} border-0 shadow-lg show mb-2`;
  toastEl.setAttribute('role', 'alert');
  toastEl.innerHTML = `
    <div class="d-flex">
      <div class="toast-body fw-medium">${message}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;
  toastContainer.appendChild(toastEl);

  setTimeout(() => {
    toastEl.remove();
  }, 4000);
}
