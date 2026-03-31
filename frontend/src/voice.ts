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
  onFinished(cb: () => void): void;
}

export function createAudioPlayer(): AudioPlayer {
  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  analyser.connect(audioCtx.destination);

  const queue: AudioBuffer[] = [];
  let isPlaying = false;
  let currentSource: AudioBufferSourceNode | null = null;
  let finishedCallback: (() => void) | null = null;

  function playNext() {
    if (queue.length === 0) {
      isPlaying = false;
      currentSource = null;
      finishedCallback?.();
      return;
    }

    isPlaying = true;
    const buffer = queue.shift()!;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    currentSource = source;

    source.onended = () => {
      if (currentSource === source) {
        playNext();
      }
    };

    source.start();
  }

  return {
    async enqueue(base64: string) {
      // Resume audio context (browser autoplay policy)
      if (audioCtx.state === "suspended") {
        console.log("[audio] resuming suspended AudioContext");
        await audioCtx.resume();
        console.log("[audio] AudioContext state:", audioCtx.state);
      }

      try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
        queue.push(audioBuffer);
        if (!isPlaying) playNext();
      } catch (err) {
        console.error("[audio] decode error:", err);
        // Skip bad audio, continue
        if (!isPlaying && queue.length > 0) playNext();
      }
    },

    stop() {
      queue.length = 0;
      if (currentSource) {
        try {
          currentSource.stop();
        } catch {
          // Already stopped
        }
        currentSource = null;
      }
      isPlaying = false;
    },

    getAnalyser() {
      return analyser;
    },

    onFinished(cb: () => void) {
      finishedCallback = cb;
    },
  };
}
