/**
 * Telegram-Style End-to-End Encrypted Voice Message Recorder & Audio Player
 */

let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;
let currentRecordingBlob = null;
let activeAudioPlayer = null;
let activePlayingMsgId = null;

const $ = (id) => document.getElementById(id);

/**
 * Start Voice Recording
 */
export async function startVoiceRecording(onTick, onError) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 24000
      }
    });

    audioChunks = [];
    recordingStartTime = Date.now();

    // Prefer webm/opus or ogg
    let mimeType = 'audio/webm; codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'audio/ogg; codecs=opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = '';
      }
    }

    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 24000 } : {});

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.start(100);

    recordingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const secs = String(elapsed % 60).padStart(2, '0');
      if (onTick) onTick(`${mins}:${secs}`, elapsed);
    }, 500);

    return true;
  } catch (err) {
    console.error('[Voice] Error starting recording:', err);
    if (onError) onError('Microphone access denied or unsupported');
    return false;
  }
}

/**
 * Stop and get Voice Message Data
 */
export function stopVoiceRecording(cancel = false) {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      clearInterval(recordingTimer);
      return resolve(null);
    }

    clearInterval(recordingTimer);
    const duration = Math.max(1, Math.round((Date.now() - recordingStartTime) / 1000));

    mediaRecorder.onstop = async () => {
      mediaRecorder.stream.getTracks().forEach(t => t.stop());

      if (cancel) {
        audioChunks = [];
        return resolve(null);
      }

      const mime = mediaRecorder.mimeType || 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: mime });
      audioChunks = [];

      // Convert Blob to Base64 Data URL
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve({
          dataUrl: reader.result,
          duration,
          mime
        });
      };
      reader.readAsDataURL(audioBlob);
    };

    mediaRecorder.stop();
  });
}

/**
 * Play / Pause Voice Message in Chat
 */
export function togglePlayVoiceNote(msgId, dataUrl, btnElement, waveElement) {
  if (activeAudioPlayer && activePlayingMsgId === msgId) {
    // Currently playing this message -> pause it
    activeAudioPlayer.pause();
    activeAudioPlayer = null;
    activePlayingMsgId = null;
    btnElement.innerHTML = '<i class="bi bi-play-fill fs-5"></i>';
    waveElement?.classList.remove('playing-bars');
    return;
  }

  // Stop any other active voice note
  if (activeAudioPlayer) {
    activeAudioPlayer.pause();
    document.querySelectorAll('.voice-play-btn').forEach(b => b.innerHTML = '<i class="bi bi-play-fill fs-5"></i>');
    document.querySelectorAll('.voice-wave-container').forEach(w => w.classList.remove('playing-bars'));
  }

  const audio = new Audio(dataUrl);
  activeAudioPlayer = audio;
  activePlayingMsgId = msgId;

  btnElement.innerHTML = '<i class="bi bi-pause-fill fs-5 text-warning"></i>';
  waveElement?.classList.add('playing-bars');

  audio.onended = () => {
    btnElement.innerHTML = '<i class="bi bi-play-fill fs-5"></i>';
    waveElement?.classList.remove('playing-bars');
    activeAudioPlayer = null;
    activePlayingMsgId = null;
  };

  audio.play().catch(e => {
    console.warn('Audio playback error:', e);
    btnElement.innerHTML = '<i class="bi bi-play-fill fs-5"></i>';
    waveElement?.classList.remove('playing-bars');
  });
}
