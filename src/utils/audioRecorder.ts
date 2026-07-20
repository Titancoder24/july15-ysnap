import { useState, useRef, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { 
  useAudioRecorder as useExpoAudioRecorder, 
  useAudioRecorderState as useExpoAudioRecorderState,
  RecordingPresets
} from 'expo-audio';

// Standard Web MIME types check
function getSupportedMimeType(): string {
  if (Platform.OS !== 'web') return 'audio/wav';
  
  if (typeof MediaRecorder === 'undefined') {
    return 'audio/mp4';
  }
  
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/aac',
    'audio/wav'
  ];
  
  for (const type of types) {
    try {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    } catch (e) {}
  }
  return 'audio/mp4'; // Safest universal standard fallback (works on iOS and Android)
}

export interface AppRecorder {
  record: () => Promise<void>;
  stop: () => Promise<string | null>;
  uri: string | null;
  isMeteringEnabled: boolean;
  // Internal web adapter state
  __webIsRecording: boolean;
  __webCurrentTime: number;
  __webMetering: number;
}

export function useAppAudioRecorder(options: { isMeteringEnabled?: boolean } = {}): AppRecorder {
  if (Platform.OS !== 'web') {
    const expoRecorder = useExpoAudioRecorder({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: options.isMeteringEnabled ?? true,
    });
    
    return {
      record: useCallback(async () => { expoRecorder.record(); }, [expoRecorder]),
      stop: useCallback(async () => {
        await expoRecorder.stop();
        return expoRecorder.uri;
      }, [expoRecorder]),
      get uri() { return expoRecorder.uri; },
      get isMeteringEnabled() { return options.isMeteringEnabled ?? true; },
      __webIsRecording: false,
      __webCurrentTime: 0,
      __webMetering: -60
    };
  }

  // Web implementation
  const [uri, setUri] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [metering, setMetering] = useState(-60);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);
  const meteringRef = useRef<any>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (meteringRef.current) {
      clearInterval(meteringRef.current);
      meteringRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  const record = useCallback(async () => {
    cleanup();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, { 
        mimeType,
        audioBitsPerSecond: 64000 // Compress to 64 kbps (perfect for voice, 10x smaller file sizes)
      });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const finalBlob = new Blob(chunksRef.current, { type: mimeType });
        const objectUrl = URL.createObjectURL(finalBlob);
        setUri(objectUrl);
      };

      const isIOSWeb = Platform.OS === 'web' && 
        (typeof navigator !== 'undefined' && (
          /iPad|iPhone|iPod/.test(navigator.userAgent) || 
          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        ));

      // Set up metering (Web Audio API) - Bypassed on iOS Web to prevent Safari/Chrome recording silencing bugs
      if (options.isMeteringEnabled !== false && !isIOSWeb) {
        try {
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          const audioContext = new AudioContextClass();
          audioContextRef.current = audioContext;
          
          const source = audioContext.createMediaStreamSource(stream);
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 32; // Small size is enough for metering
          source.connect(analyser);
          analyserRef.current = analyser;

          const bufferLength = analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);

          meteringRef.current = setInterval(() => {
            if (analyserRef.current) {
              analyserRef.current.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i];
              }
              const average = sum / bufferLength;
              // Map average value 0-255 to dB-like value -60 to 0
              const db = average > 0 ? (average / 255) * 60 - 60 : -60;
              setMetering(Math.round(db));
            }
          }, 100);
        } catch (audioErr) {
          console.warn("Failed to initialize Web Audio metering:", audioErr);
        }
      }

      try {
        recorder.start(100); // chunk every 100ms
      } catch (startErr) {
        console.warn("MediaRecorder start with timeslice failed, falling back:", startErr);
        recorder.start();
      }
      setIsRecording(true);
      setCurrentTime(0);

      // Start duration timer
      timerRef.current = setInterval(() => {
        setCurrentTime(t => t + 0.1);
      }, 100);
    } catch (err) {
      console.error("Failed to start web recording:", err);
      cleanup();
      throw err;
    }
  }, [options.isMeteringEnabled, cleanup]);

  const stop = useCallback(async (): Promise<string | null> => {
    const activeRecorder = mediaRecorderRef.current;
    if (!activeRecorder || activeRecorder.state === 'inactive') {
      setIsRecording(false);
      cleanup();
      return uri;
    }

    const completedUri = await new Promise<string | null>((resolve) => {
      const stopTimeout = setTimeout(() => {
        console.warn("MediaRecorder stop callback timed out. Resolving fallback.");
        resolve(uri);
      }, 2000);

      activeRecorder.onstop = () => {
        clearTimeout(stopTimeout);
        const finalBlob = new Blob(chunksRef.current, { type: activeRecorder.mimeType || getSupportedMimeType() });
        const objectUrl = URL.createObjectURL(finalBlob);
        setUri(objectUrl);
        resolve(objectUrl);
      };
      activeRecorder.stop();
    });
    setIsRecording(false);
    cleanup();
    return completedUri;
  }, [cleanup, uri]);

  // Clean up on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
    record,
    stop,
    get uri() { return uri; },
    get isMeteringEnabled() { return options.isMeteringEnabled ?? true; },
    __webIsRecording: isRecording,
    __webCurrentTime: currentTime,
    __webMetering: metering
  };
}

export interface AppRecorderState {
  isRecording: boolean;
  currentTime: number;
  metering: number;
}

export function useAppAudioRecorderState(recorder: AppRecorder, intervalMs: number = 100): AppRecorderState {
  if (Platform.OS !== 'web') {
    // We bypass TS check because options on native pass through standard expo-audio
    const nativeState = useExpoAudioRecorderState(recorder as any, intervalMs) as any;
    return {
      isRecording: !!nativeState?.isRecording,
      currentTime: (nativeState?.currentTime ?? nativeState?.duration ?? 0) as number,
      metering: (nativeState?.metering ?? -60) as number
    };
  }

  // Web state
  return {
    isRecording: recorder.__webIsRecording,
    currentTime: Math.round(recorder.__webCurrentTime * 10) / 10,
    metering: recorder.__webMetering
  };
}
