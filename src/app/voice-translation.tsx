import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Pressable, ScrollView, ActivityIndicator, Alert, TextInput, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { colors } from '../constants/colors';
import { typography } from '../constants/typography';
import { getLanguageByCode, languages } from '../constants/languages';
import { Ionicons } from '@expo/vector-icons';
import { AudioModule, useAudioPlayer, useAudioPlayerStatus, RecordingPresets } from 'expo-audio';
import { useAppAudioRecorder, useAppAudioRecorderState } from '../utils/audioRecorder';
import { MotionScreen } from '../components/MotionScreen';
import { elevenLabsService } from '../services/elevenLabs';
import { callEdgeFunction } from '../lib/supabase';
import { ReactiveVoiceOrb } from '../components';

const getWordCount = (text: string): number => {
  if (!text || text.trim() === '') return 0;
  return text.trim().split(/\s+/).length;
};

const getSyllableCount = (text: string): number => {
  if (!text || text.trim() === '') return 0;
  const words = text.toLowerCase().trim().split(/\s+/);
  let totalSyllables = 0;
  
  for (const word of words) {
    const cleanWord = word.replace(/[^a-z]/g, '');
    if (cleanWord.length === 0) continue;
    if (cleanWord.length <= 3) {
      totalSyllables += 1;
      continue;
    }
    
    let syllables = 0;
    const vowels = 'aeiouy';
    let prevIsVowel = false;
    
    for (let i = 0; i < cleanWord.length; i++) {
      const char = cleanWord[i];
      const isVowel = vowels.includes(char);
      if (isVowel && !prevIsVowel) {
        syllables++;
      }
      prevIsVowel = isVowel;
    }
    
    if (cleanWord.endsWith('e')) {
      syllables--;
    }
    
    if (cleanWord.endsWith('es') || cleanWord.endsWith('ed')) {
      if (syllables > 1 && !cleanWord.endsWith('le')) {
        syllables--;
      }
    }
    
    if (syllables <= 0) syllables = 1;
    totalSyllables += syllables;
  }
  
  return totalSyllables;
};

const downloadAudio = async (url: string | null, defaultFilename: string) => {
  if (!url) return;
  try {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const res = await fetch(url);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = defaultFilename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    console.error('Failed to download audio:', err);
    window.open(url, '_blank');
  }
};

export default function VoiceTranslationScreen() {
  const recorder = useAppAudioRecorder({
    isMeteringEnabled: true,
  });
  const recorderState = useAppAudioRecorderState(recorder, 100);

  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [isRecording, setIsRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [statusText, setStatusText] = useState('Ready to record');
  
  // Waveform heights state (15 bars)
  const [waveform, setWaveform] = useState<number[]>([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  
  // Audio result states
  const [transcription, setTranscription] = useState('');
  const [translation, setTranslation] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [translationItemId, setTranslationItemId] = useState<string | null>(null);
  const [isEditingTranscript, setIsEditingTranscript] = useState(false);
  const [editedText, setEditedText] = useState('');
  const [selectedSourceLanguage, setSelectedSourceLanguage] = useState<string | null>(null);
  const [selectedTargetLanguage, setSelectedTargetLanguage] = useState<string | null>(null);
  const [languagePicker, setLanguagePicker] = useState<'source' | 'target' | null>(null);

  // Audio Playback states
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [playbackProgress, setPlaybackProgress] = useState(0); // 0 to 100
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null);
  const player = useAudioPlayer(outputAudioUrl || '');
  const status = useAudioPlayerStatus(player);
  const [progressPercentage, setProgressPercentage] = useState<number | null>(null);
  const [playingHistoryId, setPlayingHistoryId] = useState<string | null>(null);

  // Fetch recent translation history items for user
  const { data: recentItems, refetch: refetchRecentItems } = useQuery<any[]>({
    queryKey: ['recentTranslationItems', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      const { data, error } = await supabase
        .from('translation_items')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.id,
  });

  const timerRef = useRef<any>(null);
  const waveRef = useRef<any>(null);
  const playbackRef = useRef<any>(null);

  // Fetch languages
  const { data: profile } = useQuery<any>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
      return data;
    },
    enabled: !!user?.id,
  });

  const { data: preferences } = useQuery<any>({
    queryKey: ['preferences', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('user_preferences')
        .select('selected_voice_id')
        .eq('user_id', user.id)
        .single();
      return data;
    },
    enabled: !!user?.id,
  });

  const nativeCode = selectedSourceLanguage ?? profile?.native_language ?? 'en';
  const targetCode = selectedTargetLanguage ?? profile?.primary_target_language ?? 'es';
  const isBusy = isRecording || statusText === 'Processing audio...' ||
    statusText === 'Transcribing and translating...' || statusText === 'Re-translating...' ||
    statusText === 'Generating voice...';

  const resetTranslationResult = () => {
    player.pause();
    setIsPlaying(false);
    setOutputAudioUrl(null);
    setPlaybackProgress(0);
    setTranscription('');
    setTranslation('');
    setEditedText('');
    setSessionId(null);
    setTranslationItemId(null);
    setStatusText('Ready to record');
  };

  const chooseLanguage = (code: string) => {
    Haptics.selectionAsync();
    if (languagePicker === 'source') {
      if (code === targetCode) setSelectedTargetLanguage(nativeCode);
      setSelectedSourceLanguage(code);
    } else if (languagePicker === 'target') {
      if (code === nativeCode) setSelectedSourceLanguage(targetCode);
      setSelectedTargetLanguage(code);
    }
    setLanguagePicker(null);
    resetTranslationResult();
  };

  const swapLanguages = () => {
    if (isBusy) return;
    Haptics.selectionAsync();
    setSelectedSourceLanguage(targetCode);
    setSelectedTargetLanguage(nativeCode);
    resetTranslationResult();
  };

  // Timer tick
  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => {
        setRecordTime((t) => t + 1);
      }, 1000);
      
      waveRef.current = setInterval(() => {
        // Random premium-looking voice heights
        setWaveform(Array.from({ length: 15 }, () => Math.floor(Math.random() * 50) + 12));
      }, 120);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (waveRef.current) clearInterval(waveRef.current);
      setWaveform([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
      setRecordTime(0);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (waveRef.current) clearInterval(waveRef.current);
    };
  }, [isRecording]);

  // Sync timeline progress with real audio duration
  useEffect(() => {
    let progressTimer: any;
    if (isPlaying && status.duration > 0) {
      progressTimer = setInterval(() => {
        const currentProgress = (status.currentTime / status.duration) * 100;
        setPlaybackProgress(Math.min(100, currentProgress));
      }, 50);
    }
    return () => clearInterval(progressTimer);
  }, [isPlaying, status.currentTime, status.duration]);

  // Handle playback completion
  useEffect(() => {
    const isFinished = status.duration > 0 
      ? status.currentTime >= status.duration - 0.2 
      : false;

    if (isPlaying && !status.playing && (isFinished || isNaN(status.duration) || status.duration === 0)) {
      setIsPlaying(false);
      setPlayingHistoryId(null);
      setPlaybackProgress(100);
      setTimeout(() => setPlaybackProgress(0), 200);
      setStatusText('Translation ready');
    }
  }, [status.playing, status.currentTime, status.duration]);

  // Sync playback speed
  useEffect(() => {
    try {
      if (player) {
        player.playbackRate = playbackSpeed;
      }
    } catch (e) {
      console.warn("Failed to set playbackRate:", e);
    }
  }, [playbackSpeed, player]);

  const handleStartRecording = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    
    if (!user) {
      Alert.alert(
        'Sign In Required',
        'Sign in to use live voice translation.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign In', onPress: () => router.replace('/(auth)/sign-in') }
        ]
      );
      return;
    }
    
    try {
      if (Platform.OS !== 'web') {
        const status = await AudioModule.requestRecordingPermissionsAsync();
        if (!status.granted) {
          Alert.alert('Microphone Access', 'Microphone permissions are required for voice translation.');
          return;
        }
      }

      setTranscription('');
      setTranslation('');
      setIsRecording(true);
      setStatusText('Listening...');
      await recorder.record();
    } catch (e) {
      console.error(e);
      setIsRecording(false);
      setStatusText('Ready to record');
      Alert.alert('Microphone Error', 'Failed to start recording. Please try again.');
    }
  };

  const handleStopRecording = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsRecording(false);
    setStatusText('Processing audio...');
    setProgressPercentage(10); // Start progress bar

    let progressInterval = setInterval(() => {
      setProgressPercentage((prev) => {
        if (prev === null) return 10;
        if (prev < 30) return prev + 5; // transcribing stage
        if (prev < 65) return prev + 3; // translation stage
        if (prev < 95) return prev + 1; // speech generation stage
        return prev;
      });
    }, 400);

    try {
      const completedUri = await recorder.stop();
      const audioUri = completedUri || recorder.uri;
      if (!audioUri) {
        throw new Error('No recorded audio file found.');
      }

      // One authenticated server call handles STT, translation, cloned/preset TTS,
      // private audio storage, and the history records as one logical turn.
      setStatusText('Transcribing and translating...');
      const result = await elevenLabsService.translateVoice(audioUri, {
        sourceLanguage: nativeCode,
        targetLanguage: targetCode,
        voiceId: preferences?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
        sessionType: 'voice',
        sessionId: sessionId || undefined,
      });

      clearInterval(progressInterval);
      setProgressPercentage(100);

      const sourceText = result.source_text;
      const translatedText = result.translated_text;
      setSessionId(result.session_id);
      setTranslationItemId(result.translation_item_id);
      setTranscription(sourceText);
      setEditedText(sourceText);
      setTranslation(translatedText);

      if (result.generated_audio_url) {
        setOutputAudioUrl(result.generated_audio_url);
        player.replace({ uri: result.generated_audio_url });
        player.play();
        setIsPlaying(true);
        setPlaybackProgress(0);
        setStatusText('Translation ready');
      } else {
        throw new Error('Failed to generate speech output.');
      }
      queryClient.invalidateQueries({ queryKey: ['recentTranslationItems', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['recentSessions', user?.id] });
      queryClient.invalidateQueries({ queryKey: ['historySessions', user?.id] });

      setTimeout(() => setProgressPercentage(null), 1000);
    } catch (e: any) {
      clearInterval(progressInterval);
      setProgressPercentage(null);
      console.error(e);
      setStatusText('Error occurred');
      Alert.alert('Translation Error', e.message || 'An unexpected error occurred during translation.');
    }
  };

  const playHistoryItem = async (item: any) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (playingHistoryId === item.id) {
        if (isPlaying) {
          player.pause();
          setIsPlaying(false);
        } else {
          player.play();
          setIsPlaying(true);
        }
        return;
      }

      setPlayingHistoryId(item.id);
      setIsPlaying(true);

      let url = item.signed_url;
      if (!url) {
        const { data, error } = await supabase.storage
          .from('media')
          .createSignedUrl(item.generated_audio_path, 86400);
        if (error || !data?.signedUrl) {
          throw error || new Error('Failed to resolve audio URL');
        }
        url = data.signedUrl;
        item.signed_url = url;
      }

      player.replace({ uri: url });
      player.play();
    } catch (err: any) {
      setIsPlaying(false);
      setPlayingHistoryId(null);
      Alert.alert('Playback Error', err.message || 'Failed to play translation.');
    }
  };

  const deleteHistoryItem = async (itemId: string) => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const { error } = await supabase
        .from('translation_items')
        .delete()
        .eq('id', itemId);
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ['recentTranslationItems', user?.id] });
    } catch (err: any) {
      Alert.alert('Error', 'Failed to delete translation item.');
    }
  };

  const loadHistoryItem = (item: any) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTranscription(item.source_text);
    setEditedText(item.source_text);
    setTranslation(item.translated_text);
    setSessionId(item.session_id);
    setTranslationItemId(item.id);
    if (item.generated_audio_path) {
      setOutputAudioUrl(item.signed_url || null);
    }
  };

  const handleTogglePlayback = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isPlaying) {
      player.pause();
      setIsPlaying(false);
      return;
    }

    if (!translation) return;

    try {
      setIsPlaying(true);
      let audioUrl = outputAudioUrl;
      if (!audioUrl) {
        setStatusText('Generating pronunciation...');
        const targetVoiceId = preferences?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM';
        const res = await elevenLabsService.generateSpeech(translation, targetVoiceId, true);
        if (res && res.url) {
          audioUrl = res.url;
          setOutputAudioUrl(res.url);
        } else {
          throw new Error('TTS synthesis returned empty URL');
        }
      }
      setStatusText('Playing pronunciation...');
      player.replace({ uri: audioUrl });
      player.play();
    } catch (err: any) {
      console.error(err);
      Alert.alert('TTS Playback Failed', err.message || 'Error occurred while calling Edge Function.');
      setIsPlaying(false);
      setStatusText('Translation ready');
    }
  };

  const cycleSpeed = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const speeds = [0.8, 1.0, 1.2, 1.5];
    const nextIdx = (speeds.indexOf(playbackSpeed) + 1) % speeds.length;
    setPlaybackSpeed(speeds[nextIdx]);
  };

  const saveEditedTranscript = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setTranscription(editedText);
    setIsEditingTranscript(false);
    setStatusText('Re-translating...');

    try {
      const { data: translationResult, error: transError } = await callEdgeFunction<{
        translated_text: string;
        detected_language: string;
      }>('translate-text', {
        source: nativeCode,
        target: targetCode,
        text: editedText,
      });

      if (transError || !translationResult) {
        throw transError || new Error('Failed to translate text.');
      }

      const translatedText = translationResult.translated_text;
      setTranslation(translatedText);
      setStatusText('Translation updated');

      // Re-generate speech output
      setStatusText('Generating voice...');
      const ttsResult = await elevenLabsService.generateSpeech(
        translatedText,
        preferences?.selected_voice_id || '21m00Tcm4TlvDq8ikWAM',
        true,
        sessionId || undefined,
      );
      if (ttsResult && ttsResult.url) {
        setOutputAudioUrl(ttsResult.url);
        player.replace({ uri: ttsResult.url });
        player.play();
        setIsPlaying(true);
        setPlaybackProgress(0);
        setStatusText('Translation ready');
      } else {
        throw new Error('Failed to generate speech output.');
      }

      if (translationItemId) {
        const { error: updateError } = await (supabase as any)
          .from('translation_items')
          .update({
            source_text: editedText,
            translated_text: translatedText,
            generated_audio_path: ttsResult.filePath,
          } as any)
          .eq('id', translationItemId)
          .eq('user_id', user?.id || '');
        if (updateError) throw updateError;
      }
    } catch (e: any) {
      console.error(e);
      setStatusText('Error occurred');
      Alert.alert('Translation Error', e.message || 'An unexpected error occurred.');
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Voice Translator</Text>
        <View style={{ width: 24 }} />
      </View>

      <MotionScreen>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        
        {/* Language pairing banner */}
        <View style={styles.languageBanner}>
          <Pressable
            style={styles.languageChoice}
            disabled={isBusy}
            onPress={() => setLanguagePicker('source')}
          >
            <Text style={styles.languageChoiceLabel}>FROM</Text>
            <View style={styles.languageChoiceRow}>
              <Text style={styles.langTag}>{getLanguageByCode(nativeCode)?.name}</Text>
              <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
            </View>
          </Pressable>
          <Pressable
            accessibilityLabel="Swap translation languages"
            style={[styles.swapButton, isBusy && styles.disabledControl]}
            disabled={isBusy}
            onPress={swapLanguages}
          >
            <Ionicons name="swap-horizontal" size={18} color={colors.accentPurple} />
          </Pressable>
          <Pressable
            style={styles.languageChoice}
            disabled={isBusy}
            onPress={() => setLanguagePicker('target')}
          >
            <Text style={styles.languageChoiceLabel}>TO</Text>
            <View style={styles.languageChoiceRow}>
              <Text style={[styles.langTag, { color: colors.accentPurple }]}>{getLanguageByCode(targetCode)?.name}</Text>
              <Ionicons name="chevron-down" size={14} color={colors.accentPurple} />
            </View>
          </Pressable>
        </View>



        {/* Audio Waveform and Timer Box */}
        <View style={styles.visualizerBox}>
          {progressPercentage !== null ? (
            <View style={{ width: '100%', alignItems: 'center', paddingHorizontal: 10 }}>
              <Text style={[styles.statusLabel, { marginBottom: 8, color: '#ffffff', fontWeight: '700' }]}>
                {statusText}
              </Text>
              <View style={{ width: '100%', height: 10, borderRadius: 5, backgroundColor: 'rgba(255, 255, 255, 0.15)', overflow: 'hidden', marginVertical: 8 }}>
                <View style={{ width: `${progressPercentage}%`, height: '100%', backgroundColor: '#ffffff', borderRadius: 5 }} />
              </View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#ffffff', marginTop: 4 }}>
                {progressPercentage}%
              </Text>
            </View>
          ) : isRecording ? (
            <Text style={styles.timer}>{formatTime(recordTime)}</Text>
          ) : (
            <View style={{ alignItems: 'center' }}>
              <Text style={styles.statusLabel}>{statusText}</Text>
              {isBusy && !isRecording && (
                <ActivityIndicator size="small" color="#ffffff" style={{ marginTop: -8, marginBottom: 12 }} />
              )}
            </View>
          )}

          {progressPercentage === null && (
            /* Waveform graphic */
            <View style={styles.waveformContainer}>
              {waveform.map((h, i) => (
                <View 
                  key={i} 
                  style={[
                    styles.waveBar, 
                    { height: h },
                    isRecording && { backgroundColor: '#ffffff' }
                  ]} 
                />
              ))}
            </View>
          )}
        </View>

        {/* Action button orb */}
        <View style={styles.orbSection}>
          <ReactiveVoiceOrb
            isRecording={isRecording}
            metering={recorderState?.metering}
            isPlaying={isPlaying}
            isProcessing={isBusy && !isRecording}
            baseDiameter={115}
            onPress={isRecording ? handleStopRecording : handleStartRecording}
          />
          <Text style={styles.orbLabel}>
            {isRecording ? 'Tap to finish speaking' : 'Tap to start speaking'}
          </Text>
        </View>

        {/* Translation Output Cards */}
        {(transcription !== '' || translation !== '') && (
          <View style={styles.resultGroup}>
            
            {/* Source text transcription */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardHeaderTitle}>TRANSCRIPT</Text>
                <Pressable 
                  style={styles.editLink}
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setIsEditingTranscript(true);
                  }}
                >
                  <Ionicons name="create-outline" size={14} color={colors.accentPurple} style={{ marginRight: 4 }} />
                  <Text style={styles.editLinkText}>Edit</Text>
                </Pressable>
              </View>
              <Text style={styles.transText}>{transcription || 'Transcribing...'}</Text>
              {transcription !== '' && (
                <Text style={styles.cardMetadata}>
                  Words: {getWordCount(transcription)} • Syllables: {getSyllableCount(transcription)}
                </Text>
              )}
            </View>

            {/* Translation card */}
            <View style={[styles.card, styles.translationCard]}>
              <View style={styles.cardHeader}>
                <Text style={[styles.cardHeaderTitle, { color: colors.textMuted }]}>TRANSLATION</Text>
              </View>
              <Text style={[styles.transText, { color: colors.textPrimary }]}>
                {translation || 'Translating...'}
              </Text>
              {translation !== '' && (
                <Text style={styles.cardMetadata}>
                  Words: {getWordCount(translation)} • Syllables: {getSyllableCount(translation)}
                </Text>
              )}
              
              {/* Playback Controls widget */}
              {translation !== '' && (
                <View style={styles.playbackContainer}>
                  {/* Play scrubber */}
                  <View style={styles.scrubberRow}>
                    <Pressable style={styles.playButton} onPress={handleTogglePlayback}>
                      <Ionicons name={isPlaying ? 'pause' : 'play'} size={20} color="#fff" />
                    </Pressable>
                    <Pressable 
                      style={[styles.playButton, { backgroundColor: colors.accentPurple, marginLeft: 8 }]} 
                      onPress={() => downloadAudio(outputAudioUrl, `translation-${targetCode}.mp3`)}
                    >
                      <Ionicons name="download" size={20} color="#fff" />
                    </Pressable>
                    <View style={styles.scrubberTrack}>
                      <View style={[styles.scrubberFill, { width: `${playbackProgress}%` }]} />
                    </View>
                    <Pressable style={styles.speedButton} onPress={cycleSpeed}>
                      <Text style={styles.speedText}>{playbackSpeed.toFixed(1)}x</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          </View>
        )}
        {/* Recent Translations History */}
        {recentItems && recentItems.length > 0 && (
          <View style={styles.historyContainer}>
            <Text style={styles.historyTitle}>Recent Translations</Text>
            {recentItems.map((item) => {
              const isItemPlaying = playingHistoryId === item.id && isPlaying;
              const sourceLang = getLanguageByCode(item.source_language)?.name || item.source_language || 'Source';
              const targetLang = getLanguageByCode(item.target_language)?.name || item.target_language || 'Target';
              
              return (
                <Pressable 
                  key={item.id} 
                  style={styles.historyCard}
                  onPress={() => loadHistoryItem(item)}
                >
                  <View style={styles.historyHeader}>
                    <View style={styles.historyLanguages}>
                      <Text style={styles.historyLangText}>{sourceLang}</Text>
                      <Ionicons name="arrow-forward" style={styles.historyArrow} />
                      <Text style={[styles.historyLangText, { color: colors.accentPurple }]}>{targetLang}</Text>
                    </View>
                    <Text style={styles.historyTimestamp}>
                      {new Date(item.created_at).toLocaleDateString()}
                    </Text>
                  </View>

                  <View style={styles.historyBody}>
                    <Text style={styles.historySourceText} numberOfLines={2}>{item.source_text}</Text>
                    <Text style={styles.historyTargetText} numberOfLines={2}>{item.translated_text}</Text>
                    <Text style={styles.historyMetadata}>
                      Words: {getWordCount(item.translated_text)} • Syllables: {getSyllableCount(item.translated_text)}
                    </Text>
                  </View>

                  <View style={styles.historyActions}>
                    <Pressable 
                      style={[styles.historyPlayBtn, isItemPlaying && { backgroundColor: colors.accentPurple }]} 
                      onPress={() => playHistoryItem(item)}
                    >
                      <Ionicons name={isItemPlaying ? 'pause' : 'play'} size={14} color="#fff" />
                      <Text style={styles.historyPlayBtnText}>{isItemPlaying ? 'Playing' : 'Listen'}</Text>
                    </Pressable>
                    <Pressable 
                      style={[styles.historyPlayBtn, { backgroundColor: colors.surfaceSoft, borderWidth: 1, borderColor: colors.border }]} 
                      onPress={async () => {
                        let url = item.signed_url;
                        if (!url) {
                          const { data } = await supabase.storage
                            .from('media')
                            .createSignedUrl(item.generated_audio_path, 86400);
                          url = data?.signedUrl || null;
                          item.signed_url = url;
                        }
                        if (url) {
                          downloadAudio(url, `translation-history-${item.id}.mp3`);
                        }
                      }}
                    >
                      <Ionicons name="download-outline" size={14} color={colors.textSecondary} />
                      <Text style={[styles.historyPlayBtnText, { color: colors.textSecondary }]}>Download</Text>
                    </Pressable>
                    <Pressable 
                      style={styles.historyDeleteBtn} 
                      onPress={() => deleteHistoryItem(item.id)}
                    >
                      <Ionicons name="trash-outline" size={16} color={colors.textMuted} />
                    </Pressable>
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
      </MotionScreen>

      {/* Transcript Edit Modal */}
      <Modal
        visible={isEditingTranscript}
        animationType="fade"
        transparent
        onRequestClose={() => setIsEditingTranscript(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalHeading}>Edit Transcript</Text>
            <TextInput
              style={styles.modalInput}
              multiline
              value={editedText}
              onChangeText={setEditedText}
            />
            <View style={styles.modalButtons}>
              <Pressable 
                style={[styles.modalBtn, styles.modalBtnCancel]} 
                onPress={() => setIsEditingTranscript(false)}
              >
                <Text style={styles.modalBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable 
                style={[styles.modalBtn, styles.modalBtnSave]} 
                onPress={saveEditedTranscript}
              >
                <Text style={styles.modalBtnSaveText}>Translate</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={languagePicker !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setLanguagePicker(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, styles.languageModalContent]}>
            <View style={styles.languageModalHeader}>
              <View>
                <Text style={styles.modalHeading}>
                  {languagePicker === 'source' ? 'Choose source language' : 'Choose target language'}
                </Text>
                <Text style={styles.languageModalSubtitle}>Select any supported translation language</Text>
              </View>
              <Pressable onPress={() => setLanguagePicker(null)} style={styles.languageCloseButton}>
                <Ionicons name="close" size={22} color={colors.textPrimary} />
              </Pressable>
            </View>
            <ScrollView style={styles.languageList} showsVerticalScrollIndicator={false}>
              {languages.map((language) => {
                const isSelected = (languagePicker === 'source' ? nativeCode : targetCode) === language.code;
                return (
                  <Pressable
                    key={language.code}
                    style={[styles.languageListItem, isSelected && styles.languageListItemSelected]}
                    onPress={() => chooseLanguage(language.code)}
                  >
                    <View>
                      <Text style={styles.languageListName}>{language.name}</Text>
                      <Text style={styles.languageListNative}>{language.nativeName}</Text>
                    </View>
                    {isSelected && <Ionicons name="checkmark-circle" size={20} color={colors.accentPurple} />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  backButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: typography.heading3.fontFamily,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  scrollContent: {
    padding: 24,
  },
  languageBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 20,
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 2,
  },
  langTag: {
    fontSize: 19,
    fontFamily: typography.heading3.fontFamily,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  languageChoice: {
    flex: 1,
    paddingHorizontal: 6,
  },
  languageChoiceLabel: {
    fontSize: 10,
    fontFamily: typography.captionMedium.fontFamily,
    fontWeight: '800',
    color: colors.textMuted,
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  languageChoiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  swapButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f3f4f6',
  },
  disabledControl: {
    opacity: 0.4,
  },
  visualizerBox: {
    alignItems: 'center',
    backgroundColor: '#000000',
    borderRadius: 24,
    padding: 28,
    marginBottom: 28,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
    borderWidth: 1,
    borderColor: '#000000',
  },
  timer: {
    fontSize: 36,
    fontFamily: typography.tabular.fontFamily,
    fontWeight: '800',
    color: '#ffffff',
    marginBottom: 16,
  },
  statusLabel: {
    fontSize: 16,
    fontFamily: typography.bodyMedium.fontFamily,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 16,
  },
  waveformContainer: {
    flexDirection: 'row',
    height: 70,
    alignItems: 'center',
    gap: 5,
  },
  waveBar: {
    width: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    minHeight: 8,
  },
  orbSection: {
    alignItems: 'center',
    marginBottom: 32,
  },
  recordingOrbIdle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
    marginBottom: 12,
  },
  recordingOrbActive: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: colors.error,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.error,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
    marginBottom: 12,
  },
  stopIcon: {
    width: 24,
    height: 24,
    backgroundColor: colors.textInverse,
    borderRadius: 4,
  },
  orbLabel: {
    fontSize: 15,
    fontFamily: typography.bodyMedium.fontFamily,
    color: colors.textSecondary,
    fontWeight: '700',
    marginTop: 8,
  },
  resultGroup: {
    gap: 20,
    marginBottom: 24,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.02,
    shadowRadius: 8,
    elevation: 2,
  },
  translationCard: {
    backgroundColor: '#faf5ff',
    borderColor: '#e9d5ff',
    borderWidth: 1.5,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardHeaderTitle: {
    fontSize: 11,
    fontFamily: typography.captionMedium.fontFamily,
    fontWeight: '800',
    color: colors.textMuted,
    letterSpacing: 1.5,
  },
  editLink: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  editLinkText: {
    fontSize: 13,
    fontFamily: typography.bodyMedium.fontFamily,
    color: colors.accentPurple,
  },
  transText: {
    fontSize: 18,
    fontFamily: typography.body.fontFamily,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 26,
  },
  playbackContainer: {
    marginTop: 16,
    borderTopWidth: 1,
    borderColor: 'rgba(9, 9, 9, 0.05)',
    paddingTop: 16,
  },
  scrubberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrubberTrack: {
    flex: 1,
    height: 4,
    backgroundColor: 'rgba(9, 9, 9, 0.08)',
    borderRadius: 2,
    marginHorizontal: 12,
    overflow: 'hidden',
  },
  scrubberFill: {
    height: 4,
    backgroundColor: colors.primary,
  },
  speedButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  speedText: {
    fontSize: 12,
    fontFamily: typography.tabular.fontFamily,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: colors.background,
    borderRadius: 20,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  languageModalContent: {
    maxHeight: '82%',
    paddingBottom: 10,
  },
  languageModalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  languageModalSubtitle: {
    fontSize: 12,
    fontFamily: typography.body.fontFamily,
    color: colors.textMuted,
    marginTop: -10,
    marginBottom: 12,
  },
  languageCloseButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.backgroundSoft,
  },
  languageList: {
    flexGrow: 0,
  },
  languageListItem: {
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  languageListItemSelected: {
    backgroundColor: colors.surfaceSoft,
  },
  languageListName: {
    fontSize: 15,
    fontFamily: typography.bodySemibold.fontFamily,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  languageListNative: {
    fontSize: 12,
    fontFamily: typography.body.fontFamily,
    color: colors.textMuted,
    marginTop: 2,
  },
  modalHeading: {
    fontSize: 17,
    fontFamily: typography.heading4.fontFamily,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 16,
  },
  modalInput: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    fontFamily: typography.body.fontFamily,
    color: colors.textPrimary,
    minHeight: 100,
    textAlignVertical: 'top',
    marginBottom: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnCancel: {
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalBtnCancelText: {
    fontSize: 15,
    fontFamily: typography.bodyMedium.fontFamily,
    color: colors.textSecondary,
  },
  modalBtnSave: {
    backgroundColor: colors.primary,
  },
  modalBtnSaveText: {
    fontSize: 15,
    fontFamily: typography.bodySemibold.fontFamily,
    fontWeight: '700',
    color: colors.textInverse,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.backgroundSoft,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusPillText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: '600',
    color: colors.textSecondary,
    letterSpacing: 0.5,
  },
  progressContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  progressLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
  },
  progressValue: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.primary,
  },
  progressBarBg: {
    height: 8,
    backgroundColor: '#f3f4f6',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 4,
  },
  historyContainer: {
    marginTop: 24,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 4,
    marginBottom: 40,
  },
  historyTitle: {
    fontSize: 18,
    fontFamily: typography.heading3.fontFamily,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 16,
  },
  historyCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 6,
    elevation: 1,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  historyLanguages: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  historyLangText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
    backgroundColor: colors.backgroundSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  historyArrow: {
    marginHorizontal: 6,
    fontSize: 12,
    color: colors.textMuted,
  },
  historyTimestamp: {
    fontSize: 10,
    color: colors.textMuted,
  },
  historyBody: {
    marginBottom: 12,
  },
  historySourceText: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 6,
    fontStyle: 'italic',
  },
  historyTargetText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  historyActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
    paddingTop: 10,
  },
  historyPlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    marginRight: 8,
  },
  historyPlayBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },
  historyDeleteBtn: {
    padding: 6,
  },
  cardMetadata: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  historyMetadata: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 6,
  },
});
