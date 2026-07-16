import { callEdgeFunction } from '../lib/supabase';
import { Platform } from 'react-native';

export interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string;
  labels?: Record<string, string>;
  is_cloned?: boolean;
}

export interface SpeechResponse {
  url: string | null;
  filePath: string;
  mediaAssetId: string | null;
  sessionId?: string;
  sourceAudioUrl?: string | null;
  sourceText?: string;
}

export interface VoiceCloneResponse {
  message: string;
  voice_profile: {
    id: string;
    display_name: string;
    provider_voice_id: string;
    status: string;
    is_cloned: boolean;
    accent_info?: string;
  };
}

export interface TranscriptionResponse {
  text: string;
  language_code?: string;
  language_probability?: number;
}

export interface VoiceTranslationResponse {
  session_id: string;
  translation_item_id: string;
  source_text: string;
  translated_text: string;
  transliteration: string | null;
  detected_language: string;
  alternatives: string[];
  context_notes: string | null;
  source_audio_url: string | null;
  generated_audio_url: string | null;
}

export const elevenLabsService = {
  /**
   * Fetch all system and custom voices from the list-voices Edge Function
   */
  async fetchVoices(): Promise<Voice[]> {
    const { data, error } = await callEdgeFunction<{ voices: Voice[] }>('list-voices');
    if (error || !data) {
      throw error || new Error('Failed to fetch voices');
    }
    return data.voices;
  },

  /**
   * Generate text-to-speech using the generate-speech Edge Function
   */
  async generateSpeech(
    text: string,
    voiceId: string = '21m00Tcm4TlvDq8ikWAM',
    saveToStorage: boolean = true,
    sessionId?: string
  ): Promise<SpeechResponse> {
    const { data, error } = await callEdgeFunction<SpeechResponse>('generate-speech', {
      text,
      voiceId,
      saveToStorage,
      sessionId,
    });
    if (error || !data) {
      throw error || new Error('Failed to generate speech');
    }
    return data;
  },

  /**
   * Transform a voice input into a target voice using Speech-to-Speech Edge Function
   */
  async changeVoice(
    audioUri: string,
    voiceId: string,
    saveToStorage: boolean = true,
    sessionId?: string
  ): Promise<SpeechResponse> {
    const formData = new FormData();
    if (Platform.OS === 'web') {
      const response = await fetch(audioUri);
      const blob = await response.blob();
      formData.append('file', blob, 'input_audio.wav');
    } else {
      formData.append('file', {
        uri: audioUri,
        name: 'input_audio.wav',
        type: 'audio/wav',
      } as any);
    }
    formData.append('voice_id', voiceId);
    formData.append('save_to_storage', saveToStorage ? 'true' : 'false');
    if (sessionId) {
      formData.append('session_id', sessionId);
    }

    const { data, error } = await callEdgeFunction<SpeechResponse>('change-voice', formData);
    if (error || !data) {
      throw error || new Error('Failed to morph voice');
    }
    return data;
  },

  /**
   * Transcribe, translate, synthesize, and persist a complete spoken turn.
   */
  async translateVoice(
    audioUri: string,
    options: {
      targetLanguage: string;
      sourceLanguage?: string;
      voiceId?: string;
      sessionId?: string;
      sessionType?: 'voice' | 'conversation';
      speakerId?: string;
      sequenceNumber?: number;
    }
  ): Promise<VoiceTranslationResponse> {
    const formData = new FormData();
    if (Platform.OS === 'web') {
      const response = await fetch(audioUri);
      const blob = await response.blob();
      formData.append('file', blob, 'voice_turn.webm');
    } else {
      formData.append('file', {
        uri: audioUri,
        name: 'voice_turn.m4a',
        type: 'audio/mp4',
      } as any);
    }

    formData.append('target', options.targetLanguage);
    formData.append('source', options.sourceLanguage || 'auto');
    formData.append('voice_id', options.voiceId || '21m00Tcm4TlvDq8ikWAM');
    formData.append('session_type', options.sessionType || 'voice');
    formData.append('speaker_id', options.speakerId || 'user');
    if (options.sessionId) formData.append('session_id', options.sessionId);
    if (options.sequenceNumber) {
      formData.append('sequence_number', String(options.sequenceNumber));
    }

    const { data, error } = await callEdgeFunction<VoiceTranslationResponse>('translate-voice', formData);
    if (error || !data) {
      throw error || new Error('Failed to translate voice');
    }
    return data;
  },

  /**
   * Clone a user's voice using the create-voice-clone Edge Function
   */
  async cloneVoice(
    name: string,
    sampleUri: string,
    accentInfo: string = 'US Accent',
    ownershipConfirmed: boolean = true,
    privacyAcknowledged: boolean = true,
    sampleDurationSeconds?: number
  ): Promise<VoiceCloneResponse> {
    const formData = new FormData();
    if (Platform.OS === 'web') {
      const response = await fetch(sampleUri);
      const blob = await response.blob();
      formData.append('file', blob, 'sample_voice.wav');
    } else {
      formData.append('file', {
        uri: sampleUri,
        name: 'sample_voice.wav',
        type: 'audio/wav',
      } as any);
    }
    formData.append('name', name);
    formData.append('accent_info', accentInfo);
    formData.append('ownership_confirmed', ownershipConfirmed ? 'true' : 'false');
    formData.append('privacy_acknowledged', privacyAcknowledged ? 'true' : 'false');
    if (sampleDurationSeconds) {
      formData.append('sample_duration_seconds', String(sampleDurationSeconds));
    }

    const { data, error } = await callEdgeFunction<VoiceCloneResponse>('create-voice-clone', formData);
    if (error || !data) {
      throw error || new Error('Failed to clone voice');
    }
    return data;
  },

  /**
   * Transcribe an audio file using the transcribe-audio Edge Function
   */
  async transcribeAudio(audioUri: string, language?: string): Promise<{
    success: boolean;
    text: string;
    detectedLanguage: string | null;
    detectedLanguageName: string | null;
    languageConfidence: number | null;
    durationSeconds: number | null;
  }> {
    const formData = new FormData();
    if (Platform.OS === 'web') {
      const response = await fetch(audioUri);
      const blob = await response.blob();
      formData.append('file', blob, 'transcription.wav');
    } else {
      formData.append('file', {
        uri: audioUri,
        name: 'transcription.wav',
        type: 'audio/wav',
      } as any);
    }
    if (language) {
      formData.append('language', language);
    }

    const { data, error } = await callEdgeFunction<any>('transcribe-audio', formData);
    if (error || !data) {
      throw error || new Error('Failed to transcribe audio');
    }
    return data;
  },
};
