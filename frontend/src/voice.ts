/**
 * Voice input (Web Speech API) and audio output (AudioContext) for JARVIS.
 */

// ---------------------------------------------------------------------------
// Speech Recognition
// ---------------------------------------------------------------------------

export interface VoiceInput {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const webkitSpeechRecognition: any;

export function createVoiceInput(
  onTranscript: (text: string) => void,
  onError: (msg: string) => void
): VoiceInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SR = (window as any).SpeechRecognition || (typeof webkitSpeechRecognition !== "undefined" ? webkitSpeechRecognition : null);
  if (!SR) {
    onError("Speech recognition not supported in this browser");
    return { start() {}, stop() {}, pause() {}, resume() {} };
  }

  const recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  let shouldListen = false;
  let paused = false;

  recognition.onresult = (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        const text = event.results[i][0].transcript.trim();
        if (text) onTranscript(text);
      }
    }
  };

  recognition.onend = () => {
    if (shouldListen && !paused) {
      try {
        recognition.start();
      } catch {
        // Already started
      }
    }
  };

  recognition.onerror = (event: any) => {
    if (event.error === "not-allowed") {
      onError("Microphone access denied. Please allow microphone access.");
      shouldListen = false;
    } else if (event.error === "no-speech") {
      // Normal, just restart
    } else if (event.error === "aborted") {
      // Expected during pause
    } else {
      console.warn("[voice] recognition error:", event.error);
    }
  };

  return {
    start() {
      shouldListen = true;
      paused = false;
      try {
        recognition.start();
      } catch {
        // Already started
      }
    },
    stop() {
      shouldListen = false;
      paused = false;
      recognition.stop();
    },
    pause() {
      paused = true;
      recognition.stop();
    },
    resume() {
      paused = false;
      if (shouldListen) {
        try {
          recognition.start();
        } catch {
          // Already started
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Speech Recognition capability detection
// ---------------------------------------------------------------------------

export function hasNativeSpeechRecognition(): boolean {
  return !!(
    (window as any).SpeechRecognition ||
    (typeof webkitSpeechRecognition !== "undefined" ? webkitSpeechRecognition : null)
  );
}

// ---------------------------------------------------------------------------
// Server-side Voice Input (fallback for Safari/iPad)
// ---------------------------------------------------------------------------

export function createServerVoiceInput(
  onAudioReady: (blob: Blob) => void,
  onError: (msg: string) => void
): VoiceInput {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let analyserNode: AnalyserNode | null = null;
  let audioCtx: AudioContext | null = null;
  let shouldListen = false;
  let paused = false;
  let chunks: Blob[] = [];
  let silenceTimer: number | null = null;
  let vadRafId: number | null = null;
  let isSpeaking = false;
  let speechStartTime = 0;

  const SILENCE_THRESHOLD = 0.02;
  const SILENCE_DURATION = 1500;
  const MIN_SPEECH_DURATION = 300;

  function startVAD() {
    if (!analyserNode) return;
    const dataArray = new Float32Array(analyserNode.fftSize);

    function check() {
      if (!shouldListen || paused || !analyserNode) return;
      analyserNode.getFloatTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);

      if (rms > SILENCE_THRESHOLD) {
        if (!isSpeaking) {
          isSpeaking = true;
          speechStartTime = Date.now();
          chunks = [];
          if (recorder?.state === "inactive") {
            recorder.start(100);
          }
        }
        if (silenceTimer !== null) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }
      } else if (isSpeaking) {
        if (silenceTimer === null) {
          silenceTimer = window.setTimeout(() => {
            const duration = Date.now() - speechStartTime;
            if (duration >= MIN_SPEECH_DURATION && recorder?.state === "recording") {
              recorder.stop();
            } else if (recorder?.state === "recording") {
              recorder.stop();
              chunks = [];
            }
            isSpeaking = false;
            silenceTimer = null;
          }, SILENCE_DURATION);
        }
      }

      vadRafId = requestAnimationFrame(check);
    }
    check();
  }

  async function initStream() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });

      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;
      source.connect(analyserNode);

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/mp4";

      recorder = new MediaRecorder(stream, { mimeType });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        if (chunks.length > 0) {
          const blob = new Blob(chunks, { type: mimeType });
          chunks = [];
          if (blob.size > 1000) {
            console.log("[voice] sending audio blob:", blob.size, "bytes");
            onAudioReady(blob);
          }
        }
      };

      startVAD();
      console.log("[voice] server-side STT active, mime:", mimeType);
    } catch (err) {
      console.error("[voice] initStream error:", err);
      onError("Microphone error: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  return {
    start() {
      shouldListen = true;
      paused = false;
      initStream();
    },
    stop() {
      shouldListen = false;
      paused = false;
      if (vadRafId) cancelAnimationFrame(vadRafId);
      if (silenceTimer) clearTimeout(silenceTimer);
      if (recorder?.state === "recording") recorder.stop();
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    },
    pause() {
      paused = true;
      if (vadRafId) cancelAnimationFrame(vadRafId);
      if (recorder?.state === "recording") recorder.stop();
    },
    resume() {
      paused = false;
      if (shouldListen) startVAD();
    },
  };
}

// ---------------------------------------------------------------------------
// Audio Player
// ---------------------------------------------------------------------------

export interface AudioPlayer {
  enqueue(base64: string): Promise<void>;
  stop(): void;
  getAnalyser(): AnalyserNode;
  prime(): void;
  onFinished(cb: () => void): void;
}

export function createAudioPlayer(): AudioPlayer {
  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  analyser.connect(audioCtx.destination);

  // Use a single persistent Audio element — required for iOS Safari.
  // iOS only allows audio playback from an element that was first played
  // during a user gesture. By reusing the same element, the initial prime
  // (from a tap) carries forward to all subsequent plays.
  const persistentAudio = new Audio();
  persistentAudio.setAttribute("playsinline", "true");

  const queue: string[] = [];
  let isPlaying = false;
  let finishedCallback: (() => void) | null = null;

  function playNext() {
    if (queue.length === 0) {
      isPlaying = false;
      finishedCallback?.();
      return;
    }

    isPlaying = true;
    const base64 = queue.shift()!;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "audio/mpeg" });
    const blobUrl = URL.createObjectURL(blob);

    persistentAudio.src = blobUrl;

    persistentAudio.onended = () => {
      URL.revokeObjectURL(blobUrl);
      playNext();
    };

    persistentAudio.onerror = () => {
      console.error("[audio] playback error");
      URL.revokeObjectURL(blobUrl);
      playNext();
    };

    persistentAudio.play().catch((err) => {
      console.error("[audio] play() rejected:", err);
      URL.revokeObjectURL(blobUrl);
      playNext();
    });
  }

  return {
    async enqueue(base64: string) {
      queue.push(base64);
      if (!isPlaying) playNext();
    },

    stop() {
      queue.length = 0;
      persistentAudio.pause();
      persistentAudio.src = "";
      isPlaying = false;
    },

    getAnalyser() {
      return analyser;
    },

    // Call this once from a user gesture to prime iOS audio
    prime() {
      persistentAudio.src = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAABhgBWMKBOAAAAAAD/+1DEAAAFeAVX9AAAA0W8q/8pgAABNQAAAA0AAAANICAIAgAAMffBMBAEHwfB8Hw+CAIfg+D7//y4Pg+D4f/8uD4Pg+H//+XB8HwfD///8uD4Pg+D///+XB8HwfB////Lg+D4Pg///8=";
      persistentAudio.play().then(() => {
        persistentAudio.pause();
        console.log("[audio] primed");
      }).catch(() => {});
    },

    onFinished(cb: () => void) {
      finishedCallback = cb;
    },
  };
}
